import { indexPath as resolveIndexPath } from '../../application/primitives/path-layout.js';
import { TsgitError } from '../../domain/error.js';
import type { GitIndex } from '../../domain/git-index/index-entry.js';
import type { FileStat, FileSystem } from '../../ports/file-system.js';
import type { GenerationView } from '../../ports/generation-view.js';
import type { IndexResolver } from '../../ports/snapshot-resolvers.js';
import type { Disposable, WriteEventStream } from '../../ports/write-event-stream.js';

interface CacheEntry {
  readonly parsed: GitIndex;
  readonly observed: FileStat;
  cachedGen: number;
}

const statMatches = (current: FileStat, observed: FileStat): boolean => {
  if (current.size !== observed.size) return false;
  if (current.ino !== observed.ino) return false;
  if (current.mtimeMs !== observed.mtimeMs) return false;
  if (current.mtimeNs !== undefined && observed.mtimeNs !== undefined) {
    return current.mtimeNs === observed.mtimeNs;
  }
  return true;
};

/**
 * Returns true when the stat comparison is potentially racy and the SHA
 * trailer must be inspected to confirm the cached parse is still valid.
 *
 * A stat tuple is racy when nanosecond-resolution mtime is unavailable on
 * either snapshot — without that precision, two writes within the same
 * millisecond produce indistinguishable stat tuples, so the trailer hash
 * is the only remaining discriminator. See ADR-150.
 */
const needsRacyCheck = (current: FileStat, observed: FileStat): boolean =>
  current.mtimeNs === undefined || observed.mtimeNs === undefined;

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  // equivalent-mutant: the length-mismatch shortcut is observably equivalent
  // to the elementwise comparison in this codebase — trailerSha is always
  // 20 bytes (SHA-1) or 32 (SHA-256) and the size guard in
  // `trailerStillMatches` ensures the live read has the same length. The
  // guard is kept for defence-in-depth on unknown callers.
  if (a.length !== b.length) return false;
  // equivalent-mutant: `i <= a.length` is observably equivalent because
  // `a[a.length]` is `undefined` and `undefined !== undefined` is `false`,
  // so the off-by-one iteration is a no-op and the result is unchanged.
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
};

const readTrailer = async (
  fs: FileSystem,
  path: string,
  size: number,
  fileSize: number,
): Promise<Uint8Array> => fs.readSlice(path, fileSize - size, size);

/**
 * Three-tier caching `IndexResolver` (design §10.4, ADR-150). On each
 * `resolve()`:
 *
 *   1. **Generation fast path** — if `cachedGen === view.current('index')`
 *      and `bypassCache` is not set, return the cached parse with zero
 *      syscalls. Catches our own writes.
 *   2. **Stat-validated path** — `fs.stat` the index; if all watched fields
 *      match the cached observation and the comparison is non-racy, refresh
 *      `cachedGen` and return the cached parse. Catches external writes.
 *   3. **SHA-trailer fallback** — when the stat is racy (ns precision
 *      unavailable), read the last `digestLength` bytes and compare against
 *      the cached `GitIndex.trailerSha`. Catches stat-collisions.
 *
 * Falls through to `inner.resolve(ctx)` on miss; replaces the cache entry
 * with the freshly parsed value.
 *
 * Subscribes to the `WriteEventStream` so callers can observe that the
 * cache is wired even though invalidation itself is lazy (the generation
 * counter does the work). The subscription is held for the resolver's
 * lifetime; if a future caller needs hard eviction semantics, the listener
 * body is the place to add it.
 */
export const createCachingIndexResolver = (
  inner: IndexResolver,
  fs: FileSystem,
  stream: WriteEventStream,
  view: GenerationView,
): IndexResolver => {
  let entry: CacheEntry | null = null;

  const subscription: Disposable = stream.subscribe(() => {
    // No-op: the generation counter already advanced; subsequent resolves
    // detect the mismatch and re-validate via stat/trailer. See ADR-150.
  });
  void subscription; // retained — disposal happens with the owning repo lifetime.

  const trailerStillMatches = async (
    cached: CacheEntry,
    path: string,
    stat: FileStat,
  ): Promise<boolean> => {
    const trailerSize = cached.parsed.trailerSha.length;
    // equivalent-mutant: this entire size guard is defence-in-depth. A
    // cached entry only exists after a successful parseIndex, which
    // requires the file to be at least 32 bytes (12-byte header + 20-byte
    // trailer + 0 entries). Combined with `statMatches=true` (the only
    // gate to reach here), stat.size === observed.size >= 32 > trailerSize.
    // So neither `trailerSize === 0` nor `stat.size < trailerSize` is
    // reachable in normal flow. The guard hardens against adapter
    // misbehaviour on truncated inputs and Stryker correctly flags the
    // mutants as observably-equivalent under the established invariants.
    if (trailerSize === 0 || stat.size < trailerSize) return false;
    const trailer = await readTrailer(fs, path, trailerSize, stat.size);
    return bytesEqual(trailer, cached.parsed.trailerSha);
  };

  const isStatValidatedHit = async (
    cached: CacheEntry,
    path: string,
    stat: FileStat,
  ): Promise<boolean> => {
    if (!statMatches(stat, cached.observed)) return false;
    // equivalent-mutant: forcing this guard to `false` makes every call
    // fall through to `trailerStillMatches`. When `statMatches` is true and
    // `needsRacyCheck` is false (both stats carry ns and ns is equal),
    // the on-disk file is provably the same byte sequence as when we
    // cached — so the trailer read produces the same hash and
    // `trailerStillMatches` returns true. Observable behaviour
    // unchanged; only one extra `readSlice` per hit is skipped.
    if (!needsRacyCheck(stat, cached.observed)) return true;
    return trailerStillMatches(cached, path, stat);
  };

  const safeStat = async (path: string): Promise<FileStat | null> => {
    try {
      return await fs.stat(path);
    } catch (err) {
      // If the file doesn't exist we still want the inner resolver to handle
      // the empty-index fallback. Re-throw anything else — using
      // `instanceof TsgitError` keeps us from accidentally swallowing
      // unrelated objects with a shape that happens to carry `.data.code`.
      if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return null;
      throw err;
    }
  };

  return {
    resolve: async (ctx, opts) => {
      const currentGen = view.current('index');
      const bypass = opts?.bypassCache === true;

      if (!bypass && entry !== null && entry.cachedGen === currentGen) {
        return entry.parsed;
      }

      const path = resolveIndexPath(ctx.layout.gitDir);
      const stat = await safeStat(path);

      if (
        !bypass &&
        entry !== null &&
        stat !== null &&
        (await isStatValidatedHit(entry, path, stat))
      ) {
        entry.cachedGen = currentGen;
        return entry.parsed;
      }

      const parsed = await inner.resolve(ctx, opts);
      if (stat !== null) {
        entry = { parsed, observed: stat, cachedGen: currentGen };
      } else {
        entry = null; // missing index — keep cache empty so next call re-checks fs
      }
      return parsed;
    },
  };
};
