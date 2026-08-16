# 642 — benchmark-snapshot stays per-merge

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidate D3)

## Context

`benchmark-snapshot` runs on every push to `main` and is the run's solo tail: across
four sampled push runs it added 12-18 minutes after every other job finished, and two of
the four runs failed. It writes the per-merge trend point to the `gh-pages` benchmark
data branch; `benchmark-compare` gives PR-time signal independently.

## Options considered

1. **Move to a nightly schedule (design recommendation)** — pros: removes the 12-18 min
   tail from every merge; nightly `bench.yml` already exists / cons: per-day instead of
   per-merge trend granularity.
2. **Keep per-merge** — pros: every merge lands a trend point, regressions bisect to a
   single merge / cons: keeps the tail and the observed failure rate on the merge path.
3. **Keep per-merge, `continue-on-error`** — pros: failures stop reddening the run /
   cons: hides them without recovering any wall clock.

## Decision

**Option 2 (user-ratified — deviates from the design recommendation).** The snapshot
cadence is untouched: one trend point per merge, bisectable to the merge that caused it.
The 12-18 minute tail is accepted as the price of that granularity; the two observed
failures remain visible per-merge rather than being silenced. Nothing in this change
edits the snapshot job.
