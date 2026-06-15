# ADR-344: Discriminate the would-overwrite refusal by class

## Status

Accepted

- **Date:** 2026-06-15
- **Design:** [design/merge-tracked-dirty-conflict-refusal.md](../design/merge-tracked-dirty-conflict-refusal.md)

## Context

git emits two textually distinct would-overwrite refusals, both exit 2:
**local-changes** (`error: Your local changes to the following files would be
overwritten by merge:` + `Please commit your changes or stash them before you
merge.`) and **untracked** (`error: The following untracked working tree files
would be overwritten by merge:` + `Please move or remove them before you merge.`).
tsgit collapses both into a single `WORKING_TREE_DIRTY { paths }` code. The design
pinned **ORD1**: when a tracked-dirty path and a non-overlapping untracked squat are
both present, git prints **both blocks** in one stderr. Per ADR-249 the library
emits structured data, not the rendered prose, but the structured shape must let a
consumer reconstruct what git printed.

The designer recommended keeping the single `WORKING_TREE_DIRTY { paths }` code
(the consumer re-derives tracked-ness). The user chose to **discriminate** so a
consumer can render git's two blocks without re-deriving — which then makes the
*form* of the discriminator load-bearing.

## Options considered

1. **(chosen) Split the refusal into two path arrays** —
   `WORKING_TREE_DIRTY { localChanges: ReadonlyArray<FilePath>, untracked: ReadonlyArray<FilePath> }`.
   Pros: faithfully represents ORD1 (both non-empty in one refusal) and lets a
   consumer render git's two blocks in order. Cons: changes the established error
   shape; ripples to the clean-path mapper and the apply consumers.
2. **Add a `reason: 'local-changes' | 'untracked'` enum to the existing flat
   `{ paths }`** *(the form the designer's discriminate-option named first)* —
   *rejected*: a single per-error `reason` **cannot represent ORD1**, where one
   refusal carries both classes at once. Choosing it would force a divergence from
   git's dual-block output — disallowed without an explicit faithfulness ADR.
3. **Keep the single `WORKING_TREE_DIRTY { paths }`** *(design recommendation)* —
   the consumer re-derives tracked-ness by stat-ing each path. Pros: zero contract
   change. Cons: the user wants the library to carry the classification it already
   computed; pushes re-derivation onto every consumer.

## Decision

`WORKING_TREE_DIRTY` carries two class-keyed path arrays:
`{ localChanges: ReadonlyArray<FilePath>, untracked: ReadonlyArray<FilePath> }`.
A refusal is raised when either is non-empty. Each array is sorted ascending
([ADR-345](345-sort-would-overwrite-paths-local-changes-first.md)); `localChanges`
is the block git prints first. This shape is the faithful realization of the user's
discriminate choice because it is the only one that represents ORD1 (both blocks in
one refusal) without diverging from git.

## Consequences

### Positive

- A consumer can reconstruct git's exact stderr — both blocks, in order — straight
  from the structured fields, with no re-stat of the working tree.
- ORD1 (dual-block) and ORD2 (overlap short-circuit to local-changes) are both
  representable.

### Negative

- The `WORKING_TREE_DIRTY` shape changes from `{ paths }` to
  `{ localChanges, untracked }`. Ripple, all in-scope for this change:
  - the `workingTreeDirty()` constructor signature;
  - the clean / fast-forward mapper `asMergeDirtyError`
    (`CHECKOUT_OVERWRITE_DIRTY` → `WORKING_TREE_DIRTY`) must route into the correct
    class bucket — the design re-pins which class checkout's dirty refusal carries;
  - the apply consumers' `would-overwrite` → `workingTreeDirty(...)` mappings;
  - the structured-error renderer in `domain/error.ts`.
- All existing `WORKING_TREE_DIRTY` assertions (clean-path tests
  `merge.test.ts:375`/`:417`, apply/stash tests) update to the two-array shape and
  must stay green.

### Neutral

- Exit semantics are unchanged (both classes are exit 2); only the structured
  payload gains the classification the library already computes internally.
