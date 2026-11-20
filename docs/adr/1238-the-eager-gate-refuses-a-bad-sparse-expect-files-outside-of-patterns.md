---
subjects:
  - src/application/primitives/internal/repo-state.ts
  - src/application/primitives/read-sparse-config.ts
---
<!-- cspell:ignore expectfilesoutsideofpatterns -->
# 1238 — The eager gate refuses a bad sparse.expectFilesOutsideOfPatterns

- **Status:** accepted
- **Date:** 2026-11-20
- **Design:** docs/design/skip-worktree-present-files.md (D-C, R1, R10) · **Supersedes/Refines:** refines ADR-1233, applies DOCTRINE D-3

## Context

git parses `sparse.expectFilesOutsideOfPatterns` for every command: a non-boolean value in local
config or in an active `config.worktree` dies with `fatal: bad boolean config value 'bogus' for
'sparse.expectfilesoutsideofpatterns'`, exit 128, even with sparse checkout off (E3, E3b, O3). The
first bad key in file order is named (O1, O2). This change starts reading the key from both files.

## Options considered

1. **Gate the key in local and the active worktree file, ordered by line against the `[core]`
   keys; breaking `!`** (recommended).
2. Gate local only and ledger the worktree case.
3. Ledger both and read a bad value as `false`.

## Decision

Option 1. **adopted-as-recommended (no user judgment)** — DOCTRINE D-3, same shape as ADR-1233:
the change reads the key, so a value it cannot parse refuses where git does, with
`CONFIG_BAD_BOOLEAN_VALUE`.

## Consequences

### Negative

- Every operational command throws on a value it used to ignore, as git does — a breaking change.
