---
subjects:
  - src/application/commands/stash.ts
---
# 1095 — `stash push` has no pending-operation gate

- **Status:** accepted
- **Date:** 2026-10-26
- **Design:** docs/design/forced-checkout-same-commit.md (DC8, F15) · **Supersedes/Refines:** refines ADR-226

## Context

tsgit's `stash push` refuses `OPERATION_IN_PROGRESS` while `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` or
`REBASE_HEAD` stands. git has no such gate. git stashes, resets, and clears `MERGE_HEAD`, `CHERRY_PICK_HEAD` and
`REVERT_HEAD`, but keeps `REBASE_HEAD`. A real resolved merge (row M2) and planted markers (K rows) prove this. The
gate has shipped since #98 with no ADR.

## Options considered

1. **Drop the gate.**
2. **Keep it and warn-and-ask.**

## Decision

**Adopted as recommended (no user judgment): option 1.** It follows the standing rule to fold a proven gap in the same
function. One condition applies: before the gate is removed, the implementer pins one real resolved cherry-pick and
one real stopped rebase (`rebase-merge/` present) against git 2.55. If either pin disagrees with the K rows, the
change stops and the user is asked.

## Consequences

- An unmerged index is still refused by the opening step (ADR-1092). A conflicted merge stays refused.
- `stash push` works during any resolved pending operation, as it does in git.
