---
subjects:
  - src/application/commands/checkout.ts
---
# 1200 — A checkout that leaves HEAD unborn reports the null oid

- **Status:** accepted
- **Date:** 2026-11-17
- **Design:** docs/design/checkout-branch-on-unborn-head.md (D4) · **Supersedes/Refines:** none

## Context

`checkout({ createBranch })` on an unborn HEAD moves the symbolic ref and leaves HEAD unborn, so
there is no commit for `CheckoutResult.id` to name.

## Options considered

1. **`zeroOid(ctx.hashConfig)`** (recommended) — what `pathRestore` already reports for an unborn
   HEAD, and what git hands its hooks.
2. **Widen `id` to `ObjectId | undefined`** — breaks every reader of `id` for one row.

## Decision

**adopted-as-recommended (no user judgment)** — precedent: `pathRestore` reports the null oid for
an unborn HEAD; option 2 differs only by breaking readers.
