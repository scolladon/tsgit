# 488 — The regression gate is advisory (non-blocking)

- **Status:** accepted
- **Date:** 2026-07-13
- **Design:** docs/design/bench-regression-gate.md · **Supersedes/Refines:** refines the non-blocking posture of ADR-483

## Context

The backlog frames 26.5 as a gate whose "diff must not exceed ±N% per scenario" — hard-gate
language. But the whole existing perf apparatus is deliberately non-blocking: the
`benchmark-compare` PR job is `continue-on-error: true` and `benchmark-snapshot` sets
`fail-on-alert: false`, because CI bench noise is ~±20% (the repo warns this in
`summary.md` and ADR-483). A tight blocking gate at that noise floor produces false reds,
which erode trust in the signal. The design recommended threading this with a hard gate
scoped to *gross* regressions only (block above a wide threshold, advisory below it).

## Options considered

1. **Hard gate** — non-zero exit blocks the merge on any scenario over N. / cons: flakes
   against ±20% noise; false reds block honest PRs.
2. **Advisory only** (chosen) — the job runs, computes and surfaces per-scenario deltas,
   flags scenarios over N, but `continue-on-error: true` never blocks the merge. / pros:
   honest about noise; a consistent, reviewable signal. / cons: enforcement is human.
3. **Hard gate on gross regressions only** (design recommendation) — block above a large N,
   advisory below. / pros: threads "must not exceed" against the physics. / cons: still a
   blocking behaviour on a noisy signal; a "gross" threshold is itself a guess.

## Decision

The gate is **advisory**. It computes each scenario's regression delta, flags any exceeding
the threshold N, and surfaces the per-scenario table (PR comment + `$GITHUB_STEP_SUMMARY`),
but it **never fails the merge** (`continue-on-error: true`). N is a **reporting/flag
threshold**, not a merge blocker. This is the user's ratified judgment; it **deviates from
the design's gross-only-hard-gate recommendation**, so the design doc is revised to match
before planning.

## Consequences

- The gate never produces a merge-blocking false red — consistent with ADR-483's stance
  that same-runner numbers are too noisy to auto-block.
- Its value over today's `benchmark-compare` is the *quality* of the signal, not
  enforcement: median-ms not `hz` (ADR-489), asymmetric (improvements never flagged),
  `tsgit`-scoped (ADR-490), and driven by unit-tested logic (ADR-491).
- Acting on a flagged regression is a human decision made on the PR — the gate informs it,
  it does not automate it.
- If the noise floor ever proves low enough to justify enforcement, flipping
  `continue-on-error` off is a one-line future change; nothing here forecloses it.
