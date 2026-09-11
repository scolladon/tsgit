---
subjects:
  - src/application/primitives/walk-commits.ts
  - src/application/primitives/internal/closure-not-marks.ts
---
# 846 — The commit walk queues each pending id once and bounds distinct pending ids

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/closure-history-walks.md (D4, review finding) · **Supersedes/Refines:** refines the brief's exit criterion 3 ("the overflow refusal fires at the same frontier size")

## Context

Replacing the frontier's `shift()` drain with a head cursor removed the quadratic drain but made the
array retain every id ever enqueued until the walk ends. A parent is enqueued once per child that
names it, so the retained array grew with the history's parent EDGES, not its commits: a layered
history of 480 commits retained 25 260 slots (52×), and a hostile 100 000-commit history shaped the
same way would pin roughly a gigabyte where the `shift()` drain retained only the pending frontier.
The `MAX_WALK_QUEUE_SIZE` guard bounded the pending count only, and counted raw pushes — so a
history in which 260 commits each name the same 260 parents (67 600 references, 260 distinct
pending ids) was refused although nothing about it is large. git's `prio_queue` walks carry an
`ENQUEUED` flag: an id is in the queue at most once at a time.

## Options considered

1. **Compact the drained prefix** (the designer's recommendation) — pros: no observable change, no
   ADR; retention under twice the pending frontier / cons: duplicate pushes and pops stay; the bound
   keeps counting pushes rather than the frontier it names.
2. **Dedup at enqueue, git's ENQUEUED discipline** (chosen) — pros: retention is the distinct-commit
   count, no duplicate pops, and the bound counts what it names; git's own queue shape / cons: a
   deliberate change to a pinned refusal condition — histories that overflowed on repeated
   references now walk.
3. **Both** — cons: more code for no further bound; dedup alone is O(commits).

## Decision

**User-ratified.** Both frontier walks — `walkCommits` and the closure's not-side ancestry marker —
keep a set of pending ids: a parent already pending is not pushed again, the set entry is cleared on
pop, and `MAX_WALK_QUEUE_SIZE` bounds the number of DISTINCT pending ids. The refusal, its code and
its reason string are unchanged; only what it counts moves, and it moves toward the frontier it
always claimed to bound.

## Consequences

Retention is bounded by the history's commits (the `visited` set already held that order of
memory). A repeated enqueue of an id that is already pending is a no-op by construction, so the
former "a redundant header enqueue overflows where a single one would not" pin becomes an
equivalence; the row now pins that the distinct pending count stays under the bound. Histories
refused only because many children name the same parents now walk — pinned by a 260 × 260 layer
in both walks. The not-side marker additionally regains the loop-top abort check and the bound it
lost when it stopped delegating to `walkCommits`.

Together with the reworked merge-base paint, the graph-first marker and the chain-wide graph
verdict landed in the same review round, the pending sets push the `primitives` chunk 69 B past its
63 kB budget and the package tarball 1.7 kB past its 918 KiB cap; both move one step (64 kB,
920 KiB) as the house convention for genuine growth prescribes.
