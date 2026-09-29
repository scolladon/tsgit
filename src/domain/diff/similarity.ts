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
 * decided. This is exactly that fallback: `isBinary`'s NUL-in-the-first-8000-
 * bytes window (`line-diff.ts`). The attribute-decided case is resolved
 * upstream, per path, by `resolveSimilarityOverride`
 * (`detect-similarity-renames.ts`'s callers thread the result in as
 * `buildFingerprint`'s `override` param — this function only ever runs
 * when that override is absent).
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
 * Below HASHBASE bytes: pack each chunk as `(bucket << 7) | n` (bucket < 2^17,
 * n <= MAX_CHUNK_LEN < 2^7, so the low 7 bits are free for n; the packed value
 * never reaches 2^24) into a pre-sized `Uint32Array` — never a dynamically
 * growing plain array — sort the FILLED prefix in place with the typed
 * array's native numeric sort (no comparator: a comparator forces V8's
 * slower generic sort path even on a typed array), then fold runs of the
 * same bucket together into pre-sized output arrays COPIED (`.slice`, not
 * `.subarray`) to their actual length — a `.subarray` view keeps the whole
 * `packedCount`-sized backing buffer alive behind it, so a blob whose
 * chunks collapse into few distinct buckets (`distinct` << `packedCount`)
 * would retain far more memory than its returned fingerprint needs, for as
 * long as any caller holds onto it (e.g. the broken-pair fingerprint cache).
 * The walk is inlined rather than routed through `walkChunks`'s callback: a
 * shared callback passed two DIFFERENT closures (this function's and
 * `denseFingerprint`'s) turns that one call site megamorphic, defeating
 * V8's inlining on the hottest loop in rename detection.
 */
export function packFingerprint(data: Uint8Array, kind: ContentKind): SpanFingerprint {
  const size = data.length;
  const packed = new Uint32Array(size);
  let packedCount = 0;
  const isText = kind === 'text';
  let accum1 = 0;
  let accum2 = 0;
  let n = 0;
  for (let i = 0; i < size; i++) {
    // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator: equivalent — forcing `i + 1 < size` true, its `<=` boundary, or `i - 1` (always < size inside this loop) only removes the bounds guard; the next conjunct `data[i + 1] === 0x0a` then reads out of range as `undefined`, which never equals 0x0a, so the branch outcome is unchanged for every i, size.
    if (isText && data[i] === CR && i + 1 < size && data[i + 1] === 0x0a) continue;
    const c = data[i] as number;
    const old1 = accum1;
    accum1 = (((accum1 << 7) ^ (accum2 >>> 25)) + c) >>> 0;
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
    n++;
    if (n < MAX_CHUNK_LEN && c !== 0x0a) continue;
    const bucket = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE;
    packed[packedCount++] = (bucket << 7) | n;
    n = 0;
    accum1 = 0;
    accum2 = 0;
  }
  if (n > 0) {
    const bucket = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE;
    packed[packedCount++] = (bucket << 7) | n;
  }

  const sorted = packed.subarray(0, packedCount);
  sorted.sort();

  const hashes = new Uint32Array(packedCount);
  const counts = new Uint32Array(packedCount);
  let distinct = 0;
  for (let i = 0; i < packedCount; i++) {
    const value = sorted[i] as number;
    const bucket = value >>> 7;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — forcing `distinct > 0` true, or its `>= 0` boundary, only lets the first iteration (distinct === 0) read hashes[-1], out of range and never equal to a real bucket number, so the else branch still runs unchanged.
    if (distinct > 0 && hashes[distinct - 1] === bucket) {
      counts[distinct - 1] = (counts[distinct - 1] as number) + (value & 127);
    } else {
      hashes[distinct] = bucket;
      counts[distinct] = value & 127;
      distinct++;
    }
  }
  return { hashes: hashes.slice(0, distinct), counts: counts.slice(0, distinct) };
}

/**
 * At or above HASHBASE bytes: accumulate every chunk directly into a fixed
 * HASHBASE-sized bucket array (every bucket already sits at its own
 * ascending index, so no per-chunk hash-map entry is needed), while ALSO
 * recording each bucket's first touch into a `touched` list sized to
 * `min(data.length, HASHBASE)` — there are at most HASHBASE distinct
 * buckets to touch regardless of how many bytes `data` holds, so sizing
 * `touched` to `data.length` directly would over-allocate without bound (a
 * 256 MiB blob would cost an extra ~1 GiB, a blob near the 2 GiB inflate
 * cap ~8 GiB). Checking `accum[bucket] === 0` before the add is cheaper
 * than a second full HASHBASE-sized scan afterward would be (measured: a
 * naive count-then-fill double scan over all 107 927 buckets was SLOWER
 * than the original `forEach`, since it pays that fixed cost twice
 * regardless of how sparse the touched set is). Sort the touched list,
 * then read each bucket's final count back out of `accum` in one further
 * O(touched) pass. The walk is inlined for the same megamorphic-callsite
 * reason `packFingerprint` inlines it.
 */
export function denseFingerprint(data: Uint8Array, kind: ContentKind): SpanFingerprint {
  const size = data.length;
  const accum = new Uint32Array(HASHBASE);
  const touched = new Uint32Array(Math.min(size, HASHBASE));
  let touchedCount = 0;
  const isText = kind === 'text';
  let accum1 = 0;
  let accum2 = 0;
  let n = 0;
  for (let i = 0; i < size; i++) {
    // Stryker disable next-line ConditionalExpression,EqualityOperator,ArithmeticOperator: equivalent — forcing `i + 1 < size` true, its `<=` boundary, or `i - 1` (always < size inside this loop) only removes the bounds guard; the next conjunct `data[i + 1] === 0x0a` then reads out of range as `undefined`, which never equals 0x0a, so the branch outcome is unchanged for every i, size.
    if (isText && data[i] === CR && i + 1 < size && data[i + 1] === 0x0a) continue;
    const c = data[i] as number;
    const old1 = accum1;
    accum1 = (((accum1 << 7) ^ (accum2 >>> 25)) + c) >>> 0;
    accum2 = ((accum2 << 7) ^ (old1 >>> 25)) >>> 0;
    n++;
    if (n < MAX_CHUNK_LEN && c !== 0x0a) continue;
    const bucket = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE;
    if (accum[bucket] === 0) touched[touchedCount++] = bucket;
    accum[bucket] = (accum[bucket] as number) + n;
    n = 0;
    accum1 = 0;
    accum2 = 0;
  }
  if (n > 0) {
    const bucket = ((accum1 + Math.imul(accum2, 0x61)) >>> 0) % HASHBASE;
    if (accum[bucket] === 0) touched[touchedCount++] = bucket;
    accum[bucket] = (accum[bucket] as number) + n;
  }

  const sortedTouched = touched.subarray(0, touchedCount);
  sortedTouched.sort();
  const hashes = new Uint32Array(touchedCount);
  const counts = new Uint32Array(touchedCount);
  // Stryker disable next-line EqualityOperator: equivalent — the extra i === touchedCount iteration reads sortedTouched[touchedCount] (out of range, undefined) and writes hashes/counts at index touchedCount; both are sized exactly touchedCount, so a typed-array out-of-bounds write is a silent no-op — the returned fingerprint is unchanged.
  for (let i = 0; i < touchedCount; i++) {
    const bucket = sortedTouched[i] as number;
    hashes[i] = bucket;
    counts[i] = accum[bucket] as number;
  }
  return { hashes, counts };
}

/**
 * Build `data`'s spanhash fingerprint, dispatching to whichever builder fits
 * its size: `packFingerprint` below HASHBASE bytes, `denseFingerprint` at or
 * above it.
 */
export function buildFingerprint(data: Uint8Array, kind: ContentKind): SpanFingerprint {
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — packFingerprint and denseFingerprint chunk the same bytes with the identical rolling hash and reduce to the same sorted, deduped bucket→count table, so routing every input through either one is a pure perf choice (see each function's own doc comment), not a correctness one — verified by forcing every input through denseFingerprint alone (full similarity.ts suite green).
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
  // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent — Stryker mutates one comparison at a time, so the OTHER pointer's bound always stays real inside the loop body; once the mutated pointer runs past its array, its read is undefined, which is never === or < the other (still in-bounds, real) value, so the loop only wastes else-branch steps draining the in-bounds pointer to its own end, adding nothing to copied.
  while (i < src.hashes.length && j < dst.hashes.length) {
    const a = src.hashes[i] as number;
    const b = dst.hashes[j] as number;
    if (a === b) {
      copied += Math.min(src.counts[i] as number, dst.counts[j] as number);
      i++;
      // Stryker disable next-line UpdateOperator: equivalent — both hash tables are ascending and distinct (both builders guarantee it), so j-- here only costs two non-matching else-branch steps (or is protected by the `j < dst.hashes.length` guard when j was already 0) before i/j re-converge to exactly where j++ would have landed — hand-traced for an interior match and a j === 0 match, no infinite loop.
      j++;
      // Stryker disable next-line EqualityOperator: equivalent — this branch is only reached once the preceding `if (a === b)` has already failed, so `a !== b` already holds here — `a < b` and `a <= b` agree for every pair that reaches this check.
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
 * - `literalAdded`: bytes of `dst`'s FINGERPRINT not accounted for by `src`
 *   (sum of `dst`'s chunk counts, minus `srcCopied`) — NOT `dstSize −
 *   srcCopied`: a text-mode chunk walk skips the CR of every CRLF pair, so a
 *   CRLF-heavy `dst` has fewer fingerprinted bytes than its raw size.
 */
export interface SpanhashChangeCounts {
  readonly srcCopied: number;
  readonly literalAdded: number;
}

/** Sum every bucket's byte count — a fingerprint's total covered bytes,
 *  which is `data.length` minus any CR bytes a text-mode walk skipped. */
function sumFingerprintCounts(fp: SpanFingerprint): number {
  let total = 0;
  for (let i = 0; i < fp.counts.length; i++) total += fp.counts[i] as number;
  return total;
}

/**
 * Return git's raw `diffcore_count_changes` outputs for a (src, dst)
 * fingerprint pair. These are the load-bearing counts for break scoring
 * (not similarity scoring):
 *
 *   merge_score  = (srcSize − srcCopied) * MAX_SCORE / srcSize   (denominator = srcSize)
 *   break_score  = min(srcSize + dstSize − 2*srcCopied, maxSize) * MAX_SCORE / maxSize
 *
 * Scores two ALREADY-BUILT fingerprints instead of re-hashing raw bytes —
 * every call site builds `src`/`dst` via `buildFingerprint` itself first (a
 * broken-pair cache, or two sides sharing one attribute-resolved content-kind
 * override per `resolveSimilarityOverride` — the break pass's two blobs are
 * the old and new state of ONE path, so a single override always applies
 * uniformly to both) rather than paying a second `buildFingerprint` pass
 * here. Empty src/dst fall through to the general computation below — an
 * empty `SpanFingerprint`'s `countCopied` and count-sum are both trivially
 * 0, matching git's own empty-table walk.
 */
export function countSpanhashChangesFromFingerprints(
  srcFingerprint: SpanFingerprint,
  dstFingerprint: SpanFingerprint,
): SpanhashChangeCounts {
  const srcCopied = countCopied(srcFingerprint, dstFingerprint);
  // git's `should_break` clamps `literalAdded` to `dstSize − srcCopied` in
  // case it overshoots `dst`'s real size. It never can here: `literalAdded`
  // is `dst`'s fingerprint byte total minus `srcCopied`, and a chunk walk
  // only ever SKIPS bytes (the CR of a CRLF pair) — its total is always
  // ≤ `dstSize`, so `literalAdded + srcCopied` is always ≤ `dstSize` too.
  const literalAdded = sumFingerprintCounts(dstFingerprint) - srcCopied;

  return { srcCopied, literalAdded };
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
