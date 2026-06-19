# ADR-368: Similarity reported as raw `{ score, maxScore }`

## Status

Accepted

- **Date:** 2026-06-19
- **Design:** [design/similarity-rename-detection.md](../design/similarity-rename-detection.md)
- **Refines:** [ADR-249](249-describe-structured-data-only.md)

## Context

git scores similarity on a `0..MAX_SCORE` scale internally (`MAX_SCORE = 60000`) and
reports a **truncated** integer percent `(int)(score · 100 / MAX_SCORE)` — e.g. 900 of
1000 shared bytes reports `R089`, not `R090`, because the integer division floors.
ADR-249 mandates the library ship the structured datum and leave rendering to the
caller. The question is the unit/range of the `similarity` field on a `rename` (and
later `copy`) change.

## Options considered

1. **(chosen) `{ score: 0..60000, maxScore: 60000 }`** — self-describing: the caller
   projects the integer percent (`score · 100 / maxScore | 0`) without importing a
   constant. Pros: ships git's exact datum; self-contained. Cons: repeats `maxScore`
   on every change.
2. **Bare `score: 0..60000` + exported `MAX_SCORE` constant** — leaner, but couples the
   caller to a domain constant to interpret the field. Rejected (defensible, but the
   self-describing shape was chosen).
3. **Pre-projected integer `percent: 0..100`** — discards git's full precision and
   bakes the truncation into the data. Rejected: violates ADR-249's ship-the-datum
   principle.

## Decision

The `similarity` field is `{ score: number /* 0..MAX_SCORE */, maxScore: number }`.
The domain exports `MAX_SCORE` and a `toSimilarityPercent(score)` projection
(`(score · 100 / MAX_SCORE) | 0`) for internal/test use and for the patch serializer's
text reconstruction. The library never returns a pre-rendered `R<n>` / `similarity
index n%` string.

## Consequences

- The `R<n>` (`--name-status`) and `similarity index n%` (patch) renderings are the
  **same** truncated projection — confirmed by the interop matrix.
- Callers compute the percent themselves; the field is forward-compatible if git ever
  changes `MAX_SCORE` (the datum stays interpretable).
- Copy detection (ADR-369) reuses the identical `similarity` shape.
