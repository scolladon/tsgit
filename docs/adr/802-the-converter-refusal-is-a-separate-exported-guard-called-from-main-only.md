---
subjects:
  - tooling/bench-to-snapshot.ts
---
# 802 — The converter's refusal is a separate exported guard called from main only

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/bench-snapshot-summary-adr-lint.md (D3) · **Supersedes/Refines:** refines ADR-056

## Context

ADR-800 puts a refusal of sample-less entries in the snapshot converter. `toSnapshotEntries` is
also imported by the benchmark-compare tool, which runs label-gated and `continue-on-error` and
has its own verdict for a scenario missing from one side. Where the refusal sits decides whether
that tool inherits it. Tooling sits outside the coverage and mutation gates, so an unexported
guard would have no mechanical protection.

## Options considered

1. **Inside `toSnapshotEntries`** — cons: makes a value-less entry throw inside the comparison
   job, where it is noise, and forecloses that tool's own missing verdict.
2. **A separate exported guard, called from `main()` only** (designer's recommendation) —
   pros: one pure, unit-testable function; the policy lives where the publish contract lives.
3. **Inline in `main()`, unexported** — cons: untestable under the gates that apply to tooling.

## Decision

**Adopted-as-recommended (no user judgment): option 2.** The converter exports a pure guard
that, given the entries, returns them unchanged when every entry carries a finite value and
otherwise throws an error naming every offending scenario. Only the publish path in `main()`
calls it. `toSnapshotEntries` keeps ADR-056's shape and semantics.

## Consequences

The comparison tool is untouched. The guard has its own unit tests in `tooling/test/unit/`, one
per branch. A future producer of a value-less entry fails the snapshot step with the scenario
named, before the publish action ever runs.
