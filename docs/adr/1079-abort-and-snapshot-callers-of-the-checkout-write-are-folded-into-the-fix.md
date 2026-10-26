---
subjects:
  - src/application/commands/internal/reset-worktree.ts
  - src/application/commands/abort-merge.ts
  - src/application/commands/internal/abort-sequencer-reset.ts
  - src/application/commands/rebase.ts
  - src/application/commands/internal/rebase-merges-steps.ts
  - src/application/commands/stash.ts
  - src/application/commands/merge.ts
---
# 1079 — The abort, snapshot and refusal-restore callers of the checkout write are fixed here too

- **Status:** accepted
- **Date:** 2026-10-25
- **Design:** docs/design/forced-checkout-displace-occupant.md (DC5, O1–O3) · **Supersedes/Refines:** refines ADR-226

## Context

The design-time probe of every caller of the changeset apply found three divergences outside the
apply itself:

- **O1:** `stash push` hashes a directory at a tracked path as a file and throws
  `PERMISSION_DENIED`.
- **O2:** `merge --abort` rewrites paths the merge never touched. git 2.55 keeps their occupants:
  re-pinned, an untracked file `d` stays where HEAD tracks `d/x`.
- **O3:** after a merge-strategy refusal, git restores HEAD over the occupant. tsgit leaves it.

ADR-1075 makes O2 worse. Every forced rewrite in `merge --abort` would displace the occupant, so
today's crash becomes deletion of an untracked file. The design recommended filing O2 as a backlog
row.

## Options considered

1. **File a backlog row and ship ADR-1075 as is.** This ships a new data-loss route.
2. **Fold O1–O3 into this change.** Each abort follows git's own reset mode, pinned per caller
   against git 2.55: `merge --abort` and the sequencer aborts, `rebase --abort` and the
   rebase-merges `reset` step. `stash push` reads the shape before hashing. The non-ff merge
   refusal restores as git does.
3. **Stopgap:** the aborts run the unforced untracked check first and refuse. This is a new
   divergence.

## Decision

**Option 2, by the user's standing rule, which deviates from the design's recommendation.** The
run brief says to probe every caller of the apply and fold each divergence found. The user's
global rule fixes a defect the change's own probes expose in the same run, and files nothing
without asking. Each caller's reset mode (`--merge`, `--hard`, or the sequencer's
untracked-protecting reset) is pinned against git 2.55 before it is designed. Nothing is inferred
from git's source alone.

## Consequences

- A fresh designer pass revises the design doc to cover O1–O3 before planning.
- The revision probes `merge --abort`, `cherry-pick --abort`, `revert --abort`, `rebase --abort`,
  the rebase-merges `reset` step, `stash push` and the non-ff merge refusal, on every occupant
  shape.
- No backlog row is filed for O1–O3.
