# 493 — Post-sweep mutation thresholds tighten conservatively, data-driven

- **Status:** accepted (user judgment — chose conservative data-driven)
- **Date:** 2026-07-14
- **Design:** docs/design/whole-codebase-mutation-sweep.md · **Supersedes/Refines:** none

## Context

The backlog says "re-tighten the per-bucket CI mutation thresholds once the sweep lands and
the floor rises." Two frictions complicate a naive crank-to-100:

- **CI mutation is per-PR-scoped** (changed files only) and non-blocking. A `break`
  threshold is checked against whatever subset a future PR touches — a high `break` plus a
  small PR touching one equivalent-mutant line fails the gate (one survivor tanks a small
  denominator).
- **Local whole-bucket scores are untrustworthy** (vitest-4 under-reporting,
  stryker-js#5928), so the post-sweep whole-bucket ceiling cannot be read reliably offline.

The achievable whole-bucket ceiling after the sweep is `(total − #equivalent-mutants)/total`
— all real survivors killed; documented equivalents still count as survivors in Stryker's
score. The `name-rev` validation confirmed the surface is already near this ceiling (both
survivors were pre-documented equivalents; zero real survivors).

## Options considered

1. **Conservative data-driven** (chosen) — raise `high`/`low` to reflect the swept state;
   raise each `break` only to a value with clear margin above the equivalent-mutant floor +
   CI noise. / cons: `break` moves less than the raw ceiling would suggest.
2. **low/high only, leave every `break`** — / cons: the hard gate never reflects the
   floor-rise the backlog calls for; under-delivers the "re-tighten" intent.
3. **Defer thresholds to a follow-up** — / cons: leaves 26.12 without the threshold change
   it names; splits one coherent piece of work across two PRs.

## Decision

After each bucket's sweep, raise its `mutation-budgets.json` `high`/`low` to reflect the
measured swept floor, and raise `break` only far enough to lock in the gain while keeping a
clear margin above `(equivalent-mutant floor + CI noise)`. No `break` is set to a value a
single equivalent mutant on a small future PR could breach. Every threshold change is
justified in the PR body against the measured per-bucket survivor landscape; no threshold is
ever lowered.

## Consequences

- The gate tightens where the sweep proved headroom, without turning future small PRs
  fragile on documented-equivalent lines.
- Threshold numbers are grounded in the sweep's measured survivor counts (killed vs
  documented-equivalent), not a round-number aspiration.
- The change stays within 26.12 (one PR), honouring the backlog's "re-tighten … once the
  sweep lands" without a follow-up split.
