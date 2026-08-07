# 573 — A refused pack degrades per-pack: skip, log, continue

- **Status:** accepted (adopted-as-recommended, no user judgment)
- **Date:** 2026-08-07
- **Design:** docs/design/pack-v3-read-compliance.md · **Supersedes/Refines:** refines ADR-226

## Context

When the local-open gate (ADR-572) refuses a pack, something must happen to the in-flight
object lookup. Git's pinned behaviour (Pin C) treats the refused pack as absent per pack:
its objects report *missing*, a sibling pack still serves the same oid, the process stays
alive, and every unrelated read is untouched.

## Options considered

1. **Pack-scoped skip** (designer's recommendation) — `lookup` continues to the next pack;
   the object resolves as `OBJECT_NOT_FOUND`; the reason goes to `ctx.logger?.warn?.` with
   the pack name. Pros: exactly Pin C2/C3/C4 / cons: the reason stops at the logger.
2. **Propagate the typed `INVALID_PACK_HEADER`** to the caller — pros: loud / cons: a
   prime-directive violation — one byte in one pack turns every unrelated read into a hard
   failure.
3. **Hybrid** (skip while another source serves, throw when nothing can) — cons: no git
   analogue; git says `missing` in precisely the case this would throw.

## Decision

Adopted as recommended: pack-scoped skip. The skip is not a swallowed error — the
structured reason reaches the Logger port (the `fetch.prune` precedent), which sanitises
and never throws. `withLazyFetchRetry` and `fetchMissing` inherit the correct "absent"
view for free.

## Consequences

A walk over a repo containing a refused pack emits one warn per lookup hitting that pack's
index (git prints one `error:` line per request for the same reason — faithful and loud).
The interop pair I-4/I-5 makes this decision falsifiable: propagation would fail I-5.
