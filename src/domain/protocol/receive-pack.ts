import type { ObjectId } from '../objects/object-id.js';
import { emptyReceiveUpdates, invalidReportStatus } from './error.js';
import { encodePktStream, type PktLine } from './pkt-line.js';

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
const TEXT_ENCODER = new TextEncoder();

export interface RefUpdate {
  readonly name: string;
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
}

export interface ReceivePackRequest {
  readonly updates: ReadonlyArray<RefUpdate>;
  readonly capabilities: ReadonlyArray<string>;
  readonly packfile: Uint8Array;
}

export interface RefStatus {
  readonly name: string;
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface ReceivePackResponse {
  readonly unpackOk: boolean;
  readonly unpackError?: string;
  readonly refUpdates: ReadonlyArray<RefStatus>;
}

const updateLine = (update: RefUpdate, caps: ReadonlyArray<string>): Uint8Array => {
  const tail = caps.length === 0 ? '' : `\0${caps.join(' ')}`;
  return TEXT_ENCODER.encode(`${update.oldId} ${update.newId} ${update.name}${tail}\n`);
};

export const buildReceivePackRequest = (req: ReceivePackRequest): Uint8Array => {
  if (req.updates.length === 0) throw emptyReceiveUpdates();
  const payloads = req.updates.map((u, idx) => updateLine(u, idx === 0 ? req.capabilities : []));
  const framed = encodePktStream(payloads);
  const out = new Uint8Array(framed.byteLength + req.packfile.byteLength);
  out.set(framed, 0);
  out.set(req.packfile, framed.byteLength);
  return out;
};

const stripTrailingNewline = (s: string): string => (s.endsWith('\n') ? s.slice(0, -1) : s);

const parseUnpackLine = (line: string): { ok: true } | { ok: false; error: string } => {
  if (line === 'unpack ok') return { ok: true };
  if (line.startsWith('unpack ')) {
    return { ok: false, error: line.slice('unpack '.length) };
  }
  throw invalidReportStatus(line);
};

const parseRefStatusLine = (line: string): RefStatus => {
  if (line.startsWith('ok ')) {
    return { name: line.slice('ok '.length), accepted: true };
  }
  if (line.startsWith('ng ')) {
    const rest = line.slice('ng '.length);
    const space = rest.indexOf(' ');
    if (space < 0) throw invalidReportStatus(line);
    return {
      name: rest.slice(0, space),
      accepted: false,
      reason: rest.slice(space + 1),
    };
  }
  throw invalidReportStatus(line);
};

const collectDataLines = async (source: AsyncIterable<PktLine>): Promise<string[]> => {
  const lines: string[] = [];
  for await (const pkt of source) {
    if (pkt.kind !== 'data') return lines;
    lines.push(stripTrailingNewline(TEXT_DECODER.decode(pkt.payload)));
  }
  return lines;
};

export const parseReceivePackResponse = async (
  source: AsyncIterable<PktLine>,
): Promise<ReceivePackResponse> => {
  const lines = await collectDataLines(source);
  if (lines.length === 0) throw invalidReportStatus('');
  const [first, ...rest] = lines as [string, ...string[]];
  const unpack = parseUnpackLine(first);
  if (!unpack.ok) {
    return { unpackOk: false, unpackError: unpack.error, refUpdates: [] };
  }
  const refUpdates = rest.map(parseRefStatusLine);
  return { unpackOk: true, refUpdates };
};
