# 568 — dispose() drains refresh-initiated close batches

- **Status:** accepted
- **Date:** 2026-08-01
- **Design:** docs/design/pack-registry-single-flight.md · **Supersedes/Refines:** refines ADR-510 (persistent-handle ownership)

## Context

`refresh()` is `void` on the public `PackRegistry` interface and fires its outgoing-pack
closes without awaiting them. A `refresh()`-then-`dispose()` sequence — which the
lazy-fetch retry path produces — could then return from `dispose()` with a descriptor
still mid-close. Those handles are reachable (the close chain holds them), so this is not
the GC crash; but the acceptance criterion consumers assert against is "zero outstanding
handles at the moment `dispose()` resolves", and untracked closes make that flaky.

## Options considered

1. **Track the batch** — `refresh()` registers its `Promise.allSettled` chain in a
   pending-closes set that `dispose()` drains before resolving (designer's
   recommendation). Cost: one Set and one drain.
2. **Leave untracked** (today's shape) and scope the leak guarantee to sequences without
   a preceding `refresh()` — weakens the requirement the consumer will test.
3. **Make `refresh()` async** — breaking change to a public `void` method; pushes the
   burden onto every caller.

## Decision

Adopted-as-recommended (no user judgment): **option 1**.

## Consequences

"Zero outstanding at dispose-resolution" holds across the whole lifecycle matrix,
deterministically — the existing refresh test's `setTimeout(…, 0)` wait can become an
awaited `dispose()`. `trackClose` is only ever handed never-rejecting promises
(`allSettled`), so the bookkeeping cannot itself become an unhandled rejection.
