---
subjects:
  - src/application/primitives/detect-similarity-renames.ts
  - src/domain/diff/diff-change.ts
---
# 903 — `-B` follows git on every pair it breaks, including type changes

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/rename-detection-git-parity.md (§2.6, §3.4, D5, D6) · **Supersedes/Refines:** none

## Context

The use-count pipeline exposes `-B` rows where tsgit diverges: a broken-then-rejoined
source must turn its other pair into a copy (K1: git `M100 m ; C100 m→q`, tsgit
`A m ; R100`), and git breaks symlink ↔ regular type changes (N7b, N7d–N7f), which tsgit's
`TypeChangeChange` cannot report as broken.

## Options considered

1. K1/K2/N6b only; defer type-change breaking — *recommended by the design.*
2. **Everything, adding `broken?: SimilarityScore` to `TypeChangeChange`.**
3. No `-B` rows.

## Decision

**Option 2 — ratified by the user.** Every `-B` row in the design's matrix follows git.
`TypeChangeChange` gains an optional `broken` dissimilarity datum, mirroring
`ModifyChange.broken` (structured data, ADR-249).

## Consequences

- Public type change on the `DiffChange` union (additive field; ships in the major).
- More pins: the N7 rows join the interop matrix.
