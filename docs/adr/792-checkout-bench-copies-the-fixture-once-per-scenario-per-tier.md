---
subjects:
  - test/bench/checkout.bench.ts
---
# 792 — `checkout.bench.ts` copies the fixture once per scenario per tier

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/fix-main-ci-bench-fixture-deps.md (D2) · **Supersedes/Refines:** refines ADR-503 (tiers unchanged)

## Context

Running `checkout.bench.ts` on a disposable copy costs a copy per scenario per tier: measured
151 ms for `small` and about 10.5 s for `medium` (133 MB, 20 000 working files), so four copies
add roughly 21 s to a suite whose nightly budget is 30 minutes. The two scenarios (force and
no-force) alternate root and tip; the no-force one relies on the tree being exactly where the
previous checkout left it.

## Options considered

1. **Unchanged `MULTI_TIERS`, one copy per scenario per tier** (designer's recommendation) —
   pros: each scenario starts from a pristine tip; no cross-scenario state / cons: ≈21 s and
   ≈270 MB peak disk per run.
2. **Small tier only** — pros: ≈0.3 s / cons: drops the medium-scale signal the checkout
   optimisation's oracle was built to measure.
3. **One copy per tier shared by both scenarios** — pros: ≈11 s / cons: the no-force
   scenario's clean-tree precondition would depend on the force scenario's iteration-count
   parity, which is the exact coupling this change removes.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** Both scenarios keep their tiers,
titles and bench names; each takes its own copy, slugged by variant and tier, and disposes it
in a single `afterAll` that closes the repository before removing the directory.

## Consequences

- The `benchmark-snapshot` series keys are unbroken.
- Collection time grows by about 21 s per run; `maintenance.bench.ts` set the precedent of
  copying a 133 MB fixture inside a describe body on every green run since 2026-08-16.
- Under `TSGIT_BENCH_LARGE` two ~500 MB copies are added; that path is opt-in and never runs in CI.
