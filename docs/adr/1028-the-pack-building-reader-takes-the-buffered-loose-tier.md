---
subjects:
  - src/application/primitives/read-object.ts
  - src/application/primitives/build-pack.ts
  - src/application/primitives/internal/deltify.ts
---
# 1028 — The pack-building reader takes the buffered loose tier

- **Status:** accepted
- **Date:** 2026-10-21
- **Design:** docs/design/gc-size-lying-loose-blob.md (D2, requirement 6) · **Supersedes/Refines:** refines ADR-907 (gc joins the buffered consumers) and ADR-902 (`readObjectMetadata` is untouched)

## Context

`buildPack` and `deltify` read each loose object once through the internal
`readObjectMetadataWithContent`, whose loose arm pins the streamed tier so that the public
`readObjectMetadata`, which shares it, stays content-derived (ADR-902). A size-lying loose blob
therefore reaches the pack writer with its real bytes and a content-derived size, where git's
`pack-objects` reads every loose object through `read_object_file`, the buffered tier
(`unpack_loose_rest`): a past-window overrun refuses, an in-window one is truncated to the claim.
Only build-pack.ts and internal/deltify.ts call `readObjectMetadataWithContent`.

## Options considered

1. **`readObjectMetadataWithContent` takes the buffered tier; `readObjectMetadata` keeps the
   streamed tier** (recommended) — pros: one inflate per loose object, as today; the pinned
   content-derived contract and its test are untouched; `push`, `bundle create` and
   `packObjects` share `buildPack` and align with git too / cons: a read mode threads through the
   shared resolver.
2. **build-pack and deltify drop the carried content and re-read through `readRawObject`** —
   cons: every loose object inflates twice, undoing deltify's carried-content design.
3. **gc-pipeline pre-checks loose candidates** — cons: a third read per loose object, gc only;
   `push` and `bundle` keep refusing only when the content happens not to be carried.

## Decision

**User-ratified: option 1.** `readObjectMetadataWithContent` reads a loose object through the
buffered tier; the size it reports is the length of the bytes that tier yields, and the content
it carries is those bytes. `readObjectMetadata` keeps the streamed tier and stays content-derived.
A pack builder never sizes an entry from the header claim and never takes the streamed tier's
real bytes.

## Consequences

A past-window overrun refuses inside the build, before any pack byte exists. An in-window overrun
is packed as its truncation (ADR-1031). The threat model of ADR-907 holds: the buffered tier
bounds the inflate to `max(32, header + claim)` under the adapter ceiling, which is tighter than
the streamed tier's unbounded inflate the builders took before. Acceptance: `bench:ab` on the gc
rows of `test/bench/maintenance.bench.ts` within noise.
