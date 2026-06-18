# ADR-365: Align `index.ts` surface to the runtime entries

## Status

Accepted

- **Date:** 2026-06-18
- **Design:** [design/public-type-re-exports.md](../design/public-type-re-exports.md)
- **Refines:** [ADR-362](362-shared-public-types-reexport-barrel.md)

## Context

The package exposes two different `.` surfaces. Tools that read the `exports` field
resolve to a runtime entry (`index.node.ts` / `index.browser.ts` / `index.default.ts`);
tools that read the top-level `module` / `types` fallback fields resolve to `src/index.ts`
(the richer "core" barrel). The two sets disagree today — and `index.ts` itself omits the
branded ids and the two orphans — so the same `import 'tsgit'` yields a different exported
type set depending on which field the toolchain honours. This is a latent consumer-facing
inconsistency.

## Options considered

1. **(chosen) Align `index.ts` to the same set** — `index.ts` re-exports the shared
   `public-types.ts` barrel, so both `.` resolutions export the identical type set. Pros:
   closes the inconsistency; free given [ADR-362](362-shared-public-types-reexport-barrel.md).
   Cons: none material.
2. **Leave `index.ts` as-is** — perpetuates the two-surface disagreement. Rejected.
3. **Make the runtime entries `export type * from './index.js'`** — would make the
   entries a superset of `index.ts`, but collides (TS2308) with each entry's own
   `openRepository` / `Open*RepositoryOptions`; this is ADR-362's rejected option (c).
   Rejected.

## Decision

`index.ts` re-exports `public-types.ts` (the same barrel the three runtime entries use).
Both `.` resolutions — `exports` runtime entries and the `module`/`types` fallback —
therefore export the identical public type set. `index.ts` retains its existing
non-overlapping exports (e.g. the snapshot-operators barrel) that the runtime entries do
not carry; alignment concerns the facade-reachable type closure, not those extras.

## Consequences

- The two-`.`-surface disagreement is closed for the facade-reachable type closure.
- A type-level edge assertion confirms the `types`/`module` resolution and the `exports`
  resolution yield the same set (per the design's test strategy).
- Future additions to `public-types.ts` propagate to `index.ts` automatically — no second
  list to maintain.
