# 492 — The whole-tree mutation sweep runs as a union of per-subdir incremental runs

- **Status:** accepted (user-directed scope; realisation reconciled with the override)
- **Date:** 2026-07-14
- **Design:** docs/design/whole-codebase-mutation-sweep.md · **Supersedes/Refines:** none

## Context

26.12 sweeps the entire `src/` surface (529 non-test files, ~57k LOC across the four
`mutation-budgets.json` buckets), delivered as one PR. The mutation override
(`.claude/workflow/mutation.md`) is explicit: **never the full tree** — one full-tree
Stryker invocation is intractable locally and the dry run flakes on the compileGlob perf
test. So "whole tree, one PR" needs a realisation that does not contradict the override.

## Options considered

1. **Union of tractable per-subdir `--incremental` runs** (chosen) — scope each Stryker
   run to a subdirectory (or a small group), `--incremental` so the accumulated
   `reports/stryker-incremental.json` builds a full-tree picture across runs without
   re-testing settled mutants. / cons: many runs to orchestrate; per-run `--mutate`
   negations must be re-stated (CLI `--mutate` replaces the config array).
2. **One full-tree `--mutate "src/**"` run** — / cons: the exact intractable/flaky path the
   override forbids; unreviewable single result; no incremental progress.
3. **Per-bucket single runs (one run per whole bucket)** — / cons: the large buckets
   (`application` 33.6k LOC, `domain` 17.4k) are still intractable as one run; too coarse to
   triage incrementally.

## Decision

Execute the whole-tree scope as the **union of per-subdir `--incremental` runs**. Partition
granularity: one subdir per run; group the many small domain subdirs (<300 LOC) so each run
is meaningfully sized; split the large ones (`diff`, `protocol`, `merge`, `storage`,
`objects`, `fsck`) onto their own runs. Bucket order `domain` → `infra`+`adapters` →
`application`. This is faithful to the override (no full-tree invocation) while covering the
full surface the user's scope choice requires.

## Consequences

- Progress is incremental and resumable — a partial sweep still lands committed value; the
  incremental cache means re-running a settled partition is free.
- The single PR accumulates all kill tests + equivalence annotations, organised by module
  (`test(mutation): <module>` commits) so the diff stays navigable despite the breadth.
- No production behaviour changes (tests-only); the prime directive still binds every kill
  test's assertions.
