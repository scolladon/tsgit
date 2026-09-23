/**
 * Pure-JS adler32 checksum — algorithm defined in RFC 1950.
 *
 * A zlib member's compressed payload is followed by a big-endian uint32
 * adler32 of the uncompressed data. `inflateZlibMember` recomputes it over
 * the fully decoded output and rejects the member on mismatch, catching
 * corruption that DEFLATE's own block structure wouldn't (bytes that still
 * parse as valid blocks but decode to the wrong data).
 */

const ADLER_MOD = 65521;

/**
 * Largest run of bytes `a`/`b` can accumulate (worst case: every byte 0xff)
 * before `b` risks overflowing the 32-bit range the final `(b << 16) | a`
 * combination assumes, so the modulo can be deferred to once per block
 * instead of once per byte. Matches zlib's own adler32.c bound.
 */
const NMAX = 5552;

export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let start = 0; start < data.length; start += NMAX) {
    const end = Math.min(start + NMAX, data.length);
    for (let i = start; i < end; i += 1) {
      a += data[i] as number;
      b += a;
    }
    a %= ADLER_MOD;
    b %= ADLER_MOD;
  }
  return ((b << 16) | a) >>> 0;
}
