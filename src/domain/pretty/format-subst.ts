import { type CharsetEncoders, encodeFromUtf8, isUtf8Label } from './reencode.js';

const DOLLAR = 0x24;
const NUL = 0;
const MARKER = new TextEncoder().encode('$Format:');

/** The accumulated output after one occurrence, with what the transcoding rule needs to know. */
export interface Expansion {
  readonly bytes: Uint8Array;
  readonly parsedHeader: boolean;
  readonly encoding: Uint8Array | undefined;
}

export type ExpandOne = (accumulated: Uint8Array, fmt: Uint8Array) => Expansion;

const concat = (head: Uint8Array, tail: Uint8Array): Uint8Array => {
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
};

const indexOfMarker = (blob: Uint8Array, from: number): number => {
  // Stryker disable next-line ArithmeticOperator: equivalent — positions past length - marker read undefined bytes, which match no marker byte
  const last = blob.length - MARKER.length;
  // Stryker disable next-line EqualityOperator: equivalent — a marker ending the blob has no `$` after it, so finding it or not both keep the tail verbatim
  for (let i = from; i <= last; i++) {
    if (MARKER.every((byte, offset) => blob[i + offset] === byte)) return i;
  }
  return -1;
};

const cutAtNul = (fmt: Uint8Array): Uint8Array => {
  const nul = fmt.indexOf(NUL);
  return nul === -1 ? fmt : fmt.subarray(0, nul);
};

const latin1 = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

/** git re-encodes the whole buffer so far, and leaves it as is when `iconv` fails. */
const settle = (
  { bytes, parsedHeader, encoding }: Expansion,
  encoders: CharsetEncoders,
): Uint8Array => {
  if (!parsedHeader || encoding === undefined) return bytes;
  const label = latin1(encoding);
  // Stryker disable next-line ConditionalExpression: equivalent — buildCharsetEncoder has no encoder for a UTF-8 label, so encodeFromUtf8 yields undefined and `?? bytes` returns the same buffer
  if (isUtf8Label(label)) return bytes;
  return encodeFromUtf8(label, bytes, encoders) ?? bytes;
};

/**
 * Expands every `$Format:<fmt>$` occurrence the way git's export-subst does: the terminator is
 * the first `$` after the marker (newlines included), the format is a C string cut at its first
 * NUL, and an unterminated tail is kept verbatim. After an occurrence that parsed the commit
 * header of a non-UTF-8 commit, the whole buffer so far is transcoded to that encoding.
 */
export const expandFormatSubst = (
  blob: Uint8Array,
  expandOne: ExpandOne,
  encoders: CharsetEncoders,
): Uint8Array => {
  let accumulated: Uint8Array = new Uint8Array(0);
  let cursor = 0;
  for (;;) {
    const marker = indexOfMarker(blob, cursor);
    const formatStart = marker + MARKER.length;
    const terminator = marker === -1 ? -1 : blob.indexOf(DOLLAR, formatStart);
    if (terminator === -1) return concat(accumulated, blob.subarray(cursor));
    accumulated = concat(accumulated, blob.subarray(cursor, marker));
    const fmt = cutAtNul(blob.subarray(formatStart, terminator));
    accumulated = settle(expandOne(accumulated, fmt), encoders);
    cursor = terminator + 1;
  }
};
