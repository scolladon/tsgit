const DOLLAR = 0x24;
const NUL = 0;
const MARKER = new TextEncoder().encode('$Format:');

export type ExpandOne = (accumulated: Uint8Array, fmt: Uint8Array) => Uint8Array;

const concat = (head: Uint8Array, tail: Uint8Array): Uint8Array => {
  const out = new Uint8Array(head.length + tail.length);
  out.set(head, 0);
  out.set(tail, head.length);
  return out;
};

const indexOfMarker = (blob: Uint8Array, from: number): number => {
  const last = blob.length - MARKER.length;
  for (let i = from; i <= last; i++) {
    if (MARKER.every((byte, offset) => blob[i + offset] === byte)) return i;
  }
  return -1;
};

const cutAtNul = (fmt: Uint8Array): Uint8Array => {
  const nul = fmt.indexOf(NUL);
  return nul === -1 ? fmt : fmt.subarray(0, nul);
};

/**
 * Expands every `$Format:<fmt>$` occurrence the way git's export-subst does: the terminator is
 * the first `$` after the marker (newlines included), the format is a C string cut at its first
 * NUL, and an unterminated tail is kept verbatim.
 */
export const expandFormatSubst = (blob: Uint8Array, expandOne: ExpandOne): Uint8Array => {
  let accumulated: Uint8Array = new Uint8Array(0);
  let cursor = 0;
  for (;;) {
    const marker = indexOfMarker(blob, cursor);
    const formatStart = marker + MARKER.length;
    const terminator = marker === -1 ? -1 : blob.indexOf(DOLLAR, formatStart);
    if (terminator === -1) return concat(accumulated, blob.subarray(cursor));
    accumulated = concat(accumulated, blob.subarray(cursor, marker));
    accumulated = expandOne(accumulated, cutAtNul(blob.subarray(formatStart, terminator)));
    cursor = terminator + 1;
  }
};
