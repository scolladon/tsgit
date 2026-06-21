# ADR-401: re-export the `log` public types from the shared barrel

## Status

Accepted

- **Date:** 2026-06-21
- **Design:** [design/diff-faithfulness-odds-ends.md](../design/diff-faithfulness-odds-ends.md) §3.2, §5
- **Relates to:** [ADR-362](362-shared-public-types-reexport-barrel.md) (shared re-export barrel), [ADR-363](363-facade-reachable-inclusion-bar.md) (facade-reachable inclusion bar)

## Context

`log` is exposed on the repository facade, but its public types — `LogOptions`,
`LogEntry`, `LogOrder` — are **not** re-exported from `src/public-types.ts`. The
sweep that established the shared barrel ([ADR-362](362-shared-public-types-reexport-barrel.md))
and set the inclusion bar "**every facade-reachable type is re-exported**"
([ADR-363](363-facade-reachable-inclusion-bar.md)) covered the diff types but missed
`log`. A consumer calling `repository.log({...})` therefore cannot import the option
or result type without reaching into a deep internal path.

This item ([ADR-400](400-log-parent-count-filter.md)) adds `minParents`/`maxParents`
to `LogOptions`, so the option type a consumer now needs to construct is itself
unreachable through the public surface — sharpening a pre-existing gap exactly where
this feature lands.

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

Re-export `LogOptions`, `LogEntry`, and `LogOrder` from `src/public-types.ts`,
applying [ADR-363](363-facade-reachable-inclusion-bar.md)'s facade-reachable
inclusion bar to the `log` surface. The regenerated `reports/api.json` is committed
with the change (the public-surface gate).

This **deviates from the design doc's recommendation** (D3.C: "leave as-is"), on the
grounds that ADR-363's already-ratified inclusion bar makes inclusion the consistent
choice, not a scope expansion.

## Consequences

### Positive

- The `log` surface is type-complete for consumers, consistent with the diff surface
  and ADR-363's bar; the new `min/maxParents` option is constructible from public
  types.

### Negative

- A larger `api.json` diff and a touch outside the brief's literal three parts —
  accepted as closing a pre-existing inconsistency at its natural touch-point.

### Neutral

- No runtime behaviour change; types-only re-export through the existing barrel.
