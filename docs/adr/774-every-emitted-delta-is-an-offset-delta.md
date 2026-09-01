---
subjects:
  - src/domain/storage/pack-writer.ts
---
# 774 — Every emitted delta is an offset delta

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/delta-writing-packer.md (DC-8) · **Supersedes/Refines:** follows from ADR-767

## Context

Pinned against git 2.55.0 on one object set: `repack` emits offset deltas by default while
bare `pack-objects` emits reference deltas, because `repack` is what passes
`--delta-base-offset`. Offset deltas measured 3 479 B smaller over 193 deltas, roughly 18 B
each — a short backward varint against a full object id. Thin packs use reference deltas
exclusively.

Since delta emission excludes `push`, no tsgit pack crosses the wire, and thin packs never
arise.

## Options considered

1. **Offset deltas only** (chosen) — pros: every stored pack stays self-contained and standalone-readable; matches the `repack` path this work targets; smaller / cons: no thin-pack capability later without revisiting.
2. **Reference deltas for thin packs on the push path** — pros: much smaller pushes / cons: a protocol feature needing its own negotiation design, and out of scope by ADR-767.
3. **Reference deltas for cross-pack bases during consolidation** — pros: existing chains survive a repack without re-encoding / cons: produces a pack depending on another pack, breaking the self-contained invariant `read-object.ts` relies on to read a resolver miss as a genuinely absent object.

## Decision

**User-ratified.** Every delta tsgit writes is an offset delta whose base precedes it in the
same pack. Reference deltas are never emitted. The read path continues to accept both, since
git writes both.

## Consequences

Every pack tsgit writes remains independently readable, so a missing object stays
unambiguously missing. Thin-pack support remains un-advertised and would need this record
reopened alongside a negotiation design.
