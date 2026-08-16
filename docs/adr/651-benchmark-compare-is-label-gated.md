# 651 — benchmark-compare is label-gated

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidate D13)

## Context

Uncovered while pinning the CI evidence: `benchmark-compare` is now the actual PR long
pole — 23m15s against `mutation`'s 22 s on the latest sampled run. It is
`continue-on-error` (non-blocking) and the repo's own operating notes record that it
mostly measures runner noise; published numbers come from the nightly bench artifact.
The brief scoped CI cadence work to the snapshot and mutation jobs, so acting on this
was a deliberate scope decision, not a fold-in.

## Options considered

1. **Label-gated: run only when the PR carries a `bench` label (design recommendation
   for the pulled-in case)** — pros: normal PRs drop the 23-minute tail; on-demand
   signal preserved / cons: no automatic per-PR comparison.
2. **Move to nightly** — pros: same wall-clock win / cons: loses on-demand PR
   comparison entirely.
3. **Trim the scenario set** — pros: keeps automatic per-PR signal / cons: still costs
   minutes on every PR for a noisy, non-blocking number.

## Decision

**Option 1 (user-ratified — the user pulled this into scope, deviating from the
design's record-only recommendation).** `benchmark-compare` runs only when the PR
carries a `bench` label. The label is distinct from ADR-641's `mutation` label so the
two heavy jobs toggle independently. Push-to-main and nightly behaviour are unchanged.
