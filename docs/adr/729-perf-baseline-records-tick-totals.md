---
subjects:
  - tooling/profile-digest.ts
  - tooling/profile-baseline.ts
  - docs/perf/baseline.json
---
# 729 — Perf baseline records tick totals

- **Status:** accepted
- **Date:** 2026-08-26
- **Design:** docs/design/perf-remediation-2026-08.md (DC-15) · **Supersedes/Refines:** refines ADR-652 (the baseline stays ungated; it becomes self-describing instead)

## Context

The committed baseline stores self-shares with no absolute scale; several commands'
entire share vectors rest on 2–16 ticks, so headline numbers can be single-tick
artefacts and no reader can tell.

## Options considered

1. **Add `ticks` per frame + `totalTicks` per command; mark under-sampled commands** (recommended, chosen).
2. **Sibling sampling doc** — cons: the denominator lives away from the number; the next reader re-derives the problem.
3. **Only raise iterations** — cons: fixes today's artifact, not the next regeneration on a different machine.

## Decision

**Adopted-as-recommended (no user judgment).** The baseline schema gains `ticks` per
frame and `totalTicks` per command, rendered in both artifacts; commands below an
explicit `UNDER_SAMPLED_TICK_FLOOR` (500) are marked, and no oracle reads a share delta
from a marked row. Iteration counts are raised per workload until each clears the floor
where feasible.

## Consequences

Share numbers become readable evidence or visibly unreliable — never silently wrong.
The schema tests move with the change; nothing gates on the artifact (unchanged posture).
