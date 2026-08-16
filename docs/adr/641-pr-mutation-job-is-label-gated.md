# 641 — The PR mutation job is label-gated

- **Status:** accepted
- **Date:** 2026-08-16
- **Design:** docs/design/perf-review-remediation.md (candidate D2)

## Context

The perf review's theory was that the 47-minute PR `mutation` job starves the runner pool; the
design refuted that on a five-run sample (`integration` started 3-4 s after its `needs`
in four consecutive runs, while `mutation` ran — the one 48-minute stall never
reproduced). Independently: the repo's merge policy already treats `mutation` as
non-blocking (informational; the local diff-scoped Stryker run plus triage in the
delivery workflow is the real gate), so on most PRs the job spends a runner for tens of
minutes producing a signal nobody waits for.

## Options considered

1. **Keep as-is + `timeout-minutes` guard (design recommendation)** — pros: no CI
   restructuring on a refuted theory / cons: still pays the full run on every PR for an
   informational signal.
2. **Keep exactly as-is** — pros: zero change / cons: same cost, and a runaway run can
   hold a slot indefinitely.
3. **Gate the PR mutation job behind a `mutation` label** — pros: normal PRs drop the
   job entirely; the signal stays available on demand, symmetric with the
   `benchmark-compare` label gate (ADR-651) / cons: an unlabelled PR ships with no CI
   mutation datapoint at all.

## Decision

**Option 3 (user-ratified — the user first chose "keep as-is", then revised to
label-gating during the same decisions conversation).** The PR `mutation` job runs only
when the PR carries a `mutation` label — a label distinct from the `bench` label of
ADR-651, so each heavy job toggles independently. Push-to-main behaviour is unchanged.
The local diff-scoped mutation run with triage remains the gating instrument for every
change, labelled or not.
