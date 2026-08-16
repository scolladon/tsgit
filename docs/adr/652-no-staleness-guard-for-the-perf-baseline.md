# 652 — No staleness guard for the perf baseline

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidate D14)

## Context

`docs/perf/baseline.json` went stale for a month — four perf-relevant merges landed
after its generation, and its top frames named symbols that no longer exist in `src/`
(`checkContainment`, `isContainedInEitherRoot`, `containmentVerdict`, `walkInternal`).
A guard against recurrence is tempting and cheap.

## Options considered

1. **None; regenerate on demand (design recommendation)** — pros: no false-positive
   machinery / cons: the artifact can silently stale again.
2. **A `validate` check failing when a `baseline.json` symbol has zero `src/`
   occurrences** — pros: would have caught this instance / cons: a profile frame name is
   not required to be a live symbol — V8 emits `<anonymous>`, minifier artefacts and
   pattern-keyed regular-expression entries — so the check false-positives and gets
   muted.
3. **A CI job that regenerates and diffs** — not viable: profile shares are
   machine-dependent and never diff clean.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** No guard is added. The
staleness mode is recorded here as a known limitation: the baseline is trusted only as
of its generation commit, and any perf work should start by checking
`git log -- docs/perf/baseline.json` against subsequent perf-relevant merges.
