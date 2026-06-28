# 430 — bisect halving ports git's find_bisection verbatim; skip stays the consumer's

- **Status:** accepted
- **Date:** 2026-06-28
- **Design:** docs/design/bisect-midpoint-primitive.md · **Relates:** ADR-226 (git-faithfulness), ADR-429 (bisect midpoint surface)
- **Decision class:** D-FAITHFULNESS — adopted-as-recommended (no user judgment)

## Context

git's bisection halving in `bisect.c` is exact and its observable outputs (which commit it
picks, the "revisions left / roughly M steps" counts) are part of the byte-for-byte contract
the prime directive (ADR-226) binds. Several implementation boundaries are genuine choice
points where a faithful library could nonetheless drift:

- **Weighting & midpoint pick.** `count_distance` counts, for each candidate, its ancestors
  within the candidate set; the weight is `min(reaches, all − reaches)`; `approx_halfway`
  is `2·weight − all ∈ {−1, 0, 1}`; `best_bisection` picks the maximal weight.
- **Tie-break order.** When two candidates tie on weight (the diamond `A2`/`B2` case),
  `--bisect` breaks the tie by **candidate-list order**, which differs from `--bisect-all`'s
  oid order. List-order fidelity is the central regression risk.
- **Merge commits.** Multi-parent commits fold the ancestor union; the weight of a merge is
  the count over the union, not a per-parent sum.
- **Degenerate count.** With `all = 1`, `--bisect-vars` yields `remainingIfGood = −1`.
- **Skip.** git's real `find_bisection` reshuffles around a skip set (`filter_skipped`,
  randomised). The brief keeps skip the consumer's responsibility.

## Options considered

- **Port `find_bisection` verbatim** — reproduce the whole pipeline (candidate-list
  construction, `count_distance`, `approx_halfway`, `best_bisection`, `estimate_bisect_steps`)
  including list-order tie-break and merge-union weighting. Pin the diamond tie and an
  octopus-merge weight against real git via interop *(adopted)*.
- *Reimplement the halving from first principles* — derive an equivalent algorithm and rely
  on the parity matrix. Risks a silent tie-break or merge-weight divergence the prime
  directive forbids.
- **Skip: no `skip` parameter** — the primitive operates on a candidate set the consumer has
  already filtered; tsgit reproduces none of git's randomised skip reshuffling *(adopted,
  per brief)*.
- *Skip: reproduce `filter_skipped`* — pulls stateful, randomised porcelain into the pure
  primitive, contradicting the brief's "skip stays the consumer's".
- **Degenerate count: faithful passthrough** (`all = 1 → remainingIfGood = −1`) *(adopted)*
  vs. *clamp to 0* — clamping would diverge from `--bisect-vars` without an ADR licence.

## Decision

Adopted as the design recommends — these align with the prime directive (ADR-226), so no
user judgment was escalated:

- **Verbatim port** of `find_bisection` including candidate-list-order tie-break and
  merge-union weighting; `estimate_bisect_steps` for `remainingSteps`. The diamond `B2` tie
  and an octopus-merge weight are pinned by interop tests against real git 2.54.0 as the
  regression guards.
- **No `skip` parameter.** The consumer pre-filters the candidate set; the primitive
  reproduces none of git's randomised skip behaviour.
- **Faithful degenerate passthrough:** `all = 1` returns `remainingIfGood = −1`, unclamped,
  matching `--bisect-vars`.

## Consequences

### Positive

- The midpoint pick and counts match real git byte-for-byte, including the tie-break and
  merge cases that a from-scratch reimplementation would most easily get wrong.
- The pure primitive stays free of randomised, stateful skip logic — small, total, and
  property-testable.

### Negative

- A verbatim port couples the implementation to git's candidate-list construction order; the
  interop pins (diamond tie, octopus weight) must travel with any future refactor.

### Neutral

- A consumer that wants git's skip behaviour composes it on top by filtering the set before
  the call; this remains additive and outside the library surface.
