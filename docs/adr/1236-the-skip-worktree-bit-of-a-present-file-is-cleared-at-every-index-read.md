---
subjects:
  - src/application/primitives/read-index.ts
  - src/application/primitives/internal/clear-skip-worktree-from-present-files.ts
---
# 1236 — The skip-worktree bit of a present file is cleared at every index read

- **Status:** accepted
- **Date:** 2026-11-20
- **Design:** docs/design/skip-worktree-present-files.md (D-A, R2–R4) · **Supersedes/Refines:** applies ADR-226

## Context

git's `repo_read_index` runs `clear_skip_worktree_from_present_files`: with `core.sparseCheckout`
on and `sparse.expectFilesOutsideOfPatterns` false, every skip-worktree entry whose path `lstat`s
is read with the bit cleared (S1, S1b). tsgit's `readIndex` returns the bits as stored, so
`status` is clean and `stash apply` refuses where git reports and merges. `readIndex` caches its
parse keyed on the index file's stat, which a file appearing in the work tree does not change.

## Options considered

1. **Clear in `readIndex`, after the cache, on every call; `readIndexAt` stays a raw parse**
   (recommended) — one read path, as in git; the cache never covers the work tree.
2. A separate primitive each reading command opts into — every unlisted reader drifts.
3. Clear inside the cached parse — serves a stale bit once a file appears.

## Decision

Option 1. **adopted-as-recommended (no user judgment)** — ADR-226: git clears on its single read
path. `readIndex` returns a new `GitIndex` with only cleared entries replaced (the input object
when nothing clears); `readIndexAt` and the index lock's previous-index read stay raw, so a cleared
bit reaches disk only when a command writes the index, as in git.

## Consequences

### Positive

- `status`, `stash apply`, `checkout` and every other reader see a present file as git does.

### Negative

- Each `readIndex` call under sparse checkout pays one `lstat` per skip-worktree entry outside a
  known-missing directory (bounded per ADR-1243).
