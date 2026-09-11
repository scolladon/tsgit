# Design — session caches and the per-command floor (31.2)

> Brief: `docs/BACKLOG.md` **31.2** (Phase 31, second of six; sourced from
> `.claude/perf-review-2026-09-10.md` F3, F6, F11 and the tail of F14). Two shipped caches are
> sized below the medium fixture and fail silently (the parsed-object memo holds ≤ 4 096 entries;
> the FlatTree LRU refuses the 3.3 MB medium HEAD tree), the delta-base cache is sized off the
> wrong knob and lets one deep read flush itself, and every command pays duplicated metadata I/O
> (HEAD read twice, `.git/config` stat'd on every sequential `readConfig`, `packed-refs`
> probed twice per packed ref, loose refs enumerated serially). Eight sub-items (a)–(h), all
> pure-perf: no object SHA, ref, reflog, state file or refusal changes — **except** where a pin
> below found an existing divergence that the touched code fixes for free (symlinked HEAD,
> `reflog expire`'s reachability rule) and where a newly honoured config key is refused the way
> git refuses it (`core.deltaBaseCacheLimit`), each recorded as a decision.
> Status: revised against ADRs 850–857 → self-reviewed ×3. Two decisions went **against** the
> first draft's recommendation and drive this revision: the delta-base cache honours
> `core.deltaBaseCacheLimit` at git's 96 MiB default on every adapter (ADR-852), and the
> `{ type, content }` cache value type lands **now**, as a major release (ADR-854).

---

## Context

### Where this comes from

Worktree `tsgit-session-caches-per-command-floor`, branch `feat/session-caches-per-command-floor`,
on top of `main@be57e0cc` (31.1 shipped). Every line anchor the brief took on `1f84254c` was
re-verified here: **31.1 touched none of the sixteen files this item edits** (`git diff --stat
1f84254c..be57e0cc -- src` lists 25 files, none of them), so the anchors are byte-stable and the
only drift is in the *claims*, listed under [Brief corrections](#brief-corrections).

Environment for every number below: Apple M3 Pro, macOS, Node 22.22.3, `git version 2.55.0`.
Review numbers (`revParse('HEAD')` 0.29 ms / 4 fs calls / 13 libuv hops; `catFile` warm
0.097 ms / 2 calls; `tag.list` 2 000 packed tags 104.6 ms / 6 005 calls vs `git tag -l` 13 ms;
`branch.list` 1 000 loose 79 ms → 12–14 ms pooled; warm `log` medium 21–30 ms → 9.4–11.5 ms once
the memo fits; `status` 145 → 138 ms once the FlatTree fits) were measured on `1f84254c` and are
**not re-run** here — 31.1 changed nothing on these paths, and the harness parts below are what
make them quotable main-vs-branch. Git probes in this doc were run fresh (matrix at the end);
the `core.deltaBaseCacheLimit` matrix (section C) was added in this revision.

### What exists today (the subsystems touched)

| Seam | File (anchors verified on `be57e0cc`) | What it does today |
|---|---|---|
| LRU | `src/domain/storage/lru-cache.ts` (142 lines) | `createLruCache(maxSizeBytes, maxEntries = ∞)` (no validation of `maxSizeBytes`; 0 is accepted and makes every `set` refuse); `set` throws on `byteSize <= 0` (`:93-95`) and **returns silently** on `byteSize > maxSizeBytes` (`:96-98`). `LruCache` is a **public** type (`domain/storage/index.ts:39`; `Context.deltaCache: LruCache<Uint8Array>`, `ports/context.ts:219`; 25 hits in `reports/api.json`). |
| Loose-object cache value | `ports/context.ts:219, :281`; `object-resolver.ts:50` (`EMPTY_TREE_BYTES`), `:64-105` (`resolveObjectBytesWithDepth` returns `{ bytes, chainDepth }`), `:149-160` (`enforceCachedCap` scans for the NUL), `:246-262` (`verifyAndReturn` hashes the header-prefixed buffer), `:528-529` (`prependHeader`), `:533-545`, `:617-657` (`resolveBaseForRefDelta`), `:659-682` (`splitHeader`, `TextDecoder`), `:684-697` (`typeNameToPackType`), `:699-703` (`cacheEntry`, charges `bytes.length`) | `ctx.deltaCache` stores loose-format bytes (`<type> <size>\0content`). Seven creation sites type it `LruCache<Uint8Array>`: `adapters/{node,browser,memory}-adapter.ts:71/:38/:67`, `index.node.ts:115`, `index.browser.ts:94`, `index.default.ts:99`, `commands/fsck.ts:42` (`createNoDeltaCache`). Consumers: `read-object.ts:176` (`readRawObject` → `splitObject(resolved.bytes)`), `internal/blob-source.ts:89-92, :141, :153-162, :178-186` (cache arm + `verifyBufferedBytes` one-shot hash), `commands/internal/gc-pipeline.ts:1015` (`delete`), `repository.ts:729` (`clear`). `RawObject` (`primitives/types.ts:90-96`: `{ type, content, bytes }`) is **public** via `primitives/index.ts:96` `export type * from './types.js'` (4 hits in `reports/api.json`) — its own doc comment ("not re-exported from the primitives barrel") is stale. Nine `readRawObject` callers; eight use `type`/`content` only, one (`fsck/content-validation.ts:80`) hashes `raw.bytes`. |
| Parsed-object memo | `src/application/primitives/internal/object-caches.ts` | Session-keyed `WeakMap` (`:47`); budget `deltaCache.maxSize × PARSED_OBJECT_MEMO_FRACTION (1/16)` (`:81, :99`) = 1 MiB at the default; entry cap 65 536 (`:92`) "never binds"; sizer adds `PARSED_OBJECT_FIXED_OVERHEAD_BYTES = 256` per entry (`:132, :149-171`) ⇒ ≤ 4 096 entries fit. Populated at `object-resolver.ts:121`. The module's own fraction sweep table (`:60-68`) was taken on the medium fixture — 5 000 commits, i.e. on the wrong side of the cliff. |
| FlatTree cache | `src/application/primitives/read-head-tree.ts` | Session-keyed, `FLAT_TREE_CACHE_FRACTION = 1/16` (`:50, :68-71`), `flatTreeByteSize` = 48 + Σ(path + oid + 110) (`:112-118`) ≈ 164 B × entries ⇒ medium HEAD (20 000 files) = 3.3 MB > 1 MiB → `set` refused on every `status`/`rm`; break-even ≈ 6 400 tracked files. Key `(rootTreeOid, maxDepth)` (ADR-726, carried forward by ADR-851). Consumers: `status.ts:162`, `rm.ts:171`. |
| Delta-base cache | `src/application/primitives/pack-registry.ts:187-199` (`DeltaBaseCacheEntry = { type, content, chainDepth }`), `:629` (`DELTA_BASE_CACHE_MAX_ENTRIES = 65_536`), `:631-643` (`createPackRegistry(ctx): PackRegistry`, **synchronous**, `createLruCache<DeltaBaseCacheEntry>(ctx.deltaCache.maxSize, 65_536)`), `:919, :961` (`clear` on refresh/dispose); `object-caches.ts:249-274` (`deltaBaseCacheEntrySize` = content + 200 B; `cacheDeltaBase` returns `void`); `object-resolver.ts:471-531` | Sized at `ctx.deltaCache.maxSize` — a **full additional** budget (ADR-736, now superseded on this point by ADR-852). Registry creation: `read-object.ts:39` `registryCache: WeakMap<Session, PackRegistry>`, `:47-53` `getPackRegistry(ctx)` **synchronous**, `:63-65` `refreshPackRegistry`, `:72-74` `disposePackRegistry`; 19 `getPackRegistry` call sites across 14 files (all inside `async` functions) plus one direct `createPackRegistry` in `commands/fetch-missing.ts:66`. None of `getPackRegistry` / `createPackRegistry` / `PackRegistry` / `DeltaBaseCacheEntry` is in `reports/api.json`. The registry reads **no** config today. The unwind loop `:504-519` inserts one full intermediate per level, nearest-the-base first. |
| Config read | `src/application/primitives/config-read.ts` (1 737 lines) | Session-keyed `cache` (`:256`) validated by `coalescedMtimeKey` (`:228-248`, coalesces **concurrent** stats only) on every `readConfigEntry` (`:342-356`) — one `stat` per sequential `readConfig`. 48 call sites across 29 `src/` files. `ParsedConfig.core` (`:44-57`) is a typed record (`maxTreeDepth?: number` at `:57`) built by `mergeCore` (`:963-970`) → `applyCoreEntry` → per-key appliers (`applyMaxTreeDepthEntry:900-905`, lenient: an invalid value merges as absent) → `finalizeCore` (`:1450-1466`). Refusals live in separate finders over the cached tokens: `findLastInvalidMaxTreeDepth` (`:736-768`, last-wins, `parseGitInt` + C-int narrowing), `findFirstInvalidPackInt` (`:676-703`) whose `checkPackWindowMemoryBound` (`:1240-1245`) is git's **unsigned-long** grammar (`parseGitInt(value, GIT_UINT64_MAX)`, negative ⇒ `'invalid unit'`). `gateVerdictCache` (`:279`) is session-keyed and **not** mtime-keyed. Import closure of `config-read.ts` (depcruise, 78 modules): `config-scoped-read.ts`, `internal/config-key.ts`, `internal/config-scope.ts`, `path-layout.ts`, `internal/layout-verdict.ts` + domain/ports — **no** object-store module (`pack-registry`, `read-object`, `object-resolver`, `object-caches`, `blob-source`, `read-head-tree`). |
| Gate | `src/application/primitives/internal/repo-state.ts` | `hasUsableHead` (`:130-144`): `lstat HEAD` → symlink ⇒ `readlink` + `isRefsLinkText`; else `readUtf8` + `isValidHeadContent`. Runs on **every** command (`assertOperationalRepository:320-325`, `assertRepository:98-103`) ahead of the session-memoised verdict (`computeGateVerdict:305-309` = `assertTrustedAndFormat` → `assertEagerConfigValid:211-244`). `assertEagerConfigValid` throws `core.maxTreeDepth` **first** (last-wins finder, pinned), then the lowest-line entry among five streaming classes (valueless string, compression, core boolean, `logAllRefUpdates`, `[diff "x"]` boolean). `readHeadRaw` (`:351-355`) already resolves HEAD **through the ref store** — it is not a third reader. |
| Ref store | `src/application/primitives/ref-store.ts` (913 lines) | Context-identity-keyed store (`:270-279`, deliberately not session-keyed — `:243-269`). `loadPackedRefs` (`:376-391`): `exists` (a `stat` on Node, `node-file-system.ts:719-730`) then `stat`, cache keyed `mtimeMs:size`. `readLooseContent` (`:393-401`) `readUtf8` follows symlinks. `resolveDirect` (`:403-415`) loose-then-packed. `collectCandidateNames` (`:532-542`) holds the packed **entries with oids**; `listRefs` (`:561-569`) still `resolveEntry`s every name serially. `packRefs` (`:875-898`): serial `exists` per packable (`:881-885`), pooled `buildPackedEntry`, serial `rm` (`:890-892`). `verifyIntegrity` (`:575-597`) serial too (fsck's; not in scope). |
| Scoped config | `src/application/primitives/internal/config-scope.ts:52-76`, `config-scoped-read.ts:148-166` | `isWorktreeScopeActive` raw-reads + `parseIniSections` the local file **outside every cache**, reached from `resolveScopePath('worktree')`. `readSingleScope` (module-private) already caches local sections behind an mtime key. Import direction today: `config-scoped-read.ts → internal/config-scope.ts` (`:8`). |
| Reflog append | `src/application/primitives/record-ref-update.ts` (66 lines), `src/adapters/node/node-file-system.ts:705-712` | `isLoggable` reads config (`:51`) and `resolveReflogIdentity` reads it again (`reflog-identity.ts:26`); `appendUtf8` runs `mkdir -p` before every append (`:709`). |
| Loose enumeration | `ref-store.ts:561-569, :881-892`, `reflog.ts:234-241`, `list-worktrees.ts:202-205` | All `for … await` serial. `boundedMapFor(ctx, 'ioBound', items, worker)` (`internal/concurrency.ts:53-58`) preserves input order and propagates the first rejection. |
| rev-parse sweep | `src/application/commands/rev-parse.ts:61-77`, `commands/internal/commit-ish.ts:22` | `refCandidates(base)` builds 6 strings eagerly; each miss throws `REF_NOT_FOUND` from `resolveDirectChain` (`resolve-ref.ts:51-53`) on top of the adapter's `FILE_NOT_FOUND`; the `catch {}` swallows **every** error. |
| reflog expire | `src/application/commands/reflog.ts:156-241` | `collectReachable` walks **all** history from **every** ref tip (`:224-232`) on every `expire`; `keepEntry` (`:213-221`) = `timestamp >= (reachable(newId) ? expireCut : unreachableCut)`. ADR-064's "fully faithful" claim is superseded by ADR-857 (pins R1–R7). |
| Options | `src/index.node.ts:49-53` (`deltaCacheMaxBytes`, `deltaCacheMaxEntries`), `index.browser.ts:42-43`, `index.default.ts:99` (bytes only), three adapters (`:27-28`, `:21-22`, `:21-22`) | `DEFAULT_DELTA_CACHE_BYTES = 16 MiB` in six places. `validateOptions` (`repository/validate-options.ts:37-56`, called from `index.node.ts:57`, `index.browser.ts:63`, `index.default.ts:47`, `repository.ts:554`) validates **neither** `deltaCacheMaxBytes` nor `deltaCacheMaxEntries` today — `ValidatableOptions` (`:9-20`) does not carry them. |
| Harness | `test/bench/` | `rev-parse.bench` (HEAD only), `cat-file.bench`, `log.bench` (2 rows), `status.bench` (tiered), `delta-chain-read.bench` (3 rows incl. "8 tips sharing deep OFS ancestor levels"), `loose-read.bench`, `commit.bench`. **No** tag-list or branch-list bench. fs-count shim pattern: `fs-count.cjs` in `.claude/perf-31-1-closure-walks-prompt.md:107-113`; unit-level: `instrumentedContext` (`test/unit/application/primitives/fixtures.ts:343`). `tooling/bench-ab.ts` (`npm run bench:ab -- <base> [head] [rounds]`). |

### Constraints this design lives under

- **ADR-226** git-faithfulness binds the data and on-disk state; **ADR-249** no rendering
  options — nothing here adds a display knob. Cache budgets are library tuning, not output;
  `core.deltaBaseCacheLimit` is a config key git honours, so its parse grammar and its refusal
  are pinned (section C), not the resulting cache size.
- **ADR-850** config is read once per command at the operational gate (D5). **ADR-851** derived
  caches are entry-bound on explicit budgets, conservative defaults (D2). **ADR-852** the
  delta-base cache honours `core.deltaBaseCacheLimit`, git's 96 MiB default, every adapter (D2).
  **ADR-853** `LruCache.set(): boolean` (D1). **ADR-854** `{ type, content }` in `ctx.deltaCache`
  now, as a major (D3). **ADR-855** HEAD freshness is the gate's `lstat` identity, `ino === 0`
  adapters re-read (D4). **ADR-856** the HEAD slot keys on Context identity (D4). **ADR-857**
  `reflog expire` follows git's reachability rule (D8). These eight are settled; the
  [decision record](#decision-candidates) below restates each with its outcome.
- **ADR-722** caches key on `ctx.session`; `deriveContext` mints a fresh token on gitDir /
  commonDir / fs-root-set / hash-algorithm change. The ref store is the documented exception
  (Context identity, `ref-store.ts:243-269`); ADR-856 extends that exception to the HEAD slot.
- **ADR-726 / 727 / 736 / 064** are superseded in scope (their carried-forward parts are named
  in ADR-851/852/857): the `(rootTreeOid, maxDepth)` key, gitlink preservation and the floor-at-1
  sizer; the per-session memo and deep-readonly `CommitData`; the delta-base cache being
  **additive**, `DELTA_BASE_CACHE_MAX_ENTRIES` and the 200 B sizer term; the `reflog` command
  shape. **ADR-788** the index-pass base cache has its own budget and is outside the family.
- **ADR-637** `core.maxTreeDepth` unclamped/refused-when-malformed — the epoch changes *when* it
  is stat'd, never what is resolved; its finder + lazy-resolver pair (`findLastInvalidMaxTreeDepth`
  + `resolveMaxTreeDepth`) is the house pattern a new numeric `[core]` key follows.
- **ADR-351** one config cache, one invalidation point — the epoch is a bit on that cache.
- **ADR-707** `packRefs` surface; **ADR-709/294** common-dir rule.
- `.claude/workflow/surface-gates.md`: `LruCache`, `Context`, `RawObject`, `parseObject`,
  `OpenNodeRepositoryOptions` / `OpenRepositoryOptions` are public → `reports/api.json`
  regenerated in the slice that changes each; no new Tier-1 command, no new error code
  (`CONFIG_BAD_NUMERIC_VALUE` and `INVALID_OPTION` already exist).
- **Release line.** Phase 31 is scoped as the **v5** line (`docs/BACKLOG.md:572`). ADR-854's
  public value-type change is breaking; the commit that lands it carries the conventional-commit
  `!` marker so release-please cuts `5.0.0` — budgeted, not forced by this item alone.
- Structure of 31.3: it owns the adapter I/O strategy (sync fast path, `tryLstat`/`tryReadUtf8`,
  `readFile` views, `blob-source` populate, the pack-first cold order). 31.2 must not reach
  ahead into those seams; where an item here would naturally touch one it is called out and left.
  The `{ type, content }` shape is **no longer** one of them — 31.3 inherits the finished shape.

### Brief corrections

1. **"`resolve-max-tree-depth` per `walkTree` … 10 010 per medium closure."** 31.1 (D2) hoisted
   the closure's resolution: the medium closure now issues O(1) config reads. The remaining
   per-call resolutions are `walk-tree.ts:133`'s other 11 callers, each one `stat` per
   `walkTree` outside an epoch. (e) still covers them; the 10 010 is gone already.
2. **"`pack-registry.ts:639-642` … comment says shared."** The call is `:640-643`; the comment
   at `:633-639` already says *additive* (ADR-736 replaced the "shared budget" text). The
   ~33 MiB provisioning was documented, not accidental — and is now moot: ADR-852 sizes the
   cache from `core.deltaBaseCacheLimit`, not from `deltaCacheMaxBytes` at all.
3. **"`record-ref-update.ts:39-53` two back-to-back `readConfig`."** One is `isLoggable`'s
   (`:51`); the other is inside `resolveReflogIdentity` (`reflog-identity.ts:26`). Folding
   them means threading a config into the identity resolver, not a local edit.
4. **"HEAD is read twice per command."** Confirmed (`repo-state.ts:142` then `ref-store.ts:396`;
   `readHeadRaw:351-355` is not a third reader — it goes through `getRefStore(ctx).resolveDirect`).
   Additionally: for a **symlinked HEAD** `readLooseContent` follows the link and returns the
   branch's oid, so `resolveDirect('HEAD')` reports `direct` (detached) where git reports
   `symbolic` (Pin H1). A pre-existing divergence that (d)'s sole reader fixes by construction —
   ADR-855 records it.
5. **"one-slot cache keyed on the gate's `lstat` `(mtime,size,ino)`."** The memory adapter reports
   `ino: 0` for every file (`memory-file-system.ts:548`) and the browser adapter likewise
   (`browser-file-system.ts:330`), both with millisecond `mtimeMs`. A key of that shape is
   **degenerate** on two of three adapters. 187 raw `writeUtf8(…/HEAD)` calls across 66 unit-test
   files rewrite HEAD between commands on the memory adapter. ADR-855.
6. **"`LruCache.set` reports a refusal."** `LruCache` is public (`Context.deltaCache`), so the
   return-type change regenerates `reports/api.json`; nine `set` call sites must each say what
   they do with the verdict (D1 table). ADR-853.
7. **"`runExpire` walks all history even when `expireCut === unreachableCut` makes reachability
   unobservable."** Git's no-walk condition is `expire_unreachable <= expire_total`, and git's
   keep rule is not tsgit's (Pins R1–R7). "Unobservable" is a property of git's rule, not of
   `===`. ADR-857.
8. **"config freshness … next *read* → next *command*."** The verdict memo (`gateVerdictCache`)
   is already "per session until `invalidateConfigCache`" — a raw external edit that makes
   `[core]` malformed after the first command is **not** refused by later commands today. The
   gate's single stat closes that gap (D5); ADR-850.
9. **"`tag.list` with 2000 packed tags = 6005 fs calls."** Per packed-only name: `readUtf8`
   (ENOENT) + `exists` + `stat` = 3 × 2 000 = 6 000, plus the gate. After (d)+(e)+(f): ≈ 5.
10. **"`isWorktreeScopeActive` … through `readSingleScope('local')`."** `readSingleScope` is
    module-private in `config-scoped-read.ts`, which imports `internal/config-scope.ts`;
    routing the check through it from where it lives today would close an import cycle
    (`depcruise no-circular` is enforced). The check has to move next to the cache (D5-iii).
11. **`deltaCacheMaxEntries`** already exists as a public option (`index.node.ts:52`); the new
    options follow that shape. **Correction to the first draft:** neither `deltaCacheMaxBytes` nor
    `deltaCacheMaxEntries` is validated anywhere (`validate-options.ts`'s `ValidatableOptions`
    omits both; a `0` or a negative silently yields a dead cache — the failure mode this item
    exists to remove). D2 validates all five cache options at the facade boundary.
12. **"store `{type, content}` and retire the `prependHeader`/`splitHeader` round trip."** The
    first draft deferred this to 31.3; ADR-854 takes it now. `RawObject` is public despite its
    comment (correction in the table above), so `bytes` leaving it is part of the same major.
13. **`core.deltaBaseCacheLimit` is not "async config at registry creation, wrong for a browser
    tab" as the first draft argued** — ADR-852 weighed both and chose parity. What the draft did
    not check, and this revision pins (section C): git 2.55 parses the key with its unsigned-long
    grammar (`k`/`m`/`g` accepted, `0` accepted, negative and empty are `invalid unit`, oversize
    is `out of range`), resolves it **last-wins**, does **not** validate a file value a
    command-line `-c` overrides, and dies on a malformed value in **most but not all** commands
    (`branch --list`, `tag -l`, `remote`, `notes list`, `pack-refs`, `config` run; everything that
    touches the object store or ref iteration dies) — the refusal placement is therefore a
    decision (NDC-2), not a transcription.

---

## Requirements

| # | Requirement | Oracle |
|---|---|---|
| R1 | The two derived caches **engage on the medium fixture** under default options: the parsed memo retains all 5 000 walked commits (entry-bound, 32 768 default — ADR-851); `readHeadTree` on a 20 000-entry HEAD (3.3 MB against an 8 MiB budget) is a cache hit on the second call. A refused `set` is **observable** (`false`, ADR-853) so neither can go dead silently again; the valve-ordering invariant is a test, not a comment. | `object-caches.test`: 5 000 distinct entries → `entryCount === 5 000`; `read-head-tree.test`: second call issues zero object reads (`instrumentedContext`), `set` returned `true`; `bench:ab` `log()` medium ≈ 2× lower, `status()` medium not worse (local only until 31.4 — see D11). |
| R2 | **Per-command floor** (Node, warm, ADR-850): `revParse('HEAD')` = 3 fs calls / 6 libuv hops (was 4 / 13); `catFile` = 2 calls / 2 hops (was 2 / 5 — the `readFile HEAD` becomes a `stat .git/config`); `branch.create` ≤ 13 (was 16; exact before/after recorded); no command issues more than one `stat .git/config` and one `lstat HEAD` per gate; the pack registry's config read inside a gated command issues **zero** stats. | `floor-oracle.mjs` under `fs-count.cjs` on `medium-v3` (recorded in the PR); unit: `instrumentedContext` over `assertOperationalRepository` + `resolveRef('HEAD')` sequences and over a first `readObject` after a gate (no `stat` of `config`). `rev-parse.bench`/`cat-file.bench` main-vs-branch. |
| R3 | `tag.list` over N packed-only tags issues **O(1)** fs calls beyond the loose walk (was 3N); `branch.list` over N loose branches resolves through the `ioBound` pool. | New `tag-list.bench` (2 000 / 10 000 packed) and `branch-list.bench` (1 000 loose), `bench:ab` ≥ 4× lower on both; unit fs-count on `listRefs`. |
| R4 | The config freshness contract is exactly ADR-850's, documented on `internals.md` (`readConfig`, `invalidateConfigCache`), with the set of tests that needed an explicit `invalidateConfigCache` enumerated in the PR. `core.deltaBaseCacheLimit` is read **once per pack registry** (per session) — ledger row L7. | `config-read.test` epoch matrix (D5); the unit suite's failing set when the epoch lands is the enumeration. |
| R5 | **Observable behaviour unchanged** — object bytes, ref/reflog contents, refusal codes and messages — except three pinned faithfulness changes: symlinked HEAD resolves `symbolic` (Pin H1, ADR-855); `reflog expire` follows git's rule (Pins R1–R7, ADR-857); a malformed `core.deltaBaseCacheLimit` is refused `CONFIG_BAD_NUMERIC_VALUE` with git's `reason` (Pins C1–C5; placement per NDC-2). Every freshness window that changes is listed in the [ledger](#freshness-ledger-what-an-external-writer-can-observe). | Existing interop suites green; new `head-symlink-interop`, extended `reflog-interop` matrix, extended `config-interop` (C-matrix); `packed-refs-interop`/`pack-refs-interop` unchanged. |
| R6 | `npm run validate` green; `npm run check:architecture` green with the new `pack-registry → config-read` edge; mutation budget intact (app ≥ 95); `reports/api.json` regenerated for `LruCache.set`, the five validated options, `Context.deltaCache`'s value type, `RawObject`, `parseObjectContent`; the breaking commit carries `!`; docs per [Docs consequences](#docs-consequences); backlog 31.2 ticked by the docs phase. | Bare gate runs into files (`echo $?`); `npm run docs:json` diff committed in the slice adding each public change. |

---

## Design

### D0 — Shape and suggested part order

Harness first (so every A/B has before/after on the same series keys — 31.1's Part 1 lesson),
then the cache seam (domain → application), then the ref/config seam in dependency order, then
the tail. Thirteen work items (D1–D11, with D2 and D3 each in two halves), proposed as **eleven parts** (details in
[Partition proposal](#partition-proposal)):

| Part | Items | Owns |
|---|---|---|
| P0 | D11 harness (benches + oracle script) | `test/bench/*`, no `src/` |
| P1 | D1 `LruCache.set` verdict | `lru-cache.ts` (+ api.json) |
| P2 | D2-i (a) memo entry-bound, (b-i) FlatTree budget, five validated options, `cacheBudgets` | `object-caches.ts`, `read-head-tree.ts`, seven entry/adapter files, `validate-options.ts`, `ports/context.ts` (+ api.json) |
| P3 | D2-ii `core.deltaBaseCacheLimit`: parse + finder + gate check + lazy resolver, async registry construction | `config-read.ts`, `internal/repo-state.ts` (`assertEagerConfigValid`), new `internal/resolve-delta-base-cache-limit.ts`, `pack-registry.ts`, `read-object.ts`, 20 call sites |
| P4 | D3-i (c-i) delta-base per-chain budget | `object-resolver.ts`, `object-caches.ts` |
| P5 | D3-ii (c-iii) `{ type, content }` value type *(2 commits; the second is the breaking one)* | `domain/objects/git-object.ts`, `ports/context.ts`, seven creation sites, `object-resolver.ts`, `read-object.ts`, `primitives/types.ts`, `blob-source.ts`, `fsck/content-validation.ts` (+ api.json) |
| P6 | D4 (d) HEAD reader + slot + symlink fix | new `internal/head-file.ts`, `repo-state.ts` (`hasUsableHead`), `ref-store.ts` (`resolveDirect`, HEAD writes), `bootstrap.ts:77` |
| P7 | D5 (e) config epoch + verdict re-keying, (h-i) `isWorktreeScopeActive`, (h-ii) one config read per ref update | `config-read.ts`, `repo-state.ts` (`assertOperationalRepository`), `config-scoped-read.ts`, `internal/config-scope.ts`, `record-ref-update.ts`, `reflog-identity.ts` |
| P8 | D6 (f) packed-refs + D7 (g) pooled enumeration *(2 commits)* | `ref-store.ts` (`loadPackedRefs`, `listRefs`, `packRefs`), `reflog.ts` (`resolveTips`), `list-worktrees.ts` |
| P9 | D8 (h-v) reflog expire model | `reflog.ts`, `reflog-interop.test.ts` |
| P10 | D9 (h-iv) rev-parse sweep + D10 (h-iii) `appendUtf8` *(2 commits)* | `resolve-ref.ts`, `rev-parse.ts`, `commit-ish.ts`; `node-file-system.ts` |

Every part is behaviour-preserving **except** P3 (a malformed `core.deltaBaseCacheLimit` is
refused — Pins C1–C5; NDC-2), P5 (public type change, no runtime-observable change), P6
(symlinked HEAD becomes `symbolic` — Pin H1), P7 (an externally-introduced malformed `[core]`
value is refused by the **next** command instead of never — correction 8), and P9 (git's expire
rule — Pins R1–R7); each is pinned by an interop test and each moves *toward* git.

---

### D1 — (b-ii) `LruCache.set` reports its verdict (ADR-853, settled)

```ts
// src/domain/storage/lru-cache.ts — public type; api.json regenerates
export interface LruCache<V> {
  get(key: string): V | undefined;
  /**
   * Store `value` under `key`. Returns `true` when the entry is now resident,
   * `false` when it was REFUSED because `byteSize` exceeds the cache's whole
   * budget — the one case that never evicts anything and leaves the cache
   * exactly as it was. A refusal is a sizing fact the caller may need to
   * surface (a derived cache whose every entry is refused is dead, not slow).
   * Still throws on `byteSize <= 0`.
   */
  set(key: string, value: V, byteSize: number): boolean;
  …
}
```

`set` returns `false` at `:96-98`, `true` after `evict()`. No behaviour change for callers that
ignore the value. What each of the nine call sites does with it:

| Call site | Verdict handling | Why |
|---|---|---|
| `read-head-tree.ts:136` | Returned to nobody at runtime; **unit test asserts `true`** for a 20 000-entry synthetic tree under the default 8 MiB budget, and `false` under a deliberately shrunk `flatTreeCacheMaxBytes` | An over-cap HEAD tree is legitimate (a 2 M-file monorepo) — not an error; the test is what makes a dead default loud |
| `object-resolver.ts:121` (memo) | Ignored; unit test asserts `true` for a 64 KiB-message commit under the valve | A pathological message not being memoised is by design |
| `object-resolver.ts:702` `cacheEntry` | Ignored | A > budget object is never cached; documented since ADR-720 |
| `object-caches.ts:273` `cacheDeltaBase` | **Returned** (D3-i charges the chain budget on `true`); D3-i's per-chain check (¼ of the cache — 24 MiB at the 96 MiB default) runs first and is strictly tighter than the whole-budget refusal for every positive limit, so `false` is unreachable there — re-derived in D3-i | — |
| `index-pack.ts:363, :558` | Ignored (ADR-788: a cache miss changes latency, never results) | — |
| `load-reftable-stack.ts:276` | Ignored | Over-cap stack re-read next time, as today |
| `bitmap-reconstruct.ts:88` | Ignored | — |
| `node-file-system.ts:1115` `parentRealpathCache` | Ignored | Key-length sizer; cannot exceed |

Rejected (ADR-853 records them so they are not re-proposed): throwing, a logger channel, a
`refusedCount` counter, the typed `'stored' | 'refused'` verdict.

---

### D2 — (a) memo bound by entries, (b-i) FlatTree on its own budget, (c-ii) the delta-base budget from `core.deltaBaseCacheLimit`, options (ADR-851 + ADR-852, settled)

**What goes wrong today.** Both derived caches take `1/16 × deltaCacheMaxBytes` and a 65 536
entry cap that "never binds". For the memo the byte cap binds at ≤ 4 096 entries (256 B floor);
a 5 000-commit walk in the same order every time is the worst LRU case (≈ 0 % hits). For the
FlatTree, 1 MiB holds ≈ 6 400 tracked files; the medium HEAD is refused on every `status`. The
delta-base cache is sized off `deltaCacheMaxBytes`, a knob git does not have, while the knob git
*does* have for exactly this cache — `core.deltaBaseCacheLimit` — is read nowhere.

**The design principle** (ADR-851): a cache's budget is expressed in the unit its consumer scales
with — **entries** for the memo (a walk of N commits needs N slots), **tracked files** for the
FlatTree (one HEAD tree of F files needs 164 F bytes) — and the byte cap becomes a *valve* sized
so it binds only for atypical entries, never for typical ones. That ordering is pinned by a unit
test per cache, so a future retune that flips the binding constraint fails a test instead of
shipping a dead cache.

#### D2-i — memo and FlatTree (ADR-851)

```ts
// object-caches.ts
/** Per-entry ceiling the valve is derived from: 256 B fixed + a 256 B typical message/parents
 *  allowance. `maxEntries × this` is what the byte valve must admit at every `deltaCacheMaxBytes`. */
export const PARSED_OBJECT_TYPICAL_ENTRY_BYTES = 512;
const memoByteValve   = (ctx) => ctx.deltaCache.maxSize;                                            // 16 MiB at the default
const memoMaxEntries  = (ctx) => ctx.cacheBudgets?.parsedObjectMemoMaxEntries
                                 ?? Math.floor(memoByteValve(ctx) / PARSED_OBJECT_TYPICAL_ENTRY_BYTES); // 32 768 at the default
// createLruCache(memoByteValve(ctx), memoMaxEntries(ctx))

// read-head-tree.ts
/** Bytes per tracked file the sizer charges (48 base + path ≈ 14 + oid 40 + 110). */
export const FLAT_TREE_TYPICAL_ENTRY_BYTES = 164;
const FLAT_TREE_DEFAULT_SHARE = 0.5;                                                                  // 8 MiB at the default ≈ 51 k files
const flatTreeMaxBytes = (ctx) => ctx.cacheBudgets?.flatTreeCacheMaxBytes ?? ctx.deltaCache.maxSize * FLAT_TREE_DEFAULT_SHARE;
// createLruCache(flatTreeMaxBytes(ctx), FLAT_TREE_CACHE_MAX_ENTRIES)
```

Deriving the default entry count *from* the valve (rather than pinning 32 768 as a literal) is
what keeps ADR-851's invariant structural at every dial value: a browser tab at
`deltaCacheMaxBytes = 4 MiB` gets a 4 MiB valve and 8 192 entries, still `entries × 512 ≤ valve`.
The two invariant tests are literal at the default (`32_768 × 512 ≤ 16 MiB`;
`164 × 50_000 ≤ 8 MiB`) and one more asserts the derivation at a non-default dial.
`PARSED_OBJECT_MEMO_MAX_ENTRIES` (65 536, `:92`) is **retired**: the derived entry count *is* the
bound and tracks the valve at every dial value (a 64 MiB dial derives 131 072 entries), so a
second, fixed cap would either never bind or silently re-create the cliff; the module's fraction-sweep table (`:55-79`) is replaced by the entry-bound
rationale and a pointer to the medium-fixture A/B (D11).

#### D2-ii — the delta-base budget honours `core.deltaBaseCacheLimit` (ADR-852)

**Mechanism (git 2.55.0, pinned C1–C5 in the matrix).** The key is parsed with git's
unsigned-long grammar: decimal / `0x` hex / leading-`0` octal, one optional `k`/`K`/`m`/`M`/`g`/`G`
unit (× 1024ⁿ); `0` is accepted (`96m`, `1K`, `0x6000000`, `100663296`, `1g`, `0` all run);
`-1`, `abc`, `96x`, `1.5m`, an empty value and a valueless key are `fatal: bad numeric config
value '<v>' for 'core.deltaBaseCacheLimit' in file .git/config: invalid unit` (git prints the key
lowercased in every such message; it is shown in canonical case throughout this doc); `99999999999999g`
is `… out of range` (C1). It resolves **last-wins** — an invalid line followed by a valid one is
fine, a valid line followed by an invalid one dies (C4), exactly `core.maxTreeDepth`'s model. A
command-line `-c core.deltaBaseCacheLimit=1m` over a malformed file value runs: the overridden
file value is never validated (C5). Git dies on a malformed value in 46 of the 60 distinct commands
probed — everything that opens the object store or iterates refs — and runs in `symbolic-ref`,
`branch --list`, `tag -l`, `check-ref-format`, `hash-object` (without `-w`), `count-objects`,
`config`, `var`, `remote`, `notes list`, `pack-refs`, `prune`, `init` (C2). When another `[core]`
class is malformed on the same file, `core.maxTreeDepth`'s refusal wins over this key in every
command, and the streaming classes (`core.sparseCheckout`, `core.compression`) win over it in 27
of 33 commands; the six exceptions (`diff`, `status`, `commit`, `gc`, `bundle create`, `rebase`)
report this key first (C3). Git's default is `96 * 1024 * 1024` bytes, per thread, per process.

**Parse and finder** (`config-read.ts`, house pattern = `core.maxTreeDepth`):

```ts
// ParsedConfig.core (:44-57) gains
/** `core.deltaBaseCacheLimit` — unsigned-long bytes; absent when unset or malformed (lenient read). */
readonly deltaBaseCacheLimit?: number;
// MutableCore (:855-870) + applyDeltaBaseCacheLimitEntry beside applyMaxTreeDepthEntry (:900-905):
//   checkPackWindowMemoryBound(value) (:1240-1245) — parseGitInt(value, GIT_UINT64_MAX), negative ⇒ absent
// finalizeCore (:1450-1466) spreads it like maxTreeDepth.
/** Last-wins finder, the twin of findLastInvalidMaxTreeDepth (:736-768): valueless ⇒ { value: '', reason: 'invalid unit' };
 *  negative ⇒ 'invalid unit'; > 2^64-1 ⇒ 'out of range'. */
export const findLastInvalidDeltaBaseCacheLimit = async (ctx): Promise<InvalidNumericEntry | undefined> => { … };
```

A value above `Number.MAX_SAFE_INTEGER` (git accepts up to 2⁶⁴−1) becomes an inexact `number`;
it is a comparison bound for `LruCache`, never arithmetic, so inexactness is harmless and stated.

**Refusal.** Two guards, deliberately redundant like `core.maxTreeDepth`'s (each covers a surface
the other cannot):

- **Eager, at the gate** — `assertEagerConfigValid` (`repo-state.ts:211-244`) runs
  `findLastInvalidDeltaBaseCacheLimit` and throws `configBadNumericValue(key, source, value,
  reason)` **after** the `core.maxTreeDepth` throw and **after** the five streaming classes'
  lowest-line pick — git's majority ordering (C3). The finder is **skipped when
  `ctx.cacheBudgets?.deltaBaseCacheMaxBytes !== undefined`** — the explicit option is tsgit's
  `-c`, and git validates no file value a `-c` overrides (C5). Placement and ordering are
  NDC-2; the recommendation is this shape.
- **Lazy, at first use** — a new `internal/resolve-delta-base-cache-limit.ts`, the 23-line twin
  of `internal/resolve-max-tree-depth.ts`:

```ts
export const GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES = 96 * 1024 * 1024;
/** Refuses CONFIG_BAD_NUMERIC_VALUE on a malformed last entry (primitive-only sessions never run the gate);
 *  otherwise the parsed value, or git's default when the key is absent. */
export const resolveDeltaBaseCacheLimit = async (ctx: Context): Promise<number> => {
  const invalid = await findLastInvalidDeltaBaseCacheLimit(ctx);
  if (invalid !== undefined) throw configBadNumericValue(invalid.key, invalid.source, invalid.value, invalid.reason);
  return (await readConfig(ctx)).core?.deltaBaseCacheLimit ?? GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES;
};
// same module — the one resolver createPackRegistry calls (NDC-1 (a): option wins, config never read when set)
export const deltaBaseCacheBudgetFor = async (ctx: Context): Promise<number> =>
  ctx.cacheBudgets?.deltaBaseCacheMaxBytes ?? (await resolveDeltaBaseCacheLimit(ctx));
```

**Where the read sits — registry construction becomes async.** ADR-852 fixes the moment
("`createPackRegistry` performs a config read at construction time"); `createPackRegistry`
(`pack-registry.ts:631`) is synchronous today, so:

```ts
// pack-registry.ts
export async function createPackRegistry(ctx: Context): Promise<PackRegistry> {
  const storeGate = createStoreGate(ctx);
  const deltaBaseCache = createLruCache<DeltaBaseCacheEntry>(
    await deltaBaseCacheBudgetFor(ctx),      // was ctx.deltaCache.maxSize
    DELTA_BASE_CACHE_MAX_ENTRIES,            // 65 536, carried forward (ADR-852)
  );
  …
}
// read-object.ts
const registryMemos = new WeakMap<Context['session'], PromiseMemo<PackRegistry>>();   // single-flight: N concurrent first reads construct once
const resolvedRegistries = new WeakMap<Context['session'], PackRegistry>();           // for the two sync/void helpers
export const getPackRegistry = (ctx: Context): Promise<PackRegistry> => memoFor(ctx).get();
export function refreshPackRegistry(ctx: Context): void { resolvedRegistries.get(ctx.session)?.refresh(); }   // a registry still constructing has not scanned yet — nothing to refresh
export async function disposePackRegistry(ctx: Context): Promise<void> { await (await registryMemos.get(ctx.session)?.peek())?.dispose(); }
```

The 19 `getPackRegistry` call sites (`read-object.ts:154,166,228`, `resolve-oid-prefix.ts:54`,
`enumerate-objects.ts:34`, `has-object.ts:14`, `internal/blob-source.ts:86,102`,
`internal/closure-engine.ts:337`, `commands/internal/gc-pipeline.ts:829,870,1069`, six `fsck/*`
passes) and `fetch-missing.ts:66`'s private `createPackRegistry` all sit inside `async`
functions and gain one `await`; none of these names is public. The registry is created on the
**first object read** of a session (every `readObject`/`readRawObject`/`hasObject`/… calls
`getPackRegistry` before touching the store), so inside a Tier-1 command it is always created
**after** that command's gate: under ADR-850 the config entry is `trusted` and the read is a
parse-cache hit — **zero stats** (R2's oracle). A primitive-only session pays one stat, which is
that session's contract for every `readConfig` anyway. `fsck`'s audit Context shares the
session, so it shares the registry; the budget is resolved from whichever Context constructs it,
and the audit view isolates only `deltaCache`, never `.git/config` — same value either way.
`deltaBaseCachingEnabled(ctx)` (`ctx.deltaCache.maxSize > 0`) stays the family gate; a
`core.deltaBaseCacheLimit = 0` (git-legal) yields `createLruCache(0)` whose every `set` is
refused — the cache is inert, `probe` always misses, exactly git's "limit 0" outcome.

**Import direction (checked, not left to the implementer).** The new edge is
`pack-registry.ts → internal/resolve-delta-base-cache-limit.ts → config-read.ts`. depcruise's
transitive closure of `config-read.ts` (78 modules) contains `config-scoped-read.ts`,
`internal/config-key.ts`, `internal/config-scope.ts`, `path-layout.ts`,
`internal/layout-verdict.ts` and domain/ports only — no `pack-registry`, `read-object`,
`object-resolver`, `object-caches`, `blob-source` or `read-head-tree` — so the edge closes no
cycle; `deltaBaseCacheBudgetFor` lives in that same module so `pack-registry.ts` gains no runtime
edge into `object-caches.ts` (whose own import of `pack-registry.ts` is type-only). `npm run check:architecture`
(`no-circular`, `viaOnly: dependencyTypesNot: ['type-only']`) is P3's gate oracle.

**Entry cap against a 96 MiB budget.** `DELTA_BASE_CACHE_MAX_ENTRIES = 65_536` is carried forward
(ADR-852). The crossover is a **1 536 B mean entry** (96 MiB / 65 536; ≈ 1 336 B of content after
the 200 B term): chains of commit- and small-tree-shaped intermediates (300 B–1 KB) hit the entry
cap first and retain ≈ 65 536 × (200 + mean) ≈ 32–75 MiB; blob-shaped chains hit the byte cap.
Either way the retained set is 2–6× today's whole budget, so the cap is the right order of
magnitude and does not move; a delta-base entry has no "typical size" for a valve-ordering
invariant, so none is written for it.

**Options.** Five cache options on `OpenNodeRepositoryOptions` / `OpenBrowserRepositoryOptions` /
the memory adapter options (`deltaCacheMaxBytes`, `deltaCacheMaxEntries` existing;
`parsedObjectMemoMaxEntries`, `flatTreeCacheMaxBytes`, `deltaBaseCacheMaxBytes` new), validated
in `validate-options.ts` (`ValidatableOptions:9-20` gains the five; `Number.isInteger(v) && v >= 0`
else `INVALID_OPTION`; no upper bound — the valve is the memory guard) at the four `validateOptions` call
sites (`index.node.ts:57`, `index.browser.ts:63`, `index.default.ts:47`, `repository.ts:554`). `0`
means disabled for every one of them (it already does for `deltaCacheMaxBytes`, which switches
the whole family off through `deltaBaseCachingEnabled` — preserved). The three new ones are
carried on `Context` as an **optional** frozen `readonly cacheBudgets?: CacheBudgets`
(`{ parsedObjectMemoMaxEntries?; flatTreeCacheMaxBytes?; deltaBaseCacheMaxBytes? }`, all
optional — the third has no synchronous default), set by the seven `create*Context` / entry
factories only from what the caller passed, and resolved by `budgetsFor(ctx)` (memo, FlatTree —
sync) and `deltaBaseCacheBudgetFor(ctx)` (async) — the `concurrency?` / `limitFor` house pattern
(`ports/context.ts:225-230`), so every hand-built `Context` literal in the test suite keeps
compiling and behaves as a default-budget Context.

**Footprint (every place this doc quotes one).** Worst-case additive total a `Context` can retain:

| Dial | `ctx.deltaCache` | memo valve | FlatTree | delta-base | **Total** |
|---|---|---|---|---|---|
| defaults (`deltaCacheMaxBytes` 16 MiB, key absent) | 16 | 16 | 8 | 96 | **136 MiB** (was ~34) |
| browser tab, `deltaCacheMaxBytes` 4 MiB, key absent | 4 | 4 | 2 | 96 | **106 MiB** — the delta-base row no longer scales with the dial (ADR-852's stated trade) |
| defaults + `core.deltaBaseCacheLimit = 16m` (or option 16 MiB) | 16 | 16 | 8 | 16 | **56 MiB** |

`deltaCacheMaxBytes` scales the memo and the FlatTree; only the key or `deltaBaseCacheMaxBytes`
scales the delta-base cache. `forgetParsedObjectMemo` unchanged. A sweep on the **large** fixture
(50 k commits) is the honest follow-on and stays out of scope with its reason.

---

### D3 — (c) delta-base cache: per-chain insert budget; `{ type, content }` in the loose-object cache (ADR-854, settled)

#### D3-i — (c-i) per-chain budget at the 96 MiB default

Today one deep read inserts every level (`object-resolver.ts:504-519`): the review's example —
a depth-43 chain over a 400 KB target, ≈ 17 MB of intermediates — flushed a 16 MiB LRU. At
ADR-852's default it no longer does: **the chain budget is ¼ of the configured limit, 24 MiB at
96 MiB**, and that example fits entirely. The budget now binds only for chains whose
intermediates exceed 24 MiB (a 2 MB target at depth ≥ 13, 500 KB at git's default depth 50) —
and it is kept as a **fraction**, not an absolute, so a user who lowers the key to `16m` gets a
4 MiB chain budget and the example binds again. Git has no per-chain rule — this is a tsgit
policy, unobservable by construction (a miss re-reads; bytes identical).

```ts
// object-resolver.ts — resolvePackChainWithDepth
export const DELTA_BASE_CHAIN_INSERT_FRACTION = 0.25;                                   // object-caches.ts
const chainBudget = registry.deltaBaseCache.maxSize * DELTA_BASE_CHAIN_INSERT_FRACTION;   // 24 MiB at the default
let inserted = 0;
const insertLevel = (key, content, chainDepth): void => {                              // base AND every level go through this
  const size = deltaBaseCacheEntrySize(content);
  if (inserted + size > chainBudget) return;                                            // over the chain budget: skip caching, keep applying
  if (cacheDeltaBase(ctx, registry, key, phase1.baseType, content, chainDepth)) inserted += size;   // D1 verdict; `true` whenever enabled
};
if (phase1.deltas.length > 0 && phase1.baseOffset !== undefined) insertLevel(deltaBaseCacheKey(hit.pack.name, phase1.baseOffset), phase1.baseContent, 0);
for (let i = phase1.deltas.length - 1; i >= 0; i -= 1) {                                // nearest the base first (today's order)
  current = applyDelta(current, step.instructions);                                     // ALWAYS applied
  insertLevel(step.probeKey, current, phase1.deltas.length - i + phase1.baseChainDepth);
}
```

**`false` from `set` is unreachable here — re-derived.** `set` refuses iff
`byteSize > maxSize`. `insertLevel` calls `cacheDeltaBase` only when
`inserted + size ≤ chainBudget = ¼ · maxSize`, hence `size ≤ ¼ · maxSize < maxSize` for every
`maxSize > 0` — including the **base** insert, which the first draft left outside the check.
With `maxSize = 0` (the key set to `0`) the chain budget is `0`, so no level ever reaches `set`.
The claim holds for any fraction in `(0, 1)` and any limit, not just the default. `cacheDeltaBase`
therefore returns the verdict for the accounting above and the unit test asserts it is `true` at
every inserted level; no runtime path branches on `false`. `chainDepth` accounting,
`enforcePackBaseCap` on probe hits and the target's own `ctx.deltaCache` insert are unchanged.
**No existing bench exercises the budget** — the delta-chain fixture's chains total far below
24 MiB (further below than the first draft's 4 MiB) — so its only oracle is the unit invariant
(one read inserts ≤ ¼ and retains the base-nearest levels); stated in D11.

#### D3-ii — (c-iii) the loose-object cache stores `{ type, content }` — now, as a major

**What changes and why now** (ADR-854). `ctx.deltaCache` holds `<type> <size>\0content` so that
`parseObject` (`git-object.ts:37`), `RawObject.bytes` and `verifyAndReturn` can consume one
shape; every pack-resolved read pays `prependHeader` (a content-sized copy, ≈ 20–40 µs at
400 KB, ≈ 0.1 µs at a 300 B commit) and every REF-delta base pays `splitHeader` (NUL scan +
`TextDecoder`). The type is known on both sides. Git's own delta-base entry carries the type
beside the data. 31.3 inherits the finished shape instead of migrating mid-rewrite.

```ts
// src/domain/objects/git-object.ts (barrel domain/objects/index.ts:37) — public, api.json
export interface ObjectContent { readonly type: ObjectType; readonly content: Uint8Array; }
/** The typed half of parseObject: dispatch on a known type. parseObject(id, rawBytes, hash) becomes
 *  splitObject + parseObjectContent and stays public (on-disk loose bytes are still this shape). */
export function parseObjectContent(id: ObjectId, type: ObjectType, content: Uint8Array, hash: HashConfig): GitObject;

// src/ports/context.ts:219 (and the RepositoryHandle mirror at :281) — public, BREAKING
readonly deltaCache: LruCache<ObjectContent>;              // was LruCache<Uint8Array>

// src/application/primitives/types.ts:90-96 — public (primitives/index.ts:96), BREAKING
export type RawObject = ObjectContent;                     // `bytes` is gone; the "internal-only" comment was stale
```

**The resolver pipeline** (`object-resolver.ts`):

- `resolveObjectBytesWithDepth` → `resolveObjectContentWithDepth: Promise<ObjectContent & { chainDepth }>`.
  Empty-tree short-circuit returns `{ type: 'tree', content: EMPTY }` (`EMPTY_TREE_BYTES:50`
  retired). Cache-hit arm returns the entry. Loose arm: inflate → `splitObject(inflated)`
  (`content` is a **view**, no copy; the retained backing store still holds the 10-byte header)
  → `cacheEntry` → verify. Pack arm: `{ type: packTypeName(baseType, id), content: current }` →
  `cacheEntry` → verify. `prependHeader` (`:533-545`), `splitHeader` (`:659-682`) and the
  `default` arm of `typeNameToPackType` (`:684-697`, now exhaustive over `ObjectType`) are
  deleted; `resolveBaseForRefDelta` (`:617-657`) returns `{ ...cached, type: objectTypeToPackType(cached.type), chainDepth: 0 }`.
- `enforceCachedCap` (`:149-160`) becomes `cached.content.length > maxBytes` — the NUL scan and
  the "header-less poisoned buffer" branch are dead by type and are removed with their five
  poisoned-cache tests (`object-resolver.test.ts:2536, :2572, :3156, :3195, :3237`).
- **Verification hashes header ‖ content without a buffer**: `verifyObjectContent(ctx, id, type,
  content)` = `createHasher()` → `update(serializeHeader(type, content.length))` →
  `update(content)` → `digestHex()`; replaces `verifyAndReturn` (`:246-262`) on every arm. On Node
  the incremental hash costs the same as one-shot; an adapter whose hasher cannot stream
  (SubtleCrypto) concatenates at digest — the copy **moves to the verify path**, which is off by
  default (ADR-718), rather than sitting on every read. Hashing the **canonical** header is git's own
  `check_object_signature` (`hash_object_file(type, buf, size)`); a loose object stored with a
  non-canonical header never reaches a hash in git — it is refused at header parse (Pin V1) — so
  the arm change is unobservable on any object git accepts (whether tsgit's `parseHeader` admits
  such a header is pre-existing and untouched). Exported for blob-source.
- `cacheEntry` (`:699-703`) charges `content.byteLength + OBJECT_CACHE_ENTRY_OVERHEAD_BYTES`,
  a new **32 B** constant in `object-caches.ts`: the `{ type, content }` wrapper (two in-object
  slots; the type tag is an interned literal, zero marginal bytes) replaces the ≈ 10 header bytes
  the old sizer charged. It is deliberately **not** the delta-base cache's 200 B key + node term:
  `deltaCacheMaxBytes` is a public dial whose documented capacity consumers tuned against, and
  charging 200 B per entry would evict a 50 k-commit walk that fits today — a large-fixture cliff
  hidden by the medium fixture, the class this item exists to remove. Accounting stays byte-based.

**Consumers.** `read-object.ts:176` `readRawObject` returns the payload directly (no
`splitObject`); the eight `readRawObject` callers that use `type`/`content` (`diff-trees.ts:443`,
`internal/deltify.ts:428`, `raw-tree-io.ts:15`, `resolve-tree-path.ts:218,235`,
`walk-raw-subtree.ts:189`, `flatten-raw.ts:204`, `raw-subtree-prefetch.ts:102`,
`read-object.ts:244`) compile unchanged; the one that hashed `raw.bytes`
(`fsck/content-validation.ts:80` → `:203`) hashes `serializeHeader(kind, rawBody.length)` ‖
`rawBody` through the incremental hasher — the loose arm (`:54`) keeps hashing the inflated
on-disk bytes as stored, because a malformed on-disk header must still hash as written.
`internal/blob-source.ts:89-92` cache arm → `resolveFromCache(ctx, id, cached: ObjectContent,
gate)` verifies via `verifyObjectContent` and returns `{ kind: 'bytes', ...cached }`;
`verifyBufferedBytes` (`:153-162`) stays one-shot for the inflated loose arm; `toBytesSource`
(`:140-143`) serves only that arm. `resolveObject` (`:107-123`) calls `parseObjectContent`.
`gc-pipeline.ts:1015` (`delete`) and `repository.ts:729` (`clear`) are value-type-agnostic.
Seven creation sites → `createLruCache<ObjectContent>(…)`.

**What a consumer holding a `Context.deltaCache` has to change** (the migration note for the
release):

```ts
// before (4.x)                                        // after (5.0)
deltaCache: createLruCache<Uint8Array>(bytes, n)       deltaCache: createLruCache<ObjectContent>(bytes, n)
ctx.deltaCache.set(id, looseBytes, looseBytes.length)  ctx.deltaCache.set(id, { type, content }, content.byteLength + 32)
const raw = ctx.deltaCache.get(id)  // bytes           const { type, content } = ctx.deltaCache.get(id) ?? …
raw.bytes  (RawObject)                                 serializeHeader(raw.type, raw.content.length) + raw.content, if a header-prefixed buffer is genuinely needed
```

`reports/api.json` regenerates for `Context`, `RawObject`, `ObjectContent`, `parseObjectContent`.
The breaking commit is the second of P5 (the first adds `ObjectContent` + `parseObjectContent`
additively); it carries `feat(objects)!:` so release-please cuts **5.0.0** (Phase 31 = v5 line).
Stryker directives touched: `object-resolver.ts:621` (the `resolveBaseForRefDelta` shortcut —
re-prove at the new lines: the fall-through now returns the same `ObjectContent` from the same
cache), `:671`/`:676` (drop with `splitHeader`).

---

### D4 — (d) One HEAD reader, one slot, validated by the gate (ADR-855 + ADR-856, settled)

**Mechanism (git).** `files_read_raw_ref` (`refs/files-backend.c`): `lstat`; a symlink mode ⇒
`readlink`, and if the text starts with `refs/` and passes `check_refname_format` it is a
symref, else fall through and read the file; a directory mode ⇒ ENOENT/EISDIR; else `open` +
`read` + `parse_loose_ref_contents`. `validate_headref` (discovery) applies the same symlink
rule. Pin H1: symlinked HEAD → `symbolic-ref HEAD` = `refs/heads/main`, `commit` advances
`main`; a symlink whose text is not `refs/…` fails discovery (`not a git repository`).

**Change.** A new internal module owns every read of `${gitDir}/HEAD` (`readHeadRaw` already
goes through the ref store, so the two readers today really are the gate and `readLooseContent`):

```ts
// src/application/primitives/internal/head-file.ts (new)
export type HeadFile =
  | { readonly kind: 'symlink'; readonly linkText: string }   // lstat said symlink; readlink text verbatim
  | { readonly kind: 'file'; readonly content: string }        // regular file, decoded UTF-8
  | { readonly kind: 'unusable'; readonly cause: unknown };    // absent / EACCES / EISDIR / EIO — the adapter's error, kept

interface HeadSlot {
  readonly identity: string | undefined;   // `${mtimeNs ?? mtimeMs}:${ctimeNs ?? ctimeMs}:${ino}:${size}`; undefined when ino === 0 (not trusted across commands)
  readonly head: HeadFile;
  trusted: boolean;                        // set by the gate's validation, cleared by the next gate, by our own HEAD write, by a mismatch
}
const slots = new WeakMap<Context, HeadSlot>();    // ADR-856: Context identity, like the ref store

/** The gate's read: ALWAYS lstat (1 hop); on identity match reuse the slot; else read once.
 *  Marks the slot trusted for the rest of this command. */
export const validateHead = async (ctx: Context): Promise<HeadFile> => { … };
/** The ref store's read: a trusted slot is returned without I/O; otherwise the same
 *  lstat-validated path as `validateHead` WITHOUT marking trusted (primitive-only sessions keep
 *  per-read freshness at 1 hop instead of 4). */
export const readHeadFile = async (ctx: Context): Promise<HeadFile> => { … };
/** Our own HEAD writes (files ref store `applySet`/`applySetSymbolic` on `HEAD`, `bootstrap.ts:77`). */
export const invalidateHeadSlot = (ctx: Context): void => { slots.delete(ctx); };
```

Read path on a slot miss, in git's order: `lstat` → symlink ⇒ `readlink` (2 hops, identity =
the link's own lstat) · directory ⇒ `unusable` · regular ⇒ **the `lstat`'s `ino` picks the
reader**. `ino !== 0` (Node): `openWithNoFollow(path, 'read')` → `handle.stat()` (identity from
the **same** open file, so the bytes and the identity can never disagree — the brief's "collapse
`lstat`+`readUtf8` into the port's `openWithNoFollow`", ADR-855) → `read` → `close` = 4 hops,
the same count as `readUtf8`'s open/fstat/read/close. `ino === 0` (memory, browser): `readUtf8`
— identity is never trusted there, and the browser adapter's `openWithNoFollow` throws
`UNSUPPORTED_OPERATION` (`browser-file-system.ts:205-207`), so the discriminator that decides
*trust* also decides *reader*; nothing branches on `ctx.runtime`. Warm path on Node: **1 hop**
(`lstat`) per command. Hop accounting (HEAD only; ADR-850's config stat is counted in R2):

| | Today | After (Node, warm) | After (memory/browser: `ino === 0`) |
|---|---|---|---|
| gate (`catFile` warm) | `lstat` + `readFile` = 1 + 4 = 5 hops, 2 calls | `lstat` = 1 hop, **1 call** | `lstat` + `readUtf8` (no hops on memory) |
| `revParse('HEAD')` | 5 + `readFile HEAD` 4 + `readFile refs/heads/main` 4 = 13 hops, 4 calls | 1 + 4 = 5 hops, **2 calls** | lstat + read + read |
| first command in a session | 13 | 1 + 4 (open/fstat/read/close) + 4 = 9 | — |

**Degenerate identity (correction 5).** When the adapter reports `ino === 0` the identity is
`undefined` and the slot is never trusted across commands: the gate re-reads the content every
command (as today) and the ref store reuses that content within the command. Freshness there is
verbatim today's at the command boundary; only Node gets the identity fast path. This is "the
gate is the data" (31.1's pattern), not a capability flag. Node's identity uses
`mtimeNs`/`ctimeNs` when present (git's `stat_data` precedent) and `ino` (git and tsgit write
HEAD by lock-and-rename, so a rewrite mints a new inode).

**Consumers.**

- `hasUsableHead` (`repo-state.ts:130-144`) → `validateHead(ctx)`; the predicate over the result
  is unchanged (`isRefsLinkText` for `symlink`, `isValidHeadContent` for `file`, `false` for
  `unusable`). The existing matrix (`repo-state.test.ts:202-340`) stays green. "HEAD deleted
  between two commands" (`:184-200`) → the second `lstat` misses → slot dropped → refuses.
  Reftable layouts: unchanged (`HEAD` stub read the same way; the reftable ref store never reads
  the slot).
- Files ref store `resolveDirect('HEAD')` (`ref-store.ts:403-415`, `name === HEAD_NAME`): →
  `readHeadFile(ctx)`: `symlink` with `refs/`-prefixed valid text ⇒ `{ kind: 'symbolic',
  target }` (the fix, Pin H1; a non-`refs/` symlink never reaches here — the gate refused);
  `file` ⇒ `parseLooseRef(content)` as today; `unusable` with a `FILE_NOT_FOUND` cause ⇒
  `missing`; any other cause is **rethrown** — a primitive caller on an EACCES/EISDIR HEAD sees
  the same `PERMISSION_DENIED`/mapped errno as today. `headCandidate` (`:462-465`) keeps its
  `exists` probe.
- A write through `applySetSymbolic('HEAD')` over a symlinked HEAD replaces the link with a
  regular file (lock + rename), git's own default too (`create_symref_locked` writes a file
  unless `core.preferSymlinkRefs`); tsgit does not implement `core.preferSymlinkRefs` —
  pre-existing, out of scope.
- `applySet`/`applySetSymbolic` (`:769-785`) call `invalidateHeadSlot(ctx)` when `update.name ===
  HEAD_NAME` after `atomicWriteRef`; `bootstrap.ts:77` (the one raw HEAD writer in `src/`)
  likewise. Reflog-only updates never touch HEAD's file.
- `list-worktrees.ts` per-worktree Contexts (`deriveWorktreeContext`) get their own slot (miss
  once per listing, as today's one read — ADR-856's accepted cost).

**Window that changes (ledger row L1).** Within one command, after the gate validated HEAD, an
external rewrite of HEAD is not observed by that command's later `resolveDirect('HEAD')` calls
(today each opens the file). The window is the command's own duration; the next gate notices.
Git's own process reads HEAD per `resolve_ref` call and would notice mid-process — nothing
observable depends on it (a concurrent `git checkout` during a `git commit` is a race in git
too, resolved by the ref lock, which tsgit also takes on write).

Not touched: non-HEAD symlinked loose refs (`readLooseContent` still follows; pre-existing,
out of scope — noted), `hasUsableHead`'s "collapse every failure to false" contract.

---

### D5 — (e) Config epoch at the gate; (h-i) worktree-scope check through the cache; (h-ii) one config read per ref update (ADR-850, settled)

**(e) Epoch.** The config cache entry gains a `trusted` bit; the operational gate is the one
place that sets it.

```ts
// config-read.ts
interface CachedConfigEntry { readonly promise: Promise<ConfigCacheEntry>; readonly mtimeKey: string; trusted: boolean }
let gateVerdictCache: WeakMap<Context['session'], { readonly promise: Promise<FilePath>; readonly mtimeKey: string }>;

/** Called by `assertOperationalRepository` AFTER `hasUsableHead`: one stat. A changed key drops
 *  the parse entry AND the verdict memo (correction 8 — the verdict is re-derived from fresh
 *  tokens, as git's per-process `git_default_config` would); an unchanged key marks the entry
 *  trusted so every `readConfig` in this command skips its stat. */
export const openConfigEpoch = async (ctx: Context): Promise<void> => { … };

const readConfigEntry = async (ctx) => {
  if (layoutFailsTrustGate(ctx.layout)) return loadConfigEntry(ctx);
  const cached = cache.get(ctx.session);
  if (cached?.trusted === true) return cached.promise;             // inside an epoch: no stat
  … today's stat-validated path, which does NOT set `trusted` …    // primitive-only sessions: per-read freshness kept
};
export const invalidateConfigCache = (ctx) => { cache.delete(…); gateVerdictCache.delete(…); invalidateScopedConfigCache(ctx); };   // unchanged shape: the epoch dies with the entry
```

`memoizeGateVerdict(ctx, compute)` becomes `memoizeGateVerdict(ctx, mtimeKey, compute)`: a memo
whose key differs is recomputed — which is also what re-runs D2-ii's
`findLastInvalidDeltaBaseCacheLimit` after an external edit. `assertOperationalRepository` =
`hasUsableHead` (D4's `validateHead`) → `openConfigEpoch` → memoised verdict. `assertRepository`
(the `config` porcelain's bare gate) does **not** open an epoch (its readers are the scoped cache,
which keeps its own per-call stat — out of scope). Nested gates re-stat: harmless, one hop.

Cost accounting: a command that reads config pays the same one stat as today (moved from its
first `readConfig` to the gate); a command that never reads config (`catFile`, `readBlob`,
`revParse`) pays **one more** stat than today — the price of closing correction 8's verdict gap
(ADR-850 option 1, chosen over the lazy variant).

**Contract (documented on `internals.md`).** A config file changed by tsgit's own writers is
seen on the next read (unchanged — they call `invalidateConfigCache`, which drops the trusted
entry). A raw external write is seen **at the next operational gate** (next command) or the next
`invalidateConfigCache`; a session that never runs a gate keeps per-read staleness detection.
Same-millisecond same-size rewrites were already undetectable (`mtimeMs:size` key) — unchanged.
The pack registry's `core.deltaBaseCacheLimit` read is a **one-time** consumer of this cache
(ledger L7): a later edit is not applied to a registry that already exists.

**Test impact.** Heuristic sweep: 46 test files seed `.git/config` with a raw `writeUtf8`; 3
also call `invalidateConfigCache`; 14 mix a Tier-1 command with a config-reading primitive. The
shape that breaks under the epoch is *gated command → raw config rewrite → config-reading
primitive called directly (no gate)*. Expected set: single digits; the mechanical enumeration is
"land the epoch, run `npm run test:unit`, add `invalidateConfigCache(ctx)` after each raw rewrite
in the failing tests" — the planner lists them from that run. `__resetConfigCacheForTests`
resets the bit.

**(h-i) `isWorktreeScopeActive`.** Reads the local scope's sections through the mtime-validated
sections cache instead of a raw read + parse per call. Correction 10: to keep the import graph
acyclic the predicate moves into `config-scoped-read.ts` next to `readSingleScope` (exported as
today's name from that module; `internal/config-scope.ts`'s `resolveScopePath(ctx, scope)` takes
the worktree verdict from its caller — `resolveScopePath(ctx, 'worktree')` becomes
`resolveWorktreeScopePath(ctx, { active })`, and the three importers (`config-scoped-read.ts`,
`update-config.ts`, `update-config-sections.ts`) pass it). `layoutFailsAcceptance` short-circuit
and the `parseGitBoolean` rule are verbatim. Oracle: `npm run check:architecture` + an
`instrumentedContext` test that an unscoped `config.get` issues no `readUtf8` of the local file
beyond the cached scope read.

**(h-ii) `recordRefUpdate`.** `resolveReflogIdentity(ctx, config?)` accepts the already-read
`ParsedConfig`; `recordRefUpdate` reads once and passes it. Under the epoch both reads are
stat-free anyway; the fold removes the second `readConfig` call (a promise hop), nothing else.

---

### D6 — (f) `packed-refs`: one stat, packed-only oids from the snapshot

**Mechanism (git).** `packed_ref_store` validates by `stat` (`stat_validity_check`) and treats
ENOENT as "no packed refs"; any other failure to read is fatal (Pin P1: a directory at
`.git/packed-refs` → `fatal: couldn't read .git/packed-refs: Is a directory`, exit 128, on
every ref operation).

```ts
// ref-store.ts — loadPackedRefs
async function loadPackedRefs(): Promise<LoadedPackedRefs> {
  const path = packedRefsPath(commonGitDir(ctx));
  let stat: FileStat;
  try { stat = await ctx.fs.stat(path); }
  catch (err) { if (isFileNotFound(err)) return EMPTY_PACKED_REFS; throw err; }   // one stat, not exists + stat
  const key = `${stat.mtimeMs}:${stat.size}`;
  … cache hit / readUtf8 / parse as today …                                        // a directory still fails in readUtf8 exactly as today
}
```

`listRefs` splits the candidate set it already computes: loose names (from
`walkAllLooseRefNames`) resolve through `resolveEntry` (pooled in D7); packed-only names (in
the snapshot, **not** in the loose set) become `{ name, value: { kind: 'direct', id: entry.id } }`
straight from the snapshot — byte-for-byte what `resolveDirect` returns for them today
(`:412-414`), without the `readUtf8` ENOENT per name. Equivalence: a loose name that fails to
parse is excluded and never falls back to packed (today's `resolveEntry` catch) — unchanged,
because loose names still go through `resolveEntry`; a loose file that vanished between
`readdir` and read falls through to the packed map inside `resolveDirect` — unchanged. The
result is sorted after, as today (`byName`). `collectCandidateNames` and `listRefNames` keep
their shapes; `packableEntries` (`:836-841`, `packRefs`) inherits. `packRefs` writes
`packed-refs` and resets `packedCache` (`:889`) — unchanged.

Ledger: no freshness change — the single `stat` per `loadPackedRefs` call is the same staleness
detector as today's `exists`+`stat` pair.

---

### D7 — (g) Loose enumeration through the `ioBound` pool

Four serial loops, each becomes `boundedMapFor(ctx, 'ioBound', items, worker)` (input order
preserved, first rejection propagates, `limitFor` from `ctx.concurrency`):

| Site | Today | After |
|---|---|---|
| `ref-store.ts:564-567` `listRefs` loose arm | `for … await resolveEntry(name)` | `boundedMapFor(ctx, 'ioBound', looseNames, resolveEntry)` → filter `undefined` → concat packed-only → sort |
| `ref-store.ts:881-885` `packRefs` prune probe | serial `exists` per packable | pooled `exists`, `toPrune` filtered in input order; the `rm` loop (`:890-892`) pooled likewise — a failure mid-way leaves an arbitrary subset of loose duplicates instead of a prefix, but `packed-refs` was written first (`:888`) and a surviving loose file holds the same value, so both partial states read identically |
| `reflog.ts:234-241` `resolveTips` | serial `tryResolve` per ref | pooled; `Set` dedup after — under D8 this survives only for the `HEAD` (`UE_HEAD`) case |
| `list-worktrees.ts:202-205` | serial `linkedEntry` per admin dir | `boundedMapFor` over the `readdir` entries, `sort(byPath)` after (already sorted; the pool keeps input order anyway) |

`verifyIntegrity` (`:575-597`) is fsck's and stays serial (out of scope). `resolveDirect`
concurrency on one store is safe: `loadPackedRefs` is a pure read + memo (a concurrent miss
parses twice, never corrupts); the `packedCache` write is a single assignment. The `mainCtx`
ref store shared across worktree Contexts (`list-worktrees.ts:197`) is the same object under the
pool as under the loop.

---

### D8 — (h-v) `reflog expire`: git's reachability rule, bounded walk (ADR-857, settled)

**Mechanism (git, `reflog.c` v2.55.0)** — pinned R1–R7:

- `reflog_expiry_prepare(refname, oid)`: `UE_HEAD` when `refname == "HEAD"` (mark list = every
  ref tip); else `commit = lookup_commit_reference_gently(oid)` (peels tags); non-commit or
  unresolvable ⇒ `UE_ALWAYS`; else `UE_NORMAL` (mark list = that one tip). Then **if
  `expire_unreachable <= expire_total` ⇒ `UE_ALWAYS`** and no walk at all. `mark_limit =
  expire_total`; `mark_reachable` stops descending at `commit->date < mark_limit` (those commits
  are kept as a `leftover` frontier and never expanded — so a commit older than `expire_total`
  is reachable only if it *is* a frontier commit).
- `should_expire_reflog_ent(old oid, new oid, timestamp)`: `timestamp < expire_total` ⇒ **expire**
  (no reachability); else `timestamp < expire_unreachable` ⇒ `UE_ALWAYS` ⇒ expire, otherwise
  expire iff `unreachable(old) || unreachable(new)`, where a null oid or a non-commit is never
  unreachable (kept); else keep.
- `--all` over a log whose ref no longer resolves ⇒ `UE_ALWAYS` (R6: the whole log expired
  under `--expire-unreachable=now`); a *single-ref* expire of such a log refuses `reflog could
  not be found` (R6′ — tsgit's `hasReflog` file probe answers differently; pre-existing, noted).

```ts
// reflog.ts — runExpire (ADR-857). tsgit's cutoffs are already git-shaped for this comparison:
// `resolveExpiryCutoff` maps never → −∞ and all/now → +∞ (git: 0 and TIME_MAX), so
// `never <= anything` and `now <= never` behave exactly as git's `expire_unreachable <= expire_total`.
type ExpireKind = { readonly kind: 'always' } | { readonly kind: 'walk'; readonly tips: ReadonlyArray<ObjectId> };
const expireKindFor = async (ctx, ref, expireCut, unreachableCut): Promise<ExpireKind> => {
  if (unreachableCut <= expireCut) return { kind: 'always' };                      // git: expire_unreachable <= expire_total
  if (ref === 'HEAD') return { kind: 'walk', tips: await resolveTips(ctx) };       // UE_HEAD
  const tip = await peelToCommitOrUndefined(ctx, ref);                              // lookup_commit_reference_gently
  return tip === undefined ? { kind: 'always' } : { kind: 'walk', tips: [tip] };   // UE_ALWAYS | UE_NORMAL
};
/** Lazy, date-bounded marking over `readCommitMeta` (graph-first, 31.1): expands a commit only
 *  while `committerDate >= expireCut`; `isUnreachable(oid)` extends the walk from the leftover
 *  frontier before answering, as git's `unreachable()` does. */
const shouldExpire = (entry, kind, reach, expireCut, unreachableCut): boolean =>
  entry.identity.timestamp < expireCut ||
  (entry.identity.timestamp < unreachableCut &&
    (kind.kind === 'always' || reach.isUnreachable(entry.oldId) || reach.isUnreachable(entry.newId)));
```

Null oids (`0000…`) and non-commit oids are "reachable" (kept) exactly as `unreachable()`
returns 0 for them — and both `lookup_commit_reference_gently` calls **peel tags**: the ref's
tip (`UE_NORMAL`), every tip under `UE_HEAD` (`push_tip_to_list`, non-commits skipped), and each
entry's `old`/`new` oid before the reachability test. So `resolveTips` (D7-pooled) resolves with
`{ peel: true }` and drops non-commits, and `isUnreachable(oid)` peels through `readObject`
before consulting the marks — today's `collectReachable` seeds `walkCommits` with **unpeeled**
tips, another pre-existing gap the rewrite closes. The per-ref walk replaces one whole-history
walk per `expire` with a walk from one tip bounded at `expire_total` — on the default clocks
(`90.days.ago`) that is the last 90 days of one branch, not the repository.

**Observable change (R1–R7 all flip to git's answers).** Recorded in ADR-857 with the interop
matrix as its pin; ADR-064's "fully faithful" paragraph is superseded. Unit tests
`reflog.test.ts:742-960` encode today's rule and are rewritten to the matrix.

---

### D9 — (h-iv) `rev-parse` candidate sweep without thrown misses

```ts
// resolve-ref.ts
type ChainOutcome = { readonly kind: 'found'; readonly id: ObjectId } | { readonly kind: 'missing'; readonly name: RefName };
// resolveDirectChain(refStore, initial, maxDepth): Promise<ChainOutcome> — today's loop, `missing` instead of throwing at :51-53
/** `resolveRef` minus the terminal refusal: `undefined` when the chain ends at a missing ref.
 *  Every other failure (cycle, depth, bad content, invalid name) still throws exactly as today. */
export const resolveRefOrMissing = async (ctx, name, options?): Promise<ObjectId | undefined> => { … peel as resolveRef … };
export async function resolveRef(ctx, name, options?) {
  const outcome = await resolveDirectChain(getRefStore(ctx), name, maxSymbolicDepth);
  if (outcome.kind === 'missing') throw refNotFound(outcome.name);   // the name the chain ENDED on, as today
  return peel ? peelChain(ctx, outcome.id, maxPeelDepth) : outcome.id;
}
```

Care: today `refNotFound(current)` names the ref the chain **ended** on (a dangling symref
`refs/heads/x → refs/heads/gone` reports `gone`), which is why the chain returns the name and
`resolveRef` throws with it — the message is unchanged; `options.peel` is threaded
(`commit-ish.ts:24` passes `{ peel: true }`). `rev-parse.ts:65-71` and `commit-ish.ts:22-28`
call `resolveRefOrMissing` inside the same `try/catch { continue }` (git's `expand_ref`
continues past broken/dangling candidates, so swallowing non-miss errors stays).
`refCandidates` stays an array — `canonicalizeRef` (`rev-parse.ts:109-124`) iterates it twice,
so a generator would break it, and six short strings cost ≈ 0.3 µs; the two stack captures are
where the time goes. Per miss after this change: 0 thrown `REF_NOT_FOUND`; the adapter's
`FILE_NOT_FOUND` on the loose probe remains (31.3's `tryReadUtf8`). The existing
`AMBIGUOUS_OID_PREFIX` / `OBJECT_NOT_FOUND` fallbacks are untouched. `rev-parse.bench` gains an
abbreviated-oid row, the only shape that exercises the sweep (D11).

---

### D10 — (h-iii) `appendUtf8` attempts first, `mkdir` on ENOENT

```ts
// node-file-system.ts — appendUtf8
await runFs(async () => {
  try { await this.fsOps.appendFile(real, content, { encoding: 'utf-8', flag: APPEND_FLAGS }); }
  catch (err) {
    if (!isErrnoException(err) || err.code !== 'ENOENT') throw err;
    await this.fsOps.mkdir(this.pathPolicy.dirname(real), { recursive: true });
    await this.fsOps.appendFile(real, content, { encoding: 'utf-8', flag: APPEND_FLAGS });   // once; a second ENOENT propagates
  }
}, path);
```

`resolveWrite` + `assertWritableLeaf` unchanged (the leaf check precedes the attempt as today).
Memory and browser adapters already create parents implicitly and issue no `mkdir` — unchanged.
`write`/`writeUtf8`/`writeExclusive` keep their `mkdir`-first shape: 31.4(e) owns the checkout
write path, and `writeExclusive` is the ref-lock path whose parent almost always exists — same
fix applies but its harness is 31.4's `checkout.bench`. Oracle: `node-file-system-injected.test.ts`
pattern — an `fsOps` double records that an append into an existing directory issues **no**
`mkdir`, a missing parent issues `mkdir` then a second `appendFile`, and a non-ENOENT failure
propagates without `mkdir`.

---

### D11 — Harness

**Which oracle proves which item** (honesty first):

| Item | Bench / oracle | Status |
|---|---|---|
| (a) memo | `log.bench` both rows, medium, `bench:ab` main-vs-branch (review: 21–30 → 9.4–11.5 ms) | exists |
| (b-i) FlatTree | `status.bench` medium, `bench:ab` **locally** on the generated fixture (review: 145 → 138). The CI nightly `status` row measures the tar-restored stat-invalid state (31.4/F4) until 31.4 lands — not publishable from the nightly for this item; say so in the PR | exists, CI row polluted |
| (b-ii) `set` verdict | structural; unit only | no bench by nature |
| (c-i) per-chain budget | **none** — `delta-chain-read.bench`'s chains total far below the 24 MiB chain budget, so it never binds on any existing fixture; unit invariant only (D3-i). A fixture whose intermediates exceed 24 MiB would make it measurable and is not built here (cost: a new generated fixture family) | **no honest bench today** |
| (c-ii) `core.deltaBaseCacheLimit` | correctness (C-matrix interop); fs-count: the registry's config read inside a gated command issues zero `stat` of `config` (unit, `instrumentedContext`); `delta-chain-read.bench` warm rows non-regression | pinned + unit |
| (c-iii) `{ type, content }` | `delta-chain-read.bench` (all three rows — every pack-resolved read loses one `prependHeader`) and `loose-read.bench` (loose arm unchanged in cost: `splitObject` is a view) `bench:ab`; the ≤ 40 µs/400 KB number is ADR-854's, from the review, not re-measured | exists (non-regression) |
| (d) HEAD | fs-count oracle (`floor-oracle.mjs` below) on `revParse('HEAD')` (4 → 2 calls) and `catFile` (2 → 1); `rev-parse.bench`, `cat-file.bench` `bench:ab` | exists |
| (e) epoch | fs-count on `branch.create` (16 → ≤ 12, exact recorded) and on a `commit` of one file (`stat .git/config` per `writeObject` → 1 per command); `commit.bench` `bench:ab` | exists |
| (f) packed-refs | new `tag-list.bench` 2 000 / 10 000 packed; fs-count on `tag.list` 2 000 (6 005 → ≈ 4) | **new** |
| (g) pooled | new `branch-list.bench` 1 000 loose (79 → 12–14 ms review); `list-worktrees`/`packRefs` prune: unit only (N small in every fixture) | **new** / unit |
| (h-i) worktree scope | fs-count on `config.get` (9 → ≈ 6); unit | script |
| (h-ii) ref-update fold | subsumed by (e)'s `branch.create` count | — |
| (h-iii) `appendUtf8` | 15 vs 57 µs is inside `commit.bench`'s noise; unit only | **no honest bench** |
| (h-iv) rev-parse sweep | new `rev-parse.bench` row `When revParse() resolves an abbreviated oid, Then measure tsgit` | **new row** |
| (h-v) reflog expire | correctness (interop matrix); no bench exists and the medium fixture's dates are seconds apart so a 90-day cut walks everything anyway | **no bench; pinned instead** |

**New bench files** (in-process scratch repositories built with tsgit's own primitives, never
`git`, never the shared cache — the 31.1 `name-rev.bench` many-tag pattern and
`fixture-scratch.ts`'s `removeSync` teardown):

- `test/bench/tag-list.bench.ts`: `setupSmallRepo()` base (`test/bench/fixtures.ts:50`), N
  lightweight tags via `updateRef` in a `boundedMapFor` loop, then `repo.packRefs()` (ADR-707) so
  every tag is packed-only; rows `When tag.list() lists 2000 packed tags, Then measure tsgit`
  and `… 10000 …`. Assert in the fixture builder that `refs/tags/` is empty after packing.
- `test/bench/branch-list.bench.ts`: 1 000 loose branches via `updateRef`; row `When
  branch.list() lists 1000 loose branches, Then measure tsgit`.
- `test/bench/rev-parse.bench.ts`: the abbreviated-oid row (7-hex prefix of the medium head
  commit).

Series keys are the `gh-pages` snapshot keys (`tooling/bench-to-snapshot.ts`); three series
start, none end — `bench-check` reports them `new` (non-blocking). `docs/perf/baseline.*` is
**not** regenerated (the `profile` workload set is unchanged).

**fs-count oracle** (implementation-time, recorded in the PR body, not CI): `fs-count.cjs`
verbatim from the 31.1 brief (`.claude/perf-31-1-closure-walks-prompt.md:107-113`) plus a
`floor-oracle.mjs` that opens `~/.cache/tsgit-bench/medium-v3` through `dist-profile` and runs
each of `revParse('HEAD')`, `catFile({ ids: [head] })`, `branch.create` (+ delete), `tag.list`
on a 2 000-packed-tag scratch, `config.get('user.name')` twice, and a first `readObject` after
`revParse` (the registry's config read), printing `__fsCounts.snapshot()` for the second
iteration. Before/after tables go in the PR.

**`bench:ab` rows read for non-regression**: `rev-parse` (both rows), `cat-file`, `log` (both),
`status` medium (local), `commit`, `delta-chain-read` (all three), `loose-read` (both),
`tag-list`, `branch-list`, `maintenance gc` (delta-base + closure paths). Absolute wall-clock
both sides, alternating rounds; published numbers only from the nightly artifact.

---

### Freshness ledger (what an external writer can observe)

Every cache or epoch this design adds or changes, with the exact window in which an
**external** mutation (not through tsgit's own writers) goes unnoticed. "Today" columns are
verified against the current code.

| # | State | Today | After | Window that changes |
|---|---|---|---|---|
| L1 | `${gitDir}/HEAD` content | read on every `resolveDirect('HEAD')` and at every gate | Node: `lstat`-identity check at every gate; trusted for the rest of that command. Memory/browser (`ino === 0`): re-read at every gate, reused within the command | **Within one command** after its gate. Same-identity rewrite (same `mtimeNs`, `ctimeNs`, `ino`, `size`) on Node — requires an in-place write within one ns tick; git-style lock-and-rename always changes `ino` |
| L2 | `.git/config` for `readConfig` consumers | `stat` on every sequential read (same-ms same-size rewrites undetectable) | one `stat` at every operational gate; trusted within the command; per-read `stat` when no gate ran (primitive-only sessions) | **Within one command** after its gate |
| L3 | `.git/config` for the **gate verdict** | session-memoised; external edits never re-validated until `invalidateConfigCache` | re-validated by the gate's `stat` every command (ADR-850) | **Improves** (closes correction 8) |
| L4 | `packed-refs` | `exists` + `stat` per load, `mtimeMs:size` key | one `stat` per load, same key | none |
| L5 | scoped config (`config` porcelain) | `stat` per `readSingleScope`; worktree flag raw-read per call | `stat` per `readSingleScope`; worktree flag from the cached local read | none (the raw read had no cache to be staler than) |
| L6 | parsed memo / FlatTree / delta-base | immutable-object caches; gc `forget`s | same, larger | none |
| L7 | `core.deltaBaseCacheLimit` → delta-base cache **size** | not read | read once when the session's pack registry is constructed (first object read); neither `invalidateConfigCache` nor `refreshPackRegistry` re-sizes an existing registry; a fresh `openRepository` (new session) sees the new value. The **refusal** of a malformed value follows L3 (gate, every command) | **Per session**, like git's per-process read — new window, stated |

---

### Cross-item ownership (who edits what, who inherits)

| Function | Owner | Inherits |
|---|---|---|
| `repo-state.ts` `assertEagerConfigValid` | D2-ii (P3) — the new finder call, last | D5 leaves it |
| `repo-state.ts` `hasUsableHead` | D4 (P6) | D5 leaves it; `assertOperationalRepository` gains the epoch call (P7) after P6 lands |
| `config-read.ts` `ParsedConfig.core` / `mergeCore` / new finder | D2-ii (P3) | D5 (P7) adds the `trusted` bit to `CachedConfigEntry` and re-keys the verdict — different functions, same file, ordered P3 → P7 |
| `pack-registry.ts` `createPackRegistry` | D2-ii (P3) — async, budget from `deltaBaseCacheBudgetFor` | D3-i reads `registry.deltaBaseCache.maxSize` (P4) |
| `read-object.ts` `getPackRegistry` (+ 19 callers) | D2-ii (P3) — `Promise<PackRegistry>` via memo | D3-ii (P5) edits `readRawObject`'s body only |
| `object-caches.ts` | D2-i (budgets, constants, `budgetsFor`) → D3-i (`cacheDeltaBase` returns the verdict, `DELTA_BASE_CHAIN_INSERT_FRACTION`) → D3-ii (`OBJECT_CACHE_ENTRY_OVERHEAD_BYTES`) — P2, P4, P5 in that order | D1's `set` verdict flows through |
| `object-resolver.ts` `resolvePackChainWithDepth` | D3-i (P4) the insert loop; D3-ii (P5) the tail (`{ type, content }` instead of `prependHeader`) | sequential, P4 then P5 |
| `object-resolver.ts` everything else in D3-ii | D3-ii (P5) | — |
| `ref-store.ts` `resolveDirect` HEAD arm | D4 | D6/D7 never touch `resolveDirect` |
| `ref-store.ts` `loadPackedRefs` | D6 | D7 calls it concurrently (safe, D7) |
| `ref-store.ts` `listRefs` | D6 splits loose/packed; **D7 pools the loose arm in the same part** (P8, two commits) | `packableEntries`/`packRefs` inherit both |
| `reflog.ts` `resolveTips` | D7 pools it | D8 narrows its use to `UE_HEAD` — P8 lands first, P9 keeps the pooled helper |
| `config-read.ts` cache entry / verdict memo | D5 | `resolve-max-tree-depth` / `write-object` / `record-ref-update` / the registry's config read inherit stat-free reads without edits |
| `record-ref-update.ts` | D5 (h-ii) | D10 changes only the adapter under `appendReflogFile` |
| `LruCache` type | D1 | every `set` caller unchanged unless listed in D1 |
| `Context` (`cacheBudgets`, `deltaCache` value type) | D2-i adds `cacheBudgets` (P2); D3-ii flips `deltaCache` (P5) | two api.json regens on the same file, P2 then P5 |
| `OpenRepositoryOptions` family + `validate-options.ts` | D2-i | — |

---

### Empirical pin matrix (git 2.55.0)

All probes in `mktemp -d` throwaways, `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*`
scrubbed, `commit.gpgsign=false`, deterministic dates, `git init -b main`. Git source quotes
from the `v2.55.0` tag (`reflog.c`, `refs/files-backend.c`, `setup.c`).

#### H — HEAD as a symlink

| Probe | Result |
|---|---|
| H1 | `rm .git/HEAD; ln -s refs/heads/main .git/HEAD`; `git commit --allow-empty` → `rev-parse main` **advanced** (= `rev-parse HEAD`), `symbolic-ref HEAD` = `refs/heads/main` (exit 0), `HEAD` is still a symlink after the commit, both `logs/HEAD` and `logs/refs/heads/main` gained a line |
| H2 | `ln -s foo .git/HEAD` (link text not `refs/…`, `foo` holding an oid): every command → `fatal: not a git repository`, exit 128 — discovery's `validate_headref` refuses; tsgit's `isRefsLinkText` already matches |
| H3 (source) | `files_read_raw_ref`: `lstat` → symlink mode ⇒ `readlink`; `starts_with(buf, "refs/") && !check_refname_format` ⇒ symref flag; otherwise fall through to `open`/`read`; directory mode ⇒ `ENOENT` |

#### P — `packed-refs`

| Probe | Result |
|---|---|
| P1 | `mkdir .git/packed-refs` → `for-each-ref`, `tag -l`, `rev-parse refs/heads/main`, `branch -l` all `fatal: couldn't read .git/packed-refs: Is a directory`, exit 128 |
| P2 | absent `packed-refs` → `tag -l` empty, `for-each-ref` lists loose refs, exit 0 |

#### C — `core.deltaBaseCacheLimit` (added in this revision; a two-commit repo with one pack)

| Probe | Command / value | Result |
|---|---|---|
| C1 grammar | value ∈ { `96m`, `96M`, `98304k`, `1K`, `100663296`, `1g`, `0`, `0x6000000` } | every probed command exit 0 — unit suffixes (×1024ⁿ), hex, and `0` accepted |
| C1 grammar | value ∈ { `-1`, `abc`, `96x`, `1.5m`, `` (empty), valueless key } | `fatal: bad numeric config value '<v>' for 'core.deltaBaseCacheLimit' in file .git/config: invalid unit`, exit 128 (`''` is printed for the empty and valueless forms) — a negative is a **syntax** refusal (`invalid unit`), git's unsigned-long grammar |
| C1 grammar | `99999999999999g` | `… out of range`, exit 128 |
| C2 die-set | value `-1`; 64 invocations, 60 distinct commands | **dies (46):** `rev-parse` (any form, incl. `--git-dir`), `for-each-ref`, `show-ref`, `update-ref`, `reflog show/expire`, `describe`, `ls-files`, `status`, `diff`, `log`, `show`, `cat-file`, `hash-object -w`, `write-tree`, `read-tree`, `checkout`, `switch`, `merge-base`, `name-rev`, `rev-list`, `worktree list`, `stash list`, `sparse-checkout list`, `check-ignore`, `check-attr`, `ls-remote`, `fsck`, `gc`, `repack`, `bundle create`, `commit`, `reset`, `rm`, `add`, `mv`, `blame`, `grep`, `clean`, `cherry-pick`, `revert`, `rebase`, `apply`, `verify-pack`, `index-pack`, `ls-tree`, `archive`, `submodule status`, `maintenance run`. **runs (14):** `symbolic-ref`, `branch --list`, `tag -l`, `check-ref-format`, `hash-object` (no `-w`), `count-objects`, `config`, `var`, `remote -v`, `notes list`, `pack-refs --all`, `prune`, `init`, and `bisect log` (exit 1 for its own reason — no bisection in progress — not the key) |
| C3 ordering | `[core] sparseCheckout = not-a-bool` + `deltaBaseCacheLimit = -1` (either line order); likewise `compression = 99` + the key | the streaming class (`bad boolean config value … core.sparsecheckout` / `bad zlib compression level 99`) is reported first in 27 of 33 commands; **`diff`, `status`, `commit`, `gc`, `bundle create`, `rebase`** report `core.deltaBaseCacheLimit` first. `maxTreeDepth = abc` + the key: `core.maxtreedepth` first in every command, either order |
| C4 last-wins | `deltaBaseCacheLimit = -1` then `= 96m` → exit 0; `= 96m` then `= -1` → dies; valueless then `= 1m` → exit 0 | config-set resolution (last write wins), like `core.maxTreeDepth`, unlike the streaming classes |
| C5 `-c` override | file `= -1`; `git -c core.deltaBaseCacheLimit=1m rev-parse HEAD` → exit 0; `-c …=abc` over a valid or invalid file → `… for 'core.deltaBaseCacheLimit': invalid unit` (no `in file` suffix) | an overridden file value is never validated; a malformed override is |
| V1 loose header (for D3-ii's verify path) | a loose blob rewritten on disk with a non-canonical header — `blob 07\0`, `blob  7\0`, `blob 7 \0` — under its canonical id | `cat-file -p`/`-s`: `error: unable to parse <id> header`, exit 128; `fsck`: `object corrupt or missing` — git never hashes a non-canonical stored header, it refuses to parse it |

#### R — `reflog expire` (history: A(…000) → B(…100) on `main`; `side` = B → C(…200); `main` reset to A, so `main`'s log is `0→A`, `A→B`, `B→A`; B reachable only from `side`; later D(…200) committed on main then reset away — D unreachable from every tip)

| Probe | Command | Result (entries kept) |
|---|---|---|
| R1 | `--expire=now --expire-unreachable=never refs/heads/main` | **0 of 3** — `expire_unreachable (0) <= expire_total (TIME_MAX)` ⇒ `UE_ALWAYS`; `timestamp < expire_total` expires all |
| R2 | `--expire=never --expire-unreachable=now refs/heads/main` | **1 of 3**: `0→A` kept; `A→B` expired (B unreachable from `main`'s tip A although reachable from `side`); `B→A` expired (**old** oid B unreachable) |
| R3 | `--expire=never --expire-unreachable=now HEAD` | **6 of 6** — `UE_HEAD` marks from every tip (`main`=A, `side`=C); A, B, C all reachable |
| R4 | `--expire=never --expire-unreachable=never refs/heads/main` | 3 of 3, no walk |
| R5 | `--expire=1700000050 --expire-unreachable=1700000150 refs/heads/main` | 1 of 3: `0→A` (ts …000 < 050) expired; `A→B` (ts …100 < 150, B unreachable) expired; `B→A` (ts …200) kept |
| R6 | with D: `--expire=now --expire-unreachable=never` → 0 of 4; `--expire=never --expire-unreachable=now` → 2 of 4 (`B→D` and `D→B` expired: D unreachable, checked on both sides); `--expire=1700000150 --expire-unreachable=1700000050` → 2 of 4 (the two ts …200 entries; `unreachable < total` ⇒ no reachability consulted) |
| R6′ | `--all --expire=never --expire-unreachable=now` after `rm refs/heads/gone` (log kept): `gone`'s log **fully expired** (unresolvable ref ⇒ `UE_ALWAYS`); single-ref `expire refs/heads/gone` → `error: reflog could not be found`, exit 255 (tsgit's file-presence `hasReflog` would proceed — pre-existing, out of scope) |
| R7 | `update-ref refs/heads/<name> <blob>` → `fatal: trying to write non-commit object … to branch` — a non-commit tip is reachable only via tags (`core.logAllRefUpdates=always`); the `UE_ALWAYS`-on-non-commit rule is transcribed from source, not exercised |

**tsgit today** on R2 (code-derived: `keepEntry` all-tips, `newId` only): keeps 3 of 3; on R6
`--expire=now --expire-unreachable=never`: keeps `B→D` (D unreachable ⇒ `never` clock); on R6
`--expire=never --expire-unreachable=now`: keeps `D→B` (newId B reachable). Three divergences.

Git source (`reflog.c`): `reflog_expiry_prepare` — `if (!cb->cmd.expire_unreachable ||
is_head(refname)) UE_HEAD; else { commit = lookup_commit_reference_gently(oid, 1); … UE_NORMAL :
UE_ALWAYS } if (cb->cmd.expire_unreachable <= cb->cmd.expire_total) UE_ALWAYS; … mark_limit =
expire_total; mark_reachable(cb)`. `should_expire_reflog_ent` — `if (timestamp <
cb->cmd.expire_total) return 1; … if (timestamp < cb->cmd.expire_unreachable) { switch (kind) {
case UE_ALWAYS: return 1; case UE_NORMAL: case UE_HEAD: if (unreachable(cb, old_commit, old) ||
unreachable(cb, new_commit, new)) return 1; } }`. `unreachable` — null oid ⇒ 0; non-commit ⇒ 0;
`REACHABLE` flag ⇒ 0; else extend `mark_reachable` from the leftover list and re-test.
`mark_reachable` — pops pending, sets `REACHABLE`, and `if (commit->date < expire_limit)
{ leftover; continue; }` before expanding parents.

---

## Decision candidates

Settled record. Every candidate the first draft raised was ratified on 2026-09-11; two went
against the draft's recommendation (DC-2's delta-base row and DC-4) and this revision folds them
through. Each row names its ADR — the ADR is the binding text, this table is the map.

| # | Choice | Ratified outcome | Draft recommended | ADR |
|---|---|---|---|---|
| DC-1 | Config freshness contract | **Gate-armed epoch** — one `stat` in `assertOperationalRepository`, entry trusted for the command, verdict memo re-keyed on the stat; primitive-only sessions keep per-read stats; a raw external write is seen at the next command or `invalidateConfigCache` | same | [ADR-850](../adr/850-config-is-read-once-per-command-at-the-operational-gate.md) |
| DC-2 | Cache budgets — memo and FlatTree | **Entry-first bounds, explicit options, conservative defaults**: memo 32 768 entries + 16 MiB valve, FlatTree 8 MiB; the valve-ordering invariant is a test | same (a′) | [ADR-851](../adr/851-derived-object-caches-are-bound-by-entries-with-explicit-budgets.md) |
| DC-2 | Cache budgets — delta-base | **Honour `core.deltaBaseCacheLimit`, git's 96 MiB default, on every adapter, no adapter gate**; `createPackRegistry` reads config at construction; family total ≈ 136 MiB at defaults | **against** — the draft recommended `deltaBaseCacheMaxBytes = deltaCacheMaxBytes` (16 MiB) and rejected the key over "an async config read at registry creation and a 96 MiB default wrong for a browser tab"; both were weighed and overruled | [ADR-852](../adr/852-the-delta-base-cache-honours-core-delta-base-cache-limit.md) |
| DC-3 | What "`LruCache.set` reports a refusal" means | **`set(): boolean`**, refusal = `false`; loudness lives in tests, no runtime channel | same (a) — ADR-853's text attributes the typed-verdict option to the draft; the draft's table recommended (a) | [ADR-853](../adr/853-lru-cache-set-reports-an-over-cap-refusal-as-a-boolean.md) |
| DC-4 | `{ type, content }` in `ctx.deltaCache` | **Change the public value type now**, major release; `prependHeader`/`splitHeader` retired; a caller needing a header-prefixed buffer synthesises it at the point of need | **against** — the draft recommended deferring to 31.3 and taking only the `TextDecoder` trim | [ADR-854](../adr/854-the-loose-object-cache-stores-type-and-content.md) |
| DC-5 | HEAD slot identity | **`lstat` identity `(mtimeNs\|mtimeMs, ctimeNs\|ctimeMs, ino, size)` trusted across commands only when `ino !== 0`**; `ino === 0` adapters re-read at each gate and share within the command; the miss-path read on Node goes through `openWithNoFollow` so bytes and identity come from one handle; symlinked HEAD resolves `symbolic` | same (a) | [ADR-855](../adr/855-head-freshness-is-the-gate-lstat-identity.md) |
| DC-6 | HEAD slot keying | **`WeakMap<Context, HeadSlot>`** — state read through a Context's own `fs` keys on the Context, not the session (refines ADR-722) | same (a) | [ADR-856](../adr/856-the-head-slot-is-keyed-on-context-identity.md) |
| DC-7 | `reflog expire` reachability rule | **Git's model in-PR**: `UE_ALWAYS`/`UE_HEAD`/`UE_NORMAL`, `timestamp < expire` unconditional, old + new checked, walk bounded at `expire_total`; ADR-064 superseded in scope; Pins R1–R7 as interop tests | same (a) | [ADR-857](../adr/857-reflog-expire-follows-git-reachability-rule.md) |

**Rejected candidates — not decisions** (carried from the first draft, plus two this revision
adds):

- *Where the HEAD reader lives* — `primitives/internal/head-file.ts`: the gate cannot construct
  a ref store for a reftable layout it has not validated yet, and the files store must share the
  slot; a module both import is the only acyclic shape.
- *Parallelising the gate's `lstat HEAD` and `stat config`* — saves one round-trip latency
  (~10 µs) at the cost of reading config on a non-repository before refusing; 31.3 batches the
  open-time probes and can fold the gate in — left sequential.
- *Epoch scoped to the Repository facade `guard()`* — no post-call hook exists (`repository.ts:744`
  is a pre-call disposal check), and command functions called directly bypass the facade; the
  gate is the only boundary every command crosses.
- *`packed-refs` directory handling* — a directory stat succeeds and the read fails with the
  adapter's EISDIR mapping exactly as today (git: fatal, P1); nothing to decide.
- *Pool bucket for loose enumeration* — `ioBound`, the bucket `packRefs` already uses.
- *`refCandidates` order* — unchanged (git's `ref_rev_parse_rules`); only laziness added.
- *`appendUtf8` retry count* — one `mkdir` + one retry; a second ENOENT is a real fault.
- *Honouring `gc.reflogExpire*` config in `expire`* — pre-existing gap; out of scope (ADR-857).
- *A lazily-sized delta-base cache inside a still-synchronous registry* (new) — resolve the
  budget on the first `assertLoadable()` and hold `deltaBaseCache` in a mutable slot. Rejected:
  it adds an "only defined after the store gate" invariant that `probeDeltaBaseCache` (sync, on
  the hot path) would have to tolerate or assert, and the two `clear()` sites would have to guard
  it; ADR-852 fixes the moment as construction, and an async constructor behind a single-flight
  memo is the plain reading with 20 mechanical `await`s and no public change.
- *A 200 B sizer term for the loose-object cache, mirroring `DELTA_BASE_CACHE_ENTRY_OVERHEAD_BYTES`*
  (new) — rejected in D3-ii: it would shrink what a public dial retains by ≈ 40 % for small
  objects and evict a 50 k-commit walk that fits today; the 32 B wrapper term is the honest
  marginal delta of the new shape.

## New decision candidates

Folding ADR-852 through surfaced **two** load-bearing choices no ADR covers, both on the newly
honoured key. Neither is manufactured: each changes a unit test's expected value and a sentence
on `internals.md`, and each has a git pin (C5, C2/C3) that argues for one side.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| NDC-1 | **Precedence between the explicit `deltaBaseCacheMaxBytes` option and `core.deltaBaseCacheLimit`** — ADR-852 names "two levers, in this order" without saying which wins when both are set | (a) **the option wins**, and when it is set the key is neither read nor validated — tsgit's option is git's `-c`: last-wins in the config set, and git validates no file value a `-c` overrides (Pin C5). (b) the key wins; the option only replaces the absent-key default of 96 MiB — the literal "in this order" reading; a host that must cap memory cannot, if the repository's config says `96m`. (c) `min(option, key)` — a ceiling semantic (the host caps, the repo may only lower); no git analogue, and a user raising the key above the option is silently ignored | **(a)** | It is the only alternative with a pinned git precedent, it is what an embedding host (the browser case ADR-852 itself raises) needs, and it makes the gate finder's skip condition (D2-ii) a faithful transcription of C5 rather than a convenience. |
| NDC-2 | **Where a malformed `core.deltaBaseCacheLimit` is refused, and in which order against the other `[core]` classes** — git dies in 46 of 60 pinned commands (C2) at `prepare_repo_settings`, a point tsgit has no equivalent of | (a) **eager at the operational gate** (`assertEagerConfigValid`, every gated command; last-wins finder; ordered after `core.maxTreeDepth` and after the five streaming classes — git's majority, C3) **plus** the lazy twin at `resolveDeltaBaseCacheLimit` for primitive-only sessions — the `core.maxTreeDepth` house pattern. Divergence: tsgit refuses `branch.list`, `tag.list`, `remote`, `notes.list`, `packRefs` where git 2.55 runs (pinned), and reports the numeric refusal *after* a streaming-class refusal in the six commands where git reports it first. (b) **lazy only**, at registry construction (first object read): no gate change. Divergence: `revParse`, `reflog show`, `worktree list`, `sparseCheckout list`, ref-only `branch`/`tag` verbs run where git dies, and the refusal surfaces mid-command after the gate passed. (c) gate-eager with an ordering that matches `status`/`commit` (the key before the streaming classes): matches 6 commands, mismatches 27 | **(a)** | Both (a) and (b) diverge on a pinned set; (a) diverges **fail-closed** (refuses where git runs) and at one boundary with one memoised verdict and one test shape, (b) diverges **fail-open** and lets a command start work before refusing. (a) also keeps the primitive path covered exactly as `core.maxTreeDepth` does. The over-refused set is five ref-only verbs and the ordering mismatch is observable only when two classes are malformed at once — both recorded in the ADR and in `config-interop`. |

---

## Test strategy

House rules: `describe('Given …')` › `describe('When …')` › `it('Then …')`, AAA, `sut`; 100 %
coverage; every error assertion checks `data`; guard clauses tested in isolation; no ignore
directives. Property lenses: `lru-cache.properties`-style sequences already exist
(`lru-cache.test.ts:498-575`); the `set` verdict adds an invariant to them (`set` returns
`false` iff `byteSize > maxSize`, and a `false` never changes `currentSize`/`entryCount`). The
`core.deltaBaseCacheLimit` value parser is `parseGitInt`, already property-tested in
`config-ini.properties.test.ts`; the new finder is a total function over tokens with a small
enum of outcomes — a parameterised sweep, not a property. The expire predicate likewise.

### Unit, per item (mutation-resistant shape)

| Item | Tests (file) | Kill shape |
|---|---|---|
| D1 | `lru-cache.test.ts`: `set` over-cap → `false`, cache unchanged (size, count, order); in-cap → `true`; the existing "single 200-byte entry in cache(50)" case (`:341`) asserts the verdict; property invariant above | Return-literal mutants; `>` vs `>=` at the exact cap (`:430` "totaling exactly 100" case extended: `set` at exactly `maxSize` → `true`) |
| D2-i memo | `object-caches.test.ts`: 5 000 distinct commit-shaped entries at the default budget → `entryCount === 5 000`; `parsedObjectMemoMaxEntries` option honoured; a 64 KiB-message entry stored; the valve-admits-entries invariant (`32_768 × 512 ≤ 16 MiB`) as a literal test, plus the derivation at `deltaCacheMaxBytes = 4 MiB` → 8 192 entries | Constant mutants via the invariant; option plumbing via a non-default value observed in `entryCount` |
| D2-i FlatTree | `read-head-tree.test.ts`: 20 000-entry synthetic tree at defaults → second call zero object reads (`instrumentedContext`), `set` verdict `true`; the over-cap case (`:171`) re-pinned under a shrunk `flatTreeCacheMaxBytes`; the "multiplied share" case (`:395`) rewritten for the new sizing; `164 × 50_000 ≤ 8 MiB` literal | Budget mutants via the 20 000-entry hit |
| D2-i options | `validate-options.test`, `index.node.test`/`index.browser.test`/`memory-adapter.test`: each of the five options refused when non-integer or negative (`INVALID_OPTION`), `0` accepted, defaulted when absent, reaching `ctx.cacheBudgets` when present | Each option's absence/presence isolated; boundary triples |
| D2-ii parse + finder | `config-read.test.ts` (+ `config-read.properties` untouched): `ParsedConfig.core.deltaBaseCacheLimit` for `96m`/`1K`/`0x6000000`/`0` (values 100 663 296 / 1 024 / 100 663 296 / 0), absent for `-1`/`abc`/`1.5m`; `findLastInvalidDeltaBaseCacheLimit` over the C1 matrix → `{ key, source, value, reason }` (`key` is the lowercased qualified name, built exactly as `findLastInvalidMaxTreeDepth` builds `core.maxtreedepth`)`` (each of `invalid unit` / `out of range` / valueless `''` isolated); last-wins (C4 both orders); `repo-state.test.ts`: `assertEagerConfigValid` throws `CONFIG_BAD_NUMERIC_VALUE` with that `data`, **after** a same-file malformed `core.sparseCheckout` (`CONFIG_BAD_BOOLEAN_VALUE` wins) and after `core.maxTreeDepth`; skipped when `ctx.cacheBudgets.deltaBaseCacheMaxBytes` is set (C5) | Reason-literal and comparison mutants via the matrix; ordering mutants via the two-class cases; the skip via presence/absence of the option |
| D2-ii resolver + registry | new `resolve-delta-base-cache-limit.test.ts`: absent key → 100 663 296; present → value; malformed → throws with `data`; `deltaBaseCacheBudgetFor` option-over-key, and no config read at all when the option is set (NDC-1 (a)); `pack-registry.test.ts`: `createPackRegistry` resolves; `deltaBaseCache.maxSize` equals the key's value / the option / 96 MiB; `readConfig` spy: one read per session, none on `refreshPackRegistry`; `read-object.test.ts`: two concurrent first `readObject`s construct one registry (`createPackRegistry` spy `toHaveBeenCalledTimes(1)`); a first `readObject` after `assertOperationalRepository` issues zero `stat` of `config` (`instrumentedContext`; lands with P7, see partition) | Default-constant mutants; precedence mutants; single-flight via the spy count |
| D3-i | `object-resolver.test.ts` (`:1606-1900` chain suites): a chain whose levels exceed ¼ of a small `deltaBaseCacheMaxBytes` inserts the base-nearest levels only (`entryCount`, `has(key)` per level), bytes returned identical; the base insert is itself subject to the budget (a base larger than ¼ is skipped, its levels still cached if they fit); `cacheDeltaBase` returns `true` at every inserted level; `chainDepth` on a later probe hit unchanged (existing `:1670` suite) | `continue` → insertion mutants via `has(key)`; fraction mutants via the boundary level; the base arm isolated |
| D3-ii | `git-object.test.ts`: `parseObjectContent` per type; `parseObject ≡ parseObjectContent ∘ splitObject`; `object-resolver.test.ts`: the four `deltaCache.set(id, rawBytes, …)` seeds (`:828, :860, :889, :920`) become `{ type, content }`; the five poisoned-cache suites (`:2536, :2572, :3156, :3195, :3237`) deleted (unreachable by type); `verifyHash: true` on a cache hit / pack read hashes header ‖ content (a hasher double records two `update`s); sizer charges `content.byteLength + 32`; `read-object.test.ts`: `readRawObject` returns `{ type, content }` with no `bytes` key; `blob-source.test.ts` (`:79, :100` seeds); `pack-registry.test.ts:4172`, `fsck.test.ts:6057` seeds; `content-validation.test.ts`: packed-object hash pass hashes `serializeHeader` ‖ body (mismatch still reported); the 15 trivial `set('a', one, 1)` seeds in the adapter/entry-point/repository tests become `{ type: 'blob', content: one }`; six explicit `LruCache<Uint8Array>` generics in tests → `LruCache<ObjectContent>` | Sizer constant via `currentSize` after one insert; hasher-order mutants via the recorded `update` sequence; `typeNameToPackType` exhaustive switch via one case per type |
| D4 | `repo-state.test.ts` matrix (`:202-340`) unchanged + new: second gate on an unchanged HEAD issues `lstat` only (a `ctx.fs` proxy whose `lstat` reports Node-shaped fields with `ino !== 0` — the memory adapter reports 0, so the identity path is reachable only through a proxy; ADR-856's Context keying makes the proxied Context's slot its own) and its miss path goes `openWithNoFollow` → `handle.stat` → `read` → `close`; the plain memory adapter (`ino === 0`) re-reads through `readUtf8` and never opens a handle; rewritten HEAD (new ino) re-read; `ref-store.test.ts`: `resolveDirect('HEAD')` after a gate issues **no** `readUtf8`; the two existing call-list assertions naming `readUtf8` on `/HEAD` re-pinned; symlinked HEAD → `{ kind: 'symbolic', target: 'refs/heads/main' }` (memory adapter `symlink`); own `setSymbolic('HEAD')` invalidates; `bootstrap` write invalidates; primitive-only sequence re-validates by `lstat` each call; `unusable` with an EACCES cause rethrows `PERMISSION_DENIED` from `resolveDirect` | Trust-bit mutants: a stale slot served after a rewrite; identity-field mutants via the proxy varying one field at a time (mtime, ctime, ino, size); reader-selection mutant via the `ino === 0` adapter never calling `openWithNoFollow`; cause-filter mutant via the EACCES case |
| D5 | `config-read.test.ts`: gate → `readConfig`×3 = one `stat`; raw rewrite inside the epoch unseen, seen at the next gate; `invalidateConfigCache` clears `trusted`; no gate → `stat` per read (today's tests hold); verdict memo re-run on key change (raw rewrite to a malformed `core.sparseCheckout` — and to a malformed `core.deltaBaseCacheLimit` — between two commands → second refuses; today's `:110/:130` tests kept); `config-scoped-read.test.ts`: unscoped `config.get` → one local read; `record-ref-update.test.ts`: `readConfig` spy called once | Bit mutants via stat counts; memo-key mutants via the malformed-rewrite refusal |
| D6 | `ref-store.test.ts`: absent `packed-refs` → one `stat`, zero `exists`; packed-only names in `listRefs` → zero `readUtf8` under the prefix; loose-overrides-packed, unparseable-loose-excluded (`:633`, `:885`, `:955` suites) unchanged; a directory at `packed-refs` throws the adapter's mapped error as today | Split mutants via read counts |
| D7 | `ref-store.test.ts`: `listRefs` over 64 loose names — an `fs` double that records max in-flight `readUtf8` > 1 and asserts sorted output; `packRefs` prune probe pooled; `list-worktrees.test.ts` order + in-flight; `reflog.test.ts` `resolveTips` dedup | Serial-vs-pooled via in-flight counter (a `boundedMapFor` → `for…await` mutant reads 1) |
| D8 | `reflog.test.ts`: the R-matrix as parameterised cases over `{expire, unreachable} × {reachable-from-own-tip, reachable-from-other-tip, unreachable, null-old}`; `UE_ALWAYS` short-circuit issues zero object reads; bounded walk stops at `expireCut`; `HEAD` uses all tips; unresolvable ref under `all` ⇒ always | Each predicate arm isolated; `<` vs `<=` at the cut; old/new symmetry via a case where only `old` is unreachable |
| D9 | `resolve-ref.test.ts`: `resolveRefOrMissing` → `undefined` on missing, the same `REF_NOT_FOUND` data (`ref` = the chain's last name) from `resolveRef`; cycle/depth/invalid-name still throw; `rev-parse.test.ts`: a miss sweep constructs no `REF_NOT_FOUND` (a `RefStore` double counting `resolveDirect` calls = 6, and `resolveRef` never invoked) | Message/name mutants via the dangling-symref case |
| D10 | `node-file-system-injected.test.ts`: existing parent → `appendFile` only; missing parent → `appendFile` (ENOENT) → `mkdir` → `appendFile`; EACCES → propagates, no `mkdir` | Retry-count and errno-filter mutants |

### Interop (real git, `test/integration/*-interop.test.ts`)

Rules as 31.1: one shared repo per `describe` in `beforeAll`, 60 s timeout, `GIT_*` scrubbed,
`HOME` isolated, signing off, a fresh tsgit `Context` after every git write.

| Test | Pins |
|---|---|
| new `head-symlink-interop.test.ts` | H1: after `ln -s refs/heads/main .git/HEAD`, tsgit `revParse('HEAD')`, `currentBranchRef`, `branch.list` `current`, and a `commit` advancing `main` all agree with git; H2: the non-`refs/` link refuses `NOT_A_REPOSITORY` where git fails discovery |
| `reflog-interop.test.ts` (extend) | R1–R6 on the pinned history with twin repos (git rewrites the peer, tsgit ours; compare log bytes); R6′ `--all` over a gone ref |
| `packed-refs-interop.test.ts` / `pack-refs-interop.test.ts` | unchanged — re-run (D6/D7 must not move a byte) |
| `config-interop.test.ts` (extend) | the correction-8 case (external edit making `core.sparseCheckout` malformed between two tsgit commands is refused by the second); **C1** (each grammar row: tsgit's `CONFIG_BAD_NUMERIC_VALUE.reason` equals git's `invalid unit` / `out of range` suffix; accepted values run); **C4** last-wins both orders; **C2** the pinned die-set on tsgit's own surface — `log`, `status`, `catFile`, `revParse` refuse, `config.get` runs, and the five over-refused verbs (`branch.list`, `tag.list`, `remote`, `notes.list`, `packRefs`) are pinned **as the recorded divergence** (test title says so); **C3** `core.maxTreeDepth` wins, a streaming class wins (tsgit's order) with the six-command exception listed in the test's comment |

### fs-count oracles

Unit: `instrumentedContext` (`fixtures.ts:343`) — filter `calls()` by path (`/HEAD`, `/config`,
`/packed-refs`, `refs/tags/…`) and method. Implementation-time: `fs-count.cjs` +
`floor-oracle.mjs` on `medium-v3` (D11), before/after tables in the PR.

### Performance oracles (recorded, not asserted in CI)

`npm run bench:ab -- main feat/session-caches-per-command-floor 2` over the rows in D11;
local `status` medium is the FlatTree oracle until 31.4 fixes the CI row.

### `Stryker disable` suppressions inside touched structures (re-prove or remove)

| File:line | Mutator | Fate |
|---|---|---|
| `lru-cache.ts:106` | ConditionalExpression — relink fast path | Unchanged line; re-run |
| `object-resolver.ts:621` | BlockStatement — `resolveBaseForRefDelta` cache shortcut | **Touched** (D3-ii): the shortcut returns the cached `ObjectContent`; re-prove at the new line — the fall-through resolves the same `ObjectContent` from the same cache via `resolveObjectContentWithDepth`, chainDepth 0 |
| `object-resolver.ts:671, :676` | EqualityOperator — `splitHeader` guards | **Dropped with `splitHeader`** |
| `object-resolver.ts:173-193` | BlockStatement — pre-apply cap | Untouched; re-run |
| `fsck.ts:46, :48` | BooleanLiteral — `createNoDeltaCache` `has`/`delete` arms | Value type only; re-run |
| `ref-store.ts:318, :320` | Equality/Conditional — `compareRefNames` | Untouched; re-run |
| `config-read.ts:185` | StringLiteral — absent sentinel | Untouched; re-run |
| `config-scope.ts:105` | ConditionalExpression — global path | Moves with `resolveScopePath` refactor; re-prove in place |
| `update-config.ts:435, :564` | CallExpression — invalidate pairing | Unchanged; re-run |
| `gc-pipeline.ts:1016, :1067` | CallExpression — memo forget / registry refresh | `getPackRegistry` becomes awaited on the same lines; re-prove after P3 |
| `tag.ts:79` | EqualityOperator — sort comparator | Untouched; re-run |
| `list-worktrees.ts:185, :187` | Equality/Conditional — `byPath` | Untouched; re-run |
| `resolve-ref.ts:34` | StringLiteral/Conditional — HEAD name guard | Structure moves into `resolveRefOrMissing`; re-prove at the new line |
| `memory-file-system.ts:438` | MethodExpression — handle read clamp | On the HEAD miss path only under the `ino !== 0` proxy (D4 tests); re-run |

Local Stryker: `--concurrency 3`, `.stryker-tmp` cleared, `static: true` mutants checked before
kill tests; ranges from `git diff main` (working-tree-inclusive).

### Docs consequences

For the docs phase: `docs/use/primitives/internals.md` — `readConfig` / `invalidateConfigCache`
(ADR-850's contract, the gate's stat, the verdict re-keying, L7 for the registry's one-time
read), `parsedObjectMemoFor …` and `readHeadTree` (entry-bound sizing, the five options, the
**136 MiB** family total replacing "~34 MiB" at `:82`, `core.deltaBaseCacheLimit` + the
option precedence, `LruCache.set` verdict), the `PackRegistry.deltaBaseCache` sentence at `:37`
(sized from the key, async construction), `RefStore · getRefStore` (single stat, packed-only
from snapshot, pooled `listRefs`, HEAD read through the slot, symlinked HEAD symbolic),
`recordRefUpdate` (one config read), `listWorktrees` (pooled); `docs/understand/performance.md:59`
(the ~34 MiB sentence → 136 MiB, the key); `docs/use/primitives/read-object.md` (`RawObject` is
`{ type, content }`); `docs/use/commands/reflog.md` Behaviour (ADR-857's rule verbatim);
`docs/use/commands/rev-parse.md` (no change in behaviour; none needed); the three new options
documented wherever `deltaCacheMaxEntries` is today (`docs/understand/architecture.md` is the
only non-design hit; the docs phase decides between extending it and adding an `openRepository`
options row to `docs/use/README.md`); a **5.0 migration note** with D3-ii's before/after table;
`reports/api.json` regenerated for `LruCache.set`, the options, `Context`, `RawObject`,
`ObjectContent`, `parseObjectContent`. Backlog 31.2 ticked by the docs phase with the design/ADR
suffix only.

---

## Out of scope

- **31.3's adapter seams** — the sync fast path, `tryLstat`/`tryReadUtf8` (the remaining
  `FILE_NOT_FOUND` construction on every rev-parse miss and loose-ref miss), `readFile`/inflate
  views, the pack-first cold order, `blob-source` populating `deltaCache`. Each is named in its
  D-section where this design stops short of it. (The `{ type, content }` shape is **in** scope —
  ADR-854 — and 31.3 inherits it.)
- **31.4** — the `status` refresh write-back (the CI `status` row is not this item's oracle),
  `write`/`writeExclusive` `mkdir`-first shape (only `appendUtf8` here), the memory adapter's
  stat identity.
- **`verifyIntegrity`'s serial loop** (`ref-store.ts:575-597`) — fsck's; the pool applies but
  its harness is `fsck-artefacts.bench` (31.6).
- **Non-HEAD symlinked loose refs** — `readLooseContent` follows symlinks for every ref; git
  models them as symrefs. Pre-existing; HEAD is fixed here because the sole reader models it;
  the general case needs its own pin matrix.
- **`gc.reflogExpire` / `gc.reflogExpireUnreachable` / per-ref patterns** and the single-ref
  expire refusal on an unresolvable ref (R6′) — pre-existing gaps in `expire`, not part of the
  reachability rule (ADR-857).
- **The scoped config reader's per-call stat** (`config` porcelain) — not on the operational
  gate; its parse is already cached; (h-i) removes the only uncached read.
- **A large-fixture (50 k commits) memo sweep** — no bench row on `large-v1` exists; the medium
  A/B and the entry-bound invariant are the oracle (ADR-851).
- **A fixture that makes the per-chain budget measurable** — intermediates > 24 MiB per chain;
  a new generated fixture family (D11).
- **Matching git's per-command die-set for `core.deltaBaseCacheLimit` exactly** — tsgit has no
  `prepare_repo_settings` moment; NDC-2 picks one boundary and pins the divergence.
- **Regenerating `docs/perf/baseline.*`** — the `profile` workload set is unchanged.
- **F2, F4, F5, F7–F10, F12, F13** of the review — 31.3–31.6.

---

## Partition proposal

Sized for TDD slices in dependency order. "Gate" is the part gate from `.claude/workflow.md`
(`vitest run <touched-tests>` + `check:types` + `biome` + `check:spelling`); the phase gate is
`npm run validate`. Parts marked *(2 commits)* land as two atomic commits inside one part
because their oracles differ while their files overlap. **Ordering constraints introduced by
this revision:** P1 → P2 → P3 → P4 → P5 are strictly sequential (each edits `object-caches.ts`
and/or `object-resolver.ts` where the previous one left off); P3 must precede P6 and P7 (all
three edit `internal/repo-state.ts`, different functions); the "registry read is stat-free
inside a gate" oracle can only be asserted after P7, so it lives in P7's test file although the
code is P3's; P5's second commit is the breaking one and carries the `!` marker.

### P0 — Harness (no `src/`)

- **Files:** new `test/bench/tag-list.bench.ts`, `test/bench/branch-list.bench.ts`; edit
  `test/bench/rev-parse.bench.ts`; scratch script `floor-oracle.mjs` + `fs-count.cjs` under the
  PR body (not committed — 31.1 precedent).
- **Fixtures/helpers:** `setupSmallRepo` (`test/bench/fixtures.ts:50`, returns `BenchRepo`),
  `removeSync` (`support/fixture-scratch.ts:43`), `scaledScenario`/`resolveScaledContext`
  (`support/scaled-bench.ts:41,56`), `benchScenario` (`support/bench-dsl.ts:107`); tsgit
  primitives `updateRef` (`src/application/primitives/update-ref.ts`), `repo.packRefs()`;
  `boundedMapFor` for fixture population.
- **Oracle:** `npx vitest bench test/bench/tag-list.bench.ts …` — every entry in `raw.json`
  with `sampleCount > 0`; the tag fixture asserts `refs/tags/` is empty after packing.
- **Gate:** vitest bench smoke + spelling. Independent commit.

### P1 — `LruCache.set` verdict (D1; ADR-853)

- **Files:** `src/domain/storage/lru-cache.ts` (`set` at `:92-118` → `boolean`), `reports/api.json`
  (`npm run docs:json`).
- **Tests:** `test/unit/domain/storage/lru-cache.test.ts` (`:341`, `:430` cases extended; property
  block `:498-575` invariant).
- **Gate:** domain tests + api.json regen in-slice (prepush gate). Independent commit.

### P2 — Memo and FlatTree budgets, five validated options, `cacheBudgets` (D2-i; ADR-851)

- **Files:** `object-caches.ts` (`PARSED_OBJECT_MEMO_FRACTION:81` → `PARSED_OBJECT_TYPICAL_ENTRY_BYTES`; `PARSED_OBJECT_MEMO_MAX_ENTRIES:92` removed;
  `memoByteValve`/`memoMaxEntries`, `budgetsFor`; `parsedObjectMemoFor:94-104`), `read-head-tree.ts`
  (`FLAT_TREE_CACHE_FRACTION:50` → `FLAT_TREE_TYPICAL_ENTRY_BYTES` + `FLAT_TREE_DEFAULT_SHARE`,
  `flatTreeCacheFor:64-74`), `ports/context.ts:198-230` (`readonly cacheBudgets?: CacheBudgets`,
  all three fields optional, next to `concurrency?:225-230`), `index.node.ts:49-53`
  (`OpenNodeRepositoryOptions`) + `:115-118`, `index.browser.ts:42-43` + `:94-97`,
  `index.default.ts:99`, `adapters/node/node-adapter.ts:27-28,71-74`,
  `adapters/browser/browser-adapter.ts:21-22,38-41`, `adapters/memory/memory-adapter.ts:21-22,67-70`,
  `repository/validate-options.ts:9-20` (`ValidatableOptions` + five validators), `repository.ts:279,655` (fallback shape carries `cacheBudgets`), `reports/api.json`.
- **Signatures changing:** `parsedObjectMemoFor(ctx)` / `flatTreeCacheFor(ctx)` keep their
  shapes; `createLruCache(ctx.deltaCache.maxSize * FRACTION, 65_536)` → `createLruCache(valve, entries)`.
- **Tests:** `object-caches.test.ts` (119 lines, 4 suites — the fraction suite rewritten to
  the entry bound + the two invariants), `read-head-tree.test.ts` (`:171`, `:395`, `:420`
  rewritten), `validate-options.test.ts` (five new boundary triples), `index.node.test.ts` /
  `index.browser.test.ts` / `memory-adapter.test.ts` / `node-adapter.test.ts` (options reach
  `ctx.cacheBudgets`), `context.test.ts` (a hand-built Context without `cacheBudgets` resolves
  defaults), `pack-registry.test.ts` (`:2570-2596` entry-count assertions unchanged — the
  delta-base row is P3's).
- **Gate:** those test files + api.json regen. Depends on P1 (the invariant tests read `set`'s verdict).

### P3 — `core.deltaBaseCacheLimit`: parse, finder, gate check, lazy resolver, async registry (D2-ii; ADR-852, NDC-1, NDC-2)

- **Files:** `config-read.ts` (`ParsedConfig.core:44-57` + `deltaBaseCacheLimit?`;
  `MutableCore:855-870`; new `applyDeltaBaseCacheLimitEntry` beside `applyMaxTreeDepthEntry:900-905`
  reusing `checkPackWindowMemoryBound:1240-1245`; `applyCoreEntry` dispatch; `finalizeCore:1450-1466`;
  new `findLastInvalidDeltaBaseCacheLimit` after `findLastInvalidMaxTreeDepth:736-768`),
  `internal/repo-state.ts` (`assertEagerConfigValid:211-244` — the new finder runs after the
  `pickLowerLine` throw, skipped when `ctx.cacheBudgets?.deltaBaseCacheMaxBytes !== undefined`),
  new `internal/resolve-delta-base-cache-limit.ts` (template: `internal/resolve-max-tree-depth.ts`,
  23 lines; exports `GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES`, `resolveDeltaBaseCacheLimit`,
  `deltaBaseCacheBudgetFor`), `pack-registry.ts` (`createPackRegistry:631-643`
  → `async`, budget from `deltaBaseCacheBudgetFor`; comment `:633-639` rewritten to the key),
  `read-object.ts` (`registryCache:39` → `PromiseMemo` map + resolved map; `getPackRegistry:47-53`
  → `Promise<PackRegistry>`; `refreshPackRegistry:63-65`; `disposePackRegistry:72-74`; the three
  internal callers `:154,166,228`), and the 16 other call sites listed in D2-ii, each `await`ed.
- **Signatures changing:** `createPackRegistry(ctx: Context): PackRegistry` →
  `Promise<PackRegistry>`; `getPackRegistry(ctx: Context): PackRegistry` → `Promise<PackRegistry>`.
  Neither is public. `createPromiseMemo` (`internal/promise-memo.ts:22`) is the memo.
- **Tests:** `config-read.test.ts` (C1/C4 matrix for the parse and the finder),
  `repo-state.test.ts` (`:110`, `:130` neighbourhood — the C3 ordering cases, the C5 skip),
  new `resolve-delta-base-cache-limit.test.ts` (incl. `deltaBaseCacheBudgetFor` precedence), `pack-registry.test.ts` (`:2570-2596` + `maxSize` from key/option/default; one
  config read per session), `read-object.test.ts` (single-flight), every test that stubs or
  calls `getPackRegistry` synchronously (grep `getPackRegistry(` under `test/`), and
  `config-interop.test.ts` (C1, C2 on tsgit's surface incl. the five over-refused verbs as the
  recorded divergence, C3, C4).
- **If the new candidates resolve otherwise:** NDC-1 (b) or (c) changes one line in
  `deltaBaseCacheBudgetFor` and drops the gate finder's skip condition; NDC-2 (b) drops the
  `repo-state.ts` edit and the C2 over-refusal rows from `config-interop`; nothing else in this
  part or any other moves.
- **Gate:** those files + `npm run check:architecture` (the new inward edge; `no-circular`) +
  the interop file (git-spawning: 60 s timeout, shared `beforeAll`). Depends on P2
  (`cacheBudgets`). Must precede P6/P7 (`repo-state.ts`).

### P4 — Delta-base per-chain budget (D3-i)

- **Files:** `object-resolver.ts` (`resolvePackChainWithDepth:471-531` loop `:494-519` →
  `insertLevel` with the chain budget; base insert inside the budget), `object-caches.ts:264-274`
  (`cacheDeltaBase` returns `boolean`; new `DELTA_BASE_CHAIN_INSERT_FRACTION = 0.25`).
- **Tests:** `object-resolver.test.ts` chain suites (`:1606-1900`), `object-caches.test.ts`.
- **Gate:** those two files. Depends on P1 (verdict) and P3 (the registry's `maxSize` is the key's).

### P5 — `{ type, content }` in the loose-object cache (D3-ii; ADR-854) *(2 commits; the second is breaking)*

- **Commit 1 (additive, domain):** `src/domain/objects/git-object.ts` (`ObjectContent`,
  `parseObjectContent` extracted from `parseObject:37-51`'s switch; `parseObject` delegates),
  `domain/objects/index.ts:37` (export both), `reports/api.json`.
  Tests: `test/unit/domain/objects/git-object.test.ts` (385 lines).
- **Commit 2 (`feat(objects)!:`):** `ports/context.ts:219,:281` (`LruCache<ObjectContent>`);
  the seven creation sites (`adapters/{node:71,browser:38,memory:67}-adapter.ts`, `index.node.ts:115`,
  `index.browser.ts:94`, `index.default.ts:99`, `commands/fsck.ts:42`); `object-resolver.ts`
  (`EMPTY_TREE_BYTES:50`; `resolveObjectBytesWithDepth:64-105` → `resolveObjectContentWithDepth`;
  `resolveObject:107-123` → `parseObjectContent`; `enforceCachedCap:149-160`;
  `verifyAndReturn:246-262` → exported `verifyObjectContent` over `createHasher` +
  `serializeHeader`; `resolvePackChainWithDepth` tail `:520-530`; `prependHeader:533-545` and
  `splitHeader:659-682` deleted; `typeNameToPackType:684-697` exhaustive; `resolveBaseForRefDelta:617-657`;
  `cacheEntry:699-703` sizer with `OBJECT_CACHE_ENTRY_OVERHEAD_BYTES = 32` from `object-caches.ts`);
  `read-object.ts:160-178` (`readRawObject` returns the payload); `primitives/types.ts:82-96`
  (`RawObject = ObjectContent`, comment fixed); `internal/blob-source.ts:89-92,:140-143,:178-186`;
  `commands/internal/fsck/content-validation.ts:20,:54,:80,:184-205`; `reports/api.json`.
  Port shapes used: `Hasher.update/digestHex` (`ports/hash-service.ts:2-9`), `serializeHeader`
  (`domain/objects/header.ts`).
- **Tests (commit 2):** `object-resolver.test.ts` (3 729 lines: seeds `:828,:860,:889,:920`;
  poisoned suites `:2536,:2572,:3156,:3195,:3237` deleted; verify-path hasher double; sizer),
  `read-object.test.ts` (1 068), `blob-source.test.ts` (`:79,:100`), `content-validation.test.ts`
  (306), `pack-registry.test.ts:4172`, `fsck.test.ts:6057`, the 15 trivial seeds in
  `index.node.test.ts:198-201`, `index.browser.test.ts:224-227`, `memory-adapter.test.ts:251-253`,
  `node-adapter.test.ts:248-249`, `repository.test.ts:654`; the six explicit generics in
  `snapshot-iteration-stability.test.ts`, `primitives-binding-surface.test.ts`,
  `object-resolver.test.ts`, `context.test.ts`, `repository.test.ts`, `snapshot-wiring.test.ts`.
  Contextually-typed `createLruCache(…)` calls in test fixtures (≈ 90) compile unchanged.
- **Gate:** commit 1 domain tests + api.json; commit 2 the files above + api.json +
  `check:types` across the repo (the type flip is the compile gate). Depends on P4 (same loop tail).

### P6 — HEAD reader and slot (D4; ADR-855, ADR-856)

- **Files:** new `src/application/primitives/internal/head-file.ts`; `internal/repo-state.ts`
  (`hasUsableHead:130-144` → `validateHead`; `isRefsLinkText`/`isValidHeadContent` stay);
  `ref-store.ts` (`resolveDirect:403-415` HEAD arm; `applySet:769`/`applySetSymbolic:777`
  invalidate on `HEAD_NAME`); `commands/internal/bootstrap.ts:77` (invalidate after the raw
  write). Port shapes used: `FileSystem.lstat/readlink/readUtf8/openWithNoFollow`
  (`ports/file-system.ts:214`), `FileHandle.stat/read/close` (`:34-48`);
  `FileStat.mtimeNs/ctimeNs/ino/size` (`:2-18`). The `ino === 0` discriminator selects
  `readUtf8`; `ino !== 0` selects `openWithNoFollow` (the browser adapter throws on it, `:205-207`).
- **Tests:** `test/unit/application/primitives/internal/repo-state.test.ts` (matrix `:202-340`,
  `:184` deleted-HEAD), `ref-store.test.ts` (`:867` symbolic HEAD suite; the two call-list
  assertions that name `readUtf8` on `/HEAD`; new HEAD suites), new `head-file.test.ts`
  (fixtures: `buildSeededContext`, `instrumentedContext`, the no-dereference fixture at
  `fixtures.ts:325-331` for the symlink arm; an `fs` proxy reporting `ino !== 0` for the
  identity + handle path), `list-worktrees.test.ts` (per-worktree slot), new
  `test/integration/head-symlink-interop.test.ts` (twin-repo helpers from `interop-helpers.ts`).
- **Gate:** those files + the interop test. Depends on P3 (`repo-state.ts`). Must precede P7.

### P7 — Config epoch, worktree-scope check, one config read per ref update (D5; ADR-850)

- **Files:** `config-read.ts` (`CachedConfigEntry:177-180` + `trusted`; `gateVerdictCache:279`;
  `memoizeGateVerdict:299-311`; `readConfigEntry:342-356`; `__resetConfigCacheForTests:365-369`;
  `invalidateConfigCache:389-393`; new `openConfigEpoch`), `internal/repo-state.ts`
  (`assertOperationalRepository:320-325`, `computeGateVerdict:305-309`),
  `config-scoped-read.ts` (`readSingleScope:148-166`; `isWorktreeScopeActive` moves here),
  `internal/config-scope.ts` (`isWorktreeScopeActive:52-76` removed; `resolveScopePath:83-112`
  takes the verdict), `update-config.ts` / `update-config-sections.ts` (callers of
  `resolveScopePath('worktree')`), `record-ref-update.ts:49-53`, `reflog-identity.ts:25-26`.
- **Tests:** `config-read.test.ts` (+ properties file untouched), `repo-state.test.ts` (`:110`,
  `:130` verdict cases; the malformed-`deltaBaseCacheLimit`-between-commands case),
  `config-scoped-read.test.ts`, `config-scope.test.ts` (+ properties), `record-ref-update.test.ts`,
  `reflog-identity.test.ts`, `read-object.test.ts` (**the P3 oracle**: first `readObject` after
  `assertOperationalRepository` issues zero `stat` of `config`), `config-interop.test.ts`
  (correction 8 case); then the mechanical enumeration: `npm run test:unit`, add
  `invalidateConfigCache` where a gated command precedes a raw rewrite and a gate-less read.
- **Gate:** those files + `npm run check:architecture` (import cycle). Depends on P6.

### P8 — `packed-refs` single stat + pooled enumeration (D6, D7) *(2 commits)*

- **Files:** `ref-store.ts` (`loadPackedRefs:376-391`, `listRefs:561-569`, `packRefs:875-898`),
  `commands/reflog.ts` (`resolveTips:234-241`), `list-worktrees.ts:192-208`.
- **Tests:** `ref-store.test.ts` (`:339-475` packed suites, `:633`, `:885`, `:955`, `:1062`
  spread-ceiling suite), `list-worktrees.test.ts`, `reflog.test.ts` (`resolveTips`),
  `packed-refs-interop.test.ts` + `pack-refs-interop.test.ts` re-run.
- **Gate:** ref-store + list-worktrees + reflog unit files; interop re-run. Commit 1 (D6) has
  the fs-count oracle; commit 2 (D7) the in-flight oracle. Independent of P6/P7 in code; ordered
  after them only because `listRefs`'s HEAD candidate reads through the slot.

### P9 — `reflog expire` rule (D8; ADR-857)

- **Files:** `commands/reflog.ts` (`runExpire:156-200`, `keepEntry:213-221`,
  `collectReachable:224-232`, `resolveTips` from P8); reads `readCommitMeta`
  (`internal/read-commit-meta.ts`, 31.1), `resolveRef(…, { peel: true })`, `readObject` for the
  non-commit check; `resolveExpiryCutoff` (`primitives/expiry-cutoff.ts`).
- **Tests:** `reflog.test.ts:742-1010` rewritten to the R-matrix; `reflog-interop.test.ts`
  (expire suites `:695-960`, `:1074`, `:1134`, `:1358`) extended with R1–R6′; `docs/adr/064`
  supersession note is already committed.
- **Gate:** the two files (interop git-spawning). Depends on P8 for the pooled `resolveTips`.

### P10 — rev-parse sweep + `appendUtf8` (D9, D10) *(2 commits)*

- **Files:** `resolve-ref.ts:10-64` (`resolveRefOrMissing`), `commands/rev-parse.ts:61-77`,
  `commands/internal/commit-ish.ts:22`, `domain/refs` `refCandidates` (unchanged shape);
  `adapters/node/node-file-system.ts:705-712`.
- **Tests:** `resolve-ref.test.ts`, `rev-parse.test.ts`, `commit-ish` tests,
  `node-file-system-injected.test.ts` (+ `node-file-system.test.ts` append cases).
- **Gate:** commit 1 primitives/commands tests; commit 2 adapter tests. Independent of every
  other part; last because smallest.

**Shared-commit guidance.** P1, P2, P3 and P5 each regenerate `reports/api.json` (four regens; `ParsedConfig`
is public — 5 hits — so P3's new `core.deltaBaseCacheLimit` field is a report change too); P5's two commits share a
seam but only the second is breaking; P8's two commits share files and a gate but not an
oracle; P10's two commits share nothing but size. Every other part is independent by gate and
by file, in the order above. Eleven parts, fourteen commits.
