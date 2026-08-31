---
subjects:
  - src/domain/storage/pack-writer.ts
---
# 776 — The pack writer entry becomes a discriminated union

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/delta-writing-packer.md (DC-10)

## Context

`PackWriterEntry` is a published type: `{ type: BasePackEntryType, uncompressedSize,
compressedData }`. `BasePackEntryType` structurally excludes both delta types, so the writer
cannot express a delta at all. A delta entry additionally needs its base's backward distance.
The last released version is 3.6.0 and a major release is already pending, so a breaking
change to this type costs no additional major bump.

## Options considered

1. **Additive** — keep the type, add a sibling delta type and a union alias — pros: source-compatible, ships as a minor / cons: leaves a type whose name claims generality it does not have, and two ways to say the same thing.
2. **Re-shape `PackWriterEntry` into the union** (chosen) — pros: one name, one concept; the writer's input type finally describes what a pack entry actually is / cons: breaks any consumer narrowing `entry.type` to `BasePackEntryType`.
3. **A separate internal delta writer** — pros: published contract untouched / cons: forks the writer into two near-identical implementations.

## Decision

**User-ratified.** `PackWriterEntry` becomes a discriminated union over `type`: the existing
base shape, plus a delta shape carrying the base's backward distance alongside the
compressed delta payload. `serializePackfile` accepts the union and narrows on `type`. This
is a breaking change to a published type, folded into the already-pending major.

## Consequences

The writer's input type is honest about what it can express, and an entry that carries a
distance without a delta type is unrepresentable. Consumers narrowing on
`BasePackEntryType` must widen. Because the change lands before the pending release, it costs
one major bump rather than two.
