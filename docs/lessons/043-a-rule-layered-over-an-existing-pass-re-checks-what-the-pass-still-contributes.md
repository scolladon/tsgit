---
subjects:
  - src/application/primitives/materialize-tree.ts
phases: [review, validation]
kind: gotcha
trigger: a fix adds a mode-specific rule that runs beside an existing pass over the same inputs
evidence:
  - src/application/primitives/materialize-tree.ts
  - test/unit/application/primitives/materialize-tree.test.ts
source: { run: checkout-branch-on-unborn-head, phase: validation, date: 2026-11-17 }
status: active
supersedes: []
last-verified: 2026-11-17
---
# 043 — A rule layered over an existing pass re-checks what the pass still contributes

## Context

Review added a sparse file/directory rule (`sparseCollisions`) beside the non-sparse
displacement pass (`displacedByTarget`). Both took the same written target entries, with the
older pass narrowed to in-pattern targets through a filter. Mutation testing left the filter
and its predicate as survivors. Under sparse checkout, every key the old pass produced was
already in the new rule's `indexFiles`, which leave the index, so the old pass added nothing.
The fix runs the old pass only without sparse checkout and removes the filter.

## Lesson

When a new rule takes over a mode, the old pass beside it can become a no-op in that mode.
The leftover narrowing shows up as equivalent-looking survivors, not as a failing test.

## How to apply

When a fix adds a mode-specific rule next to an existing pass, compare the pass's outputs with
the new rule's in that mode. If the new rule's output covers them, skip the pass in that mode;
do not narrow it with a filter.

## Evidence

`resolveCarryCollisions` in `src/application/primitives/materialize-tree.ts` calls
`displacedByTarget` only when `opts.sparse` is undefined. The sparse rows of
`test/unit/application/primitives/materialize-tree.test.ts` still pass unchanged.
