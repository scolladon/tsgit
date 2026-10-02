---
subjects:
  - src/application/commands/internal/gc-pipeline.ts
---
# 936 — gc treats an unreadable reflog or worktree gitdir as absent, as git does

- **Status:** accepted
- **Date:** 2026-10-02
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-226

## Context

gc's reachability roots include every reflog entry and every linked worktree's HEAD and index.
git 2.55 ignores any failure to open a reflog (`files_for_each_reflog_ent` returns -1 and
`handle_one_reflog` discards it) and skips a linked worktree whose `gitdir` cannot be read
(`get_linked_worktree`). Live: with a reflog made unreadable (mode 000, or a directory in its
place), `git gc`, `git prune --expire=now` and `git repack -ad` exit 0 and prune a commit that
only that reflog named. tsgit's gc aborted instead (EACCES/EIO rethrown), and no ADR recorded the
divergence.

## Options considered

1. **Faithful: treat the unreadable reflog / gitdir as absent and prune as git does** (recommended).
2. **Keep aborting, record a divergence** — cons: gc refuses where git succeeds.
3. **Faithful plus a logger warning** — cons: extra signal git does not give.

## Decision

**User-ratified — option 1.** gc tolerates exactly the open failures git tolerates on these two
reads and continues as if the reflog or worktree were absent, pruning what only it named. This
transcribes git's binary, upstream data-loss hazard included: a reflog the process cannot read no
longer protects the commits it names.

## Consequences

- Interop rows pin the prune against git (unreadable reflog; unreadable worktree gitdir).
- Callers that want the protection must keep reflogs readable — the same contract git imposes.
