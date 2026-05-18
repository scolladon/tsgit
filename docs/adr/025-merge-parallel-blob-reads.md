# ADR-025: `buildContentMerger` reads ours/theirs/base in parallel

## Status

Accepted (at `af6de38608353eb7d12ad4b83d137940fa9f5c56`)

## Context

Phase 13.4a's `buildContentMerger` reads the three blobs sequentially:

```typescript
const oursBytes = (await readBlob(ctx, mergeCtx.ourId)).content;
const theirsBytes = (await readBlob(ctx, mergeCtx.theirId)).content;
const baseBytes =
  mergeCtx.baseId !== undefined ? (await readBlob(ctx, mergeCtx.baseId)).content : undefined;
```

Each `readBlob` waits for the previous to complete before issuing
the next I/O. For a merge with N conflicting paths, that's 3N
sequential I/O round trips. Pass-1 perf review of Phase 13.4a
flagged this as a HIGH; parallelisation was deferred to Phase 13.8
so the security HIGH on memory pressure (no per-blob cap)
remained sequential and bounded.

Phase 13.8 introduces `readBlob({ maxBytes })`. With the per-blob
cap in place, parallelising the three reads is safe to do without
adding cumulative-memory risk on top of the existing per-blob
bound.

## Decision

`buildContentMerger` reads the three blobs with `Promise.all`:

```typescript
const [ours, theirs, base] = await Promise.all([
  readBlob(ctx, mergeCtx.ourId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
  readBlob(ctx, mergeCtx.theirId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES }),
  mergeCtx.baseId !== undefined
    ? readBlob(ctx, mergeCtx.baseId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES })
    : Promise.resolve(undefined),
]);
```

Three concurrent reads, each bounded at `MAX_CONFLICT_OUTPUT_BYTES`
(256 MiB). Cumulative peak: 3 × 256 MiB = 768 MiB during a single
content merge. Acceptable in the merge contract — the cap is per-
blob and protects against a single adversarial input; the merge
operation is allowed to materialise three legitimate blobs
concurrently.

## Consequences

### Positive

- **Wall-time roughly equals one blob read instead of three.**
  Loose/pack reads are I/O-bound; concurrent dispatch reduces
  serialised latency to a single round trip for the slowest blob.
- **`Promise.all` is the smallest possible change.** No
  abstraction, no semaphore, no new helper. The original
  sequential code's three statements become one destructure.
- **The per-blob cap from ADR-024 is what makes this safe.** A
  single 256 MiB cap × 3 blobs is bounded; without the cap, three
  concurrent reads could individually OOM the process.
- **Deterministic output.** `mergeContent` is pure of its three
  inputs; parallel vs serial fetch produces identical merge
  results.

### Negative

- **Cumulative memory under parallelisation is 3 × cap.** For
  legitimate 256 MiB blobs that's 768 MiB peak. If a future
  audit decides this is too much, the next step is a semaphore
  around the parallel fetch (read base + at-most-one-of-ours-
  theirs at a time). We don't add it now because no real-world
  merge exercises the worst case — 256 MiB legitimate blobs are
  vanishingly rare.
- **`Promise.all` failure semantics: first rejection wins.** If
  ours' read throws `OBJECT_TOO_LARGE` first, the in-flight base
  and theirs reads continue until they yield. Their results are
  discarded (the caller never sees them). For loose objects on
  disk this is essentially free; for pack reads it's
  cancellation-unaware work that we accept as a cost of using
  the standard combinator. A future refactor could thread
  `AbortSignal` through `readObject`, but that's broader than
  this phase.

### Neutral

- Mutation testing cannot distinguish parallel from serial
  without timing instrumentation. Stryker will surface a mutant
  that swaps `Promise.all` for a sequential `for-await`; we
  document it inline as `equivalent-mutant` per the project
  convention.

## Alternatives considered

- **Keep sequential.** Rejected. The HIGH perf review finding
  from Phase 13.4a was the original motivation. We have the
  per-blob cap in place; there is no longer a reason to keep
  the sequential chain.
- **Promise.all with a semaphore (e.g., max-2 concurrent).**
  Rejected for v1.x. Adds machinery for a hypothetical
  worst case. The follow-up path is clear if needed.
- **Read base first, then ours+theirs in parallel.** Considered.
  The merge fast-paths in `mergeContent` (`bytesEqual(ours, base)`
  etc.) want base to short-circuit, so reading base first then
  conditionally reading ours/theirs feels intuitive. Rejected
  because (a) the fast-path comparison only applies when ours
  OR theirs equals base — both are still needed for the conflict
  fallback; (b) the conditional structure adds branches without
  saving expected work; (c) Promise.all is more legible.
- **Memoise the three reads at the buildContentMerger factory
  level.** Rejected. Each content-merger call has a different
  triple. Memoisation would only help when the same triple
  appears repeatedly within a merge, which the tree walker
  doesn't do.
