---
subjects:
  - src/application/commands/rm.ts
  - src/domain/git-index/resolve-undo.ts
---
# 1012 — rm records resolve-undo and runs during a pending merge, cherry-pick, revert or rebase

- **Status:** accepted
- **Date:** 2026-10-18
- **Design:** docs/design/cache-tree-write-path-perf.md · **Supersedes/Refines:** applies ADR-226; extends the resolve-undo recording of `add`

## Context

git `rm` of an unmerged path records its stages in `REUC` (`remove_index_entry_at` → `record_resolve_undo`, pins E2, E3), and runs during a pending merge. tsgit `rm` refused with `OPERATION_IN_PROGRESS` (pin T3), so it could never resolve a conflict.

## Options considered

1. Fold: drop the refusal for pending operations and record resolve-undo (recommended).
2. File both as follow-ups.

## Decision

**User-ratified — option 1** (fold).

## Consequences

- `rm` during a merge succeeds where it refused. Interop compares `REUC` bytes and `git ls-files --resolve-undo` with git's.
