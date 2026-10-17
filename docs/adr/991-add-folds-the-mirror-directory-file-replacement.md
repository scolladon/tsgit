---
subjects:
  - src/application/commands/add.ts
  - src/domain/git-index/directory-file-conflict.ts
---
# 991 — add folds the mirror directory/file replacement

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** —

## Context

The mirror case — a tracked file or symlink `a` replaced by a directory holding `a/b` — corrupts the
index the same way on every add route, `add -A` included (design rows M1–M6). It is the other half of
the same git insertion check, outside the backlog item's wording.

## Options considered

1. Fold it into this change (recommended).
2. Leave it out with a backlog entry.

## Decision

**User-ratified — option 1.** Inserting `a/b` drops the stage-0 entry at each leading directory
(`a`, `a/x`) silently; a directory on disk at a tracked non-gitlink path reads as deleted on the walk
paths, so `add a`, `add .` and `add -A` report `a` as removed. Other stages at the leading
directory survive (row M5).

## Consequences

- Both directions of git's directory/file check ship together; about +30 % of the change.
