---
subjects:
  - src/application/commands/sparse-checkout.ts
  - src/application/primitives/internal/enable-worktree-config.ts
supersedes:
  - adr: "074"
    scope: "sparse-checkout keys are persisted to the common config file"
---
# 1188 — sparse checkout writes its keys to the worktree config

- **Status:** accepted
- **Date:** 2026-11-13
- **Design:** docs/design/sparse-checkout-worktree-config.md · **Supersedes/Refines:** supersedes ADR-074 (the target file of the sparse keys)

## Context

ADR-074 persisted `core.sparseCheckout` / `core.sparseCheckoutCone` to `.git/config`.
git 2.56 writes them to `<gitDir>/config.worktree` after turning on
`extensions.worktreeConfig` (B1–B6), so tsgit's `set` in a linked worktree turns sparse
on for every worktree (L3) and tsgit's `disable` after a git `set` leaves git sparse
(W-dis). git's `add` and `reapply` write no config (A1, B7, B8), and `set` without a
mode keeps the current mode when sparse is on (S1, S2, S4).

## Decision

**adopted-as-recommended (no user judgment)** — ADR-226 (git faithfulness).

- `set` with a mode, or with sparse off, turns the worktree scope on (`extensions.worktreeConfig
  = true` in the common config; a local `core.worktree` moves to the main worktree's
  `<commonDir>/config.worktree`, even when run from a linked worktree), then writes
  `core.sparseCheckout = true` and `core.sparseCheckoutCone` to the current worktree's
  `<gitDir>/config.worktree`.
  Without a mode it keeps the resolved mode when sparse is on, else cone, and writes no
  config when sparse is already on.
- `disable` turns the worktree scope on and writes `core.sparseCheckout = false`,
  `core.sparseCheckoutCone = false` and `index.sparse = false` to `config.worktree`.
- `add` and `reapply` write no config.

Superseded from ADR-074: the sparse keys are written to `<commonDir>/config`.

Carried forward from ADR-074: the targeted line-surgery mechanism — a write changes only
the targeted keys and copies the rest of the file through untouched.

## Consequences

### Positive

- Sparse state is per worktree, as in git.

### Negative

- A repository tsgit makes sparse now carries `extensions.worktreeConfig`, which older
  tools that do not know the extension refuse — as they refuse a git-made one.
