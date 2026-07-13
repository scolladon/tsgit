# 483 — Published numbers are a committed, hand-transcribed snapshot with provenance

- **Status:** accepted
- **Date:** 2026-07-13
- **Design:** docs/design/competitor-benchmarks.md · **Supersedes/Refines:** none

## Context

Two facts constrain how the published numbers are captured: benchmarks are noisy (the repo
already warns ±20% on GitHub Actions runners, and the `benchmark-compare` CI job is
`continue-on-error` and never blocks), and the "Why tsgit" numbers must be *citable* — a
number that changes on every nightly run is not citable. The CI nightly (`bench.yml`) and
the `benchmark-snapshot` trend job already produce ephemeral artifacts for trend tracking;
this decision is about the *published, citable* number, not the trend signal.

## Options considered

1. **Committed snapshot, hand-transcribed** (design recommendation) — pros: matches how
   `performance.md` already works (dated, host-pinned, hand-transcribed from
   `npm run bench:summary`); numbers change only when a human re-measures and re-commits
   with an updated provenance line, so they stay stable and honest. / cons: manual refresh
   step per release.
2. **Formalise a `bench:publish` script → committed `reports/benchmarks/published.md`** —
   pros: more reproducible capture. / cons: new script + committed report to maintain
   before the 26.5 regression gate exists; premature.
3. **CI-produced only, docs link the nightly artifact** — pros: no manual step. / cons: not
   citable — the numbers drift each run and the artifact expires in 30 days.

## Decision

The published numbers are a **committed snapshot, hand-transcribed** into
`performance.md` and the README slice, each carrying explicit provenance (platform, CPU,
Node version, isomorphic-git version, capture date). They are regenerated on a documented
reference host via `npm run bench:summary` and transcribed by a human — exactly the flow
`performance.md` already uses. The CI nightly and trend jobs stay as-is (ephemeral trend
signal, unchanged). **Per-release maintenance is a manual release-checklist step** ("re-run
`npm run bench:summary` on the reference host; update the performance.md table, the README
slice, and the provenance date"), not a scripted gate.

## Consequences

- The citable numbers are stable point-in-time measurements dated by their provenance line;
  a fresh local run drifting within ±20% is expected and covered by the caveat framing.
- No new script or committed report artifact ships now; a `bench:publish` formalisation
  remains available as a later hardening adjacent to the 26.5 regression gate.
- The release checklist gains one manual refresh step; the numbers never silently go stale
  because the provenance date makes the snapshot's age visible.
