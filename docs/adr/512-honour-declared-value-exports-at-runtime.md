# 512 — Honour the declared .d.ts value exports at runtime (documented ADR-249 exception)

- **Status:** accepted
- **Date:** 2026-07-27
- **Design:** docs/design/close-isogit-perf-gap.md · **Supersedes/Refines:** documented exception to ADR-249

## Context

`dist/types/index.node.d.ts` declares `toSimilarityPercent` and `MAX_SCORE` as value exports, but the runtime bundle omits them — `export type *` in `public-types.ts` strips runtime values, so TypeScript consumers compile green and crash at runtime. `toSimilarityPercent` is a display-percent formatter, in tension with ADR-249 (structured data, not cosmetics). A consumer (sfdx-git-delta) already shipped a local workaround.

## Options considered

1. **Add the runtime value exports to honour the .d.ts (recommended)** — pros: fixes the consumer crash directly; the published type surface is the contract / cons: a small cosmetic helper joins the public runtime surface.
2. **Remove both from the public type surface** — pros: ADR-249-pure / cons: consumers keep recomputing the percent locally.
3. **Expose raw score only, drop the percent helper** — pros: structured / cons: breaks the declared surface differently.

## Decision

**Option 1 (user-ratified).** Value-export every value declared by the built `.d.ts` from the runtime entry — the audit sweeps all of `domain/diff`'s value exports, not just the two symbols. `toSimilarityPercent` stands as a documented, narrow ADR-249 exception: the `.d.ts` had already published it, and the declared surface is the contract. A permanent guard test parses the built `.d.ts` value-export list and asserts each is defined in the built runtime bundle, killing the drift class.

## Consequences

Declared-vs-runtime drift becomes structurally impossible (guard test). The new runtime exports pass the public-surface gates (api.json, README count, doc coverage). ADR-249 still bars *new* cosmetic surfaces; this exception covers only the already-declared symbols.
