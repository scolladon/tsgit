# 697 — The protocol-v0 `object-format` gap is closed

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/sha256-object-format.md (candidate D8) · **Refines:** ADR-681, ADR-695

## Context

> **Naming, corrected before merge.** This ADR uses git's own vocabulary, in which the pre-v2
> wire protocol is "v0". **tsgit does not use that name.** The codebase types the legacy protocol
> as **v1** — `export type FetchWireVersion = 1 | 2`
> (`src/application/commands/internal/fetch-negotiation.ts`). Everywhere below, read "v0" as
> tsgit's `FetchWireVersion === 1`. Implementation and tests must use the repository's own
> vocabulary, not git's; the ADR filename is left unchanged because other documents cite it.

tsgit neither reads nor sends the `object-format` capability on the legacy protocol. Today that is
inert, because tsgit is SHA-1 only. Under ADR-681 it becomes a hole: a v0 SHA-256 peer would be
silently accepted, and the mismatch refusal of ADR-695 would never fire on that path.

## Options considered

1. **Close it** — read and send `object-format` on v0 (design recommendation) — pros: the
   mismatch refusal becomes total across protocol versions / cons: a small change on a legacy
   protocol path.
2. **Push only** — cons: leaves the fetch direction silently accepting a mismatched peer, which
   is the dangerous direction.
3. **Leave it and document** — cons: documents a silent-acceptance hole rather than fixing it,
   in a change whose whole purpose is removing silent misreads.

## Decision

**Option 1 — adopted as recommended (no user judgment).**

Protocol v0 reads and sends `object-format` in both directions.

## Consequences

- ADR-695's refusal is reachable on every transport path, so "which format does this peer use"
  has one answer regardless of protocol version.
- v0 is legacy, but leaving a silent-acceptance path in a change premised on eliminating silent
  misreads would be self-defeating.
- The interop suite gains a v0 row alongside the v2 rows for the mismatch refusal.
