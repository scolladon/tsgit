import { v2CommandUnsupported } from '../error.js';
import type { PktLine } from '../pkt-line.js';

const VERSION_LINE = 'version 2';
const DEFAULT_OBJECT_FORMAT = 'sha1';
const KNOWN_COMMANDS = new Set(['ls-refs', 'fetch']);

export type V2Capabilities = {
  readonly version: 2;
  readonly agent?: string;
  readonly commands: ReadonlySet<string>;
  readonly objectFormat: string;
};

const TEXT_DECODER = new TextDecoder();

const stripTrailingNewline = (value: string): string =>
  value.endsWith('\n') ? value.slice(0, -1) : value;

const splitCapability = (line: string): readonly [string, string | undefined] => {
  const eq = line.indexOf('=');
  return eq === -1 ? [line, undefined] : [line.slice(0, eq), line.slice(eq + 1)];
};

const readLine = async (iter: AsyncIterator<PktLine>): Promise<string | undefined> => {
  const next = await iter.next();
  if (next.done || next.value.kind !== 'data') return undefined;
  return stripTrailingNewline(TEXT_DECODER.decode(next.value.payload));
};

export const parseV2Capabilities = async (
  pktStream: AsyncIterable<PktLine>,
): Promise<V2Capabilities> => {
  const iter = pktStream[Symbol.asyncIterator]();
  const first = await readLine(iter);
  if (first !== VERSION_LINE) {
    throw v2CommandUnsupported(first ?? '');
  }

  const commands = new Set<string>();
  let agent: string | undefined;
  let objectFormat = DEFAULT_OBJECT_FORMAT;

  for (let line = await readLine(iter); line !== undefined; line = await readLine(iter)) {
    const [name, value] = splitCapability(line);
    if (name === 'agent') {
      agent = value;
      continue;
    }
    if (name === 'object-format') {
      objectFormat = value ?? '';
      if (objectFormat !== DEFAULT_OBJECT_FORMAT) {
        throw v2CommandUnsupported(line);
      }
      continue;
    }
    if (KNOWN_COMMANDS.has(name)) {
      commands.add(name);
    }
  }

  return agent === undefined
    ? { version: 2, commands, objectFormat }
    : { version: 2, agent, commands, objectFormat };
};

export const supportsV2Fetch = (caps: V2Capabilities): boolean =>
  caps.commands.has('fetch') && caps.commands.has('ls-refs');
