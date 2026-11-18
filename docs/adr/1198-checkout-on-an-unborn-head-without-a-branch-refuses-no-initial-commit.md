---
subjects:
  - src/application/commands/checkout.ts
---
# 1198 — checkout on an unborn HEAD without a branch to create refuses `NO_INITIAL_COMMIT`

- **Status:** accepted
- **Date:** 2026-11-17
- **Design:** docs/design/checkout-branch-on-unborn-head.md (D2) · **Supersedes/Refines:** none

## Context

With `rev` optional (ADR-1197), `{}` and `{ detach: true }` on an unborn HEAD reach a state git
refuses with `fatal: You are on a branch yet to be born`. The refusal needs a code.

## Options considered

1. **Reuse `NO_INITIAL_COMMIT`** (recommended) — the existing member, without fields, that `stash`
   and the history rewriters already raise for an unborn HEAD.
2. **A new `CHECKOUT_UNBORN_HEAD` member** — a second name for the same condition.
3. **`INVALID_OPTION { option: 'rev' }`** — reports a valid option shape as invalid.

## Decision

**ratified by the user** — option 1, chosen together with ADR-1197. The refusal fires before any
index read or ref write.
