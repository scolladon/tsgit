# Performance review — 2026-09-10

Deep review of `main` (1f84254c), every command, against the compromises recorded by the 2026-08 remediation (PR #285, `.claude/perf-review-2026-08-26.md`, `docs/design/perf-remediation-2026-08.md`) and its follow-ups (30.1–30.6).

Environment for every local number: Apple M3 Pro, macOS, Node 22.22.3, git 2.55.0, fixtures from `~/.cache/tsgit-bench` (medium = 5000 commits / 20 000 blobs / 10 041 trees, small = 50 / 200, delta-chain = 300 commits with 43-deep OFS chains). Reference numbers: CI nightly `bench.yml` run 34453177071 (2026-09-10, linux-x64, Node 24.20, EPYC 9V74).

Method: fresh `npm run profile` (13 workloads; it regenerated `docs/perf/baseline.json|md`, which now sit **modified and uncommitted** in the working tree — commit or discard deliberately), six `--cpu-prof` captures with full stacks for caller attribution, an fs-call counting shim (`--require`) with ordered path traces, a throwaway sync-I/O patch of a *copy* of the profile bundle as a hypothesis test, three real-git probes, and seven parallel code reviews (object reads / cold open, working tree, history walks, diff/merge/rewrite, network/pack/gc, refs/config/gates, adapters/domain).

Tiers: **M** measured (profile, trace, A/B, or micro-benchmark on the real construct) · **H** mechanism verified by reading code, cost unquantified · **S** speculative. Levels: L0 requirement · L1 architecture · L2 algorithm · L3 language.

Nothing here is a regression against #285. Every shipped mechanism is present and doing what it was designed to do; these are the next layer down, plus three places where a shipped fix is sized or wired so that it does not engage on the medium fixture.

---

## TL;DR

1. **The object closure re-walks every commit's whole tree.** `revList({objects:true})` over the medium fixture takes **39.3 s** on a warm handle with zero file reads; `git rev-list --objects` takes **0.11 s** (357×). The interesting side of `closure-engine.ts` has no seen-tree prune (the uninteresting side does), so it visits O(commits × tree entries) ≈ 10⁸ entries instead of O(distinct trees) ≈ 10⁴, and each of the 10 010 `walkTree` calls also re-`stat`s `.git/config` for `core.maxTreeDepth`. This is under `gc`'s reachability, `pack-objects`, `bundle-create`, `push` and `rev-list --objects`. Fix is ~20 lines. **[F1]**
2. **The floor under every small command and every cold path is libuv threadpool round-trips, not syscalls.** A `stat` costs 0.9 µs synchronous and 9.8 µs through `fs.promises`; a pread on a held handle 0.6 vs 10 µs. A throwaway patch routing *metadata* I/O synchronously (nothing else changed) measured: `openRepository` 0.87 → 0.32 ms, `revParse('HEAD')` 0.29 → 0.11 ms, the per-command gate 0.097 → 0.046 ms, a 43-deep delta chain 0.73 → 0.30 ms, warm `status` on 20k files 145 → 96 ms, cold open+read −29…−46 %. Git is synchronous here; isomorphic-git wins the cold-read bench (0.22×) by making 13 fewer calls, not by being faster per call. This is an L0 decision (event-loop blocking budget) before it is a diff. **[F2]**
3. **Two shipped caches are sized below the medium fixture and silently do nothing there.** The parsed-commit memo (1 MiB budget, 256 B floor ⇒ at most 4096 entries) thrashes on a 5000-commit walk: warm `log` is 21–30 ms at the default budget and **9.4–11.5 ms** once it fits (2.2×). The FlatTree LRU (1 MiB) refuses the 3.3 MB medium HEAD tree and `LruCache.set` returns silently; `status` re-flattens HEAD on every call (−8 % once it fits). **[F3, F11]**
4. **The nightly `status` number measures a broken stat-cache, not `status`.** `bench.yml` restores fixtures through `actions/cache` (tar), which changes ino/ctime; tsgit then re-reads and re-hashes every tracked file on every `status` forever because, unlike git's `refresh_index`, it never writes the refreshed stat data back. Reproduced locally: 145 ms on the generated fixture, **450 ms with 20 005 file reads per call** on a tar copy; real git rewrote its index on the same copy. The published 0.78× / 1.06× are this pathology (isomorphic-git hashes everything by design, so it reads as parity). **[F4]**
5. **The cold packed read still probes loose first and opens the pack three times.** The trace of open + one blob is 29 fs calls: `readdir(objects/xx)` precedes the pack lookup (the pack-first order believed shipped is not at this call site), two midx stats, stat + readFile of the `.idx`, header and `.rev` through path-based `readSlice` (open/read/close each), a path `stat` of the pack, then the persistent handle. The delta chain then issues one pread per level (44 for the 43-deep leaf) with no window cache. **[F5]**
6. **Merge, rebase, cherry-pick and revert are O(repo), not O(change).** Three full-tree flattens, a full merged-tree rewrite through `writeObject` (which deflates before checking existence), and a full re-walk in materialisation: the same 2-file merge costs 6.6 ms in a 2-file repo and 17.4 ms with 2000 unrelated files. Each rebase pick pays it again, serially. **[F7]**
7. **Three benches misprice their subject**: `merge.bench` builds the fixture inside `sut` (merge is 4.75 ms of the reported 47 ms); `checkout.bench` alternates an all-delete and an all-write workload (the ±48 % RME is the gap between them, not noise); `closure.bench` compares a commits-only walk against a full closure + deltify + pack write. **[Harness]**

---

## Baseline

CI nightly 2026-09-10 (linux-x64, Node 24, EPYC):

| Scenario | tsgit | isomorphic-git | ratio |
|---|---|---|---|
| readBlob, fresh open per call (cold LRU) | 1.501 ms | 0.324 ms | **0.22×** |
| readBlob, delta-chain leaf, cold pack | 4.742 ms | 1.639 ms | **0.35×** |
| readBlob, cold pack, small | 1.911 ms | 1.279 ms | **0.67×** |
| status clean, small / medium | 22.4 ms / 1746 ms | 17.6 ms / 1847 ms | **0.78×** / 1.06× (see F4) |
| status dirty, 25 modified | 2.73 ms | 10.3 ms | 3.77× |
| log medium (5000 commits) / same with commit-graph | 51.7 / 53.0 ms | 791 ms | 15.3× |
| readBlob cold pack, medium | 2.67 ms | 77 ms | 28.9× |
| clone 5-commit repo over http-backend | 31.0 ms | 32.0 ms | 1.03× |
| revParse HEAD / catFile HEAD / show HEAD / describe / name-rev | 0.51 / 0.17 / 0.94 / 1.1 / 1.1 ms | — | |
| checkout medium tip↔root, force / no-force | 3292 ms ±48 % / 4473 ms ±23 % | — | |
| merge (bench includes fixture build) | 47.3 ms | — | |
| add 2 files / 200 files | 6.5 / 62.3 ms | — | |
| commit, one staged file | 11.2 ms | — | |
| gc 3000 loose objects / deltify 3000 blobs | 2085 / 2214 ms | — | |
| fetchPack 8 × 200-deep chains (1600 objects) | 80.7 ms | — | |
| fsck 8000 objects, no artefacts / with .rev + .bitmap | 878 / 1037 ms | — | |
| commit-graph write, 5000 commits | 96 ms | — | |
| bundled inflate vs native, 1 MiB compressible | 15.6 ms vs 2.3 ms | — | 6.7× slower |

Local instrumented floors (`dist-profile` build, fs calls counted below the adapter):

| Operation | ms | fs calls | breakdown |
|---|---|---|---|
| openRepository (medium) | 0.87 | 13 | realpath×2, stat×8, readlink×1 (EINVAL on a regular HEAD), readFile×2 |
| open + readBlob cold (small / medium / delta-chain) | 1.73 / 2.53 / 2.94 | 29 / 29 / 72 | + readdir×2, stat×4, open×3, fh.read×3 (46 on the chain), readFile×1 |
| revParse('HEAD'), warm | 0.29 | 4 | lstat HEAD · readFile HEAD · **readFile HEAD again** · readFile refs/heads/main |
| catFile(HEAD), warm, object cached | 0.097 | 2 | lstat HEAD · readFile HEAD (the gate alone) |
| readBlob, warm | 0.002 | 0 | |
| log 5000 commits, iteration 1 / 2+ | 196 / 21–30 | 5263 / 6 | fh.read×4999 (one pread per commit), readdir×255 (loose fanout probes before every pack hit) |
| status medium, iteration 1 / 2+ | 225 / 145 | 21 153 / 20 102 | lstat×20 045, readdir×41, readFile×5, stat×11 |
| status medium, tar-restored copy, every iteration | 450 | 43 400 | + readFile×20 005, stat×3150 (re-hash of every file) |
| revList objects:true, medium, warm | **39 300** | 10 012 | stat .git/config ×10 010 |
| delta-chain leaf, byte cache disabled | 0.73 | 44 | fh.read×44 (one per level) |

Syscall micro-benchmarks (20 000 files of the medium fixture; a HEAD-sized file for reads):

| Primitive | `fs.promises` | synchronous |
|---|---|---|
| lstat, sequential | 10.7 µs | 1.4 µs |
| lstat, 32-wide pool | 3.9 µs | 1.35 µs (chunks of 512 + `setImmediate`) |
| stat / stat ENOENT | 9.8 / 13.2 µs | 0.9 / 0.6 µs (`throwIfNoEntry:false`) |
| readFile, 25-byte file | 80 µs (open + fstat + read + close, 4 hops) | 32 µs |
| pread 4 KiB on a held handle | 10.0 µs | 0.6 µs |
| readFile 1000 small files | 14.5 µs/file at a 32-wide pool | 37 µs/file serial — **sync loses on bulk reads** |

Sync-patched bundle (throwaway copy of `dist-profile`; `stat/lstat/readFile/readlink/realpath/readdir` → `*Sync` wrapped in resolved promises; pack `FileHandle.read` → `fs.readSync`; nothing else):

| Operation | default | sync-patched | Δ |
|---|---|---|---|
| openRepository | 0.87 ms | 0.32 ms | **2.7×** |
| open + readBlob cold small / medium / delta-chain | 1.73 / 2.53 / 2.94 | 1.23 / 1.41 / 1.60 | −29 % / −44 % / −46 % |
| revParse HEAD, warm | 0.290 | 0.112 | **2.6×** |
| catFile HEAD, warm (gate only) | 0.097 | 0.046 | **2.1×** |
| delta-chain leaf, cache disabled | 0.73 | 0.30 | **2.4×** |
| status medium, warm (16 MiB / 64 MiB caches) | 145 / 138 | 96 / 84 | −33 % / −42 % |
| log medium, warm (16 MiB / 64 MiB caches) | 21–30 / 9.4–11.5 | 20–27 / 9–11 | ~0 (CPU-bound) |

Fresh `--prof` self-shares that moved since the committed baseline: `log` parseObject 39 % + `ObjectId.from` 22 % (memo misses, F3); `status` lstat 39 %, flattenEntry+flattenLevel 12 % (F11), stepEntry 8 %; `blame` scanEntryAt 55 % + scanRawTreeFor 35 % (whole-directory scan — pinned faithful, see Verified healthy); `pack-read` now open-dominated (layoutRootsOf, tokenizeLine, NodeFileSystem constructor); `cat-file`/`rev-parse` are 80 % idle (I/O wait, F2/F6); `commit`/`add` resolveWrite 15–19 %, configMtimeKey 3–5 %.

---

## Open questions (L0 — the user decides; each gates a slice below)

1. **Event-loop blocking budget for metadata I/O (F2).** Git is fully synchronous. The Node adapter could serve stat/lstat/readlink/small-file reads/pread-on-held-handle synchronously (≤ ~30 µs each, ~30 ms total for a 20k-file `status` in 512-file chunks with yields) while keeping the async pools for bulk reads, where sync loses. Options: (a) default-on for the cheap/serial primitives; (b) opt-in `openRepository({ io: 'sync-metadata' })`; (c) stay async and only cut call counts (F5, F6), which recovers roughly half. Measured ceiling: 2–2.7× on every small command.
2. **`status` as a writer (F4).** Git's `refresh_index` writes refreshed stat data back under an optional lock. Making `status` do the same is faithful but changes a read-only command into an occasional writer; needs an ADR and a `RESOURCE_LOCKED` → skip-silently rule.
3. **Config freshness contract (F6).** `readConfig` stats `.git/config` on every *sequential* call so that a raw `ctx.fs.writeUtf8` past `invalidateConfigCache` is seen on the next read. A per-command epoch (one stat per gate) weakens that to "next command" and removes ~10k stats from the medium closure, 15 from a merge, one per `writeObject`. Is the "next read" contract published or a test convenience?
4. **Cache budgets (F3, F11).** `deltaCacheMaxBytes: 16 MiB` actually provisions ~33 MiB (delta-base cache is an additional full budget, parsed memo and FlatTree an additional 1/16 each) and the two derived caches are too small for a 5000-commit / 20k-file repo. Options: entry-bound the memo and give FlatTree its own option, or re-derive all fractions from one documented total.
5. **Index extensions (F13).** Every index write drops `TREE`/`UNTR`/`EOIE`. Writing them back is a faithfulness fix (one `tsgit add` currently destroys git's cache-tree) and the enabler for O(change) `commit` and untracked-scan pruning — but it is an L-sized slice with its own invalidation rules.
6. **gc's post-pack verify pass (F10).** `gc` re-reads and re-hashes every object it just packed; git does not. Keep as opt-in `{ verify: true }` or drop; either is an ADR line.

---

## Findings (ranked by estimated win / effort)

| # | Tier | Lvl | Axis | Finding | Est. win | Effort |
|---|---|---|---|---|---|---|
| F1 | M | L1/L2 | closure | Object closure re-walks every commit's tree; no seen-tree prune; config stat per walkTree | 39 s → ~0.2 s on medium; gc/pack-objects/push/bundle | S |
| F2 | M | L0/L1 | fs | Threadpool round-trips are the floor; sync fast path for metadata I/O | 2–2.7× every small command, −33 % status, −30–46 % cold reads | M + decision |
| F3 | M | L2 | caches | Parsed-object memo capped at ≤ 4096 entries; thrashes on ≥ 5k-commit walks | 2.2× warm log; grows with repo size | S |
| F4 | M | L1 | status | No `refresh_index` write-back; stat-invalid index re-hashes forever; CI bench measures it | 3× on tar/cp'd repos; honest CI number | M + ADR |
| F5 | M/H | L1/L2 | reads | Cold pack read: loose-first probe, pack opened 3×, path stat, per-level preads, all `.idx` forced sequentially on midx-less repos | −40 % cold reads; 2× delta chains; 11.7 → ~3 ms with 48 packs | M |
| F6 | M | L2 | gates/refs | HEAD read twice per command; config stat per sequential read; packed-refs exists+stat per ref; serial loose-ref enumeration; `config.get` re-parses local config | −30 % per-command floor; tag.list 104 → ~13 ms; branch.list 79 → 12 ms | S–M |
| F7 | M | L1 | merge | Merge family O(repo): 3 flattens + full tree rewrite + deflate-before-exists + full re-walk; picks serial and stat-cache-blind | flat cost for small changes; rebase N× | L (cursor) / S (rest) |
| F8 | M | L2 | index-pack | Per-entry zlib stream construction (17 µs, 8.8×); JS CRC32 70× slower than `zlib.crc32`; `bytesToHex` array+join | −25 % fetchPack; ~1.5 s off a 100k-object clone | S |
| F9 | H | L1 | fsck | Every object decoded twice, serially, with the delta cache disabled | ~2× fsck | M |
| F10 | M/H | L2 | packer | Non-rolling delta hash, no per-block val compare, no size prefilters (1.87× measured); double inflate > 16 MiB; serial deflate; push sends delta-free packs; gc verify pass | ~2× deltify; gc −40 %; push wire bytes | M |
| F11 | M | L2 | caches | FlatTree LRU refuses medium HEAD tree; `LruCache.set` drops silently; delta-base cache inserts every chain level; 33 MiB actual budget | −8 % status; budget honesty | S |
| F12 | H | L2 | walks | Commit-graph unused by merge-base / name-rev / bisect; generation numbers parsed, never read; `walkCommits` `shift()` O(n²); `blame -L` blames whole file | merge-base/describe on deep histories; blame -L | M |
| F13 | H | L1 | index | Index extensions dropped on every write (cache-tree/UNTR); commit rebuilds whole tree with nested pools; racy smudge missing; stat-cache unarmed outside `status` | O(change) commit; faithfulness | L |
| F14 | M | L2/L3 | browser/adapters | adler32 = 55 % of bundled inflate (10.6× available); per-entry `TsgitError` stack capture on expected misses; defensive full-buffer copies; limiter `shift()` cliff at ~20k tasks | bundled inflate ~2×; status −4 %; checkout at 50k files | S |

---

## Detail

### F1 — Object closure visits O(commits × tree entries) (M, L1/L2)

**Evidence.** `revList({wants:[HEAD], objects:true})` on the medium fixture: 39 298 ms warm (second iteration 38 505 ms, zero `fh.read` — pure CPU), 35 000 entries emitted, and **10 010 `stat .git/config`** calls. `git rev-list --objects HEAD` on the same repo: 0.11 s. The fixture has 5002 commits, 10 041 distinct trees, 20 040 blobs.

**Cause.** `src/application/primitives/internal/closure-engine.ts:224-226` → `emitTree` (`:121-139`) calls a full recursive `walkTree` per walked commit. `tryEmit`/`state.emitted` (`:245, :264-268`) dedupes at *emission*, but the traversal still descends every subtree of every commit. The uninteresting side already has the prune: `closure-not-marks.ts:60-61` (`if (seenTrees.has(treeId)) return`). Same shape in `enumerate-push-objects.ts:70`. Each `walkTree` also resolves `core.maxTreeDepth` through `readConfig`, whose sequential-call `stat` (F6) is the 10 010 stats. Git's `process_tree()` sets `SEEN` and returns; each distinct tree is expanded once.

**Fix.** Add `skipTree?: (id: ObjectId) => boolean` to `WalkTreeOptions`, checked before `enterTree` pushes a subtree frame; pass `(id) => state.emitted.has(id)` from `emitTree` and short-circuit `emitTree` when the root is already emitted. Hoist the `maxTreeDepth` resolution to one call per closure (or per `walkTree` caller). Replace `enumeratePushObjects` with `computeClosure({wants, not: haves, objects: true})` so `push` inherits the prune and the bitmap path.

**Cost.** None: the emitted entry for an already-seen tree is dropped by `tryEmit` today, so path / `nameHash` (first encounter wins, as in git) and emission order are unchanged; pack bytes identical. Reuses the existing `emitted` set.

**Risk.** A tree reachable under two paths keeps its first-encounter path — same as today and as git.

**Measure.** The scratchpad shape above (`revList objects:true` on medium), then `maintenance.bench` gc and a new closure bench of 300 commits × 2000-entry tree; expect linear-in-commits today, flat after.

### F2 — Threadpool round-trips are the per-command floor (M, L0/L1)

**Evidence.** The micro-benchmark and sync-patched tables above. `cat-file` and `rev-parse` CPU profiles are 80–83 % idle. Every `fs.promises` call is a libuv dispatch + threadpool hop + callback + promise resolution (~10 µs) regardless of the syscall's own cost (~1 µs for stat/pread on a warm cache). `fs.promises.readFile` is four such hops. isomorphic-git's 0.32 ms cold read is 13 fewer hops, not faster hops.

**Cause.** `src/adapters/node/node-file-system.ts` routes every port method through `fs.promises` (`realFsOps = fsPromises`); the per-command gate, ref resolution, config staleness stat, pack header/.rev reads and the delta chain are *serial dependency chains* of such hops, where nothing overlaps.

**Fix (after decision 1).** In `NodeFileSystem`, implement `stat`/`lstat`/`exists`/`readlink` with `fs.*Sync` (`throwIfNoEntry:false` for probes) returning already-resolved promises; `readUtf8`/`read` with `readFileSync` below a size threshold (~64 KiB — HEAD, refs, config, packed-refs, small `.idx`), async above; the pack `FileHandle.read` with `fs.readSync(handle.fd, …)`. Keep `boundedMapFor` pools for bulk reads (blob materialisation, add, diff), where async wins. For the `status` lstat sweep, batch synchronous lstats in chunks of ~512 with a `setImmediate` yield between chunks (measured 1.35 µs/file). The port contract is unchanged (Promise-returning).

**Cost.** Event-loop blocking of tens of µs per call; ~30 ms cumulative for a 20k-file status in chunks. Browser/memory adapters unaffected. Faithfulness: git is synchronous.

**Risk.** A slow network filesystem turns 10 µs sync calls into ms-long stalls; expose the threshold and the opt-out.

**Measure.** `rev-parse.bench`, `cat-file.bench`, `loose-read.bench` (fresh-open scenario), `delta-chain-read.bench` cold, `status.bench` — main vs branch absolute wall-clock.

### F3 — Parsed-object memo holds at most 4096 commits (M, L2)

**Evidence.** `--cpu-prof` of the `log` workload: `parseObject` 39 % inclusive with `LruCache.set` frames present on iterations that should be memo hits. `ObjectId.from` 6.4 % (called from `parseRequiredFields`, i.e. re-parse). A/B with the memo budget quadrupled: warm log 21–30 ms → 9.4–11.5 ms.

**Cause.** `src/application/primitives/internal/object-caches.ts:81, :92, :149-171` — budget = `deltaCache.maxSize × 0.0625` = 1 MiB; `parsedObjectByteSize` adds a 256 B fixed overhead per entry, so the entry cap (65 536) never binds and the byte cap admits ≤ 4096 commits. A 5000-commit walk in the same order every time is the worst LRU case (sequential scan larger than the cache ⇒ ~0 % hits). The module's own fraction sweep was taken on exactly this fixture, i.e. on the wrong side of the cliff.

**Fix.** Bound the memo by entries, not bytes: `maxEntries = min(65_536, deltaCache.maxSize / 64)` (16 MiB ⇒ 262k… cap at 65k) with the byte fraction raised to a safety valve (¼). Alternatively give it its own option.

**Cost.** ~4–5 MiB retained for 16k parsed commits. Same bytes are already resident in `deltaCache` as raw objects.

**Measure.** `log.bench` medium; re-run the fraction sweep on the *large* fixture.

### F4 — `status` never writes back a refreshed index (M, L1, needs ADR)

**Evidence.** Local: original fixture 145 ms / 0 file reads per warm status; `tar` copy of the same fixture 450 ms with `readFile×20 005` + `stat×3150` per status, every iteration. Real git on the tar copy: `.git/index` mtime changed after one `git status` (1788522122 → 1789063520). `.github/workflows/bench.yml:25-29` restores `~/.cache/tsgit-bench` via `actions/cache@v6` (tar), so every cache-hit nightly measures this state. Internal control: the `status-dirty` bench (index written by tsgit's own `add`, stat-cache valid) reads 3.77× vs isomorphic-git; clean status (git-built, tar-restored) reads 0.78–1.06×.

**Cause.** `isEntryStatClean` → `matchesContentStat` requires mtime, ctime, ino, uid, gid, size — the same fields as git's `match_stat_data`. Git then writes the refreshed entries back (`refresh_index` + optional lock); `status.ts:125-171` has no `acquireIndexLock`, so a stat-invalid entry stays invalid forever and every `status` re-reads + clean-filters + SHA-1s the file. Every re-hash also runs `resolveFilterDriver(…, {eagerSectionValidation:true})`.

**Fix.** Collect entries whose content compare said "clean but stat-stale", rebuild via `indexEntryFromStat` with the stat in hand, and when at least one moved: `acquireIndexLock` + `commit` best-effort, swallowing `RESOURCE_LOCKED` (git's optional lock; `--no-optional-locks` opts out). Add `refresh?: boolean` on `StatusOptions` defaulting to git's default (on). Also memoise the "no `.gitattributes` anywhere" verdict once per status so the re-hash path is not paying per-file filter resolution.

**Cost.** `status` becomes an occasional writer. Index bytes change only in per-host stat fields (already `equivalent-under-readback`).

**Harness.** Until this lands, the CI clean-status rows are not a `status` measurement. Add a bench variant that tars the fixture into scratch and runs status twice.

**Measure.** `status.bench` medium after the fix: iteration 2 collapses to the lstat-only pass.

### F5 — Cold packed read shape (M/H, L1/L2)

**Evidence.** Ordered trace of open + one blob (small): after the 13 open-time calls — `stat multi-pack-index`, `stat multi-pack-index-chain`, **`readdir objects/aa`** (loose fanout, before any pack), `readdir objects/pack`, `stat pack.idx`, `readFile pack.idx`, `open pack` (header via path `readSlice`), `stat pack` (size for the offset table), `open pack.rev` (path `readSlice`), `open pack` (persistent handle), `fh.read`×3. The delta-chain leaf then does `fh.read`×44 (one per level; 0.73 ms with the byte cache disabled, 0.30 ms with sync preads). The `log` iteration 1 shows `readdir`×255 — every fanout dir is listed before its pack hit. Cold open with 48 packs and no midx: 11.7 ms vs 2.6 ms with midx (CI).

**Cause.**
- `object-resolver.ts:86` (`tryLoose`) runs before `:95` (`registry.lookup`). The shipped "pack-first" fix is the readdir-backed membership cache, which lowers the *warm* cost; the cold order is still loose-first. Git's `do_oid_object_info_extended` is pack-first.
- `pack-registry.ts:448-457` `headerMemo` reads the 12-byte header via `ctx.fs.readSlice(packPath, …)` (open + read + close) instead of the pack's own `handleMemo`; `buildOffsetTable` (`:461`) does `ctx.fs.stat(packPath)` for `.size` where `handle.stat()` (fstat) is available; `pack-artefact-source.ts:110` loads `.rev` through path `readSlice` too.
- `pack-generation.ts:115-134` `resolveIndexes` forces *every* pack's `.idx` (stat + full read + parse) sequentially before the first lookup on a midx-less repo; `lookupViaIndexedSnapshot` (`pack-registry.ts:800-812`) then early-exits on the first hit anyway.
- `collectDeltaChain` (`object-resolver.ts:332-430`) reads one entry per level through `readSlice`; no window cache (git's `use_pack` mmaps 32 MiB windows; iso-git slurps the pack).
- `midx-source.ts:133, :249`: two sequential ENOENT stats per session that the `objects/pack` listing already answers.
- `pack-registry.ts:364-378` `readBoundedIdx`: `stat` then `read` then the identical size check again.

**Fix.** Swap the two arms in `resolveObjectBytesWithDepth` (pack first, loose on miss — git's order, faithfulness-positive); route header and `.rev` through the held handle and take the size from `fstat`; derive midx/.rev/.bitmap presence from the `readdir` listing; make `lookupViaIndexedSnapshot` lazy per pack like `lookupViaUnclaimedPacks` already is, and bound-parallel `resolveIndexes` for the bulk consumers; add a per-`RegisteredPack` window LRU (e.g. 4 × 1 MiB, keyed `offset >>> 20`) under `readSlice`, cleared with the delta-base cache.

**Cost.** Loose-only repos pay one `readdir(objects/pack)` ENOENT (~13 µs) they already pay via the midx probe. Window cache: bounded explicit memory per touched pack.

**Measure.** `loose-read.bench` fresh-open, `pack-read.bench` cold arms, `delta-chain-read.bench` cold, `midx-lookup.bench` no-midx arm.

### F6 — Per-command gate and ref/config I/O (M, L2)

**Evidence.** `revParse('HEAD')` warm = `lstat HEAD`, `readFile HEAD`, `readFile HEAD`, `readFile refs/heads/main` (0.29 ms; 13 libuv hops). `catFile` warm = `lstat HEAD` + `readFile HEAD` (0.097 ms) — the gate is the whole cost when the object is cached. `status` small trace: `stat .git/config` twice, `stat .git/index` twice, `readFile HEAD` twice. Reviewer traces: `tag.list` with 2000 packed tags = **6005 fs calls, 104.6 ms** (`git tag -l`: 13 ms incl. fork) — per packed ref: loose `readUtf8` ENOENT + `exists packed-refs` + `stat packed-refs`; `branch.list` with 1000 loose branches = 79 ms sequential vs 12–14 ms through a bounded pool; `config.get` = 9 fs calls every call incl. a full read + INI parse of `.git/config`; `branch.create` = 16 fs calls incl. two back-to-back `stat .git/config`; the medium closure = 10 010 config stats.

**Cause.**
- `repo-state.ts:130-144` `hasUsableHead` reads HEAD for the gate; `ref-store.ts:393-415` reads it again for the command. Git's `validate_headref` + `resolve_ref` open HEAD once.
- `config-read.ts:230` `coalescedMtimeKey` merges only *concurrent* stats; every sequential `readConfig` (48 call sites, incl. `write-object.ts:34` per object, `resolve-max-tree-depth` per `walkTree`) pays one.
- `ref-store.ts:376-391` `loadPackedRefs`: `exists` then `stat` (both are `stat`); `:561-570` `listRefs` resolves packed-only names through the loose miss path sequentially even though `collectCandidateNames` already holds the packed entries with oids.
- `config-scope.ts:52-76` `isWorktreeScopeActive` re-reads and re-parses `.git/config` outside every cache.
- `record-ref-update.ts:39-53`: two `readConfig` calls per ref update; `node-file-system.ts:705-712` `appendUtf8` runs `mkdir -p` before every append (15 µs vs 57 µs for the append).

**Fix.** Make the ref store the sole HEAD reader with a one-slot cache keyed on the gate's `lstat` `(mtime, size, ino)` so the "notice an external rewrite" contract holds verbatim; collapse `lstat + readUtf8` into `openWithNoFollow` where the port already has it. Per-command config epoch refreshed by `assertOperationalRepository` (decision 3), or minimally fold the duplicate reads in `recordRefUpdate` and hoist `core.looseCompression` out of `writeObject`. `loadPackedRefs`: one `stat` with `FILE_NOT_FOUND → EMPTY`. `listRefs`: take packed-only oids from the snapshot, resolve loose names through `boundedMapFor`, sort after. `isWorktreeScopeActive`: read through `readSingleScope('local')`. `appendUtf8`/`write`: attempt first, `mkdir` + retry on ENOENT.

**Cost.** The epoch weakens config freshness from "next read" to "next command" (decision 3). Everything else is faithfulness-neutral.

**Measure.** fs-call counts on `revParse`, `catFile`, `branch.create`; a new `tag-list.bench` at 2k/10k packed tags and `branch.list` at 1k loose.

### F7 — Merge family is O(repo) (M, L1)

**Evidence.** Reviewer measurement, same 2-file non-ff merge: 2-file repo 6.62 ms / 127 fs ops; +500 unrelated files 8.69 ms / 176 ops; +2000 unrelated files (40 dirs) 17.36 ms / 317 ops — ≈ 5.4 µs and 0.095 fs ops per unrelated file. The extra ops match `41 dirs × (stat + mkdir + open …)` from `writeObject`. The merge bench's 47.3 ms is 20.6 ms fixture build + 4.75 ms merge (see Harness).

**Cause.** `merge.ts:326-345` flattens all three trees; `three-way-tree.ts:43-56, 513-526` builds union sets over every path; `synthesiseMergedTree` (`merge.ts:376-382` → `writeLeafTrie`) rewrites every directory tree; `materialize-tree.ts:90-97` re-walks the whole merged tree against the whole index. `apply-merge-to-worktree.ts:291-322` is the same shape per rebase/cherry-pick/revert pick, and its writes are two plain `for … await` loops (`:376-391`) while `merge.ts:625-652` pools them. `find-would-overwrite.ts:113-122` is serial and never passes `indexMtime`, so it reads + hashes every touched file (the stat cache is armed only from `status` — `compare-working-tree-entry.ts:107`). `write-object.ts:34-53` deflates before probing existence (git's `check_and_freshen` probes first) and `mkdir`s the fanout dir on every write. `three-way-tree.ts:513-526` awaits content merges one at a time (the `reserved`-name ordering is the only blocker; classify first, pool the content arm).

**Fix.** Short-term (S): `writeObject` early-return on `probeLooseOid || registry.lookup` before deflate, `mkdir` only on ENOENT; thread `index.indexMtime` into `compareWorkingTreeEntry` for `findWouldOverwrite`, `rm`, `stash`, `applyMergeToWorktree`; pool the two write loops in `apply-merge-to-worktree` exactly as `merge.ts` does. Structural (L): replace the three flattens with a three-way raw-tree cursor merge-join (the ADR-514 cursor machinery exists): at each directory, if `base === ours` emit theirs' subtree oid verbatim and do not descend, symmetrically, and skip when all three agree; carry surviving subtree oids into the merged-tree build so `writeLeafTrie` writes only changed directories; pass the changed-path set to `materializeTree`'s existing `paths` scope. This is merge-ort's `collect_merge_info_callback`; emitted oids are identical by construction.

**Cost.** Structural half is the largest change in this review. Faithfulness improves (subtree reuse by oid serialises to the same bytes).

**Measure.** A scaled merge bench: same 2-file change over 0 / 500 / 2000 / 20 000 bulk files, assert a flat slope; a cherry-pick bench with a 300-file pick.

### F8 — index-pack per-entry costs (M, L2)

**Evidence (reviewer micro-benchmarks, Node 22.22.3).** `NodeCompressor.streamInflate` = `createInflate()` + 3 listeners + promise + per-chunk copy per call: 20.5 µs at 500 B, 46.9 µs at 32 KiB; `zlib.inflateSync(tail, {info:true})` = 2.33 µs at 500 B and returns `engine.bytesWritten` = exact compressed bytes consumed (verified byte-exact incl. trailing garbage; truncation still `Z_BUF_ERROR`, cap still `ERR_BUFFER_TOO_LARGE`). Called once per entry from `pack-byte-source.ts:73, :389` → ≈ 21 ms of the 80.7 ms fetchPack bench, ~1.3–1.7 s per 100k-object clone. `crc32.ts:16-22` byte-at-a-time table loop: 76.7 ms per 32 MiB vs 1.1 ms for `zlib.crc32` (Node ≥ 22.2, identical output) — over every byte of every received and written pack. `bytesToHex` (`encoding.ts:5-13`): array-of-20 + `join`, 0.211 µs/oid vs 0.095 µs for string accumulation; called per tree entry, per index lookup, per commit-graph oid.

**Fix.** `streamInflate` → `inflateSync` with `{info:true, maxOutputLength}` below a size gate mirroring ADR-735 (keep the stream arm for large members); add `crc32` to the `Compressor` port, `zlib.crc32` on Node, the JS loop (or a slice-by-4) as the memory/browser implementation; `bytesToHex` → `s += HEX[b]` accumulation (portable; skip the 65k pair table for the browser bundle). `pkt-line.ts:85-95` `parseLength`: nibble arithmetic instead of TextDecoder + regex + parseInt.

**Cost.** None observable; bit-identical outputs. `streamInflate` sync arm blocks the loop for the member's duration — same posture as `inflate`.

**Measure.** `fetch-pack.bench`, `clone-small-repo.bench`, `fsck-artefacts.bench`.

### F9 — fsck reads everything twice, serially, cache disabled (H, L1)

`fsck.ts:66, :85-89, :102-105`: `auditCtx` carries `createNoDeltaCache()`; `buildObjectCache` reads + parses all N objects (full inflate incl. blob bodies, to project `{type}`), then `runContentValidationPass` reads all N again raw; both loops are `for … of await` with no pool; iteration is oid order, not pack order, so a delta chain is re-inflated from its base twice per object. Git's `verify_packfile` walks in pack order and consults `delta_base_cache`. **Fix:** one pass — raw bytes once per object (pack-offset order where the registry can give it), hash for the content pass, parse into the projection, drop the bytes; keep a private bounded delta-base cache (isolation is about the *opening* Context's cache, not about having none); fold findings in universe order. The +160 ms for `.rev` + `.bitmap` on the CI row is within two reviewers' independent pricing of ~1 ms and likely nightly noise (~12–18 % resolution) — re-run interleaved before chasing it. **Measure:** `fsck-artefacts.bench` no-artefact arm.

### F10 — Packer and gc (M/H, L2)

- `delta-encode.ts:178-184, :286, :372-395`: `hashBlock` recomputes a 16-byte FNV per target byte instead of rolling (git's Rabin `T[]/U[]` roll = 2 lookups/byte); `DeltaIndex` (`:41-49`) stores no block hash value, so every chain member gets a full `evaluateCandidate` (git: `if (entry->val != val) continue`); `deltify.ts:196-215` lacks git's two O(1) `try_delta` size filters and builds the index eagerly on admission (`:344`). Reviewer port of the scan loop on the bench shape (3000 × 2560 B, window 10): 1015 ms / 33.8 µs per pair with zero hits → 543 ms / 18.1 µs rolling + val compare (1.87×); hash portion 12.6 → 3.4 µs. Changes delta *bytes* (permitted) toward git's own hash. Every `Stryker disable … equivalent` in `delta-encode.ts` must be re-proven.
- `deltify.ts:127-131` inflates every object for `(type, size)` (full inflate on loose), keeps ≤ 16 MiB of content, re-inflates the rest at `:428`; emission loop `:458-462` is strictly sequential, so the > 16 KiB async `deflate` gate occupies one threadpool slot at a time.
- `push.ts:353` `buildPack(ctx, {objects})` — no `delta: true`, while advertising `ofs-delta`; every other producer passes it. Plus three full pack-sized buffers resident (pack, request body, transport).
- `gc-pipeline.ts:994-1001`: after writing, re-reads + re-hashes the whole reachable set with `verifyHash: true` — git's `prune-packed` only does an index lookup (decision 6).
- `clone.ts:284-309`, `fetch.ts:311-323`: one ref transaction per advertised ref (git: one `ref_transaction`).

**Measure.** `deltify.bench`, `maintenance.bench` gc, a new push bench over `http-backend-server`.

### F11 — Cache sizing and honesty (M/H, L2)

- `read-head-tree.ts:50, :68-74, :112-118`: FlatTree budget 1 MiB; `flatTreeByteSize` = 164 B × 20 000 = 3.3 MB for medium; `lru-cache.ts:96-98` returns silently on over-cap. Break-even ≈ 6 400 tracked files. Status −8 % when it fits (measured 145 → 138 ms). **Fix:** own budget option or fraction 0.5; make `LruCache.set` return whether it stored (or count refusals) so a dead cache cannot recur silently.
- `object-resolver.ts:506-519`: the unwind loop inserts one full-size intermediate per chain level into the delta-base cache — a depth-43 chain over a 400 KB target pushes ~17 MB through a 16 MiB LRU in one read, evicting its own earlier levels; `:528-529` then copies the content again to prepend a loose header for `deltaCache`. `pack-registry.ts:639-642` sizes the delta-base cache at the *full* `deltaCache.maxSize` (the code comment says "shared budget"), so `deltaCacheMaxBytes: 16 MiB` provisions ~33 MiB. **Fix:** budget per-chain inserts (nearest-the-base levels first, ≤ ¼ of the cache); store `{type, content}` and drop `prependHeader`/`splitHeader` round-trips; document or fold the 2× budget (decision 4).

### F12 — History walks (H, L2)

- `merge-base.ts:24-38`, `bisect-midpoint.ts:17-22`, `name-rev.ts:55, :126-129` read + parse full commit objects for parents + date only; `commitHeader` (graph) has two callers (`walk-commits.ts:80`, `commit-date-walk.ts:176`). Git's `parse_commit_in_graph` serves these from the graph with no object read. `CommitHeader.generation` is produced (`read-commit-graph.ts:37, :303`) and never consumed — no `min_generation` cutoff in `paint_down_to_common`-equivalent code. **Fix:** a shared `readCommitMeta(ctx, id)` = graph first, `readObject` + graft fallback; generation cutoff in merge-base / name-rev gated on graph presence (changes visited set only, git's own mechanism — pin against `git merge-base` with and without a graph).
- `walk-commits.ts:110` drains the frontier with `queue.shift()` — the O(n²) `bitmap-binding.ts:204-209` was fixed for; backs `revList --objects`, `gc`, `log --first-parent`. Keep `MAX_WALK_QUEUE_SIZE` on `length − head`.
- `blame.ts:169, :256-271`: `-L` seeds the whole file and filters at the end; git seeds one `blame_entry` over `[bottom, top)`.
- `commit-date-walk.ts:114-121, :145-162`: `Promise.allSettled` fan-out + step object + closure per commit even for a single parent — reviewer scaffold model 1.55 → 1.19 µs/commit (~7 % of log).
- `closure-engine.ts:211-227` buffers every walked `Commit` (messages included) to run `markBoundaryTrees`, which reads only `id` and `tree`.
- `whatchanged.ts:54-71` awaits the tree diff inside the walk loop, stalling the read-ahead; `range-diff.ts:66-104` holds every patch's blob content for both series.
- `name-rev.ts:58-60, :68-84` serial across refs and parents; `loadShallowSet` awaited per expanded commit.

### F13 — Index extensions, commit, checkout (H, L1)

- `index-lock.ts:121-137` serialises `extensions: []` on every commit — cache-tree (`TREE`), untracked cache (`UNTR`), `EOIE`/`IEOT` are dropped by all 18 writers. Faithfulness: one `tsgit add` destroys git's cache-tree. Perf: blocks O(change) commit and untracked-scan pruning.
- `commit.ts:411-459`: rebuilds and rewrites every directory tree from the index on every commit (git's `cache_tree_update` skips unchanged subtrees); `boundedMapFor` minted at every recursion level (32^depth in flight); `[head, ...rest]` destructure per path segment. Compounds with `writeObject` deflate-before-exists (F7).
- `index-writer.ts:100-140`: no racy-clean smudge (`ce_smudge_racily_clean_entry`) — a same-second same-size rewrite is reported clean forever on second-resolution filesystems (memory/browser adapters, FAT/network). Correctness, not just perf.
- `write-working-tree-file.ts:26-39, :128-142`, `apply-changeset.ts:186-209`, `node-file-system.ts:672-684`: per checked-out file: `lstat` (always-miss on the add direction, throwing a stack-capturing `TsgitError`), `mkdir -p`, a `pipeline` + `WriteStream` for a 2.5 KB blob, `chmod` + its leaf `lstat`, then a path `lstat` for the index entry — 8 syscalls vs git's `open(O_CREAT|O_EXCL, mode)` + `write` + `fstat` + `close`. Reviewer measurement at 2560 B, conc 32: 95.3 µs vs 71.3 µs git-shaped. **Fix:** `mode` on `FileSystem.write`; return the post-write `fstat`; buffered write below ~1 MiB.
- `compare-working-tree-entry.ts:107`: `indexMtime` (the stat-cache arm) is passed only by `status`; `rm.ts:138`, `stash.ts:156`, `find-would-overwrite`, `apply-merge-to-worktree` read + hash everything. `stash.ts:145-193` is additionally fully sequential and hashes + writes every untracked file inline.
- `add.ts:143, :182-193, :488, :528`: literal-path add lstats each path three times and stages serially (no bench covers this path).
- `status.ts:142-146`, `index-diff.ts:71-106`, `compute-changeset.ts:44-55`: three Maps + two Sets of n over already-sorted sequences (a merge-join needs none); `computeChangeset` sorts without `comparePaths` (UTF-16 order, a faithfulness nit); `matcher-stack.ts:53-57` allocates per ignore match and scans forward without early exit (git scans backward and breaks); `ancestorsOf` O(depth²) allocations per walked entry.

### F14 — Adapters and domain primitives (M, L2/L3)

- `adapters/adler32.ts:13-21`: `for…of` + two `%` per byte = **55.2 % self time** of the bundled inflate decoder (`--cpu-prof`, 4 MiB text); 111 MiB/s vs 1177 MiB/s with the NMAX=5552 deferred-modulo loop (10.6×). Bit-identical. Should halve the 1 MiB bundled-inflate gap to native. Ship with `inflate.ts:38, :340-359` `GrowableBuffer` presized from the declared entry size (0.68 → 0.34 ms at 8 MiB).
- `domain/error.ts:84-90` + `node-file-system.ts:251-295`: `TsgitError` = 2.1 µs per construction (0.22 µs with `stackTraceLimit = 0`); a clean `status` constructs 200–400 of them (one per directory: `loadCappedUtf8` → `lstat(dir/.gitignore)` ENOENT), measured 4–5 % of status. Same at the loose-object probe miss, loose-ref misses, hook probes. **Fix:** `tryLstat` / `tryReadUtf8` port methods (the `exists` shape already catches before `mapErrno`).
- `node-file-system.ts:634` `new Uint8Array(await readFile(real))` copies; `readFile` returns an exact-fit own-ArrayBuffer Buffer, so a view is a strict win. `node-compressor.ts:168, :196, :277` copy inflate output (≤ 16 KiB outputs are views into a 16 KiB `_outBuffer`, so gate the view on `byteLength === buffer.byteLength`). `pack-registry.ts:496` zero-fills the hot `readSlice` buffer while the fallback uses `allocUnsafe`.
- `concurrency-limiter.ts:33` drains waiters with `shift()`; `apply-changeset.ts:358` and `add.ts:246` enqueue every item synchronously, so the queue reaches N − 32: 40k tasks at limit 8 = 498 ms vs 21 ms with a head cursor (23×; cliff ≈ 10–20k files).
- `read-gitattributes.ts:109-119`: per-directory cache stores values not promises, so the 32-wide diff fan-out issues 322 `lstat`s where 11 suffice (same class as the FileHandle memo fixed in #263).
- `blob-source.ts:88-99, :188-207, :231-238` reads `deltaCache` but never populates it, so `streamBlob`, the whitespace drop-pass and merge's content path re-inflate on repeat. The loose-vs-packed 1.8× on the whitespace bench is 4 vs 2 threadpool tasks per blob (open + 2 reads + close vs one pread) — not an exists probe; the lever is F2/F5, not the loose path.
- `browser-file-system.ts:263-280, :27-34`: `walkToParent` re-resolves every segment from the root per call; `readSlice` re-resolves + `getFile()` per slice (a depth-10 chain = 50 round-trips); no `createSyncAccessHandle`. `browser-hash-service.ts:64-70, :39-52`: per-byte `toString(16).padStart` hex; streaming hasher copies every chunk twice. Unmeasured on a real browser (no host here).
- `has-object.ts:15-17` bypasses the fanout cache (`exists` = a stat per call in loops); `resolve-oid-prefix.ts:29-40` `exists` + `readdir` and per-call `RegExp`s.
- `tree.ts:67-108` (`parseTreeContent`, now only behind the public `readTree`): whole-body copy + a `TextDecoder` for the mode where the cursor's byte-octal path exists.

---

## Harness honesty

- **`merge.bench.ts:27`** builds the scratch repo inside `sut`: merge is 4.75 ms of the reported 47.3 ms. Pre-build a pool of scratches; measure only `merge.run()`.
- **`checkout.bench.ts:66-70, :91-98`** alternates tip→root (~20k deletes, 2 syscalls each, no object reads) and root→tip (~20k writes, 8 syscalls + inflate each). The ±48 % is the gap between the two modes; a real regression in the write wave is invisible. Split into two scenarios with a non-measured reset; the file header's "mixed changeset" fixture is still unbuilt.
- **`closure.bench.ts:72-96`**: `revList` = commits-only walk, no write; `packObjects` = full closure + deltify + pack write. Not a tier comparison. Add a direct `computeClosure({objects:true, tier})` pair; `assertClosureAnsweredByBitmap` already builds the call.
- **`status.bench` on CI** measures the tar-restored stat-invalid state (F4). Add a tar-copy variant and a fresh-fixture variant so both are visible.
- **`add.bench`** covers only `{all:true}`; the literal-path arm (3 lstats/file, serial) has no coverage.
- **`fsck-artefacts.bench`** +160 ms for `.rev` + `.bitmap` is within nightly resolution; re-run interleaved before designing.
- **`log` with commit-graph = parity** is expected for a full `log` (git reads each commit body too); the graph's value is in merge-base / describe / name-rev / rev-list (F12), none of which use it yet.
- **`profile` workloads**: `pack-read` is now `openRepository`-dominated (its 8000 fresh opens make it the cold-open profile, which is useful — rename it, or add an explicit open-only workload). `docs/perf/baseline.*` regenerated this session, uncommitted.
- **CI per-op cost is ~2× local** for the same 13 libuv ops (0.506 vs 0.29 ms revParse). Op count is the portable lever; absolute wins from F2 will differ on Linux — confirm with `strace -c` on the runner.

---

## Verified healthy (checked, nothing to do)

- Facade construction (~122 closures) ≈ 10 µs of the cold open; `openRepository` touches no object store, packed-refs or index.
- `verifyHash: false` is hash-free on every arm; `parsePackIndex`, `parseObject`/`splitObject`/`parseBlobContent` are zero-copy; `resolveRead` is 0.05 µs and syscall-free; `bigint` stats cost +7 % of a stat and the nanoseconds are consumed (faithfulness); `deriveLimits` reads `UV_THREADPOOL_SIZE`.
- The gate verdict memo, `coalescedMtimeKey` (concurrent case), `listWorktrees` shared `mainCtx` (ADR-722), parent-realpath LRU (zero `realpath` in a warm `branch.create`), `assertWritableLeaf` no-op on POSIX, `refsWalkRoot` prefix push-down, `listRefNames` never opening loose refs.
- `BinaryHeap`, the byte-level commit parser (message decode 0.045 µs/commit — laziness would not pay), `emitInArtefactPositions`, `reconstructEntry`, `rev-list`'s tier default, `packPositionMap` (0.73 ms at 8k; `Float64Array` changes nothing), the `.rev` lazy successor lookup (two reviewers priced it at 39–105 ns vs 60 ns — ≤ 1 ms at 8k objects either way).
- `blame`'s whole-directory scan is **pinned faithful**: real git 2.55 refuses `rev-parse <tree>:aaa` when a `10064a`-mode sibling follows the match (probed both orders this session). No early-exit is available; the remaining blame cost is that scan and is small in absolute terms (4 ms / 500 commits).
- `mergeTrees` trivial-merge short-circuits, rename detection's algorithmic core (exact pass, size reject, spanhash once per oid, 4 candidates per dst, limit² guard), `buildContentMerger` (three reads under one `Promise.all`), `archive` (lazy, not materialised), `isBinary` 8000-byte window, `grep` matchers compiled once, the loose-oid fanout cache, `assertNoPendingOperation` under one `Promise.all`.
- `PktBuffer` is O(n) on byte-drip (copyWithin fix landed); fsck's object cache retains projections, not blob bytes; index-pack pass 2 pops parents as their last child resolves; `sortPackIndexEntries` on a `Uint32Array` permutation (44 ms / 200k, optimal); delta index built once per window member and reused; one delta direction only; transport middleware per request; sideband demux zero-copy; hashing native with an incremental hasher on receive; `NodeCompressor` deflate level = zlib default 6 = git's `core.compression` default.
- `walkWorkingTree` explicit stack + lazy stat; `.gitignore` probed per directory; `readIndex` cache with three layered guards; `applyChangeset` drain-before-rethrow; `createLeadingPathScanner` single-flight; `statOnlyVerdict` size fast-path; `readFileAt` resolves a single path without index or flatten.

---

## Not measured

- Browser/OPFS and the bundled decoder on a real browser (no host); the adler32 finding is measured on Node running the same code.
- Windows (`honoursNoFollow` / `honoursRenameKinds` false arms).
- Linux absolute numbers for F2 (ratios transfer; CI per-op cost is ~2× local — see Harness).
- The large fixture (50k commits) — F1 and F3 extrapolate from medium; F1's 357× will grow with commit count.
- Real-network transport; push has no bench at all.
- Memory (RSS) on clone/fetch beyond the 30.5 receive path; the reviewer notes on `range-diff` and `push` residency are H.

---

## Suggested delivery slices

1. **Closure prune + config hoist (F1)** — one PR, no ADR; the largest absolute win in the review and the smallest diff. Ship first and re-run gc/pack-objects/push benches.
2. **Quick wins, no ADR** — F3 memo entry cap; F11 FlatTree budget + observable `LruCache.set`; F6 single HEAD read, packed-refs single stat, packed-only oids from the snapshot, pooled loose enumeration, `isWorktreeScopeActive` through the cache, folded `recordRefUpdate` reads; F8 `inflateSync {info:true}`, `crc32` port method, `bytesToHex`, `parseLength`; F14 adler32 + GrowableBuffer presize, limiter head cursor, `walkCommits` head cursor, `.gitattributes` promise memo, `blob-source` cache populate, `tryLstat` for `.gitignore` probes; F7-S `writeObject` probe-before-deflate + `mkdir` on ENOENT, stat-cache arming outside `status`, pooled writes in `apply-merge-to-worktree`.
3. **I/O shape (after decision 1)** — F2 sync metadata fast path; F5 pack-first order, held-handle header/.rev/fstat, presence from listing, lazy per-pack `.idx`, pack window cache.
4. **`status` refresh write-back (decision 2, ADR)** + the bench fixture variants.
5. **Merge/rebase cursor descent (F7-L)**.
6. **Index extensions + cache-tree commit + racy smudge + checkout write shape (F13, decision 5, ADR)**.
7. **Commit-graph consumers + generation cutoffs + `blame -L` (F12)** with interop pins against `git merge-base` / `git name-rev` with and without a graph.
8. **Packer: rolling hash + val compare + size filters, header-only sizing, pooled deflate, push deltas, ref batching (F10, decision 6)** — re-prove every equivalent-mutant note in `delta-encode.ts`.
9. **fsck single pass (F9)**.
10. **Harness** — merge/checkout/closure bench fixes, tar-copy status variant, literal-path add scenario, push bench, commit the regenerated `docs/perf/baseline.*`.

Verification rule unchanged: absolute wall-clock main-vs-branch through `tooling/bench-ab.ts` (never self-share deltas), interop goldens for anything near a refusal surface, mutation budget intact, published numbers from the nightly artifact.
