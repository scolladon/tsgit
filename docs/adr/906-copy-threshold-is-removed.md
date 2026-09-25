---
subjects:
  - src/domain/diff/rename-detect.ts
  - src/application/primitives/detect-similarity-renames.ts
supersedes:
  - adr: "373"
    scope: "RenameDetectOptions.copyThreshold"
---
# 906 — `RenameDetectOptions.copyThreshold` is removed; one threshold gates renames and copies

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/rename-detection-git-parity.md (§4.5, D9) · **Supersedes:** ADR-373 (copyThreshold only)

## Context

git has one `minimum_score` shared by `-M` and `-C`; its single matrix runs a rename pass
then a copy pass against it. tsgit carried a separate `copyThreshold`, which has no git
counterpart and complicates the single-matrix pipeline.

## Options considered

1. Keep both: rename pass at `threshold`, copy pass at `copyThreshold` — *recommended by
   the design.*
2. **Remove `copyThreshold`; one threshold like git.**
3. Separate matrices per threshold.

## Decision

**Option 2 — ratified by the user** (the release is already a major). `threshold` gates
both passes.

Superseded from ADR-373: the `copyThreshold?` member of `RenameDetectOptions`.
Carried forward from ADR-373: the single cohesive `RenameDetectOptions` object, `threshold`,
`copies` and `breakRewrites`.

## Consequences

- Breaking change for callers passing `copyThreshold` — named in the changelog.
