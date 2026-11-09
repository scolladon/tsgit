---
subjects:
  - src/application/primitives/internal/linked-worktrees.ts
  - src/application/commands/internal/fsck/roots.ts
---
# 1157 — worktrees are enumerated in OS readdir order everywhere

- **Status:** accepted
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1150

## Context

git has one `get_worktrees`: the main worktree, then `.git/worktrees/*` in `readdir` order.
Which store dies first on a dying link (Q7, three runs) and the order of reflog findings
(R1/R2, two runs) follow that order. tsgit's `worktreeContexts` uses `ctx.fs.readdir`, which is
sorted (lesson 026), so the reflog pass reports `aa` before `zz` where git reports `zz` first.
The store walk needs the OS order; the question is whether the other `worktreeContexts`
callers (the reflog pass, the index pass, `rev-list`'s other-HEAD tips, the HEAD snapshot)
take it too.

## Options considered

1. **OS order in `linkedWorktreeAdmins`, inherited by every `worktreeContexts` caller** —
   pros: git's one order; one enumeration; R1/R2 fixed / cons: `rev-list`'s "first absent other
   HEAD dies" now follows OS order, which no row pins. The designer's recommendation.
2. **OS order for the store walk only; `worktreeContexts` stays sorted** — cons: keeps a
   proven wrong order (R1) and two enumerations.

## Decision

**Adopted-as-recommended (no user judgment) — basis ADR-226 and lesson 026, pinned by Q7, R1
and R2: option 1.** `linkedWorktreeAdmins` reads `.git/worktrees` with
`ctx.fs.readdirInOsOrder ?? ctx.fs.readdir`; `worktreeContexts` builds on it.

## Consequences

- The reflog pass, the index pass, the HEAD snapshot and `rev-list`'s other-HEAD tips follow
  the OS order.
- Order-dependent interop rows derive their expectation from git's output on the same
  directory (lesson 026), never from a hard-coded order.
