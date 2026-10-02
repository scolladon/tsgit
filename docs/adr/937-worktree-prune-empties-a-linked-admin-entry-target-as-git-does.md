---
subjects:
  - src/application/commands/internal/prune-worktrees.ts
---
# 937 — Worktree prune empties a linked admin entry's target, as git does

- **Status:** accepted
- **Date:** 2026-10-02
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-625 (write containment), ADR-226

## Context

gc's worktree-prune step removes a condemned `.git/worktrees/<id>`. When that entry is a symbolic
link to a directory, git 2.55 follows it (opening the directory through the link), deletes the target
directory's contents, then unlinks the link. Live: a link to an outside directory with no `gitdir`
file had that directory's contents wiped by a plain `git gc`. tsgit's node adapter refuses deletes
through a link (ADR-625's write guard), so tsgit only removed the link.

## Options considered

1. **Keep containment, record a divergence** — never delete outside the repository through a link.
2. **Copy git exactly: empty the target through the link, then remove the link.**
3. **Copy git only when the target resolves inside the repository.**

## Decision

**User-ratified — option 2.** The prune step empties a condemned linked entry's target directory
exactly as git does, then removes the link. This is a deliberate, narrowly scoped exception to
ADR-625's write guard: only this step, only for a `worktrees/<id>` entry git itself condemns, and
only the deletions git performs. The upstream hazard is transcribed: a `worktrees/<id>` link
pointing outside the repository lets gc delete data there.

## Consequences

- The delete goes through a capability scoped to the link's target, declared on the write-surface
  audit, and signed off by the security review.
- Interop rows pin the outcome against git (link to a live admin dir kept; dangling link kept;
  link to a file unlinked; link to a vanished worktree's admin dir: target emptied and link removed).
