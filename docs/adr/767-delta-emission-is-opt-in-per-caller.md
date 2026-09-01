---
subjects:
  - src/application/primitives/build-pack.ts
---
# 767 — Delta emission is opt-in per caller

- **Status:** accepted
- **Date:** 2026-08-31
- **Design:** docs/design/delta-writing-packer.md (DC-1) · **Supersedes/Refines:** retires the inflation trade recorded in ADR-732

## Context

`buildPack` has five callers: the three gc pipeline sites (normal, promisor, cruft), plus
`pack-objects`, `bundle-create` and `push`. Only the gc path has a measured inflation
problem, but every local-disk writer pays the same delta-free cost. `push` is different in
kind: its output crosses the wire and its shape is constrained by capability negotiation.

## Options considered

1. **gc/consolidation only** — pros: the brief's exact scope, smallest surface / cons: bundles and `pack-objects` output keep inflating for no reason.
2. **Every local-disk writer** (chosen) — pros: gc, `pack-objects` and `bundle-create` all get the measured savings class; `push` wire behaviour untouched / cons: three opt-in sites instead of one.
3. **All five including `push`** — pros: smallest packs everywhere / cons: needs `ofs-delta` gated on capability negotiation; the failure mode is a rejected push against an old server.

## Decision

**User-ratified.** Delta emission is a per-call option on `buildPack`, defaulting to off.
The three gc pipeline sites, `pack-objects` and `bundle-create` opt in. `push` does not:
its pack stays base-only, so `receive-pack-client.ts`'s self-contained-pack invariant and
the un-advertised `thin-pack` capability both hold unchanged. The option is a capability,
not a policy — callers choose, `buildPack` never infers from context.

## Consequences

Three write paths shrink into the measured savings class. The push path is unchanged and
carries no new negotiation risk. Extending to `push` later is a contained follow-up that
needs its own capability design, not a rework of the packer.
