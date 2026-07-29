# ADR-527: No sourcemap for the browser bundle

## Status

Accepted (at `9e128c04`) — adopted-as-recommended (no user judgment)

## Context

ADR-468 removed all `.map` files from the published tarball and made the
`^package/.*\.map$` forbidden-path grep in `tooling/verify-tarball.sh` the
executable spec. A map for the single-file bundle was measured at 2 541 792 B raw
/ 734 010 B gzip — larger than the entire current tarball — and shipping it would
require carving an exception out of ADR-468's guard. Emitting-but-excluding is
the exact shape ADR-468 rejected (a `sourceMappingURL` trailer that 404s in
consumer devtools).

## Decision

The bundle output sets `sourcemap: false`. ADR-468's broad forbidden-path guard
stays byte-identical and must stay green — that green is the proof this decision
landed.

## Consequences

### Positive

- Tarball stays at the measured 671 936 B instead of ~1.41 MB.
- ADR-468's guard is untouched; no per-file exception to maintain.

### Negative

- CDN consumers debug minified code; they can switch to the bundler path for a
  debuggable build.

### Neutral

- Consistent with every other artefact in the package (none ship maps).
