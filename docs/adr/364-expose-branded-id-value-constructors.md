# ADR-364: Expose branded-id value constructors, not just the types

## Status

Accepted

- **Date:** 2026-06-18
- **Design:** [design/public-type-re-exports.md](../design/public-type-re-exports.md)
- **Refines:** [ADR-362](362-shared-public-types-reexport-barrel.md)

## Context

`ObjectId`, `RefName`, and `FilePath` (`src/domain/objects/object-id.ts`) are each a
declaration-merged pair: an `export type` plus an `export const` carrying the
smart-constructors (`ObjectId.from`, `ObjectId.fromRaw`, `RefName.from`, `FilePath.from`).
A consumer that receives a branded id from one call and must pass a literal sha/ref/path
to another needs a way to cross the brand boundary. The shared barrel
([ADR-362](362-shared-public-types-reexport-barrel.md)) is otherwise `export type *`
(type-only), so the value side is a genuine product choice, not just hygiene.

## Options considered

1. **(chosen) Export type and value constructors** — consumers can both annotate and
   mint/validate ids. Pros: brand boundary crossable without unsafe `as` casts; the
   constructors already validate input and throw specific errors. Cons: three tiny frozen
   objects enter the bundle (size-limit budget).
2. **Type only** — consumers can annotate/return ids but must use `as` casts to construct
   them, defeating the brand's safety exactly where it matters. Rejected.
3. **Type now, defer constructors** — splits a coherent change across two PRs for no
   benefit. Rejected.

## Decision

Re-export both sides of the three branded ids. In `public-types.ts` these three names use
a regular value+type `export { ObjectId, RefName, FilePath } from
'./domain/objects/object-id.js'` (not `export type *`), so the constructors are reachable
from every runtime entry and `index.ts`. This is the one carve-out from ADR-362's
type-only default.

## Consequences

- `public-types.ts` carries three value exports; everything else stays type-only.
- `check:size` sees three small frozen constructor objects — expected within budget;
  verified in the validation/gate pass.
- Consumers can write `repo.primitives.readObject(ObjectId.from(sha))` without casts.
- A value-constructor smoke test (round-trip + specific-error on invalid input, imported
  **from the entry**) proves the value side is reachable, per the design's test strategy.
