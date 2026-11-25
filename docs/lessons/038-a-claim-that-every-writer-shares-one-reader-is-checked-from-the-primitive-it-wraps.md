---
subjects:
  - src/application/commands/merge.ts
  - src/application/primitives/read-sparse-checkout.ts
  - src/application/primitives/materialize-tree.ts
phases: [design, planning]
kind: trap
trigger: a design scopes a fix to one shared function because "every consumer goes through it"
evidence:
  - src/application/commands/merge.ts
  - test/integration/sparse-checkout-worktree-config-interop.test.ts
  - test/unit/application/commands/merge.test.ts
source: { run: sparse-checkout-worktree-config, phase: implementation, date: 2026-11-13 }
status: active
supersedes: []
last-verified: 2026-11-25
---
# 038 — A claim that every writer shares one reader is checked from the primitive it wraps

## Context

The design for sparse keys in `config.worktree` listed every caller of `loadSparseMatcher` and
concluded that fixing that one reader fixed every writer. The plan's merge twins then stayed red
after the reader was fixed: fast-forward and clean three-way `merge` materialise through
`materializeTree` and never called `loadSparseMatcher` at all, so they ignored sparse even with
plain local config. git marks those paths `S` and leaves them off disk.

## Lesson

Listing a function's callers proves who uses it, not who should. The behaviour lives in the
primitive the function feeds (`materializeTree`'s `sparse` option); a caller of the primitive that
skips the function is invisible from the function's side.

## How to apply

When a design says "every consumer goes through X", list the callers of the primitive X feeds, not of X.
For each caller of the primitive that does not pass X's result, pin a twin row against git before the plan.
Write the gap into the design's consumer table, folded or deferred, never left out.

## Evidence

`src/application/commands/merge.ts` (`attemptNonConflictTree`) now passes the matcher; the
"fast-forward merge" and "three-way merge" rows in
`test/integration/sparse-checkout-worktree-config-interop.test.ts` and the "fast-forward merge
brings a change outside the pattern" row in `test/unit/application/commands/merge.test.ts` turn
red without it.
