# ADR-161: Wave-0 harness extension — wire doc-links into validate; mutation-budgets stays CI-only

## Status

Accepted (at `1c35bc3`). **Amended on `feat/20-1-snapshot-join`** to revise
scope after discovering `check:mutation-budgets` is incompatible with local
`validate` runs (see "Revision" section below).

## Context

`package.json` defines two scripts that the spike's §14.3 validation gates
depend on:

- `check:doc-links` (line 197) — verifies that markdown cross-references in
  `docs/` resolve.
- `check:mutation-budgets` (line 204) — verifies the per-file mutation-survivor
  budgets file is honored.

Both exist as scripts but neither is invoked by `npm run validate`
(lines 693–715). They run today only as manual hygiene.

Phase 20.1 design relies on both as PR-blocking gates:

- doc-links because the spike introduces docs across `docs/use/snapshots.md`,
  `docs/understand/caching.md`, and updates to multiple existing pages.
- mutation-budgets because the new caching layer + `join` + `GenerationView`
  must have 0 surviving mutants (per CLAUDE.md mutation-budget rule).

## Revision (discovered Wave 0, mid-implementation)

The original decision was to wire BOTH checks into `validate`. Running
`check:mutation-budgets` standalone on the branch surfaced an unstated
prerequisite:

```
report not found: reports/mutation/mutation-report.json
❌ [check:mutation-budgets] exited with exit code 1.
```

`check:mutation-budgets` reads Stryker's mutation report. Stryker is NOT
part of `validate` — it lives in `npm run test:mutation` (30+ minutes;
nightly + per-PR CI workflow). Wiring `check:mutation-budgets` into
`validate` would either (a) make local `validate` fail unless Stryker
ran first, or (b) require pulling Stryker into the `validate` chain,
turning validate into a 30-minute gate.

Neither is acceptable. `validate` must stay fast (< 5 min) to be useful
as a pre-commit gate.

## Decision (revised)

Wave 0 wires **only** `check:doc-links` into `validate`. The
`check:mutation-budgets` gate stays as a dedicated CI workflow check
(invoked after `test:mutation` in the per-PR mutation workflow), NOT
a member of `npm run validate`.

This is honest about the cost: doc-link checking is cheap (a few seconds
of HTTP HEAD requests); mutation-budget checking is cheap *given a report*
but the report itself costs 30+ minutes to produce. Coupling them in
`validate` would conflate two very different gate latencies.

Design doc §14.3 + §15.6, spike §14.3, and plan doc Wave 0 are amended
on the same branch to reflect this revision.

## Consequences

### Positive

- `validate` stays fast (< 5 min); contributors can run it pre-commit
  without paying the Stryker cost.
- `check:doc-links` becomes PR-blocking via `validate`, catching broken
  cross-references in every PR.
- `check:mutation-budgets` remains a real gate via the dedicated mutation
  CI workflow — enforcement is unchanged, just the surface that invokes it.
- One-line edit to `package.json` — minimal blast radius.

### Negative

- Local `npm run validate` does NOT enforce mutation budgets. Contributors
  hitting Stryker for the first time via CI may be surprised by failures
  they couldn't reproduce locally. Mitigated: documented in `CONTRIBUTING.md`;
  `npm run test:mutation` is available for local mutation runs.
- The phase's stated "every gate in `validate` covers every check" goal
  is now caveated. Mitigated: design + plan + spike all annotate
  `check:mutation-budgets` as "wired by CI workflow, not by validate".

### Neutral

- Existing in-flight PRs without doc updates may hit doc-links failures
  after Wave 0 lands. Mitigated: Wave 0 runs the check across the whole
  repo before any 20.1 code lands; any link rot is fixed in Wave 0 itself.
- Pattern reusable: any future "fast check" can join `validate`; any
  future "slow check" stays in a dedicated CI workflow.
