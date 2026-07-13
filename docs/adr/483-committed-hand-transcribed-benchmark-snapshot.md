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

A second constraint surfaced while measuring: a **personal host is not a reliable
reference**. Measuring on an Apple M3 Pro while an interactive session loaded the machine
biased tsgit's syscall-heavy paths (`status`, cold `readBlob`) — isomorphic-git, a pinned
dependency whose code cannot change, itself measured 1.2–2.4× slower than a clean run, and
tsgit's `lstat`-heavy ratios shifted against it. The CI nightly (`bench.yml`) runs on a
**dedicated GitHub Actions runner** with no such contention, so its numbers are clean and
reproducible by anyone.

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
`performance.md` and the README slice, each carrying explicit provenance (runner OS/arch,
CPU, Node version, isomorphic-git version, capture date). They are **sourced from a dated
CI nightly benchmark run** (`bench.yml`, a dedicated GitHub Actions runner) and transcribed
by a human — **not** measured on a personal machine, whose interactive-load bias makes its
numbers uncitable. Transcribing a specific dated run into a committed snapshot gives the
citability option 1 wants while drawing on the clean environment option 3 wants; the live
artifact (which drifts and expires) is never the citation target. The CI nightly and trend
jobs stay as-is. **Per-release maintenance is a manual release-checklist step** ("read the
latest nightly benchmark artifact; update the performance.md table, the README slice, and
the provenance date"), not a scripted gate.

## Consequences

- The citable numbers are stable point-in-time measurements dated by their provenance line
  (runner OS/arch, CPU, Node, iso-git version, run date); the ±20% runner-variance caveat is
  preserved, and a reader who re-runs sees drift within that band.
- The reference environment is the dedicated CI nightly runner, reproducible by anyone —
  more citable than a personal laptop, and it sidesteps the interactive-load measurement
  bias that would otherwise penalise tsgit's syscall-heavy paths.
- No new script or committed report artifact ships now; a `bench:publish` formalisation
  remains available as a later hardening adjacent to the 26.5 regression gate.
- The release checklist gains one manual refresh step (read the nightly artifact, transcribe,
  re-date); the numbers never silently go stale because the provenance date makes the
  snapshot's age visible.
