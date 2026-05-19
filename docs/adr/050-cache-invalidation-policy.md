# ADR-050: Cache invalidation policy for the normalised-root cache + resolveForCreation LRU

## Status

Accepted (at `50e6eed`)

## Context

Phase 14.5 introduces two caches inside `NodeFileSystem`:

1. **Normalised-root cache (14.5.1)** — two `string | undefined`
   fields holding `policy.normalizeForCompare(rootDir)` and
   `policy.normalizeForCompare(canonicalRoot)`. Populated lazily;
   read by `pathContains` on every containment check.
2. **resolveForCreation LRU (14.5.4)** — an `LruCache<string, string>`
   mapping the raw parent path to its `realpath(parent)` result.
   Capacity 64. Re-uses the existing `src/domain/storage/lru-cache.ts`.

Both caches sit on the security-critical containment path. A stale
entry that survives an invalidation event could (in theory) widen a
TOCTOU window or shift a write to an unintended location.

Cache-invalidation strategies for an in-process filesystem-aware
cache:

1. **TTL.** Evict entries after N milliseconds. Requires a clock and
   a sweeper; gives a hard upper bound on staleness. Overkill for
   the rootDir cache (the rootDir is immutable for the adapter's
   lifetime).
2. **Event-driven (write-side invalidation).** Invalidate on any
   adapter operation that could change the entry's truth value
   (rm, rmRecursive, rename). Requires hooking those operations.
3. **Never invalidate.** Cache for the adapter's lifetime. Defensible
   only when the cached value is provably stable (e.g., the rootDir
   itself is `readonly` on construction).

Different cache requires different strategy:

- **Normalised-root cache.** `rootDir` is `readonly`. The canonical
  root is the realpath of a path that does not change during the
  adapter's lifetime. Strategy 3 (never invalidate) is sufficient.
- **resolveForCreation LRU.** Caches the realpath of a directory that
  exists at cache time. The directory CAN be deleted via the same
  adapter (rmRecursive) or renamed via the same adapter (rename).
  Strategy 2 (event-driven) is required.

For the LRU specifically, two events drop entries:

1. **rmRecursive of an ancestor.** Clear every key that starts with
   the removed path + sep. The traversal is O(N) over a 64-entry
   cache — trivially cheap.
2. **rename of a source path that has cached descendants.** Clear
   every key under the source path. Same O(N) cost.

External filesystem mutations (a user `rm -rf`'s the working tree
while tsgit is operating on it) are not invalidated. The post-realpath
containment check still gates the joined `real` against rawRoot and
canonicalRoot — a stale LRU entry can produce a wrong write location
inside the tree but cannot escape it.

## Decision

**Normalised-root cache (14.5.1):** never invalidate. Cache the
result on first computation, reuse for the adapter's lifetime.

**resolveForCreation LRU (14.5.4):** invalidate on adapter-side
writes that touch the cache's namespace.

```ts
// Inside rmRecursive's exit point:
this.invalidateCreationCacheUnder(real);

// Inside rename's success path:
this.invalidateCreationCacheUnder(srcReal);

private invalidateCreationCacheUnder(prefix: string): void {
  const prefixWithSep = prefix + this.pathPolicy.sep;
  for (const key of this.creationParentCache.keys()) {
    if (key === prefix || key.startsWith(prefixWithSep)) {
      this.creationParentCache.delete(key);
    }
  }
}
```

LRU capacity: 64. Aligns with the existing pack-delta-base cache
sizing; covers the common "deep clone into one tree" workload
without unbounded memory growth.

The LRU does NOT cache the result when `realpathParentIfExists(parent)`
returns `undefined` (parent doesn't exist yet — fall back to the
existing walk). This avoids freezing a "doesn't exist" decision into
the cache; the next call after the parent is created will warm the
cache cleanly.

## Consequences

### Positive

- Cache invalidation is **local** — all four mutation sites
  (rmRecursive, rename, and the two cache writers themselves) live
  inside `NodeFileSystem`. No external coordination.
- The two caches each carry the strategy appropriate to their
  invariant: the immutable normalised-root needs no invalidation;
  the mutable parent-dir realpath gets event-driven invalidation.
- Existing post-realpath containment check remains the security
  gate. Stale LRU entries cannot enable rootDir escapes.

### Negative

- External filesystem mutations bypass the LRU invalidation. A user
  who externally renames `/root/src/` to `/root/source/` mid-clone
  could see writes land in the cached old location. Limited blast
  radius (still inside rootDir; post-realpath containment passes
  because both old and new locations are in-tree) but worth
  documenting.
- The cache adds branches that need both arms tested under mutation
  testing (hit + miss). 14 new branch arms total across both caches.

### Neutral

- The 64-entry LRU is sized for typical workloads but is not tuned.
  A future profiling pass (§15.3) may revisit.
- The cache invalidation logic does not propagate across multiple
  `NodeFileSystem` instances pointing at the same rootDir. Each
  instance is independently cached. This matches the existing
  canonical-root promise behaviour.
