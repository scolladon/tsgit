# ADR-531: The bundle re-exports `src/index.browser.ts` as-is

## Status

Accepted (at `9e128c04`) — adopted-as-recommended (no user judgment)

## Context

The bundle's input decides its public surface. `src/index.browser.ts` exports 46
names (measured; incl. `openRepository`, runtime detection, branded-type
constructors, diff/merge constants) and deliberately does not re-export the
browser adapter classes or transport middleware. Alternatives: a bundle-only
entry that widens the surface, or splitting into core + adapters bundles.

## Decision

The bundle's input is `src/index.browser.ts` unchanged: the pinned 46 exports,
byte-for-byte the same surface as the bundler path's browser condition. Export
parity is measured (46 = 46), not assumed.

## Consequences

### Positive

- Packaging-only change: zero API surface delta, docs and support answers never
  fork between CDN and bundler consumers.
- `check:doc-coverage` / `check:browser-surface` stay out of a packaging change.

### Negative

- CDN consumers cannot reach the adapter classes or transport middleware; they
  get the documented `openRepository({ rootHandle })` path only.

### Neutral

- A wider surface remains possible later as a separate, deliberate API decision.

## Related

- [ADR-525](525-browser-bundle-artefact-path.md) · [ADR-526](526-cdn-exposure-top-level-fields.md) · [ADR-527](527-browser-bundle-no-sourcemap.md) · [ADR-528](528-tarball-size-cap-750kib.md) · [ADR-529](529-browser-docs-placement.md) · [ADR-530](530-bundle-built-by-existing-rollup-config.md)
