---
subjects:
  - src/application/primitives/internal/deltify.ts
---
# 831 — The bound and promotion heuristics ship with ordering, measured in stages

- **Status:** accepted
- **Date:** 2026-09-07
- **Design:** docs/design/name-hash-delta-ordering.md (DC-6)

## Context

`find_deltas` and `try_delta` carry four heuristics beyond ordering. Two are CPU-only on the
corpora here — the size pre-filters and the cross-type scan `break` — and two can move bytes:

- **The depth-scaled search bound.** Git's `max_size` scales with the candidate's depth, so it
  prefers shallower bases and ends chains around depth 43. tsgit uses a flat `size × 0.5` and
  runs to the cap of 50. On the deep-chain corpus tsgit's flat bound therefore yields *more*
  compression than git's, at the cost of longer read chains.
- **Best-base promotion.** Git moves a chosen base to the most-recent window slot; tsgit's
  window is FIFO with no promotion. On a chain-shaped corpus the predecessor is already the most
  recent member, so this has no measurable effect there.

The standing argument for excluding both was one variable per measurement: the design's
measurement contract attributes the deep-chain gain to the tiebreak and the many-files gain to
the hash, and a third change lands in the same numbers.

## Options considered

1. **Ordering only** — pros: one variable per measurement; the cleanest possible attribution for the gap this entry exists to close; smallest diff / cons: leaves two known divergences from git standing, and the chain-depth distribution stays unfaithful.
2. **Ordering plus the depth-scaled bound** — pros: takes the divergence with a real faithfulness argument / cons: the bound costs bytes on the deep-chain corpus, so it works against the entry's headline metric.
3. **Ordering, the bound, and promotion, landed as separate measured stages** (chosen) — pros: closes all three known ordering-and-window divergences from git in one PR; staged measurement keeps every variable attributable / cons: the largest diff, the longest run, and a net size number that may land worse than ordering alone.

## Decision

**User-ratified.** All three land in this change, as three separately-committed stages with a
benchmark between each: ordering first, then the depth-scaled bound, then best-base promotion.
Each stage records its own before/after on both fixtures, so the size effect of every variable is
attributable even though all three ship together.

This is explicitly a faithfulness-over-size trade on the bound. tsgit accepts a size regression
on deep-chain corpora in exchange for a chain-depth distribution that matches git's — a chain of
50 that git would have ended at 43 is smaller on disk and slower to read, and git's choice is the
one being replicated.

Promotion is expected to read as zero on both fixtures. It ships because it is a real divergence
with a cheap fix, and its stage exists to record that zero rather than to assume it.

## Consequences

Every ordering-and-window divergence from git named in the design is closed, so the residual
list after this change is the two CPU-only heuristics and nothing that moves bytes.

The headline size number becomes a composite, and reading it as "what name-hash ordering bought"
would be wrong. Only the first stage's measurement supports that claim; the published figure is
the sum of a gain, a regression, and a zero. The measurement contract carries all three
separately for exactly this reason, and any later comparison against these numbers must say which
stage it is comparing.

A staged plan is more parts and more benchmark runs than a single ordering change, and the middle
stage is the one that makes the total look worse. Landing it as its own commit is what keeps that
legible rather than buried.
