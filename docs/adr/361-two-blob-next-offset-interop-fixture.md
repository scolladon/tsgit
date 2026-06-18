# ADR-361: Two-adjacent-large-blob interop fixture for next-offset boundaries

## Status

Accepted

- **Date:** 2026-06-18
- **Design:** [design/streaming-inflate-64kib.md](../design/streaming-inflate-64kib.md)
- **Depends on:** [ADR-359](359-exact-slice-pack-reads-via-next-offset.md)

## Context

Under [ADR-359](359-exact-slice-pack-reads-via-next-offset.md) the fix's highest-risk
correctness property is the **next-entry offset** computation. For any entry that is not
the last in the pack, the read range ends at the *next* entry's offset; an off-by-one or a
mis-sorted offset table silently hands `inflate` a wrong byte range — truncating or
over-reading the member — without necessarily raising an error. Unit tests exercise the
resolver and the offset-table logic with synthetic packs, but only a real `git`-produced
pack on a real file system pins the property cross-tool.

A single-large-blob pack only ever reads the *last* entry (bounded by the pack trailer),
so it never exercises the next-entry-offset path. Two adjacent large entries are required
to read a non-last entry whose end is another entry's offset.

## Options considered

1. **(chosen) Include fixture P3** — a pack containing two adjacent blobs, each >64 KiB
   compressed, read both, assert byte-identical to `git cat-file -p`. Exercises the
   next-offset boundary for a non-last large entry on a real pack.
2. **Unit spy only** — rely on the resolver unit tests asserting the computed range. Skips
   the real-filesystem / real-pack proof of the boundary arithmetic.

## Decision

Include the two-large-blob interop fixture (P3) alongside the single-blob cases in the new
`large-object-pack-interop` suite:

- **P1** — one ~140 KB random blob, packed via real `git gc`; `readBlob` returns
  byte-identical content.
- **P2** — same, read with hash verification (no `OBJECT_HASH_MISMATCH`).
- **P3** — two adjacent large blobs in one pack; both read byte-identical (next-offset
  boundary for the non-last entry).
- **P4** — the same blob left loose (no `gc`); `readBlob` succeeds (loose-path regression
  guard).

All `git` invocations run under the scrubbed-environment interop harness (`GIT_*` unset,
isolated `HOME`, `GIT_CONFIG_NOSYSTEM`, signing off).

## Consequences

### Positive

- Pins the next-offset boundary arithmetic on a real pack and real file system — the one
  failure mode that can silently mis-read objects.

### Negative

- One additional `git`-dependent interop fixture (skipped when `git` is unavailable).

### Neutral

- The fixture's rationale shifted from the design's original "bytesConsumed after retry"
  framing (grow-and-retry) to "next-offset boundary for a non-last entry" (exact-slice);
  the decision to include it is unchanged.
