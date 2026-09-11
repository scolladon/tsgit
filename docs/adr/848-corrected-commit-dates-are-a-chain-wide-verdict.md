---
subjects:
  - src/domain/commit/commit-graph.ts
  - src/application/primitives/internal/read-commit-graph.ts
---
# 848 — Corrected commit dates are a chain-wide verdict

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/closure-history-walks.md (D6/D7, review finding) · **Supersedes/Refines:** refines ADR-839 and ADR-544

## Context

The commit-graph reader resolved each commit's generation per LAYER: corrected commit dates where
the layer carried a `GDA2` chunk, topological levels otherwise. The generation had no consumer
before this change; the cutoffs merge-base and name-rev now rest on it assume generations are
comparable across the whole chain. git's `validate_mixed_generation_chain` clears
`read_generation_data` on EVERY layer when any layer lacks it, so a mixed chain serves topological
levels uniformly, and `corrected_commit_dates_enabled` answers for the chain. Pinned on a
corrected-date base layer with a `commitGraph.generationVersion=1` split layer on top: tsgit served
`1 700 000 100` and `1 700 000 900` beside `1`, `2` and `3`, name-rev dropped every tip and merge-base
`--all` kept a redundant base, where git names `a^2~1` and returns `[T]`.

## Options considered

1. **Resolve the verdict once per chain and serve topological levels for every layer when any
   layer lacks corrected dates** (recommended, chosen) — pros: git's rule, monotone generations,
   one exported `correctedCommitDatesEnabled` for the merge-base comparator switch / cons: none.
2. **Keep per-layer resolution and clamp the cutoffs** — cons: hides the mixed numbers behind
   heuristics git does not have.

## Decision

**Adopted-as-recommended (no user judgment).** The loaded graph carries `correctedCommitDates` —
true only when every layer has a `GDA2` chunk — and the domain's `commitDataAt` takes that verdict
as a required option, serving `CDAT` topological levels for every layer when it is false.
`correctedCommitDatesEnabled(ctx)` exposes the verdict.

## Consequences

Mixed chains behave as in git for name-rev, merge-base and bisect; the merge-base queue switches to
date-only ordering exactly when git does (ADR-840). The test fixture that writes graphs now refuses a
parent outside its layers and writes real corrected dates, so generation order can differ from date
order in unit fixtures.
