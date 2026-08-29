---
subjects:
  - src/application/primitives/pack-registry.ts
  - src/application/primitives/internal/pack-offset-table.ts
  - src/application/primitives/internal/pack-positions.ts
  - src/domain/storage/pack-index.ts
  - src/domain/storage/rev-index.ts
---
# 720 — Pack successor lookup is lazy and `.rev`-first

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-4) · **Supersedes/Refines:** refines 625-one-shared-pack-offset-sort-for-idx-and-rev.md (the shared sort's read-path role shrinks to the no-`.rev` fallback)

## Context

Answering "where does this pack entry end" currently materialises two O(N) passes over
the whole pack index (`entryOffsets` into a boxed array, then a rev-index gather),
memoised per pack per generation — the dominant cost of a cold single-object read. With
a `.rev` present, `p ↦ readOffset(index, revIndexPositionAt(rev, p))` is monotonic, so
the successor is a binary search: O(log N) DataView reads, zero allocation — canonical
git's own shape. The `REV_INDEX_MIN_OBJECTS = 5000` threshold protects a gather-vs-sort
crossover that only exists under the eager design, and the eager table has no bulk
consumer (fsck and the bitmap tier use `packPositions()`/`packPositionMap` independently).

## Options considered

1. **Lazy `.rev`-backed successor; retire the threshold; `Float64Array` table only as no-`.rev` fallback** (recommended, chosen) — pros: kills the O(N) build on the read path; a present `.rev` always wins / cons: log N per successor query for bulk-ish readers (none exist today).
2. **Lazy lookup but keep the threshold** — cons: keeps a tuning constant whose justifying crossover no longer exists.
3. **Eager, drop only the boxed intermediate** — cons: still O(N) per pack per cold open.

## Decision

**User-ratified.** The successor query binary-searches the `.idx`+`.rev` pair lazily;
`REV_INDEX_MIN_OBJECTS` is retired — a present, loadable `.rev` is always preferred. The
memoised sorted-offset table survives only as the no-`.rev` fallback and is built
directly into a `Float64Array`. The refusal layering is preserved verbatim:
`INVALID_PACK_INDEX` stays absent from `isSkippablePackFault` so mid-read corruption
refuses rather than degrading to a silent `OBJECT_NOT_FOUND`, the three corrupt-index
error strings are kept byte-identical, and an out-of-range `.rev` value degrades the pack
to the fallback exactly as the gather's bounds check does today.

## Consequences

Cold single-object reads stop paying O(N) per touched pack; midx repos benefit
transitively (a midx hit no longer forces the owning pack's table). The
`pack-offset-table` bench fixture must exercise both the `.rev` path and the fallback
(the fixture's object count is raised past the old threshold in the same change), and the
Stryker equivalence proof written against the old `bisectLeft`-over-table structure is
re-proved or removed with it.
