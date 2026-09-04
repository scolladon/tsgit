---
subjects:
  - test/bench/support/fixture-scratch.ts
  - test/bench/checkout.bench.ts
  - test/bench/maintenance.bench.ts
---
# 791 — Bench fixture copies live in `fixture-scratch.ts`

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/fix-main-ci-bench-fixture-deps.md (D1) · **Supersedes/Refines:** none

## Context

Two bench files need a mutable copy of a cached scaled fixture: `maintenance.bench.ts`
already carries a private `copyToScratch`, and `checkout.bench.ts` must stop mutating the
shared cache in place. The house rule is one implementation of "copy a cached fixture into a
disposable directory", so the question is only where it lives. The `actions/cache` key that
guards every CI fixture is `hashFiles('test/bench/support/fixture-generator.ts')`, so a file
choice is also a cache-invalidation choice.

## Options considered

1. **A new `test/bench/support/fixture-scratch.ts`** (designer's recommendation) — pros: a
   copier imports nothing from `src/`, and edits to it never bust the CI fixture cache / cons:
   one more support module.
2. **Extend `test/bench/support/write-scratch.ts`** — pros: the scratch vocabulary is already
   there / cons: that module exists to *build* repos through `openRepository`; a copier has a
   different dependency set and a different reason to change.
3. **Put it in `fixture-generator.ts`** — cons: every future tweak to the copier would change
   the cache key and cold-rebuild every fixture on every runner.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `test/bench/support/fixture-scratch.ts`
exports `copyFixtureToScratch(sourceCwd)` returning `{ cwd, dispose, disposeSync }`, mirroring
`ScratchRepo`'s shape. The copy is created beside its source as
`<label>-v<N>.scratch.<pid>.<random>` (review refinement, adopted): it then lands on the same
filesystem as every other measured fixture, and a copy orphaned by a killed run is a leftover
the prune verb can recognise by its dead pid. `maintenance.bench.ts` drops its private copy and imports the shared
helper; `checkout.bench.ts` uses it for every tier. The module must never import from
`fixture-generator.ts`'s hashed file or from `src/`.

## Consequences

- Exactly one copier exists under `test/bench/`; a bench that mutates a fixture has one
  obvious call to make, and its absence is the review signal.
- The CI cache key is untouched by copier changes.
- `write-scratch.ts` keeps its single reason to change: building repos through the library.
- `vitest bench` never runs `afterAll`, so a copy is released through the scenario's
  `teardown` (the bench DSL's hook) and released synchronously there — tinybench does not
  await that hook, and an async removal in a file's last scenario is cut off by the worker's
  exit.
