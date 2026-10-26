---
subjects:
  - src/application/commands/merge.ts
  - test/integration/missing-value-refusal-interop.test.ts
  - test/integration/conflict-style-interop.test.ts
phases: [implementation]
kind: gotcha
trigger: a part changes a step every invocation of a command runs, such as a new pre-strategy step in merge
evidence:
  - src/application/commands/merge.ts
  - test/integration/missing-value-refusal-interop.test.ts
  - test/integration/conflict-style-interop.test.ts
  - test/integration/checkout-leading-symlink-interop.test.ts
source: { run: forced-checkout-displace-occupant, phase: implementation, date: 2026-10-25 }
status: active
supersedes: []
last-verified: 2026-10-26
---
# 015 — A shared command-path change runs the command's whole interop family

## Context

One part added git's pre-merge snapshot to every true merge. Its part gate ran the touched
files' tests, and they were green. The snapshot resolved the merge author eagerly and refused
`AUTHOR_UNCONFIGURED` on a clean tree. Three interop suites that never touch the snapshot
swallow the merge error and assert on the work tree, so they broke silently: 12 rows across
conflict-style, missing-value-refusal and leading-symlink. Only a later full run caught them,
and a bisect over `git archive` copies named the part. git's `stash create` falls back to the
identity `git stash <git@stash>` and never refuses.

## Lesson

A step that every invocation of a command runs is not covered by the touched files' tests. Its
blast radius is every suite that drives the command.

## How to apply

When a part adds or reorders a step that every call of a command runs, its gate also runs
`test/integration/<command>*` and every interop file that invokes the command (grep for the
command's facade call). Report the count. Any red row that passes on the parent commit belongs
to the part. Bisect with `git archive <sha>` copies, never by checking out commits in the
worktree.

## Evidence

`src/application/commands/merge.ts` — `snapshotBeforeStrategies` and its fallback identity.
`test/integration/missing-value-refusal-interop.test.ts`, `test/integration/conflict-style-interop.test.ts`,
`test/integration/checkout-leading-symlink-interop.test.ts` — the suites that went red.
