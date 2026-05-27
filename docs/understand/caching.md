# Caching protocol

The snapshot+join surface caches parsed `.git/index` and resolved trees in
memory. This page documents the invalidation contract — the protocol that
keeps cached data fresh in the face of in-process writes, external writes,
and racy filesystem metadata.

## The CQS triple (ADR-157)

Three small ports separate the write side from the read side:

```
WriteEventEmitter   .emit(scope)       — command side
WriteEventStream    .subscribe(listener) → Disposable
GenerationView     .current(scope) → number   — query side
```

| Port | Holders | Contract |
|---|---|---|
| `WriteEventEmitter` | write-boundary primitives (`add`, `commit`, …) | Must `emit(scope)` AFTER the write succeeds, BEFORE releasing the lock |
| `WriteEventStream` | caching adapters | Receive event fan-out; subscription returns a `Disposable` |
| `GenerationView` | caching adapters, read primitives | Returns a monotonically-increasing counter per scope |

`scope` is one of `'index' | 'refs' | 'objects'`. Each has its own
independent counter; `emit('index')` does not perturb `current('refs')`.

The single in-process adapter (`createInMemoryWriteEventBus(view)`) owns
the only mutator on the underlying counter and exposes the read-only
`GenerationView` to the rest of the system.

## Lock-ordering protocol

Critical for TOCTOU correctness:

```
1. Acquire scope lock (e.g. .git/index.lock)
2. Write the new payload + atomic rename
3. emit(scope)                               ← BEFORE step 4
4. Release lock
```

Reasoning: a reader querying `view.current('index')` BEFORE acquiring its
own resolver-lock will see either the OLD generation (and re-validate via
stat / trailer) or the NEW generation (and re-parse). It cannot see a
stale snapshot with the new generation already published.

## Three-tier index invalidation (ADR-150)

`CachingIndexResolver` validates each call in three tiers:

```
┌─────────────────────────────────────────────────────────────────┐
│ Tier 1: Generation fast path                                    │
│  if cachedGen === view.current('index') && !bypassCache:        │
│    return cached value         ← zero syscalls                  │
│                                                                 │
│ Tier 2: Stat-validated path                                     │
│  stat the file; if (size, ino, mtime[ns]) match observed        │
│    AND comparison is not racy:                                  │
│      refresh cachedGen; return cached value  ← one syscall     │
│                                                                 │
│ Tier 3: SHA-trailer fallback                                    │
│  read last digestLength bytes; compare to cached trailerSha:    │
│    on match:  refresh cachedGen; return cached value            │
│    on miss:   inner.resolve(); replace entry                    │
└─────────────────────────────────────────────────────────────────┘
```

**Tier 1** catches our own writes — the write primitive bumped the
generation, so the next resolve detects the mismatch.

**Tier 2** catches external writes — another process modified the index;
our generation never bumped, but the filesystem stat did. The comparison
is "non-racy" when nanosecond-precision mtime is available on both
snapshots. On platforms without ns precision (FAT, some NFS), we fall to
tier 3.

**Tier 3** catches stat-collisions — when stat matches but mtime
resolution is coarse, the SHA-1 trailer is a hash-stable
content-discriminator. Same trick git's working-tree stat cache uses
for `racy-clean` detection.

## Single-flight de-duplication

`SingleFlightIndexResolver` sits between the snapshot factory and the
caching resolver. A thundering herd of concurrent `.entries()` calls
collapse into a single inflight `inner.resolve()`; subsequent callers
share the same promise.

## Tree resolver caching

Trees are content-addressed (oid is `sha1(serialised tree)`), so there
is no invalidation. `CachingTreeResolver` is a bounded LRU (default 256
entries) keyed by `ObjectId`. Same oid always maps to the same bytes
forever.

## Iteration stability (design §8.0)

Each snapshot handle owns the lifetime of the data it observes:

1. First `.entries()` call → resolver.resolve() → captured reference.
2. Subsequent `.entries()` calls on the same handle → stream from the
   captured reference, bypassing the resolver entirely.
3. A *new* `repo.snapshot.index()` call returns a fresh handle whose own
   first iteration sees the resolver's post-invalidation state.

So: emit('index') invalidates the *resolver cache* for new snapshots, but
never disturbs an in-flight loop on an existing handle.

## When the cache is wrong

Three escape hatches:

- `entries({ bypassCache: true })` — skip every cache tier for this call.
- `openRepository({ caching: false })` — disable caching globally (Wave 2).
- The default settings are correct for 99% of workflows; reach for these
  only when measurement says you must.

## Disabling deprecation warnings

`warnDeprecated` (used by Wave 8 legacy walkers) honours the
`TSGIT_SUPPRESS_DEPRECATIONS=1` env variable. Per-callsite dedup is
default-on; the env var fully silences output. See
[ADR-160](../adr/160-suppress-deprecations-env-var.md).
