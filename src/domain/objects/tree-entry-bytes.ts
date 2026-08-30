/**
 * Shared byte-level classifier for a tree entry's mode span. Kept
 * deliberately small: the octal-digit scan is the one piece of logic the
 * tree parser and the raw cursor must run identically, so both report the
 * same fault for the same bytes. Deciding what a fault *means* — a throw, a
 * fsck finding — stays with each consumer, not here.
 */
const OCTAL_ZERO = 0x30;
const OCTAL_SEVEN = 0x37;

/** True when `buf[start, end)` contains a byte outside the octal-digit range. */
export function hasNonOctalByte(buf: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const byte = buf[i]!;
    if (byte < OCTAL_ZERO || byte > OCTAL_SEVEN) return true;
  }
  return false;
}
