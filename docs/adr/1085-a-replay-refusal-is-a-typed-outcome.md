---
subjects:
  - src/application/commands/rebase.ts
  - src/application/commands/internal/rebase-merges-steps.ts
  - src/application/commands/internal/reset-worktree.ts
---
# 1085 — A replay refusal is a typed outcome

- **Status:** accepted
- **Date:** 2026-10-25
- **Design:** docs/design/forced-checkout-displace-occupant.md (DC12, P11) · **Supersedes/Refines:** refines ADR-1084

## Context

A commit-verb line's refusal must reach the replay loop, which writes the reschedule. Today the
merge throws `WORKING_TREE_DIRTY` from `mergeIntoLockedIndex`.

## Options considered

1. **A guard around each line's replay** that catches only `WORKING_TREE_DIRTY`, writes the
   reschedule and rethrows. One site per loop; it relies on nothing else in the line raising that
   code.
2. **A typed `{ kind: 'refused', localChanges, untracked }` outcome** threaded through
   `MergeTreesOutcome`, `ReplayOutcome`, `Produced`, `Step`, the meld member's outcome and the
   checkout helper used for a fast-forward pick.

## Decision

**Option 2, by the user's guardrail "types over runtime checks", which deviates from the design's
recommendation.** In option 1, correctness rests on which code an exception carries, and the
compiler cannot check that. In option 2, the compiler makes every loop and verb handle the refusal.
The public `rebase` command still throws the same `WORKING_TREE_DIRTY` refusal with the same data
once the reschedule is written.

## Consequences

- Five unions widen, and the fast-forward helper gets a second return shape for the rebase callers.
- The size cost is accepted. The caps are re-measured after review.
