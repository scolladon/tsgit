# 669 — Ownership is an optional `LayoutProbe` capability

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/ownership-trust-gate.md (candidate D1) · **Refines:** ADR-535, ADR-665

## Context

The trust gate needs to ask "does the caller own this path?". That question has no
platform-neutral answer: node compares `stat.uid` against the process uid, while memory and
browser sandboxes have no foreign ownership at all. Domain and `src/repository/` code must not
carry a platform ownership model.

## Options considered

1. **Optional `LayoutProbe.isOwnedByCaller?: (path) => Promise<boolean>`** (design
   recommendation) — pros: ADR-665's shape, already ratified for exactly this situation — an
   optional member whose *omission* is a meaningful, documented answer / cons: one more
   optional member on the probe.
2. **Widen `LayoutProbe.stat` with `uid?: number`** and compare in `resolve-layout.ts` — pros:
   no new method / cons: measurably wrong — the memory and browser adapters hardcode `uid: 0`,
   so a uid-comparing gate declares every sandboxed repository foreign-owned for any non-root
   process; silent in production, invisible in a root-run container. Also pushes a platform
   ownership model into `src/repository/`.
3. **A separate `TrustProbe` port** — pros: single responsibility / cons: doubles the plumbing
   through all three shims for one method.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

`LayoutProbe` gains an optional `isOwnedByCaller`. **Omission means trusted**: a sandbox that
cannot have a foreign owner satisfies the gate trivially, and that is a documented answer
rather than an unhandled case. Like the port itself (ADR-535), it stays out of the public
barrel.

## Consequences

- Memory and browser adapters wire nothing and remain trusted, with no special-casing scattered
  through the shims.
- The node adapter is the only implementation, which is also where ADR-670's platform gap lives.
- Cost is zero `stat` calls when the capability is omitted.
