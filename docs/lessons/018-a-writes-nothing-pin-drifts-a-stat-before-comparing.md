---
subjects:
  - src/application/commands/internal/refresh-index.ts
  - test/integration/stash-push-reset-interop.test.ts
phases: [design, review]
kind: gotcha
trigger: pinning that a git command refuses and writes nothing to the index
evidence:
  - src/application/commands/internal/refresh-index.ts
  - test/integration/stash-push-reset-interop.test.ts
source: { run: forced-checkout-same-commit, phase: review, date: 2026-10-26 }
status: active
supersedes: []
last-verified: 2026-10-29
---
# 018 — A "writes nothing" pin drifts a stat before comparing

## Context

The design pinned `git stash push` on an unmerged index as "exits 1 and writes nothing", from
an unchanged index hash. The fixture had settled the index first, so git's rewrite produced the
same bytes. A code reviewer then drifted the stat of a clean tracked file. git 2.55 still exits 1,
but it rewrites `.git/index` first: the inode changes and the clean entry takes the new mtime.
It also rewrites the index on "No local changes to save". The design was wrong, and so was the
code built from it.

## Lesson

On a settled index, an equal hash cannot tell "not written" from "rewritten with the same
content". git's refresh-then-write steps hide behind exactly that.

## How to apply

Before you pin that a git command writes nothing to the index, drift the stat of one clean
tracked entry (`touch -t`) in both peers.
Then compare that entry's cached stat (`ls-files --debug`) and the index file's inode, not only
the bytes.
Write the pinned row with the drifted entry, so a later refactor cannot settle it away.

## Evidence

- `test/integration/stash-push-reset-interop.test.ts`, the row "Given a merge left conflicted on f
  and a stat-drifted clean entry", compares the drifted entry's cached stat across both tools.
- `src/application/commands/internal/refresh-index.ts`, `refreshAndWriteIndex`: refresh, write
  unconditionally, then refuse.
