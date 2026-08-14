# 624 — README links the performance analysis; no comparison table in the README

- **Status:** accepted
- **Date:** 2026-08-13
- **Design:** — · **Supersedes/Refines:** supersedes [ADR-482](482-competitor-comparison-publication-surfaces.md); refines [ADR-094](094-readme-honesty-boundaries.md) and [ADR-483](483-committed-hand-transcribed-benchmark-snapshot.md)

## Context

ADR-482 put a curated tsgit-vs-isomorphic-git slice (win / parity / honest loss) in the
README's "Why tsgit" section. In practice the head-to-head table on the project's front
page reads as an aggressive competitive pitch against a peer library — a posture the
project does not want. The full analysis in `docs/understand/performance.md` remains
valuable: it carries the complete dataset, provenance, methodology, and the explanations
of why the slow paths are slow.

## Options considered

1. **Keep the curated README slice** (ADR-482's decision) — pros: numbers up front. /
   cons: front-page head-to-head framing is more adversarial than the project wants,
   and two surfaces must stay consistent on every refresh.
2. **README gets a pointer only; the dataset lives in performance.md** (ADR-482's
   rejected option 2) — pros: leanest README, single published surface, no competitive
   framing on the front page; the honest wins/parity/losses picture is one click away. /
   cons: a reader skimming only the README sees no numbers.
3. **Soften the README table (absolute medians, no ratios)** — pros: keeps numbers. /
   cons: still a comparison section inviting the same reading; still two surfaces.

## Decision

Option 2. The README carries **no performance synthesis and no comparison table** —
only a short neutral section linking to `docs/understand/performance.md`.
`performance.md` is the **single published comparison surface**: full dataset,
provenance, methodology, reference points, and the honest account of current losses.

## Consequences

- ADR-482 is marked Superseded, not deleted — its "never cherry-pick only wins"
  principle survives intact on the one remaining surface.
- ADR-094's honesty boundary stands: wins, parity, and losses all stay published with
  provenance; what changes is only *where* (one page instead of two).
- The ADR-483 release-refresh procedure now targets one file: hand-transcribe the
  nightly artifact into `performance.md` only (RUNBOOK updated accordingly).
- The backlog's original "fold the comparison into the README" aspiration (the driver
  behind ADR-482's choice) is consciously overridden.
