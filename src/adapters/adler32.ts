/**
 * Pure-JS adler32 checksum — algorithm defined in RFC 1950.
 *
 * Used to validate the true end of a zlib stream: the 4 bytes that trail the
 * compressed payload are a big-endian uint32 adler32 of the uncompressed data.
 * Checking this lets the progressive-prefix `streamInflate` scan accept a
 * boundary only when the runtime's DecompressionStream consumed the complete
 * stream (including the checksum), not an early truncated prefix that some
 * runtimes (Deno, Workers) accept prematurely.
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
