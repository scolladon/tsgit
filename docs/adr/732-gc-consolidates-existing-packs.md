---
subjects:
  - src/application/commands/maintenance.ts
---
# 732 — gc consolidates existing packs

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-17 clarification) · **Supersedes/Refines:** refines ADR-731 (adds the consolidation half of default gc)

## Context

ADR-731 pinned the cruft-pack lifecycle but deferred the other half of default `gc` —
consolidating pre-existing normal packs (`repack -A -d`) — because tsgit's pack writer
emits base entries only, so re-packing existing delta chains inflates the repository.
The deferral left one pinned divergence: an object packed while reachable and since made
unreachable stayed in its normal pack instead of migrating to the cruft pack.

## Options considered

1. **Lifecycle only** (designer recommendation) — pros: non-destructive, no inflation / cons: one placement divergence from default gc; existing packs never consolidate.
2. **Consolidate despite inflation** (chosen) — pros: true default-gc placement parity; the divergence row disappears / cons: repository size inflates until a delta-writing packer exists.

## Decision

**User-ratified.** The gc task performs full default-gc consolidation: all reachable
objects — loose and previously packed — repack into one new pack; unreachable objects,
wherever they lived, migrate to the cruft pack under ADR-731's four-branch lifecycle;
superseded packs and their sibling artifacts (`.idx`, `.rev`, `.mtimes`, bitmap) are
deleted; the midx is expired or rewritten to name only surviving packs; `*.keep`-marked
packs are excluded exactly as git excludes them. The delta-free writer's size inflation
is accepted and documented as a known trade, with a delta-writing packer recorded as the
follow-up that retires it. Pack-internal byte layout remains a non-surface (ADR-731);
placement, naming, sibling lifecycle, refusals and expiry arithmetic are the pinned
surfaces.

## Consequences

Object-placement parity with default gc becomes total — the interop divergence row is
replaced by a parity row. Repository size after gc may exceed git's for the same input;
the maintenance result exposes enough scalars for a caller to observe it. A
delta-writing pack writer becomes the highest-value follow-up to this command.
