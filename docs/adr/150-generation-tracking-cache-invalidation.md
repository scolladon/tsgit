# ADR-150: Generation-tracking + stat-fallback for cache invalidation

## Status

Accepted (at `1c35bc3`)

## Context

Phase 20.1 introduces in-process caching of parsed `.git/index` and resolved
trees. A long-lived tsgit process must invalidate these caches when the
underlying data changes. Sources of mutation:

- **Our own writes** — `repo.add()`, `repo.commit()`, etc. mutate the index.
- **External writers** — concurrent git CLI, IDEs, editor LSP integrations,
  CI scripts, lazygit/tig, our own pre-commit hooks.

Three families of invalidation strategy:

1. **Always re-parse** — correct but defeats the cache.
2. **mtime-only polling** — fast but breaks on coarse-mtime filesystems
   (FAT, some NFS) and on sub-second double-writes.
3. **Generation-tracking + stat fallback + SHA-trailer fallback** — three
   tiers, each catches what the previous misses.

## Decision

Cache records `(parsedValue, observedStat, generationAtParse)`. Invalidation
follows this contract:

- Every write-boundary primitive calls `WriteEventEmitter.emit(scope)` AFTER
  the write but BEFORE releasing the lock (critical for TOCTOU — see spike §7.3).
- `CachingIndexResolver` (and peer) subscribe via `WriteEventStream`; an
  internal counter increments per event, exposed via `GenerationView`.
- Cache-hit path:
  1. If `cachedGen === view.current(scope)` → use cache, **zero syscalls**.
  2. Else `stat()`; if `(mtime, size, ino)` match observed → use cache,
     refresh `cachedGen`.
  3. Racy-stat window (`stat-mtime ≥ recorded-mtime`) → compare last 20 bytes
     (SHA-1 trailer); mismatch → re-parse.
  4. Else (stat differs) → re-parse, replace entry.

Lock-ordering: emit BEFORE release. Reasoning: JS single-threaded per task,
so the emit and the release are an atomic pair from any other task's POV.
External writers don't call emit at all; their writes are caught by the stat
or trailer comparison.

## Consequences

### Positive

- Zero syscalls on cache hit when no writes have occurred. Multi-order-of-magnitude
  speedup vs. always-re-parse for read-heavy workloads (e.g., 50k-file `status`).
- Catches our own writes via generation (no syscall needed — we just wrote).
- Catches external writes via stat (one syscall per cache hit when generation
  matches but file changed externally).
- Catches racy-stat collisions via SHA-trailer comparison — same trick git's
  own stat-cache uses for working-tree entries.

### Negative

- Three-tier invalidation is more code than a single re-parse line. Mitigated
  by single-flight wrapper + property tests + 100% mutation budget on the
  caching adapter.
- SHA-trailer comparison reads 20 bytes per ambiguous case. Cost negligible
  vs. full parse.

### Neutral

- Tree/commit caches are content-addressed; no invalidation logic needed.
- Workdir entries are per-row, not globally cached; this ADR doesn't apply to
  them.
