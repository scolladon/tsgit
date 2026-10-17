---
subjects:
  - src/domain/git-index/cache-tree.ts
---
# 979 — Cache-tree invalidation cost is accepted

- **Status:** accepted
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** —

## Context

Keying cache-tree invalidation by raw bytes costs 40–110 ns per changed UTF-8 path (+13–27% of that step), under 0.1% of a 100k-entry index write (perf review).

## Options considered

1. **Accept** (recommended).
2. Precompute lighter projections (gain unmeasured).

## Decision

**Adopted-as-recommended (no user judgment) — option 1.**

## Consequences

- No extra code for an unmeasurable gain at command scale.
