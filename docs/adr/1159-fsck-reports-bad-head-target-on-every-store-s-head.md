---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/commands/internal/fsck/refs-verify.ts
  - src/domain/refs/symref-referent.ts
---
# 1159 — fsck reports badHeadTarget on every store's HEAD

- **Status:** accepted
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1121, ADR-1124

## Context

`refs_fsck_symref` strips the worktree prefix from the name and, when the bare name is `HEAD`
and the target does not start with `refs/heads/`, reports `badHeadTarget: HEAD points to
non-branch '<target>'` as an error (bit 8) and returns before the referent checks. A linked
HEAD holding `ref: refs/tags/x` (B3) and the main HEAD holding the same (C1) both get it;
tsgit reports nothing on either. The msg-id is catalogued in `src/domain/fsck/msg-ids.ts` but
never emitted. B3 is in this change's family; C1 is the same code line.

## Options considered

1. **Fold it: one fact in the walk, a grade, a shadow rule** — pros: the same line for every
   store's HEAD; one msg-id already catalogued / cons: two unit and three interop rows. The
   designer's recommendation.
2. **Leave it out** — cons: B3 and C1 stay red.

## Decision

**Adopted-as-recommended (no user judgment) — basis ADR-226, pinned by B3 and C1: option 1.**
A symbolic body on a store's `HEAD` whose referent is not under `refs/heads/` yields
`{ ref, msgId: 'badHeadTarget', referent }`, graded by `fsck.badHeadTarget` (default error).
When graded error it shadows that ref's `badReferentName` and `symrefTargetIsNotARef`, as
`refs_fsck_symref`'s early return does; this extends the `shadowed` rule of ADR-1124.

## Consequences

- A detached HEAD and a HEAD on a branch get no finding.
- `docs/design/fsck.md`'s msg-id table marks `badHeadTarget` as emitted.
