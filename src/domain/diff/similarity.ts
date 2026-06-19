/**
 * Pure spanhash similarity scorer — git's diffcore-delta.c algorithm.
 * I/O-free; never imports platform adapters.
 */

/** Raw score ceiling; mirrors git's MAX_SCORE = 60000. */
export const MAX_SCORE = 60000;

/** Default rename threshold (50% of MAX_SCORE). */
export const DEFAULT_RENAME_THRESHOLD = 30000;

/** Default -B break-attempt gate (50% of MAX_SCORE). */
export const DEFAULT_BREAK_SCORE = 30000;

/** Default -B keep-broken gate (60% of MAX_SCORE). */
export const DEFAULT_MERGE_SCORE = 36000;

/**
 * Structured similarity datum shared by RenameChange, CopyChange, and the
 * broken field on ModifyChange. score is in 0..MAX_SCORE; maxScore is always
 * MAX_SCORE so callers can reconstruct the denominator.
 */
export interface SimilarityScore {
  readonly score: number;
  readonly maxScore: number;
}

/**
 * Compute the 4-byte multiplicative hash used to build the spanhash table.
 * Matches git's hash function for 4-byte windows.
 */
function hash4(data: Uint8Array, offset: number): number {
  let h = 0;
  for (let i = 0; i < 4; i++) {
    h = (Math.imul(h, 0x4b9ace4d) + ((data[offset + i] ?? 0) & 0xff)) >>> 0;
  }
  return h;
}

/**
 * Compute the smallest power of 2 >= min, with a floor of 256.
 */
function nextPow2(min: number): number {
  let size = 256;
  while (size < min) size <<= 1;
  return size;
}

/**
 * Count how many dst bytes are covered by spans that appear in src,
 * using git's spanhash greedy forward-extension strategy.
 *
 * For each 4-byte window in dst, look up its hash in the table built from src.
 * On a match (same hash AND same 4 bytes), extend the span forward as long as
 * bytes agree, accumulating the matched byte count.
 */
function countSrcCopied(src: Uint8Array, dst: Uint8Array): number {
  const srcSize = src.length;
  const dstSize = dst.length;
  const mask = nextPow2(srcSize >> 2) - 1;

  // Build table: hash slot → (srcOffset, 4 key bytes).
  // Later positions overwrite earlier ones on collision (git's behaviour).
  const table = new Array<readonly [number, number, number, number, number] | undefined>(
    mask + 1,
  ).fill(undefined);

  for (let i = 0; i <= srcSize - 4; i++) {
    const h = hash4(src, i) & mask;
    table[h] = [i, src[i] ?? 0, src[i + 1] ?? 0, src[i + 2] ?? 0, src[i + 3] ?? 0];
  }

  let srcCopied = 0;
  let j = 0;

  while (j <= dstSize - 4) {
    const h = hash4(dst, j) & mask;
    const entry = table[h];

    if (
      entry !== undefined &&
      entry[1] === dst[j] &&
      entry[2] === dst[j + 1] &&
      entry[3] === dst[j + 2] &&
      entry[4] === dst[j + 3]
    ) {
      const matchStart = j;
      let si = entry[0] + 4;
      let dj = j + 4;
      while (si < srcSize && dj < dstSize && src[si] === dst[dj]) {
        si++;
        dj++;
      }
      srcCopied += dj - matchStart;
      j = dj;
    } else {
      j++;
    }
  }

  return srcCopied;
}

/**
 * Estimate the similarity between two byte blobs using git's spanhash algorithm.
 * Returns a raw score in 0..MAX_SCORE.
 *
 * Special cases:
 * - Both empty → MAX_SCORE (identical trivially)
 * - Identical content → MAX_SCORE
 * - One empty, other non-empty → 0
 * - Either blob shorter than 4 bytes (and not identical) → 0
 */
export function estimateSimilarity(src: Uint8Array, dst: Uint8Array): number {
  const srcSize = src.length;
  const dstSize = dst.length;
  const maxSize = Math.max(srcSize, dstSize);

  if (maxSize === 0) return MAX_SCORE;
  if (src === dst) return MAX_SCORE;
  if (srcSize === dstSize) {
    let identical = true;
    for (let i = 0; i < srcSize; i++) {
      if (src[i] !== dst[i]) {
        identical = false;
        break;
      }
    }
    if (identical) return MAX_SCORE;
  }

  if (srcSize < 4 || dstSize < 4) return 0;

  return Math.floor((countSrcCopied(src, dst) * MAX_SCORE) / maxSize);
}

/**
 * Project a raw score to an integer percent, truncating (not rounding).
 * Mirrors git's `(int)(score * 100 / MAX_SCORE)`.
 */
export function toSimilarityPercent(score: number): number {
  return ((score * 100) / MAX_SCORE) | 0;
}
