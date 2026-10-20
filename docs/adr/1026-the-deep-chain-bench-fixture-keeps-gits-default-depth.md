---
subjects:
  - test/bench/delta-chain-read.bench.ts
  - test/bench/support/fixture-generator.ts
supersedes:
  - adr: "471"
    scope: "the at-or-under-50 constraint and its reason that tsgit refuses deeper chains"
---
# 1026 — The deep-chain bench fixture keeps git's default depth

- **Status:** accepted
- **Date:** 2026-10-20
- **Design:** docs/design/lift-delta-chain-read-cap.md (DC-8) · **Supersedes/Refines:** supersedes ADR-471 (its depth constraint and rationale only)

## Context

ADR-471 built the deep-delta-chain bench fixture — an evolving 4 KiB blob repacked at
`--depth=50 --window=250`, max chain ≈ 43 — under the constraint that it must stay at or under
50 "because tsgit refuses deeper". ADR-1019 removes that refusal, so the constraint and its
reason are stale while the fixture itself still measures the case that matters.

## Options considered

1. **Keep the fixture; restate its reason** (recommended) — pros: it measures what `git gc`
   produces at defaults, the shape every real repository carries / cons: no scenario stresses
   the walker past 50.
2. **Add a deep scenario** (e.g. `fast-import --depth=1000`) beside it — pros: exercises the
   uncapped walker / cons: a shape rare in practice, more bench runtime, and no measurement says
   it is needed.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The fixture is unchanged; its reason
is now "a realistic repository packed at git's defaults", not a reader limit.

Superseded from ADR-471: the at-or-under-50 constraint and its reason that tsgit refuses deeper
chains — no reader refuses any depth.

Carried forward from ADR-471: everything else — option 1's evolving blob at `--depth=50
--window=250`, the deepest-chain object id taken from `git verify-pack -v`, and the env-isolated
generator.

## Consequences

A future git that packs deeper no longer breaks the leaf read; the generator's `verify-pack`
parse still records the deepest object. A deep-chain scenario is added only on a measured
complaint.
