---
subjects:
  - tooling/bench-summarize.ts
---
# 809 — A tsgit-only row renders an em dash and n/a; a no-tsgit row keeps the missing marker

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/bench-snapshot-summary-adr-lint.md (D10) · **Supersedes/Refines:** none

## Context

The summary renderer requires both a `tsgit` and an `isomorphic-git` entry in a group and
otherwise prints `_missing entry_` in both cells. The suite now has 81 tsgit-only groups against
14 paired ones, so the published summary reads as if most of the suite did not run. The runnable
bench set stays at exactly two names (ADR-480), so this is a rendering fix inside that
constraint, not a new competitor layout.

## Options considered

1. **tsgit-only: tsgit cell as in a paired row, an em dash in the baseline cell, `n/a` speedup;
   no-tsgit: today's `_missing entry_` in both cells** (designer's recommendation) — pros: an
   em dash reads as "no peer, by design"; the alarm stays where the genuine anomaly is.
2. **tsgit-only: an italic `_not run_` marker; no-tsgit: `_missing entry_` in the tsgit cell with
   the baseline still rendered** — cons: `_not run_` reads as a failure; renders a baseline for a
   shape that has never occurred and would read as a comparison.
3. **tsgit-only: an empty baseline cell** — cons: indistinguishable from a truncated table.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** Paired rows are byte-identical to
today. A tsgit-only row carries the tsgit median-or-mean, rate and error margin exactly as a
paired row does, an em dash for the baseline and `n/a` for the speedup. A group with no `tsgit`
entry keeps the `_missing entry_` rendering in both cells. The footnote says the speedup applies
to paired rows only.

## Consequences

The nightly summary shows every measured scenario. The missing-entry marker now means exactly
one thing: a scenario that produced no tsgit result.
