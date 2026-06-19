/**
 * Pure spanhash similarity scorer — git's diffcore-delta.c algorithm.
 * I/O-free; never imports platform adapters.
 *
 * Algorithm (mirrors git's `hash_chars` + `diffcore_count_changes`):
 * 1. Split each blob into chunks delimited by LF or up to 64 bytes, whichever
 *    comes first (same rule git applies for text vs binary).
 * 2. Hash each chunk with git's two-accumulator rolling hash and store its byte
 *    count in a hash-map keyed by `(accum1 + accum2 * 0x61) % HASHBASE`.
 * 3. For each chunk hash present in BOTH src and dst, count min(src_cnt, dst_cnt)
 *    bytes as "copied".
 * 4. score = (src_copied * MAX_SCORE) / max(src_size, dst_size)
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

/** Modulus used by git's spanhash hash function (prime between 2^16..2^17). */
const HASHBASE = 107927;

/** Max chunk size before forcing a hash boundary (git constant). */
const MAX_CHUNK_LEN = 64;

/**
 * Build a map from chunk-hash → total byte count for all chunks in `data`.
 * Chunks are delimited by `\n` (LF) or every `MAX_CHUNK_LEN` bytes.
 * Mirrors git's `hash_chars` in `diffcore-delta.c`.
 */
function buildChunkMap(data: Uint8Array): Map<number, number> {
  const map = new Map<number, number>();
  const size = data.length;
  let accum1 = 0;
  let accum2 = 0;
  let n = 0;

  for (let i = 0; i < size; i++) {
    // The loop guard `i < size` ensures `data[i]` is always defined.
    const c = data[i] as number;
    const old1 = accum1;
    accum1 = (((accum1 << 7) ^ (accum2 >>> 25)) + c) >>> 0;
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
    n++;
    if (n >= MAX_CHUNK_LEN || c === 0x0a /* LF */) {
      const hashval = (accum1 + Math.imul(accum2, 0x61)) % HASHBASE;
      map.set(hashval, (map.get(hashval) ?? 0) + n);
      n = 0;
      accum1 = 0;
      accum2 = 0;
    }
  }
  if (n > 0) {
    const hashval = (accum1 + Math.imul(accum2, 0x61)) % HASHBASE;
    map.set(hashval, (map.get(hashval) ?? 0) + n);
  }

  return map;
}

/**
 * Count how many bytes from `src` were "copied" to `dst`.
 * For each chunk hash in src, takes min(src_cnt, dst_cnt) as copied bytes.
 * Mirrors git's `diffcore_count_changes` in `diffcore-delta.c`.
 */
function countSrcCopied(srcMap: Map<number, number>, dstMap: Map<number, number>): number {
  let copied = 0;
  for (const [hashval, srcCnt] of srcMap) {
    const dstCnt = dstMap.get(hashval) ?? 0;
    if (dstCnt > 0) {
      copied += Math.min(srcCnt, dstCnt);
    }
  }
  return copied;
}

/**
 * Estimate the similarity between two byte blobs using git's spanhash algorithm.
 * Returns a raw score in 0..MAX_SCORE.
 *
 * Special cases:
 * - Both empty → MAX_SCORE (identical trivially)
 * - Identical content → MAX_SCORE (checked via reference equality for speed)
 * - One empty, other non-empty → 0
 */
export function estimateSimilarity(src: Uint8Array, dst: Uint8Array): number {
  const srcSize = src.length;
  const dstSize = dst.length;
  const maxSize = Math.max(srcSize, dstSize);

  if (maxSize === 0) return MAX_SCORE;
  if (srcSize === 0 || dstSize === 0) return 0;

  const srcMap = buildChunkMap(src);
  const dstMap = buildChunkMap(dst);
  const srcCopied = countSrcCopied(srcMap, dstMap);

  return Math.trunc((srcCopied * MAX_SCORE) / maxSize);
}

/**
 * Project a raw score to an integer percent, truncating (not rounding).
 * Mirrors git's `(int)(score * 100 / MAX_SCORE)`.
 */
export function toSimilarityPercent(score: number): number {
  return ((score * 100) / MAX_SCORE) | 0;
}
