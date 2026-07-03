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

const CERT_VERSION_LINE = 'certificate version 0.1\n';

export interface PushCertPayloadInput {
  readonly pusher: string;
  readonly pushee: string;
  readonly nonce: string;
  readonly updates: ReadonlyArray<RefUpdate>;
}

export interface SignedReceivePackRequest {
  readonly updates: ReadonlyArray<RefUpdate>;
  readonly capabilities: ReadonlyArray<string>;
  readonly armor: string;
  readonly pusher: string;
  readonly pushee: string;
  readonly nonce: string;
  readonly packfile: Uint8Array;
}

// The cert header (version/pusher/pushee/nonce/blank) plus the no-caps
// ref-update lines, raw (unframed). This is both the P.2 signed-payload
// body and the set of pkt-line payloads P.1#2-#7 frame individually — the
// single source of truth that keeps the two byte-identical.
const certBodySegments = (input: PushCertPayloadInput): ReadonlyArray<Uint8Array> => [
  TEXT_ENCODER.encode(CERT_VERSION_LINE),
  TEXT_ENCODER.encode(`pusher ${input.pusher}\n`),
  TEXT_ENCODER.encode(`pushee ${input.pushee}\n`),
  TEXT_ENCODER.encode(`nonce ${input.nonce}\n`),
  TEXT_ENCODER.encode('\n'),
  ...input.updates.map((u) => updateLine(u, [])),
];

const concatBytes = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const total = parts.reduce((sum, p) => sum + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
};

export const buildPushCertPayload = (input: PushCertPayloadInput): Uint8Array =>
  concatBytes(certBodySegments(input));

const armorLines = (armor: string): ReadonlyArray<string> => {
  const trimmed = armor.endsWith('\n') ? armor.slice(0, -1) : armor;
  return trimmed.split('\n').map((line) => `${line}\n`);
};

export const buildSignedReceivePackRequest = (req: SignedReceivePackRequest): Uint8Array => {
  const opener = TEXT_ENCODER.encode(`push-cert\0 ${req.capabilities.join(' ')}`);
  const armorPayloads = armorLines(req.armor).map((line) => TEXT_ENCODER.encode(line));
  const endPayload = TEXT_ENCODER.encode('push-cert-end\n');
  const framed = encodePktStream([opener, ...certBodySegments(req), ...armorPayloads, endPayload]);
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
