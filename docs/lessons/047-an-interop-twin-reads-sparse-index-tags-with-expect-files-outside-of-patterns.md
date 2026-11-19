---
subjects:
  - test/integration/sequencer-sparse-cone-writes-interop.test.ts
phases: [planning, implementation, review]
kind: gotcha
trigger: an interop twin compares `git ls-files -t` output under a sparse checkout
evidence:
  - test/integration/sequencer-sparse-cone-writes-interop.test.ts
source: { run: sequencer-sparse-cone-writes, phase: review, date: 2026-11-19 }
status: active
supersedes: []
last-verified: 2026-11-19
---
# 047 — An interop twin reads sparse index tags with expectFilesOutsideOfPatterns

## Context

The sparse interop suite compared `git ls-files -t -s` between the git and tsgit twins. With
`sparse.expectFilesOutsideOfPatterns` at its default (false), git clears the skip-worktree bit of
every present file when it reads an index, so an `S` entry whose file is on disk read as `H` on
both sides. A `stash apply --index` row that left a dirty file `S` passed for that reason, and only
a reviewer's probe found it. Turning the setting on surfaced it, plus one refusal row where git
itself writes the cleared bit back.

## Lesson

Reading the index with stock git under sparse checkout rewrites what you are trying to compare.

## How to apply

Read twin index tags with `git -c sparse.expectFilesOutsideOfPatterns=true ls-files -t -s`.
Compare the disk listing as well as the tags.
Where git persists the cleared bit itself (a refused stash apply), override that row's reader and say why in a comment.

## Evidence

`test/integration/sequencer-sparse-cone-writes-interop.test.ts`: `tagged()`, and the `tagsOf`
override on the `stash-skipped-untracked-blocker` row.
