# 611 — Exact-size bound for the reverse index, dedicated constant for the bitmap

- **Status:** accepted (adopted-as-recommended)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (DC-9, T-2/T-3) · **Refines:** ADR-600

## Context

ADR-600's ratio is that a new declared-count bound gets a bound sized by its own
arithmetic, not a borrowed cap. The `.rev` can do better than a cap: its size is
**exactly** `12 + 4·N + 2·digestLength`, with `N` already in hand from the `.idx`. The
`.bitmap` has no such exact relation, and ADR-605's ratification makes its bounds binding
rather than theoretical — a single EWAH run-length word can declare a clean run of 2³²
words, i.e. 2³⁸ bits, which is ~32 GiB if materialised.

## Options considered

1. **Dedicated constants for both** — correct / invents a constant for `.rev` where exact
   arithmetic already exists.
2. **Exact size for `.rev`, dedicated constant for the bitmap** (designer's recommendation)
   — the bound and the corruption check are the same test for `.rev`.
3. **Reuse the pack-index cap for both** — repeats the mistake ADR-600 was written to
   correct.

## Decision

Option 2. The `.rev` is `stat`ed and refused unless its size is **exactly**
`12 + 4·N + 2·digestLength`; that single test is simultaneously the allocation bound and
git's own size check. Its ceiling exists transitively without being invented, because `N`
comes from an `.idx` already capped.

The bitmap gets a dedicated named constant with its arithmetic in the doc-comment, sized
from `objectCount` as a soft upper bound rather than a flat number.

**Binding EWAH mitigations**, now that ADR-605 ships a parser:

- Every declared stream length is validated against the **remaining buffer** before any
  allocation — git's own `eof in data` check, where the mapped file length is the bound.
- Streams are decoded by **lazy run iteration**; a clean run is never materialised as an
  array. Total decoded bit count is bounded by the pack's `objectCount`, which is known and
  small.
- An empty stream on disk is `bitSize=0, wordCount=1, word=0` — 20 bytes, not 12. A parser
  that special-cases "empty means zero words" mis-parses git's own output.

## Consequences

No `DataView` read may occur at an unproven offset; a `RangeError` escaping either parser
is a defect, not an error path, and the totality property test is the guard. Trusting an
artefact's *content* (ADR-606, ADR-615) never implies trusting its *length*.
