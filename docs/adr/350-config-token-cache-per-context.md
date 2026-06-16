# ADR-350: Cache the config token stream per-Context alongside the parsed config

## Status

Accepted

## Context

ADR-348's eager `core` path-likes guard runs `findFirstValuelessEntry` at the start of essentially every command. That helper (and its wildcard sibling `findFirstValuelessInSection`, ADR-349) does an **independent, uncached** `fs.readUtf8` of `.git/config` + a full char-wise `tokenizeConfig` — the cold-path re-read 24.9l designed for the refusal-only path. ADR-348 moved it onto the hot path of every command, so each guarded command now reads + tokenizes `.git/config` twice: once via the cached `readConfig` (inside `assertRepository`'s neighbourhood) and once via the guard.

`readConfig` caches `Promise<ParsedConfig>` per-`Context` in a WeakMap (single-flight; `invalidateConfigCache` on write, `__resetConfigCacheForTests` for tests). But it caches only the *parsed* result — and `ParsedConfig` erases valueless string fields (ADR-315 D4), so the cached parse genuinely cannot answer "is this key valueless / at which line". That is why the guard re-reads raw. `loadConfig` already tokenizes once (`parseConfigText` → `parseIniSections` → `tokenizeConfig`); the token stream — which retains `value === null` and `startLine` — is thrown away after parsing.

The per-command double-read is negligible at realistic config sizes (low tens of µs), but it is a fixed per-command tax that the perf review flagged, and the token stream needed to remove it is already produced.

## Decision

Extend `readConfig`'s per-`Context` cache value from `Promise<ParsedConfig>` to a pair holding **both** the parsed config **and** the token stream (and the source path) produced by the single `loadConfig` tokenize. `findFirstValuelessEntry` and `findFirstValuelessInSection` consult the cached tokens instead of issuing a fresh `fs.readUtf8` + `tokenizeConfig`.

- **One cache, one read, one invalidation point.** A config write's `invalidateConfigCache` (and `__resetConfigCacheForTests`) clears the parsed config and the tokens atomically — there is no second map to drift out of sync. This is why the single-value pair is chosen over a parallel token WeakMap or a derived `valuelessEntries` list.
- **Behavior-identical.** The guards produce the same `{ key, source, line }` for every input: tokens retain `value === null` (null-only detection) and `startLine` (the reported 1-based line), and the source path is the same `${commonGitDir}/config`. A missing config file caches the "no tokens" state exactly as the raw re-read returned `undefined`.
- **Porcelain `config` exemption unaffected.** It is the *guard* that is omitted from the `config` command (ADR-348), not the cache; caching tokens does not make `config` refuse.

## Consequences

### Positive

- Collapses the per-command double-read to a single read+tokenize; `pull`'s repeated core scans (and fetch/merge's) all share the one cached token stream via the shared `Context`.
- No `ParsedConfig` shape change, no new error code, no public surface change. The finders keep their signatures.

### Negative

- The cache value grows from a parsed object to a `{ parsed, tokens, source }` pair (a modest, bounded memory increase per live `Context` — the tokens are already computed transiently). The invalidation path must clear the pair as a unit (it does — single map).

### Neutral

- A future non-guard token consumer can reuse the cached stream; not built now (YAGNI), but the single-source-of-truth shape does not preclude it.
