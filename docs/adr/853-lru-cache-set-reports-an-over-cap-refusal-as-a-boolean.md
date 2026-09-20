---
subjects:
  - src/domain/storage/lru-cache.ts
---
# 853 — `LruCache.set` reports an over-cap refusal as a boolean

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/session-caches-per-command-floor.md (D1, DC-3) · **Supersedes/Refines:** none

## Context

`LruCache.set` returns `void`. When an entry's `byteSize` exceeds the cache's whole budget it
returns without storing anything and without evicting anything — the one path that leaves the
cache exactly as it was. Two shipped caches were sized under their real workload and every
single `set` was refused; both were dead for months, and the silence is why. A cache that is
merely slow reports itself in a profile; a cache that stores nothing reports itself nowhere.

Making the refusal observable is the structural half of that fix. The question is what shape the
report takes, on a **public** type — `LruCache` is reachable through `Context.deltaCache`, so any
signature change regenerates the API report.

## Options considered

1. **`set(): boolean`**, refusal is `false` (chosen) — pros: smallest public surface; the eight
   call sites that do not care are unchanged. Cons: `toBe(false)` at an assertion does not say
   why; a third verdict later would be a breaking change.
2. **Typed verdict `'stored' | 'refused'`** — pros: self-documenting at the call site,
   extensible. Cons: one more exported type name in the public surface.
3. **Boolean plus a `refusedCount` counter** — pros: enables a runtime health probe. Cons: adds
   mutable state to the cache with no consumer that reads it.

## Decision

**Option 1.** `set(key, value, byteSize)` returns `true` when the entry is resident afterwards and
`false` when it was refused because `byteSize` exceeds the whole budget. It still throws on a
non-positive `byteSize` — a refusal is a sizing fact, a zero size is a caller bug, and the two
stay distinguishable. Callers that ignore the value are unchanged in behaviour.

**The loudness that matters is in the tests, not at runtime.** An over-cap entry is legitimate —
a two-million-file monorepo's HEAD tree, a 64 KiB commit message — so no call site throws, logs
or degrades on `false`. What makes a dead default impossible to ship again is a unit test per
derived cache asserting `true` for a realistic input at the default budget and `false` under a
deliberately shrunk budget, alongside ADR-851's valve-ordering invariant.

## Consequences

`reports/api.json` regenerates. Nine `set` call sites compile unchanged; two — the FlatTree cache
and the parsed-object memo — gain the assertions above. The delta-base cache's own call site can
never see `false`, because the delta-base cache's per-chain insert budget (design D3-i) is
strictly tighter than the whole-budget refusal and runs first.

Rejected alternatives and why, so they are not re-proposed: throwing (a large blob is not an
error), a logger channel (no logger exists in the port set at this layer), and a counter (no
runtime consumer). Adding a third verdict later is a breaking change to a public type; that cost
was accepted in exchange for the smaller surface.
