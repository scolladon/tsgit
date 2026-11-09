---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/primitives/internal/linked-worktrees.ts
  - src/application/commands/internal/fsck/refs-verify.ts
---
# 1150 — fsck's ref-content pass walks every worktree's ref store

- **Status:** accepted
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-294, ADR-1137, ADR-1138

## Context

git 2.56's `refs verify` child (`cmd_refs_verify`) loops `get_worktrees_without_reading_head`
and runs `refs_fsck` on each worktree's ref store from any working directory: the main store
first, then every `.git/worktrees/<id>` whose `gitdir` file reads as non-empty. Each store's
`refs` directory is walked in full, whatever the namespace, then its root refs. tsgit's
`verifyIntegrity` walks only the current worktree's view (`[common refs/, own refs/]`) and
reads each body by name through `perWorktreeRefDir`, so another worktree's garbage is never
seen from the main worktree (A1–A4, A16, A20), the main worktree's per-worktree refs are
invisible from a linked one (A5), and a name met under one root is read from the other (A20,
C4).

## Options considered

1. **Every store from any cwd, through a light `linkedWorktreeAdmins` primitive** (id, admin
   dir, OS order, `gitdir` skip rule) that `worktreeContexts` also builds on — pros: git's
   walk, one enumeration, no Context minted per store / cons: a new primitive. The designer's
   recommendation.
2. **Every store through `worktreeContexts`' derived Contexts and `getRefStore(worktreeCtx)`**
   — cons: strips the walked store's gitdir from link referents where git strips the cwd's
   (A1 from the main worktree would turn into an error), mints a Context per store, pulls a
   command-layer helper into primitives.
3. **The current worktree only, prefix added** — cons: stays red on A1, A2, A16, A20 and C4.

## Decision

**Adopted-as-recommended (no user judgment) — basis ADR-226 (the prime directive), pinned by
A1, A2, A16, A20 and C4: option 1.** `verifyIntegrity` walks the main store, then every linked
admin directory `get_linked_worktree` accepts, in that order. Each store gets its `refs` root
walked in full and its root refs read from the store gitdir; packed refs keep the main-only
handling. Every body, `cannotReadRef` path and `lstat` is taken at the walked path, never
re-derived from the name. A linked worktree is skipped when its `gitdir` file is missing,
unreadable or empty, the current one included (pin J).

## Consequences

- Findings of another worktree's store appear from any working directory, with git's exit
  bits.
- The current linked worktree's own store is walked as a linked store, so its names follow
  ADR-1152.
- One more `readdir` of `.git/worktrees` and one `gitdir` read per entry on every fsck.
