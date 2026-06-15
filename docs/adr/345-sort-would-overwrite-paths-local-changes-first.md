# ADR-345: Sort would-overwrite paths ascending, local-changes first

## Status

Accepted

- **Date:** 2026-06-15
- **Design:** [design/merge-tracked-dirty-conflict-refusal.md](../design/merge-tracked-dirty-conflict-refusal.md)

## Context

The would-overwrite refusal carries the offending paths, now split by class
([ADR-344](344-discriminate-would-overwrite-refusal-by-class.md)). The design pinned
that real git lists paths **alphabetically sorted** within each block (M1: add-order
`zebra`,`alpha`,`mango` printed as `alpha`,`mango`,`zebra`) and prints the
**local-changes block before the untracked block** (ORD1). The path set is built
from `changedPaths`, which derives from a `Set` whose iteration order is not the
faithful order.

## Options considered

1. **(chosen) Sort each class array ascending; order local-changes before
   untracked** *(design recommendation)* — Pros: matches git's pinned within-block
   sort (M1) and cross-block order (ORD1); deterministic and mutation-stable;
   `sortedRecordedPaths` / `comparePaths` already exist to reuse. Cons: none.
2. **Preserve discovery (`Set`-iteration) order** — Cons: non-deterministic across
   runs; defeats byte-for-byte interop pinning and mutation stability.

## Decision

Both `WORKING_TREE_DIRTY` class arrays are sorted ascending with the existing path
comparator. `localChanges` is the first-printed block and `untracked` the second,
matching git's ORD1 ordering. ORD2 (a path that is both) resolves to local-changes
only, so it never appears in both arrays.

## Consequences

### Positive

- Refusal output is deterministic and byte-for-byte faithful to git's ordering,
  both within and across the two blocks.
- Reuses the existing path comparator — no new sorting code.

### Negative

- None.

### Neutral

- Sorting is applied at the refusal-construction boundary; the internal
  `changedPaths` set stays order-agnostic.
