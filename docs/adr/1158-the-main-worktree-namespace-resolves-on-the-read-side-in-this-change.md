---
subjects:
  - src/application/primitives/resolve-ref.ts
  - src/application/primitives/ref-store.ts
  - src/application/commands/internal/fsck/refs-verify.ts
---
# 1158 — the main-worktree/ namespace resolves on the read side in this change

> **Superseded by [ADR-1164](1164-the-per-worktree-ref-namespace-routes-writes-to-the-store-the-name-selects.md)** for the write-side scope: the write routes no longer stay out "until pinned" — the run's impact triage pinned them on nine rows and the namespace now routes writes to the store the name selects. The read-side rule (`parse_worktree_ref` on reads, the shared lookup for a name that is not per-worktree) is carried forward.

- **Status:** superseded by ADR-1164
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-294

## Context

git's `parse_worktree_ref` maps `main-worktree/<name>` to the main worktree's store and
`worktrees/<id>/<name>` to that worktree's, for a per-worktree `<name>` only. `rev-parse`
resolves `main-worktree/HEAD`, `worktrees/wt/HEAD` and `worktrees/wt/refs/bisect/bad` from
both working directories and refuses `main-worktree/refs/heads/main`,
`worktrees/wt/refs/heads/side` and `worktrees/nope/HEAD` (B14). A symref whose target is
`main-worktree/HEAD` gets `symrefTargetIsNotARef` only, exit 0 (A25, B8). tsgit's resolver has
no such namespace: `worktrees/wt/…` resolves only because the loose path exists on disk, and
`main-worktree/HEAD` throws `OBJECT_NOT_FOUND`, so fsck adds `badRefOid` and exits 2. The
backlog lists this as 32.49, next in the same release-order row.

## Options considered

1. **Keep it separate, next in the row** — pros: its locus is the shared resolver, reaching
   `rev-parse`, `log`, symref chains and the write routes, each needing its own pins; this
   change shares no code with it / cons: A25, B8 and C3 stay red one more cut. The designer's
   recommendation.
2. **Fold the read side** — `resolveDirect` (and the HEAD reader behind it) maps
   `main-worktree/<per-worktree name>` to the main store and `worktrees/<id>/<per-worktree
   name>` to that store, with the A25, B8, B14 and C3 interop rows; write routes stay as they
   are — pros: the row ships whole for readers / cons: the write side stays unpinned.

## Decision

**Ratified by the user against the designer's recommendation: option 2.** The read-side
resolver takes git's `parse_worktree_ref` rule: `main-worktree/<name>` and
`worktrees/<id>/<name>` resolve against that worktree's store when `<name>` is a per-worktree
name (a root ref or `refs/bisect/`, `refs/worktree/`, `refs/rewritten/`), and are looked up as
ordinary shared names otherwise, so `worktrees/wt/refs/heads/side` and `worktrees/nope/HEAD`
stay unresolved as git's do. The write routes are out of this change and keep their pins to
make.

## Consequences

- fsck on `ref: main-worktree/HEAD` reports `symrefTargetIsNotARef` only, exit 0 (A25, B8);
  `revParse('main-worktree/HEAD')` resolves (C3).
- The design gains a resolver part and its interop rows; the backlog row 32.49 is ticked with
  this change.
- Writes through `main-worktree/…` stay unpinned and unsupported until pinned.
