import type { ObjectId } from '../objects/object-id.js';
import { emptyReceiveUpdates, invalidReportStatus } from './error.js';
import { assertNotRemoteError, encodePktStream, type PktLine } from './pkt-line.js';

// Stryker disable next-line ObjectLiteral: equivalent — TextDecoder's fatal option defaults to false, so the empty options object configures an identical decoder
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
  readonly packfile?: Uint8Array | undefined;
}

/**
 * What a `report-status-v2` receiver's `option` lines say about one `ok`: the
 * ref it was really stored under and the ids it really moved between, each
 * absent when the receiver did not say.
 */
export interface RefStatusReport {
  readonly refName?: string;
  readonly oldId?: ObjectId;
  readonly newId?: ObjectId;
  readonly forcedUpdate?: boolean;
}

export interface RefStatus {
  readonly name: string;
  readonly accepted: boolean;
  readonly reason?: string;
  /** Set on an `ok` that `option` lines follow. */
  readonly report?: RefStatusReport;
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

// git sends commands + flush and no pack when every command is a delete.
const withPackfile = (framed: Uint8Array, packfile: Uint8Array | undefined): Uint8Array => {
  if (packfile === undefined) return framed;
  const out = new Uint8Array(framed.byteLength + packfile.byteLength);
  out.set(framed, 0);
  out.set(packfile, framed.byteLength);
  return out;
};

export const buildReceivePackRequest = (req: ReceivePackRequest): Uint8Array => {
  if (req.updates.length === 0) throw emptyReceiveUpdates();
  const payloads = req.updates.map((u, idx) => updateLine(u, idx === 0 ? req.capabilities : []));
  const framed = encodePktStream(payloads);
  return withPackfile(framed, req.packfile);
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
  readonly packfile?: Uint8Array | undefined;
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
  return withPackfile(framed, req.packfile);
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

/**
 * git arms `PACKET_READ_DIE_ON_ERR_PACKET` on `receive_status()`'s own reader,
 * so an error packet anywhere in the report — first line or after a clean
 * `unpack ok` — is the remote's message, never an unparseable status line
 * (measured, git 2.55.0). Callers hand this the report pkt-lines themselves:
 * under `side-band-64k` those are already the band-1 payload's own packets,
 * which is where git's armed reader sits too.
 */
const collectDataLines = async (source: AsyncIterable<PktLine>): Promise<string[]> => {
  const lines: string[] = [];
  for await (const pkt of source) {
    if (pkt.kind !== 'data') return lines;
    const text = TEXT_DECODER.decode(pkt.payload);
    assertNotRemoteError(text);
    lines.push(stripTrailingNewline(text));
  }
  return lines;
};

const OPTION_PREFIX = 'option ';
const HEX_ID = /^[0-9a-f]+$/;

/** git's object-id parse of an option value: the id the value starts with, when it does. */
const parseOptionId = (value: string | undefined, hexLength: number): ObjectId | undefined => {
  const hex = value?.slice(0, hexLength);
  return hex?.length === hexLength && HEX_ID.test(hex) ? (hex as ObjectId) : undefined;
};

/** One `option <key> [<value>]` line folded into the report it extends; an unknown key or an unparseable id leaves it as it was. */
const withOption = (report: RefStatusReport, line: string, hexLength: number): RefStatusReport => {
  const body = line.slice(OPTION_PREFIX.length);
  const space = body.indexOf(' ');
  const key = space < 0 ? body : body.slice(0, space);
  const value = space < 0 ? undefined : body.slice(space + 1);
  if (key === 'refname') return value === undefined ? report : { ...report, refName: value };
  if (key === 'forced-update') return { ...report, forcedUpdate: true };
  const id = parseOptionId(value, hexLength);
  if (id === undefined) return report;
  if (key === 'old-oid') return { ...report, oldId: id };
  return key === 'new-oid' ? { ...report, newId: id } : report;
};

/** git's `receive_status`: an `option` line extends the report of the `ok` it follows. */
const foldStatusLines = (
  lines: ReadonlyArray<string>,
  hexLength: number,
): ReadonlyArray<RefStatus> => {
  const statuses: RefStatus[] = [];
  for (const line of lines) {
    if (!line.startsWith(OPTION_PREFIX)) {
      statuses.push(parseRefStatusLine(line));
      continue;
    }
    const last = statuses[statuses.length - 1];
    if (last?.accepted !== true) throw invalidReportStatus(line);
    statuses[statuses.length - 1] = {
      ...last,
      report: withOption(last.report ?? {}, line, hexLength),
    };
  }
  return statuses;
};

export const parseReceivePackResponse = async (
  source: AsyncIterable<PktLine>,
  hexLength: 40 | 64 = 40,
): Promise<ReceivePackResponse> => {
  const lines = await collectDataLines(source);
  if (lines.length === 0) throw invalidReportStatus('');
  const [first, ...rest] = lines as [string, ...string[]];
  const unpack = parseUnpackLine(first);
  if (!unpack.ok) {
    return { unpackOk: false, unpackError: unpack.error, refUpdates: [] };
  }
  return { unpackOk: true, refUpdates: foldStatusLines(rest, hexLength) };
};
