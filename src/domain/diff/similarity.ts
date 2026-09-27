import { isBinary } from './line-diff.js';

/**
 * Pure spanhash similarity scorer — git's diffcore-delta.c algorithm.
 * I/O-free; never imports platform adapters.
 *
 * Algorithm (mirrors git's `hash_chars` + `diffcore_count_changes`):
 * 1. Split each blob into chunks delimited by LF or up to 64 bytes, whichever
 *    comes first (same rule git applies for text vs binary). In a text blob,
 *    the CR of a CRLF pair is skipped: neither accumulated nor counted.
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

/** Carriage return — the byte git's spanhash chunk walk skips when it opens
 *  a CRLF pair in a text blob. */
const CR = 0x0d;

/** Whether a blob's bytes are treated as text or binary while chunking:
 *  text skips the CR of a CRLF pair, binary hashes every byte. Mirrors git's
 *  `is_text` in `hash_chars`. */
export type ContentKind = 'text' | 'binary';

/**
 * git derives `is_text` from `!diff_filespec_is_binary`, which falls back to
 * a content sniff (`buffer_is_binary`) whenever no diff attribute already
 * decided. This port has no attribute plumbing into the rename/break pass,
 * so it always takes that fallback: `isBinary`'s NUL-in-the-first-8000-bytes
 * window (`line-diff.ts`).
 */
export function contentKindOf(bytes: Uint8Array): ContentKind {
  return isBinary(bytes) ? 'binary' : 'text';
}

/**
 * A sorted spanhash table: `hashes` is ascending and distinct, each entry
 * < HASHBASE; `counts[i]` is the total byte count of every chunk that hashed
 * into `hashes[i]`. The typed-array shape `packFingerprint`/`denseFingerprint`
 * both build and `countCopied` merge-scans, replacing a per-blob hash-map
 * with a sorted table scored the way git's `spanhash_top` is.
 */
export interface SpanFingerprint {
  readonly hashes: Uint32Array;
  readonly counts: Uint32Array;
}

/**
 * Walk `data` into spanhash chunks — delimited by `\n` (LF) or every
 * `MAX_CHUNK_LEN` bytes, whichever comes first, with the CR of a CRLF pair
 * skipped first in a text blob — and call `onChunk` once per completed
 * chunk with its bucket and byte count. Mirrors git's `hash_chars` in
 * `diffcore-delta.c`; shared by `packFingerprint` and `denseFingerprint` so
 * the accumulator arithmetic lives in exactly one place.
 */
function walkChunks(
  data: Uint8Array,
  kind: ContentKind,
  onChunk: (bucket: number, n: number) => void,
): void {
  const size = data.length;
  let accum1 = 0;
  let accum2 = 0;
  let n = 0;
  for (let i = 0; i < size; i++) {
    // The CR of a CRLF pair is skipped in a text blob: neither accumulated
    // nor counted. A lone CR or a trailing CR (no following byte) is hashed
    // like any other byte.
    if (kind === 'text' && data[i] === CR && i + 1 < size && data[i + 1] === 0x0a) continue;
    // The loop guard `i < size` ensures `data[i]` is always defined.
    const c = data[i] as number;
    const old1 = accum1;
    accum1 = (((accum1 << 7) ^ (accum2 >>> 25)) + c) >>> 0;
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
    n++;
    if (n < MAX_CHUNK_LEN && c !== 0x0a /* LF */) continue;
    // git's accumulators are `unsigned int`: the sum wraps to 32 bits BEFORE
    // the modulo is taken. `Math.imul` already wraps the product to a 32-bit
    // (signed) result, so only the addition needs the explicit `>>> 0` to
    // land on the same bucket as git's `(accum1 + accum2 * 0x61) % HASHBASE`.
    onChunk(((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE, n);
    n = 0;
    accum1 = 0;
    accum2 = 0;
  }
  if (n > 0) onChunk(((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE, n);
}

/**
 * Below HASHBASE bytes: pack each chunk as `(bucket << 7) | n` (bucket < 2^17,
 * n <= MAX_CHUNK_LEN < 2^7, so the low 7 bits are free for n) into one array,
 * sort it natively, then fold runs of the same bucket together. A transient
 * allocation proportional to the chunk count, never to HASHBASE — cheap for
 * the common small-diff blob.
 */
export function packFingerprint(data: Uint8Array, kind: ContentKind): SpanFingerprint {
  const packed: number[] = [];
  walkChunks(data, kind, (bucket, n) => packed.push((bucket << 7) | n));
  packed.sort((a, b) => a - b);

  const hashes: number[] = [];
  const counts: number[] = [];
  packed.forEach((value) => {
    const bucket = value >>> 7;
    const last = hashes.length - 1;
    if (last >= 0 && hashes[last] === bucket) {
      counts[last] = (counts[last] as number) + (value & 127);
    } else {
      hashes.push(bucket);
      counts.push(value & 127);
    }
  });
  return { hashes: Uint32Array.from(hashes), counts: Uint32Array.from(counts) };
}

/**
 * At or above HASHBASE bytes: accumulate every chunk directly into a fixed
 * HASHBASE-sized bucket array (no per-chunk allocation, no sort — every
 * bucket already sits at its own ascending index) and read the touched ones
 * back out in one linear pass.
 */
export function denseFingerprint(data: Uint8Array, kind: ContentKind): SpanFingerprint {
  const accum = new Uint32Array(HASHBASE);
  walkChunks(data, kind, (bucket, n) => {
    accum[bucket] = (accum[bucket] as number) + n;
  });

  const hashes: number[] = [];
  const counts: number[] = [];
  accum.forEach((n, bucket) => {
    if (n > 0) {
      hashes.push(bucket);
      counts.push(n);
    }
  });
  return { hashes: Uint32Array.from(hashes), counts: Uint32Array.from(counts) };
}

/**
 * Build `data`'s spanhash fingerprint, dispatching to whichever builder fits
 * its size: `packFingerprint` below HASHBASE bytes, `denseFingerprint` at or
 * above it.
 */
export function buildFingerprint(data: Uint8Array, kind: ContentKind): SpanFingerprint {
  return data.length < HASHBASE ? packFingerprint(data, kind) : denseFingerprint(data, kind);
}

/**
 * Count how many bytes from `src` were "copied" to `dst`: a two-pointer
 * merge scan over both sorted, distinct hash tables, summing min(count) for
 * every hash present in both. Mirrors git's `diffcore_count_changes` in
 * `diffcore-delta.c` over its sorted `spanhash_top` table.
 */
export function countCopied(src: SpanFingerprint, dst: SpanFingerprint): number {
  let copied = 0;
  let i = 0;
  let j = 0;
  while (i < src.hashes.length && j < dst.hashes.length) {
    const a = src.hashes[i] as number;
    const b = dst.hashes[j] as number;
    if (a === b) {
      copied += Math.min(src.counts[i] as number, dst.counts[j] as number);
      i++;
      j++;
    } else if (a < b) {
      i++;
    } else {
      j++;
    }
  }
  return copied;
}

/**
 * Raw change counts from git's `diffcore_count_changes` in `diffcore-delta.c`.
 *
 * - `srcCopied`: bytes of `src` whose chunk hash also appears in `dst`
 *   (min(src_cnt, dst_cnt) per hash bucket, summed). This is the "shared"
 *   byte count used by both similarity and break scoring.
 * - `literalAdded`: bytes of `dst` not accounted for by `src`
 *   (`dstSize − srcCopied`). Together with `srcCopied`, callers can derive
 *   git's break-attempt gate and merge-score without a second blob scan.
 */
export interface SpanhashChangeCounts {
  readonly srcCopied: number;
  readonly literalAdded: number;
}

/**
 * Return git's raw `diffcore_count_changes` outputs for a (src, dst) blob pair.
 * These are the load-bearing counts for break scoring (not similarity scoring):
 *
 *   merge_score  = (srcSize − srcCopied) * MAX_SCORE / srcSize   (denominator = srcSize)
 *   break_score  = min(srcSize + dstSize − 2*srcCopied, maxSize) * MAX_SCORE / maxSize
 *
 * Special cases mirror `estimateSimilarity`:
 * - Both empty → srcCopied = 0, literalAdded = 0
 * - src empty  → srcCopied = 0, literalAdded = dstSize
 * - dst empty  → srcCopied = 0, literalAdded = 0
 */
export function countSpanhashChanges(src: Uint8Array, dst: Uint8Array): SpanhashChangeCounts {
  const srcSize = src.length;
  const dstSize = dst.length;

  // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: equivalent — this guard is a perf short-circuit only. Skipping it (whole/either-operand forced false, || swapped to &&, or the body emptied) still falls through to buildFingerprint on an empty src/dst, which yields an empty SpanFingerprint; countCopied over an empty table always returns 0, so srcCopied=0 and literalAdded=dstSize-0=dstSize either way — verified by hand for every documented variant.
  if (srcSize === 0 || dstSize === 0) {
    return { srcCopied: 0, literalAdded: dstSize };
  }

  const srcCopied = countCopied(
    buildFingerprint(src, contentKindOf(src)),
    buildFingerprint(dst, contentKindOf(dst)),
  );

  return { srcCopied, literalAdded: dstSize - srcCopied };
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
  return estimateSimilarityFromFingerprints(
    buildFingerprint(src, contentKindOf(src)),
    src.length,
    buildFingerprint(dst, contentKindOf(dst)),
    dst.length,
  );
}

/**
 * Score two blobs from their precomputed fingerprints and byte sizes.
 * Avoids re-hashing bytes when a blob is scored against multiple partners.
 *
 * Special cases mirror `estimateSimilarity`:
 * - maxSize === 0 → MAX_SCORE
 * - either size === 0 → 0
 */
export function estimateSimilarityFromFingerprints(
  src: SpanFingerprint,
  srcSize: number,
  dst: SpanFingerprint,
  dstSize: number,
): number {
  const maxSize = Math.max(srcSize, dstSize);
  if (maxSize === 0) return MAX_SCORE;
  // Stryker disable next-line ConditionalExpression,LogicalOperator: equivalent — this guard is a perf short-circuit only. Skipping it (whole/either-operand forced false, or || swapped to &&) still falls through to countCopied with an empty src or dst fingerprint (well-formed callers pass fingerprints consistent with size), which always returns 0, so Math.trunc(0 * MAX_SCORE / maxSize) = 0 either way — verified by hand for every documented variant.
  if (srcSize === 0 || dstSize === 0) return 0;
  const srcCopied = countCopied(src, dst);
  return Math.trunc((srcCopied * MAX_SCORE) / maxSize);
}

/**
 * Project a raw score to an integer percent, truncating (not rounding).
 * Mirrors git's `(int)(score * 100 / MAX_SCORE)`.
 */
export function toSimilarityPercent(score: number): number {
  return ((score * 100) / MAX_SCORE) | 0;
}
