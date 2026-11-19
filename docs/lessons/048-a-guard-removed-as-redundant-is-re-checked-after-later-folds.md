---
subjects:
  - src/application/commands/mv.ts
phases: [review, implementation]
kind: gotcha
trigger: a review fix removes a guard as redundant while other folds are still landing on the same function
evidence:
  - src/application/commands/mv.ts
  - test/unit/application/commands/mv.test.ts
source: { run: mv-directory-one-rename, phase: review, date: 2026-11-19 }
status: active
supersedes: []
last-verified: 2026-11-19
---
# 048 — A guard removed as redundant is re-checked after later folds

## Context

Review cycle 1 removed the `item.kind !== 'directory'` operand from `removeAbandonedSources`:
a skipped file kept its index entry, so it could never classify as untracked. Cycle 2 then folded
git's index replacement rule into `applyToIndex`, which can drop a skipped file's entry when
another move's target lands beneath it. The removed operand was load-bearing again: the cleanup
ran `rmRecursive` on a file, threw `NOT_A_DIRECTORY` after the work tree had moved and before the
index was committed. Only the security reviewer's git-parity probe caught it.

## Lesson

"Redundant" is a claim about the premises at one commit; a later fold on the same function can
revoke them.

## How to apply

When a guard is removed as redundant, write its premise in the comment that replaces it.
After every later fold on the same function, re-read those premises against the new code.
Keep a test that drives the premise's failure case, so a revoked premise turns a test red.

## Evidence

`src/application/commands/mv.ts`: `removeAbandonedSources` and its comment;
`test/unit/application/commands/mv.test.ts`: the "skipped file whose index entry another move
replaces" row.
