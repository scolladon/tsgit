# 560 — The `withStat` arm takes its drop verdict from the shared scanner

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/whitespace-drop-fast-path.md · **Supersedes/Refines:** none

## Context

Pinning the cap family uncovered that tsgit's two arms **already disagree with each other
on `main` today**: a whitespace-only change to a file whose two sides total more than
50 000 lines is dropped by the predicate arm (agreeing with git) and kept by the
`withStat` arm. The cause is not the line caps — at 99 999 lines `isBinary` is false — but
`diffLines` refusing `M + N > MAX_DIFF_LINES = 50 000` and returning `wholeFileFallback`
with `added = deleted = 99 999`, so `shouldDrop`'s `added === 0` test fails. This is a
live violation of ADR-513's "the two verdicts must stay provably consistent" and of the
invariant `diff-whitespace-modes-interop.test.ts` exists to assert; that suite is green
only because its fixtures are two lines long.

## Options considered

1. **The shared scanner over the materialised buffers** (designer's recommendation) —
   `stats` still computed as today for the `withStat` surface; only the keep/drop verdict
   moves. Pros: the two arms become consistent **by construction**, which is ADR-513's
   actual requirement and ADR-551's argument applied to the third code path; retires the
   disagreement as a side effect / cons: real surgery on `applyStatPass`.
2. **A `binaryDetection: 'nul-only'` option on `computeStatFields`**, used solely for the
   drop decision — cons: fixes the cap half only; `MAX_DIFF_LINES` is untouched, so the
   disagreement survives this option entirely.
3. **Leave it** and accept the arm disagreement — the do-nothing option, leaving a
   now-pinned inconsistency standing.

## Decision

**Option 1**, ratified by the user.

## Consequences

`applyStatPass`'s comment — "the stat and drop predicate share one `computeStatFields`
call so drop and counts are mutually consistent" — stops being the mechanism and must be
rewritten to describe the new one. Consistency stops being a property asserted by a
comment and becomes one held by construction, which is the only form ADR-513 actually
asked for. Because the shared scanner is the one ADR-558 rewrote to an incremental O(1)
fold, the stat arm inherits that too. This decision retires the arm disagreement but not
the wider count divergence it sits next to, which is ADR-561's.
