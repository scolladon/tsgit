# 661 — The layout config read includes `config.worktree` under the extension

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (candidate D9)

## Context

Measured: with `extensions.worktreeConfig = true` (and `repositoryformatversion = 1`),
git honours **both** `core.bare` and `core.worktree` from `<gitDir>/config.worktree`
when deciding the layout — a shape `git worktree` itself produces. The layout read runs
before any Context exists, over the `LayoutProbe`, with includes disabled.

## Options considered

1. **Read `<commonDir>/config` plus `<gitDir>/config.worktree` when the extension is on
   (design recommendation)** — pros: matches git for a shape git creates; one
   conditional extra read of a file that usually does not exist / cons: none material.
2. **`<commonDir>/config` only** — a real divergence on worktree-config repositories.
3. **Reuse the command-tier `readConfig` via a provisional Context** — circular (the
   Context needs the layout the read produces) and couples `openRepository` failure
   modes to the per-Context cache.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Pinned by measurement
(ADR-226). Per-worktree scoping of every *other* config key stays as the
linked-worktree design left it.
