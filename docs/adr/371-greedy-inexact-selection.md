# ADR-371: Replicate git's greedy inexact selection, not an optimal matching

## Status

Accepted

- **Date:** 2026-06-19
- **Design:** [design/similarity-rename-detection.md](../design/similarity-rename-detection.md)
- **Refines:** [ADR-226](226-git-faithfulness-prime-directive.md)

## Context

When several candidate sources score near-equally against several targets, the choice
of matching algorithm changes which pairs form. git's `diffcore-rename.c` scores every
`(src, dst)` pair, sorts candidates by score descending, and greedily records the best
still-available match (`record_if_better`), each source consumed by at most one
target. This is **greedy, not a globally-optimal (Hungarian) assignment**: a pinned
near-symmetric 5×5 case (every source ~equally similar to every target) leaves one
pair orphaned that an optimal matcher would have kept. The prime directive (ADR-226)
binds tsgit to git's observable output byte-for-byte.

## Options considered

1. **(chosen) Replicate git's score-sorted greedy `record_if_better` matrix** — every
   pair scored, sorted score-descending, best still-available match recorded. Pros:
   reproduces git's pinned decisions exactly, including the greedy orphan. Cons:
   deliberately suboptimal — pairs fewer files than a globally-optimal matcher in
   adversarial near-symmetric inputs.
2. **Globally-optimal (Hungarian) assignment** — pairs more files. Rejected: diverges
   from git's output and fails the interop pin.
3. **Per-target argmax** — simpler, but can double-assign one source to two targets and
   still diverges from git. Rejected.

## Decision

The inexact selection replicates git's algorithm: score every candidate `(src, dst)`
pair, sort by score descending (with git's tie-break order), and greedily record the
best match for which neither side is yet consumed. tsgit does **not** improve on git's
matching even though a better matching exists; byte-for-byte faithfulness wins over
"more correct".

## Consequences

- The near-symmetric orphan case is pinned by interop; any future "optimization" of the
  matcher that changes pairings is a faithfulness regression, not an improvement.
- Copy detection (ADR-369) shares the same greedy selection machinery.
- The selection is deterministic given git's score sort and tie-break order, which the
  interop matrix pins.
