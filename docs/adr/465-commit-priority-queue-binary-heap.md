# 465 — commit priority-queue: comparator-parameterized binary min-heap

- **Status:** accepted
- **Date:** 2026-07-09
- **Design:** docs/design/commit-priority-queue-heap.md · **Refines:** ADR-226 (git-faithfulness); docs/design/consolidate-commit-priority-queue.md (the 23.3a consolidation)

## Context

The shared date-ordered commit queue (`src/domain/commit/priority-queue.ts`)
keeps commits newest-committer-date-first with an oid-ascending tie-break via a
sorted-array `enqueue` (linear scan + `splice`, O(N)) and an O(N) `shift` pop —
**O(N²)** over N commits. Canonical git uses a binary min-heap (`prio_queue` in
`prio-queue.c`), O(log N) per put/get → **O(N log N)**. Migrating raises three
choices: the heap's API shape, whether it must be a *stable* heap, and whether
in-place mutation is acceptable under the domain's immutable-by-default style.

## Options considered

1. **Generic `BinaryHeap<T>` with an injected `less(a, b)` comparator** —
   `push`/`pop`/`size`/`entries()`; each consumer constructs it with its own
   comparator. Pros: one structure serves both the oid and the FIFO orders,
   encapsulates the backing array (removes the reachable `.shift()` corruption
   footgun), enables bisect convergence (ADR-466). Cons: needs an `entries()`
   view for the two frontier-scanning consumers; mechanical call-site churn.
   *(recommended)*
2. **Two named classes** (`CommitPriorityQueue` + `FifoCommitPriorityQueue`) —
   type-level split of the tie-break. Cons: duplicated heap body / a subclass
   split, two types to test, no gain over a comparator argument.
3. **Free-functions over a raw array** (heap sift in place on `QueueEntry<T>[]`)
   — smallest churn, frontier scans keep working verbatim. Cons: the exposed
   array stays `.shift()`/`.splice()`-able → the heap invariant is unprotected.

## Decision

- **API shape (user-ratified).** A generic `BinaryHeap<T>` lives in
  `src/domain/commit/`, parameterized by an injected `less(a, b): boolean`
  (`true` ⇒ `a` pops before `b`). It exposes `push`, `pop`, `size`, and an
  unsorted `entries()` view; it is an internal module (relative-import only, not
  re-exported through any public barrel). Consumers construct it with their
  comparator — `precedes` (`date desc, oid asc`) for the order-independent
  consumers, `(date desc, ins asc)` for bisect (ADR-466).
- **Non-stable heap (adopted-as-recommended, no user judgment).** The heap does
  not preserve insertion order among comparator-equal entries. This is faithful:
  the order-sensitive consumers each induce a *strict total order* on their
  enqueued set (oids are `seen`-unique; bisect's `ins` is unique and monotonic),
  so no ties arise and the pop sequence is byte-identical to the sorted array;
  `merge-base` alone re-enqueues equal-oid duplicates but its result is
  order-independent, so any tie resolution yields the same result. git's own
  `prio_queue` is likewise non-stable.
- **In-place mutation (adopted-as-recommended, no user judgment).** The heap
  mutates its backing array (sift swaps), fully encapsulated behind `push`/`pop`
  — the same containment the current `splice`/`shift` already rely on. This
  honours immutable-by-default at the object boundary while keeping the hot path
  allocation-free.

## Consequences

- **Behaviour-preserving.** Pop order is byte-identical for every consumer (the
  strict-total-order / result-independence proof is in the design doc), so all
  downstream SHAs, refs, reflogs, on-disk state, and outputs are unchanged. No
  `reports/api.json` change (the module stays internal).
- The two frontier-scanning consumers (`merge-base`'s `hasNonStale` `.some`,
  `commitDateWalk`→describe's `frontier` snapshot) retarget their set scans onto
  `entries()` rather than a raw array.
- Enables ADR-466: bisect converges onto this structure by passing its own
  comparator, with no second heap implementation.
- The sift comparisons are load-bearing and must be mutation-killed by the
  pop-order property + unit tests (no suppressions).
