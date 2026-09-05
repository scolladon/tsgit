---
subjects:
  - .github/workflows/ci.yml
---
# 801 — The benchmark-snapshot job bounds the run-phase hang with a timeout

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/bench-snapshot-summary-adr-lint.md (D2) · **Supersedes/Refines:** none

## Context

With `throws: true` (ADR-800), an error raised during a benchmark's **run** phase, after warmup,
rejects inside the timer callback vitest wraps the run in; that promise never settles and the
worker hangs. Pinned in the design. No job in the CI workflow sets a timeout today, so such a
hang would run to the platform's six-hour default before failing.

## Options considered

1. **Add `timeout-minutes` to `benchmark-snapshot`, matching the nightly workflow's 30**
   (designer's recommendation) — pros: one line; a hang becomes a bounded red; every other
   job-level failure benefits too / cons: none beyond choosing a number.
2. **Accept the hang unbounded** — cons: burns the six-hour default on every run-phase error.
3. **Drop `throws` to avoid the hang** — cons: restores the silent pass this change exists to
   remove.

## Decision

**Ratified by the user: option 1.** The `benchmark-snapshot` job declares `timeout-minutes: 30`,
the same bound the nightly bench workflow already uses.

## Consequences

A run-phase benchmark error surfaces as a job timeout within the hour, with the bench step's
output preserved for diagnosis. The bound is a job-level fact, not a per-scenario one; a scenario
that legitimately needs longer than the job allows is a change to this number, recorded here.
The bound covers every job running the bench suite: `benchmark-snapshot` at 30 minutes for its
one full-sweep pass, `benchmark-compare` at 60 for its six passes over the hot-path-scoped subset
(2 × `BENCH_ROUNDS` sides) — it is the subset, not the full sweep, that lets six passes fit inside
a bound sized for one.
