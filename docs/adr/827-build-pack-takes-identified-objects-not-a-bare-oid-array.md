---
subjects:
  - src/application/primitives/build-pack.ts
---
# 827 — buildPack takes identified objects, not a bare oid array

- **Status:** accepted
- **Date:** 2026-09-07
- **Design:** docs/design/name-hash-delta-ordering.md (DC-2) · **Supersedes/Refines:** follows from ADR-769

## Context

`BuildPackInput` is `{ oids: ReadonlyArray<ObjectId>, delta?: boolean }`. Ordering by name hash
(ADR-826) needs a second per-object value, and the recency tiebreak needs a third. Both are
optional and both are produced by the caller, so the question is how they travel.

ADR-769 already deleted a positional contract on the *result* side, for the reason that
alignment held only by convention and hid a real reordering behind it. Adding two parallel
arrays to the input would reintroduce exactly the shape that record removed, on the other side
of the call.

## Options considered

1. **`nameHashes?: Uint32Array` aligned to `oids`, plus a second array for recency** — pros: 4 bytes an object, the typed-array slab shape ADR-790 chose for the result side; additive, no published type breaks / cons: reintroduces positional alignment as an unenforced invariant, and a second optional slab for recency makes three arrays the caller must keep in step.
2. **`paths?: ReadonlyArray<Uint8Array | undefined>`, packer hashes** — pros: mirrors git's `add_object_entry`, which hashes at insert / cons: keeps N path byte-arrays resident across the sort, paying the per-object path cost this design exists to avoid.
3. **`objects: ReadonlyArray<{ id, nameHash?, recency? }>` replacing `oids`** (chosen) — pros: one array; identity and its optional attributes travel together and cannot drift out of alignment; adding a third attribute later costs a field, not a fourth array / cons: breaks the published `BuildPackInput` and touches all five call sites.

## Decision

**User-ratified.** `BuildPackInput.oids` is replaced by
`objects: ReadonlyArray<{ id: ObjectId; nameHash?: number; recency?: number }>`. This is a
breaking change to a published type and ships as one.

`BuildPackResult.emissionOrder` keeps its meaning — emission ordinal to input index — and its
docblock is restated in terms of `objects` rather than `oids`.

## Consequences

The alignment invariant becomes unrepresentable rather than merely tested: there is no second
array to fall out of step with the first, so the class of bug where object *i* is given object
*j*'s hash cannot be written. This is the input-side counterpart of what ADR-769 did for the
result side, and it is why that record's reasoning is followed rather than worked around.

The cost is a breaking change to `BuildPackInput` and five call sites updated in one step. Every
caller that has neither a hash nor a recency writes `oids.map((id) => ({ id }))` and is otherwise
untouched, so the migration is mechanical for the callers that do not opt in.

Per-object memory rises by the object wrapper rather than by 4 bytes in a slab. On the gc path
the objects are already materialised by the reachability walk, so the wrapper is the walk's own
allocation rather than a new one; a caller that today holds only a flat oid array pays for the
wrappers it creates.
