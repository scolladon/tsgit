# ADR-090: Strict input order, sequential reads

## Status

Accepted (at `cfacf2b`)

## Context

Three concurrency policies were considered for `catFileBatch`:

- **Strict order, sequential.** Read ids one at a time. Yield in
  input order. Matches `git cat-file --batch`'s default.
- **Strict order, bounded-parallel.** Read N ids in parallel; buffer
  early completions to preserve input order. Faster on cold loose
  objects; needs a head-of-line buffer; introduces contention on
  `PackRegistry` and the delta-base LRU, which are not designed for
  parallel readers.
- **Unordered, bounded-parallel.** Equivalent to git's `--unordered`.
  Highest throughput; pushes ordering responsibility to the caller.

The bottleneck on a packed repo is in-memory: `.idx` fanout binary
search, `applyDelta` chains, inflate of compressed payloads. These
are CPU-bound, not I/O-bound. `readObject` already caches the
parsed `PackRegistry` per-Context (`registryCache` WeakMap) and shares
the LRU delta cache (`ctx.deltaCache`). Adding bounded parallelism
would not unlock more throughput — it would split CPU across cores
which are already busy doing the same `inflate` / `applyDelta` work.

On cold loose objects (uncommon in a real workload — packs are the
norm) parallelism would help, but the additional state (a parallel
read coordinator, an out-of-order buffer, and the LRU contention)
costs more code, more tests, more mutation surface, more
documentation than the gain warrants today.

## Decision

`catFileBatch` reads ids strictly in input order, one at a time.

The implementation is a `for await … of` loop calling `readObject`
per id, yielding the resulting entry, and checking `ctx.signal
.aborted` before and after each iteration.

No `concurrency` or `unordered` options on the surface. They can be
added later without breaking the type (additive properties on
`CatFileBatchOptions`).

## Consequences

### Positive

- Simplest correct implementation — one `for await` loop, one
  `try/catch` around `readObject`.
- Output order is byte-trivially identical to input order; callers
  can correlate by index without re-keying.
- No coordination structures, no head-of-line buffer, no contention
  on `PackRegistry` / `deltaCache`. The existing per-Context caches
  remain race-free.
- Cancellation is precise: `ctx.signal.aborted` is checked between
  every read, so an abort lands on the next yield boundary.

### Negative

- A pathological workload (millions of cold loose objects on a slow
  disk) would not benefit from concurrent I/O. We treat this as
  out-of-target — packed repos and warm caches are the realistic
  case.

### Neutral

- A future `concurrency` option, or an `unordered: true` mode, can
  ship later without disturbing existing callers — the iterable shape
  already permits it.
