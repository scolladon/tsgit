# ADR-401: re-export the `log` public types from the shared barrel

## Status

Accepted

- **Date:** 2026-06-21
- **Design:** [design/diff-faithfulness-odds-ends.md](../design/diff-faithfulness-odds-ends.md) §3.2, §5
- **Relates to:** [ADR-362](362-shared-public-types-reexport-barrel.md) (shared re-export barrel), [ADR-363](363-facade-reachable-inclusion-bar.md) (facade-reachable inclusion bar)

## Context

`log` is exposed on the repository facade. `LogOptions` and `LogEntry` already reach
the public surface — `application/commands/index.ts` exports them and
`src/public-types.ts` re-exports the whole commands barrel via `export type *`. But
`LogOrder` (the `'date' | 'first-parent'` order union referenced by
`LogOptions.order`) is **not** named in that barrel export, so it is the one log
public type that is unreachable — inconsistent with the already-exported analogous
`ShortlogBy`, and with the inclusion bar "**every facade-reachable type is
re-exported**" set when the shared barrel was established
([ADR-362](362-shared-public-types-reexport-barrel.md) /
[ADR-363](363-facade-reachable-inclusion-bar.md)).

This item ([ADR-400](400-log-parent-count-filter.md)) edits the `log` surface
(`minParents`/`maxParents` on `LogOptions` — both `number`, introducing no new named
type), so it is the natural moment to close the pre-existing `LogOrder` gap rather
than defer it.

## Options considered

- (a) **Bundle the re-export now** — add `LogOptions`, `LogEntry`, `LogOrder` to the
  barrel as part of this item.
- (b) **Leave as a follow-up** — the gap predates this brief; defer it.

**Chose (a).** `log` plainly meets ADR-363's facade-reachable inclusion bar, so the
omission is a bug in the original sweep, not a new surface decision. We are already
editing `LogOptions` for the parent-count filter, so the consumer touch-point is in
scope; shipping the new option behind an unreachable type would be a half-measure.
The repo's working style lands a coherent whole per PR rather than filing adjacent
small gaps as deferred follow-ups.

## Decision

Add the missing `type LogOrder` to the `log` export in
`application/commands/index.ts`, so all three log public types (`LogOptions`,
`LogEntry`, `LogOrder`) reach `src/public-types.ts` through its existing
`export type *` wildcard — applying [ADR-363](363-facade-reachable-inclusion-bar.md)'s
facade-reachable inclusion bar to the `log` surface, mirroring the already-exported
`ShortlogBy`. The regenerated `reports/api.json` is committed with the change (the
public-surface gate).

This **deviates from the design doc's recommendation** (D3.C: "leave as-is"), on the
grounds that ADR-363's already-ratified inclusion bar makes inclusion the consistent
choice, not a scope expansion.

## Consequences

### Positive

- The `log` surface is type-complete for consumers — `LogOrder` becomes nameable,
  consistent with the diff surface, the already-exported `ShortlogBy`, and ADR-363's
  bar.

### Negative

- A larger `api.json` diff and a touch outside the brief's literal three parts —
  accepted as closing a pre-existing inconsistency at its natural touch-point.

### Neutral

- No runtime behaviour change; types-only re-export through the existing barrel.
