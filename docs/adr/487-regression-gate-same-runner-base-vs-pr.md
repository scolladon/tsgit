# 487 — The regression gate compares the base branch and PR head on the same runner

- **Status:** accepted
- **Date:** 2026-07-13
- **Design:** docs/design/bench-regression-gate.md · **Supersedes/Refines:** none

## Context

The regression gate must compare each scenario's current runtime against *some*
reference. Two references are viable: a **committed baseline** captured once from a
dated nightly run (ADR-483's clean reference), or a **same-runner base-vs-PR** comparison
that benches both the PR's base branch and its head on one runner and compares the ratio.
ADR-483's sharpest lesson is that a **cross-environment** comparison is the uncitable,
noisy case — numbers measured in environment A and compared against environment B swallow
the systematic offset between them into the threshold. A committed baseline reintroduces
exactly that (nightly runner vs PR runner); a same-runner ratio does not.

## Options considered

1. **Committed baseline vs fresh PR bench** — pros: "locks the numbers" into a reviewable
   committed artifact; benches only once per PR. / cons: cross-run variance forces a wide
   threshold; the baseline drifts and needs a manual refresh procedure; a stale baseline
   silently weakens the gate.
2. **Same-runner base-vs-PR** (design recommendation, chosen) — pros: the ratio is
   load-independent (both sides pay the same runner contention — the exact method the
   26.7a `status:clean` investigation used to prove "no regression"); nothing to commit or
   let go stale; a tighter threshold is defensible. / cons: roughly doubles the CI bench
   cost on code PRs (build + bench both sides); the optimized numbers live in no committed
   artifact.
3. **Post-merge trend gate** — pros: cheapest, reuses the `gh-pages` trend series. / cons:
   catches a regression only after it lands on `main`, never on the PR.

## Decision

The gate benches the PR's **base branch** and the **PR head** on the **same runner** and
compares per-scenario runtimes. There is **no committed baseline** — the base branch *is*
the baseline. This reuses the existing `benchmark-compare` runner recipe (checkout base →
build → bench; checkout head → build → bench; compare).

## Consequences

- No baseline file, no `.gitignore` exception, and no baseline-refresh procedure ship —
  the "baseline home / format / refresh" question is moot.
- CI bench cost roughly doubles on code-changing PRs (two build+bench passes); acceptable
  because the job is advisory and same-runner is the only noise-honest comparison.
- The comparison consumes both sides' `raw.json`; the shared flattening and threshold logic
  is extracted (ADR-491) so both runs are reduced through one tested code path.
- Because nothing is committed, the "lock the final numbers" intent is served by the
  *gate* (a future PR cannot regress past its own base beyond the threshold), not by a
  frozen artifact.
