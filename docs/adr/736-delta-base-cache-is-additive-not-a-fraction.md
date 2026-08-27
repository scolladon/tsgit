---
subjects:
  - src/application/primitives/pack-registry.ts
  - src/application/primitives/object-resolver.ts
---
# 736 — The delta-base cache is a separate, additive budget — not a fraction

- **Status:** accepted
- **Date:** 2026-08-27
- **Design:** docs/design/perf-remediation-2026-08.md · **Supersedes/Refines:** none

## Context

`createPackRegistry` sizes `deltaBaseCache` — the offset-keyed cache of reconstructed
OFS/REF-delta intermediates — at `ctx.deltaCache.maxSize`, the SAME size as the ordinary
loose-object byte cache. The code comment removed by this ADR claimed this was a "shared
budget"; it is not. `deltaBaseCache` is a second, independent `LruCache` instance with its own
`currentSize` accounting — the two caches' combined worst-case footprint is additive
(`deltaCacheMaxBytes` × 2), not a single shared ceiling.

This sits alongside two siblings that DO size themselves as a fraction of `deltaCacheMaxBytes`:
the parsed-object memo (ADR-727, 1/16) and the FlatTree cache (ADR-726, 1/16). With every cache
at its default, the true additive total a Context can retain is:

| cache | default size |
|---|---|
| `ctx.deltaCache` (loose-object bytes) | 16 MiB |
| parsed-object memo (ADR-727) | 1 MiB (1/16) |
| FlatTree cache (ADR-726) | 1 MiB (1/16) |
| `deltaBaseCache` (this ADR) | 16 MiB (1×, not a fraction) |
| **total** | **~34 MiB** |

Neither ADR-726 nor ADR-727 was wrong about ITS OWN cache — each really is sized as a fraction,
exactly as documented. The gap is that no ADR previously stated the delta-base cache's own
sizing decision, or the combined total across all four caches.

## Options considered

1. **Size `deltaBaseCache` as a fraction of `deltaCacheMaxBytes`**, matching its siblings, so
   `deltaCacheMaxBytes` becomes close to a true ceiling on this whole cache family. Cons: no A/B
   measurement exists for what fraction is safe — the cache's job (surviving mid-OFS-chain
   intermediates for the walk currently reconstructing them, per ADR-720/F10) is different in
   kind from the parsed-object memo's (skipping a re-parse across unrelated reads), and shrinking
   it without measurement risks quietly regressing the deep-delta-chain reads (`blame`,
   `log --follow`) it exists to help.
2. **Keep it additive, at its current size, and document the true total** (recommended, chosen).
3. **Keep it additive, but at a smaller absolute default** (e.g. a fixed 4 MiB regardless of
   `deltaCacheMaxBytes`). Cons: breaks the existing precedent that `deltaCacheMaxBytes` is the one
   knob that scales every cache in this family, for no measured benefit.

## Decision

**Option 2.** `deltaBaseCache` stays sized at `ctx.deltaCache.maxSize` — a full, additional
budget, not a share. The misleading "shared budget" comment is replaced with one stating the
additive relationship explicitly. An entry cap (`DELTA_BASE_CACHE_MAX_ENTRIES = 65_536`,
matching the parsed-object memo and the commit-graph header cache) is added — the byte cap alone
does not defend against a repo of many small, cheap intermediates outrunning entry-count-bound
memory (V8 object/Map overhead per entry, not reflected in the byte accounting). The entry sizer
(`deltaBaseCacheEntrySize`) gains a `DELTA_BASE_CACHE_ENTRY_OVERHEAD_BYTES = 200` fixed term,
accounting for the `${packName}:${offset}` key string, the LRU's own node object, and the
`{ type, content, chainDepth }` wrapper — none of which the raw content byte length reflected.

## Consequences

The documented default total footprint across this cache family is ~34 MiB, not the ~16 MiB
`deltaCacheMaxBytes` alone would suggest — a reader tuning `deltaCacheMaxBytes` down for a
memory-constrained host (e.g. a browser tab) should budget for roughly 2.1× that number, not the
literal value. If a future profile shows `deltaBaseCache` at its full additive size is a real
memory problem on such a host, option 1 (a real fraction) remains available — this ADR's Option 1
is the recorded fallback, gated on running the same kind of A/B ADR-727 already did for its own
fraction (1/16, 1/8, 1/4) before picking a value.
