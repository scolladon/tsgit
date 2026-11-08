---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/primitives/update-ref.ts
  - src/domain/refs/per-worktree-ref.ts
---
# 1166 — deletes and symbolic writes refuse every name git's refname_is_safe rejects

- **Status:** accepted
- **Date:** 2026-11-08
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1164

## Context

git's `transaction_refname_valid` (refs.c:1368) sends every update without a non-null new id
— a delete or a symbolic write — through `refname_is_safe` (refs.c:382), which rejects every
prefixed per-worktree name and any name outside `refs/` that is not a root ref, with `error:
refusing to update ref with bad name '<n>'`, exit 1. The design revision pinned it (W24–W30,
W34, W44, and W28 for `foo/bar`). tsgit at HEAD deletes through a prefix — `deleteRef
('worktrees/wt/HEAD')` from the main worktree removes `refs/heads/side` — writes symbolic refs
through a prefix, and deletes `foo/bar`.

## Options considered

1. **Gate deletes and symbolic writes with the whole of `refname_is_safe`, `foo/bar`
   included** — pros: the same git function and refusal path, one predicate / cons: a
   pre-existing accepted write (`deleteRef('foo/bar')`) becomes a refusal. The designer's
   recommendation.
2. **Gate only the prefixed names** — cons: splits one git predicate in two and leaves W28
   red.

## Decision

**Adopted-as-recommended (no user judgment) — basis DOCTRINE(D-2) and ADR-226, pinned by
W24–W30, W34, W44 and W28: option 1.** `updateRef` on a delete, `deleteRefs` and
`writeSymbolicRef` refuse with `INVALID_REF` any name `isRefnameSafe` rejects, before any
lock or write; a multi-name delete holding one unsafe name deletes nothing, as git's
transaction does. Every internal delete caller passes the same predicate.

## Consequences

- `deleteRef('foo/bar')` and the prefixed deletes refuse where they used to write; the wrong-ref
  deletes of W25 and W27 are gone.
- The predicate lives in the domain beside `parseWorktreeRef` and is reused by the write
  routes.
