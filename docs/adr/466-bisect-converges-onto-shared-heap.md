# 466 — bisect midpoint converges onto the shared binary heap

- **Status:** accepted
- **Date:** 2026-07-09
- **Design:** docs/design/commit-priority-queue-heap.md · **Amends:** ADR-430 (the "intentionally not shared" clause) · **Relates:** ADR-465, ADR-226

## Context

ADR-430 kept `bisect-midpoint.ts`'s candidate walk on its *own* local FIFO-stable
sorted-array queue (`WalkEntry { id, date, ins }`, `entryPrecedes` = `date desc,
ins asc`), "intentionally not shared" with the domain queue. The stated reason
was narrow: the shared queue baked in an **oid** tie-break, which is faithful
only for order-independent consumers, whereas bisect's candidate-list order is
order-sensitive and must break equal-date ties by **insertion order (FIFO)** to
match `git rev-list`'s `--date-order` / `--bisect` list-order tie-break. That
reason is now gone: ADR-465's heap takes the comparator as an argument, so a
FIFO tie-break is expressible on the shared structure. Bisect also suffers the
identical O(N²) the migration removes.

## Options considered

1. **Converge now** — migrate bisect onto the shared `BinaryHeap` constructed
   with `(date desc, ins asc)` `less`; delete the local `WalkEntry` /
   `entryPrecedes` / `enqueueWalkEntry`. Pros: bisect gets O(N log N); one queue
   structure (DRY); both-merge-direction diamond goldens guard it directly.
   Cons: amends an accepted ADR; slightly wider diff. *(recommended)*
2. **Heap capable, bisect stays local this PR** — leave bisect on its O(N²) walk
   for a follow-up. Cons: perpetuates the duplicated structure; a follow-up cuts
   against the no-follow-ups-by-default rule.
3. **Never converge** — keep bisect permanently separate. Cons: permanent
   duplication for no faithfulness gain.

## Decision

Bisect converges (user-ratified). `bisect-midpoint.ts`'s candidate walk uses the
shared `BinaryHeap<WalkEntry>` (ADR-465) constructed with the comparator
`a.date > b.date || (a.date === b.date && a.ins < b.ins)`; the local
`WalkEntry` / `entryPrecedes` / `enqueueWalkEntry` are deleted. The monotonic
`ins` insertion counter stays the equal-date tie-break key, so the candidate-list
order is unchanged. This **amends ADR-430's "intentionally not shared" clause**:
the FIFO walk now shares the heap implementation while keeping its own comparator.
ADR-430's other decisions — the verbatim `find_bisection` port, list-order
tie-break semantics, merge-union weighting, faithful degenerate passthrough, and
`skip` staying the consumer's responsibility — are untouched.

## Consequences

- Bisect's candidate enumeration drops from O(N²) to O(N log N) with no change to
  which commit it picks or the reported counts.
- The equal-date merge-diamond interop goldens in
  `test/integration/bisect-midpoint-interop.test.ts` (both merge directions) now
  guard the shared heap's FIFO comparator directly — they remain the FIFO-order
  regression net and must stay green unchanged.
- One priority-queue structure remains in the codebase instead of two.
- Future readers of ADR-430 must follow the amendment here for the sharing story;
  the tie-break *semantics* it records still stand.
