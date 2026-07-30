# 540 — `worktree.list` derives the main entry from the common dir

- **Status:** accepted
- **Date:** 2026-07-29
- **Design:** docs/design/linked-worktree-discovery.md · **Supersedes/Refines:** refines ADR-296 (worktree verbs)

## Context

`git worktree list --porcelain` always reports the main worktree first, with the main
worktree's own path — even when invoked from a linked worktree. tsgit's
`list-worktrees` uses `ctx.layout.workDir` for the main entry, which is wrong the
moment a linked worktree's Context can exist (its `workDir` is the linked worktree).

## Options considered

1. **Always derive the main path from `commonDir` (strip a trailing `/.git`; no strip ⇒ the gitdir path itself)** (recommended) — pros: provable no-op for every existing shape (normal `/r/.git` → `/r` = `workDir`; bare `bare.git` unchanged); correct from linked worktrees / cons: none.
2. **Keep `ctx.layout.workDir`** — pros: status quo / cons: wrong main entry from any linked worktree.
3. **Derive only when `commonDir !== gitDir`** — pros: none over 1 / cons: behaviourally identical to 1 with an extra branch to test and mutate.

## Decision

**Adopted-as-recommended (no user judgment).** Option 1: the main entry's path is always
derived from the common dir per the pinned rule (design §1h); the `main` flag follows
the derivation.

## Consequences

`worktree.list` from inside a linked worktree matches `git worktree list --porcelain`;
existing shapes are byte-identical. Interop scenario I pins it.
