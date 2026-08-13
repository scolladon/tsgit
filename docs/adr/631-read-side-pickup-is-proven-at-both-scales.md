# 631 — Read-side pickup is proven at both scales

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-08-13
- **Design:** docs/design/rev-on-idx-write.md (DC-8)

## Context

Requirement 7 says tsgit's read side picks up the freshly written `.rev` on next open.
`resolveSortedOffsets`' accelerator arm is gated on `REV_INDEX_MIN_OBJECTS` (5,000), so
a direct `loadPackRevIndex` assertion on a test-sized pack never exercises the arm the
requirement is about.

## Decision

Prove both: the always-on integration assertion (`loadPackRevIndex` is `usable` and
`revIndexPositions` ≡ `packPositionMap`) **and** one scaled case at or above the gate
threshold so the accelerator arm actually fires. If the scaled fixture proves too slow
for the integration tier, it moves to the bench fixture family rather than being
dropped.

## Consequences

One ≥5,000-object fixture joins the test suite; its build cost is watched against the
integration tier's timeout conventions (explicit `beforeAll` timeout per the repo's
interop findings).
