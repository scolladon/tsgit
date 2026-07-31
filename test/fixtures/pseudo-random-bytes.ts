/** A 32-bit integer hash with strong avalanche (triple32) — each byte comes from
 *  hashing its own index, not a chained generator, so consecutive bytes carry no
 *  exploitable correlation for deflate's matcher. */
const mix32 = (x: number): number => {
  let h = x >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
};

/** A deterministic byte stream over a near-full range (excluding NUL/LF/CR) — dense
 *  enough that deflate cannot find useful matches, so its compressed size stays close
 *  to its raw size instead of shrinking well below it. Excluding NUL also keeps the
 *  content text to every binary sniff, and excluding LF/CR keeps it one single line.
 *  `seed` names the stream: the same seed always yields the same bytes, so a failure
 *  reproduces exactly. */
export const pseudoRandomBytes = (length: number, seed: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const candidate = mix32((seed * 1_000_003 + i) >>> 0) & 0xff;
    bytes[i] = candidate === 0x00 || candidate === 0x0a || candidate === 0x0d ? 0x01 : candidate;
  }
  return bytes;
};
