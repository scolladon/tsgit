import { ObjectId } from '../objects/object-id.js';
import { parseCapabilities } from './capabilities.js';
import {
  duplicateRef,
  emptyWants,
  invalidBaseUrl,
  invalidRefLine,
  missingCapabilities,
  missingServiceHeader,
  unknownAckStatus,
} from './error.js';
import { encodePktLine, encodePktStream, type PktLine } from './pkt-line.js';
import { parseSideBand } from './side-band.js';

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
const TEXT_ENCODER = new TextEncoder();

const SHA_ANY_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const SERVICE_LINE_RE = /^# service=(?<service>[^\n]+)\n?$/;
const PEELED_SUFFIX = '^{}';

export interface AdvertisedRef {
  readonly name: string;
  readonly id: ObjectId;
  readonly peeled?: ObjectId;
}

export interface Advertisement {
  readonly capabilities: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<AdvertisedRef>;
  readonly head?: AdvertisedRef;
}

export interface WantHaveRequest {
  readonly wants: ReadonlyArray<ObjectId>;
  readonly haves: ReadonlyArray<ObjectId>;
  readonly capabilities: ReadonlyArray<string>;
  readonly depth?: number;
  readonly done?: boolean;
}

export type AckStatus = 'ack' | 'continue' | 'common' | 'ready';

export interface AckEntry {
  readonly id: ObjectId;
  readonly status: AckStatus;
}

export interface UploadPackResponse {
  readonly acks: ReadonlyArray<AckEntry>;
  readonly nak: boolean;
  readonly packBody: AsyncIterable<Uint8Array>;
}

export type Service = 'git-upload-pack' | 'git-receive-pack';

export const buildDiscoveryUrl = (baseUrl: string, service: Service): string => {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw invalidBaseUrl('invalid URL');
  }
  if (parsed.hash !== '') {
    throw invalidBaseUrl('fragment must not be set');
  }
  const path = parsed.pathname.endsWith('/') ? parsed.pathname.slice(0, -1) : parsed.pathname;
  const query =
    parsed.search === '' ? `?service=${service}` : `${parsed.search}&service=${service}`;
  return `${parsed.protocol}//${parsed.host}${path}/info/refs${query}`;
};

const stripTrailingNewline = (s: string): string => (s.endsWith('\n') ? s.slice(0, -1) : s);

const validateOidString = (s: string): ObjectId => {
  if (!SHA_ANY_RE.test(s)) {
    throw invalidRefLine(s);
  }
  return ObjectId.from(s);
};

const splitFirstRef = (
  line: string,
): { readonly id: string; readonly name: string; readonly tail: string } => {
  const nul = line.indexOf('\0');
  if (nul < 0) throw missingCapabilities();
  const head = line.slice(0, nul);
  const tail = line.slice(nul + 1);
  const space = head.indexOf(' ');
  if (space < 0) throw invalidRefLine(line);
  const id = head.slice(0, space);
  const name = head.slice(space + 1);
  if (name.length === 0) throw invalidRefLine(line);
  return { id, name, tail };
};

const splitRef = (line: string): { readonly id: string; readonly name: string } => {
  const space = line.indexOf(' ');
  if (space < 0) throw invalidRefLine(line);
  const id = line.slice(0, space);
  const name = line.slice(space + 1);
  if (name.length === 0) throw invalidRefLine(line);
  return { id, name };
};

const findHead = (
  capabilities: ReadonlyArray<string>,
  refs: ReadonlyArray<AdvertisedRef>,
): AdvertisedRef | undefined => {
  const directHead = refs.find((r) => r.name === 'HEAD');
  if (directHead) return directHead;
  const symref = capabilities.find((c) => c.startsWith('symref=HEAD:'));
  if (!symref) return undefined;
  const target = symref.slice('symref=HEAD:'.length);
  const targetRef = refs.find((r) => r.name === target);
  if (!targetRef) return undefined;
  return { name: 'HEAD', id: targetRef.id };
};

const consumeServiceHeader = async (
  iter: AsyncIterator<PktLine>,
  expectedService: Service,
): Promise<void> => {
  const first = await iter.next();
  if (first.done || first.value.kind !== 'data') {
    throw missingServiceHeader(expectedService, '');
  }
  const text = stripTrailingNewline(TEXT_DECODER.decode(first.value.payload));
  const match = SERVICE_LINE_RE.exec(`${text}\n`);
  // The regex always captures a non-empty `service` group when it matches,
  // so `match.groups.service` is guaranteed defined here.
  const actual = match?.groups?.service;
  if (actual === undefined) {
    throw missingServiceHeader(expectedService, text);
  }
  if (actual !== expectedService) {
    throw missingServiceHeader(expectedService, actual);
  }
  const sep = await iter.next();
  if (sep.done || sep.value.kind !== 'flush') {
    throw missingServiceHeader(expectedService, actual);
  }
};

interface RefAccumulator {
  readonly refs: AdvertisedRef[];
  readonly byName: Map<string, number>;
}

const appendNewRef = (acc: RefAccumulator, name: string, id: ObjectId): void => {
  if (acc.byName.has(name)) throw duplicateRef(name);
  acc.refs.push({ id, name });
  acc.byName.set(name, acc.refs.length - 1);
};

const applyPeeled = (acc: RefAccumulator, line: string): void => {
  const trimmed = line.slice(0, -PEELED_SUFFIX.length);
  const split = splitRef(trimmed);
  const peeled = validateOidString(split.id);
  const baseIdx = acc.byName.get(split.name);
  if (baseIdx === undefined) throw invalidRefLine(line);
  // baseIdx is taken from byName, kept in lockstep with refs.push — index is
  // always valid, so the lookup here cannot return undefined.
  const base = acc.refs[baseIdx] as AdvertisedRef;
  acc.refs[baseIdx] = { ...base, peeled };
};

const handleRefLine = (
  acc: RefAccumulator,
  capabilities: ReadonlyArray<string> | undefined,
  line: string,
): ReadonlyArray<string> => {
  if (capabilities === undefined) {
    const split = splitFirstRef(line);
    appendNewRef(acc, split.name, validateOidString(split.id));
    return parseCapabilities(split.tail);
  }
  if (line.endsWith(PEELED_SUFFIX)) {
    applyPeeled(acc, line);
    return capabilities;
  }
  const split = splitRef(line);
  appendNewRef(acc, split.name, validateOidString(split.id));
  return capabilities;
};

const collectRefs = async (
  iter: AsyncIterator<PktLine>,
): Promise<{
  readonly capabilities: ReadonlyArray<string>;
  readonly refs: ReadonlyArray<AdvertisedRef>;
}> => {
  const acc: RefAccumulator = { refs: [], byName: new Map() };
  let capabilities: ReadonlyArray<string> | undefined;
  let pkt = await iter.next();
  while (!pkt.done) {
    if (pkt.value.kind !== 'data') break;
    const line = stripTrailingNewline(TEXT_DECODER.decode(pkt.value.payload));
    capabilities = handleRefLine(acc, capabilities, line);
    pkt = await iter.next();
  }
  return { capabilities: capabilities ?? [], refs: acc.refs };
};

export const parseAdvertisedRefs = async (
  source: AsyncIterable<PktLine>,
  expectedService: Service,
): Promise<Advertisement> => {
  const iter = source[Symbol.asyncIterator]();
  try {
    await consumeServiceHeader(iter, expectedService);
    const { capabilities, refs } = await collectRefs(iter);
    const head = findHead(capabilities, refs);
    return head ? { capabilities, refs, head } : { capabilities, refs };
  } finally {
    // The raw `iter.next()` loop above does not engage the for-await runtime
    // hook, so an exception thrown by consumeServiceHeader / collectRefs would
    // leave an upstream ReadableStream reader locked. Calling `iter.return`
    // propagates the cancel through the decodePktStream generator into the
    // ReadableStream adapter at the call site (clone / fetch-pack).
    await iter.return?.();
  }
};

const wantLine = (oid: ObjectId, caps: ReadonlyArray<string>): Uint8Array => {
  const tail = caps.length === 0 ? '' : ` ${caps.join(' ')}`;
  return TEXT_ENCODER.encode(`want ${oid}${tail}\n`);
};

const haveLine = (oid: ObjectId): Uint8Array => TEXT_ENCODER.encode(`have ${oid}\n`);

const deepenLine = (depth: number): Uint8Array => TEXT_ENCODER.encode(`deepen ${depth}\n`);

const DONE_FRAME = encodePktLine(TEXT_ENCODER.encode('done\n'));

export const buildUploadPackRequest = (req: WantHaveRequest): Uint8Array => {
  if (req.wants.length === 0) throw emptyWants();
  const wantPayloads: Uint8Array[] = [];
  req.wants.forEach((w, idx) => {
    wantPayloads.push(wantLine(w, idx === 0 ? req.capabilities : []));
  });
  if (req.depth !== undefined) wantPayloads.push(deepenLine(req.depth));
  const wantStream = encodePktStream(wantPayloads);
  const haveStream =
    req.haves.length === 0 ? new Uint8Array(0) : encodePktStream(req.haves.map(haveLine));
  const trailer = req.done ? DONE_FRAME : new Uint8Array(0);
  const total = new Uint8Array(wantStream.byteLength + haveStream.byteLength + trailer.byteLength);
  let off = 0;
  total.set(wantStream, off);
  off += wantStream.byteLength;
  total.set(haveStream, off);
  off += haveStream.byteLength;
  total.set(trailer, off);
  return total;
};

interface ResponseSplit {
  readonly acks: ReadonlyArray<AckEntry>;
  readonly nak: boolean;
  readonly buffered: ReadonlyArray<PktLine>;
}

const parseAckLine = (text: string): AckEntry => {
  // Caller (splitMeta) guarantees `text` starts with the literal `'ACK '`
  // (with a trailing space), so split(' ') always produces at least 2 parts
  // and parts[1] is the oid token.
  const stripped = stripTrailingNewline(text);
  const parts = stripped.split(' ');
  const id = ObjectId.from(parts[1] as string);
  const status = parts[2];
  if (status === undefined) return { id, status: 'ack' };
  if (status === 'continue' || status === 'common' || status === 'ready') {
    return { id, status };
  }
  throw unknownAckStatus(status);
};

const splitMeta = async (iter: AsyncIterator<PktLine>): Promise<ResponseSplit> => {
  const acks: AckEntry[] = [];
  let nak = false;
  let pkt = await iter.next();
  while (!pkt.done) {
    if (pkt.value.kind !== 'data') {
      return { acks, nak, buffered: [pkt.value] };
    }
    const text = TEXT_DECODER.decode(pkt.value.payload);
    if (text.startsWith('ACK ')) {
      acks.push(parseAckLine(text));
      pkt = await iter.next();
      continue;
    }
    if (text.startsWith('NAK')) {
      nak = true;
      pkt = await iter.next();
      continue;
    }
    return { acks, nak, buffered: [pkt.value] };
  }
  return { acks, nak, buffered: [] };
};

async function* replay(
  buffered: ReadonlyArray<PktLine>,
  iter: AsyncIterator<PktLine>,
): AsyncGenerator<PktLine, void, unknown> {
  for (const b of buffered) yield b;
  let pkt = await iter.next();
  while (!pkt.done) {
    yield pkt.value;
    pkt = await iter.next();
  }
}

async function* rawPackBytes(
  source: AsyncIterable<PktLine>,
): AsyncGenerator<Uint8Array, void, unknown> {
  for await (const pkt of source) {
    if (pkt.kind !== 'data') return;
    yield pkt.payload;
  }
}

async function* packBodyStream(
  buffered: ReadonlyArray<PktLine>,
  iter: AsyncIterator<PktLine>,
  options: { readonly sideBand: boolean; readonly onProgress?: (text: string) => void },
): AsyncGenerator<Uint8Array, void, unknown> {
  const replayed = replay(buffered, iter);
  if (options.sideBand) {
    const sbOptions = options.onProgress ? { onProgress: options.onProgress } : {};
    yield* parseSideBand(replayed, sbOptions);
    return;
  }
  yield* rawPackBytes(replayed);
}

export const parseUploadPackResponse = async (
  source: AsyncIterable<PktLine>,
  options: { readonly sideBand: boolean; readonly onProgress?: (text: string) => void },
): Promise<UploadPackResponse> => {
  const iter = source[Symbol.asyncIterator]();
  const meta = await splitMeta(iter);
  return {
    acks: meta.acks,
    nak: meta.nak,
    packBody: { [Symbol.asyncIterator]: () => packBodyStream(meta.buffered, iter, options) },
  };
};
