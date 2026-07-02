import { ObjectId } from '../objects/object-id.js';
import { parseCapabilities } from './capabilities.js';
import {
  duplicateRef,
  emptyWants,
  invalidBaseUrl,
  invalidRefLine,
  missingCapabilities,
  missingServiceHeader,
  tooManyAdvertisedRefs,
  unknownAckStatus,
} from './error.js';
import { encodePktLine, encodePktStream, type PktLine } from './pkt-line.js';
import { parseSideBand } from './side-band.js';

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });
const TEXT_ENCODER = new TextEncoder();

const SHA_ANY_RE = /^[0-9a-f]{40}([0-9a-f]{24})?$/i;
const SERVICE_LINE_RE = /^# service=(?<service>[^\n]+)\n?$/;
const PEELED_SUFFIX = '^{}';

/**
 * Hard cap on the number of refs the parser will accept in a single
 * advertisement. A malicious server could otherwise emit millions of ref lines
 * to exhaust heap before the existing `maxResponseBytes` cap (which gates the
 * POST pack body) would trigger. 500_000 matches the order of magnitude that
 * canonical git tolerates and is well past anything a legitimate repo emits.
 */
export const MAX_ADVERTISED_REFS = 500_000;

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
  /**
   * Partial-clone object filter — a canonical filter spec (see
   * `parseObjectFilter`). When set, a `filter <spec>` line is emitted; the
   * caller must have negotiated the `filter` capability.
   */
  readonly filter?: string;
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
  /** Commits the server flagged as new shallow boundaries (empty unless `expectShallow` was set). */
  readonly shallow: ReadonlyArray<ObjectId>;
  /** Commits the server flagged as no-longer-shallow (empty unless `expectShallow` was set). */
  readonly unshallow: ReadonlyArray<ObjectId>;
}

export interface ShallowUpdates {
  readonly shallow: ReadonlyArray<ObjectId>;
  readonly unshallow: ReadonlyArray<ObjectId>;
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
    // Inclusive cap: enforce BEFORE `handleRefLine` inserts the next entry so
    // the limit+1 entry never lands in `acc.refs` or `acc.byName`. The
    // capability line counts as the first ref (it carries the first oid+name
    // pair), so the cap fires after exactly MAX_ADVERTISED_REFS lines.
    if (acc.refs.length >= MAX_ADVERTISED_REFS) {
      throw tooManyAdvertisedRefs(acc.refs.length + 1, MAX_ADVERTISED_REFS);
    }
    const line = stripTrailingNewline(TEXT_DECODER.decode(pkt.value.payload));
    capabilities = handleRefLine(acc, capabilities, line);
    pkt = await iter.next();
  }
  return { capabilities: capabilities ?? [], refs: acc.refs };
};

export interface ParseAdvertisedRefsOptions {
  /**
   * Whether the source carries the HTTP discovery `# service=...\n0000`
   * prologue. SSH's `git-upload-pack`/`git-receive-pack` advertisement has no
   * such prologue — the ref/capability pkt-lines start immediately. Defaults
   * to `true` (HTTP shape) for backward compatibility.
   */
  readonly servicePrologue?: boolean;
}

export const parseAdvertisedRefs = async (
  source: AsyncIterable<PktLine>,
  expectedService: Service,
  options?: ParseAdvertisedRefsOptions,
): Promise<Advertisement> => {
  const iter = source[Symbol.asyncIterator]();
  try {
    if (options?.servicePrologue ?? true) {
      await consumeServiceHeader(iter, expectedService);
    }
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

const filterLine = (spec: string): Uint8Array => TEXT_ENCODER.encode(`filter ${spec}\n`);

const DONE_FRAME = encodePktLine(TEXT_ENCODER.encode('done\n'));

export const buildUploadPackRequest = (req: WantHaveRequest): Uint8Array => {
  if (req.wants.length === 0) throw emptyWants();
  const wantPayloads: Uint8Array[] = [];
  req.wants.forEach((w, idx) => {
    wantPayloads.push(wantLine(w, idx === 0 ? req.capabilities : []));
  });
  if (req.depth !== undefined) wantPayloads.push(deepenLine(req.depth));
  if (req.filter !== undefined) wantPayloads.push(filterLine(req.filter));
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

interface ShallowParseState {
  readonly shallow: ObjectId[];
  readonly unshallow: ObjectId[];
}

const SHALLOW_PREFIX = 'shallow ';
const UNSHALLOW_PREFIX = 'unshallow ';

const parseShallowOid = (text: string, prefix: string): ObjectId => {
  const stripped = stripTrailingNewline(text);
  const raw = stripped.slice(prefix.length);
  if (!SHA_ANY_RE.test(raw)) throw invalidRefLine(stripped);
  return ObjectId.from(raw);
};

const tryConsumeShallowLine = (text: string, state: ShallowParseState): boolean => {
  if (text.startsWith(SHALLOW_PREFIX)) {
    state.shallow.push(parseShallowOid(text, SHALLOW_PREFIX));
    return true;
  }
  if (text.startsWith(UNSHALLOW_PREFIX)) {
    state.unshallow.push(parseShallowOid(text, UNSHALLOW_PREFIX));
    return true;
  }
  return false;
};

/**
 * Consume the optional shallow-response section emitted by `git-upload-pack`
 * when the request carried `deepen <N>`:
 *
 *   shallow <oid>\n     <- zero or more
 *   unshallow <oid>\n   <- zero or more
 *   0000                <- flush ends the section
 *
 * The iterator is advanced past the terminating flush (or the first
 * non-shallow data line — that line is returned as a buffered peek so the
 * downstream consumer can resume cleanly).
 */
export const parseShallowResponse = async (
  iter: AsyncIterator<PktLine>,
): Promise<ShallowUpdates> => {
  const state: ShallowParseState = { shallow: [], unshallow: [] };
  let pkt = await iter.next();
  while (!pkt.done) {
    if (pkt.value.kind !== 'data') {
      // Flush (or delim) ends the shallow block. Iterator is already past it.
      return { shallow: state.shallow, unshallow: state.unshallow };
    }
    const text = TEXT_DECODER.decode(pkt.value.payload);
    if (!tryConsumeShallowLine(text, state)) {
      // First non-shallow data line — return it as a buffered peek for the
      // next consumer (splitMeta). Encoded via the WeakMap on the iterator.
      pushbackBuffer.set(iter, pkt.value);
      return { shallow: state.shallow, unshallow: state.unshallow };
    }
    pkt = await iter.next();
  }
  return { shallow: state.shallow, unshallow: state.unshallow };
};

/**
 * Per-iterator one-line pushback used by `parseShallowResponse` to hand a
 * data line back to `splitMeta`. WeakMap keying avoids leaking when the
 * iterator is GCed.
 */
const pushbackBuffer = new WeakMap<AsyncIterator<PktLine>, PktLine>();

const splitMeta = async (iter: AsyncIterator<PktLine>): Promise<ResponseSplit> => {
  const acks: AckEntry[] = [];
  let nak = false;
  const first: PktLine | undefined = pushbackBuffer.get(iter);
  // equivalent-mutant: flipping the `if (first !== undefined)` guard either
  // way is observable-equivalent. WeakMap.delete is a no-op when the key
  // is absent (the always-delete mutant), and skipping the delete leaves a
  // stale entry that GC reclaims when the iterator is unreferenced (the
  // never-delete mutant). The next splitMeta call gets a fresh iterator
  // identity, so the stale entry is unreachable.
  // Stryker disable next-line ConditionalExpression: equivalent — always-delete hits a no-op WeakMap.delete on an absent key; never-delete leaves a stale entry on an iterator no other splitMeta call can reach.
  // Stryker disable next-line EqualityOperator: equivalent — inverting the guard only swaps a no-op delete for a never-read stale entry; the WeakMap is keyed per-iterator and read once.
  if (first !== undefined) pushbackBuffer.delete(iter);
  let pkt: IteratorResult<PktLine> =
    first !== undefined ? { done: false, value: first } : await iter.next();
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
  options: {
    readonly sideBand: boolean;
    readonly onProgress?: (text: string) => void;
    readonly expectShallow?: boolean;
  },
): Promise<UploadPackResponse> => {
  const iter = source[Symbol.asyncIterator]();
  // equivalent-mutant: flipping the `options.expectShallow === true` gate to
  // always-true is observable-equivalent on non-shallow streams. When the
  // first pkt-line is `NAK\n`, `parseShallowResponse` recognises it as a
  // non-shallow data line, pushes it back into the iterator via
  // `pushbackBuffer`, and returns empty arrays. `splitMeta` then retrieves
  // the buffered NAK and processes it identically to the non-shallow path.
  const shallowUpdates: ShallowUpdates =
    options.expectShallow === true
      ? await parseShallowResponse(iter)
      : { shallow: [], unshallow: [] };
  const meta = await splitMeta(iter);
  return {
    acks: meta.acks,
    nak: meta.nak,
    shallow: shallowUpdates.shallow,
    unshallow: shallowUpdates.unshallow,
    packBody: { [Symbol.asyncIterator]: () => packBodyStream(meta.buffered, iter, options) },
  };
};
