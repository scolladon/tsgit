---
subjects:
  - test/bench/fetch-pack.bench.ts
---
# 803 — The fetch-pack bench receives into a fresh memory context per iteration

- **Status:** accepted
- **Date:** 2026-09-04
- **Design:** docs/design/bench-snapshot-summary-adr-lint.md (D4) · **Supersedes/Refines:** none

## Context

The fetch-pack scenario receives the same pack into one memory repository on every iteration.
The second receive collides with the artefacts the first one wrote, so the scenario has never
measured anything. The synthetic pack itself depends only on the hash algorithm, not on the
store, so it can be built once and replayed into any number of destinations.

## Options considered

1. **A fresh `createMemoryContext()` inside the measured function** (designer's
   recommendation) — pros: measured at about 0.003% of one iteration; a cold delta cache on
   every iteration, which is what a real receive faces; immune to the writer's artefact list /
   cons: the context is constructed inside the measured region.
2. **One context, every artefact removed after each call** — cons: coupled to the writer's
   artefact list, which grew by `.rev` recently and will grow again; a warm cache across
   iterations prices something the scenario does not claim to measure.
3. **One context, a distinct pack per iteration** — cons: changes the fixture the scenario is
   named after and moves pack building inside the measured region.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `build` constructs the entry list, the
pack bytes, the negotiator and the wanted id once, through a seed context used only to hash and
compress. The measured function receives into a brand-new memory context every call and keeps
the guard that the receive reported a pack path. The scenario title and the bench name are
unchanged, so the published series key is unchanged.

## Consequences

The scenario measures a cold receive-and-index every iteration. This shape is required under
every outcome of ADR-804: with a tolerant receive path, a second receive into an occupied
destination would take the already-present path and price something else.
