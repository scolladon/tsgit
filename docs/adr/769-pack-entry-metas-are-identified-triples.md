---
subjects:
  - src/application/primitives/build-pack.ts
  - src/domain/storage/pack-writer.ts
---
# 769 — Pack entry metas are identified triples in emission order

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/delta-writing-packer.md (DC-3)

## Context

Delta selection requires emitting objects in `(typeRank, size DESC, oid ASC)` order so a
base always precedes its delta. Today `buildPack` emits in the caller's `oids` order and
returns `entries: ReadonlyArray<{ crc32, offset }>` positionally aligned to that input, and
all five callers zip the two lists by index to build the matching index file. Reordering
emission silently breaks that zip.

## Options considered

1. **Permute the metas back into `input.oids` order** — pros: invisible to callers / cons: keeps a positional contract that only holds by convention, and hides a real reordering behind it.
2. **Return `{ id, crc32, offset }` triples in emission order** (chosen) — pros: metas carry their own identity, so no caller can mis-zip; order-independent by construction / cons: changes all five call sites.
3. **Add a path hint and a name hash to the sort key** — pros: better size class on many-distinct-files / cons: helps only the callers that have paths; gc has none.

## Decision

**User-ratified.** `buildPack` returns metas as `{ id, crc32, offset }` in emission order.
The positional-alignment contract is deleted rather than preserved: every caller keys on
`id` instead of on array position. Emission order becomes `buildPack`'s own concern and no
longer leaks into the caller contract.

## Consequences

A whole class of index-construction bug becomes unrepresentable — a caller can no longer
pair a checksum with the wrong object by reordering its input. All five call sites change in
one atomic step, and the writer's published result type changes with them. Positional
alignment cannot be reintroduced later without reopening this record.
