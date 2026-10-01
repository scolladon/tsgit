---
subjects:
  - src/application/primitives/internal/read-commit-graph.ts
---
# 927 — The commit-graph missing-layer warning goes to the logger only

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-15) · **Supersedes/Refines:** refines ADR-914, ADR-921

## Context

git warns `unable to find all commit-graph files` when a split-chain layer is missing from
every source and serves the loaded prefix. The commit-graph changes speed, never answers.

## Options considered

1. **`logger.warn` only** (recommended).
2. **Logger and a structured view of the loaded chain** — cons: public API with no data use.
3. **Silent**.

## Decision

**User-ratified — option 1.** Unlike an unusable alternate (ADR-914), which changes which
objects resolve, a partial commit-graph changes no result, so it gets no structured surface.

## Consequences

- Tests assert the warning through an injected logger.
