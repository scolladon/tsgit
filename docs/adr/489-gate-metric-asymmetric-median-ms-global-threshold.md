# 489 — Gate metric: asymmetric per-scenario median-ms delta with a single global threshold

- **Status:** accepted (adopted-as-recommended — no user judgment)
- **Date:** 2026-07-13
- **Design:** docs/design/bench-regression-gate.md · **Supersedes/Refines:** none

## Context

The comparison needs a metric and a threshold policy. `snapshot.json` already tracks
**median runtime in ms** (smaller-is-better) via `toSnapshotEntries`; the legacy
`benchmark-compare` uses ops/s (`hz`). A perf *improvement* must never be flagged as a
regression. The threshold can be one global value or tuned per scenario.

## Options considered

1. **Global N, median-ms, asymmetric** (design recommendation, chosen) — one threshold,
   the least-noisy central estimator, improvements never flagged. / cons: a single N cannot
   reflect that syscall-heavy scenarios are noisier than CPU-bound ones.
2. **Per-scenario N, median-ms** — precise per scenario. / cons: higher maintenance; invites
   bikeshedding; premature before any scenario proves chronically noisy.
3. **ops/s (`hz`) metric** — matches the legacy job. / cons: noisier than median-ms; a
   second metric to reason about alongside the snapshot/trend surface.

## Decision

Per scenario, `deltaPct = (current_median_ms − base_median_ms) / base_median_ms × 100`. A
scenario is **flagged iff `deltaPct > N`** — **asymmetric**, so improvements (negative
delta) are never flagged. **One global N**, initialised at **≈ 10 %** (defensible for the
same-runner comparison of ADR-487, where the systematic per-runner offset cancels, so the
band can sit below the ±20 % raw-noise figure). Because the gate is advisory (ADR-488), N
is a tunable reporting threshold, not a merge blocker. The metric is **median-ms**, reusing
`toSnapshotEntries` for the flatten.

## Consequences

- One metric spans the gate, the snapshot, and the trend series — no second unit to
  reconcile.
- Improvements are always free; only slowdowns beyond N are surfaced.
- N lives in one place and is trivially tunable as observed noise dictates.
- Per-scenario thresholds are deferred; if a specific scenario proves chronically noisy it
  can be revisited without reworking the mechanism.
