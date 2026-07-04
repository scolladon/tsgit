import { unsupportedObjectFormat, v2CommandUnsupported } from '../error.js';
import type { PktLine } from '../pkt-line.js';

const VERSION_LINE = 'version 2';
const DEFAULT_OBJECT_FORMAT = 'sha1';
const KNOWN_COMMANDS = new Set(['ls-refs', 'fetch']);

export type V2Capabilities = {
  readonly version: 2;
  readonly agent?: string;
  readonly commands: ReadonlySet<string>;
  /**
   * Sub-features of the `fetch` command, parsed from its `fetch=<features>`
   * value (e.g. `shallow`, `wait-for-done`, `filter`). Empty when the server
   * advertises a bare `fetch` line or omits the command entirely.
   */
  readonly fetchFeatures: ReadonlySet<string>;
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

const splitFetchFeatures = (value: string | undefined): ReadonlyArray<string> =>
  value === undefined ? [] : value.split(' ').filter((feature) => feature.length > 0);

interface CapabilityState {
  readonly commands: Set<string>;
  readonly fetchFeatures: Set<string>;
  agent: string | undefined;
  objectFormat: string;
}

/** `ls-refs`/`fetch` lines add to `commands`; `fetch`'s own `=<features>` value additionally fans out into `fetchFeatures`. */
const applyCommandLine = (
  state: CapabilityState,
  name: string,
  value: string | undefined,
): void => {
  if (!KNOWN_COMMANDS.has(name)) return;
  state.commands.add(name);
  if (name !== 'fetch') return;
  for (const feature of splitFetchFeatures(value)) state.fetchFeatures.add(feature);
};

const applyCapabilityLine = (state: CapabilityState, line: string): void => {
  const [name, value] = splitCapability(line);
  if (name === 'agent') {
    state.agent = value;
    return;
  }
  if (name === 'object-format') {
    state.objectFormat = value ?? '';
    if (state.objectFormat !== DEFAULT_OBJECT_FORMAT)
      throw unsupportedObjectFormat(state.objectFormat);
    return;
  }
  applyCommandLine(state, name, value);
};

export const parseV2Capabilities = async (
  pktStream: AsyncIterable<PktLine>,
): Promise<V2Capabilities> => {
  const iter = pktStream[Symbol.asyncIterator]();
  try {
    const first = await readLine(iter);
    if (first !== VERSION_LINE) {
      throw v2CommandUnsupported(first ?? '');
    }

    const state: CapabilityState = {
      commands: new Set<string>(),
      fetchFeatures: new Set<string>(),
      agent: undefined,
      objectFormat: DEFAULT_OBJECT_FORMAT,
    };

    for (let line = await readLine(iter); line !== undefined; line = await readLine(iter)) {
      applyCapabilityLine(state, line);
    }

    return state.agent === undefined
      ? {
          version: 2,
          commands: state.commands,
          fetchFeatures: state.fetchFeatures,
          objectFormat: state.objectFormat,
        }
      : {
          version: 2,
          agent: state.agent,
          commands: state.commands,
          fetchFeatures: state.fetchFeatures,
          objectFormat: state.objectFormat,
        };
  } finally {
    // The raw `iter.next()` loop above does not engage the for-await runtime
    // hook, so an exception (or an early `return` from the caller) would
    // leave an upstream ReadableStream reader locked. Calling `iter.return`
    // propagates the release through `withPushback` into the HTTP session's
    // reader, mirroring `parseAdvertisedRefs`'s v1 cleanup.
    await iter.return?.();
  }
};

export const supportsV2Fetch = (caps: V2Capabilities): boolean =>
  caps.commands.has('fetch') && caps.commands.has('ls-refs');
