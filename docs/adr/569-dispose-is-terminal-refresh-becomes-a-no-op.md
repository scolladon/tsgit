# 569 — dispose() is terminal: refresh() becomes a no-op after it

- **Status:** accepted
- **Date:** 2026-08-01
- **Design:** docs/design/pack-registry-single-flight.md · **Supersedes/Refines:** none

## Context

After `dispose()`, a `refresh()` clears the memo, so the next `all()` re-scans and its
packs open handles nothing will ever close — the very leak this change fixes, re-entering
through the back door. The repository facade's own `guard()` refuses post-dispose
operations, but `createPackRegistry` is also used standalone (`fetch-missing.ts`),
outside that state machine.

## Options considered

1. **Terminal flag** — `dispose()` sets `disposed` before its first await; `refresh()`
   returns immediately when set; `all()` keeps returning the closed, retired set exactly
   as today (designer's recommendation). Cost: one boolean, one guard.
2. **Leave as-is** — a narrow but live re-introduction of the unowned-handle leak.
3. **`dispose()` also clears the memo** — strictly worse: guarantees the next read opens
   unowned handles rather than merely permitting it.

## Decision

Adopted-as-recommended (no user judgment): **option 1**.

## Consequences

"Disposed" means disposed, in every consumer of the registry — not only under the
facade. Setting the flag before the first await gates a `refresh()` interleaved anywhere
inside `dispose()`. Reads through the retired set keep today's per-call fallback
behaviour, so nothing observable changes for a consumer that (incorrectly) reads after
disposal.
