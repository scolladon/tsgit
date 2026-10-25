---
subjects:
  - src/application/primitives/apply-changeset.ts
  - test/integration/merge-abort-interop.test.ts
phases: [validation]
kind: gotcha
trigger: a mutation kill test's expectation is a crash or a refusal
evidence:
  - src/application/primitives/apply-changeset.ts
  - test/integration/merge-abort-interop.test.ts
  - test/integration/sequencer-reset-interop.test.ts
source: { run: forced-checkout-displace-occupant, phase: validation, date: 2026-10-25 }
status: active
supersedes: []
last-verified: 2026-10-26
---
# 017 — A kill test never pins a crash git does not have

## Context

A triager killed a displacement mutant with a unit row: an unmerged `d/x` under
`unmergedPaths: 'reset'`, a regular file at `d`. The row asserted `NOT_A_DIRECTORY` and that
the file survived, which is today's tsgit behaviour. Pinned at the command level, git 2.55
`merge --abort` replaces the untracked file with the directory and restores `d/x`. The same
holds for cherry-pick and revert aborts, ignored files and symlinks alike. The kill test had
locked the divergence in.

## Lesson

A mutant kill proves only that a test distinguishes two behaviours, not that the kept one is
right. A crash or refusal chosen as the expectation is a claim about git and needs git's
answer.

## How to apply

Before committing a kill test whose expectation is an error, a refusal or a kept occupant,
reproduce the shape through the public command against git 2.55. Only pin it when git does the
same. When git differs, the mutant exposed a defect: fix the code and pin git's outcome in an
interop row.

## Evidence

`src/application/primitives/apply-changeset.ts` — `displaceFile`, which now removes the leading file unconditionally.
`test/integration/merge-abort-interop.test.ts` and `test/integration/sequencer-reset-interop.test.ts` — the nested-occupant rows.
