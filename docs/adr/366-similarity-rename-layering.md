# ADR-366: Similarity rename scoring layering — pure-domain scorer + primitive orchestrator

## Status

Accepted

- **Date:** 2026-06-19
- **Design:** [design/similarity-rename-detection.md](../design/similarity-rename-detection.md)

## Context

Exact (R100) rename detection is a pure-domain function over a `TreeDiff`
(`detectRenames`, `src/domain/diff/rename-detect.ts`): it buckets deletes by blob id
and never reads bytes. Content-similarity pairing needs the actual blob **bytes** of
each candidate add/delete, which is I/O — the domain layer has no `Context` and must
stay I/O-free under the hexagonal dependency rule. `detectRenames` is already invoked
from the primitive tier (`primitives/diff-trees.ts`), which holds `ctx` and already
hydrates blob bytes for `attachStats` / `materialisePatchFiles`.

## Options considered

1. **(chosen) Pure-domain `estimateSimilarity` + primitive orchestrator** — a pure
   `estimateSimilarity(src, dst): number` in the domain; a primitive
   `detectSimilarityRenames(ctx, diff, options)` runs the exact pass, then hydrates
   only the leftover unpaired blobs and scores them. Pros: domain stays pure and
   property-testable; reuses the existing hydration precedent at the tier that holds
   `ctx`; scores lazily (only leftovers, only past the limit guard). Cons: none material.
2. **Pre-hydrate all bytes, pass a `Map<ObjectId, bytes>` into an enriched domain
   `detectRenames`** — keeps one function but leaks byte maps through the domain
   boundary and hydrates even pairs the exact pass already consumed. Rejected.
3. **A separate command-tier similarity step** — duplicates orchestration the
   primitive tier already centralizes for every consumer. Rejected.

## Decision

The byte-level similarity scorer is a pure domain function
(`estimateSimilarity`, `src/domain/diff/similarity.ts`). The I/O orchestration —
running the exact pass, hydrating leftover blobs through `Context`, building the
score matrix, and selecting winners — lives in a new primitive
`detectSimilarityRenames` (`src/application/primitives/detect-similarity-renames.ts`).
`diffTrees` swaps its lone `detectRenames(...)` call for the new primitive; every
existing consumer threads through `diffTrees` unchanged.

## Consequences

- The domain gains no I/O dependency; the scorer is unit- and property-testable in
  isolation.
- The exact pass runs first and removes its pairs before the inexact matrix is built,
  so only genuinely-unpaired candidates are hydrated and scored.
- Bounded-concurrency blob reads reuse the `materialisePatchFiles` pool pattern.
