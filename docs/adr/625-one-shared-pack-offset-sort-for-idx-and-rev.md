# 625 — One shared pack-offset sort for idx and rev

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-08-13
- **Design:** docs/design/rev-on-idx-write.md (DC-2)

## Context

The `.rev` body is the permutation of index positions ordered by pack offset. That
ordering could come from an independent re-sort inside the writer, from re-parsing the
just-built `.idx` through `packPositionMap`, or from a comparator shared with the idx
serializer.

## Decision

Extract the oid/offset ordering into a shared helper consumed by both `serializePackIndex`
and `serializePackRevIndex`. One sort definition means the `.idx` and the `.rev` can never
disagree about index positions. An independent re-sort duplicates the comparator; reusing
`packPositionMap` over the freshly built `.idx` would pay a full parse and make
`fsck`'s `.rev` cross-check compare a value against itself — a tautology instead of an
oracle.

## Consequences

`pack-offset-table.ts`'s in-memory fallback sort and the new writer derive from the same
ordering definition. The fsck rev pass (`rev-index-health.ts`) remains an independent
verifier of tsgit's own output.
