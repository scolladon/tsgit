# 482 — Publish the comparison: README "Why tsgit" slice + performance.md dataset

- **Status:** accepted
- **Date:** 2026-07-13
- **Design:** docs/design/competitor-benchmarks.md · **Supersedes/Refines:** none

## Context

The backlog says to "fold the comparison into the README's 'Why tsgit' section, which
currently ships our-numbers-only." That phrasing is aspirational: the README (65 lines,
deliberately lean) ships *no* numbers today — the measured tsgit-vs-isomorphic-git table
lives in `docs/understand/performance.md`. The decision is where the published comparison
surfaces without bloating the README or duplicating the dataset.

## Options considered

1. **Compact curated "Why tsgit" table in README + full dataset in performance.md** (design
   recommendation) — pros: honours the backlog's explicit "fold into README"; a ≤10-line
   slice (one win, one parity, one honest loss) keeps the README lean; performance.md stays
   the single dataset home. / cons: two surfaces to keep consistent on refresh.
2. **Numbers stay in performance.md; README gets a pointer only** — pros: leanest README. /
   cons: contradicts the backlog's explicit "fold into README's Why tsgit section."
3. **One headline stat sentence in README + link** — pros: minimal README footprint. /
   cons: a single number cherry-picks; weaker than a small win/parity/loss table.

## Decision

The README gains a **"Why tsgit" section carrying a compact, curated comparison table** —
approximately three rows chosen to show a representative win, a parity, and an honest loss
(e.g. `status:dirty` faster, `clone` at parity, `readBlob:cold` slower) — plus a one-line
pointer to `docs/understand/performance.md` for the full dataset and methodology. The slice
stays ≤ ~10 lines and carries the "±20% variance — trust direction" caveat inline or by
pointer. **`performance.md` remains the full-dataset + methodology home**; the README slice
is a curated view of it, never a second dataset.

## Consequences

- The README slice **must not cherry-pick only wins** — it shows at least one honest loss,
  so a skimming reader is not misled.
- On every refresh, the README slice and the performance.md table are updated together with
  the same provenance date (see [ADR-483](483-committed-hand-transcribed-benchmark-snapshot.md)).
- The README stays lean; the comparison does not spawn a third doc page.
