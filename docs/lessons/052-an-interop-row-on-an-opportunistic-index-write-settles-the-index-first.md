---
subjects:
  - test/integration/sparse-gitlink-writers-interop.test.ts
  - test/integration/skip-worktree-present-files-fixtures.ts
phases: [review, validation]
kind: gotcha
trigger: an interop row compares the on-disk index after a git command that writes it only when an entry is racy or stale
evidence:
  - test/integration/sparse-gitlink-writers-interop.test.ts
  - test/integration/skip-worktree-present-files-fixtures.ts
source: { run: skip-worktree-present-files, phase: review, date: 2026-11-22 }
status: active
supersedes: []
last-verified: 2026-11-22
---
# 052 — An interop row on an opportunistic index write settles the index first

## Context

git persists a cleared skip-worktree bit only when the command writes the index for another
reason. `git add -A` writes it only if some entry is racily clean or stale. The `add -A` gap row
flaked on the git side alone (1 in 30, then 2 in 10): whether git rewrote the index depended on
whether the fixture's files shared the index's mtime second.

## Lesson

An on-disk index after an opportunistic write records the clock, not the command.

## How to apply

Before running git or tsgit on such a row, settle both repositories: refresh the index once
and wait past the racy window, so neither tool has a racy entry to rewrite.
Apply the settle only to the operations that write opportunistically, so the other rows still pin a real write.
Re-run a git-side flake 10+ times before blaming tsgit.

## Evidence

`test/integration/sparse-gitlink-writers-interop.test.ts` — `settleWhenOpportunistic` and its
comment; `test/integration/skip-worktree-present-files-fixtures.ts` — `settle`.
