---
subjects:
  - src/application/primitives/build-pack.ts
  - src/domain/storage/delta-policy.ts
---
# 832 — Mixed recency presence in one pack input is refused

- **Status:** accepted
- **Date:** 2026-09-07
- **Design:** docs/design/name-hash-delta-ordering.md (DC-7) · **Supersedes/Refines:** refines ADR-826

## Context

ADR-826 defines a recency-present mode and a recency-absent mode. It does not say what an input
where *some* objects carry a recency does, and that is not hypothetical: gc's promisor pack mixes
reachable members, which have a traversal ordinal, with unreachable ones, which do not.

A comparator that skips the recency compare when either side lacks one is **not transitive**.
With `A(recency 1, oid z)`, `B(recency 2, oid a)` and `C(no recency, oid m)`: `A < B` by recency,
`B < C` by oid, and `C < A` by oid — a cycle. A comparator with a cycle makes `Array.prototype.sort`
undefined, so the mixed state cannot simply be tolerated.

Git has no analogue of the mixed state. Every `object_entry` has an address, so every object has
an ordinal, and unreachable objects are appended to the packing list after the traversal — giving
them higher addresses and sorting them last under `type_size_sort`'s final key.

## Options considered

1. **Refuse a mixed input** (chosen) — pros: the mixed state becomes unrepresentable rather than merely handled, so the non-transitive comparator cannot be written; keeps ADR-826's two modes literally two; restores an input-shape refusal with named data, which the move to `objects` removed along with the slab-length check / cons: gc must synthesise ordinals for unreachable promisor members.
2. **Absent sorts last, via a sentinel** — pros: no guard, slightly less code, and gc's output bytes are identical to option 1 because unreachable members land after every reachable one in oid order either way / cons: keeps a state git does not have, adds an implicit third mode every ordering test must name, and leaves non-transitivity as something a sentinel prevents rather than something that cannot arise.
3. **Absent sorts first** — cons: git appends unreachable objects after the traversal, so they sort last; putting them first is a divergence with nothing behind it.

## Decision

**User-ratified.** `buildPack` refuses an input in which some objects carry `recency` and others
do not, throwing `INVALID_PACK_INPUT` with `{ reason: 'mixed-recency', present, absent }` before
any I/O. The comparator stays unconditional: every object either has a recency or none does.

gc supplies ordinals for the unreachable members of a promisor pack as `reachable.size + i` over
the oid-sorted unreachable array, so they sort after every reachable object — reproducing git's
"appended after the traversal" placement.

The choice between this and the sentinel was made on model fidelity, not bytes: the two produce
identical packs on every input gc constructs. Git cannot represent an object without an ordinal,
and neither can tsgit under this record.

## Consequences

The comparator has no conditional branch and no sentinel value, so its transitivity is structural
rather than argued, and the ordering tests have exactly two arms to cover.

`buildPack` regains a named input-shape refusal. That matters because the move from parallel
arrays to `objects` (ADR-827) deleted the slab-length check that used to be the only such guard;
without this record the input shape would have no validation at all.

gc's promisor path grows an ordinal-synthesis step it did not need before. The step is a sort and
an index, and its output is pinned by the same byte-equality gate that covers the rest of gc.

A caller that legitimately holds recency for only part of its input has no route through
`buildPack` and must decide what the missing members mean. No current caller is in that position.
