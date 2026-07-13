# 484 — Comparison scenario set: the six small-repo scenarios

- **Status:** accepted
- **Date:** 2026-07-13
- **Design:** docs/design/competitor-benchmarks.md · **Supersedes/Refines:** none

## Context

Eight bench files already emit an isomorphic-git baseline, split into a small-repo default
set and a `TSGIT_BENCH_LARGE`-gated scaled set (some scaled scenarios go tsgit-only at large
scale because isomorphic-git is impractically slow). The published `performance.md` table
today covers six small-repo scenarios. The decision is which scenarios the *published*
comparison covers.

## Options considered

1. **Consolidate and publish the existing six small-repo scenarios** (design
   recommendation): `log`, `readBlob:cold`, `readBlob:warm`, `status:clean`,
   `status:dirty`, `clone` — pros: stable-surface, green, default-path (no gate), already
   apples-to-apples on a shared fixture and already documented; includes the honest
   tsgit-slower rows. / cons: no large-scale comparison published.
2. **Also promote 1–2 scaled comparison rows** (`log-scale`, `status-scale`,
   `pack-read-scale`) — pros: low-cost, they already run. / cons: `TSGIT_BENCH_LARGE`-gated
   and some go tsgit-only at large scale, so publishing them needs a clear scale/"not
   measured against iso-git at this scale" caveat to stay honest.
3. **Add new write-path scenarios** (`commit`, `checkout`, `init`) — pros: broader surface.
   / cons: needs careful same-fixture/equivalent-options framing; isomorphic-git's write API
   differs enough to risk an unfair comparison; new bench code.

## Decision

The published comparison covers the **six small-repo scenarios** (`log`, `readBlob:cold`,
`readBlob:warm`, `status:clean`, `status:dirty`, `clone`) — the stable-surface,
apples-to-apples set that already runs green on the default path. **The scaled comparison
set stays gated and unpublished; no new write-path scenarios are added** in this change.
The published table must keep the honest tsgit-slower rows (`readBlob:cold`, `log:walk`)
alongside the wins — the comparison's credibility depends on showing the losses.

## Consequences

- The comparison surface is exactly what `performance.md` publishes today, refreshed against
  the stable Phase-26 surface — no new bench scenarios ship, so the DSL/summarizer are
  untouched (see [ADR-480](480-competitor-benchmark-set-pure-js-peer-plus-reference-points.md)).
- Promoting a scaled row or adding a write-path scenario is a future scope decision,
  each gated on an honest same-fixture/equivalent-options (or explicit-scale-caveat) framing.
- The README slice (see [ADR-482](482-competitor-comparison-publication-surfaces.md)) draws
  its three curated rows from this six-scenario set.
