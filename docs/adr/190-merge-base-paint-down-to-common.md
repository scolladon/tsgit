# ADR-190: Merge-base via Git's paint-down-to-common algorithm

## Status

Accepted (at `c232f238a1b7b45c9513b09b4c11c78aa6da430b`)

## Context

Computing *all* best common ancestors (LCAs) of commits, correctly even in criss-cross histories, can be done two ways:

- **Full reachability + remove-redundant** — intersect the complete ancestor sets, then drop any common ancestor reachable from another. Simple and provably correct, but walks the entire ancestry on every call (no early termination).
- **Git's paint-down-to-common** — a commit-date priority queue paints `one` with `PARENT1` and the others with `PARENT2`, propagating a `STALE` flag down from each discovered base so that ancestors of known bases are pruned. The walk stops as soon as the queue holds only stale commits. A subsequent `remove_redundant` pass drops non-best bases.

The current `mergeBase` uses neither — it does a layered bidirectional BFS and returns the first-intersection lex-min, which can surface a non-optimal base in criss-cross histories.

## Decision

Implement **Git's paint-down-to-common** mechanism, faithfully:

- A priority queue ordered by **committer timestamp descending** (newest first), with oid as a deterministic tie-break. Implemented as an insertion-sorted array (pop-front); a binary heap is a transparent drop-in left to the v2 perf phase since it does not change pop order or results.
- Flags tracked in per-call `Map<ObjectId, number>` (bits `PARENT1=1`, `PARENT2=2`, `STALE=4`, `RESULT=8`) — no global object-flag mutation, so each paint runs on fresh, isolated state and needs no `clear_commit_marks` analogue.
- The walk continues while the queue holds a non-stale commit; a commit flagged `PARENT1|PARENT2` is recorded as a result and its `STALE` bit propagates to parents.
- `removeRedundant` re-paints each candidate against the rest (candidate as `PARENT1`, others as `PARENT2`): a candidate reachable from another (`PARENT2` on itself) is redundant; any other reached from the candidate (`PARENT1` on it) is redundant.
- Commit reads are memoized in a per-invocation `Map` so the repeated paints in `removeRedundant` and the octopus fold do not re-read objects.

This is faithful to Git's *mechanism* (early termination via date ordering, `STALE` pruning), not merely its results.

## Consequences

### Positive

- Results match Git exactly, including the multiple-LCA criss-cross case, and the existing `mergeBase` non-optimality bug is fixed.
- Early termination: the date-ordered queue stops once all remaining frontier commits are stale, avoiding a full-ancestry walk on typical inputs.
- Per-call flag/read Maps keep the algorithm pure (no shared mutable state), aligning with the immutability principle and easing test isolation.

### Negative

- Materially more code than full-reachability: a priority queue, four flag bits, `STALE` propagation, and a pairwise `removeRedundant` pass. More surface to drive to 100% coverage and zero surviving mutants.
- The date/`STALE` logic has subtle branches; mutation testing must cover the `queue_has_nonstale` exit, the `(flags & f) === f` skip, and the `STALE`-propagation guard individually.

### Neutral

- Committer timestamp is read from the parsed commit object (already available); no new domain capability needed.
- The insertion-sorted-array PQ is O(n) per insert; acceptable for merge-base frontier sizes, and swappable for a heap later without behavioural change.
