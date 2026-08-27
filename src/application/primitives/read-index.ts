import { invalidIndexHeader } from '../../domain/git-index/error.js';
import { type GitIndex, parseIndex } from '../../domain/git-index/index.js';
import { bytesToHex } from '../../domain/objects/encoding.js';
import type { Context } from '../../ports/context.js';
import type { FileStat } from '../../ports/file-system.js';
import { indexPath } from './path-layout.js';
import {
  exceedsMaxIndexBytes,
  REASON_INDEX_CHECKSUM_MISMATCH,
  REASON_INDEX_EXCEEDS_MAX,
} from './validators.js';

const NS_PER_SECOND = 1_000_000_000n;

const indexMtimeFrom = (stat: FileStat): { seconds: number; nanoseconds: number } => ({
  seconds: Math.floor(stat.mtimeMs / 1000),
  nanoseconds: stat.mtimeNs === undefined ? 0 : Number(stat.mtimeNs % NS_PER_SECOND),
});

/**
 * The cache validity key: every field that would move if a writer (this
 * process or an external one) replaced `.git/index`. `mtimeNs` AND `ino` are
 * both required, not just `mtimeMs` — a second-resolution filesystem cannot
 * otherwise distinguish two writes landing in the same clock tick.
 */
interface IndexCacheKey {
  readonly size: number;
  readonly mtimeMs: number;
  readonly mtimeNs: bigint | undefined;
  readonly ino: number;
}

interface IndexCacheEntry {
  readonly key: IndexCacheKey;
  readonly index: Promise<GitIndex>;
}

// Keyed on `ctx.session` — not `ctx` itself — so a Context derived from the
// same repository-open shares this cache instead of missing on every
// spread-derivation, mirroring `config-read.ts`. Safe to share PURELY by
// session despite `.git/index` being per-worktree (`indexPath` reads
// `ctx.layout.gitDir`, which differs across worktrees): the entry's own
// `(size, mtimeMs, mtimeNs, ino)` key self-validates on every read, so a
// worktree switch (different file, different inode) is a correctly-detected
// cache MISS, never a wrong-file hit — at worst, interleaved worktree reads
// evict each other's entry, a perf cost, never a correctness one. Cache
// reference is mutable so test code can swap in a fresh WeakMap and
// guarantee isolation between cases that re-use the same session — mirrors
// `config-read.ts`'s own reset story.
const cache: WeakMap<Context['session'], IndexCacheEntry> = new WeakMap();

const keyFrom = (stat: FileStat): IndexCacheKey => ({
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  mtimeNs: stat.mtimeNs,
  ino: stat.ino,
});

const sameKey = (a: IndexCacheKey, b: IndexCacheKey): boolean =>
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.mtimeNs === b.mtimeNs && a.ino === b.ino;

/**
 * A stat match is racy — and cannot be trusted on its own — when either
 * snapshot lacks nanosecond precision (undefined `mtimeNs`): two writes
 * inside the same millisecond then produce identical stat tuples. The
 * snapshot-resolver cache one layer up (`caching-index-resolver.ts`) faces
 * the identical problem and resolves it the same way, below.
 */
const isRacyMatch = (a: IndexCacheKey, b: IndexCacheKey): boolean =>
  a.mtimeNs === undefined || b.mtimeNs === undefined;

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

/**
 * Trailer fallback for a racy stat match: the trailer bytes are the only
 * discriminant left against a same-tick external rewrite that happens to
 * reuse the exact stat tuple. One `readSlice` of the digest length —
 * negligible next to a full re-parse.
 */
const trailerStillMatches = async (
  ctx: Context,
  path: string,
  stat: FileStat,
  cachedIndex: Promise<GitIndex>,
): Promise<boolean> => {
  const cached = await cachedIndex;
  const trailerSize = cached.trailerSha.length;
  if (trailerSize === 0 || stat.size < trailerSize) return false;
  const trailer = await ctx.fs.readSlice(path, stat.size - trailerSize, trailerSize);
  return bytesEqual(trailer, cached.trailerSha);
};

/**
 * Read, verify and parse `.git/index` off disk — the full cost `readIndex`
 * pays on a cache miss. Unchanged from before caching existed: integrity
 * (trailer checksum) is verified BEFORE `parseIndex` runs, so a malformed
 * payload can never leak parser state through an error message.
 */
const loadIndex = async (ctx: Context, path: string, stat: FileStat): Promise<GitIndex> => {
  const bytes = await ctx.fs.read(path);
  // Post-check against the actual read size — defeats TOCTOU where a concurrent
  // writer grows the file between stat and read.
  if (exceedsMaxIndexBytes(bytes.length)) {
    throw invalidIndexHeader(REASON_INDEX_EXCEEDS_MAX);
  }

  // Integrity-first: validate trailing checksum BEFORE parsing the structure,
  // so malformed payloads cannot leak parser state through error messages.
  // Trailer size follows the active hash algorithm (SHA-1 = 20, SHA-256 = 32).
  const trailerSize = ctx.hashConfig.digestLength;
  // A file too short to carry the trailer is not a valid index. Reject early —
  // don't silently hand unvalidated bytes to parseIndex.
  if (bytes.length < trailerSize) {
    throw invalidIndexHeader('file is shorter than the hash trailer');
  }
  const payload = bytes.subarray(0, bytes.length - trailerSize);
  const trailerBytes = bytes.subarray(bytes.length - trailerSize);
  const trailer = bytesToHex(trailerBytes);
  const computed = await ctx.hash.hashHex(payload);
  if (computed !== trailer) {
    throw invalidIndexHeader(REASON_INDEX_CHECKSUM_MISMATCH);
  }

  return {
    ...parseIndex(bytes, ctx.hashConfig.digestLength),
    indexMtime: indexMtimeFrom(stat),
  };
};

/**
 * Read `.git/index`, memoised per session and keyed on the file's own
 * `(size, mtimeMs, mtimeNs, ino)` — following `config-read.ts`'s precedent. A
 * second call whose stat matches the cached key joins the cached parse
 * instead of re-reading, re-verifying and re-parsing the whole file.
 *
 * Three independent guards keep this correct: the stat-key comparison
 * catches a change to the on-disk file (this process or an external one);
 * the trailer fallback catches a same-tick external rewrite that a
 * nanosecond-blind stat tuple cannot distinguish from no change at all; and
 * `invalidateIndexCache` — called from the index-lock commit path — drops
 * the entry unconditionally the moment THIS process writes a new index, so
 * neither of the read-side checks needs to run at all for our own commits.
 */
export async function readIndex(ctx: Context): Promise<GitIndex> {
  const path = indexPath(ctx.layout.gitDir);
  if (!(await ctx.fs.exists(path))) {
    return { version: 2, entries: [], extensions: [], trailerSha: new Uint8Array(0) };
  }
  // Pre-check against stat to reject oversized files before allocating.
  const stat = await ctx.fs.stat(path);
  if (exceedsMaxIndexBytes(stat.size)) {
    throw invalidIndexHeader(REASON_INDEX_EXCEEDS_MAX);
  }
  const key = keyFrom(stat);
  const cached = cache.get(ctx.session);
  if (cached !== undefined && sameKey(cached.key, key)) {
    const trusted =
      !isRacyMatch(cached.key, key) || (await trailerStillMatches(ctx, path, stat, cached.index));
    if (trusted) return cached.index;
  }
  const index = loadIndex(ctx, path, stat);
  cache.set(ctx.session, { key, index });
  return index;
}

/**
 * Drop the cached `readIndex` entry for the session — called from the
 * index-lock commit path (`internal/index-lock.ts`) immediately after a
 * successful write, so the next `readIndex` on this session always sees the
 * commit regardless of stat granularity.
 */
export const invalidateIndexCache = (ctx: Context): void => {
  cache.delete(ctx.session);
};
