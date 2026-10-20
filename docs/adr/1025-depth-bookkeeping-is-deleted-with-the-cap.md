---
subjects:
  - src/application/primitives/object-resolver.ts
  - src/application/primitives/pack-registry.ts
  - src/application/primitives/internal/object-caches.ts
---
# 1025 — Depth bookkeeping is deleted with the cap

- **Status:** accepted
- **Date:** 2026-10-20
- **Design:** docs/design/lift-delta-chain-read-cap.md (DC-7, §5) · **Supersedes/Refines:** refines ADR-1019

## Context

The cap's only readers are a set of counters threaded through the resolver: `externalDepth` on
six functions, `chainDepth` on every return type, `Phase1Result.baseChainDepth`, and
`DeltaBaseCacheEntry.chainDepth`, whose doc comment exists so a warm cache cannot hide depth.
None of it is in `reports/api.json`. `enforcePackDeltaPreApplyCap`'s `depth !== 1` reads the
walk's local counter, not this plumbing, and survives.

## Options considered

1. **Delete it in this change** (recommended) — pros: without the cap it is dead code whose
   comments explain a guarantee that no longer exists; internal, so no API change and no hotfix
   blocker / cons: ~150 lines of diff and a dozen test literals.
2. **Leave it computed, never read** — pros: smaller diff / cons: dead code with stale comments.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `chainDepth` leaves
`DeltaBaseCacheEntry`, `cacheDeltaBase`, `insertLevel`, `Phase1Result` and every resolver return
type; `externalDepth`'s slot becomes ADR-1020's walk memory. `deltify.ts`'s own `chainDepth` is
the writer's emission depth, a different concept, and is untouched.

## Consequences

Cache accounting is unchanged (`deltaBaseCacheEntrySize` sizes content only). A pure refactor
under the behavioural fix's suite: the type checker is the gate, and `bench:ab` on
`delta-chain-read` confirms no hot-path regression.
