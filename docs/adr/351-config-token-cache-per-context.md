# ADR-351: Cache the config token stream per-Context alongside the parsed config

## Status

Accepted (closes backlog 26.9)

## Context

24.9r (#179) shipped an eager `[core]` path-like valueless gate (`assertOperationalRepository` → `assertNoValuelessCorePaths` → `findFirstValuelessEntry`) that runs on essentially every operational command. `findFirstValuelessEntry` (`config-read.ts`) does an **independent, uncached** `readRawConfig` + `tokenizeConfig` of `${gitDir}/config` every call — duplicating the read+tokenize `readConfig` already performed (it caches `Promise<ParsedConfig>` per-Context in a WeakMap, then discards the token stream after building `ParsedConfig`). The per-command double read+tokenize is ~80µs (syscall-dominated) — negligible per command but pure avoidable duplication on the hot path. 24.9r deferred this as backlog 26.9 because it touches the heavily mutation-tested config-read cache.

26.9 also records a trap: the cheaper-looking "skip the gate when `ParsedConfig.core` is absent" short-circuit is **unsound** — a `[core]` section holding only a valueless string-typed key yields `core === undefined`, the exact case the gate must fire on. The token-cache approach avoids that trap entirely (it inspects the raw tokens, which retain the valueless key).

## Decision

Extend `readConfig`'s per-Context cache value from `Promise<ParsedConfig>` to a pair holding **both** the parsed config **and** the token stream (and the source path) produced by a single `loadConfig` tokenize. `findFirstValuelessEntry` consults the cached tokens instead of issuing a fresh `readRawConfig` + `tokenizeConfig`.

- **One cache, one read, one invalidation point.** `invalidateConfigCache` and `__resetConfigCacheForTests` clear the parsed config and the tokens atomically — no second map to drift. This single-value pair is chosen over a parallel token WeakMap (drift risk) or a derived `valuelessEntries` list (couples the cache to one consumer).
- **One tokenize.** `loadConfig` tokenizes once; a small `parseIniSectionsFromTokens` extraction lets the parse reuse those tokens rather than re-tokenizing inside `parseIniSections` (which stays exported and behaviour-identical for its other callers).
- **Behaviour-identical.** `findFirstValuelessEntry` produces the same `{ key, source, line }` for every input — tokens retain `value === null` (null detection) and `startLine` (the reported line); a missing config caches the "no tokens" state exactly as the raw re-read returned `undefined`.

## Consequences

### Positive

- Collapses the per-command double read+tokenize to one; the eager `[core]` gate (and every other `findFirstValuelessEntry` consumer) serves from the cached tokens via the shared Context.
- No `ParsedConfig` shape change, no new error code, no public surface change; `findFirstValuelessEntry` keeps its signature.

### Negative

- The cache value grows from a parsed object to a `{ parsed, tokens, source }` pair (a modest, bounded memory increase per live Context — the tokens were already computed transiently). Invalidation must clear the pair as a unit (it does — single map).

### Neutral

- Behaviour-preserving, so the change is exercised by the existing finder/cache tests passing unchanged plus a new read-count (cache-reuse) test; it lands with the heavily mutation-tested cache, so the diff is mutation-scoped tightly.
