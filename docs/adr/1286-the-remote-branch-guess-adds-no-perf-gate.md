---
subjects:
  - src/application/commands/checkout.ts
---
# 1286 — the remote-branch guess adds no perf gate

- **Status:** accepted
- **Date:** 2026-11-27
- **Design:** docs/design/checkout-remote-branch-dwim.md (DC-6) · **Supersedes/Refines:** none

## Context

The guess runs only where main threw. The switch that hits gains one scan of the
already-cached config tokens per command (ADR-1284), with no I/O. The remote config walk and the
`lstat` run only on the miss path.

## Options considered

1. **No new gate;** `bench:ab` on `checkout.bench.ts` after the change (recommended).
2. A D-7 bench pair: a switch with a large config against a floor twin, gated.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-7)'s trigger is per-item work on a
hot path (a hash per entry, an `lstat` per probe). This is one constant-size scan per command,
so D-7 does not apply. Option 2 is added if `bench:ab` shows a delta.

## Consequences

### Positive

- No bench fixture to maintain for a constant cost.

### Negative

- A regression in the scan is caught by `bench:ab`, not by a gate.
