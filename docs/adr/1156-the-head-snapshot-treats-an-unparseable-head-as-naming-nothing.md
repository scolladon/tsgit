---
subjects:
  - src/application/commands/internal/fsck/roots.ts
---
# 1156 — the HEAD snapshot treats an unparseable HEAD as naming nothing

- **Status:** accepted
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1150

## Context

`snapshot_refs` resolves every worktree's HEAD with `refs_resolve_ref_unsafe`; a HEAD holding
`garbage` resolves to NULL and is skipped with no pointer, while the `refs verify` child
reports `worktrees/wt/HEAD: badRefContent: garbage` (A7) or `HEAD: badRefContent: garbage`
from a linked working directory (A8). tsgit's `headOf` tolerates only `isSkippedRefReadFault`;
`parseLooseRef` throws `INVALID_OBJECT_ID` on the body and fsck dies.

## Options considered

1. **`headOf` treats `INVALID_OBJECT_ID` as "names nothing"** — pros: local to fsck's snapshot;
   the content line comes from the store walk (ADR-1150) / cons: the catch names an error code.
   The designer's recommendation.
2. **The shared HEAD reader (`resolveHeadDirect` → `parseLooseRef`) throws a distinct
   `INVALID_REF` for an unparseable body** — cons: changes a reader on every HEAD route (gc
   retention, rev-list, …), none pinned for this.

## Decision

**Adopted-as-recommended (no user judgment) — no trade-off beyond mechanics: option 1.**
`headOf` returns `NO_HEAD` on `INVALID_OBJECT_ID` as it does on a skipped read fault; the
store walk reports the content finding on the store's HEAD name.

## Consequences

- fsck no longer throws on a garbage HEAD of any worktree (A7, A8).
- Other HEAD readers keep their behaviour.
