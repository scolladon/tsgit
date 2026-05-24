# ADR-108: Pyramid-audit scripts follow existing `scripts/**` mutation exclusion

## Status

Accepted (at `b511d7f`)

## Context

`scripts/**` is excluded from Stryker mutation runs in the existing
`stryker.config.json` — the rationale being that the scripts are build-time
tooling, not shipped product code, and the marginal mutation cost of
~10 small files would slow the per-PR mutation gate noticeably while adding
little signal (the scripts are exercised by their own vitest unit tests at
100% coverage).

Phase 19.2 adds `scripts/audit-test-pyramid.ts` plus a handful of helper
modules under `scripts/test-pyramid/**`. The question is whether the 19.2
files should be a one-off exception to the `scripts/**` exclusion — because
the team is asking the audit tool to *itself* be trustworthy — or whether
they should follow the existing convention.

Arguments for an exception:

- The audit influences PR review decisions; a silent bug in the scanner
  could mask findings.
- Coverage at 100% is a weaker guarantee than mutation testing (a coverage
  hit doesn't prove the assertion catches the bug).

Arguments for following convention:

- The audit is report-only (ADR-104) — a wrong finding is visible (it shows
  up in the PR) and refutable. The blast radius of a quiet bug is bounded.
- Mutation testing on scripts adds Stryker boot time without proportional
  benefit; the rest of the mutation pyramid (ADRs 100–102) is calibrated
  around `src/` only.
- One-off exceptions accumulate; the convention-following path keeps the
  mutation config flat.

## Decision

Phase 19.2 follows the existing `scripts/**` exclusion. `scripts/test-pyramid/**`
and `scripts/audit-test-pyramid.ts` are *not* added to the Stryker mutate
set. Their correctness is enforced by:

- 100% line / branch / function / statement coverage from
  `test/unit/scripts/test-pyramid/**`.
- An end-to-end integration test
  (`test/integration/scripts/audit-test-pyramid.test.ts`) that spawns the
  script against a synthetic temp directory and asserts the emitted reports.

If a regression slips past the 100%-coverage net, the report-only stance of
ADR-104 means the worst-case is a visibly-wrong report — the fix lands in a
follow-up PR with the bug case added to the unit fixtures.

## Consequences

### Positive

- No new exclusion-list entry to maintain; existing convention holds.
- Per-PR mutation gate stays fast.
- Bug blast-radius is bounded by ADR-104.

### Negative

- Subtle scanner bugs (e.g. brace-counter mis-counts a nested arrow
  function) won't be caught by mutation. Mitigation: comprehensive unit
  fixtures covering nested describes, multi-line openers, `.skip`/`.todo`,
  and `.each(...)`.

### Neutral

- Symmetric with `scripts/check-mutation-budgets.ts` and
  `scripts/check-doc-coverage.ts`, both of which are excluded from mutation
  for the same reason.
- Promotable: if a future audit heuristic becomes a hard gate, that change
  can include a Stryker exception for the heuristic's module and a new ADR.
