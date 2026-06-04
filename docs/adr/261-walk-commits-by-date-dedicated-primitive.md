# ADR-261: Date-ordered history walk is a dedicated `walkCommitsByDate` primitive

## Status

Proposed

## Context

The 23.4 read-model foundation needs an **all-parents, commit-date-ordered**
commit walk — "every reachable commit, newest committer-date first" — as the
Core that a converged `log` and the queued `shortlog`/`range-diff`/`whatchanged`/
`name-rev` commands project over. Today the only date-ordered ancestry walk is
buried inside `describe` (entangled with tag-candidate bookkeeping); the
general-purpose `walkCommits` primitive offers only a topological FIFO and a
first-parent FIFO.

`walkCommits` and a date walk are **structurally different traversals**:

- `walkCommits` enqueues bare parent **oids** and reads each commit **lazily, on
  pop**. That laziness is load-bearing: it lets `MAX_WALK_QUEUE_SIZE` guard
  against a cheap denial-of-service where an octopus commit lists thousands of
  *fake* parents — they flood the oid queue without a single read. A unit test
  exploits exactly this cheap-flood vector, asserting `INVALID_WALK_INPUT`.
- A date walk must know a commit's timestamp to place it in a priority queue, so
  it reads each commit **eagerly, at enqueue**, and carries the loaded `Commit`
  through the queue. A fake parent can never enter the date frontier — it fails
  to read first — so the cheap-flood vector does not exist, and a different
  bound applies (a `seen`-gated enqueue caps the frontier at the reachable-commit
  count, the same ceiling any reachability walk holds).

`walkCommits` even carries a breadcrumb inviting an in-place extension —
`pickNext(queue, _order)` is commented *"Order arg retained for future
heap-based scheduler."* So two homes are viable:

1. **Add `order: 'date'` to `walkCommits`.** One read-model entry point; reuses
   `validateOptions`/`fetchCommit`/abort/`until`/`shallow`; auto-surfaces through
   the existing `repo.primitives.walkCommits` binding. But it forces the eager
   date discipline to live beside the lazy FIFO discipline inside one function,
   and the two cannot share a queue (oid-lazy vs commit-eager); the result is a
   hard internal seam where the overflow guard applies to one branch but not the
   other.
2. **A dedicated `walkCommitsByDate` primitive** in its own module, leaving
   `walkCommits` untouched.

## Decision

Ship the date-ordered history walk as a **dedicated `walkCommitsByDate`
primitive** (option 2), a sibling of `walkCommits` rather than a third `order`
on it.

Three drivers settle the choice:

1. **The algorithm is not the same**, so isolating it makes the spec easier and
   safer to express through tests — each primitive's test suite pins one
   traversal, with a smaller, more targeted mutation surface than a branched
   function where mutants can hide in the seam between the two disciplines.
2. **Perf isolation** — a standalone primitive can be benchmarked and optimised
   (its eager-read priority-queue cost) without entangling `walkCommits`'s lazy
   FIFO hot path.
3. **Fusion stays open** — should the two ever prove safely unifiable, merging a
   well-tested standalone primitive into `walkCommits` later is a deliberate,
   test-backed step; the reverse (splitting a prematurely-merged branch) is
   harder and riskier.

- New module `src/application/primitives/walk-commits-by-date.ts`, bound at
  `repo.primitives.walkCommitsByDate` and re-exported from the primitives barrel.
- Its options are `from` / `until` / `shallow` / `ignoreMissing` / `verifyHash`
  (a dedicated `WalkCommitsByDateOptions` — no `order` field, since the order is
  the primitive's identity).
- It reuses the **shared** pieces that are genuinely common: the seed validators
  (`isEmptyFrom` / `exceedsMaxWalkSeeds` and their `INVALID_WALK_INPUT` reasons)
  and a **commit reader** extracted from `walkCommits` into a shared internal
  helper so the two walkers share one `readObject`-plus-`ignoreMissing`-plus-
  non-commit-skip implementation instead of duplicating it.
- It walks all parents in commit-date priority order via the shared
  `domain/commit/priority-queue.ts` (`enqueue` / `QueueEntry<Commit>` /
  `precedes`), making it the payload-carrying consumer ADR-259 anticipated when
  it created `domain/commit/` for "the queued commit-walk commands."

`walkCommits`'s observable behaviour is unchanged; only its private commit reader
is relocated to the shared helper it now co-owns. The now-vestigial
`pickNext(_order)` breadcrumb (the "future heap-based scheduler" landed in a
sibling, not in-place) is logged for the architecture pass, not removed here.

## Consequences

### Positive

- Clean separation of disciplines: the eager date-priority walk and the lazy
  FIFO walk each stay small, single-purpose, and independently testable; neither
  carries a dead branch or a guard that applies to "the other half."
- Tighter mutation surface: a divergent algorithm tested in isolation yields a
  smaller, more specific kill set than a branched function whose mutants can hide
  in the FIFO/date seam.
- Independent perf headroom: the date walk can be profiled and tuned without
  perturbing `walkCommits`'s lazy hot path.
- Reversible by construction: a standalone, well-tested primitive can be fused
  into `walkCommits` later if that proves safe — a deliberate test-backed move,
  unlike retro-splitting a prematurely-merged branch.
- The DoS contract is preserved verbatim: `walkCommits`'s oid-flood guard and its
  `INVALID_WALK_INPUT`-before-read semantics are untouched, while the date walk's
  frontier is bounded by its `seen`-gated enqueue (no fake parent can enter, so
  no numeric cap is needed — a cap line would be untestable without a
  reachable-commit count in the tens of thousands).
- Populates `domain/commit/` with the payload-carrying priority-queue consumer
  ADR-259 forecast, validating that home.
- Additive: `repo.primitives.walkCommitsByDate` is a new binding; no existing
  signature changes.

### Negative

- A second commit-walk primitive to learn beside `walkCommits` (mitigated: the
  two answer genuinely different questions — "topological/first-parent stream"
  vs "newest-commit-date-first reachable set").
- Some plumbing rhymes across the two walkers (`until` / `shallow` / abort
  checks). It is **not** byte-identical (oid-lazy vs commit-eager queues), so it
  is deliberately not over-factored; only the truly shared reader is extracted.

### Neutral

- New public surface is limited to the `walkCommitsByDate` binding + its options
  type; `reports/api.json` regenerates to include them.
- The deterministic tie-break (oid-ascending on equal committer dates) is
  inherited from the shared `precedes`; git's equal-date heap order is
  unspecified, so faithfulness goldens use strictly-decreasing dates and the
  tie-break is pinned by a unit test, not by parity.
- Unifying `describe`'s bespoke date walk onto this primitive is **not** done
  here — its candidate-reachability bookkeeping is entangled and rule-of-three is
  not met (this is the second general consumer); re-evaluated in the architecture
  pass and logged as a follow-up if it stays divergent.
