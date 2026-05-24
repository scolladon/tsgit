# ADR-106: Pyramid target ratio is 80/15/5 with warn bands, not 70/20/10

## Status

Accepted (at `b511d7f`)

## Context

Phase 19.2 needs a target ratio for unit / integration / e2e tests. Three
shapes were considered:

1. **70/20/10** — the classic Mike Cohn pyramid. Hitting this from today's
   207/24/4 (88/10/2) would require either adding ~10 integration tests and
   ~15 browser specs, or moving ~30 tests out of `test/unit/`. The first is
   real work that doesn't belong to 19.2's scope; the second is destructive
   (a unit test that's adequately mocked already gives the signal the
   integration test would give, at a fraction of the runtime).
2. **80/15/5 — domain-heavy.** Reflects the hexagonal architecture: most
   logic lives in `src/domain/**` and tier-2 primitives, both of which are
   pure and unit-testable. Integration covers ports/adapters + real-FS paths.
   E2E covers browser surface-parity.
3. **No fixed ratio, only floors.** Enforce "integration ≥ N tests" and
   "e2e ≥ M tests" without a ratio. Easier to live with but lets the unit
   count balloon without raising a flag, and silences the "your test layer
   is melting upward" signal that the ratio is meant to surface.

tsgit is structurally a unit-heavy codebase. The domain tier is pure
TypeScript with zero platform deps; the application tier is pure composition
over ports. Most logic *should* be in unit tests. The 70/20/10 default
assumes a typical layered web app where business logic and persistence are
intertwined; that's not this codebase.

A target alone is insufficient — the audit needs to know when to flag drift.
A symmetric ±5% band around each target would be over-restrictive (a slight
healthy increase in unit coverage would warn). What matters is the asymmetric
direction: too-few unit tests is a smell, too-few integration tests is a
smell, too-many integration tests is a smell (logic leaking out of unit
layer), but too-many unit tests is fine.

## Decision

Adopt 80/15/5 with the following warn bands:

| Tier | Target | Warn below | Warn above |
|---|---:|---:|---:|
| unit | 80% | 75% | — |
| integration | 15% | 10% | 25% |
| e2e | 5% | 3% | — |

- "Warn" means surface a finding in the report. Per ADR-104, this does not
  fail CI.
- The unit tier has no upper bound — domain-heavy projects skew unit-heavy.
- The integration tier has both bounds: drift below 10% means platform
  coverage is thinning; drift above 25% suggests logic that should be in unit
  tests is reaching for I/O.
- The e2e tier only has a floor; ramp-up is owned by 19.3/19.5/19.5a.

The current 207/24/4 baseline puts the audit at:
- unit 88% (above target, no warn).
- integration 10.2% (right at the warn floor — load-bearing signal).
- e2e 1.7% (warns from day one — that warning is the prompt for 19.5/19.5a).

The manifest `test-pyramid-budgets.json` carries these numbers. Changing them
requires an ADR-superseding change.

## Consequences

### Positive

- Numbers reflect this project's architecture, not a generic web-app rule of
  thumb.
- E2E starts warning on day one — the audit immediately signals that
  19.5/19.5a have real work to land.
- Integration upper-bound catches "we accidentally turned a unit-pure
  primitive into an integration test" before the unit suite atrophies.

### Negative

- "Domain-heavy" is a debatable framing — a new contributor used to the
  classic pyramid might push back. Mitigation: the manifest comment and the
  audit's markdown report cite this ADR by number.
- The 80/15/5 split makes 19.5/19.5a's ramp-up *visible* — the audit will
  keep flagging e2e until those phases land.

### Neutral

- The bands are themselves ADR-able later — if 19.3/19.4 land a better
  signal-to-noise, the manifest can shift and the change carries its own ADR.
