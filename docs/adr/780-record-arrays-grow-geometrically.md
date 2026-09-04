---
subjects:
  - src/application/primitives/internal/pack-records.ts
---
# 780 — The record arrays grow geometrically, never sized from the declared count

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-09-01
- **Design:** docs/design/streaming-index-pass.md (DC-2) · **Supersedes/Refines:** none

## Context

Pass 1 stores one fixed-width record per entry. The obvious sizing input is the pack header's
`objectCount` — but that is a server-controlled `uint32` on an attacker-supplied stream. Today
it bounds only a `push` loop, so a lying header costs CPU until the first inflate fails. Sizing
a real allocation from it would turn that into a memory DoS: 50 000 000 × 33 B is 1.65 GB
claimed by a pack that may hold three entries.

## Options considered

1. **Allocate up front** at `min(objectCount, maxObjectsPerPack, structuralMax)`, where
   `structuralMax = (totalBytes − 12 − digestLength) / 9` from the pinned 9-byte minimum entry.
   Pros: exact, one allocation. Cons: a 512 MiB pack can still claim ~59.6 M entries — 1.97 GB
   of records before a byte is validated.
2. **Grow geometrically** (recommended) from a small capacity, with `objectCount` used only as
   a loop bound. Pros: a 50 M-entry claim over a 3-entry pack allocates for 3. Cons: a transient
   1.5× during each doubling, bounded by the real entry count.
3. **An array of objects** — no sizing question, roughly 5× the bytes.

## Decision

**Option 2.** Capacity grows geometrically from a small initial size as entries are actually
parsed; `header.objectCount` is a loop bound and never an allocation input. The structural
clamp from option 1 is kept as a second bound *underneath* the growth, not instead of it.

## Consequences

`maxObjectsPerPack`'s documented purpose changes: it no longer guards "before `fetchPack`
allocates per-entry state", because nothing allocates from the declared count. Its doc comment
moves with this change. A pack with a huge declared count and few real entries costs CPU
proportional to the real entries and memory proportional to the real entries.
