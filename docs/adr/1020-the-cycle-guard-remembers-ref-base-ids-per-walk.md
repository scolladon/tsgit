---
subjects:
  - src/application/primitives/object-resolver.ts
  - src/application/primitives/read-object.ts
  - src/application/commands/internal/fsck/object-cache.ts
---
# 1020 — The cycle guard remembers REF base ids per walk

- **Status:** accepted
- **Date:** 2026-10-20
- **Design:** docs/design/lift-delta-chain-read-cap.md (DC-2, §2) · **Supersedes/Refines:** refines ADR-1019

## Context

ADR-1019's guard G2 must remember what a walk has visited so a REF_DELTA cycle is caught. The
resolver's REF hop recurses through six async frames carrying `externalDepth`; the two header
walkers loop. The hot path — `git repack`, `git gc` and tsgit's own writer all emit OFS_DELTA
only (`repack.useDeltaBaseOffset` defaults true) — must not pay for a guard aimed at a shape
only a hand-built `.idx` produces.

## Options considered

1. **Per-walk set of REF base ids** (recommended), created lazily on the first REF hop and
   passed down the recursion in place of `externalDepth` — pros: design §2 shows every cycle
   contains a REF hop, so REF base ids suffice; OFS-only chains allocate nothing / cons: one more
   parameter on the resolver's internal signatures.
2. **Hop counter bounded by the store's total entry count** — pros: no allocation, keeps the
   existing plumbing / cons: detects a 2-cycle only after Σ entries hops, each inflating and
   retaining an instruction stream — the heap-exhaustion loop again, merely bounded.
3. **Per-walk set of every visited (pack instance, offset)**, OFS hops included — pros: catches
   every repeat without reasoning / cons: a set insertion per OFS level on the hottest read path,
   to catch cycles G1 already makes impossible.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** G2 is a per-walk set of REF base ids,
created on the first REF hop, passed down the REF recursion in the resolver and kept walk-local
in the two header walkers. Detection fires on the second visit of the first repeated id, after at
most one trip round the cycle. The set is per read — two concurrent reads never share one — so it
is not shared mutable state.

## Consequences

An OFS-only read allocates nothing new. The `externalDepth` parameter's slot on the six resolver
functions becomes the walk memory (ADR-1025 deletes the depth itself). A REF chain whose base id
is also stored in a second pack still resolves: the lookup is deterministic, so an acyclic walk
never repeats a REF base id however many copies exist.
