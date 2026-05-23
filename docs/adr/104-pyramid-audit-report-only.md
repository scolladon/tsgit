# ADR-104: Phase 19.2 testing-pyramid audit is report-only, not a CI gate

## Status

Accepted (at `b511d7f`)

## Context

Phase 19.2 introduces a testing-pyramid audit: count unit/integration/e2e
tests, surface drift from a target ratio, flag over-mocked integration tests
and under-asserted unit tests. The audit's output shape has two reasonable
defaults:

1. **Gate (`exit 1` on threshold miss).** Same shape as 19.1's
   `check:mutation-budgets`: a CI job that fails the PR when the audit finds
   problems. Strong-signal, but pushes the team to scramble in CI to silence
   findings — including findings that turn out to be heuristic false positives.
2. **Report-only (`exit 0` always, write findings to artifacts).** A CI job
   that runs the same audit but never fails. Findings surface in PR artifacts
   (and, later, PR comments). The team can choose to act, defer, or refine the
   heuristic.

The audit's heuristics — "any `vi.mock` in `test/integration/**` is wrong",
"any `it()` with zero `expect()` is wrong" — are early-cut and need a few
cycles of calibration against real PR traffic before they can support a hard
gate. 19.3 (under-assertion lint) and 19.4 (integration usefulness audit) are
already on the backlog as the natural home for the gate conversation, with
sharper heuristics.

Two more inputs:

- The user explicitly chose "Tool + report-only (no gate)" when asked about
  the audit's output shape.
- ADR-099 (docs-PR gate warn-then-block) set the precedent for warn-only
  first, promotion to gate after one cycle of observation.

## Decision

Phase 19.2 ships as a report-only audit:

- `scripts/audit-test-pyramid.ts` always exits `0` after a successful run.
  The only non-zero exits are manifest-parse errors and filesystem errors —
  i.e., the audit itself is broken, not "the audit found problems".
- Findings are emitted to `reports/test-pyramid.json` (machine-readable) and
  `reports/test-pyramid.md` (human-readable), both committed as workflow
  artifacts.
- The CI step that runs the audit has no `if: failure()`-style behaviour
  attached and never blocks PR merging.
- No comment-based suppression mechanism (no `// audit-skip:` markers, no
  `.audit-ignore` file). Because the audit can't fail the build, there is
  nothing to silence.

When 19.3 / 19.4 promote individual heuristics to gates, those promotions
will be ADR'd at that time with the calibration data 19.2 gathered.

## Consequences

### Positive

- No false-positive churn in PRs while the heuristics are immature.
- Pyramid drift is still visible — the markdown report makes a 90/8/2 split
  as obvious as a 80/15/5 one.
- Promotion path is clean: turn `process.exitCode = 1` on when a heuristic is
  ready, in its own ADR'd change.

### Negative

- A team that ignores the report gets the same drift the audit is meant to
  prevent. Mitigation: PR-comment posting (a later change) puts the findings
  directly into reviewer eyeballs.
- "Report-only" is a quieter signal than CI-red. Mitigation: the audit's
  markdown output goes into the PR comment surface in a follow-up, where it
  becomes hard to ignore even without a status gate.

### Neutral

- Aligns with ADR-099's warn-then-block cadence.
- Parallels `check:doc-links` (ADR-095), which is also a report-style
  heuristic without a hard fail.
