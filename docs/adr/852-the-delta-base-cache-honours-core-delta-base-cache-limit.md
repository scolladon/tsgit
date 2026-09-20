---
subjects:
  - src/application/primitives/pack-registry.ts
  - src/application/primitives/internal/object-caches.ts
supersedes:
  - adr: "736"
    scope: "the delta-base cache's default sizing rule and the documented family total"
---
# 852 — The delta-base cache honours `core.deltaBaseCacheLimit`, at git's default

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/session-caches-per-command-floor.md (D2, DC-2) · **Supersedes/Refines:** supersedes ADR-736 in scope

> **Correction (2026-09-14).** ADR-869 amends the family total stated in the Consequences. The
> parsed memo's valve is now charged at its measured cost, about 37.7 MiB at the 32 768-entry default
> instead of 16 MiB, so the documented worst-case additive footprint at the defaults is about
> **158 MiB** at sha1 — 16 MiB loose-object bytes, about 37.7 MiB parsed memo, 8 MiB FlatTree and
> 96 MiB delta bases — not 136 MiB. The delta-base cache's own sizing, the decision of this record,
> is unchanged.

## Context

`createPackRegistry` sizes the delta-base cache at `ctx.deltaCache.maxSize` — 16 MiB at the
default — an additive budget deliberately equal to the loose-object byte cache's.

Git sizes the same cache from a config key: `core.deltaBaseCacheLimit`, documented as the
"maximum number of bytes **per thread** to reserve for caching base objects that may be
referenced by multiple deltified objects", default **96 MiB on all platforms** (verified against
git 2.55.0's own documentation). tsgit reads that key nowhere. A user who has tuned it in their
`.git/config` — the supported way to tune exactly this cache — is silently ignored.

That is a config-surface divergence rather than an output one: no object bytes, ref contents or
refusal changes with the cache's size. It is nonetheless a key git honours and tsgit does not,
and the sizing decision cannot be revisited honestly without deciding whether to read it.

The two are separable: whether to honour the key, and what to use when it is absent.

## Options considered

1. **Honour the key, at git's 96 MiB default, on every adapter** (chosen) — pros: full parity on
   a documented knob, one rule to state and to test, no adapter gate to keep in sync. Cons: a
   browser tab can then retain about 120 MiB of caches.
2. **Honour the key, keep a 16 MiB default** — pros: keeps the family ceiling near today's.
   Cons: a repository with no config set behaves unlike git on chain-heavy reads, which is the
   case the key exists for.
3. **Honour the key, git's default on Node only, derived elsewhere** — pros: parity where git
   actually runs; browser stays small. Cons: two rules, and the adapter gate is a second place
   for the default to drift.

## Decision

**Option 1.** The delta-base cache reads `core.deltaBaseCacheLimit` when present and uses it;
when the key is absent the default is git's **96 MiB, on every adapter**, with no adapter gate.
`createPackRegistry` therefore performs a config read at construction time. Under ADR-850's
epoch that read is stat-free whenever a gate has already run in this command, so the new
dependency costs a parse, not a round trip. `deltaBaseCachingEnabled` remains the gate for the
whole family, so the zero-budget audit Context used by `fsck` is unaffected.

A caller who needs a smaller ceiling than git's has two levers, in this order: the
`core.deltaBaseCacheLimit` key, exactly as with git, or the explicit `deltaBaseCacheMaxBytes`
option.

## Consequences

The documented worst-case additive footprint of the cache family rises to roughly **136 MiB** at
the defaults — 16 MiB loose-object bytes, a 16 MiB memo valve, 8 MiB FlatTree (ADR-851) and
96 MiB of delta bases — against about 34 MiB before. A reader tuning for a memory-constrained
host must now budget from that number.

Two differences from git are worth stating plainly rather than discovering later. Git's 96 MiB is
**per thread in a process that exits when the command ends**; a tsgit `Context` can live for the
lifetime of a server or a browser tab, so the same number is held for longer here. And a browser
tab is not a platform git runs on at all, so "all platforms" in git's documentation says nothing
about it. Both were weighed and the parity rule was chosen over an adapter gate; if a profile
later shows a real problem on a constrained host, option 3 is the recorded fallback and needs no
new decision beyond picking the gate.

Carried forward from ADR-736: the delta-base cache is a **separate, additive** budget and not a
fraction of any sibling; `DELTA_BASE_CACHE_MAX_ENTRIES` still bounds entry count independently of
bytes; and `deltaBaseCacheEntrySize` keeps its fixed overhead term for the key string, the LRU
node and the entry wrapper. Superseded from ADR-736: the default sizing rule
(`ctx.deltaCache.maxSize`), the claim that `deltaCacheMaxBytes` is the one knob scaling this
particular cache, and the documented ~34 MiB family total.
