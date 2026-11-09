---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/commands/internal/fsck/types.ts
---
# 1153 — a refs root that is not a directory is refs-walk-failed with NOT_A_DIRECTORY

- **Status:** accepted
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1138

## Context

`files_fsck_refs_dir` begins a `dir_iterator` on `<store gitdir>/refs`. When that root is a
regular file or a symbolic link, the iterator fails with `error: cannot open directory <p>: Not
a directory` and the verify exits non-zero (bit 8), for a linked store (B6, P10) and for the
main store (S9) alike; the walk does not follow a symlinked root. tsgit's `isDirectoryPath`
gate follows the link and reports nothing, and the listing throws `NOT_A_DIRECTORY` from the
linked worktree. ADR-1138 already models a root that cannot be iterated as `refs-walk-failed`
with `reason: 'PERMISSION_DENIED'`.

## Options considered

1. **`refs-walk-failed` with `reason: 'NOT_A_DIRECTORY'`, no `unreadable-ref-path` before it**
   — pros: the same git outcome stays one arm; the reason discriminates the rendered line / cons:
   the `reason` union widens. The designer's recommendation.
2. **A new arm `refs-root-not-directory`** — cons: two arms for one outcome (the iteration over
   a root failed, bit 8).

## Decision

**Adopted-as-recommended (no user judgment) — basis ADR-1138 and no trade-off beyond
mechanics: option 1.** The store root is classified by `lstat`: absent (silent for a linked
store), not a directory (file or symlink: `refsWalkFailed` with `reason: 'NOT_A_DIRECTORY'`),
or a directory (today's walk). `refs-walk-failed.reason` becomes
`'PERMISSION_DENIED' | 'NOT_A_DIRECTORY'`; the interop renders the latter as git's
`cannot open directory <p>: Not a directory`.

## Consequences

- The listing treats a linked worktree's own namespace that is not a directory as absent
  instead of throwing.
- The main store's absent `refs` stays silent and unpinned, as before.
