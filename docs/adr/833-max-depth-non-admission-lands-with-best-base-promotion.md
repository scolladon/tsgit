---
subjects:
  - src/application/primitives/internal/deltify.ts
---
# 833 — Max-depth non-admission lands with best-base promotion

- **Status:** accepted
- **Date:** 2026-09-07
- **Design:** docs/design/name-hash-delta-ordering.md (DC-8) · **Supersedes/Refines:** refines ADR-831

## Context

`find_deltas` does not return an object to the window once it has become a delta at
`max_depth`, and runs no promotion for it. tsgit admits every candidate unconditionally, so a
depth-50 member occupies a window slot no later object can use as a base.

This is a window mechanic the design's first pass did not list among git's four heuristics; it
surfaced when the revision pinned the window against git 2.55.0 empirically rather than from
source alone. It is a real divergence under the ordering stage taken alone. Once the
depth-scaled bound lands it becomes byte-neutral on both fixtures, because no chain reaches 50
under that bound.

## Options considered

1. **Fold it into the promotion stage** (chosen) — pros: it is three lines in the same function that stage already rewrites; one commit, one measured zero / cons: the promotion stage's measurement then covers two mechanics rather than one.
2. **Leave it a named residual** — pros: keeps the promotion stage minimal / cons: leaves a known window divergence open, and falsifies ADR-831's stated consequence that nothing byte-moving remains — this mechanic can move bytes under a flat bound.
3. **Its own fourth stage** — pros: maximum attribution / cons: spends a whole measurement point recording a zero the promotion stage would record anyway.

## Decision

**User-ratified.** Non-admission lands in the same commit as best-base promotion. Both are
window-admission mechanics in `deltifyEntries`, both are expected to read as zero on the two
fixtures, and the stage records that zero once.

## Consequences

Every window mechanic git has is now either implemented or recorded as a CPU-only residual, so
ADR-831's "nothing that moves bytes remains" holds as written.

The promotion stage measures two mechanics together. That is a deliberate narrowing of the
staging discipline, justified because both are expected to be byte-neutral on these corpora: a
non-zero reading on that stage means one of the two moved bytes and needs separating, which the
stage's own row says explicitly so a surprising number is not silently attributed to promotion.

Under the ordering stage alone — before the bound lands — the divergence is still present and
still able to move bytes. The staged measurement records the ordering stage's numbers with that
caveat rather than pretending the window already matches git's.
