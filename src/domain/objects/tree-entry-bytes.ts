/**
 * Shared byte-level primitives for a tree entry. Kept deliberately small:
 * the octal-digit scan is the one piece of logic the tree parser and the raw
 * cursor must run identically, and the byte key is the one piece fsck's
 * duplicate and sort passes share. Deciding what a fault *means* — a throw, a
 * fsck finding — stays with each consumer, not here.
 */
const OCTAL_ZERO = 0x30;
const OCTAL_SEVEN = 0x37;
const KEY_CHUNK_SIZE = 1024;

/** True when `buf[start, end)` contains a byte outside the octal-digit range. */
export function hasNonOctalByte(buf: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const byte = buf[i]!;
    if (byte < OCTAL_ZERO || byte > OCTAL_SEVEN) return true;
  }
  return false;
}

/**
 * Lossless byte-to-string key for fsck's duplicate set and its name
 * comparisons. One code unit per byte, accumulated in bounded chunks — never
 * a spread over a whole 4096-byte name, which would overflow the argument
 * list. A text decoder is deliberately not used here: every single-byte
 * decoder either loses information (mapping distinct bytes to the same code
 * point) or is not reversible to the original byte, which would make a later
 * use of the key as a name silently wrong.
 */
export function entryNameKey(buf: Uint8Array, start: number, end: number): string {
  let key = '';
  for (let chunkStart = start; chunkStart < end; chunkStart += KEY_CHUNK_SIZE) {
    const chunkEnd = Math.min(chunkStart + KEY_CHUNK_SIZE, end);
    key += String.fromCharCode(...buf.subarray(chunkStart, chunkEnd));
  }
  return key;
}
