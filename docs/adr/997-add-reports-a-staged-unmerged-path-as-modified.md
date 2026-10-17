---
subjects:
  - src/application/commands/add.ts
---
# 997 — add reports a staged unmerged path as modified

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** —

## Context

After a modify/delete conflict, `git add -v f` on an unchanged `f` prints `add 'f'` (pinned on git
2.55). tsgit stages the path but leaves it out of `modified` because its content equals the last stage,
so a caller reconstructing `add -v` from `AddResult` misses the line.

## Options considered

1. Report every staged unmerged path in `modified` (recommended).
2. Leave it out.

## Decision

**User-ratified — option 1.** A path whose prior entry is unmerged is reported in `modified` when staged,
whatever its content, on the fast path and the walks.

## Consequences

- `AddResult` reconstructs git's `add` lines for conflict resolution.
