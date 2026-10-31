---
subjects:
  - src/application/primitives/ref-store.ts
  - src/repository/resolve-layout.ts
---
# 1137 — the ref walk skips an unreadable refs root as git does

- **Status:** accepted
- **Date:** 2026-10-31
- **Design:** docs/design/fsck-broken-ref-chain-unreadable.md · **Supersedes/Refines:** refines ADR-1131, ADR-1132 and ADR-1134

## Context

A review fix made the shared loose-ref walk rethrow `PERMISSION_DENIED` when a `refs` root itself
is unreadable, so a repository git refuses (`refs/` mode 000, detached HEAD) could not let gc
prune what its loose refs reach. Every opening route (explicit `gitDir`, discovery, a gitfile, a
linked worktree) now applies git's `is_git_directory` rule and refuses that repository first.
Probed on git 2.56.0, the rethrow then diverges where git carries on: `refs/` at mode 0300 passes
`is_git_directory`, the loose iterator skips it, and `git gc --prune=now` exits 0 and prunes what
only those refs reach; a linked worktree's own `worktrees/<id>/refs` at 000 is listed through by
`for-each-ref`, and `git fsck` exits 8 with `error opening directory`. The low-level
`createNodeContext` constructor runs no opening check.

## Options considered

1. **Rethrow only for the common `refs/` root** — pros: no silent prune on any route / cons: a
   refusal git does not have at mode 0300.
2. **Follow git everywhere: the walk skips an unreadable root as it skips any directory** — pros:
   git's listing, gc and fsck results on every shape git opens / cons: a `createNodeContext` caller
   on a repository git refuses reads an empty loose listing.
3. **Follow git and add the opening check to `createNodeContext`** — pros: faithful with no silent
   prune / cons: a new refusal and two probes on the low-level constructor.

## Decision

**Ratified by the user: option 2.** The walk skips a `PERMISSION_DENIED` directory at any depth,
its root included. Faithfulness rests on the opening routes, which refuse every repository git
refuses. `createNodeContext` stays a constructor that trusts its caller: it applies no
`is_git_directory` check, as before this change.

## Consequences

- At `refs/` mode 0300, tsgit lists, gc's and fsck's exactly as git does.
- A linked worktree's own unreadable `refs` root is listed through, as git does.
- A caller that builds a context with `createNodeContext` over a repository whose `refs/` is
  unreadable gets an empty loose listing; `openRepository` is the guarded entry point.
