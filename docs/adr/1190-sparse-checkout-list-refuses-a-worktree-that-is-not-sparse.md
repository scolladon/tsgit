---
subjects:
  - src/application/commands/sparse-checkout.ts
---
# 1190 — sparse checkout list refuses a worktree that is not sparse

- **Status:** accepted
- **Date:** 2026-11-16
- **Design:** docs/design/sparse-checkout-worktree-config.md · **Supersedes/Refines:** refines ADR-071

## Context

git 2.56 `sparse-checkout list` on a worktree whose resolved `core.sparseCheckout` is off dies
with `fatal: this worktree is not sparse` (exit 128). `repo.sparseCheckout.list()` returned
`{ cone: false, patterns: [] }`. The change already edits `sparseCheckoutList` (it now resolves
the key through the worktree layer), so the refusal mismatch is in its perimeter, but the
faithful fix turns a returning public method into a throwing one.

## Options considered

1. **Ledger it** (recommended at triage) — pros: no consumer-visible break / cons: a pinned
   refusal mismatch stays open.
2. **Fold it** — `list()` refuses as git does / cons: a breaking change for callers that read an
   empty list as "not sparse".

## Decision

**ratified by the user** — option 2. `sparseCheckoutList` refuses when the resolved
`core.sparseCheckout` is off, with the shape `add` and `reapply` already use for the same git
condition: `INVALID_OPTION { option: 'action', reason: 'list requires sparse checkout to be
enabled' }`. No new error code. The commit is marked breaking.

## Consequences

### Negative

- Callers that called `list()` to find out whether sparse is on must catch the refusal.
- A `core.sparseCheckout = true` set only in the global config now refuses, where git lists with
  the warning `this worktree is not sparse (sparse-checkout file may not exist)`: tsgit resolves
  the key from the repository's local and worktree layers only, by design. It returned the empty
  list before, matching git by chance.

### Neutral

- `add`, `reapply` and `list` now refuse alike on a worktree that is not sparse.
