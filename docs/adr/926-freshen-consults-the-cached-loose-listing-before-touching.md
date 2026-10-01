---
subjects:
  - src/application/primitives/internal/freshen-object.ts
  - src/application/primitives/internal/loose-oid-cache.ts
---
# 926 — Freshen consults the cached loose listing before touching a file

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-14) · **Supersedes/Refines:** refines ADR-922, ADR-509

## Context

git's loose freshen calls `utime()` on each source's candidate path and treats failure as
absent. tsgit already keeps a per-fanout-dir loose-oid listing per source (ADR-509).

## Options considered

1. **Consult the cached fanout listing; call `utimeNow` only on a hit** (recommended) — cons: a loose copy written by another process after the listing was cached is missed, so a local duplicate is written.
2. **Call `utimeNow` directly in every source, as git** — cons: one failing call per source for every brand-new object.

## Decision

**User-ratified — option 1.** The only observable difference is a rare, harmless duplicate
loose copy in the primary when the cache is stale; the object's bytes and every read answer are unchanged.

## Consequences

- No extra syscall per source on the common write of a brand-new object.
