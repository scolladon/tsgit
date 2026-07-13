# 490 — The gate scopes to tsgit-named benches only

- **Status:** accepted (adopted-as-recommended — no user judgment)
- **Date:** 2026-07-13
- **Design:** docs/design/bench-regression-gate.md · **Supersedes/Refines:** none

## Context

Several bench scenarios register **two** benches — one named `tsgit` and one named
`isomorphic-git` — for the competitor comparison (ADR-480/484). isomorphic-git is a pinned
dependency whose code cannot change from our side; its per-run timing shifts are pure noise
to a gate meant to protect **tsgit's** performance. New scenarios are also added over time.

## Options considered

1. **Gate `tsgit`-named benches only** (design recommendation, chosen) — keys on the
   `> tsgit` suffix; iso-git entries are filtered out before comparison. / pros: every
   flagged delta is a tsgit signal. / cons: none material.
2. **Gate all benches, including iso-git** — / cons: adds flake with zero actionable signal
   (we cannot fix iso-git).
3. **Explicit allow-list of stable scenarios** — / cons: a hand-maintained list that drifts
   as scenarios are added.

## Decision

The gate keys on entries whose bench name is `tsgit` (snapshot key suffix `> tsgit`) and
filters out `isomorphic-git` entries before comparing. A scenario present in the current
run but **absent from the base** (a newly added bench) is reported as `new` and **never
flagged**; a scenario present in the base but absent from the current run is reported as
`missing` and warned, not flagged (a rename/removal is a legitimate refactor, and a
scenario the runner could not measure — e.g. a `git`-absent `SKIP` — must not fabricate a
regression).

## Consequences

- Adding or renaming a bench never breaks the gate.
- iso-git timing noise never contributes to a verdict.
- The gate's verdict set is exactly the `tsgit` scenarios common to both runs.
