# ADR-362: Shared `public-types.ts` re-export barrel

## Status

Accepted

- **Date:** 2026-06-18
- **Design:** [design/public-type-re-exports.md](../design/public-type-re-exports.md)
- **Refines:** [ADR-249](249-describe-structured-data-only.md)

## Context

The three runtime entries — `src/index.node.ts`, `src/index.browser.ts`,
`src/index.default.ts` — end with an identical thin tail block that re-exports only
`Repository`, `OpenRepositoryOptions`, `AdapterSet`, the progress helpers, and the
runtime detectors. None of the types those signatures transitively mention are nameable
from `import … from 'tsgit'`. Closing that gap needs a mechanism that adds the full set
to all three entries without the list drifting between them, and that also keeps the
`module`/`types` fallback surface (`index.ts`) consistent (see [ADR-365](365-align-index-surface-to-runtime-entries.md)).

## Options considered

1. **(chosen) One shared `src/public-types.ts` barrel** — `export type *` from the
   existing barrels (commands / ports / domain-objects / snapshot / diff) **minus** the
   names each entry owns (`Repository`, `OpenRepositoryOptions`, `openRepository`),
   re-exported by all three runtime entries **and** `index.ts`. Pros: single source of
   truth, cannot drift, forces the `export type *` hygiene decision once. Cons: one new
   file to register in `knip.json` `entry[]`.
2. **Explicit `export type { … }` lists per entry** — no new file, but the list is
   duplicated 3× and drifts over time. Rejected.
3. **`export type * from './index.js'` in each entry** — inherits the core barrel but
   collides (TS2308) with each entry's own `openRepository` / `Open*RepositoryOptions`
   and makes `index.ts` re-export itself circularly. Rejected.

## Decision

Introduce `src/public-types.ts` as the single public type surface. It re-exports the
facade-reachable closure (scope per [ADR-363](363-facade-reachable-inclusion-bar.md))
using `export type *` / `export type { … }` so nothing leaks to runtime, **excluding**
the entry-owned names `Repository`, `OpenRepositoryOptions`, `openRepository`. All three
runtime entries and `index.ts` re-export `public-types.ts`. The file is added to
`knip.json` `entry[]`. The branded-id value carve-out is governed by
[ADR-364](364-expose-branded-id-value-constructors.md).

## Consequences

- One list to maintain; the three entries can no longer disagree on their type surface.
- `public-types.ts` becomes a knip entry; its exports are "used" by virtue of the entry
  re-exports.
- Pure `export type *` keeps the emitted JS and bundle size unchanged for the type-only
  additions; the only value additions are the three branded-id constructors (ADR-364).
- The tail block's runtime-detector / progress / `AdapterSet` exports stay on the entries
  themselves (they are value exports already present); `public-types.ts` carries the
  type surface.
