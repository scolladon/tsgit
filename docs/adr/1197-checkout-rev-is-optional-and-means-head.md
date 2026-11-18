---
subjects:
  - src/application/commands/checkout.ts
---
# 1197 — checkout's `rev` is optional and an omitted one means HEAD

- **Status:** accepted
- **Date:** 2026-11-17
- **Design:** docs/design/checkout-branch-on-unborn-head.md (D1) · **Supersedes/Refines:** none

## Context

git's `checkout -b x` with no start point succeeds on an unborn HEAD: it rewrites `HEAD` as a
symbolic ref to `refs/heads/x` and touches nothing else. `CheckoutSwitchOptions.rev` was required,
so tsgit could not express that form, and `{}` refused with `INVALID_OPTION` where git's bare
`checkout` is a no-op.

## Options considered

1. **`rev?: string`** (recommended) — an omitted `rev` means HEAD, as in git's argv. `{}` stays on
   HEAD, `{ detach: true }` detaches at HEAD, `{ createBranch }` on a born HEAD creates at HEAD, and
   on an unborn HEAD it only rewrites the symbolic ref. The "either rev or paths" refusal goes.
2. **Discriminated variant** — only `{ createBranch }` may omit `rev`; `{}` and `{ detach: true }`
   stay type errors and keep a refusal git does not make.
3. **An `orphan` option** — git's `--orphan`, a wider feature no pinned row needs.

## Decision

**ratified by the user** — option 1. `isSwitch` becomes "not a path restore"; the `rev` + `paths`
refusal keeps its code and reason.
