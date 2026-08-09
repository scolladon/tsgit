# 594 — Flat and incremental chain ship together

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-08
- **Design:** docs/design/midx-read-support.md (DC-3, Pins C, I, J)

## Context

The midx has two on-disk forms: the flat `objects/pack/multi-pack-index` and the
incremental `multi-pack-index.d/` chain (a chain file of layer digests plus one
complete midx per layer). Pin J pins the precedence — a loadable flat file suppresses
the chain entirely; Pin I pins the chain's all-or-nothing degradation.

## Options considered

1. **Flat + chain now** — one loader; a chain is N layers where a flat file is 1.
2. **Flat now, chain deferred** — a `multi-pack-index.d/` present stays ignored.
3. **Chain only, flat as a synthetic 1-layer chain** — inverts Pin J's precedence.

## Decision

Adopted as recommended: **flat + chain now** (option 1). The chain is ~40 lines over
the flat loader and shares every parser row. Deferring it would give two lookup
semantics in one product once ADR-592's authority lands — chain-only repos served by
the `.idx` scan while flat-midx repos are served authoritatively — and the divergence
would appear in exactly the busy-fetch repos the feature exists for.

## Consequences

`loadMidxSet` owns Pin J's precedence (flat with `try` semantics, else chain, else
`.idx` scan) and Pin I's all-or-nothing rule (any missing or Tier-B layer drops the
whole chain; a Tier-A layer dies per ADR-593). Chain lookup walks layers newest-first
— unobservable for git-written chains, recorded in the design.
