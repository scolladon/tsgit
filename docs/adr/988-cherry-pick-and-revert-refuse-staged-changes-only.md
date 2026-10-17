---
subjects:
  - src/application/commands/internal/replay-sequence.ts
---
# 988 — Cherry-pick and revert refuse staged changes only

- **Status:** accepted
- **Date:** 2026-10-16
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-226

## Context

tsgit's cherry-pick and revert refuse any uncommitted change, staged or not (`WORKING_TREE_DIRTY`).
Pinned against git 2.55: an unrelated unstaged deletion lets both proceed (exit 0); a staged change
makes cherry-pick refuse with "your local changes would be overwritten by cherry-pick" (exit 128);
rebase refuses unstaged changes, which tsgit already matches. A lossy entry reads as an unstaged
deletion (ADR-973), so the gap blocks every cherry-pick in a repository holding one.

## Options considered

1. **Git's rule** — cherry-pick and revert require the index to match HEAD; the working tree is
   guarded only by the merge's would-overwrite check (recommended).
2. Exempt lossy entries from the clean-tree check for cherry-pick and revert only.
3. Leave the refusal and drop the cherry-pick/revert interop rows.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** A git-faithful fold of a pinned gap that
exists for UTF-8 paths too.

## Consequences

- Cherry-pick and revert proceed over unrelated unstaged changes, as git does.
- Rebase and pull keep their clean-tree check.
