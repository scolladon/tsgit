---
subjects:
  - test/bench/add.bench.ts
---
# 995 — add's bench covers a large index

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** —

## Context

The only new cost scales with index size (one binary search per inserted path). The existing scenario
re-stages a file in a one-entry index and cannot show that cost.

## Options considered

1. Keep the existing scenario and add two 10,000-entry scenarios (re-stage a modified tracked file;
   stage one new file), committed before the fix so `bench:ab` sees them on both sides (recommended).
2. The existing scenario only.

## Decision

**Adopted-as-recommended (no user judgment)** — option 1, aligned with the user's request to measure the
clean `add <file>` fast path before and after. Bound: each scenario within +10 %.

## Consequences

- One extra bench commit lands first in the branch.
