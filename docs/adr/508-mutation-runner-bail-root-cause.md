# 508 — Phantom survivors root-caused to bail cancellation; adopt `disableBail`

- **Status:** accepted (user judgment — chose docs correction + `disableBail` adoption)
- **Date:** 2026-07-26
- **Design:** docs/spike/stryker-vitest-empty-run-survivors.md (addendum) ·
  **Refines/Supersedes:** supersedes ADR-507's decision 1 ("no tsgit config
  change — none helps"); its other decisions stand

## Context

ADR-507 recorded the empty-run mis-scoring with the trigger unknown and
concluded no config change helps — true for every lever tested at the time
(pool, `coverageAnalysis`, `related`, `ignoreStatic`). Vitest-internals
probing subsequently pinned the trigger: the runner passes `bail: 1` to
vitest; on the first failing test (a mutant being killed) the worker fires
`onCancel("test-failure")` immediately while the failing result is still in
vitest's throttled task-update batch. The main process handles the cancel
first, force-stops the workers before the batch is applied (destroying the
kill evidence), parks the remaining files as bare result-less tasks, and
resolves the run as complete — which the runner scores "survived". The
phantom survivors were mutants being killed. Confirmed three ways: 13/13
in-window cancel traces; the upstream retry guard eliminates the flip (5/5);
`disableBail: true` eliminates the flip (5/5).

## Decision

1. **Adopt `disableBail: true` in `stryker.config.mjs`** — removes the race
   at its trigger. Cost: every covering test runs per mutant (no
   stop-at-first-kill), measured ≈1.5× slower on the repro; more loop mutants
   reach the hit-limit and report Timeout instead of Killed (both count as
   detected). Revert once the upstream guard ships.
2. **Correct the record**: ADR-507's "not config-fixable" holds only for the
   levers enumerated there; the spike doc gains a definitive root-cause
   addendum and the backlog entry is amended.

## Consequences

- Local and CI mutation runs are phantom-survivor-free by construction; the
  triage procedure's phantom caveat becomes a historical note once a full
  sweep confirms.
- Mutation wall-time increases; acceptable — the CI mutation job is
  non-blocking and local runs are scoped.
- The upstream contribution continues independently (retry guard as
  defense-in-depth; root-cause comment gives maintainers grounds to choose a
  bail-aware fix).
