---
subjects:
  - src/application/primitives/object-store.ts
  - src/application/primitives/pack-registry.ts
  - src/application/primitives/internal/loose-oid-cache.ts
  - src/application/primitives/internal/midx-source.ts
  - src/application/primitives/path-layout.ts
---
# 918 — Each object directory is an explicit object source

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-5) · **Supersedes/Refines:** none

## Context

Today the pack registry, midx and loose cache assume one objects directory. git looks up each
source in order — primary packs, primary loose, then each alternate's packs and loose — and a
corrupt alternate midx is fatal only once the lookup reaches that source (Pins M2/M3).

## Options considered

1. **Explicit `ObjectSource`/`SourceLocation` threaded into `createPackRegistry` and the loose cache; an `ObjectStore` memo per session; `getPackRegistry` stays primary** (recommended).
2. **A per-source derived `Context` via `deriveContext`** — cons: re-reads config or needs a keep-session exception.
3. **One merged registry over all sources** — cons: falsified by Pins M2/M3; erases local vs non-local.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Lookups iterate sources in git's
depth-first pre-order; a source is never consulted before every earlier source has missed. A
repository without alternates iterates a one-element source list.

## Consequences

- Hot-path shape changes (loop + store indirection): a `bench:ab` row is required.
- A full miss re-prepares every source's packs and forgets the missed prefix in every source.
