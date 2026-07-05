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
const DECODER = new TextDecoder('utf-8', { fatal: false });
const HEX_LENGTH_RE = /^[0-9a-f]{4}$/i;
const PKT_LENGTH_BYTES = 4;
const ACC_CAPACITY = MAX_PKT_LINE_PAYLOAD + PKT_LENGTH_BYTES;

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

const parseLength = (acc: Uint8Array): number => {
  const header = DECODER.decode(acc.subarray(0, PKT_LENGTH_BYTES));
  if (!HEX_LENGTH_RE.test(header)) {
    throw invalidPktLength(header);
  }
  const length = Number.parseInt(header, 16);
  if (length > ACC_CAPACITY) {
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

class PktBuffer {
  readonly acc = new Uint8Array(ACC_CAPACITY);
  used = 0;

  accept(chunk: Uint8Array): void {
    if (this.used + chunk.byteLength <= ACC_CAPACITY) {
      this.acc.set(chunk, this.used);
      this.used += chunk.byteLength;
      return;
    }
    // Fill the header bytes from the chunk so parseLength can surface
    // INVALID_PKT_LENGTH or PKT_TOO_LARGE; never try to buffer the body.
    const headerNeeded = Math.max(0, PKT_LENGTH_BYTES - this.used);
    const headerSlice = chunk.subarray(0, headerNeeded);
    this.acc.set(headerSlice, this.used);
    this.used += headerSlice.byteLength;
    parseLength(this.acc);
    throw pktTooLarge(this.used);
  }

  drop(consume: number): void {
    this.acc.copyWithin(0, consume, this.used);
    this.used -= consume;
  }

  slice(from: number, to: number): Uint8Array {
    return this.acc.slice(from, to);
  }
}

async function* decode(
  source: AsyncIterable<Uint8Array>,
  v2: boolean,
): AsyncGenerator<PktLine, void, unknown> {
  const buf = new PktBuffer();
  for await (const chunk of source) {
    buf.accept(chunk);
    yield* drain(buf, v2);
  }
  if (buf.used > 0) {
    throw pktTruncated(buf.used);
  }
}

function* drain(buf: PktBuffer, v2: boolean): Generator<PktLine, void, unknown> {
  while (buf.used >= PKT_LENGTH_BYTES) {
    const length = parseLength(buf.acc);
    const decision = classify(length, buf.used, v2);
    if (decision.kind === 'wait') return;
    if (decision.kind === 'data') {
      const payload = buf.slice(PKT_LENGTH_BYTES, decision.consume);
      buf.drop(decision.consume);
      yield { kind: 'data', payload };
      continue;
    }
    buf.drop(decision.consume);
    yield { kind: decision.kind };
  }
}
