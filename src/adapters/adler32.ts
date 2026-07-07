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

export function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % ADLER_MOD;
    b = (b + a) % ADLER_MOD;
  }
  return ((b << 16) | a) >>> 0;
}
