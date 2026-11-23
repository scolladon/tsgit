---
subjects:
  - src/application/primitives/build-index-from-tree.ts
  - src/application/commands/reset.ts
---
# 1241 — reset --mixed keeps the read bit of an unchanged entry

- **Status:** accepted
- **Date:** 2026-11-20
- **Design:** docs/design/skip-worktree-present-files.md (D-F, R9) · **Supersedes/Refines:** applies DOCTRINE D-2

## Context

git's mixed reset carries the bit the index read held for an entry whose `(mode, id)` is
unchanged: a cleared present file stays `H` (R2), an absent one stays `S` (R2a), and a stored
`H` stays `H` (R2x). tsgit re-marks every entry from the patterns, which hides the file again.

## Options considered

1. **Carry the read bit for an unchanged `(mode, id)`, after pinning the changed- and new-entry
   shapes** (recommended).
2. Ledger it as a pre-existing `buildIndexFromTree` divergence.

## Decision

Option 1. **adopted-as-recommended (no user judgment)** — DOCTRINE D-2: the reset reader row stays
red without it, and R2x shows the primitive already diverges on main.

## Consequences

### Positive

- A reset never re-hides a present file git shows.
