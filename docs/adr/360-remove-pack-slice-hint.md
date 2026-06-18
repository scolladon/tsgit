# ADR-360: Remove `PACK_SLICE_HINT`

## Status

Accepted

- **Date:** 2026-06-18
- **Design:** [design/streaming-inflate-64kib.md](../design/streaming-inflate-64kib.md)
- **Depends on:** [ADR-359](359-exact-slice-pack-reads-via-next-offset.md)

## Context

`PACK_SLICE_HINT = 1 << 16` (`object-resolver.ts:28`) was the fixed size of the first
slice read at a pack entry's offset, used at its single call site
(`object-resolver.ts:317`). It existed only to bound a "generous" first read in a world
where the resolver guessed how many bytes to pull before inflating.

[ADR-359](359-exact-slice-pack-reads-via-next-offset.md) replaces that guess with the
entry's **exact** byte range derived from the next-entry offset. There is no longer a
first-read-then-grow step, so a fixed first-read size has no role. The design's original
recommendation to *keep* `PACK_SLICE_HINT` as a first-read hint was premised on the
grow-and-retry strategy; choosing exact-slice reads voids that premise. This ADR records
the cross-candidate re-decision.

## Options considered

1. **(chosen) Remove the constant and its use site** — reads compute `[offset, nextOffset)`
   exactly; no fixed slice size remains.
2. **Keep `1 << 16` as a max-single-read sanity cap** — retains the literal as a guard
   that refuses entries larger than 64 KiB. Re-introduces a per-entry ceiling — precisely
   the failure ADR-359 removes. Rejected.

## Decision

Delete `PACK_SLICE_HINT` and its usage. Pack-entry reads size their slice from the exact
`[offset, nextOffset)` range (ADR-359); no first-read hint or per-entry slice ceiling
survives.

## Consequences

### Positive

- No residual fixed-size constant that could reintroduce a read ceiling.
- One fewer magic literal on the pack-read path.

### Negative

- None material — the constant's only consumer is replaced by exact-range reads in the
  same change.

### Neutral

- Supersedes the design doc's "keep as first-read hint" recommendation, which assumed the
  grow-and-retry strategy that was not chosen.
