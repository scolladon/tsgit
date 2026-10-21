---
subjects:
  - src/application/primitives/internal/object-emit.ts
  - src/application/primitives/internal/closure-engine.ts
  - src/application/commands/internal/gc-pipeline.ts
---
# 1032 — A blob want is typed from its header, never its body

- **Status:** accepted
- **Date:** 2026-10-21
- **Design:** docs/design/gc-size-lying-loose-blob.md (G11, requirement 7, P6) · **Supersedes/Refines:** refines ADR-1027 (the gc task's refusal sites) and ADR-907 (which reads take the buffered tier)

## Context

The closure engine types every want — a ref tip, a tag target, an index entry gc retains — by
reading its whole body through the buffered tier (`resolveWant` → `resolveTagChain` →
`parseTypedObject` → `readObject`). A size-lying loose blob named by the borrower's index or by a
ref therefore refused `LOOSE_OBJECT_CORRUPT` at root resolution, even when only an alternate held
it and gc would never pack it. Pinned on git 2.55.0: for the same borrower `git gc` exits 0, for a
blob the index names and for a blob a ref names. git's `parse_object` types a blob want through
`oid_object_info`, the header alone, and without `--verify-objects` never inflates its body;
`--indexed-objects` adds index blobs to pending with no read at all. Where the liar is local, both
tools still refuse: git in `pack-objects`, tsgit in the pack build — the same outcome at a later
site. A blob reached only through a tree was already typed from the tree entry, unread.

## Options considered

1. **Type a blob want from its header alone in `resolveTagChain` and `resolveWant`; read content
   only for tags and commits** (recommended) — pros: git's `parse_object` shape, one mechanism for
   index entries and ref-named blobs, and the same change aligns `push` and `bundle create`, which
   peel wants through the same helper; a blob want pays two header probes instead of one full
   inflate / cons: a tree want keeps its read, so a corrupt tree want refuses where it did before.
2. **Pass index entries to the closure as typed blob tips with no read** (git's
   `add_index_objects_to_pending`) — pros: zero reads for index blobs / cons: a ref naming a blob
   still inflates it; a second request shape for one consumer.
3. **Keep reading; record the divergence** — cons: diverges from git on exit status and leaves a
   full inflate per index entry on every gc.

## Decision

**Adopted-as-recommended (no user judgment): option 1** — the git-faithful standing rule
(ADR-226). A want whose header says `blob` is typed `blob` and queued as a pending object without
its body being read; `OBJECT_NOT_FOUND` for a missing want and the typing-conflict refusal are
unchanged. Tags are still read to peel and commits to seed the walk.

## Consequences

gc, `push` and `bundle create` no longer inflate a blob want's body; a borrower whose index or
refs name a blob only an alternate holds gets git's exit 0 whatever that blob's header claims.
Pinned by closure unit rows (a size-lying blob want, a tag targeting it, an honest blob want
read-spied, a missing id) and by the alternates gc interop row.
