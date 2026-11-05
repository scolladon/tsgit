---
subjects:
  - src/application/commands/merge.ts
---
# 1145 — merge maps a peel fault of its parent to "not something we can merge"

- **Status:** accepted
- **Date:** 2026-11-04
- **Design:** docs/design/rev-parse-corrupt-input.md · **Supersedes/Refines:** refines ADR-199

## Context

`merge` does not reach `resolveCommitIsh`: `resolveMergeParent` resolves through the rev-parse DWIM
(ADR-199) and peels with `peelChain`, which throws `INVALID_OBJECT_ID` or `OBJECT_NOT_FOUND` on a
corrupt tag. git refuses `merge: x - not something we can merge` with exit 1 and no `MERGE_HEAD`
(pinned twice on 2.56.0) — the refusal `resolveMergeParent` already gives a non-commit.

## Options considered

1. **Fold it: a read or peel fault of the chain becomes `refNotFound(name)`** — pros: same input, same
   behaviour, one function, pinned on both tools / cons: none found. The designer's recommendation.
2. **Leave merge out of the perimeter and report it as an impact** — cons: a pinned divergence on a
   route this change's fixtures already exercise.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** In `resolveMergeParent` a chain read or peel
fault (`OBJECT_NOT_FOUND`, `INVALID_OBJECT_ID`) refuses with `REF_NOT_FOUND { name }`, for the single
head and the octopus parents alike; `MERGE_HEAD` is never written.

## Consequences

- The merge interop rows pin the exit-1 class and the untouched state on every corrupt variant.
