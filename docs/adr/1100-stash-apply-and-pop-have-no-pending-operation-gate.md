---
subjects:
  - src/application/commands/stash.ts
---
# 1100 — `stash apply` and `pop` have no pending-operation gate

- **Status:** accepted
- **Date:** 2026-10-27
- **Design:** docs/design/stash-apply-dir-file-replacement.md (DC5, F11) · **Supersedes/Refines:** refines ADR-226, ADR-1095

## Context

tsgit's `stash apply` and `pop` refuse `OPERATION_IN_PROGRESS` while `MERGE_HEAD`, `CHERRY_PICK_HEAD`,
`REVERT_HEAD` or `REBASE_HEAD` stands. git has no such gate: it applies the stash and keeps every marker (A.5 P1,
a real resolved merge; P2–P5, planted markers). A conflicted merge is still refused, by the opening refresh step
that ADR-1092 added to push and this change adds to apply (`MERGE_HAS_CONFLICTS`, A.5 U1). ADR-1095 removed the
same gate from `stash push` under the fold rule, with a pin condition; the gate shipped since #98 with no ADR.

## Options considered

1. **Drop the gate** (designer's recommendation) — pros: git's behaviour; same function this change edits; the
   twin of ADR-1095 / cons: removes a refusal shipped since #98; a caller relying on it loses a guard.
2. **Keep it after the refresh, report an impact** — pros: the guard stays / cons: a proven gap on the edited
   function deferred against the fold rule; a resolved merge cannot take a stash as git allows.

## Decision

**Adopted as recommended (no user judgment): option 1.** It follows ADR-226 and the rule ADR-1095 already applied
to the push twin. The same condition applies: before the gate is removed, the implementer pins one real resolved
cherry-pick and one real stopped rebase (`rebase-merge/` present) against git 2.55. If either pin disagrees with
the planted-marker rows, the change stops and the user is asked.

## Consequences

- An unmerged index is refused by the opening refresh (`MERGE_HAS_CONFLICTS`), as in git.
- `stash apply` and `pop` work during any resolved pending operation and keep its markers, as in git.
- `assertNoPendingOperation` loses its last stash caller; its other callers are unchanged.
