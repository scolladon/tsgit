---
subjects:
  - src/application/commands/branch.ts
  - src/application/commands/internal/checked-out-branches.ts
  - src/domain/worktree/error.ts
  - docs/use/commands/branch.md
---
# 1115 — `BRANCH_CHECKED_OUT` carries the kind of hold

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (F8, D-F8) · **Supersedes/Refines:** refines ADR-249

## Context

git 2.56's 7780bff ("branch: report active bisect run when rejecting delete") checks
`branch_bisecting()` before `branch_checked_out()` and words the refusal
`cannot delete branch '<b>' used by worktree at '<p>' for bisect`. The bisect lookup returns the
first registration in worktree order, where the checkout lookup keeps the last. Pinned on 2.56.0:
a linked worktree that started a bisect on the branch, and a main worktree bisecting it with HEAD
detached, both get the suffix; a plain checkout does not. tsgit's `branchCheckedOut(branch, path)`
carries no qualifier, so the interop row cannot rebuild the suffix.

## Options considered

1. **Add `hold: 'checkout' | 'bisect'` to `BRANCH_CHECKED_OUT`** — pros: one refusal family, one
   code, one qualifier / cons: a new required field on an existing error.
2. **A new code `BRANCH_BISECTING { branch, path }`** — pros: equally faithful / cons: one git
   refusal site split into two codes.

## Decision

**User-ratified: option 1.** `BRANCH_CHECKED_OUT` gains `hold: 'checkout' | 'bisect'`.
`branchDelete` checks the bisect hold first and reports the first worktree, in listing order,
whose bisect claims the branch; only then does it check the checkout hold. `heldBranches` and its
fetch caller are unchanged.

## Consequences

- The branch-delete interop row rebuilds ` for bisect` from `hold`, and a two-worktree row pins
  that the bisect path wins over a checkout of the same branch.
- Consumers that matched on `BRANCH_CHECKED_OUT` keep matching; the field is additive.
