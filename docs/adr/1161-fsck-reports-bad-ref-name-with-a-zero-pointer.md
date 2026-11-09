---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/commands/internal/fsck/refs-verify.ts
---
# 1161 — fsck reports badRefName with a zero pointer

- **Status:** accepted
- **Date:** 2026-11-07
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1121

## Context

`files_fsck_refs_name` runs `check_refname_format` on the prefixed name of every non-root
entry and reports `badRefName: invalid refname format` as an error; the content check still
runs on the same file (Q9). The listing side then includes the broken name with the null oid,
so `snapshot_refs` adds `invalid sha1 pointer 0{40}` (bit 2) for the current view: a linked
`refs/bisect/a..b` gets the error from the main worktree (exit 8) and error plus pointer from
the linked one (exit 10, A24); the main `refs/heads/a..b` gets both (B1). tsgit reports
nothing on any of them. `branch` and `for-each-ref` additionally hide such a name with
`ignoring ref with broken name` (E1), which is a listing-consumer matter outside fsck.

## Options considered

1. **The content fact on the prefixed name with `isSafeRefName`, plus a zero pointer in fsck's
   snapshot for a listed name failing it** — pros: both halves fsck-local; A24, B1, Q9 green /
   cons: `isSafeRefName` also rejects the Unicode direction overrides, which git's
   `check_refname_format` may accept (unpinned). The designer's recommendation.
2. **The content fact only** — cons: A24 from the linked worktree and B1 stay at 8 where git
   gives 10.
3. **Leave it out** — cons: A24, B1 and Q9 stay red.

## Decision

**Adopted-as-recommended (no user judgment) — basis ADR-226, pinned by A24, B1 and Q9: option
1.** The walk pushes `{ ref, msgId: 'badRefName' }` before the body facts for a non-root entry
whose prefixed name fails `isSafeRefName`; `fsck.badRefName` grades it (default error).
`snapshotTargets` gives a listed name failing `isSafeRefName` the zero oid, so the current
view's pointer appears as git's does. Hiding broken names from `branch` and `for-each-ref`
(E1) stays out of this change.

## Consequences

- `docs/design/fsck.md`'s msg-id table marks `badRefName` as emitted.
- The direction-override difference between `isSafeRefName` and `check_refname_format` is a
  named risk; a pin on `refs/heads/a<U+202E>b` decides whether the predicate needs git's
  grammar.
