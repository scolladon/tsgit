---
subjects:
  - src/application/commands/add.ts
  - src/domain/git-index/directory-file-conflict.ts
---
# 990 — add applies git's directory/file replacement on every route

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** —

## Context

A tracked directory replaced by a symlink or regular file, then `add <it>`, leaves the entries beneath
it in tsgit's index next to the new entry. `git write-tree` refuses that index. The pinned matrix (design
§D1) shows the gap on the literal fast path and, through skip-worktree, exclusion and unmerged rows, on
the `addByPathspec` and `addAll` walks too. Routing the literal to the walk fixes the reported rows
but not git's silent drops (rows X3, X4).

## Options considered

1. Fix the fast path only.
2. Route such literals to `addByPathspec`.
3. One same-stage directory/file insertion rule on all three routes, plus reported removals on the fast
   path (recommended).

## Decision

**User-ratified — option 3** (the user accepted the design's recommendation set). Inserting a new stage-0
entry drops the same-stage entries beneath it without reporting them. A path that already holds a stage-0
entry is replaced in place with no check, as git does (rows C1, C2). The fast path also reports the
pathspec-matched entries now gone from disk, as git's tracked-path update pass does.

## Consequences

- Every pinned row matches git 2.55; the clean re-stage of a tracked file pays one branch.
- A first-time insertion pays one binary search over the prior index.
