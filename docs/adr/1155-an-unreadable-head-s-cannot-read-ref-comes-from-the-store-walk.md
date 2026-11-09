---
subjects:
  - src/application/commands/internal/fsck/refs-verify.ts
  - src/application/commands/internal/fsck/roots.ts
  - src/application/primitives/ref-store.ts
---
# 1155 — an unreadable HEAD's cannotReadRef comes from the store walk

- **Status:** accepted
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1122, ADR-1150

## Context

git prints one `cannot read ref file '<p>'` line for a HEAD at mode 000, and `git refs verify`
run alone prints the same line (P1, P2): it is the root-ref step of the store walk, not
`snapshot_refs`. The snapshot's `refs_resolve_ref_unsafe` returns NULL and the HEAD is skipped
silently. tsgit reports the line through the snapshot (`unreadableHeadFinding`), naming the
main HEAD `main-worktree/HEAD` from a linked working directory where git prints `HEAD`, and its
store walk reads only the own gitdir's root refs. Each store's root-ref check stops at its
first error-severity finding (P3, S10), so the line's source also decides which later root
refs of that store are reported.

## Options considered

1. **The store walk's root-ref step reports it; the snapshot's `UnreadableHead` is retired** —
   pros: git's source; the error ends that store's root check as git's does; P2's `ref`
   becomes `HEAD` / cons: `WorktreeHeadSnapshot.unreadable` goes. The designer's recommendation.
2. **Keep the snapshot as the source and skip `HEAD` in the root-ref walk** — cons: later root
   refs of that store would be reported where git stops.

## Decision

**Adopted-as-recommended (no user judgment) — basis ADR-226, pinned by P1, P2, P3 and S10:
option 1.** `rootRefFindings` runs per store from the store gitdir, in OS order, reporting
`cannotReadRef` for a refused file; `snapshotWorktreeHeads` stops collecting `unreadable` and
`unreadableHeadFinding` is removed. `collectContentNotices` ends each store's root check at
that store's first error, keyed on the finding's prefix.

## Consequences

- `UnreadableHead` and `WorktreeHeadSnapshot.unreadable` are removed (internal types).
- P2's `ref` is `HEAD` (ADR-1152).
