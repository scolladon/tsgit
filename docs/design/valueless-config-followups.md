# Design — valueless-config-followups

> Brief: three independent deltas #179 (24.9r, ADRs 346–350) left open on its own base — **A** a per-Context config token cache (closes backlog 26.9; behaviour-preserving perf), **B** eager all-`[merge *]` driver valueless validation (closes 24.9v; faithfulness, more refusals), **C** empty-string `core` path-like feature-off handling (#179 missed it; faithfulness fix, no ADR). B and C are re-pinned against real git on this base; A is structural. New ADRs start at **351**.
> Status: draft → self-reviewed ×3 → ready for ADR conversation

## Context

#179 (24.9r) landed the remaining string-typed valueless refusal under ADRs 346–350. The as-landed shape on **this** base (which the brief's reference design — a parallel, non-merged 24.9r — does NOT match; its symbol names and placements differ) is:

- `src/application/primitives/internal/valueless-config-guard.ts` — `assertNoValuelessConfig(ctx, section, subsection, keys)`: throws `CONFIG_MISSING_VALUE { key, source, line }` for the FIRST valueless key (by config-file line) among `keys` under `[<section> "<subsection>"]`. The detection is `findFirstValuelessEntry` in `config-read.ts` (cold-path re-tokenize: a fresh `readRawConfig` + `tokenizeConfig` per call), with `subsection` an **exact-match filter** (`matchesSection`: `tokenSubsection === subsection`) — **there is no subsection-wildcard finder on this base** (confirmed: only `findFirstValuelessEntry` exists).
- `src/application/primitives/internal/repo-state.ts` — `assertOperationalRepository(ctx)` = `assertRepository` then `assertNoValuelessCorePaths` (the eager `[core]` gate, scanning `['excludesfile','attributesfile']` only). It is the operational entry point of the whole command surface (~50 call sites across the command set). `core.hookspath` is NOT in this broad pair — it refuses **per-accessor** in `run-hook.ts` `invokeHook` (`assertNoValuelessConfig(ctx,'core',undefined,['hookspath'])`, ADR-350). The porcelain `config` command stays on the bare `assertRepository` (ADR-346 split: porcelain survives a valueless `[core]`).
- `src/application/primitives/resolve-merge-driver.ts` — `namedChoice(ctx, name)` guards `assertNoValuelessConfig(ctx,'merge',name,['driver','name'])` only for the **attribute-selected** driver (reached only when a path's `merge=<name>` attribute resolves the named branch). This is 24.9r's documented merge under-refusal — the B target.
- `src/application/primitives/config-read.ts` — `readConfig` caches `Promise<ParsedConfig>` in a `WeakMap<Context, …>` (L52); `invalidateConfigCache(ctx)`/`__resetConfigCacheForTests()` are the cache invalidation calls. `loadConfig` does one `readRawConfig` + `parseConfigText` (`→ parseIniSections → tokenizeConfig`), keeps the parsed result, and **discards the token stream**. The merge layer erases every valueless string field to absent (`if (value === null) …` skip), so a `ParsedConfig` consumer cannot distinguish absent from valueless — the guards must re-read raw tokens.

ADR-226 (prime directive) binds observable behaviour byte-for-byte; ADR-249 refines it: faithfulness binds **data + on-disk state + refusal conditions**, not rendered stdout. The library emits the structured `CONFIG_MISSING_VALUE { key, source, line }`; each interop test reconstructs git's two display lines from those fields.

This design covers three deltas that build on that as-landed state. They are independent (A is pure perf, B adds refusals, C fixes a pre-existing empty-string divergence) and can land in any order, but A is sequenced first (the cache the wildcard scan B introduces should consume) and the doc keeps them as separate slice families.

### What B and C forced us to re-pin (this base, real git 2.54.0)

The reference design pinned its M4 / E3a–E3c-dist matrix against a *different* base. The prime directive (`CLAUDE.md`: "never trust cross-base; re-pin against real git here") requires re-confirmation. Both matrices below were produced fresh in `mktemp -d` throwaways on this machine's git 2.54.0; the worktree `.git/config` was spot-checked intact (`remote.origin.url` unchanged) afterwards. The conclusions match the reference — recorded here as the authoritative pins for this PR.

## Requirements

1. **A (token cache, 26.9):** `findFirstValuelessEntry` reuses a config token stream cached per-`Context` alongside `ParsedConfig`, populated by a single tokenize, invalidated in lockstep with `readConfig` (`invalidateConfigCache` / `__resetConfigCacheForTests`). **Behaviour-identical:** the same `{ key, source, line }` for every config input; the eager `[core]` gate stops double-reading the file on every operational command. The 26.9 "skip the gate when `ParsedConfig.core` is absent" short-circuit is NOT taken — it is unsound (a `[core]` holding only a valueless path-like yields `core === undefined`, the exact case the gate must fire on); the token-cache approach avoids needing it.
2. **B (eager merge-driver, 24.9v):** any real 3-way **content** merge of a path refuses on the FIRST valueless `merge.<d>.driver`/`name` by config-file line across **all** `[merge *]` subsections — independent of whether any path resolves `merge=<d>` and independent of whether the merge auto-resolves or conflicts (M4). It stays **lazy** (no die on `status`/`log`/`add`/fast-forward merge — M3). The refusal carries `CONFIG_MISSING_VALUE { key, source, line }`, exit 128, reconstructing git's two lines.
3. **C (empty-string path-likes):** an empty-string (valued `''`, not null) `core.excludesFile`/`attributesFile`/`hooksPath` is treated as **feature-OFF** (exit 0), matching git — distinct from the **valueless** (null) refusal (unchanged) and, for `hooksPath` only, distinct from **absent** (absent fires the default-dir hook; empty fires nothing — E3c-dist). No `ParsedConfig` change; the fix is purely at the three consumers.
4. **Valueless ≠ absent ≠ empty-string** stays the universal boundary: only present-but-null refuses (A and C both preserve this); B fires only on null in `[merge *]`; C handles only `''`.
5. **Porcelain `config` reads stay faithful** (ADR-314): `--get`/`--list` succeed on a valueless or empty key (A keeps the guard out of `readConfig`/`config`; C does not touch porcelain). Pinned E3a-cfg.
6. A new backlog id is proposed for C (no id today); B closes 24.9v; A closes 26.9.

## Design

### Pinned git behaviour (git 2.54.0; `env -i`-style — all `GIT_*` scrubbed, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, signing off; valueless/empty lines written directly into `<tmp>/.git/config` in a `mktemp -d` throwaway) — authoritative for this base

#### B — `merge.*.driver`/`name` (closes 24.9v)

| # | Config (in `.git/config`) | Command | git stderr / result | exit | Conclusion |
|---|---|---|---|---|---|
| **M4** | `[merge "custom"]` / `driver` (valueless, line 14), **NO `.gitattributes` referencing `custom`** | `git merge other` where both sides edit `f.txt` on **non-overlapping** lines (**auto-resolves, no conflict**) | `error: missing value for 'merge.custom.driver'` / `fatal: bad config variable 'merge.custom.driver' in file '.git/config' at line 14` | 128 | **ANY real 3-way content merge of a path dies, even when (a) no path resolves `merge=custom` and (b) the merge auto-resolves with no conflict.** Trigger is "a path enters content merge", not "a conflict occurs". |
| **M-conflict** | as M4 but both sides edit the **same** line (conflicts) | `git merge other` | `… 'merge.custom.driver'` … `at line 14` | 128 | the die is the valueless driver loading, not the conflict — fires on conflicting merges too. |
| **M2** | `[merge "custom"]` / `driver = cat %A` (line 14) / `name` (valueless, line 15) | `git merge other` (content merge) | `… 'merge.custom.name'` … `at line 15` | 128 | valueless `name` dies too (driver valued). |
| **M-order** | `[merge "zzz"]` / `name` (valueless, line 14) + `[merge "aaa"]` / `driver` (valueless, line 16) | `git merge other` (content merge) | `… 'merge.zzz.name'` … `at line 14` | 128 | **across all `[merge *]` subsections, FIRST valueless by file line wins** (`zzz.name` reported though `aaa` is the lexically-first / driver key). Confirms scan-all-subsections, file-order. |
| **M-tree** | `[merge "custom"]` / `driver` (valueless, line 14), no attribute | `git merge-tree --write-tree main other` (no worktree) | `… 'merge.custom.driver'` … `at line 14` | 128 | the no-worktree tree merge dies identically — the die is at the `[merge *]` table load, not a worktree write. |
| **M3** | `[merge "custom"]` / `driver` valueless | `git status --porcelain`, `git log -1`, `git add`, **fast-forward `git merge ff`** (only one side advanced) | (no die) | 0 | **lazy** — the `[merge *]` table is read only when a real 3-way content merge runs for some path; not in default config, not on read commands, not on a fast-forward (no content merge). |

**Conclusion (B):** git loads the WHOLE `[merge *]` table at content-merge time and dies on the first valueless `driver`/`name` by file line, independent of attribute resolution and of conflict-vs-auto-resolve. tsgit's `namedChoice` guard fires only when a `merge=<name>` attribute resolves a path — so it MISSES every content merge that does not carry a custom `merge=` attribute (the common case M4). This is the documented 24.9v under-refusal.

#### C — empty-string `core` path-likes feature-off

| # | Config (in `.git/config`) | Command | git result | exit | Conclusion |
|---|---|---|---|---|---|
| **E3a** | `[core]` / `excludesFile = ` (empty, has `=`) | `git status --porcelain` with an untracked `ignoreme.log` present | `?? ignoreme.log` (untracked shown, no global ignore loaded) | 0 | **empty `excludesFile` == absent: global-ignore feature OFF, not resolved as a literal path.** |
| **E3a-ctrl** | `[core]` / `excludesFile` (valueless, null, no `=`) | `git status --porcelain` | `error: missing value for 'core.excludesfile'` / `fatal: … at line 14` | 128 | **control — valueless (null) dies; empty (`''`) does not.** The boundary the C fix must respect. |
| **E3a-cfg** | `[core]` / `excludesFile = ` (empty) | `git config --list`, `git config --get core.excludesFile` | `--list` prints `core.excludesfile=` (empty value kept); `--get` prints an empty line | 0 | porcelain reads keep the empty value (ADR-314), unaffected by the fix. |
| **E3b** | `[core]` / `attributesFile = ` (empty) | `git status --porcelain`, `git checkout .` | no die; `checkout .` → `Updated 0 paths` | 0 | **empty `attributesFile`: attributes feature OFF, not a literal path.** |
| **E3c** | `[core]` / `hooksPath = ` (empty), blocking `.git/hooks/pre-commit` (`exit 1`) present | `git commit` | commit **SUCCEEDS** — the pre-commit hook does NOT fire | 0 | **empty `hooksPath`: hooks feature OFF — no hook fires.** |
| **E3c-dist (unset)** | NO `core.hooksPath`, same blocking `.git/hooks/pre-commit` | `git commit` | commit **BLOCKED** — the default-dir hook FIRES | 1 | **absent `hooksPath` ≠ empty:** absent fires the default `.git/hooks` hook. |
| **E3c-dist (explicit)** | `[core]` / `hooksPath = .git/hooks`, same blocking hook | `git commit` | commit **BLOCKED** — hook FIRES | 1 | explicit default dir fires; confirms empty is not "the default dir". |
| **E3c-dist (CWD)** | `[core]` / `hooksPath = ` (empty) + an executable `./pre-commit` in the worktree root | `git commit` | commit **SUCCEEDS** — the CWD hook does NOT fire | 0 | **empty `hooksPath` is NOT "resolve to CWD/worktree root" either** — it is genuinely "no hooks directory". |
| **E3-all** | `[core]` / all three (`excludesFile`/`attributesFile`/`hooksPath`) empty together | `status`, `log -1`, `rev-parse --git-dir`, `branch --list`, `cat-file -p HEAD`, `ls-files`, `stash list` | every command exits 0 | 0 | feature-off across the board; no command errors on any combination of empty path-likes. |

**Conclusion (C):** empty == absent for `excludesFile`/`attributesFile` (feature off). For `hooksPath`, empty ≠ absent: absent fires the default-dir hook (E3c-dist unset), explicit-default fires (E3c-dist explicit), but **empty fires nothing** and is **not** the CWD (E3c-dist CWD). The C fix must therefore treat empty `hooksPath` as a "no hooks directory" sentinel — never the `${gitDir}/hooks` default, never `${workDir}/`.

### A — per-Context config TOKEN cache (closes 26.9; behaviour-preserving perf)

**Problem.** `findFirstValuelessEntry` re-reads + re-tokenizes `${gitDir}/config` on every call. The eager `[core]` gate (`assertOperationalRepository → assertNoValuelessCorePaths → findFirstValuelessEntry`) runs on every operational command, in addition to the cached `readConfig(ctx)` the command's real work performs — one cached parse + one uncached tokenize of the same bytes per command. `loadConfig` already tokenizes the same bytes once (`parseConfigText → parseIniSections → tokenizeConfig`) but discards the token stream, and the guard cannot consume `ParsedConfig` because the merge layer erases `value === null` to absent (the very signal the guard needs).

**Goal.** Make `findFirstValuelessEntry` reuse an already-tokenized form, cached + invalidated in lockstep with `readConfig`, with **byte-identical guard results**: the same `{ key, source, line }` for every input. The token stream retains `value === null` and `startLine`, so detection and the reported line are preserved exactly — only *where the tokens come from* changes.

**Constraints (binding).**
- (a) **Behaviour-identical.** `findFirstValuelessEntry` keeps its exact `matchesSection` / lower-case-key / verbatim-subsection / first-by-line walk; only the token source changes from a fresh `readRawConfig` + `tokenizeConfig` to the cached stream. `source` stays `${commonGitDir(ctx)}/config` (the absolute path the tokens were read from) — and the file-absent path still returns `undefined` (today: `raw === undefined → undefined`).
- (b) **Shared lifetime + invalidation (the load-bearing correctness property).** The token cache is keyed on the same `Context` identity as `readConfig`'s WeakMap, populated single-flight (`Promise<…>`), and **dropped by the same two calls**: `invalidateConfigCache(ctx)` and `__resetConfigCacheForTests()`. A config write must invalidate parsed AND tokens together, or a guard could scan stale tokens after a write fixed/introduced a valueless key. The token cache must never outlive the parse cache.
- (c) **Porcelain `config` exemption unaffected.** The exemption is that `config` does not *call the guard* (it uses bare `assertRepository`). Caching tokens puts no throw near `readConfig`/`config`; no change to ADR-314 / E3a-cfg.
- (d) **Missing-file outcome cached** so the guard's "no config → no valueless → return `undefined`" path is preserved without a second `fs` hit.

**Recommended cache shape (see Decision candidate 1):** extend the existing `readConfig` WeakMap value from `Promise<ParsedConfig>` to one entry carrying both products:

```
interface ConfigCacheEntry {
  readonly parsed: ParsedConfig;
  readonly tokens: ReadonlyArray<ConfigToken>;   // [] when the file is absent
  readonly source: string;                       // the absolute config path the tokens came from
}
let cache: WeakMap<Context, Promise<ConfigCacheEntry>>;
// readConfig returns entry.parsed (unchanged public contract / return type).
// findFirstValuelessEntry consumes entry.tokens instead of re-reading + re-tokenizing.
```

`loadConfig` becomes "read raw once → tokenize once → assemble `parsed` from the tokens": a single `fs.readUtf8` + single `tokenizeConfig` feeds both the parser and the guard. **The single-tokenize seam needs a small refactor:** today `parseIniSections(text, source)` re-tokenizes internally (`for (const token of tokenizeConfig(text, source))` at config-read.ts L446), so `loadConfig` calling both `parseConfigText` and `tokenizeConfig` would tokenize twice. The fix is a token-taking assembler — extract `parseIniSectionsFromTokens(tokens)` (the existing `parseIniSections` loop minus its `tokenizeConfig` call), and have `loadConfig` tokenize once and feed the token array to BOTH the assembler and the cache entry; `parseIniSections(text, source)` stays as a thin `tokenizeConfig`→`parseIniSectionsFromTokens` wrapper for its other callers (writers). This keeps the public `parseIniSections`/`tokenizeConfig` exports unchanged. `invalidateConfigCache` / `__resetConfigCacheForTests` operate on the one WeakMap unchanged. `findFirstValuelessEntry` walks `entry.tokens` with its existing logic; an absent file is the cached `tokens: []` (and `source` still the would-be path), so `findFirstValuelessEntry` returns `undefined` (no matching section) exactly as today.

If the single-tokenize seam is judged out of scope for A (the refactor touches the heavily mutation-tested `parseIniSections`), the fallback is to cache the token array produced by ONE `tokenizeConfig` in `loadConfig` and let `parseConfigText` re-tokenize as it does today — the guards still stop double-reading the *file* (the syscall-dominated cost 26.9 names: "~80µs/command, syscall-dominated") and reuse the cached tokens, even though the parser re-tokenizes the already-read bytes. The cache-reuse test asserts the `fs.readUtf8` spy fires once (the binding win); the second in-memory tokenize is a smaller, optional follow-up. The plan picks based on the mutation-budget cost of touching `parseIniSections`; both are behaviour-identical.

**Why faithfulness-neutral.** No observable behaviour (refusal, key, line, exit, on-disk state) changes — the guard computes the identical answer from identical tokens, sourced from cache. The empty/absent paths are unchanged. Pure perf: the eager gate's per-command second read collapses into the cached one.

### B — eager all-`[merge *]` driver validation at the content-merge chokepoint (closes 24.9v)

**The primitive gap.** `findFirstValuelessEntry`'s `subsection` is an exact-match filter (`tokenSubsection === subsection`). M-order proves git scans ALL `[merge *]` subsections and reports the first valueless by file line, so the eager merge guard cannot be `assertNoValuelessConfig(ctx,'merge',<one-subsection>,…)`. **Add a subsection-wildcard finder** (porting the reference design's §0 shape onto this base):

```
// config-read.ts — sibling of findFirstValuelessEntry, same token walk, subsection wildcard
export const findFirstValuelessInSection = async (
  ctx, section, keys,
): Promise<ValuelessEntry | undefined> => { /* match ANY subsection of `section`
   (tokenSection.toLowerCase() === section.toLowerCase(), ignore tokenSubsection),
   lower-case the key, keep the matched subsection verbatim in qualifiedKey,
   first valueless by file line */ };
// valueless-config-guard.ts — thin wrapper, same shape as assertNoValuelessConfig
export const assertNoValuelessInSection = async (ctx, section, keys): Promise<void> => { … };
```

Once A lands, `findFirstValuelessInSection` consumes the cached token stream like `findFirstValuelessEntry` (a code-reviewer note for slice ordering — the wildcard finder is one walk over the same cached tokens, no extra read). The exact-subsection `findFirstValuelessEntry` is untouched (still used by `core`, `user`, `remote`/`pushurl`, the exact-subsection `branch`/`submodule` guards — all genuinely subsection-scoped).

**Placement — the content-merge chokepoint, once-lazily.** The single `ContentMerger` every 3-way consumer routes through is `buildContentMerger` (confirmed: `merge.ts:317` directly; `cherry-pick`/`revert`/`rebase`/`stash` via `apply-merge-to-worktree.ts:233,295`). Guard once, lazily, the first time the merger runs for a path:

```
export const buildContentMerger = (ctx, labels = DEFAULT_MERGE_LABELS): ContentMerger => {
  let providerPromise; const provider = () => (providerPromise ??= buildAttributeProvider(ctx));
  let driverGuard;                                   // once-latched
  const ensureNoValuelessMergeDriver = () =>
    (driverGuard ??= assertNoValuelessInSection(ctx, 'merge', ['driver', 'name']));
  return async (mergeCtx) => {
    await ensureNoValuelessMergeDriver();            // whole-table scan, all [merge *], first by line
    const [ours, theirs, base] = await Promise.all([ … ]);
    …existing per-path resolve + dispatch…
  };
};
```

This reproduces M4/M-conflict/M2/M-order/M-tree exactly: any path entering content merge triggers the whole-table scan (all `[merge *]` subsections, first valueless by file line), with no dependence on attribute resolution. It stays **lazy** (M3): `buildContentMerger` is *constructed* on every merge, but the returned closure (which holds the guard) is *invoked* only by the per-path merge loop for paths that need content merging — a fast-forward / no-content-merge merge invokes it for zero paths and never throws. The latch makes the table scan run at most once per operation regardless of path count. `merge-tree --write-tree` routes through the same merger (no worktree), so M-tree is covered.

**Reconciliation with `namedChoice` (Decision candidate 2).** The eager chokepoint scan **subsumes** `namedChoice`'s per-driver guard: it fires for ANY content merge before any specific driver resolves, so for any input where `namedChoice` would refuse (a path resolves `merge=<name>` and that section is valueless), the chokepoint scan already refused at line-order-first — the same or an earlier key. The candidate is whether to **remove** the `namedChoice` guard (subsumed, one chokepoint) or **keep** both (defence in depth). Recommendation in the table; the designer does not decide.

### C — empty-string `core` path-likes feature-off (no ADR; git is the spec)

Three consumer-side fixes, each treating empty-string as feature-off — distinct from the null refusal (unchanged) and, for `hooksPath`, distinct from absent.

- **`readGlobalExcludes` (`read-gitignore.ts` L40)** — empty == absent (E3a):
  ```
  const raw = config.core?.excludesFile;
  if (raw === undefined || raw === '') return undefined;   // empty == absent: global-ignore OFF
  ```
  This returns the same `undefined` the absent branch returns, before `expandUserPath(ctx,'')` (which returns `''`, not `undefined`) and `loadCappedUtf8(ctx,'',…)` (which `lstat('')`s) can mis-resolve.
- **`readGlobal` (`read-gitattributes.ts` L34)** — identical guard on `core.attributesFile` (E3b):
  ```
  const raw = (await readConfig(ctx)).core?.attributesFile;
  if (raw === undefined || raw === '') return undefined;   // empty == absent: attributes OFF
  ```
- **`resolveHooksDir` (`run-hook.ts` L20–31)** — empty `hooksPath` is feature-off, and per E3c-dist it is NOT the default dir and NOT `${workDir}/`. Today `hooksPath === ''` falls through every branch (`'' === undefined`? no; `''.startsWith('~/')`? no; `isAbsolutePath('')`? no) → returns `` `${workDir}/` `` (the worktree root — wrong). The fix: an empty `hooksPath` must make `runHook` find no hook (matching E3c: commit succeeds, no hook fires), and must NOT collapse to `${gitDir}/hooks` (which would re-enable the default hook the UNSET case fires — E3c-dist). The faithful constraint: **empty `hooksPath` ⇒ no hook fires, and it must NOT resolve to the default dir or the worktree root.** The concrete sentinel (e.g. resolve to a hooks dir guaranteed to hold no hook script, or signal "no hooks dir" up to the runner so the hook lookup short-circuits) is an implementation detail the plan pins against the E3c interop. This is the one path-like whose empty-handling is not simply "== absent", because for `hooksPath` absent ≠ off (E3c-dist).

**Why no `ParsedConfig` change.** The parser already keeps the empty string (`''` is valued; only `null` is dropped — confirmed in `applyCoreEntry`: `if (value === null) return undefined` then the string branches assign `value`, so `''` lands as `core.excludesFile = ''`). The fix is purely at the three consumers; no type, no merge-layer, no error-code change. The valueless refusal (null) is untouched — E3a-ctrl confirms null still dies, E3a confirms empty does not.

**No ADR (Decision candidate 3).** git is the unambiguous spec (the prime directive, ADR-226/249, already binds it): empty = feature-off, exit 0. There is no design *choice* to record (no alternatives to weigh — git's behaviour is the only faithful answer), only a matrix + a three-consumer fix. The one subtlety worth surfacing — empty `hooksPath` ≠ absent (E3c-dist) — is captured in this section and the E3c interop, not a separable decision. Contrast A and B, which embody genuine architectural choices.

### New backlog id for C

C has no backlog id. Proposed, in dependency order (a Wave-C faithfulness follow-up alongside the 24.9* family, independent of 24.9v/26.9):

> **24.9w** Empty-string `core` path-like feature-off parity — a valued-but-EMPTY (`''`, not null) `core.excludesFile`/`attributesFile`/`hooksPath` is feature-OFF in git (exit 0, no file loaded / no hook fired), but tsgit's consumers (`readGlobalExcludes`, `readGlobal`, `resolveHooksDir`) mis-resolve `''` as a literal path (`lstat('')`, or `${workDir}/` for hooks). Fix each consumer to treat empty as feature-off — `excludesFile`/`attributesFile` as `== absent`, `hooksPath` as a "no hooks dir" sentinel (empty ≠ absent: absent fires the default-dir hook). Distinct from 24.9r's valueless (null) refusal, which is unchanged. Pin with interop (E3a–E3c-dist). No ADR — git is the spec. _(surfaced by 24.9r's review; #179 missed the empty case.)_

The session places the id; the dependency note: independent of 24.9v and 26.9, lands with this PR.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **1 — A: token-cache shape** | How the already-tokenized config is cached so `findFirstValuelessEntry`/`findFirstValuelessInSection` reuse it, sharing lifetime + invalidation with `readConfig`. | **(a)** Extend the existing `readConfig` WeakMap value to `{ parsed, tokens, source }` — one map, one read, both products; `readConfig` returns `.parsed`, finders consume `.tokens`. **(b)** A second parallel WeakMap keyed on the same `Context` holding `Promise<tokens>`, populated alongside the parsed cache, invalidated in the same `invalidateConfigCache`/`__resetConfigCacheForTests`. **(c)** Cache a derived `valuelessEntries` list (pre-scanned candidates) instead of raw tokens. | **(a)** | Single source of truth, single read, single invalidation point — one WeakMap to clear, so parsed and tokens can never drift out of sync (the binding constraint b). `loadConfig` already tokenizes once, so the entry just keeps the array `parseIniSections` consumes. (b) duplicates the lifetime-coupling surface (two maps to invalidate atomically — a latent staleness bug). (c) over-specializes to today's key sets (each new family needs a re-scan / wider list) and bakes guard logic into the read primitive, closer to the porcelain `config` path the design keeps guard-free. |
| **2 — B: `namedChoice` reconciliation** | Whether the eager all-`[merge *]` chokepoint scan replaces or coexists with `namedChoice`'s per-driver guard. | **(a)** **Replace** — remove `assertNoValuelessConfig(ctx,'merge',name,['driver','name'])` from `namedChoice`; the chokepoint scan subsumes it (fires for any content merge, before a specific driver resolves, at line-order-first). **(b)** **Coexist** — keep both (chokepoint scan + `namedChoice` guard) as defence in depth. **(c)** Guard only in `namedChoice` with a subsection-wildcard pre-pass there (no chokepoint move). | **(a) Replace** | The chokepoint scan is reached on every content merge before `namedChoice` runs (`buildContentMerger`'s closure awaits the guard before the per-path resolve that calls `namedChoice`), and it scans all subsections first-by-line — so it fires for a strict superset of `namedChoice`'s cases, at the same or an earlier key. Keeping both (b) is dead defence (the second guard is unreachable when the first always fires first) and risks a divergent message if the two ever disagree on which key is "first". (c) cannot reproduce M4 (a content merge with no `merge=<name>` attribute never reaches `namedChoice`). Minimal + faithful = one guard at the chokepoint. |
| **3 — C: needs an ADR?** | Whether the empty-string path-like fix warrants an ADR. | **(a)** No ADR — faithfulness bug fix, git is the spec (matrix E3a–E3-all + interop are the record). **(b)** One ADR documenting empty=feature-off and the `hooksPath`-is-special nuance. | **(a) No ADR** | There is no design *choice* — git's empty=feature-off is the only faithful answer; ADR-226/249 already bind it; the matrix + interop pin and enforce it. The one subtlety (empty `hooksPath` ≠ absent) is captured in the design section and the E3c interop, not a separable decision. (Contrast A and B, which weigh genuine alternatives → candidates 1 and 2.) |

## Test strategy

Mutation-resistant per project conventions: assert `.data` fields **individually** via try/catch (never bare `toThrow(Class)`); one isolated test per guard condition; new code touched by the four property-test lenses gets a `*.properties.test.ts` sibling only if a lens fits (see below).

### A — token cache (unit only; behaviour-identical)

- **All existing** `findFirstValuelessEntry` / `assertNoValuelessConfig` / `assertNoValuelessCorePaths` / merge-guard / hook-guard tests pass **unchanged** — the behaviour-identity proof.
- **Cache-reuse test:** with a `Context` whose `fs.readUtf8` is a spy, call `readConfig(ctx)` then a finder (`findFirstValuelessEntry` / the eager `[core]` gate) on the same `ctx`; assert `fs.readUtf8` for the config path is invoked **once**, not twice (kills a "re-read per guard" regression). Pair: after `invalidateConfigCache(ctx)`, the next finder re-reads (spy count increments) — proves shared invalidation. A finder that runs *before* `readConfig` populates and serves the cache too (single source either way). File-absent: the cached `tokens: []` outcome is served without a second `fs` hit, finder returns `undefined`.
- No interop (no behaviour to pin; faithfulness-neutral by construction).

### B — eager merge-driver (unit + interop)

- **`findFirstValuelessInSection` / `assertNoValuelessInSection` (new primitive)**: a valueless key in subsection A reported when A is the only section; with subsections A (line m) and B (line n>m) both valueless, **A reported** (file-order discriminator, kills a fixed-subsection mutant); a valueless key in a non-matching *section* not reported; an empty-string (`= `) key not reported (null-only); case-folding (section/key lower-cased, subsection verbatim). Example tests only (not a parser).
- **Chokepoint guard (`buildContentMerger`)**: a content merge (auto-resolving, **no attribute**) with valueless `merge.<d>.driver` → `CONFIG_MISSING_VALUE { key:'merge.<d>.driver', line }` (M4 — the decisive no-attribute test, kills a "guard in `namedChoice` only" mutant); conflicting merge, same fixture → throws (M-conflict); valueless `name` (driver valued) → `.name` (M2); two valueless `[merge *]` sections, earlier-line reported (M-order discriminator); **fast-forward / no-content-merge merge** with the same valueless driver → no throw (M3 laziness — drive a merge that materialises zero content-merge paths, assert no throw); a cherry-pick/revert reaching the same merger inherits the throw (one representative; others by the shared-chokepoint note). If candidate 2 resolves to **replace**: a test that `namedChoice`'s own guard is gone yet an attribute-selected valueless driver still refuses *via the chokepoint* (proves no regression of the original `namedChoice` case).
- **Property tests — DO NOT APPLY.** `findFirstValuelessInSection` is `findFirstValuelessEntry`'s detection generalised to "any subsection" — a command-surface refusal detector, not a parser/round-trip, matcher/aggregator, total-function-over-grammar, or counting invariant. The file-order detection is the existing tokeniser's, already tested. Example tests document the literal behaviour.

### B + C — interop (`test/integration/missing-value-refusal-interop.test.ts`, extend — the file already houses the 24.9r valueless interop)

Mirror the existing twin shape: write the line by `writeFile` into `<tmp>/.git/config`, run real `git` via the `interop-helpers.ts` scrubbed-env runner, capture exit + stderr; run tsgit on the same repo; reconstruct git's two lines from `{ key, source, line }` (normalising the `file '<F>'` token to repo-relative; `key`/`line` verbatim) and assert equality.

- **B:** `merge.custom.driver` valueless, **no attribute**, auto-resolving content merge → `git merge other` vs tsgit `merge` (M4); two valueless `[merge *]` sections, earlier reported (M-order); fast-forward merge with the same valueless driver → both exit 0 (M3 distinctness); `git status` on the same fixture → both exit 0 (lazy distinctness).
- **C:** `core.excludesFile = ` (empty) → real `git status` exits 0 with the untracked file shown AND tsgit `status` exits 0 / does not raise (E3a); `core.attributesFile = ` (empty) → `git status`/`checkout .` exit 0 AND tsgit does not raise (E3b); `core.hooksPath = ` (empty) with a blocking pre-commit present → real `git commit` succeeds (hook does not fire) AND tsgit `commit` succeeds (hook does not fire) — the decisive E3c parity; **control:** UNSET `hooksPath` → the hook fires in both (E3c-dist); **boundary control:** empty `core.excludesFile` exits 0 in both while **valueless** `core.excludesFile` dies 128 in both (E3a-ctrl); `config --list` on empty `core.excludesFile` succeeds in both (E3a-cfg porcelain).

### C — unit (faithfulness-bearing)

- `readGlobalExcludes` with `core.excludesFile = ''` → returns `undefined` (no `lstat('')`, no throw); regression: absent → `undefined` (unchanged); a real valued path still loads.
- `readGlobal` (attributes) with `core.attributesFile = ''` → `buildAttributeProvider` yields no global source, no throw; valued path still loads.
- `resolveHooksDir('', layout)` → does NOT return `` `${workDir}/` `` and does NOT return the `${gitDir}/hooks` default; `runHook` with empty `hooksPath` fires no hook (drive via a hook-runner stub asserting it is never matched / never invoked, matching E3c). Pair: `resolveHooksDir(undefined, layout)` → default dir (UNSET unchanged, E3c-dist control); a valued `hooksPath` → resolves as today.

## Out of scope

- **`branch.*` eager all-section validation** — on this base `pull` guards `branch.<currentBranch>` exact-subsection inside `resolveUpstream` (and only when a branch is checked out). git scans all `[branch *]` and dies even on an unrelated branch's valueless key / detached HEAD / explicit args; that is a separate documented under-refusal (ADR-348's `pull`-scoped decision), NOT one of these three deltas. Not silently added.
- **`submodule.*` valueless** — 24.9r already guards `submodule.<n>.url`/`update` (config-sourced mode, ADR-347); unchanged here.
- **Int-typed valueless** (`24.9s`) — different message shape, own error code, blocked until an int key is merged. Untouched.
- **A short-circuit "skip the gate when `core` absent"** — explicitly rejected (26.9 NOTE): unsound, because a `[core]` holding only a valueless path-like yields `core === undefined`. The token cache makes the gate cheap without needing the short-circuit.
- **A shared command preamble** consolidating `assertOperationalRepository`'s call sites — the reference design's E2; NOT in scope here (these three deltas are A/B/C only). `assertOperationalRepository` already is the shared operational entry; no further consolidation requested.
- **The byte-exact repo-relative `file '<F>'` token** — caller-side rendering (ADR-249); library emits its absolute resolved path in `source`; interop normalises. Unchanged.
- **Writing valueless/empty entries via tsgit's config writer** — git's CLI cannot write valueless; empty is a normal valued write, already handled by the parser. Not a new surface.
