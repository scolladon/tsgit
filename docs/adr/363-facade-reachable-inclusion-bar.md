# ADR-363: Inclusion bar — facade-reachable type closure plus orphans

## Status

Accepted

- **Date:** 2026-06-18
- **Design:** [design/public-type-re-exports.md](../design/public-type-re-exports.md)
- **Refines:** [ADR-362](362-shared-public-types-reexport-barrel.md)

## Context

"Re-export every type the facade's signatures mention" needs a precise, mechanical line
so the shared barrel ([ADR-362](362-shared-public-types-reexport-barrel.md)) neither
under- nor over-exposes. The candidates ranged from the strict transitive closure to
re-exporting whole barrels wholesale.

## Options considered

1. **(chosen) Facade-signature-reachable closure incl. orphans** — the transitive
   closure of `Repository` (every member, including `repo.ctx: Context`),
   `OpenRepositoryOptions`, and the three `Open*RepositoryOptions`, unwrapping
   `Promise` / `AsyncIterable` / `ReadonlyArray` / overload sets / union members. In
   practice this equals the full commands + primitives + ports + relevant domain
   barrels, plus the two orphan types reachable from a public signature but in no barrel.
   Pros: matches the brief verbatim. Cons: must add new barrel re-exports for the orphans.
2. **Closure plus whole barrels** — also re-export entire commands / primitives / ports
   barrels even where not facade-reachable. Adds non-reachable noise. Rejected.
3. **Closure minus deep `Context` ports** — exclude resolver / event-bus ports.
   Infeasible: `repo.ctx: Context` already makes those reachable, so excluding them would
   make `Context` itself un-nameable. Rejected.

## Decision

The inclusion bar is the facade-signature-reachable transitive closure. The two confirmed
orphans — `MergeBaseOptions` (`src/application/primitives/merge-base.ts`, via
`Repository['primitives'].mergeBase`) and `Pathspec` (`src/domain/pathspec/index.ts`, via
`SnapshotOptions.paths`) — are in scope and gain a re-export at their declaring tier's
barrel in addition to being surfaced through `public-types.ts`. Patch-serializer types
(`PatchFile`, `PatchOptions`, …) are **not** facade-reachable (the facade returns
structured diff, not rendered patch, per [ADR-249](249-describe-structured-data-only.md))
and are out of scope; the brief's illustrative `PatchResult` does not exist in the codebase.

## Consequences

- The two orphans need a new barrel re-export (their declaring tier currently exposes
  neither), then ride `public-types.ts` like everything else.
- `repo.ctx: Context` drags the deep port set into the public surface by design — this is
  accepted, not a leak.
- The bar is mechanical: a future facade signature mentioning a new type automatically
  pulls it into scope; the type-level nameability test (per the design's test strategy)
  guards against regressions.
