---
subjects:
  - src/domain/storage/delta-encode.ts
  - src/application/primitives/internal/deltify.ts
---
# 768 — Selection splits a pure codec from a lazy window

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/delta-writing-packer.md (DC-2)

## Context

Domain code has zero outward dependencies. A delta selector, however, needs object content,
and materialising every object to hand the domain a pure array contradicts the residency
bound the whole design is built around: the window is valuable precisely because it is lazy.

## Options considered

1. **Pure domain over materialised objects** — pros: cleanest layering / cons: forces every object's content resident, defeating the window.
2. **Split** (chosen) — pros: every decision stays pure and unit-testable; I/O sits where I/O belongs / cons: the feature spans two layers.
3. **All inside `build-pack.ts`** — pros: fewest files / cons: blows the file-size and function-size limits.

## Decision

**User-ratified.** The domain owns the pure parts — `encodeDelta`, `createDeltaIndex`, the
ordering comparator and the acceptance predicate — as total functions over bytes. A
primitive-internal `deltify.ts` owns the sliding window and is the only piece that reads
objects. Every choice the packer makes is therefore a pure function; only the fetching is
not.

## Consequences

The comparator, encoder and acceptance rule are directly unit- and property-testable with no
context and no fixtures. Residency is governed in one place. The cost is that reading the
feature end to end means reading two files instead of one.
