# Design — session caches and the per-command floor (31.2)

> Brief: `docs/BACKLOG.md` **31.2** (Phase 31, second of six; sourced from
> `.claude/perf-review-2026-09-10.md` F3, F6, F11 and the tail of F14). Two shipped caches are
> sized below the medium fixture and fail silently (the parsed-object memo holds ≤ 4 096 entries;
> the FlatTree LRU refuses the 3.3 MB medium HEAD tree), the delta-base cache over-provisions
> ~2× and lets one deep read flush itself, and every command pays duplicated metadata I/O
> (HEAD read twice, `.git/config` stat'd on every sequential `readConfig`, `packed-refs`
> probed twice per packed ref, loose refs enumerated serially). Eight sub-items (a)–(h), all
> pure-perf: no object SHA, ref, reflog, state file or refusal changes — **except** where a pin
> below found an existing divergence that the touched code fixes for free (symlinked HEAD,
> `reflog expire`'s reachability rule), each recorded as a decision.
> Status: draft → self-reviewed ×3

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
make them quotable main-vs-branch. Git probes in this doc were run fresh (matrix at the end).

### What exists today (the subsystems touched)

| Seam | File (anchors verified on `be57e0cc`) | What it does today |
|---|---|---|
| LRU | `src/domain/storage/lru-cache.ts` (142 lines) | `createLruCache(maxSizeBytes, maxEntries = ∞)`; `set` throws on `byteSize <= 0` (`:93-95`) and **returns silently** on `byteSize > maxSizeBytes` (`:96-98`). `LruCache` is a **public** type (`domain/storage/index.ts:39`; `Context.deltaCache: LruCache<Uint8Array>`, `ports/context.ts:219`; 25 hits in `reports/api.json`). |
| Parsed-object memo | `src/application/primitives/internal/object-caches.ts` | Session-keyed `WeakMap` (`:47`); budget `deltaCache.maxSize × PARSED_OBJECT_MEMO_FRACTION (1/16)` (`:81, :99`) = 1 MiB at the default; entry cap 65 536 (`:92`) "never binds"; sizer adds `PARSED_OBJECT_FIXED_OVERHEAD_BYTES = 256` per entry (`:132, :149-171`) ⇒ ≤ 4 096 entries fit. Populated at `object-resolver.ts:121`. The module's own fraction sweep table (`:60-68`) was taken on the medium fixture — 5 000 commits, i.e. on the wrong side of the cliff. |
| FlatTree cache | `src/application/primitives/read-head-tree.ts` | Session-keyed, `FLAT_TREE_CACHE_FRACTION = 1/16` (`:50, :68-71`), `flatTreeByteSize` = 48 + Σ(path + oid + 110) (`:112-118`) ≈ 164 B × entries ⇒ medium HEAD (20 000 files) = 3.3 MB > 1 MiB → `set` refused on every `status`/`rm`; break-even ≈ 6 400 tracked files. Key `(rootTreeOid, maxDepth)` (ADR-726). Consumers: `status.ts:162`, `rm.ts:171`. |
| Delta-base cache | `src/application/primitives/pack-registry.ts:629-643`, `object-resolver.ts:471-531` | `deltaBaseCache = createLruCache(ctx.deltaCache.maxSize, 65 536)` — a **full additional** budget (ADR-736, deliberate; the brief's "comment says shared" is the pre-ADR-736 comment, now replaced by `:633-639`). The unwind loop `:504-519` inserts one full intermediate per level, nearest-the-base first; `:528-529` `prependHeader` copies content into loose format for `ctx.deltaCache`; `resolveBaseForRefDelta:634,656` `splitHeader`s it back (subarray + `TextDecoder`). |
| Gate | `src/application/primitives/internal/repo-state.ts` | `hasUsableHead` (`:130-144`): `lstat HEAD` → symlink ⇒ `readlink` + `isRefsLinkText`; else `readUtf8` + `isValidHeadContent`. Runs on **every** command (`assertOperationalRepository:320-325`, `assertRepository:98-103`) ahead of the session-memoised verdict (`computeGateVerdict:305-309`, `memoizeGateVerdict` in `config-read.ts:299-311`). |
| Ref store | `src/application/primitives/ref-store.ts` (913 lines) | Context-identity-keyed store (`:270-279`, deliberately not session-keyed — `:243-269`). `loadPackedRefs` (`:376-391`): `exists` (a `stat` on Node, `node-file-system.ts:719-730`) then `stat`, cache keyed `mtimeMs:size`. `readLooseContent` (`:393-401`) `readUtf8` follows symlinks. `resolveDirect` (`:403-415`) loose-then-packed. `collectCandidateNames` (`:532-542`) holds the packed **entries with oids**; `listRefs` (`:561-569`) still `resolveEntry`s every name serially (packed-only names: `readUtf8` ENOENT → `loadPackedRefs` → map). `packRefs` (`:875-898`): serial `exists` per packable (`:881-885`), pooled `buildPackedEntry`, serial `rm` (`:890-892`). `verifyIntegrity` (`:575-597`) serial too (fsck's; not in scope). |
| Config cache | `src/application/primitives/config-read.ts` (1 737 lines) | Session-keyed `cache` (`:256`) validated by `coalescedMtimeKey` (`:228-248`, coalesces **concurrent** stats only) on every `readConfigEntry` (`:342-356`) — one `stat` per sequential `readConfig`. 48 call sites across 29 `src/` files, incl. `write-object.ts:34` per object, `resolve-max-tree-depth.ts:17,21` per `walkTree` (11 callers after 31.1), `record-ref-update.ts:51` + `reflog-identity.ts:26` per ref update. `gateVerdictCache` (`:279`) is session-keyed and **not** mtime-keyed. `invalidateConfigCache` (`:389-393`) drops both + the scoped cache. |
| Scoped config | `src/application/primitives/internal/config-scope.ts:52-76`, `config-scoped-read.ts:148-166` | `isWorktreeScopeActive` raw-reads + `parseIniSections` the local file **outside every cache**, reached from `resolveScopePath('worktree')` — i.e. on every unscoped `config.get` and every worktree-scope read/write. `readSingleScope` (module-private) already caches local sections behind an mtime key. Import direction today: `config-scoped-read.ts → internal/config-scope.ts` (`:8`). |
| Reflog append | `src/application/primitives/record-ref-update.ts` (66 lines), `src/adapters/node/node-file-system.ts:705-712` | `isLoggable` reads config (`:51`) and `resolveReflogIdentity` reads it again (`reflog-identity.ts:26`); `appendUtf8` runs `mkdir -p` before every append (`:709`). Memory adapter appends via `writeUtf8` (`memory-file-system.ts:132-135`, parents implicit); browser via `resolveFileHandle(path, true)` (`browser-file-system.ts:74-80`). |
| Loose enumeration | `ref-store.ts:561-569, :881-892`, `reflog.ts:234-241`, `list-worktrees.ts:202-205` | All `for … await` serial. `boundedMapFor(ctx, 'ioBound', items, worker)` (`internal/concurrency.ts:53-58`) preserves input order and propagates the first rejection. |
| rev-parse sweep | `src/application/commands/rev-parse.ts:61-77`, `commands/internal/commit-ish.ts:22` | `refCandidates(base)` (`domain/refs`) builds 6 strings eagerly; each miss throws `REF_NOT_FOUND` from `resolveDirectChain` (`resolve-ref.ts:51-53`) on top of the adapter's `FILE_NOT_FOUND` (both `TsgitError`s capture a stack, 2.1 µs each — F14); the `catch {}` swallows **every** error (git's `expand_ref` likewise continues past broken/dangling candidates, warning only). |
| reflog expire | `src/application/commands/reflog.ts:156-241` | `collectReachable` walks **all** history from **every** ref tip (`:224-232`) on every `expire`; `keepEntry` (`:213-221`) = `timestamp >= (reachable(newId) ? expireCut : unreachableCut)`. ADR-064 calls this "fully faithful"; the pin matrix below says otherwise (correction 7). |
| Options | `src/index.node.ts:49-53` (`deltaCacheMaxBytes`, `deltaCacheMaxEntries`), `index.browser.ts:42`, `index.default.ts`, three adapters | `DEFAULT_DELTA_CACHE_BYTES = 16 MiB` in six places; `validateOptions` (`repository/validate-options.ts`). |
| Harness | `test/bench/` | `rev-parse.bench` (HEAD only), `cat-file.bench`, `log.bench` (2 rows), `status.bench` (tiered), `delta-chain-read.bench` (3 rows incl. "8 tips sharing deep OFS ancestor levels"), `commit.bench`. **No** tag-list or branch-list bench. fs-count shim pattern: `fs-count.cjs` in `.claude/perf-31-1-closure-walks-prompt.md:107-113` (wraps `fs.promises.{stat,lstat,readFile,readdir,open,readlink,realpath}`, `globalThis.__fsCounts`); unit-level: `instrumentedContext` (`test/unit/application/primitives/fixtures.ts:343`, records `stat/lstat/exists/readUtf8/read/readSlice/readdir/readlink/openWithNoFollow/mkdir/write*`). `tooling/bench-ab.ts` (`npm run bench:ab -- <base> [head] [rounds]`). |

### Constraints this design lives under

- **ADR-226** git-faithfulness binds the data and on-disk state; **ADR-249** no rendering
  options — nothing here adds a display knob. Cache budgets are library tuning, not output.
- **ADR-722** caches key on `ctx.session`; `deriveContext` mints a fresh token on gitDir /
  commonDir / fs-root-set / hash-algorithm change. The ref store is the documented exception
  (Context identity, `ref-store.ts:243-269`) — the HEAD slot below follows the ref store's
  reasoning, not the general rule (DC-6).
- **ADR-726** FlatTree keyed `(rootTreeOid, maxDepth)`; **ADR-727** parsed memo is a byte-capped
  LRU "sharing the delta-cache budget by fraction" — (a) refines it; **ADR-736** delta-base cache
  is additive, and records "option 1 (a real fraction) remains available … gated on an A/B";
  **ADR-788** the index-pass base cache has its own budget and is outside the read-path family.
  DC-2 amends 726/727/736's sizing paragraphs; it does not reopen their shapes.
- **ADR-637** `core.maxTreeDepth` unclamped/refused-when-malformed — the epoch changes *when* it
  is stat'd, never what is resolved.
- **ADR-351** one config cache, one invalidation point — the epoch is a bit on that cache, not a
  second map.
- **ADR-064** reflog command shape and its "fully faithful expire" claim — superseded by DC-7 if
  (a) is taken.
- **ADR-707** `packRefs` surface; **ADR-709/294** common-dir rule (`packed-refs` lives in the
  common dir).
- `.claude/workflow/surface-gates.md`: `LruCache` (public), `OpenNodeRepositoryOptions` /
  `OpenRepositoryOptions` (public) → `reports/api.json` regenerated in the slice that changes
  them (prepush gate); no new Tier-1 command, no new error code.
- Structure of 31.3: it owns the adapter I/O strategy (sync fast path, `tryLstat`/`tryReadUtf8`,
  `readFile` views, `blob-source` populate, the pack-first cold order). 31.2 must not reach
  ahead into those seams; where an item here would naturally touch one it is called out and left.

### Brief corrections

1. **"`resolve-max-tree-depth` per `walkTree` … 10 010 per medium closure."** 31.1 (D2) hoisted
   the closure's resolution: the medium closure now issues O(1) config reads. The remaining
   per-call resolutions are `walk-tree.ts:133`'s other 11 callers, each one `stat` per
   `walkTree` outside an epoch. (e) still covers them; the 10 010 is gone already.
2. **"`pack-registry.ts:639-642` … comment says shared."** The call is `:640-643`; the comment
   at `:633-639` already says *additive* (ADR-736 replaced the "shared budget" text). The
   ~33 MiB provisioning is documented, not accidental — (c-ii) is a *decision to revisit*
   (DC-2), not a bug fix.
3. **"`record-ref-update.ts:39-53` two back-to-back `readConfig`."** One is `isLoggable`'s
   (`:51`); the other is inside `resolveReflogIdentity` (`reflog-identity.ts:26`). Folding
   them means threading a config into the identity resolver, not a local edit.
4. **"HEAD is read twice per command."** Confirmed (`repo-state.ts:142` then `ref-store.ts:396`;
   `branch.list` reads it in `resolveCurrentBranchTarget`, and an unprefixed `listRefs()` —
   `packRefs` — adds an `exists` probe at `headCandidate:464`).
   Additionally: for a **symlinked HEAD** `readLooseContent` follows the link and returns the
   branch's oid, so `resolveDirect('HEAD')` reports `direct` (detached) where git reports
   `symbolic` (Pin H1: `git symbolic-ref HEAD` = `refs/heads/main`; `git commit` advances
   `main`). The gate already models the link correctly (`isRefsLinkText`). A pre-existing
   divergence that (d)'s sole reader fixes by construction — DC-5 records it.
5. **"one-slot cache keyed on the gate's `lstat` `(mtime,size,ino)`."** The memory adapter reports
   `ino: 0` for every file (`memory-file-system.ts:548`) and the browser adapter likewise
   (`browser-file-system.ts:330`), both with millisecond `mtimeMs`; the Node adapter supplies
   `mtimeNs`/`ctimeNs`. A key of that shape is **degenerate** on two of three adapters: two
   same-length HEAD rewrites inside one millisecond (`ref: refs/heads/main` →
   `ref: refs/heads/feat`) are indistinguishable. 187 raw `writeUtf8(…/HEAD)` calls across 66
   unit-test files do exactly that between commands on the memory adapter. DC-5.
6. **"`LruCache.set` reports a refusal."** `LruCache` is public (`Context.deltaCache`), so any
   return-type change regenerates `reports/api.json`; nine `set` call sites must each say what
   they do with the verdict (D1 table). DC-3.
7. **"`runExpire` walks all history even when `expireCut === unreachableCut` makes reachability
   unobservable."** Git's no-walk condition is `expire_unreachable <= expire_total`
   (`reflog.c` `reflog_expiry_prepare` → `UE_ALWAYS`), and git's keep rule is not tsgit's:
   `timestamp < expire_total` expires **unconditionally**, the unreachable clock tests **both**
   `old` and `new` oids, reachability is from **the ref's own tip** (`UE_NORMAL`; all tips only
   for `HEAD`, `UE_HEAD`), and the mark walk is **bounded** at `expire_total` (`mark_limit`).
   Pins R1–R7: on `refs/heads/main` (tip A, `A→B` in its log, B reachable only from `side`)
   `--expire=never --expire-unreachable=now` git keeps 1 entry; tsgit's all-tips/newId-only rule
   keeps 3. `--expire=now --expire-unreachable=never` git expires an unreachable-tip entry; tsgit
   keeps it. So "unobservable" is a property of git's rule, not of `===`. DC-7.
8. **"config freshness … next *read* → next *command*."** The verdict memo (`gateVerdictCache`)
   is already "per session until `invalidateConfigCache`" — a raw external edit that makes
   `[core]` malformed after the first command is **not** refused by later commands today, while
   `readConfig` consumers do see it. Git re-reads config per process and dies. The gate's single
   stat is the natural place to close that gap (D5); DC-1 records it as a sub-choice because it
   costs config-free commands one stat.
9. **"`tag.list` with 2000 packed tags = 6005 fs calls."** Per packed-only name: `readUtf8`
   (ENOENT) + `exists` + `stat` = 3 × 2 000 = 6 000, plus the gate. After (d)+(e)+(f): the
   gate's `lstat HEAD` + `stat .git/config` + `stat` + `readdir` of `refs/tags` (loose walk) +
   one `stat packed-refs` ≈ 5 (the HEAD candidate is ruled out by the prefix); the `readUtf8`
   of `packed-refs` only on a key change.
10. **"`isWorktreeScopeActive` … through `readSingleScope('local')`."** `readSingleScope` is
    module-private in `config-scoped-read.ts`, which imports `internal/config-scope.ts`
    (`:8`); routing the check through it from where it lives today would close an import cycle
    (`depcruise no-circular` is enforced). The check has to move next to the cache (D5-iii).
11. **`deltaCacheMaxEntries`** already exists as a public option (`index.node.ts:52`); the brief's
    "explicit options" follow that shape rather than inventing a new one.

---

## Requirements

| # | Requirement | Oracle |
|---|---|---|
| R1 | The two derived caches **engage on the medium fixture** under default options: the parsed memo retains all 5 000 walked commits (entry-bound, DC-2); `readHeadTree` on a 20 000-entry HEAD is a cache hit on the second call. A refused `set` is **observable** (DC-3) so neither can go dead silently again. | `object-caches.test`: 5 000 distinct entries → `entryCount === 5 000`; `read-head-tree.test`: second call issues zero object reads (`instrumentedContext`), `set` returned `true`; `bench:ab` `log()` medium ≈ 2× lower, `status()` medium not worse (local only until 31.4 — see D11). |
| R2 | **Per-command floor** (Node, warm, DC-1 (a)): `revParse('HEAD')` = 3 fs calls / 6 libuv hops (was 4 / 13); `catFile` = 2 calls / 2 hops (was 2 / 5 — the `readFile HEAD` becomes a `stat .git/config`); `branch.create` ≤ 13 (was 16; exact before/after recorded); no command issues more than one `stat .git/config` and one `lstat HEAD` per gate. Under DC-1 (a′) subtract the config stat (2 / 5 and 1 / 1). | `floor-oracle.mjs` under `fs-count.cjs` on `medium-v3` (recorded in the PR); unit: `instrumentedContext` over `assertOperationalRepository` + `resolveRef('HEAD')` sequences. `rev-parse.bench`/`cat-file.bench` main-vs-branch. |
| R3 | `tag.list` over N packed-only tags issues **O(1)** fs calls beyond the loose walk (was 3N); `branch.list` over N loose branches resolves through the `ioBound` pool. | New `tag-list.bench` (2 000 / 10 000 packed) and `branch-list.bench` (1 000 loose), `bench:ab` ≥ 4× lower on both (review: 104.6 → ~13 ms ceiling set by git's own 13 ms; 79 → 12–14 ms); unit fs-count on `listRefs` (zero `readUtf8` under `refs/tags/` for packed-only names). |
| R4 | The config freshness contract is exactly what DC-1 ratifies, documented on `internals.md` (`readConfig`, `invalidateConfigCache`), with the set of tests that needed an explicit `invalidateConfigCache` enumerated in the PR. | `config-read.test` epoch matrix (D5); the unit suite's failing set when the epoch lands is the enumeration (expected small — see D5 "Test impact"). |
| R5 | **Observable behaviour unchanged** — object bytes, ref/reflog contents, refusal codes and messages — except the two pinned faithfulness fixes: symlinked HEAD resolves `symbolic` (Pin H1), and `reflog expire` follows git's rule (Pins R1–R7) if DC-7(a). Every freshness window that changes is listed in the [ledger](#freshness-ledger-what-an-external-writer-can-observe). | Existing interop suites green; new `head-symlink-interop`, extended `reflog-interop` matrix; `packed-refs-interop`/`pack-refs-interop` unchanged. |
| R6 | `npm run validate` green; mutation budget intact (app ≥ 95); `reports/api.json` regenerated (`LruCache.set`, new options); docs per [Docs consequences](#docs-consequences); backlog 31.2 ticked by the docs phase. | Bare gate runs into files (`echo $?`); `npm run docs:json` diff committed in the slice adding each public change. |

---

## Design

### D0 — Shape and suggested part order

Harness first (so every A/B has before/after on the same series keys — 31.1's Part 1 lesson),
then the cache seam (domain → application), then the ref/config seam in dependency order, then
the tail. Eleven work items, proposed as **eight parts** (details in
[Partition proposal](#partition-proposal)):

| Part | Items | Owns |
|---|---|---|
| P0 | D11 harness (benches + oracle script) | `test/bench/*`, no `src/` |
| P1 | D1 `LruCache.set` verdict | `lru-cache.ts` (+ api.json) |
| P2 | D2 budgets: (a) memo entry-bound, (b-i) FlatTree budget, options plumbing | `object-caches.ts`, `read-head-tree.ts`, six entry/adapter files, `validate-options.ts` (+ api.json) |
| P3 | D3 (c-i) delta-base per-chain budget (+ (c-iii) only if DC-4 = a) | `object-resolver.ts`, `object-caches.ts` |
| P4 | D4 (d) HEAD reader + slot + symlink fix | new `internal/head-file.ts`, `repo-state.ts` (`hasUsableHead`), `ref-store.ts` (`resolveDirect`, HEAD writes), `bootstrap.ts:77` |
| P5 | D5 (e) config epoch + verdict re-keying, (h-i) `isWorktreeScopeActive`, (h-ii) one config read per ref update | `config-read.ts`, `repo-state.ts` (`assertOperationalRepository`), `config-scoped-read.ts`, `internal/config-scope.ts`, `record-ref-update.ts`, `reflog-identity.ts` |
| P6 | D6 (f) packed-refs + D7 (g) pooled enumeration | `ref-store.ts` (`loadPackedRefs`, `listRefs`, `packRefs`), `reflog.ts` (`resolveTips`), `list-worktrees.ts` |
| P7 | D8 (h-v) reflog expire model (DC-7) | `reflog.ts`, `reflog-interop.test.ts` |
| P8 | D9 (h-iv) rev-parse sweep + D10 (h-iii) `appendUtf8` | `resolve-ref.ts`, `rev-parse.ts`, `commit-ish.ts`; `node-file-system.ts` |

Every part is behaviour-preserving **except** P4 (symlinked HEAD becomes `symbolic` — Pin H1),
P5 under DC-1 (a) (an externally-introduced malformed `[core]` value is refused by the **next**
command instead of never — correction 8), and P7 (git's expire rule — Pins R1–R7); each is
pinned by an interop test and each moves *toward* git.

---

### D1 — (b-ii) `LruCache.set` reports its verdict

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
ignore the value. What each of the nine call sites does with it (DC-3 shape (a)):

| Call site | Verdict handling | Why |
|---|---|---|
| `read-head-tree.ts:136` | Returned to nobody at runtime; **unit test asserts `true`** for a 20 000-entry synthetic tree under the default budget, and `false` under a deliberately shrunk `flatTreeCacheMaxBytes` | An over-cap HEAD tree is legitimate (a 2 M-file monorepo) — not an error; the test is what makes a dead default loud |
| `object-resolver.ts:121` (memo) | Ignored; unit test asserts `true` for a 64 KiB-message commit under the valve | A pathological message not being memoised is by design |
| `object-resolver.ts:702` `cacheEntry` | Ignored | A > budget object is never cached; documented since ADR-720 |
| `object-caches.ts:273` `cacheDeltaBase` | Ignored — D3's per-chain budget check (≤ ¼ of the cache) runs first and is strictly tighter than the whole-budget refusal, so `false` is unreachable there | — |
| `index-pack.ts:363, :558` | Ignored (ADR-788: a cache miss changes latency, never results) | — |
| `load-reftable-stack.ts:276` | Ignored | Over-cap stack re-read next time, as today |
| `bitmap-reconstruct.ts:88` | Ignored | — |
| `node-file-system.ts:1115` `parentRealpathCache` | Ignored | Key-length sizer; cannot exceed |

Rejected: throwing (a large blob is not an error), a logger channel (none exists in the port
set), a `refusedCount` counter on the cache (no runtime consumer; the tests and benches are
the consumers — DC-3 alternatives).

---

### D2 — (a) memo bound by entries, (b-i) FlatTree on its own budget, options

**What goes wrong today.** Both caches take `1/16 × deltaCacheMaxBytes` and a 65 536 entry cap
that "never binds". For the memo the byte cap binds at ≤ 4 096 entries (256 B floor); a
5 000-commit walk in the same order every time is the worst LRU case (≈ 0 % hits). For the
FlatTree, 1 MiB holds ≈ 6 400 tracked files; the medium HEAD is refused on every `status`.

**The design principle** (the memory hint's "a number that reproduces is not a number that is
validated"): a cache's budget is expressed in the unit its consumer scales with — **entries**
for the memo (a walk of N commits needs N slots), **tracked files** for the FlatTree (one HEAD
tree of F files needs 164 F bytes) — and the byte cap becomes a *valve* sized so it binds only
for atypical entries, never for typical ones. That ordering is pinned by a unit test per cache
(the valve at the default must admit `maxEntries × typicalEntryBytes`), so a future retune
that flips the binding constraint fails a test instead of shipping a dead cache.

```ts
// object-caches.ts
export const PARSED_OBJECT_MEMO_MAX_ENTRIES = 65_536;          // primary bound (unchanged value)
/** Per-entry ceiling the valve is derived from: 256 B fixed + a 256 B typical message/parents
 *  allowance. `maxEntries × this` is what the byte valve must admit at the default budget. */
export const PARSED_OBJECT_TYPICAL_ENTRY_BYTES = 512;
// createLruCache(memoByteValve(ctx), memoMaxEntries(ctx))
```

```ts
// read-head-tree.ts
/** Bytes per tracked file the sizer charges (48 base + path ≈ 14 + oid 40 + 110). */
export const FLAT_TREE_TYPICAL_ENTRY_BYTES = 164;
// createLruCache(flatTreeMaxBytes(ctx), FLAT_TREE_CACHE_MAX_ENTRIES)
```

The **numbers** are DC-2's (the brief pre-names this decision); the shapes on the table
(`ctx.deltaCache` itself stays 16 MiB in every row):

| Option | Memo | FlatTree | Delta-base | Worst-case additive total at defaults |
|---|---|---|---|---|
| (a) explicit options, generous defaults | `parsedObjectMemoMaxEntries` 65 536; valve `2 × deltaCacheMaxBytes` = 32 MiB (admits 65 536 × 512 B) | `flatTreeCacheMaxBytes` = `deltaCacheMaxBytes` = 16 MiB (≈ 100 k files) | `deltaBaseCacheMaxBytes` = `deltaCacheMaxBytes` = 16 MiB (ADR-736) | 16 + 32 + 16 + 16 = **80 MiB** (≈ 34 today) |
| (a′) explicit options, conservative defaults | 32 768 entries; valve 16 MiB (admits 32 768 × 512 B) | 8 MiB (≈ 50 k files) | 16 MiB | 16 + 16 + 8 + 16 = **56 MiB** |
| (b) one documented total | `objectCacheMaxBytes` = 64 MiB split into fixed sixteenths (4/16 bytes · 4/16 delta-base · 4/16 flat · 4/16 memo valve); entries fixed at 65 536 | — | — | 64 MiB by construction — but fractions hide cliffs again, the exact failure mode being fixed |
| (c) git's knob | as (a) | as (a) | `core.deltaBaseCacheLimit` (git default **96 MiB**) | ≥ 160 MiB; needs an async config read at registry creation |

Every option keeps `deltaCacheMaxBytes` as the one dial that scales the family (a browser tab at
4 MiB scales (a) to 20 MiB). Options land on `OpenNodeRepositoryOptions` /
`OpenBrowserRepositoryOptions` / the memory adapter options and the three `create*Context`
factories (the six `DEFAULT_DELTA_CACHE_BYTES` sites), validated in `validate-options.ts`
(positive finite integers, like `deltaCacheMaxEntries`), carried on `Context` as an **optional**
`readonly cacheBudgets?: CacheBudgets` (`{ parsedObjectMemoMaxEntries; flatTreeCacheMaxBytes;
deltaBaseCacheMaxBytes }`, frozen, set by the three `create*Context` factories) and resolved by
one `budgetsFor(ctx)` helper that derives the defaults from `ctx.deltaCache.maxSize` when the
field is absent — the `concurrency?` / `limitFor` house pattern (`ports/context.ts:225-230`),
so every hand-built `Context` literal in the test suite keeps compiling and behaves as a
default-budget Context. `createPackRegistry` reads `budgetsFor(ctx).deltaBaseCacheMaxBytes`
instead of `ctx.deltaCache.maxSize`.

`deltaBaseCachingEnabled` (`object-caches.ts:214-216`) stays the gate for all three (fsck's
zero-budget audit Context). `forgetParsedObjectMemo` unchanged. The module's fraction-sweep
table (`:55-79`) is replaced by the entry-bound rationale and a pointer to the medium-fixture
A/B (D11); a sweep on the **large** fixture (50 k commits) is the honest follow-on and is
listed under out-of-scope with its reason (no large-fixture bench row exists).

---

### D3 — (c) delta-base cache: per-chain insert budget; the loose-header round trip

**(c-i) Per-chain budget.** Today one deep read inserts every level (`object-resolver.ts:504-519`):
a depth-43 chain over a 400 KB target pushes ≈ 17 MB through a 16 MiB LRU, evicting every
other chain's levels and its own base-nearest ones. Git has no per-chain rule — it relies on a
96 MiB default (`core.deltaBaseCacheLimit`) — so this is a tsgit **policy**, unobservable by
construction (a cache miss re-reads; bytes identical).

```ts
// object-resolver.ts — resolvePackChainWithDepth
const chainBudget = registry.deltaBaseCache.maxSize * DELTA_BASE_CHAIN_INSERT_FRACTION;   // ¼
let inserted = 0;
if (phase1.deltas.length > 0 && phase1.baseOffset !== undefined) {           // base first, as today (:494-503)
  inserted += insertLevel(baseKey, phase1.baseContent, 0);                  // returns the bytes charged, 0 when skipped
}
for (let i = phase1.deltas.length - 1; i >= 0; i -= 1) {                     // nearest the base first (today's order)
  current = applyDelta(current, step.instructions);                          // ALWAYS applied
  const chainDepth = phase1.deltas.length - i + phase1.baseChainDepth;      // unchanged (:517)
  if (inserted + deltaBaseCacheEntrySize(current) > chainBudget) continue;  // over the chain budget: stop caching, keep applying
  cacheDeltaBase(ctx, registry, step.probeKey, phase1.baseType, current, chainDepth);
  inserted += deltaBaseCacheEntrySize(current);
}
```

Nearest-the-base first is already the loop's order; the budget makes the *retained* set the
base-nearest levels (the ones a sibling leaf shares — in git packs the base is the newest
version and deltas chain older ones, so old-version reads share the lower levels). `chainDepth`
accounting, `enforcePackBaseCap` on probe hits and the target's own `ctx.deltaCache` insert are
unchanged. The `¼` is a named constant with the rationale above; its only oracle today is the
unit invariant (one read inserts ≤ ¼ and retains the base-nearest levels) — **no existing bench
exercises it** (the delta-chain fixture's chains total far below 16 MiB), stated in D11.

**(c-iii) Retire `prependHeader`/`splitHeader`.** `ctx.deltaCache` stores loose-format bytes
(`<type> <size>\0content`) because `parseObject` (`git-object.ts:33`), `RawObject.bytes`
(`types.ts:90-96`, nine `readRawObject` callers incl. the raw tree walks and fsck's hash pass)
and `verifyAndReturn` all consume that shape. Storing `{ type, content }` therefore changes the
**public** `Context.deltaCache` value type, the six creation sites, `parseObject`'s entry point
and `RawObject` (whose `bytes` would have to be synthesised — the copy moves, it does not
disappear). The avoidable cost is one content-sized copy per **pack-resolved** read
(`prependHeader`, ≈ 20–40 µs at 400 KB, ≈ 0.1 µs at a 300 B commit) plus a `TextDecoder` in
`splitHeader`. 31.3 restructures this exact seam (`readFile` views, inflate-output views,
`blob-source` populating `deltaCache`). DC-4 recommends deferring (c-iii) to 31.3 and taking
only the free part here: `splitHeader` compares the type bytes directly (no `TextDecoder`,
no `subarray` for the name) — behaviour-identical, kills nothing observable.

---

### D4 — (d) One HEAD reader, one slot, validated by the gate

**Mechanism (git).** `files_read_raw_ref` (`refs/files-backend.c`): `lstat`; a symlink mode ⇒
`readlink`, and if the text starts with `refs/` and passes `check_refname_format` it is a
symref (the symref flag is set), else fall through and read the file; a directory mode ⇒
ENOENT/EISDIR; else `open` + `read` + `parse_loose_ref_contents`. `validate_headref`
(discovery) applies the same symlink rule. Pin H1: symlinked HEAD → `symbolic-ref HEAD` =
`refs/heads/main`, `commit` advances `main`; a symlink whose text is not `refs/…` fails
discovery (`not a git repository`).

**Change.** A new internal module owns every read of `${gitDir}/HEAD`:

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
const slots = new WeakMap<Context, HeadSlot>();    // DC-6: Context identity, like the ref store

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
the link's own lstat) · directory ⇒ `unusable` · regular ⇒ `readUtf8` (4 hops; identity = the
lstat's). A rewrite landing between the `lstat` and the `readUtf8` stores new bytes under the
old identity; the next gate's `lstat` sees the rewrite's identity, mismatches, and re-reads —
the slot self-heals at the command boundary, which is the contract anyway. (The brief's
"collapse `lstat`+`readUtf8` into `openWithNoFollow`" — `open` + `fstat` + `read` + `close`,
identity and bytes from one handle — is the shape of DC-5 (b), where the gate always reads: it
takes 5 hops to 4 there. Under (a) the warm path is the `lstat` alone, and routing the miss path
through `FileHandle` would only move HEAD reads onto the memory adapter's handle emulation and a
browser fallback for no hop saved.) Warm path on Node: **1 hop** (`lstat`) per command. Hop
accounting (HEAD only; DC-1's config stat is counted in R2):

| | Today | After (Node, warm) | After (memory/browser: `ino === 0`) |
|---|---|---|---|
| gate (`catFile` warm) | `lstat` + `readFile` = 1 + 4 = 5 hops, 2 calls | `lstat` = 1 hop, **1 call** | `lstat` + `readUtf8` (no hops on memory) |
| `revParse('HEAD')` | 5 + `readFile HEAD` 4 + `readFile refs/heads/main` 4 = 13 hops, 4 calls | 1 + 4 = 5 hops, **2 calls** | lstat + read + read |
| first command in a session | 13 | 1 + 4 + 4 = 9 | — |

**Degenerate identity (correction 5).** When the adapter reports `ino === 0` the identity is
`undefined` and the slot is never trusted across commands: the gate re-reads the content every
command (as today) and the ref store reuses that content within the command. Freshness there is
verbatim today's at the command boundary; only Node gets the identity fast path. This is "the
gate is the data" (31.1's pattern), not a capability flag. Node's identity uses
`mtimeNs`/`ctimeNs` when present (ADR-conformant stat-cache fields; git's `stat_data` precedent)
and `ino` (git and tsgit write HEAD by lock-and-rename, so a rewrite mints a new inode).

**Consumers.**

- `hasUsableHead` (`repo-state.ts:130-144`) → `validateHead(ctx)`; the predicate over the result
  is unchanged (`isRefsLinkText` for `symlink`, `isValidHeadContent` for `file`, `false` for
  `unusable`). The existing matrix (`repo-state.test.ts:202-340`: symlink to `refs/heads/main`,
  symlink elsewhere, dangling symlink, valid/invalid regular, absent, EACCES, EISDIR) stays green.
  "HEAD deleted between two commands" (`:184-200`) → the second `lstat` misses → slot dropped →
  refuses. Reftable layouts: unchanged (`HEAD` stub read the same way; the reftable ref store
  never reads the slot).
- Files ref store `resolveDirect('HEAD')` (`ref-store.ts:403-415`, `name === HEAD_NAME`): →
  `readHeadFile(ctx)`: `symlink` with `refs/`-prefixed valid text ⇒ `{ kind: 'symbolic',
  target }` (the fix, Pin H1; a non-`refs/` symlink never reaches here — the gate refused);
  `file` ⇒ `parseLooseRef(content)` as today; `unusable` with a `FILE_NOT_FOUND` cause ⇒
  `missing` (today: `readUtf8` → `undefined` → packed lookup → `missing`; HEAD is never packed,
  so skipping the packed load is unobservable); any other cause is **rethrown** — a primitive
  caller on an EACCES/EISDIR HEAD sees the same `PERMISSION_DENIED`/mapped errno as today (the
  gate collapses every cause to "no usable head" exactly as it does now, so nothing changes on
  the command surface either). `headCandidate` (`:462-465`) keeps its `exists` probe (1 stat;
  its prefix guard already skips it for `refs/…` prefixes).
- A write through `applySetSymbolic('HEAD')` over a symlinked HEAD replaces the link with a
  regular file (lock + rename), which is git's own default too (`create_symref_locked` writes a
  file unless `core.preferSymlinkRefs`); tsgit does not implement `core.preferSymlinkRefs` —
  pre-existing, out of scope.
- `applySet`/`applySetSymbolic` (`:769-785`) call `invalidateHeadSlot(ctx)` when `update.name ===
  HEAD_NAME` after `atomicWriteRef`; `bootstrap.ts:77` (the one raw HEAD writer in `src/`)
  likewise. Reflog-only updates never touch HEAD's file.
- `list-worktrees.ts` per-worktree Contexts (`deriveWorktreeContext`) get their own slot (miss
  once per listing, as today's one read).

**Window that changes (ledger row L1).** Within one command, after the gate validated HEAD, an
external rewrite of HEAD is not observed by that command's later `resolveDirect('HEAD')` calls
(today each opens the file). The window is the command's own duration; the next gate notices.
Git's own process reads HEAD per `resolve_ref` call and would notice mid-process — nothing
observable depends on it (a concurrent `git checkout` during a `git commit` is a race in git
too, resolved by the ref lock, which tsgit also takes on write).

Not touched: non-HEAD symlinked loose refs (`readLooseContent` still follows; pre-existing,
out of scope — noted), `hasUsableHead`'s "collapse every failure to false" contract.

---

### D5 — (e) Config epoch at the gate; (h-i) worktree-scope check through the cache; (h-ii) one config read per ref update

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
whose key differs is recomputed. `assertOperationalRepository` = `hasUsableHead` (D4's
`validateHead`) → `openConfigEpoch` → memoised verdict. `assertRepository` (the `config`
porcelain's bare gate) does **not** open an epoch (its readers are the scoped cache, which keeps
its own per-call stat — out of scope). Nested gates (a command calling another command's
function) re-stat: harmless, one hop.

Cost accounting: a command that reads config pays the same one stat as today (moved from its
first `readConfig` to the gate); a command that never reads config (`catFile`, `readBlob`,
`revParse`) pays **one more** stat than today — the price of closing correction 8's verdict gap.
DC-1 (a′) is the lazy variant (gate only *clears* `trusted`; the first read stats), which keeps
config-free commands stat-free and leaves the verdict gap as is.

**Contract (documented on `internals.md`).** A config file changed by tsgit's own writers is
seen on the next read (unchanged — they call `invalidateConfigCache`, which drops the trusted
entry). A raw external write is seen **at the next operational gate** (next command) or the next
`invalidateConfigCache`; a session that never runs a gate keeps per-read staleness detection.
Same-millisecond same-size rewrites were already undetectable (`mtimeMs:size` key) — unchanged.

**Test impact (the brief's question).** Heuristic sweep: 46 test files seed `.git/config` with a
raw `writeUtf8`; 3 also call `invalidateConfigCache`; 14 mix a Tier-1 command with a
config-reading primitive. The shape that breaks under (a) is *gated command → raw config
rewrite → config-reading primitive called directly (no gate)*. Unit tests overwhelmingly seed
config in Arrange before the first command, and primitive-only tests never arm an epoch, so the
expected set is single digits; the mechanical enumeration is "land the epoch, run
`npm run test:unit`, add `invalidateConfigCache(ctx)` after each raw rewrite in the failing
tests" — the planner lists them from that run. `__resetConfigCacheForTests` resets the bit.

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

### D8 — (h-v) `reflog expire`: git's reachability rule, bounded walk

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
// reflog.ts — runExpire (DC-7 a). tsgit's cutoffs are already git-shaped for this comparison:
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
tips, another pre-existing gap the rewrite closes (an annotated-tag-only commit is reachable in
git). The per-ref walk replaces one whole-history walk per `expire` with a walk from one tip
bounded at `expire_total` — on the default clocks (`90.days.ago`) that is the last 90 days of
one branch, not the repository.

**Observable change (R1–R7 all flip to git's answers).** Recorded as DC-7 with the interop
matrix as its pin; ADR-064's "fully faithful" paragraph is superseded. Unit tests
`reflog.test.ts:742-960` encode today's rule and are rewritten to the matrix. DC-7 (b) is the
perf-only fallback: skip the all-tips walk when `unreachableCut <= expireCut` … except that under
tsgit's *current* keep rule the walk is unobservable only at `===` (with `<`, unreachable entries
are kept longer than reachable ones), so (b) is strictly the brief's literal `===` and keeps
every divergence.

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
(`commit-ish.ts:24` passes `{ peel: true }`). `rev-parse.ts:65-71`
and `commit-ish.ts:22-28` call `resolveRefOrMissing` inside the same `try/catch { continue }`
(git's `expand_ref` continues past broken/dangling candidates, so swallowing non-miss errors
stays). `refCandidates` stays an array — `canonicalizeRef` (`rev-parse.ts:109-124`) iterates
it twice, so a generator would break it, and six short strings cost ≈ 0.3 µs; the brief's
"six strings" is not where the time goes, the two stack captures are. Per miss after this
change: 0 thrown `REF_NOT_FOUND`; the adapter's `FILE_NOT_FOUND` on the loose probe remains
(31.3's `tryReadUtf8`). The existing `AMBIGUOUS_OID_PREFIX` / `OBJECT_NOT_FOUND` fallbacks are
untouched. `rev-parse.bench` gains an abbreviated-oid row, the only shape that exercises the
sweep (D11).

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
write path (`mode` on write, fstat return), and `writeExclusive` is the ref-lock path whose
parent almost always exists — same fix applies but its harness is 31.4's `checkout.bench`.
Oracle: `node-file-system-injected.test.ts` pattern — an `fsOps` double records that an append
into an existing directory issues **no** `mkdir`, a missing parent issues `mkdir` then a
second `appendFile`, and a non-ENOENT failure propagates without `mkdir`.

---

### D11 — Harness

**Which oracle proves which item** (honesty first):

| Item | Bench / oracle | Status |
|---|---|---|
| (a) memo | `log.bench` both rows, medium, `bench:ab` main-vs-branch (review: 21–30 → 9.4–11.5 ms) | exists |
| (b-i) FlatTree | `status.bench` medium, `bench:ab` **locally** on the generated fixture (review: 145 → 138). The CI nightly `status` row measures the tar-restored stat-invalid state (31.4/F4) until 31.4 lands — not publishable from the nightly for this item; say so in the PR | exists, CI row polluted |
| (b-ii) `set` verdict | structural; unit only | no bench by nature |
| (c-i) per-chain budget | **none** — `delta-chain-read.bench`'s chains total far below 16 MiB, so the budget never binds on any existing fixture; unit invariant only (D3). A 400 KB × 43-level fixture would make it measurable and is not built here (cost: a new generated fixture family) | **no honest bench today** |
| (c-ii) budget docs | documentation | — |
| (d) HEAD | fs-count oracle (`floor-oracle.mjs` below) on `revParse('HEAD')` (4 → 2 calls) and `catFile` (2 → 1); `rev-parse.bench`, `cat-file.bench` `bench:ab` | exists |
| (e) epoch | fs-count on `branch.create` (16 → ≤ 12, exact recorded) and on a `commit` of one file (`stat .git/config` per `writeObject` → 1 per command); `commit.bench` `bench:ab` | exists |
| (f) packed-refs | new `tag-list.bench` 2 000 / 10 000 packed; fs-count on `tag.list` 2 000 (6 005 → ≈ 4) | **new** |
| (g) pooled | new `branch-list.bench` 1 000 loose (79 → 12–14 ms review); `list-worktrees`/`packRefs` prune: unit only (N small in every fixture) | **new** / unit |
| (h-i) worktree scope | fs-count on `config.get` (9 → ≈ 6: the raw local read goes, and under D4 the gate's second HEAD read; the per-scope stats and the global/system `exists` probes stay — out of scope); unit | script |
| (h-ii) ref-update fold | subsumed by (e)'s `branch.create` count | — |
| (h-iii) `appendUtf8` | 15 vs 57 µs is inside `commit.bench`'s noise; unit only | **no honest bench** |
| (h-iv) rev-parse sweep | new `rev-parse.bench` row `When revParse() resolves an abbreviated oid, Then measure tsgit` (six misses + prefix resolve; today's HEAD row never enters the sweep) | **new row** |
| (h-v) reflog expire | correctness (interop matrix); no bench exists and the medium fixture's dates are seconds apart so a 90-day cut walks everything anyway — a bench would measure the walk, not the bound | **no bench; pinned instead** |

**New bench files** (in-process scratch repositories built with tsgit's own primitives, never
`git`, never the shared cache — the 31.1 `name-rev.bench` many-tag pattern and
`fixture-scratch.ts`'s `removeSync` teardown):

- `test/bench/tag-list.bench.ts`: `setupSmallRepo()` base (`test/bench/fixtures.ts:50`), N
  lightweight tags via `updateRef` in a `boundedMapFor` loop, then `repo.packRefs()` (ADR-707) so
  every tag is packed-only; rows `When tag.list() lists 2000 packed tags, Then measure tsgit`
  and `… 10000 …`. Assert in the fixture builder that `refs/tags/` is empty after packing (the
  row is meaningless if the tags stayed loose).
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
on a 2 000-packed-tag scratch, `config.get('user.name')` twice, printing
`__fsCounts.snapshot()` for the second iteration. Before/after tables go in the PR.

**`bench:ab` rows read for non-regression**: `rev-parse` (both rows), `cat-file`, `log` (both),
`status` medium (local), `commit`, `delta-chain-read` (all three), `tag-list`, `branch-list`,
`maintenance gc` (delta-base + closure paths). Absolute wall-clock both sides, alternating
rounds; published numbers only from the nightly artifact.

---

### Freshness ledger (what an external writer can observe)

Every cache or epoch this design adds or changes, with the exact window in which an
**external** mutation (not through tsgit's own writers) goes unnoticed. "Today" columns are
verified against the current code.

| # | State | Today | After | Window that changes |
|---|---|---|---|---|
| L1 | `${gitDir}/HEAD` content | read on every `resolveDirect('HEAD')` and at every gate | Node: `lstat`-identity check at every gate; trusted for the rest of that command. Memory/browser (`ino === 0`): re-read at every gate, reused within the command | **Within one command** after its gate. Same-identity rewrite (same `mtimeNs`, `ctimeNs`, `ino`, `size`) on Node — requires an in-place write within one ns tick; git-style lock-and-rename always changes `ino` |
| L2 | `.git/config` for `readConfig` consumers | `stat` on every sequential read (same-ms same-size rewrites undetectable) | one `stat` at every operational gate; trusted within the command; per-read `stat` when no gate ran (primitive-only sessions) | **Within one command** after its gate |
| L3 | `.git/config` for the **gate verdict** | session-memoised; external edits never re-validated until `invalidateConfigCache` | DC-1 (a): re-validated by the gate's `stat` every command; (a′)/(b): unchanged | **Improves** under (a) (closes correction 8) |
| L4 | `packed-refs` | `exists` + `stat` per load, `mtimeMs:size` key | one `stat` per load, same key | none |
| L5 | scoped config (`config` porcelain) | `stat` per `readSingleScope`; worktree flag raw-read per call | `stat` per `readSingleScope`; worktree flag from the cached local read | none (the raw read had no cache to be staler than) |
| L6 | parsed memo / FlatTree / delta-base | immutable-object caches; gc `forget`s | same, larger | none |

---

### Cross-item ownership (who edits what, who inherits)

| Function | Owner | Inherits |
|---|---|---|
| `repo-state.ts` `hasUsableHead` | D4 (P4) | D5 leaves it; `assertOperationalRepository` gains the epoch call (P5) after P4 lands |
| `ref-store.ts` `resolveDirect` HEAD arm | D4 | D6/D7 never touch `resolveDirect` |
| `ref-store.ts` `loadPackedRefs` | D6 | D7 calls it concurrently (safe, D7) |
| `ref-store.ts` `listRefs` | D6 splits loose/packed; **D7 pools the loose arm in the same part** (P6, two commits) | `packableEntries`/`packRefs` inherit both |
| `reflog.ts` `resolveTips` | D7 pools it | D8 narrows its use to `UE_HEAD` — P6 lands first, P7 keeps the pooled helper |
| `config-read.ts` cache entry / verdict memo | D5 | `resolve-max-tree-depth` / `write-object` / `record-ref-update` inherit stat-free reads without edits |
| `record-ref-update.ts` | D5 (h-ii) | D10 changes only the adapter under `appendReflogFile` |
| `object-caches.ts` | D2 (budgets, constants) and D3 (`cacheDeltaBase` returns the verdict) — D2 first | D1's `set` verdict flows through |
| `LruCache` type | D1 | every `set` caller unchanged unless listed in D1 |
| `OpenRepositoryOptions` family + `Context` | D2 | — |

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

The brief pre-names two ADR decisions (DC-1, DC-2). Probing every load-bearing choice adds five
more, each with a recommendation; rejected candidates (not decisions) follow the table.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | **Config freshness contract** (brief i) | (a) gate-armed epoch: one `stat` in `assertOperationalRepository`, entry trusted for the command, verdict memo re-keyed on the stat (closes correction 8); primitive-only sessions keep per-read stats; contract "raw external write seen at the next command or `invalidateConfigCache`". (a′) same but lazy — the gate only clears `trusted`, the first `readConfig` stats; config-free commands pay nothing; the verdict gap stays. (b) keep per-read stats; ship only the (h-ii) fold and 31.1's hoist | **(a)** | The one stat is the price of a refusal git makes and tsgit currently does not (an externally malformed `[core]` refused on the next command); (a′) saves a ~10 µs hop on `catFile`-shaped commands only, which 31.3 makes ~1 µs; (b) leaves `write-object`'s per-object stat and 11 `walkTree` callers' stats. Test impact: single-digit files expected, enumerated mechanically (D5). |
| DC-2 | **Cache budgets** (brief ii) | (a) explicit options with entry-first bounds and generous defaults (memo 65 536 entries + 32 MiB valve, FlatTree 16 MiB ≈ 100 k files, delta-base 16 MiB; worst-case additive ≈ 80 MiB, scales with `deltaCacheMaxBytes`). (a′) same options, conservative defaults (32 768 entries + 16 MiB, FlatTree 8 MiB; ≈ 56 MiB). (b) one documented total re-derived into fractions. (c) git's `core.deltaBaseCacheLimit` (96 MiB) for the delta-base cache | **(a′)** | Entry-first bounds are the structural fix; the defaults are a memory-vs-cliff trade the user owns. (a′) covers the medium fixture 6× over on entries and 2.5× on files with a total 1.6× today's, and every number is one option away; (a) is what a 50 k-commit repository wants but doubles the documented footprint; (b) re-creates the hidden-cliff failure mode; (c) needs an async config read at registry creation and a 96 MiB default that is wrong for a browser tab. |
| DC-3 | **What "`LruCache.set` reports a refusal" means** | (a) `set(): boolean`, refusal = `false`; consumers are D1's table — tests only, no runtime channel. (b) typed verdict `'stored' \| 'refused'`. (c) boolean + a `refusedCount` counter on the cache | **(a)** | Same information as (b) with less mutation surface; (c) adds a stat nobody reads at runtime — the loudness that matters is the unit test pinning `true` at the default budget for the medium-shaped inputs, plus the D2 invariant tests (valve admits `maxEntries × typical`) that make a future retune fail before it ships. Public type → api.json regen either way. |
| DC-4 | **(c-iii) `{type, content}` in `ctx.deltaCache`** | (a) change the public `Context.deltaCache` value type now (`parseObject` content entry point, `RawObject.bytes` synthesised, six creation sites). (b) keep bytes; drop only the `TextDecoder` in `splitHeader`. (c) defer (c-iii) to 31.3, which owns this seam (`readFile` views, inflate views, `blob-source` populate); take (b) here | **(c)** | Measured avoidable cost is one copy per pack-resolved read (≤ 40 µs at 400 KB, 0.1 µs at a commit); the blast radius is a public port type plus nine `readRawObject` callers, and 31.3 rewrites the same pipeline — doing it twice is churn. Recorded as a deferral with its number, not dropped. |
| DC-5 | **HEAD slot identity** (correction 5) | (a) `lstat` identity `(mtimeNs\|mtimeMs, ctimeNs\|ctimeMs, ino, size)` trusted across commands only when `ino !== 0`; `ino === 0` adapters (memory, browser) re-read at each gate and share within the command. (b) content-share only (the gate always reads; no identity trust; 5 → 4 hops on the gate, 13 → 8 on `revParse`). (c) identity everywhere + the memory adapter minting a per-write generation `ino` | **(a)** | Node gets the brief's floor (gate 5 → 1 hops, `revParse` 13 → 5) on git's own `stat_data` identity precedent; the degenerate adapters get (b)'s behaviour automatically, so no unit test that rewrites HEAD raw between commands (187 sites) can go stale; (c) changes the memory adapter's stat identity, which 31.4's stat-cache work depends on. Includes the symlinked-HEAD `symbolic` fix (Pin H1) — a faithfulness fix the sole reader gets by construction; the alternative (preserve today's `direct`) would mean deliberately re-implementing the divergence. |
| DC-6 | **HEAD slot keying** | (a) `WeakMap<Context, HeadSlot>` (Context identity, the ref store's own rule — `ref-store.ts:243-269`: a `{ …ctx, fs: proxy }` spread must not read HEAD through the original fs). (b) `WeakMap<Context['session'], …>` (ADR-722's general rule; derived Contexts share the slot) | **(a)** | The slot is read through `ctx.fs`; session keying would let a proxied-fs Context be served bytes the proxy never produced — exactly the failure the ref store documents having hit. Cost: one extra HEAD read per derived Context (`listWorktrees`), as today. |
| DC-7 | **`reflog expire` reachability rule** (correction 7) | (a) git's model in-PR (D8): `UE_ALWAYS`/`UE_HEAD`/`UE_NORMAL`, `timestamp < expire` unconditional, old+new checked, walk bounded at `expire_total`; ADR-064's "fully faithful" superseded; Pins R1–R7 as interop tests. (b) perf-only: skip the all-tips walk at `expireCut === unreachableCut` (the brief's literal), divergences recorded as known. (c) (b) now, (a) as its own backlog item | **(a)** | Three pinned divergences in refusal-adjacent output (which reflog lines survive `gc`'s expire); the faithful mechanism *is* the perf mechanism (one tip, bounded walk); the code is being touched anyway; "everything rides in the current PR" is the default. (b) buys nothing on the default clocks (`90.days` vs `30.days` are never equal). |

**Rejected candidates — not decisions:**

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
- *Pool bucket for loose enumeration* — `ioBound`, the bucket `packRefs` already uses for
  `buildPackedEntry`.
- *`refCandidates` order* — unchanged (git's `ref_rev_parse_rules`); only laziness added.
- *`appendUtf8` retry count* — one `mkdir` + one retry; a second ENOENT is a real fault.
- *Honouring `gc.reflogExpire*` config in `expire`* — pre-existing gap (tsgit uses constants);
  not part of the reachability rule; out of scope.

---

## Test strategy

House rules: `describe('Given …')` › `describe('When …')` › `it('Then …')`, AAA, `sut`; 100 %
coverage; every error assertion checks `data`; guard clauses tested in isolation; no ignore
directives. Property lenses: `lru-cache.properties`-style sequences already exist
(`lru-cache.test.ts:498-575`); the `set` verdict adds an invariant to them (`set` returns
`false` iff `byteSize > maxSize`, and a `false` never changes `currentSize`/`entryCount`). No
parser or matcher is touched elsewhere (the expire predicate is a total function over three
timestamps and two booleans — a parameterised sweep is the clearer proof).

### Unit, per item (mutation-resistant shape)

| Item | Tests (file) | Kill shape |
|---|---|---|
| D1 | `lru-cache.test.ts`: `set` over-cap → `false`, cache unchanged (size, count, order); in-cap → `true`; the existing "single 200-byte entry in cache(50)" case (`:341`) asserts the verdict; property invariant above | Return-literal mutants; `>` vs `>=` at the exact cap (`:430` "totaling exactly 100" case extended: `set` at exactly `maxSize` → `true`) |
| D2 memo | `object-caches.test.ts`: 5 000 distinct commit-shaped entries at the default budget → `entryCount === 5 000`; `parsedObjectMemoMaxEntries` option honoured; a 64 KiB-message entry stored; the valve-admits-entries invariant (`maxEntries × PARSED_OBJECT_TYPICAL_ENTRY_BYTES <= valve` at defaults) as a literal test | Constant mutants via the invariant; option plumbing via a non-default value observed in `entryCount` |
| D2 FlatTree | `read-head-tree.test.ts`: 20 000-entry synthetic tree at defaults → second call zero object reads (`instrumentedContext`), `set` verdict `true` (spy on the cache or assert via reads); the over-cap case (`:171`) re-pinned under a shrunk `flatTreeCacheMaxBytes`; the "multiplied share" case (`:395`) rewritten for the new sizing; `FLAT_TREE_TYPICAL_ENTRY_BYTES × 100_000 <= default` literal | Budget mutants via the 20 000-entry hit |
| D2 options | `validate-options.test`, `index.node.test`/`index.browser.test`/`memory-adapter.test`: each option validated (non-integer, ≤ 0 refused with the existing `INVALID_OPTION` shape), defaulted, and reaching `ctx.cacheBudgets` | Each option's absence/presence isolated |
| D3 | `object-resolver.test.ts` (`:1606-1900` chain suites): a chain whose levels exceed ¼ of a small `deltaBaseCacheMaxBytes` inserts the base-nearest levels only (`entryCount`, `has(key)` per level), bytes returned identical; a `false` from `cacheDeltaBase` stops further inserts; `chainDepth` on a later probe hit unchanged (existing `:1670` suite) | `continue` → insertion mutants via `has(key)`; fraction mutants via the boundary level |
| D4 | `repo-state.test.ts` matrix (`:202-340`) unchanged + new: second gate on an unchanged HEAD issues `lstat` only (a `ctx.fs` proxy whose `lstat` reports Node-shaped fields with `ino !== 0` — the memory adapter reports 0, so the identity path is only reachable through a proxy; DC-6's Context keying makes the proxied Context's slot its own) / re-reads on the plain memory adapter (`ino === 0`); rewritten HEAD (new ino) re-read; `ref-store.test.ts`: `resolveDirect('HEAD')` after a gate issues **no** `readUtf8`; the two existing call-list assertions naming `readUtf8` on `/HEAD` re-pinned; symlinked HEAD → `{ kind: 'symbolic', target: 'refs/heads/main' }` (memory adapter `symlink`); own `setSymbolic('HEAD')` invalidates (next read sees it without a gate); `bootstrap` write invalidates; primitive-only sequence re-validates by `lstat` each call; `unusable` with an EACCES cause rethrows `PERMISSION_DENIED` from `resolveDirect` | Trust-bit mutants: a stale slot served after a rewrite; identity-field mutants via the proxy varying one field at a time (mtime, ctime, ino, size); cause-filter mutant via the EACCES case |
| D5 | `config-read.test.ts`: gate → `readConfig`×3 = one `stat`; raw rewrite inside the epoch unseen, seen at the next gate; `invalidateConfigCache` clears `trusted`; no gate → `stat` per read (today's tests hold); verdict memo re-run on key change (raw rewrite to a malformed `core.sparseCheckout` between two commands → second refuses `CONFIG_BAD_BOOLEAN_VALUE`; today's `:110/:130` tests kept); `config-scoped-read.test.ts`: unscoped `config.get` → one local read; `record-ref-update.test.ts`: `readConfig` spy called once | Bit mutants via stat counts; memo-key mutants via the malformed-rewrite refusal |
| D6 | `ref-store.test.ts`: absent `packed-refs` → one `stat`, zero `exists`; packed-only names in `listRefs` → zero `readUtf8` under the prefix; loose-overrides-packed, unparseable-loose-excluded (`:633`, `:885`, `:955` suites) unchanged; a directory at `packed-refs` throws the adapter's mapped error as today | Split mutants via read counts |
| D7 | `ref-store.test.ts`: `listRefs` over 64 loose names — an `fs` double that records max in-flight `readUtf8` > 1 and asserts sorted output; `packRefs` prune probe pooled; `list-worktrees.test.ts` order + in-flight; `reflog.test.ts` `resolveTips` dedup | Serial-vs-pooled via in-flight counter (a `boundedMapFor` → `for…await` mutant reads 1) |
| D8 | `reflog.test.ts`: the R-matrix as parameterised cases over `{expire, unreachable} × {reachable-from-own-tip, reachable-from-other-tip, unreachable, null-old}`; `UE_ALWAYS` short-circuit issues zero object reads; bounded walk stops at `expireCut` (a commit older than the cut, reachable through it, is treated as unreachable unless it is the frontier commit — R-source); `HEAD` uses all tips; unresolvable ref under `all` ⇒ always | Each predicate arm isolated; `<` vs `<=` at the cut; old/new symmetry via a case where only `old` is unreachable |
| D9 | `resolve-ref.test.ts`: `resolveRefOrMissing` → `undefined` on missing, the same `REF_NOT_FOUND` data (`ref` = the chain's last name) from `resolveRef`; cycle/depth/invalid-name still throw; `rev-parse.test.ts`: a miss sweep constructs no `REF_NOT_FOUND` (a `RefStore` double counting `resolveDirect` calls = 6, and `resolveRef` never invoked) | Message/name mutants via the dangling-symref case |
| D10 | `node-file-system-injected.test.ts`: existing parent → `appendFile` only; missing parent → `appendFile` (ENOENT) → `mkdir` → `appendFile`; EACCES → propagates, no `mkdir` | Retry-count and errno-filter mutants |

### Interop (real git, `test/integration/*-interop.test.ts`)

Rules as 31.1: one shared repo per `describe` in `beforeAll`, 60 s timeout, `GIT_*` scrubbed,
`HOME` isolated, signing off, a fresh tsgit `Context` after every git write.

| Test | Pins |
|---|---|
| new `head-symlink-interop.test.ts` | H1: after `ln -s refs/heads/main .git/HEAD`, tsgit `revParse('HEAD')`, `symbolicRef`-equivalent (`currentBranchRef`), `branch.list` `current`, and a `commit` advancing `main` all agree with git; H2: the non-`refs/` link refuses `NOT_A_REPOSITORY` where git fails discovery |
| `reflog-interop.test.ts` (extend) | R1–R6 on the pinned history with twin repos (git rewrites the peer, tsgit ours; compare log bytes); R6′ `--all` over a gone ref |
| `packed-refs-interop.test.ts` / `pack-refs-interop.test.ts` | unchanged — re-run (D6/D7 must not move a byte) |
| `config-interop.test.ts` | unchanged; plus the correction-8 case: an external edit making `core.sparseCheckout` malformed between two tsgit commands is refused by the second (git refuses on its next invocation) |

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
| `object-resolver.ts:621` | BlockStatement — `resolveBaseForRefDelta` cache shortcut | Untouched under DC-4 (c); re-run |
| `object-resolver.ts:671, :676` | EqualityOperator — `splitHeader` guards | Rewritten if the `TextDecoder` goes (DC-4 b/c): re-prove at the new lines or drop with the literal |
| `object-resolver.ts:173-193` | BlockStatement — pre-apply cap | Untouched; re-run |
| `ref-store.ts:318, :320` | Equality/Conditional — `compareRefNames` | Untouched; re-run |
| `config-read.ts:185` | StringLiteral — absent sentinel | Untouched; re-run |
| `config-scope.ts:105` | ConditionalExpression — global path | Moves with `resolveScopePath` refactor; re-prove in place |
| `update-config.ts:435, :564` | CallExpression — invalidate pairing | Unchanged; re-run (the pairing still holds with the trusted bit) |
| `tag.ts:79` | EqualityOperator — sort comparator | Untouched; re-run |
| `list-worktrees.ts:185, :187` | Equality/Conditional — `byPath` | Untouched; re-run |
| `resolve-ref.ts:34` | StringLiteral/Conditional — HEAD name guard | Structure moves into `resolveRefOrMissing`; re-prove at the new line |
| `memory-file-system.ts:438` | MethodExpression — handle read clamp | Now on the HEAD read path (memory adapter, `openWithNoFollow`); re-run |

Local Stryker: `--concurrency 3`, `.stryker-tmp` cleared, `static: true` mutants checked before
kill tests; ranges from `git diff main` (working-tree-inclusive).

### Docs consequences

For the docs phase: `docs/use/primitives/internals.md` — `readConfig` / `invalidateConfigCache`
(DC-1 contract, the gate's stat, the verdict re-keying), `parsedObjectMemoFor …` and
`readHeadTree` (entry-bound sizing, options, the new additive total replacing "~34 MiB",
`LruCache.set` verdict), `RefStore · getRefStore` (single stat, packed-only from snapshot,
pooled `listRefs`, HEAD read through the slot, symlinked HEAD symbolic), `recordRefUpdate`
(one config read), `listWorktrees` (pooled); `docs/use/commands/reflog.md` Behaviour (DC-7's
rule verbatim) and `docs/adr/064` superseded-by note; `docs/use/commands/rev-parse.md` (no
change in behaviour; none needed); the three new options documented wherever
`deltaCacheMaxEntries` is today (no `docs/use` page mentions it — `docs/understand/architecture.md`
is the only non-design hit; the docs phase decides between extending it and adding an
`openRepository` options row to `docs/use/README.md`); `reports/api.json` regenerated for
`LruCache.set` and the options. Backlog 31.2 ticked by the docs phase with the design/ADR
suffix only.

---

## Out of scope

- **31.3's adapter seams** — the sync fast path, `tryLstat`/`tryReadUtf8` (the remaining
  `FILE_NOT_FOUND` construction on every rev-parse miss and loose-ref miss), `readFile`/inflate
  views, the pack-first cold order, `blob-source` populating `deltaCache`, and — under DC-4 (c) —
  the `{type, content}` cache value type. Each is named in its D-section where this design stops
  short of it.
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
  reachability rule.
- **The scoped config reader's per-call stat** (`config` porcelain) — not on the operational
  gate; its parse is already cached; (h-i) removes the only uncached read.
- **A large-fixture (50 k commits) memo sweep** — no bench row on `large-v1` exists; the medium
  A/B and the entry-bound invariant are the oracle; the sweep is the honest follow-on and is
  stated as such in `object-caches.ts`'s rationale rather than invented.
- **Regenerating `docs/perf/baseline.*`** — the `profile` workload set is unchanged.
- **F2, F4, F5, F7–F10, F12, F13** of the review — 31.3–31.6.

---

## Partition proposal

Sized for TDD slices in dependency order. "Gate" is the part gate from `.claude/workflow.md`
(`vitest run <touched-tests>` + `check:types` + `biome` + `check:spelling`); the phase gate is
`npm run validate`. Parts marked *(2 commits)* land as two atomic commits inside one part
because their oracles differ while their files overlap.

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

### P1 — `LruCache.set` verdict (D1)

- **Files:** `src/domain/storage/lru-cache.ts` (`set` at `:92-118` → `boolean`), `reports/api.json`
  (`npm run docs:json`).
- **Tests:** `test/unit/domain/storage/lru-cache.test.ts` (`:341`, `:430` cases extended; property
  block `:498-575` invariant).
- **Gate:** domain tests + api.json regen in-slice (prepush gate). Independent commit.

### P2 — Budgets and options (D2; DC-2, DC-3)

- **Files:** `object-caches.ts` (`PARSED_OBJECT_MEMO_FRACTION:81` → valve constants;
  `parsedObjectMemoFor:94-104`), `read-head-tree.ts` (`FLAT_TREE_CACHE_FRACTION:50`,
  `flatTreeCacheFor:64-74`), `pack-registry.ts:640-643` (`deltaBaseCacheMaxBytes`),
  `ports/context.ts:198-230` (`cacheBudgets`), `index.node.ts:49-53` (`OpenNodeRepositoryOptions`),
  `index.browser.ts:42`, `index.default.ts`, `adapters/node/node-adapter.ts:27,71`,
  `adapters/browser/browser-adapter.ts:21,38`, `adapters/memory/memory-adapter.ts:21,67`,
  `repository/validate-options.ts`, `repository.ts:279,655` (fallback shape), docs page for
  options, `reports/api.json`.
- **Tests:** `object-caches.test.ts` (119 lines, 4 suites), `read-head-tree.test.ts` (`:171`,
  `:395`, `:420` rewritten), `validate-options` tests, entry-point tests, `pack-registry.test.ts`
  (`:2570-2596` entry-count assertions unchanged).
- **Gate:** the five test files + api.json regen. Could share a part with P1 (same seam) but the
  api.json diff is cleaner in two commits.

### P3 — Delta-base per-chain budget (D3; DC-4)

- **Files:** `object-resolver.ts` (`resolvePackChainWithDepth:471-531` loop `:504-519`;
  `splitHeader:659-682` `TextDecoder` removal under DC-4 b/c), `object-caches.ts:264-274`
  (`cacheDeltaBase` returns the verdict; new `DELTA_BASE_CHAIN_INSERT_FRACTION`).
- **Tests:** `object-resolver.test.ts` chain suites (`:1606-1900`), `object-caches.test.ts`.
- **Gate:** those two files. Depends on P1 (verdict) and P2 (budget field). Independent commit.

### P4 — HEAD reader and slot (D4; DC-5, DC-6)

- **Files:** new `src/application/primitives/internal/head-file.ts`; `internal/repo-state.ts`
  (`hasUsableHead:130-144` → `validateHead`; `isRefsLinkText`/`isValidHeadContent` stay);
  `ref-store.ts` (`resolveDirect:403-415` HEAD arm; `applySet:769`/`applySetSymbolic:777`
  invalidate on `HEAD_NAME`); `commands/internal/bootstrap.ts:77` (invalidate after the raw
  write). Port shapes used: `FileSystem.lstat/readlink/openWithNoFollow`, `FileHandle.stat/read/
  close` (`ports/file-system.ts:34-48, :118, :214`); `FileStat.mtimeNs/ctimeNs/ino/size`.
- **Tests:** `test/unit/application/primitives/internal/repo-state.test.ts` (matrix `:202-340`,
  `:184` deleted-HEAD), `ref-store.test.ts` (`:867` symbolic HEAD suite; the two call-list
  assertions that name `readUtf8` on `/HEAD`; new HEAD suites), new `head-file.test.ts`
  (fixtures: `buildSeededContext`, `instrumentedContext`, the no-dereference fixture at
  `fixtures.ts:325-331` for the symlink arm), `list-worktrees.test.ts` (per-worktree slot), new
  `test/integration/head-symlink-interop.test.ts` (twin-repo helpers from
  `interop-helpers.ts`).
- **Gate:** those files + the interop test (git-spawning: 60 s timeout, shared `beforeAll`).
  Must precede P5 (both edit `repo-state.ts`).

### P5 — Config epoch, worktree-scope check, one config read per ref update (D5; DC-1)

- **Files:** `config-read.ts` (`CachedConfigEntry:177-180` + `trusted`; `gateVerdictCache:279`;
  `memoizeGateVerdict:299-311`; `readConfigEntry:342-356`; `__resetConfigCacheForTests:365-369`;
  `invalidateConfigCache:389-393`; new `openConfigEpoch`), `internal/repo-state.ts`
  (`assertOperationalRepository:320-325`, `computeGateVerdict:305-309`),
  `config-scoped-read.ts` (`readSingleScope:148-166`; `isWorktreeScopeActive` moves here),
  `internal/config-scope.ts` (`isWorktreeScopeActive:52-76` removed; `resolveScopePath:83-112`
  takes the verdict), `update-config.ts` / `update-config-sections.ts` (callers of
  `resolveScopePath('worktree')`), `record-ref-update.ts:49-53`, `reflog-identity.ts:25-26`.
- **Tests:** `config-read.test.ts` (+ properties file untouched), `repo-state.test.ts` (`:110`,
  `:130` verdict cases), `config-scoped-read.test.ts`, `config-scope.test.ts` (+ properties),
  `record-ref-update.test.ts`, `reflog-identity.test.ts`, `config-interop.test.ts` (correction
  8 case); then the mechanical enumeration: `npm run test:unit`, add `invalidateConfigCache`
  where a gated command precedes a raw rewrite and a gate-less read.
- **Gate:** those files + `npm run check:architecture` (import cycle). Depends on P4.

### P6 — `packed-refs` single stat + pooled enumeration (D6, D7) *(2 commits)*

- **Files:** `ref-store.ts` (`loadPackedRefs:376-391`, `listRefs:561-569`, `packRefs:875-898`),
  `commands/reflog.ts` (`resolveTips:234-241`), `list-worktrees.ts:192-208`.
- **Tests:** `ref-store.test.ts` (`:339-475` packed suites, `:633`, `:885`, `:955`, `:1062`
  spread-ceiling suite), `list-worktrees.test.ts`, `reflog.test.ts` (`resolveTips`),
  `packed-refs-interop.test.ts` + `pack-refs-interop.test.ts` re-run.
- **Gate:** ref-store + list-worktrees + reflog unit files; interop re-run. Commit 1 (D6) has
  the fs-count oracle; commit 2 (D7) the in-flight oracle. Independent of P4/P5 in code; ordered
  after them only because `listRefs`'s HEAD candidate reads through the slot.

### P7 — `reflog expire` rule (D8; DC-7)

- **Files:** `commands/reflog.ts` (`runExpire:156-200`, `keepEntry:213-221`,
  `collectReachable:224-232`, `resolveTips` from P6); reads `readCommitMeta`
  (`internal/read-commit-meta.ts`, 31.1), `resolveRef(…, { peel: true })`, `readObject` for the
  non-commit check; `resolveExpiryCutoff` (`primitives/expiry-cutoff.ts`).
- **Tests:** `reflog.test.ts:742-1010` rewritten to the R-matrix; `reflog-interop.test.ts`
  (expire suites `:695-960`, `:1074`, `:1134`, `:1358`) extended with R1–R6′; `docs/adr/064`
  supersession note (docs phase).
- **Gate:** the two files (interop git-spawning). Depends on P6 for the pooled `resolveTips`.

### P8 — rev-parse sweep + `appendUtf8` (D9, D10) *(2 commits)*

- **Files:** `resolve-ref.ts:10-64` (`resolveRefOrMissing`), `commands/rev-parse.ts:61-77`,
  `commands/internal/commit-ish.ts:22`, `domain/refs` `refCandidates` (lazy);
  `adapters/node/node-file-system.ts:705-712`.
- **Tests:** `resolve-ref.test.ts`, `rev-parse.test.ts`, `commit-ish` tests,
  `node-file-system-injected.test.ts` (+ `node-file-system.test.ts` append cases).
- **Gate:** commit 1 primitives/commands tests; commit 2 adapter tests. Independent of every
  other part; last because smallest.

**Shared-commit guidance.** P1+P2 share a seam but not a gate (api.json twice); P6's two commits
share files and a gate but not an oracle; P8's two commits share nothing but size. Every other
part is independent by gate and by file, in the order above.
