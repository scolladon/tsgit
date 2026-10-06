---
subjects:
  - src/domain/merge/three-way-tree.ts
  - src/application/commands/merge.ts
---
# 947 — Merge detects file and directory renames as git's ort does

- **Status:** accepted
- **Date:** 2026-10-06
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-945, ADR-226

## Context

git's default merge strategy, ort, detects renames between the merge base and each side before the
three-way merge (`merge-ort.c` `detect_and_process_renames`): a file renamed on one side and edited on
the other merges cleanly into the renamed path; rename/delete, rename/add and rename/rename
(1-to-2, 2-to-1) produce their own conflict shapes; directory-rename detection
(`merge.directoryRenames`, default `conflict`) moves new files into a renamed directory. tsgit's
three-way tree merge had no rename pass, so it reported modify/delete conflicts where git merges
cleanly — in `merge`, `pull`, `rebase`, `cherry-pick`, `revert`, `stash apply` and every other
caller of the merge core.

## Options considered

1. **File renames now**, directory renames to the backlog.
2. **File and directory renames now** — ort's full rename handling.
3. **Backlog** the whole feature and refuse `-X find-renames` / `no-renames` until it lands.

## Decision

**User-ratified — option 2.** The merge core detects renames as ort does, reusing tsgit's diff rename
detection (similarity scoring and pairing, `diff.renameLimit` / `merge.renameLimit`), and handles:
rename vs modify, rename/delete, rename/add, rename/rename 1-to-2 and 2-to-1, mode and content
changes across a rename, and directory renames with git's `merge.directoryRenames` modes (`true`,
`false`, `conflict`). `merge.renames` / `diff.renames` and `-X find-renames[=<n>]` / `-X no-renames`
control it as in git. Conflict index stages, working-tree files, `MERGE_MSG` conflict lines and
`AUTO_MERGE`-independent results match git's.

## Consequences

- Every merge-core caller changes behaviour where renames are involved (breaking where results
  differ — `!` commits); `reports/api.json` and docs updated when public result/conflict types grow.
- Interop rows compare merged trees, index stages, conflict paths and commit SHAs with git for each
  rename shape, through merge, rebase and cherry-pick.
- Performance: rename detection runs only when both sides add and delete paths, as in ort; a bench
  row joins `bench:ab`.
