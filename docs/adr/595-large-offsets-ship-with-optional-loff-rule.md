# 595 — Large offsets ship, with the optional-LOFF rule

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-08
- **Design:** docs/design/midx-read-support.md (DC-4, Pin F)

## Context

The midx `OOFF` chunk stores u32 offsets; offsets ≥ 2 GiB indirect through an
optional `LOFF` chunk via bit 31. Pin F pinned the rule without a 2 GiB pack by
rebuilding a valid midx with a synthetic `LOFF` chunk: with `LOFF` present, bit 31
selects a row (F1, all reads succeed); with `LOFF` absent, bit 31 is **part of the
offset** — git takes `0x80000000` literally and fails on the truncated-pack path
(F2). The `.idx` v2 large-offset table is always present at a computed position, so
`readOffset`'s masking logic cannot be reused verbatim.

## Options considered

1. **Ship now** — parse `LOFF`, honour the optional-chunk rule.
2. **Defer, refusing** — bit 31 set is a fault; the midx is discarded. Every repo
   with a >2 GiB pack silently loses the feature — the repo class it exists for.
3. **Defer, ignoring** — mask bit 31 unconditionally: a silent-corruption bug (F2
   proves the two readings differ).

## Decision

Adopted as recommended: **ship now** (option 1). It is ~12 lines mirroring
`pack-index.ts`'s `readOffset`, with the one deliberate difference: the indirection
branch is taken only when a `LOFF` chunk exists.

## Consequences

`lookupMultiPackIndex` checks `largeOffsetsOffset === undefined` before honouring
bit 31; an out-of-range `LOFF` row refuses (`check: 'large-offset'`); the high-word
safe-integer guard mirrors `pack-index.ts:103`. Both Pin F directions are unit rows
and interop rows.
