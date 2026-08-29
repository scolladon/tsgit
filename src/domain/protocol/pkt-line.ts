import { invalidPktLength, pktLengthReserved, pktTooLarge, pktTruncated } from './error.js';

export type PktLine =
  | { readonly kind: 'data'; readonly payload: Uint8Array }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/**
 * One request/response round-trip against a git service (`git-upload-pack` /
 * `git-receive-pack`), transport-agnostic. Lives in `domain/protocol` (rather
 * than the `GitServiceSession` seam that defines it) because primitives —
 * which may not import from `application/commands` — need to accept it as a
 * parameter.
 */
export type GitExchange = (requestBytes: Uint8Array) => Promise<AsyncIterable<PktLine>>;

export const MAX_PKT_LINE_PAYLOAD = 65516;

const ENCODER = new TextEncoder();
// Stryker disable next-line ObjectLiteral: equivalent — TextDecoder's fatal option defaults to false, so the empty options object configures an identical decoder
const DECODER = new TextDecoder('utf-8', { fatal: false });
// Stryker disable next-line Regex: equivalent — the tested header decodes from exactly 4 bytes, hence at most 4 UTF-16 units, so a match of four hex chars must span the whole string and each anchor is redundant
const HEX_LENGTH_RE = /^[0-9a-f]{4}$/i;
const PKT_LENGTH_BYTES = 4;
const MAX_PKT_LINE_FRAME = MAX_PKT_LINE_PAYLOAD + PKT_LENGTH_BYTES;

export const FLUSH_PKT: Readonly<Uint8Array> = ENCODER.encode('0000');
export const DELIM_PKT: Readonly<Uint8Array> = ENCODER.encode('0001');
export const RESPONSE_END_PKT: Readonly<Uint8Array> = ENCODER.encode('0002');

const lengthPrefix = (length: number): Uint8Array => {
  // length is 0..MAX_PKT_LINE_PAYLOAD + 4 == 65520, fits in 4 hex chars
  const hex = (length + 0x10000).toString(16).slice(-4);
  return ENCODER.encode(hex);
};

export const encodePktLine = (payload: Uint8Array): Uint8Array => {
  if (payload.byteLength > MAX_PKT_LINE_PAYLOAD) {
    throw new RangeError(
      `pkt-line: payload too large (${payload.byteLength} > ${MAX_PKT_LINE_PAYLOAD})`,
    );
  }
  const total = payload.byteLength + PKT_LENGTH_BYTES;
  const out = new Uint8Array(total);
  out.set(lengthPrefix(total), 0);
  out.set(payload, PKT_LENGTH_BYTES);
  return out;
};

const concatPktLines = (payloads: ReadonlyArray<Uint8Array>, trailer: Uint8Array): Uint8Array => {
  let total = trailer.byteLength;
  for (const p of payloads) {
    if (p.byteLength > MAX_PKT_LINE_PAYLOAD) {
      throw new RangeError(
        `pkt-line: payload too large (${p.byteLength} > ${MAX_PKT_LINE_PAYLOAD})`,
      );
    }
    total += p.byteLength + PKT_LENGTH_BYTES;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of payloads) {
    const length = p.byteLength + PKT_LENGTH_BYTES;
    out.set(lengthPrefix(length), off);
    off += PKT_LENGTH_BYTES;
    out.set(p, off);
    off += p.byteLength;
  }
  out.set(trailer, off);
  return out;
};

export const encodePktStream = (payloads: ReadonlyArray<Uint8Array>): Uint8Array =>
  concatPktLines(payloads, FLUSH_PKT);

/**
 * Like `encodePktStream` but WITHOUT the terminating flush-pkt — for framing
 * a section that is terminated by something other than a flush (e.g. the v1
 * have-list immediately followed by "done", or a v2 arg-list followed by more
 * frames).
 */
export const encodePktLines = (payloads: ReadonlyArray<Uint8Array>): Uint8Array =>
  concatPktLines(payloads, new Uint8Array(0));

const parseLength = (view: Uint8Array, offset: number): number => {
  const header = DECODER.decode(view.subarray(offset, offset + PKT_LENGTH_BYTES));
  if (!HEX_LENGTH_RE.test(header)) {
    throw invalidPktLength(header);
  }
  const length = Number.parseInt(header, 16);
  if (length > MAX_PKT_LINE_FRAME) {
    throw pktTooLarge(length);
  }
  return length;
};

export const decodePktStream = (
  source: AsyncIterable<Uint8Array>,
  options?: { readonly v2?: boolean },
): AsyncIterable<PktLine> => {
  const v2 = options?.v2 ?? false;
  return {
    [Symbol.asyncIterator]: () => decode(source, v2),
  };
};

type Decision =
  | { readonly kind: 'flush' | 'delim' | 'response-end'; readonly consume: number }
  | { readonly kind: 'data'; readonly consume: number }
  | { readonly kind: 'wait' };

const classify = (length: number, available: number, v2: boolean): Decision => {
  if (length === 0) return { kind: 'flush', consume: PKT_LENGTH_BYTES };
  if (length === 1) {
    if (!v2) throw pktLengthReserved(1);
    return { kind: 'delim', consume: PKT_LENGTH_BYTES };
  }
  if (length === 2) {
    if (!v2) throw pktLengthReserved(2);
    return { kind: 'response-end', consume: PKT_LENGTH_BYTES };
  }
  if (length < PKT_LENGTH_BYTES) {
    throw pktLengthReserved(length);
  }
  if (available < length) return { kind: 'wait' };
  return { kind: 'data', consume: length };
};

/**
 * Drain every complete pkt-line from `view[start, limit)`, yielding one
 * `PktLine` per frame and stopping at the first incomplete header/body (or
 * once fewer than `PKT_LENGTH_BYTES` remain). Returns the offset reached —
 * `limit` when everything drained, otherwise the start of the surviving
 * incomplete frame. `payload` is always copied via `new Uint8Array(...)`,
 * never `.slice()`: `view` may be a `Buffer` (a `Uint8Array` subclass whose
 * `slice` ALIASES the source instead of copying), so a caller that recycles
 * its chunk buffer between yields must not be able to corrupt an
 * already-yielded payload.
 */
function* drainFrames(
  view: Uint8Array,
  limit: number,
  v2: boolean,
  start: number,
): Generator<PktLine, number, unknown> {
  let offset = start;
  while (limit - offset >= PKT_LENGTH_BYTES) {
    const length = parseLength(view, offset);
    const decision = classify(length, limit - offset, v2);
    if (decision.kind === 'wait') break;
    if (decision.kind === 'data') {
      yield {
        kind: 'data',
        payload: new Uint8Array(
          view.subarray(offset + PKT_LENGTH_BYTES, offset + decision.consume),
        ),
      };
    } else {
      yield { kind: decision.kind };
    }
    offset += decision.consume;
  }
  return offset;
}

/**
 * Carries only the trailing INCOMPLETE pkt-line between chunks, never the
 * chunk itself — a delivered chunk of any size is drained of every complete
 * pkt-line it contains. The surviving tail is always shorter than one frame
 * (MAX_PKT_LINE_FRAME bytes): a declared length above that refuses via
 * parseLength before any body bytes are considered for buffering.
 *
 * Backed by ONE reusable `MAX_PKT_LINE_FRAME`-sized buffer rather than a
 * fresh tail+chunk concatenation per `accept` call: the naive
 * concatenate-then-slice approach copies the ENTIRE pending tail on every
 * delivered chunk, so a byte-at-a-time ("byte-drip") stream costs O(n²) —
 * copying a growing ~64 KiB tail on every single byte. Here, a pending tail
 * is topped up in place (bounded by the buffer's fixed capacity, never by
 * how much has accumulated so far) and drained frames are compacted to the
 * front with `copyWithin`, so accepting a chunk costs O(chunk), never
 * O(pending tail).
 */
class PktBuffer {
  private readonly buf = new Uint8Array(MAX_PKT_LINE_FRAME);
  private used = 0;

  get pending(): number {
    return this.used;
  }

  *accept(chunk: Uint8Array, v2: boolean): Generator<PktLine, void, unknown> {
    let chunkOffset = 0;
    while (chunkOffset < chunk.byteLength) {
      // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — `this.used` only ever grows via `Math.min`-bounded additions or resets to a `byteLength` difference, so it can never go negative; forcing this branch when `this.used === 0` only routes the first top-up through `this.buf` instead of parsing `chunk` directly — `drainFrames` reads either buffer identically, and every byte of `chunk` still ends up copied into `this.buf` exactly once, in order (now, or via the trailing-leftover copy below) — same yielded frames, same final `used`.
      if (this.used > 0) {
        // A pending tail exists — top it up with only as much of `chunk` as
        // fits the buffer's remaining capacity (never more; a single frame
        // can never exceed MAX_PKT_LINE_FRAME, so filling to capacity is
        // always enough to complete it) and drain whatever that yields.
        const room = this.buf.length - this.used;
        const take = Math.min(room, chunk.byteLength - chunkOffset);
        this.buf.set(chunk.subarray(chunkOffset, chunkOffset + take), this.used);
        this.used += take;
        chunkOffset += take;
        const consumed = yield* drainFrames(this.buf, this.used, v2, 0);
        this.buf.copyWithin(0, consumed, this.used);
        this.used -= consumed;
        continue;
      }
      // No pending tail — parse straight out of `chunk`, copying nothing
      // for any complete frame it contains.
      const consumed = yield* drainFrames(chunk, chunk.byteLength, v2, chunkOffset);
      chunkOffset = consumed;
      // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — `drainFrames` returns an offset within `[chunkOffset, chunk.byteLength]` by construction (`classify` only advances `consume` up to `available`), so `chunkOffset <= chunk.byteLength` always holds; forcing this branch true at the `===` boundary computes `leftover = 0`, `.set()`s an empty slice, and reassigns `chunkOffset` to its own unchanged value — a genuine no-op.
      if (chunkOffset < chunk.byteLength) {
        // A trailing incomplete frame remains — buffer just that slice.
        const leftover = chunk.byteLength - chunkOffset;
        this.buf.set(chunk.subarray(chunkOffset), 0);
        this.used = leftover;
        chunkOffset = chunk.byteLength;
      }
    }
  }
}

async function* decode(
  source: AsyncIterable<Uint8Array>,
  v2: boolean,
): AsyncGenerator<PktLine, void, unknown> {
  const buf = new PktBuffer();
  for await (const chunk of source) {
    yield* buf.accept(chunk, v2);
  }
  if (buf.pending > 0) {
    throw pktTruncated(buf.pending);
  }
}
