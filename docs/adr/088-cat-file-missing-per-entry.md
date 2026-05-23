# ADR-088: Missing-object hits are yielded per-entry, not thrown

## Status

Accepted (at `cfacf2b`)

## Context

`catFileBatch` reads a stream of ids. Some will resolve, some will
not — every realistic batch user has to tolerate misses (a stale
index, a packfile pruned between scan and read, a partial-clone id
the promisor cannot serve). Three policies were considered:

- **Throw on first miss.** Single bad id aborts the whole batch.
  Simple, but hostile to high-throughput consumers — a "best-effort
  scan a million ids" use case is unworkable. Also forces callers to
  rebuild progress state on retry.
- **`onMissing: 'skip' | 'yield' | 'throw'` option.** Configurable
  per-call. Triples the surface to test and document with no proven
  caller that needs the variety.
- **Yield a discriminated `{ ok: false, id, reason: 'missing' }`
  entry.** The stream stays alive; the consumer decides what to do
  with each miss; the union encodes the policy at the type level.
  Matches git's textual contract (`<sha> missing\n` after a read of
  an unknown id) — same per-id outcome, structured rather than
  printed.

Only `OBJECT_NOT_FOUND` is a "miss." Everything else — corrupt pack,
hash mismatch, decompress failure, repository disposed, ports rejected
— is a real error that callers must see, not silently absorb.

## Decision

`catFileBatch` yields a discriminated union per id:

```ts
type CatFileBatchEntry =
  | { ok: true;  id: ObjectId; type; size; object }
  | { ok: false; id: ObjectId; reason: 'missing' };
```

The error filter is exactly `err instanceof TsgitError && err.data
.code === 'OBJECT_NOT_FOUND'`. All other thrown errors propagate out
of the iterator unchanged.

Partial-clone lazy-fetch is layered underneath: `readObject` already
attempts a single promisor fetch per missing id. If the fetch
succeeds, we get an `ok: true` entry. If the fetch was attempted but
the object is still absent, `OBJECT_NOT_FOUND` is rethrown — which
becomes `{ ok: false, reason: 'missing' }`. A network failure during
the fetch is a different `TsgitError` code (e.g. `HTTP_*` /
`TRANSPORT_*`) and propagates as an exception.

No `onMissing` option ships. The union encodes intent; callers who
want throw-on-miss filter and throw themselves in O(1) code.

## Consequences

### Positive

- A long batch survives sparse misses — the dominant use case
  (indexers, GC walkers) works at full throughput.
- `OBJECT_NOT_FOUND` is the only soft outcome — every other failure
  remains loud, preserving the project's "never silently swallow
  errors" rule (CLAUDE.md / common/coding-style.md).
- Type-level discrimination — TypeScript narrows `entry.ok` to give
  callers a checked branch.

### Negative

- Two-state union forces a check at every read site. The type does
  not let callers ignore it accidentally, which is the whole point.

### Neutral

- `reason` is currently a single literal `'missing'`. The union is
  extensible — future variants (e.g. `'invalid-cone'` if a
  sparse-checkout filter ever rejects) would be additive.
