---
subjects:
  - src/application/primitives/materialize-tree.ts
  - src/application/primitives/apply-changeset.ts
  - src/application/commands/internal/reset-worktree.ts
---
# 1081 — Reset modes reach the apply as two optional enums

- **Status:** accepted
- **Date:** 2026-10-25
- **Design:** docs/design/forced-checkout-displace-occupant.md (DC7, P8) · **Supersedes/Refines:** refines ADR-1077

## Context

The design pinned git 2.55's reset mode for each caller. The merge-family aborts and skips use
`reset --merge`. `rebase --abort`, `rebase --skip` and the rebase-merges `reset` step use a hard
reset that refuses to overwrite untracked occupants. `stash push` uses `reset --hard`. The apply
needs a way to receive these modes.

## Options considered

1. **Two optional, additive enums on `MaterializeTreeOpts` and `ApplyChangesetOpts`:**
   `untrackedOccupants: 'overwrite' | 'protect'` and `unmergedPaths: 'hidden' | 'reset'`. They sit
   beside ADR-1077's `ignoredOccupants`.
2. **One enum, `resetMode: 'merge' | 'protect-untracked'`.**
3. **Internal only:** a non-exported materialise entry, with public options unchanged.

## Decision

**Adopted as recommended (no user judgment): option 1.** It follows ADR-1077's pattern and the
project rule that commands are built from the primitives users get. Orthogonal enums compose with
`force` and `ignoredOccupants`, whereas a single mode would need one value per combination.

## Consequences

- `api.json` changes additively and is regenerated before push.
- `hardResetWorktreeToCommit` is replaced by helpers named by intent in `reset-worktree.ts`.
