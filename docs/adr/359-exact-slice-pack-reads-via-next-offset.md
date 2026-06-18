# ADR-359: Exact-slice pack-entry reads via the next-entry offset

## Status

Accepted

- **Date:** 2026-06-18
- **Design:** [design/streaming-inflate-64kib.md](../design/streaming-inflate-64kib.md)

## Context

`object-resolver.ts:readEntryHeaderWithChunk` reads a single fixed-size slice
(`PACK_SLICE_HINT = 1 << 16 = 65536` bytes) at a pack entry's offset and assumes the
whole zlib member lives inside it. The assumption breaks the moment an entry's compressed
stream exceeds the 64 KiB slice: `streamInflate` receives a truncated buffer and Node's
`createInflate` throws `unexpected end of file`. The boundary was confirmed empirically at
65,365 OK / 67,618 FAIL — exactly the 65536-byte cap. This blocks reading any object whose
compressed payload exceeds ~64 KiB (large blobs such as already-compressed Static
Resources, flat trees with thousands of entries). The loose path is unaffected
(`tryLoose` reads the whole file and inflates via the size-unbounded whole-buffer
`inflate`).

Two structural facts shape the fix:

- The pack-index stores per-entry **offsets** but **not** compressed sizes, so a single
  entry's compressed length is not known a priori.
- `InflateStreamResult.bytesConsumed` is consumed in exactly **one** call site —
  `fetch-pack.ts` (sequential walk of a received in-memory pack during indexing).
  `object-resolver` reads a single object via the index, which already knows the offset,
  and **discards** `bytesConsumed`. The whole-buffer `inflate(data)` is size-unbounded on
  **all three** adapters; only `streamInflate` carries the O(n²) progressive-prefix scan
  and its 64 KiB cap, and only because it must locate a member boundary inside a buffer
  that has trailing bytes from later entries.

## Options considered

1. **Grow-and-retry** — read 64 KiB; on truncation, double the slice and retry until the
   member fits or EOF. Bounded heap, no ceiling (a fixed doubling cap was rejected for
   re-introducing the bug). Cons: ~2–4× redundant I/O for large objects; keeps using
   `streamInflate`, so the browser/memory O(n²) cap still blocks their large reads.
2. **Read-to-EOF in one shot** — slice `[offset, fileEnd)` per entry. One read, but
   buffers the entire pack tail per entry — a small object near the front of a multi-GB
   pack allocates gigabytes. Disqualified on heap.
3. **(chosen) Exact-slice via next-entry offset** — derive the entry's exact byte range
   `[offset, nextOffset)` from the pack index (last entry bounded by
   `packSize − digestLength`), read exactly that, and inflate the member with the
   whole-buffer `inflate`. Git packs have no inter-entry padding, so the slice is exactly
   the member with no trailing bytes.
4. **True streaming decoder** — replace `streamInflate`'s scan with a zero-dependency
   pure-JS streaming zlib decoder that reports consumed bytes. The only way to also lift
   `fetch-pack`'s browser cap, but a large, perf-critical, byte-exact subproject far
   beyond a targeted read fix.

## Decision

Adopt **Option 3**. `object-resolver` computes each pack entry's exact byte range from a
per-pack offset table (built once from `PackIndex.objectCount` + `readOffset(i)`, sorted
by offset, cached on the registered pack; the highest-offset entry is bounded by the pack
file size minus the trailing digest). It reads exactly `[offset, nextOffset)` and inflates
the member through the size-unbounded whole-buffer `inflate` — **no** `streamInflate`, **no**
`bytesConsumed`, **no** grow-and-retry. Packed reads become structurally identical to loose
reads (exact member → `inflate`), so the 64 KiB read ceiling lifts on Node, browser, and
memory alike with no inflate rewrite.

**Scope boundary.** `fetch-pack` (sequential indexing of a *received* pack — browser
clone) still uses `streamInflate` + `bytesConsumed` over a concatenated in-memory buffer
and keeps the browser/memory 64 KiB `streamInflate` cap. Lifting *that* requires the
Option-4 streaming decoder. Whether it rides along is **deferred to review time** — once
the Option-3 diff size is known, the choice is fold-in-the-decoder vs. a loud written
call-out in the design/PR. It is explicitly **not** filed as a silent follow-up.

## Consequences

### Positive

- Removes the fixed read ceiling on **all three adapters** — large blobs/trees read
  correctly. Packed reads gain the loose path's size-independence.
- Optimal I/O and heap for reads: one exact read per entry, peak compressed-side
  allocation equal to the member size.
- No new inflate machinery, no hand-written decoder; the browser/memory read path needs
  zero adapter changes.

### Negative

- New per-pack sorted-offset table + one `fs.stat` on the `.pack` for the trailer bound
  (cached). Edge handling for the last entry and large-offset (>2 GiB) packs.
- `object-resolver` stops exercising `streamInflate`; its `bytesConsumed` contract now
  lives solely on the `fetch-pack` path.

### Neutral

- `fetch-pack` is unchanged; its browser/memory large-entry limitation is untouched and
  carried as an explicit, surfaced open decision (above), not a regression.
