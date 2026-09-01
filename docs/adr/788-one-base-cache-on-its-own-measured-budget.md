---
subjects:
  - src/application/primitives/internal/index-pack.ts
  - src/application/commands/bundle-verify.ts
---
# 788 — One byte-capped base cache, on its own measured budget

- **Status:** accepted
- **Date:** 2026-09-01
- **Design:** docs/design/streaming-index-pass.md (DC-1, DC-11) · **Refines:** ADR-736

## Context

ADR-779's forest walk leaves exactly one piece of re-work: every base entry that has children is
read from disk twice — once in pass 1 to compute its oid, once in pass 2 as a forest root. A
carry-over cache removes precisely that second read and nothing else. Measured in git, whose own
base cache is a pure speed layer: disabling it costs **1.84×** and **2.07×** wall clock on the
two fixtures, so shipping no cache is not free — it is a deliberate ~2× on clone latency.

Separately, the thin-pack seam already has a cache, on the wrong side of the port and unbounded:
`bundle-verify.ts` wraps `ExternalBaseResolver` in a `Map<ObjectId, content>` that retains every
externally-resolved base — and memoises `undefined` results too — for the life of the verify.
That is the same unbounded-residency shape this change exists to remove.

The design's rationale cited "ADR-727/736's fraction pattern" as precedent for sizing. That is a
misreading: **ADR-736 considered a fraction and rejected it**, keeping `deltaBaseCache` at a
full, additive `deltaCacheMaxBytes`. The fraction siblings are ADR-726 and ADR-727. This
decision therefore has no sizing precedent to inherit.

## Options considered

Budget, once the cache itself was settled:

1. **A fraction of `deltaCacheMaxBytes`** (1/16, 1 MiB at the default), matching ADR-726/727 —
   cons: on a pack whose largest object is 4.76 MiB the cache holds almost nothing, so most
   second reads happen anyway.
2. **A full additive `deltaCacheMaxBytes`** (16 MiB), following ADR-736's own precedent — cons:
   pushes the documented four-cache additive total from ~34 MiB to ~50 MiB, in a change whose
   purpose is bounding memory.
3. **Its own named constant, defaulted from a measurement** on the fixtures.

## Decision

**User-ratified: one cache, option 3 for its budget.**

*Shape.* A single byte-capped LRU inside the indexer, keyed on `ctx.session` per ADR-722, serves
**both** roles: pass-1 base contents carried into pass 2, and externally-resolved thin-pack
bases. `bundle-verify.ts`'s unbounded `Map` is deleted and its resolver returns to being a plain
port call. One structure, one budget, one eviction policy, one seam to mutation-test. A
thin-pack-only cache was rejected as redundant — ADR-779's walk groups REF children by base oid,
so an external base is fetched once and becomes a root like any other.

*Budget.* The index pass takes its **own named constant**, whose default is set from a
measurement on the design's fixtures — not borrowed from the read-path cache family. This cache
is transient (one index pass), on the write path, with a hit pattern that resembles neither
`deltaBaseCache`'s nor the parsed-object memo's; inheriting either sibling's number would be a
coincidence dressed as a precedent. The implementation owes that measurement before the default
is pinned.

## Consequences

An unbounded retention leaves the thin-pack path, which is a residency fix in its own right and
independent of the pack-size win. `deltaCacheMaxBytes` remains the single dial for the *read*-path
family; this cache is deliberately outside it, so ADR-736's documented additive total is unchanged
by this decision and gains one clearly-labelled, transient sibling instead. The measured default
is a number a future profile can revisit without reopening the cache's shape. Because the cache is
an optimisation over an already-correct walk, disabling it must change latency and never results.
