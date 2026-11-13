---
subjects:
  - src/application/primitives/internal/repo-state.ts
---
# 1185 — the worktree sparse boolean check runs after the local gate

- **Status:** accepted
- **Date:** 2026-11-13
- **Design:** docs/design/sparse-checkout-worktree-config.md · **Supersedes/Refines:** refines ADR-850

## Context

With the extension on, git refuses every command on a sparse key in `config.worktree`
holding a value outside the boolean grammar (rows R10, R12), and names a bad local value
before a bad worktree one (O1, O2). The operational gate memoizes its verdict keyed on the
local file's mtime only.

## Options considered

1. **After `memoizeGateVerdict`, outside the memo**, kept fresh by `readSingleScope`'s
   stat (recommended) — pros: matches O1/O2, linked worktrees stay apart / cons: one extra
   stat per command when the extension is on.
2. **Inside `computeGateVerdict`** with the memo keyed on both files — cons: the
   per-session memo cannot tell linked worktrees apart; reworks ADR-850's key.
3. **In `loadSparseMatcher` only** — cons: `status` passes on R10, where git refuses.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-850 (the memo key stays local-only)
and ADR-182 (the scoped cache keys on gitDir). `assertOperationalRepository` and
`assertOperationalRepositorySettingsFirst` call `assertWorktreeSparseBooleansValid` after
the memoized verdict; it refuses with `CONFIG_BAD_BOOLEAN_VALUE` whose `source` names
`config.worktree`.

## Consequences

### Neutral

- A refused layout never reads the worktree file (ADR-679 holds).
