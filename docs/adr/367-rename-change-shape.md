# ADR-367: Single `rename` variant carrying both sides + similarity

## Status

Accepted

- **Date:** 2026-06-19
- **Design:** [design/similarity-rename-detection.md](../design/similarity-rename-detection.md)

## Context

`RenameChange` (`src/domain/diff/diff-change.ts`) is a public, re-exported type
(ADR-362/365). It carries a **single** `id`/`mode`, baked on the R100 assumption
`oldId === newId` and `oldMode === newMode`. A content-similarity rename violates both
(the blobs differ, the mode may differ) and additionally reports a similarity score.
The shape must grow without breaking the exact-rename consumers (patch serializer,
blame, range-diff).

## Options considered

1. **(chosen) One `rename` variant with `oldId`/`newId`/`oldMode`/`newMode` +
   `similarity`** — R100 is the special case `oldId === newId`, `oldMode === newMode`,
   `similarity.score === MAX_SCORE`. Pros: consumers branch on data, not on a new tag;
   no `DiffChangeType` churn; the exact pass simply fills both sides identically.
   Cons: every `RenameChange` reader updates from `id`/`mode` to the two-sided fields.
2. **Split `exact-rename` (oldId===newId) and `similarity-rename` tags** — two
   discriminated variants + a new `DiffChangeType` value. Rejected: more consumer
   churn, and the distinction is derivable from the data.
3. **Keep `id`/`mode`, add optional `oldId?`/`oldMode?`/`similarity?`** — Rejected:
   optional-field primitive obsession and an ambiguous R100 representation.

## Decision

`RenameChange` carries `oldPath`, `newPath`, `oldId`, `newId`, `oldMode`, `newMode`,
and a structured `similarity` field. There is exactly one `rename` variant for both
the exact and inexact passes; R100 is represented as `similarity.score === MAX_SCORE`
with the two sides equal. The single `id`/`mode` pair is removed.

## Consequences

- All `RenameChange` consumers migrate to the two-sided fields (`blame` reads `oldId`
  for the renamed source; the patch serializer reads both sides + `similarity`).
- The public type surface changes; the re-export barrel and `api.json` update accordingly.
- Copy detection (ADR-369), if it introduces a `CopyChange`, follows the same
  two-sided + `similarity` shape for consistency (worked out in the revised design).
