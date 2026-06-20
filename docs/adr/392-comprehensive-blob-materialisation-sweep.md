# ADR-392: Stream every full-blob working-tree materialisation site, not just the checkout hot path

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/blob-streaming.md](../design/blob-streaming.md)
- **Refines:** [ADR-390](390-write-stream-port-method.md)

## Context

`apply-changeset.ts:167` (`checkout:materialize`) is the single hot path for checkout /
reset / stash / sparse-checkout, all of which route through the shared
`writeWorkingTreeEntry` primitive. But it is not the *only* place a full blob is read and
written to the working tree: the three-way-merge path materialises a clean survivor side
via `readBlob(...).content` → `writeWorkingTreeEntry` directly (e.g.
`apply-merge-to-worktree.ts`, `write-distinct-types-sides.ts`), bypassing the changeset
loop. Converting only the shared changeset primitive would leave those direct sites
buffered. The decision is how wide to cast the conversion.

This deviates from the design's recommendation (convert the shared primitive only); the
user chose the comprehensive sweep so that **no** full-blob materialisation is left
buffered.

## Options considered

1. Convert the shared `writeWorkingTreeEntry` regular-file arm only (the design's rec) —
   covers every `applyChangeset` caller with one change, but misses direct
   `readBlob → writeWorkingTreeEntry` sites outside the changeset loop.
2. **(chosen) Comprehensive sweep** — convert *every* working-tree site that materialises
   a **full blob** (`readBlob(id).content` → working-tree write) to `streamBlob` →
   `writeStream`, including the merge clean-survivor writes, not just the changeset hot
   path — pros: no full-blob materialisation is left buffered; the memory win is
   repo-wide / cons: more call sites to convert and pin; requires an explicit
   enumeration so nothing is missed and nothing inapplicable is force-fit.
3. A still-broader sweep that also rewrites synthesised-content writes — Rejected: see
   the exclusion criterion.

## Decision

Convert **every** site that writes a *full* blob's content to the working tree to the
streaming path (`streamBlob` → `writeStream`). The exclusion criterion: a site is **not**
converted when it writes **synthesised or length-capped content** rather than a single
whole blob — specifically the merge **conflict-marker** materialisation (it builds
`<<<<<<<`-marked, `MAX_CONFLICT_OUTPUT_BYTES`-capped content from multiple sides, with no
single blob stream to consume) and symlink/gitlink modes (ADR-391). The design revision
enumerates the exact in-scope sites; the plan slices each.

## Consequences

### Positive

- The peak-memory win covers checkout, reset, stash, sparse-checkout, **and** merge
  clean-survivor writes — every full-blob path, not one.

### Negative

- More consumer conversions and interop pins than the single-hot-path approach.

### Neutral

- Conflict-marker and symlink/gitlink writes stay buffered by the exclusion criterion —
  they have no whole-blob stream to consume.
