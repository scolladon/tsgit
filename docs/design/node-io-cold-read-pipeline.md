# Design — Node I/O strategy and the cold read pipeline (31.3)

> Brief: `docs/BACKLOG.md` **31.3** (Phase 31, third of six; sourced from
> `.claude/perf-review-2026-09-10.md` F2, F5 and the adapter half of F14). The floor under every
> small command is libuv threadpool round trips, not syscalls. Serve the cheap, serial file
> operations synchronously from the Node adapter under a per-turn budget, keep bulk reads on the
> pools, and cut the cold packed read (open + one packed blob) from 29 calls to ≤ 24 by reading
> packs before loose objects (git's order for buffered reads), routing the pack header and size through the held
> handle, answering midx presence from the listing, loading `.idx` files lazily per pack, and
> caching pack windows. Adapter constant factors (error construction on expected misses, buffer
> copies, the limiter queue, adler32, browser handle walks) come along with it.
> Status: draft → self-reviewed ×3 (converged) → revised against ADR-879…892 (every decision
> candidate settled) → ready for planning.

## Context

### Where this comes from

The 2026-09-10 review measured the per-command floor on `main` 1f84254c. `statSync` costs
0.9 µs against 9.8 µs for `fs.promises.stat`, a pread on a held handle 0.6 µs against 10 µs, and
`fs.promises.readFile` takes four hops (80 µs for a 25-byte file). The `cat-file` and `rev-parse`
CPU profiles are 80–83 % idle. A throwaway patch of a copy of the profile bundle (metadata calls
turned into `*Sync` inside resolved promises, pack `FileHandle.read` into `fs.readSync`, nothing
else) measured:

| Workload | async (today) | sync-patched | factor |
|---|---|---|---|
| `openRepository` | 0.87 ms | 0.32 ms | 2.7× |
| `revParse('HEAD')` | 0.29 ms | 0.11 ms | 2.6× |
| operational gate | 0.097 ms | 0.046 ms | 2.1× |
| 43-deep delta chain, cold | 0.73 ms | 0.30 ms | 2.4× |
| warm 20k-file `status` | 145 ms | 96 ms | −33 % |
| cold open + read | — | — | −29 … −46 % |

Sync loses on bulk independent reads: 1000 small files cost 14.5 µs/file through a 32-wide pool
against 37 µs/file read serially and synchronously. The lever therefore applies only to cheap
serial primitives.

31.2 (PR #301) removed calls: HEAD read once, config epoch at the gate, packed-refs single stat.
31.3 makes the calls that remain cheaper and removes the ones on the cold packed path. The two
changes compound.

### Pre-decided (user, 2026-09-10) — ratified as ADR-879, not re-opened

**Option (a).** The sync fast path is **default-on** for the cheap serial primitives: stat, lstat,
exists, readlink, size-gated small reads (about 64 KiB) and pread on a held handle. It runs under
a per-event-loop-turn budget (about 1 ms of synchronous work, then one `setImmediate` yield).
`openRepository` gets an opt-out for network or cold filesystems (`io: 'threadpool'`, ADR-881).
Bulk independent reads stay on the threadpool pools, where async measured faster. **The port
stays Promise-returning**: this is an adapter-level policy behind `openRepository`, and
application code never sees a sync call.

### Measured today (main 46ac2df5, post-31.2; ordered trace, this design session)

Traced through `dist-profile` with an ordered shim that wraps `fs.promises.*`, the `*Sync`
functions and the `FileHandle` prototype (`FileHandle.close` was not captured by the shim — closes
are not counted anywhere below). Fixtures from `~/.cache/tsgit-bench/*-v3`, second iteration of
each loop.

**`openRepository` — 13 calls, all serial:**

```
realpath <R>                     cwd canonicalisation            index.node.ts  canonicalize
stat     <R>/.git                discovery                       find-layout.ts findLayout
readlink <R>/.git/HEAD           link text first (EINVAL here)   find-layout.ts hasValidHead
stat     <R>/.git/HEAD           regular-file check              find-layout.ts hasValidHead
readFile <R>/.git/HEAD           HEAD grammar                    find-layout.ts hasValidHead
stat     <R>/.git/commondir      ENOENT on a normal repo         find-layout.ts resolveCommonDir
stat     <R>/.git/objects                                        find-layout.ts sharedDirsValid
stat     <R>/.git/refs                                           find-layout.ts sharedDirsValid
stat     <R>                     ownership (uid) of the worktree trust-verdict.ts evaluateTrust
stat     <R>/.git                ownership (uid) of the gitdir   trust-verdict.ts evaluateTrust
stat     <R>/.git/config         format read, size gate          read-repository-format.ts
readFile <R>/.git/config         extensions.* / core.repositoryformatversion
realpath <R>/.git                gitDir canonicalisation         index.node.ts  resolveNodeLayout
```

**Open + one packed blob (`single-pack-v3`) — 16 more calls:**

```
stat config · readFile config · stat config           (gate epoch + repo-settings — 31.2 territory)
stat objects/pack/multi-pack-index                    midx-source.ts probeFlat          ENOENT
stat objects/pack/multi-pack-index.d/…-chain          midx-source.ts readChainManifest  ENOENT
readdir objects/60                                    loose-oid-cache.ts loadFanoutSet  (loose first)
readdir objects/pack                                  pack-registry.ts scanPacks
stat pack-….idx · readFile pack-….idx                 pack-registry.ts readBoundedIdx
open pack-….pack · FH.read                            headerMemo → ctx.fs.readSlice (open #1)
stat pack-….pack                                      buildOffsetTable (open #2 would be fstat)
open pack-….rev · FH.read                             pack-artefact-source.ts loadPackRevIndex
open pack-….pack · FH.read                            handleMemo + readSlice (open #3)
```

**`revParse('HEAD')` warm after open — 9 calls:** `lstat HEAD · open HEAD · FH.stat · FH.read ·
stat config · readFile config · open refs/heads/main · FH.stat · FH.read`.

**Cold open + one blob, 48 packs, no midx (`many-pack-no-midx-v3`) — 110 calls:** `stat` 53,
`readFile` 49, `readdir` 2, `open` 3, `FH.read` 3. `resolveIndexes` forces all 48 `.idx` files
before the first lookup.

**43-deep delta-chain leaf (`delta-chain-v3`, 187 KB pack) — 59 calls, 44 of them `FH.read`**:
one pread per chain level.

Micro-costs on this machine (Apple M3 Pro, Node 22.22.3), used to size the budget mechanism:

| Operation | cost |
|---|---|
| `performance.now()` / `process.hrtime.bigint()` | 0.065 / 0.061 µs |
| `setImmediate` yield (await round trip) | 13.1 µs |
| `lstatSync` hit (bigint) | 1.43 µs |
| `lstatSync` miss, `throwIfNoEntry: false` | 1.13 µs |
| `lstatSync` miss, try/catch | 3.41 µs |
| `fs.promises.lstat` hit / miss | 10.3 / 12.0 µs |
| sync `open`+`fstat`+`read`+`close`, 25 B | 9.4 µs |
| `fs.promises.readFile`, 25 B | 48.7 µs |
| `realpathSync.native` / `fs.promises.realpath` | 8.1 / 20.1 µs |

### What exists today (the subsystems touched)

- **Node adapter.** `src/adapters/node/node-file-system.ts` `NodeFileSystem` routes every port
  method through `this.fsOps` (`FsOperations`, a `Pick<typeof fsPromises, …>` injected by
  constructor, ADR-047). Read methods share one shape:
  `const { all } = this.resolvedRootSet ?? (await this.loadRootSet()); const real = this.resolveRead(path, all); return runFs(() => this.fsOps.X(real), path)`.
  `runFs`/`mapErrno` turn errno into `TsgitError`. `isPresent(path, 'stat' | 'lstat')` backs
  `exists`/`lexists`. `wrapNodeHandle` adapts `fsPromises.FileHandle` to the port `FileHandle`.
  Constructor: `(rootDir, pathPolicy = nativePolicy, fsOps = realFsOps, rootsArePreResolved = false, removeTreeConcurrency = 8)`.
- **Node entry.** `src/index.node.ts` `openRepository` builds the layout through a raw
  `nodeLayoutProbe` (`fs.promises` `stat`/`readFile`/`readlink`, never the bounded adapter,
  because discovery climbs above the root) and `canonicalize` (`realpath`), then hands a
  `fallback` adapter set to `openRepositoryCore`. `makeWorktreeFs` builds further
  `NodeFileSystem` instances. `src/adapters/node/node-adapter.ts` `createNodeContext` is the
  sync factory twin.
- **Port.** `src/ports/file-system.ts` `FileSystem`: every method returns a Promise. Optional
  capabilities already follow one shape: `lexists` (ADR-873, the non-throwing no-follow presence
  probe) and `atomicRename` (ADR-705/823). `src/repository/wrap-fs-validator.ts` forwards an
  optional method only when the adapter has it. `src/ports/layout-probe.ts` `LayoutProbe` is the
  narrower internal discovery surface.
- **Object read.** `src/application/primitives/object-resolver.ts`
  `resolveObjectContentWithDepth`: `assertLoadable` gate → empty tree → `deltaCache` → `tryLoose`
  (`probeLooseOid` readdir-backed membership, `internal/loose-oid-cache.ts`) → `registry.lookup`
  → `resolvePackChainWithDepth` (`collectDeltaChain`, one `RegisteredPack.readSlice` per level).
  `internal/blob-source.ts` `openBlobSource` (streaming, `streamBlob` and the whitespace
  predicate) has its own loose-then-pack order.
- **Pack registry.** `src/application/primitives/pack-registry.ts`: `createStoreGate` (the midx
  load, `internal/midx-source.ts` `loadMidxSet` → `probeFlat` stat, `readChainManifest` stat),
  `scanPacks` (`readdir objects/pack` → `fileNames` → `loadCandidatePack` → `loadPack`), and
  `loadPack`'s per-pack memos: `indexMemo` (`readBoundedIdx`: stat, read, re-check),
  `headerMemo` (`ctx.fs.readSlice(packPath, 0, 12)`), `buildOffsetTable` (`ctx.fs.stat(packPath)`),
  `handleMemo` (`openWithNoFollow(packPath, 'read')`) and `readSlice` (allocates
  `new Uint8Array(length)` per call, falls back to `ctx.fs.readSlice` on
  `UNSUPPORTED_OPERATION`). `lookup` → `lookupViaIdxScan` → `lookupViaIndexedSnapshot` (forces
  `generation.indexed` = `internal/pack-generation.ts` `resolveIndexes`, sequential over every
  pack) or `lookupViaUnclaimedPacks` (lazy per pack, `unclaimedIndexOrSkip`). `refresh()` and
  `dispose()` clear `deltaBaseCache` and close handles.
- **Harness.** Benches in `test/bench/` (`bench-dsl.ts`, scaled/tiered scenarios), A/B through
  `tooling/bench-ab.ts` (`npm run bench:ab -- <base-ref> [head-ref] [rounds]`), profiles through
  `tooling/profile.ts` + `tooling/profile-registry.ts` over `dist-profile`. The fs-count shim of
  31.1/31.2 (`.claude/perf-31-1-closure-walks-prompt.md`, `fs-count.cjs`) wraps only
  `fs.promises` — **it cannot see a sync arm** (see D10).

### Constraints this design lives under

- **CLAUDE.md prime directive (ADR-226).** Object bytes, refusals and state files stay
  byte-identical with git, unless an ADR records a divergence. Every change below is classified
  in the faithfulness ledger (D11).
- **Hexagonal layering.** Sync calls live **only** in `src/adapters/node/` and in the Node entry
  `src/index.node.ts`. Application code keeps calling the Promise-returning port. The budget and
  yield are adapter state.
- **ADR-047** (`FsOperations` injection), **superseded for the constructor signature by
  ADR-883**: injected test doubles must keep working, now passed as `{ fsOps }` in one options
  object. The sync surface is an optional capability, and the async path stays the fallback.
- **ADR-879…892** (this slice's decisions) bind every section below; the Decision candidates
  section maps each candidate to its ADR.
- **ADR-873 / ADR-705** (optional-capability shape): a new port method is optional, its absence
  changes cost and never the answer, and `wrapFsValidator` forwards it only when present.
- **ADR-721** (first-party read containment is single-authority): every sync arm resolves through
  the same `resolveRead` as its async twin. No new read path bypasses it.
- **ADR-811–825** (adapter refusal-code parity): a sync arm refuses with exactly the code its
  async arm raises, on every platform the contract suite runs on (ubuntu, macOS, windows-latest).
- **ADR-735** (event-loop stall, not throughput, justifies a size gate): the precedent for the
  budget and the size gate.
- **ADR-719** (concurrency limits derive from the limiting resource): the pools that stay async
  keep their derived widths.
- **ADR-720** (lazy, `.rev`-first successor), **ADR-782** (index-pack pass 2 through
  `readSlice`), **ADR-736/852/858** (delta-base cache budget and its config key), **ADR-773**
  (pack config naming: git's key names, git's grammar, `unsigned long` bound for a byte
  quantity), **ADR-850/851/859/862/869** (config read once at the gate; derived caches bound by
  explicit budgets; repo-settings validated at their own tier; byte valves width-aware),
  **ADR-722** (caches key on the session token).
- **Memory findings that bind:** `return await` in async adapter paths (workerd reports a
  handler-less rejection; run `test:parity:workers|deno|bun` when adapters change); classify
  cross-module-graph errors on `data.code` (`errorDataCode`), never `instanceof`; never merge
  platform adapters into shared rollup chunks; Windows `readlink` returns link text with backslashes.
  The sync arm reuses the same link-text normalisation.

### Brief corrections (re-located by symbol on 46ac2df5)

| Brief cite | Now | Correction |
|---|---|---|
| `object-resolver.ts:86` / `:95` | `tryLoose` call `:96`, `registry.lookup` `:115` in `resolveObjectContentWithDepth` | Moved, still loose-first. |
| "git's `do_oid_object_info_extended` is pack-first" | pinned matrix, D5 | **Only half true on git 2.55.0.** Info queries and buffered reads are pack-first. A small blob **streamed** to output (`cat-file -p <blob>`, `show <blob>`, `checkout`, `--batch` content) is loose-first. The swap therefore belongs in the buffered resolver only; `blob-source.ts` keeps its order. |
| `pack-registry.ts:448-457`, `:461` | `headerMemo` `:450-459`, `buildOffsetTable`'s `ctx.fs.stat` `:463` | Confirmed: the `.pack` is opened three times (header `readSlice`, stat by path, held handle). |
| `pack-artefact-source.ts:110` `.rev` "likewise" | `loadPackRevIndex` `:110` | The `.rev` is **its own file**, so it cannot ride the pack's handle. It keeps one bounded `readSlice`, which the sync arm makes cheap (D3). |
| `midx-source.ts:133,249` | `probeFlat` `:136`, `readChainManifest` `:253` | The chain file lives in `objects/pack/multi-pack-index.d/`, so the `objects/pack` listing answers it only through the presence of the `multi-pack-index.d` entry. |
| `pack-generation.ts:115-134` | unchanged | Confirmed, 48 packs → 49 `readFile` + 53 `stat`. |
| `readBoundedIdx :364-378` "size check twice" | `:366-379` | The second check is a free length compare that guards against TOCTOU growth. It is not a second read. The cost is `stat` + `read` (2 calls); no change beyond the sync arm (D6 note). |
| `collectDeltaChain :332-430` | `:394+` | Confirmed, 44 `FH.read` for the 43-deep leaf. |
| `pack-registry.ts:496` zero-fill | `readSlice` `:498` `new Uint8Array(length)` | Subsumed by the window cache: windows are allocated once, and reads become views (D7). |
| `node-file-system.ts:634` copy | `read` `:637` | Moved, still copies. |
| `node-compressor.ts:168,196,277` | `:168` `inflate`, `:196` `streamInflate`, `:277` `createInflateStream` | `:196` sits inside `streamInflate`, which **31.6** replaces with `inflateSync({info:true})`. It is out of 31.3 to avoid a collision. |
| `stat .git` twice | — | The second is `evaluateTrust`'s ownership stat (uid), not discovery. It is batchable, not removable. |
| (new) | open trace | `read-repository-format.ts` reads `.git/config` at open. The first command then re-stats and re-reads it, so the open-time read seeds nothing. Left as is (ADR-891). |
| (new) | — | Pack-first puts the `objects/pack` listing in front of **every** loose read. An unreadable `objects/pack` then decides loose reads; pinned in D5 (rows D1–D3). |
| `has-object.ts:15-17` | unchanged | Already pack-first. Only the `exists` → membership-cache change remains. |
| `read-gitattributes.ts` promise memo | — | Backlog places it in **31.5**; not here. |

## Requirements

R1. **Port unchanged for callers.** No existing `FileSystem` method changes signature or
semantics. The only port additions are optional methods (`tryLstat`, `tryReadUtf8`), and
omitting them changes cost, never answers. The Node adapter's constructor is not a port: it
becomes `new NodeFileSystem(rootDir, options?)` (ADR-883), and a bare `new NodeFileSystem(root)`
keeps compiling.

R2. **Default-on, opt-out exact.** `openRepository` (node) and `createNodeContext` serve the
primitives in R3 synchronously by default (`io?: 'sync-fast-path' | 'threadpool'`, default
`'sync-fast-path'`, ADR-881). With `io: 'threadpool'`, the ordered fs trace of every
bench workload matches `main`'s call for call, apart from the changes of D5–D8 (pack-first,
shared listing, held-handle header, lazy `.idx`, windows, the lstat-first discovery probe and the
skipped realpath), which hold in both modes.

R3. **Sync set is closed and named.** Sync arms exist for exactly: `stat`, `lstat`, `exists`,
`lexists`, `tryLstat`, `readlink`; `read` / `readUtf8` / `tryReadUtf8` on a **regular file** of
size ≤ the size gate; `readSlice` with `length` ≤ the size gate on a regular file; the port
`FileHandle.read` / `FileHandle.stat` on a handle opened by `openWithNoFollow(_, 'read')`; and at
open, `LayoutProbe.stat` / `readUtf8` / `readLink` plus `realpath` canonicalisation. Everything
else (all writes, `readdir`, `rmRecursive`, `open` itself, `close`, and reads above the gate)
stays on the async path unchanged. "`open` itself" means the `open` behind
`openWithNoFollow`, which keeps its `fsPromises.FileHandle` (ADR-885). The `openSync` inside the
small-read arms is part of those arms and is closed before they return.

R4. **Loop budget holds.** With the sync path on, no single unbroken run of synchronous
file work exceeds the budget by more than one operation. Once the spent time in the current turn
reaches the budget, the next sync-eligible call waits for one `setImmediate` turn first. A 20k-file
`status` shows a `perf_hooks.monitorEventLoopDelay` max ≤ budget + 1 ms locally (D10).

R5. **Refusal parity.** `test/unit/ports/file-system.contract.ts` runs green against
`NodeFileSystem` in both modes, on every CI OS. For every sync arm, a unit row asserts that the
errno → code mapping is identical to the async arm (`ENOENT`, `ENOTDIR`, `EACCES`, `EPERM`,
`ELOOP`, `EISDIR`, unknown → `UNSUPPORTED_OPERATION`).

R6. **No synchronous read of a non-regular file.** A FIFO, socket or device at a read path never
blocks the event loop. The sync arm opens non-blocking, fstat-checks and hands anything
non-regular to the async arm, so today's behaviour (a pool thread waits) is preserved exactly.

R7. **Pack-first buffered reads.** `resolveObjectContentWithDepth` consults the pack registry
before loose objects. `openBlobSource` keeps loose-first. Both are pinned by an interop test
against git 2.55.0 (D5 matrix rows O1, P1, P2, D1–D4).

R8. **Cold packed read shape.** Open + one packed blob on `single-pack-v3`: the `.pack` is opened
once, there is no loose `readdir`, and there is no midx `stat` when the listing shows no midx
entries. The recorded count drops from 16 to ≤ 12 post-open calls (exact number recorded in the
PR).

R9. **Lazy `.idx`.** On `many-pack-no-midx-v3`, a lookup that hits the first pack loads exactly
one `.idx`. `all()`, `health()` and `indexFaults()` still see the full classification, and warn
once per unreadable `.idx` per generation.

R10. **Delta chain windows.** The 43-deep leaf issues ≤ ⌈chain span / window⌉ + 1 pack reads
instead of 44. Windows default to 64 KiB, under a 16 MiB registry-wide limit.
`core.packedGitWindowSize` / `core.packedGitLimit` only lower those defaults, and a malformed
value refuses every command at the eager tier, as git does (ADR-882).

R11. **Benches, main vs branch, absolute.** `bench:ab` rows listed in D10 are reported both sides.
No row regresses beyond `bench-check` noise. The headline rows (open, `revParse`, `catFile`, cold
pack, delta chain cold, `status`) are expected to improve, with magnitudes recorded. The review's
factors are expectations, not gates.

R12. **Quality gates.** 100 % line/branch/function/statement coverage; 0 surviving mutants, with
equivalent mutants proven in prose; no ignore directives; property siblings for adler32 (D9) and
for any new parser (none expected).

R13. **The strategy is documented.** `docs/get-started/node.md` and
`docs/understand/performance.md` describe the two `io` modes and when to pick `'threadpool'`
(network or cold filesystems), and the `openRepository` reference (`reports/api.json`) carries
the new option (ADR-881).

## Design

### D0 — Shape and part order

```
                 openRepository({ io })                createNodeContext({ io })
                         │   'threadpool' → no policy, async arm only   │
                         ▼  'sync-fast-path' (default)                  ▼
            SyncIoPolicy { ops: SyncFsOperations, budget: TurnBudget }   ◄── one per repository
               │                     │                        │
     nodeLayoutProbe/canonicalize   NodeFileSystem (main)    NodeFileSystem (makeWorktreeFs)
                                    new NodeFileSystem(roots, { syncIo, … })
               │                     │
               ▼                     ▼
   sync arm ◄── admit? ── TurnBudget ── spent ≥ budget ─► await nextTurn (setImmediate)
      │ non-regular / above gate / no policy
      ▼
   async arm (today's fsOps path, unchanged)

 application ── Promise port ──► pack registry
     resolveObjectContentWithDepth: gate → empty tree → deltaCache → registry.lookup → loose
     registry: packDirListing (1 readdir) ─► store gate (midx presence from listing)
                                         └► scanPacks (same listing)
               RegisteredPack: handle ─► header / fstat size / windows (registry-wide LRU)
               lookup (no midx): lazy per-pack .idx, first hit wins
```

Part order (sequential where files overlap):

```
adapter chain:  P1 (constructor options object, mechanical) ─┐
                P2 (budget, policy, sync ops type)  ─────────┴─► P3 → P4 → P5 → P10
registry chain: P6 → P7 → P8
riders:         P9
```

P1 lands before any sync arm (ADR-883). P2 shares no file with P1 and may run beside it. P3–P5
share `node-file-system.ts`, P4 edits the constructor sites P1 migrated, and P10 follows P5
because both edit `browser-file-system.ts`. P8 adds no public option (ADR-882), so the registry
chain shares no file with the adapter chain. P9 is independent. Parts are listed with context
blocks after D12.

### D1 — `TurnBudget` and `SyncIoPolicy` (adapter state)

New file `src/adapters/node/sync-io-budget.ts`:

```ts
export interface TurnBudget {
  /** undefined → run now; a Promise → await it (the next turn) before running. */
  readonly admit: () => Promise<void> | undefined;
  /** Charge the elapsed time of one completed sync operation. */
  readonly charge: (startedAt: number) => void;
}

export interface SyncIoPolicy {
  readonly ops: SyncFsOperations;
  readonly budget: TurnBudget;
  readonly maxSyncReadBytes: number;
}

export const createTurnBudget = (
  budgetMs: number,
  clock: () => number = performance.now.bind(performance),
  scheduleTurnEnd: (cb: () => void) => void = setImmediate,
): TurnBudget => …
```

Semantics:

- The first charge in a turn arms **one** `scheduleTurnEnd` marker. When it fires, it resets
  `spent` to 0 and resolves the shared `nextTurn` promise. A `setImmediate` callback cannot run
  while a microtask chain is still draining, so the marker firing is exactly "the loop got a
  turn".
- `admit()` returns `undefined` while `spent < budgetMs` (no await, so no extra microtask hop on
  the hot path). Otherwise it returns the shared `nextTurn` promise, and N concurrent callers
  share one yield.
- `charge(startedAt)` adds `clock() − startedAt`. One clock read before and one after each op
  cost 0.13 µs against a 1.1–1.4 µs op (about 10 %). A cheaper count-based budget was rejected (ADR-880).
- Measured yield cost is 13 µs. At a 1 ms budget, a long sweep pays about 1.3 % for the yields.
- Scope is **per repository** (ADR-890): `openRepository` creates one `SyncIoPolicy` and shares
  it among the layout probe, the main adapter and every `makeWorktreeFs` instance.
  `createNodeContext` creates one per context. No module-level budget exists.
- The policy is built from the public option (ADR-881): `io` absent or `'sync-fast-path'` →
  `createSyncIoPolicy()` (1 ms budget, 64 KiB gate, `realSyncFsOps`; internal constants per
  ADR-880, not options); `io: 'threadpool'` → no policy at all (`undefined`), so every adapter the
  repository builds runs today's async path. `SyncIoPolicy` is an internal name; only `io` is
  public.

The arm pattern every sync-eligible method follows (shown for `lstat`):

```ts
lstat = async (path: string): Promise<FileStat> => {
  const { all } = this.resolvedRootSet ?? (await this.loadRootSet());
  const real = this.resolveRead(path, all);
  const sync = this.syncIo;
  if (sync === undefined) return runFs(async () => mapStat(await this.fsOps.lstat(real, BIGINT)), path);
  const wait = sync.budget.admit();
  if (wait !== undefined) await wait;
  return runSync(sync.budget, () => mapStat(sync.ops.lstatSync(real, BIGINT)), path);
};
```

`runSync(budget, op, path)` is the synchronous twin of `runFs`. It times the op, charges it,
turns errno into `mapErrno(err, path)`, and rethrows non-errno errors untouched. The method stays
`async`, so a throw becomes a rejection; callers never see a synchronous throw. The shared tail is
extracted so no arm exceeds 20 lines.

### D2 — `SyncFsOperations` and the constructor options object (ADR-883)

`src/adapters/node/fs-operations.ts` gains a second injectable surface:

```ts
import * as fs from 'node:fs';
export type SyncFsOperations = Pick<typeof fs,
  'statSync' | 'lstatSync' | 'readlinkSync' | 'openSync' | 'fstatSync' | 'readSync' | 'closeSync'
> & { readonly realpathSync: { readonly native: typeof fs.realpathSync.native } };
export const realSyncFsOps: SyncFsOperations = fs;
```

`NodeFileSystem`'s constructor becomes `(rootDir, options?)` (ADR-883, superseding ADR-047's
positional signature):

```ts
export interface NodeFileSystemOptions {
  readonly pathPolicy?: PathPolicy;          // default nativePolicy
  readonly fsOps?: FsOperations;             // default realFsOps
  readonly syncIo?: SyncIoPolicy;            // absent → every method runs today's async path
  readonly rootsArePreResolved?: boolean;    // default false
  readonly removeTreeConcurrency?: number;   // default REMOVE_TREE_CONCURRENCY
}

constructor(rootDir: string | ReadonlyArray<string>, options: NodeFileSystemOptions = {})
```

The migration of every construction site is its own mechanical part, **P1**, landed before any
sync arm; P1 introduces the object without `syncIo`, and P3 adds the member. When `syncIo` is
absent, **every method runs today's code path**. Existing doubles (`fakeFsOps` in
`node-fs-fakes.ts`) are passed as `{ fsOps }` and keep the async path. New tests pass a fake
`SyncFsOperations` built the same way as `fakeFsOps`. The internal helpers that take an `fsOps`
argument (`realpathNearestExisting(absolute, policy, fsOps)`) keep their signatures (ADR-883
carries them forward from ADR-047).

`realpathSync.native` is used, not `realpathSync`, because `fs.promises.realpath` is the native
`realpath(3)` while the JS `realpathSync` walks segments with its own cache. On Windows the two
differ on subst/junction spellings, and the native twin keeps canonical paths identical across
modes.

### D3 — `NodeFileSystem` sync arms

| Port method | Sync arm | Falls back to async when |
|---|---|---|
| `stat` / `lstat` | `statSync`/`lstatSync(real, { bigint: true })` → `mapStat` | no policy |
| `exists` / `lexists` | `statSync`/`lstatSync(real, { throwIfNoEntry: false })` → `!== undefined`; other errno → `mapErrno` | no policy |
| `tryLstat` (D4) | `lstatSync(real, { bigint: true, throwIfNoEntry: false })` | no policy |
| `readlink` | `readlinkSync(real)` (string; link text normalised by the caller exactly as today) | no policy |
| `read` / `readUtf8` / `tryReadUtf8` | `openSync(real, O_RDONLY \| O_NONBLOCK)` → `fstatSync` → regular and `size ≤ gate` → `readSync` into `Buffer.allocUnsafe(size)` (loop until EOF or `size`) → `closeSync` (in `finally`) | non-regular, size > gate, or no policy: close and run today's `fsOps.readFile` |
| `readSlice(path, off, len)` | same open/fstat guard, then `readSync(fd, buf, 0, len, off)` → `bytesRead` view | `len > gate`, non-regular, or no policy |
| `FileHandle.read` / `.stat` (from `openWithNoFollow(_, 'read')`) | `readSync(handle.fd, …)` / `fstatSync(handle.fd, { bigint: true })` | no policy; `'write'` handles stay async |

Invariants:

- **Containment unchanged.** Every arm calls `resolveRead` first (ADR-721). `openWithNoFollow`
  keeps its `isSymlinkLeaf` pre-check and discriminator.
- **The open of a held handle stays async** (ADR-885). The `fsPromises.FileHandle` object keeps its
  GC-close safety net, and only its reads and fstat use `handle.fd`. A `close` cannot race a sync
  read: the read completes inside one JS turn, and `RegisteredPack.close` already drains
  `inFlight`.
- **FIFO safety (R6).** `O_NONBLOCK` makes `openSync` return immediately on a FIFO. `fstatSync`
  then sees a non-regular file, and the arm closes it and delegates to the async arm, which opens
  **without** `O_NONBLOCK` as today. On a regular file `O_NONBLOCK` has no effect. Windows has no
  `O_NONBLOCK` constant (`fs.constants.O_NONBLOCK` is `undefined`), and the flag is omitted there
  (`?? 0`): named pipes do not live in the NTFS namespace these paths resolve to. A
  `win-only` row pins that the sync small read of a regular file behaves identically.
- **Size gate at read time, not stat time.** The arm reads `size` bytes and then **one more
  `readSync`** to confirm EOF. If the file grew between `fstat` and the read, the extra bytes are
  read in a loop up to the gate. Beyond the gate, the arm discards and delegates to the async arm,
  so a growing file is never truncated and the gate is never exceeded.
- **`read` returns a view, not a copy** (the `:637` rider): `new Uint8Array(buf.buffer,
  buf.byteOffset, n)` over the arm's own `allocUnsafe` buffer. On the async arm,
  `fsOps.readFile`'s Buffer is wrapped as a view when `byteOffset === 0 && byteLength ===
  buffer.byteLength` (own, exact-fit ArrayBuffer), and copied otherwise (a pooled slice).
- **`loadRootSet` / `canonicalizeRoots`** use `realpathSync.native` under a policy (first call
  only; `rootsArePreResolved` skips it anyway).
- **Errors.** Each sync errno flows through the same `mapErrno`. `throwIfNoEntry: false` returns
  `undefined` for `ENOENT` **only**; `ENOTDIR` still throws and maps to `NOT_A_DIRECTORY`, exactly
  as the async arm does.

What stays pooled, and why: `readdir` (ADR-886: its entries count is unbounded, and after D5 the
cold path has one or two), all writes (not in the decision), `read` above the gate (bulk: blobs,
large `.idx`, packs), and `rmRecursive`/`rename` (compound, write-side). The `boundedMapFor` pools
keep their ADR-719 widths. A sync-eligible call issued through a pool (the 20k `lstat` sweep of
`status`) runs synchronously inside the pool's slot. The pool then serialises cheaply, and the
budget yields every ≈ 1 ms (≈ 700 lstats at 1.4 µs).

### D4 — `tryLstat` / `tryReadUtf8` (optional port methods, ADR-873 shape; ADR-884)

```ts
/** OPTIONAL. Resolves `undefined` exactly where `lstat` refuses FILE_NOT_FOUND; otherwise as `lstat`. */
readonly tryLstat?: (path: string) => Promise<FileStat | undefined>;
/** OPTIONAL. Resolves `undefined` exactly where `readUtf8` refuses FILE_NOT_FOUND; otherwise as `readUtf8`. */
readonly tryReadUtf8?: (path: string) => Promise<string | undefined>;
```

- Node: the sync arm answers a miss with no error object at all (`throwIfNoEntry: false`,
  1.13 µs against 3.41 µs for a caught throw). The async arm catches `ENOENT` **before**
  `mapErrno`, the way `isPresent` does, so no `TsgitError` stack is captured (2.1 µs today).
- Memory: the existing `lstat`/`readUtf8` resolution (ancestor symlink walk included, ADR-872),
  returning `undefined` on its not-found arm instead of constructing a refusal. Browser: the
  existing handle walk, likewise.
- `wrap-fs-validator.ts` forwards both only when present, guarded as read surfaces and invoked on
  the adapter itself (the `lexists` precedent).
- Callers take `ctx.fs.tryLstat?.(p)` and fall back to `lstat` + `errorDataCode(err) ===
  'FILE_NOT_FOUND'`, **never `instanceof`** (fix the `instanceof TsgitError` in
  `loadCappedUtf8` while touching it). Hot callers converted in this slice:
  `internal/read-capped-file.ts` `loadCappedUtf8` (one per directory in `status`: `.gitignore`,
  and `.gitattributes` through the same helper), `config-scoped-read.ts`, `shallow-file.ts`,
  `read-sparse-checkout.ts` (per-command probes of usually-absent files). Other
  `FILE_NOT_FOUND` catch sites are cold and stay as they are; the PR lists them.
- Loose-ref misses go through `openWithNoFollow` (`ref-store.ts` `leafKind`), not
  `readUtf8`/`lstat`. They are **not** covered by these two methods, and a `tryOpenWithNoFollow`
  is out of scope (ADR-884).

### D5 — Pack-first buffered reads (faithfulness-positive) and the shared pack-dir listing

**Pinned matrix — git 2.55.0, scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`,
signing off, `mktemp -d` throwaway.** Setup: `hello\n` committed, `git gc` (0 loose objects),
then a loose file planted at the same oid.

| # | Planted loose object | Command | Result | Source served |
|---|---|---|---|---|
| O1 | valid zlib, `blob 7\0LOOSE!\n` (impostor) | `cat-file -s` / `-t` / `--batch-check` | `6` / `blob` / `blob 6` | **pack** |
| O1 | same | `cat-file -p <blob>`, `cat-file blob`, `show <blob>`, `checkout -- a`, `--batch` content | `LOOSE!` | **loose** (streamed) |
| O1 | same | `cat-file -p` with `-c core.bigFileThreshold=1` | `hello` | **pack** |
| O1 | same (second commit changes `a`) | `diff HEAD~1 HEAD`, `grep HEAD~1`, `blame HEAD~1`, `cat-file --filters`, `archive` | `hello` | **pack** (buffered) |
| O2 | commit impostor at the HEAD oid | `log -1 --format=%s`, `cat-file -p HEAD` | `c1` | **pack** |
| O3 | tree impostor at `HEAD~1^{tree}` | `ls-tree`, `cat-file -p <tree>` | original entries | **pack** |
| P1 | garbage (not zlib) | `cat-file -p` / `-t` / `-e` | `error: inflate: data stream error…` then `hello`; exit 0 | loose tried, pack served |
| P2 | garbage, object **not** packed | `cat-file -p` | `error: inflate…`, `fatal: Not a valid object name <oid>`; exit 128 | — |
| P3 | size-lying `blob 99\0hello\n` | `cat-file -p` / `-s` | `hello` / `6` | pack |
| P4 | garbage | `rev-list --objects HEAD` | exit 0 | pack |

Reading of the matrix: git answers **info and every buffered content read from the pack first**.
Only the small-blob **streaming** path (`stream_blob_to_fd`) is loose-first, which the
`bigFileThreshold=1` row confirms (the large-object stream arm opens the pack). tsgit's buffered
resolver (`resolveObjectContentWithDepth`, behind `readObject`, `readBlob`, `readRawObject`, tree
and commit reads) maps onto git's buffered class. `openBlobSource` (behind `streamBlob` and the
whitespace predicate) maps onto the streaming class.

**Change.**

```
resolveObjectContentWithDepth: gate → empty tree → deltaCache → registry.lookup(id)
                                ├─ hit  → resolvePackChainWithDepth (unchanged)
                                └─ miss → tryLoose (unchanged body) → miss → OBJECT_NOT_FOUND
openBlobSource:                 unchanged (loose → pack), matching git's streaming class
```

Observable differences, all toward git: an impostor or corrupt loose copy of a packed object is
no longer served or fatal on the buffered path (rows O1-buffered, P1, P3). A loose-only
repository now forces the pack scan on its first read. That scan is one listing, shared with the
store gate below, so the loose-only cold read goes from `stat midx · stat chain · readdir fanout`
to `readdir pack · readdir fanout`.

**The shared listing.** Today the store gate (`createStoreGate` → `loadMidxSet`) stats two paths,
and `scanPacks` lists the directory separately. After the change, one `packDirListing` promise
memo per generation feeds both, and `refresh()` clears it with the gate:

- `probeFlat` / `readChainManifest` take the listing. **No entry** named `multi-pack-index`
  (resp. `multi-pack-index.d`) → absent, with no I/O. **Any** entry (file, symlink, directory) →
  today's `stat` path runs verbatim. So a symlinked midx is still followed (pin D4 below) and a
  directory is still classified by today's code. The listing only ever removes probes whose answer
  it already knows.
- `loadMidxSet(ctx, packsDir, listing?)` gains an **optional** `listing` parameter. Its only `src`
  caller is `createStoreGate`. About 40 direct calls in `midx-source.test.ts` pass no listing
  and keep exercising today's stat path unchanged; new rows cover the listing arm.

**Pinned: an unusable `objects/pack` (same throwaway protocol).**

| # | Arrangement | Command | git result |
|---|---|---|---|
| D1 | loose-only, `chmod 000 objects/pack` | `cat-file -p` / `-t` / `log -1` | `error: unable to open object pack directory: …: Permission denied`, then the object; exit 0 |
| D2 | packed blob, `chmod 000 objects/pack` | `cat-file -p <packed>` | the same error, then `fatal: Not a valid object name`; exit 128 |
| D2 | loose blob, same | `cat-file -p <loose>` | the error line, then the object; exit 0 |
| D3 | `objects/pack` is a regular file | `cat-file -p <loose>` | `error: …: Not a directory`, then the object; exit 0 |
| D4 | `multi-pack-index` is a symlink to a valid midx | `cat-file -p` | object served, midx used |
| D5 | `multi-pack-index` is a directory | `cat-file -p` | `fatal: mmap failed: Invalid argument`; exit 128 |

tsgit today: `isMissingPackDir` folds `FILE_NOT_FOUND` and `NOT_A_DIRECTORY` (D3, already
faithful). `PERMISSION_DENIED` propagates, but only to `all()`/`lookup()`, so a loose read
survives D1 by accident of the order. Pack-first would make D1 refuse. **ADR-887 decides:** the
registry folds every fault of the `objects/pack` listing (`FILE_NOT_FOUND` and `NOT_A_DIRECTORY`
as today, `PERMISSION_DENIED` and any other errno newly) into an empty listing, and reports it
once per generation through `ctx.logger?.warn` with the fault attached (no logger → silent, never
a refusal). That is git's shape on all of D1–D3: loose served, packed → `OBJECT_NOT_FOUND`. D5 is
a **pre-existing** divergence (tsgit's `probeFlat` discards a non-regular midx as a tier-B fault
where git dies). It is recorded here and not changed.

**Riders on the same seam.**

- `has-object.ts` `hasObject`: the loose arm becomes `probeLooseOid(ctx, id)`, which is the
  session membership cache, instead of `ctx.fs.exists` per call. It is already pack-first, so
  there is no order change.
- `resolve-oid-prefix.ts`: `scanLoose` drops the `exists` pre-probe (readdir with
  `FILE_NOT_FOUND`/`NOT_A_DIRECTORY` → `[]`, the `isMissingFanoutDir` rule), and the two
  `RegExp`s become per-`hexLength` module constants (two hash widths, so two entries each).
- `loose-oid-cache.ts` module doc: "loose-first precedence is unaffected" becomes a statement of
  the new split.

### D6 — Pack registry: one open per pack, lazy `.idx`

- `headerMemo`: reads the 12-byte header through the pack's own `readSlice` (the held handle, or
  the window cache in D7), no longer `ctx.fs.readSlice(packPath, …)`. **Faithfulness-neutral,
  with one consistency gain.** The header was read through a symlink-following path open while
  every data read used the no-follow handle. The scan already drops a symlinked `.pack`
  (`fileNames` holds regular files only), so no reachable input changes.
- `buildOffsetTable`: `packFileSize` comes from `handle.stat()` (fstat on the held handle). On
  adapters without a handle (`UNSUPPORTED_OPERATION`, browser), it falls back to
  `ctx.fs.stat(packPath)` through the same arm `readSlice` already takes. `RegisteredPack` gains
  an internal `size(): Promise<number>` memo that shares `handleMemo`.
- `readBoundedIdx`: unchanged (see Brief corrections). With the sync arm the `stat` costs 1.4 µs.
  A `.idx` above the size gate stays a pooled `readFile`.
- `lookupViaIndexedSnapshot` (no midx) becomes lazy: it walks `generation.packs` in candidate
  order through `unclaimedIndexOrSkip` (same warn-once `generation.warnedIdx`), exactly as
  `lookupViaUnclaimedPacks` does without the claimed filter. The first hit returns. The pack order
  and the header probe on the hit are unchanged, so **the same pack serves the same oid**. The
  two functions collapse into one loop with a `claimed` predicate (`() => false` without a midx).
- `resolveIndexes` (behind `all()`, `health()`, `indexFaults()`) loads through
  `boundedMapFor(ctx.concurrency.ioBound)`. Results are **re-ordered by candidate index before
  warning**, so the warn sequence and the `IndexedPacks.packs` order are identical to the
  sequential version. It reuses each pack's `indexMemo`, so a pack a lookup already loaded costs
  nothing.
- **Warn timing (observable only through `ctx.logger`).** An unreadable `.idx` is now warned when
  a lookup reaches it or when a bulk consumer forces classification, instead of at the first
  lookup of any object. git warns on its own lazy `open_pack_index`. This is closer, and
  `logger` output is not a git-faithfulness surface.

### D7 — Pack window cache (git's `use_pack`, ADR-882)

A per-`RegisteredPack` window LRU sits under `RegisteredPack.readSlice`, in the application
layer, so it is platform-neutral:

- A window is `[base, base + W)` with `base = floor(offset / W) × W`, loaded by **one** read
  through the held handle (sync pread on Node, `ctx.fs.readSlice` fallback in the browser) and
  clamped at the file end.
- A request `[offset, offset + len)` fully inside a cached window returns a **view** (`subarray`,
  no copy). `RegisteredPack.readSlice` has exactly two consumers, `object-resolver.ts`
  (`readEntryHeaderWithChunk`, `:666`) and `fsck/object-cache.ts` (`:224`), plus the header memo
  after D6. P8 audits all three for writes into the returned bytes (none expected: they feed
  header parsers and inflate) and for **retention**. A retained view pins its whole window after
  eviction, and the LRU would then under-count live memory, so any consumer that keeps bytes
  beyond the call must copy. The return type becomes `Promise<Readonly<Uint8Array>>`-shaped where
  the compiler allows it. A request that crosses a window edge with `len ≤ W` loads a
  window based at `floor(offset / PAGE) × PAGE` (PAGE = 4 KiB), git's "window starting at the
  offset" rule. A request with `len > W` bypasses the cache (one direct read, today's shape).
- Budget: windows are charged to one registry-wide byte limit with LRU eviction across packs,
  git's `packed_git_limit` shape. Defaults (ADR-882): **64 KiB window, 16 MiB limit**, internal
  named constants in `pack-window-cache.ts`; no programmatic option exists (ADR-882 keeps one
  additive for later). The effective values are `min(default, key)` for
  `core.packedGitWindowSize` / `core.packedGitLimit`: a key can only **lower** a default, and a
  value above it is clamped to it. The 64 KiB window is confirmed or replaced by P8's
  delta-chain probe on the spread row before merge. The cache is cleared exactly where
  `deltaBaseCache` is cleared (`refresh()`, `dispose()`), because a replaced pack may reuse its
  name.
- This replaces the per-call `new Uint8Array(length)` zero-fill (the `:498` rider), since window
  buffers are allocated once.
- **Honest sizing of the win.** Under the default sync arm, a pread costs 0.6 µs, so the 44 reads
  of the delta chain are ≈ 26 µs of its 0.30 ms. The window cache mostly pays on the `io: 'threadpool'` path
  (44 × 10 µs) and in the **browser**, where each `readSlice` is a handle walk plus `getFile()`
  (a depth-10 chain costs 50 round trips). That is why it is in scope. The probe for this part
  measures all three.

**Config pin (git 2.55.0; `git config --file` in the throwaway).** `core.packedGitWindowSize` and
`core.packedGitLimit` are read by git's `git_default_config`, so **every command dies** on a
malformed value (`cat-file`, `rev-parse`, `status` all refuse identically):

| value | both keys |
|---|---|
| `0`, `1`, `1k`, `4g`, `9223372036854775807` | accepted |
| `abc`, `-1`, `''`, valueless | `fatal: bad numeric config value '<v>' for '<key>' in file .git/config: invalid unit`, with `<key>` printed all-lowercase |
| `18446744073709551616` | `… : out of range` |

The bound is `unsigned long`, with the grammar and reasons of `pack.windowMemory` (ADR-773).
Documented defaults (`git help config`): window 1 GiB on 64-bit (32 MiB on 32-bit, 1 MiB with
`NO_MMAP`); limit 32 TiB on 64-bit (256 MiB on 32-bit). **git's numbers are mmap reservations**,
paged lazily, while tsgit's window is an eager heap read. A literal 1 GiB window would read the
whole pack on the first access. ADR-882 therefore separates "honour the key" (as an upper
bound) from "use git's default value" (tsgit keeps heap-sized defaults).

Today tsgit **ignores** both keys and so accepts a malformed value that git refuses. That is a
pre-existing faithfulness gap. ADR-882 closes it: a malformed value refuses through
`configBadNumericValue` from `assertEagerConfigValid`
(`src/application/primitives/internal/repo-state.ts`) on every command, as a **sixth candidate**
beside the five finders it already runs under one `Promise.all`, in lowest-line ordering
(`pickLowerLine`) with the other eager keys. The finder reuses the grammar and reasons of the
`pack.windowMemory` unsigned-long finder (`findFirstInvalidPackInt`, `config-read.ts`). This is the **eager** tier, not ADR-859's
repo-settings tier, because git reads these keys in `git_default_core_config`, which the pin shows
dying in `rev-parse` and `status`.

### D8 — `openRepository`: batched probes and the derivable realpath

With the sync arm on, the 13 open calls cost about 1–8 µs each and batching changes little. With
`io: 'threadpool'` (network filesystem, where each hop can be milliseconds), the serial chain is the
cost. So the batching targets **critical-path depth**, and the call count stays the same or
falls:

- `find-layout.ts` `layoutFor`'s candidate check (`hasValidHead` + `resolveCommonDir` +
  `sharedDirsValid`) issues `readLink(HEAD)`, `stat(HEAD)`, `stat(commondir)`,
  `stat(gitDir/objects)` and `stat(gitDir/refs)` under one `Promise.all`. It then **evaluates
  them in today's decision order**: link text first; the `readUtf8(HEAD)` content read runs only
  after `stat(HEAD).isFile` (FIFO safety is kept; it stays serial). The speculative
  `gitDir/objects|refs` stats are used only when `commondir` is absent. When `commondir` is
  present, the shared dirs are stat'ed under the resolved common dir as today, so the speculation
  costs two wasted stats on linked worktrees only. Serial depth: 8 → 3 rounds on a normal repo.
- `trust-verdict.ts` `evaluateTrust`: `isOwnedByCaller` for every `checkedPathsOf` path under one
  `Promise.all`. The **first foreign path in iteration order** is reported, so the verdict is
  identical.
- `index.node.ts` `resolveNodeLayout`: the gitDir `realpath` is skipped when the gitDir is
  `<canonical cwd-derived workDir>/.git` **and** discovery saw `.git` as a directory that is not a
  symlink. That needs the discovery probe to `lstat` first and `stat` only on a symlink (same call
  count on the common path; the answer is identical because `stat` follows exactly the symlinks
  `lstat` reports). An ancestor of a realpath is real, and a non-symlink child of a real directory
  is real, so `realpath` would return the same string. This is the `isDerivedFromCanonicalCwd`
  proof, extended by one segment. 13 → 12 calls.
- `readlink HEAD` stays: link text first is git's `validate_headref`, and EINVAL on a regular
  HEAD is the answer, not waste. It moves into the batch.

### D9 — Constant-factor riders

| Rider | Change | Guard |
|---|---|---|
| `internal/concurrency-limiter.ts` `createConcurrencyLimiter` | `queue.shift()` → head cursor with compaction once `head > 1024 && head > queue.length / 2` (40k tasks: 498 → 21 ms measured) | FIFO order property: release order equals admit order |
| `internal/blob-source.ts` buffered arms | populate `ctx.deltaCache` on the buffered base and loose arms with `{ type, content }` (ADR-854 value type) when `declaredSize === content.byteLength`, mirroring `resolveObjectContentWithDepth`'s `cacheEntry` rule | a size-lying header (ADR-863) is never cached |
| `adapters/adler32.ts` `adler32` | NMAX = 5552 deferred-modulo loop, indexed `for` (111 → 1177 MiB/s, bit-identical) | `adler32.properties.test.ts`: equals the reference one-byte loop over arbitrary bytes and lengths spanning NMAX boundaries |
| `adapters/inflate.ts` `GrowableBuffer` | initial capacity `min(maxOutputBytes, INITIAL_CAPACITY_CEILING)` when the caller passed an explicit `maxOutputBytes` (the declared entry size on pack paths); default constructor unchanged | inflate property suite unchanged; one row asserts no regrowth for an exact-size member |
| `node/node-compressor.ts` `inflate` (`:168`), `createInflateStream` (`:277`) | view instead of copy when `out.byteOffset === 0 && out.byteLength === out.buffer.byteLength`; copy otherwise (≤ 16 KiB outputs alias zlib's `_outBuffer`) | a row that inflates two ≤ 16 KiB members back to back and asserts the first is not overwritten |
| `browser/browser-file-system.ts` `walkToParent` / `resolveFileHandle` | directory-handle LRU keyed by parent path (the `parentRealpathCache` shape: bytes + entries capped), invalidated on `rm`/`rename`/`rmRecursive` of the path or any ancestor | browser contract suite; Playwright chromium + firefox |
| `browser/browser-hash-service.ts` hex + streaming | 256-entry hex lookup table; the streaming hasher concatenates once into a preallocated buffer (one copy, not two) | hash-service contract suite, browser interop spec |

`createSyncAccessHandle` (worker-only, exclusive lock per file) is **out** of this slice
(ADR-888).

### D10 — Harness and measurement plan (one probe per part)

**Oracles by item:**

| Item | Oracle | Status |
|---|---|---|
| Constructor options object (P1) | none: no runtime change; gate is types + biome + the touched suites, and the `new NodeFileSystem(` site count before/after | — |
| Sync arms (P3) | `rev-parse.bench` HEAD row, `cat-file.bench`, `loose-read.bench` both rows, `status.bench` (local), all `bench:ab` main-vs-branch absolute | exist |
| Open (P4) | `loose-read.bench` "reads a blob" (fresh open per call) is the open oracle; trace oracle: 13 → 12 calls, serial rounds recorded with `io: 'threadpool'` | exist + script |
| Loop budget (R4) | new implementation-time probe: `monitorEventLoopDelay({ resolution: 1 })` around 5 × `status()` on `medium-v3`; max and p99 recorded both modes | script |
| `tryLstat` (P5) | `status.bench` (review: 4–5 % of status is error construction); unit fs-count on `loadCappedUtf8` misses | exists |
| Pack-first + listing (P6) | `midx-lookup.bench` rows "loose object with no packs", "cold open reads one loose blob", "cold open reads one blob with/without midx"; `pack-read.bench` cold rows; trace oracle R8 | exist |
| Lazy `.idx` (P7) | `midx-lookup.bench` "first pack with no midx" and "cold open reads one blob with no midx" (review: 11.7 vs 2.6 ms); trace oracle R9 | exist |
| Windows (P8) | `delta-chain-read.bench` cold + 8-tips rows, both modes; `pack-read.bench` "spread across a cold large pack" (the regression sentinel: a random-access read must not pay a full window per object); `log.bench`; trace oracle R10 | exist |
| Riders (P9) | `adapter-inflate.bench` bundled rows (adler32); a 40k-task limiter micro-probe; `diff-whitespace.bench` (blob-source cache) | exist + script |
| Browser (P10) | Playwright parity + a depth-10 chain read counting `getFile()` calls | script |

**Trace shim (replaces `fs-count.cjs`).** 31.1/31.2's shim wraps only `fs.promises`, so after
P3 it would report a **false** drop to near zero. The implementation-time shim must wrap
`fs.promises.*`, the `*Sync` functions **and** the `FileHandle` prototype (`read`, `stat`, and
`close` via the prototype symbol), and count both families. The shape used for this design's
traces: ordered log, path made relative to the fixture root, enabled around one iteration. Numbers
go in the PR body, as in 31.2.

**CI absolutes.** CI per-op cost is ≈ 2× local for the same hops. Before quoting Linux numbers,
run `strace -c -f` over the open + one-blob probe on `ubuntu-latest` through a throwaway `probe/**`
branch with a push-triggered workflow (the rename-probe pattern from 2026-09-06). Record syscall
counts both modes. The branch is deleted after.

**`profile` workloads (ADR-892).** `pack-read` (8000 fresh opens) is really an `openRepository`
profile. Add an explicit `open` workload that measures `openRepository` alone (open + dispose, no
read). `pack-read` keeps its name and is made to profile the packed read on an already-open
repository (open once outside the measured loop), so the name finally matches the workload; its
baseline row is re-recorded in the same commit and the PR notes the series break. Regenerate and commit `docs/perf/baseline.*` in the harness part.

**`bench:ab` rows read for non-regression:** every row in the table above plus `log` (both),
`commit`, `tag-list`, `branch-list`, `maintenance gc`, `fetch-pack`, `clone-small-repo`. The
writes stay async, but they share the adapter.

### D11 — Faithfulness ledger

| Change | Class | Pin |
|---|---|---|
| Sync arms, budget, `io` option | neutral (git is synchronous; no data or refusal change) | contract suite both modes (R5) |
| Pack-first buffered resolver | **positive** (O1 buffered, O2, O3, P1, P3) | new `test/integration/object-precedence-interop.test.ts` |
| `openBlobSource` stays loose-first | faithful (O1 streamed rows) | same test, streamed rows |
| Unreadable `objects/pack` fold (ADR-887) | **positive** (D1–D3) | same test, posix-only, skipped as root |
| midx presence from listing | neutral (symlink/dir entries fall through to `stat`; D4) | `midx-interop.test.ts` gains the symlinked-midx row |
| Header/size through the held handle | neutral | unit |
| Lazy `.idx` | neutral (same pack order, same first hit) | unit + `packfile-interop` unchanged |
| Window knobs (ADR-882) | **positive** (malformed keys refused as git does) | `config-interop` / new rows in `repo-settings-config-interop.test.ts`-style file, eager tier |
| Open batching / realpath skip | neutral (same decisions, same order) | `find-layout.test.ts`, trust tests |
| Riders | neutral (bit-identical outputs) | property + unit |
| midx-as-directory (D5 row) | pre-existing divergence, unchanged | recorded only |
| git re-scans the pack directory before failing a lookup; tsgit only after a lazy fetch | pre-existing divergence, not pinned here, unchanged | recorded only |

### D12 — Parts

Each part is one TDD cycle with atomic commits and ends with its probe (memory hint: one
measurement per part; review has caught regressions a green validate missed).

#### P1 — `NodeFileSystem` takes one options object (mechanical migration, ADR-883)

- **Behaviour:** none. Every construction site keeps its meaning; only the argument shape
  changes. Lands before any sync arm (ADR-883), as one commit.
- **Files:** `src/adapters/node/node-file-system.ts` (`NodeFileSystem` `constructor`, new exported
  `NodeFileSystemOptions`; `src/adapters/node/index.ts` re-exports the type next to the class);
  every construction site passing a second argument; `reports/api.json` regenerated.
- **Current signature** (`node-file-system.ts:524-530`):
  `constructor(rootDir: string | ReadonlyArray<string>, pathPolicy: PathPolicy = nativePolicy,
  fsOps: FsOperations = realFsOps, rootsArePreResolved = false, removeTreeConcurrency: number =
  REMOVE_TREE_CONCURRENCY)`. **New:** `constructor(rootDir, options: NodeFileSystemOptions = {})`
  with the D2 interface **minus `syncIo`** (P3 adds that member); each field defaults exactly as
  the positional parameter did, destructured in the constructor head.
- **Unchanged:** `FsOperations`, `realFsOps`, and the internal helpers that take an `fsOps`
  argument (`realpathNearestExisting(absolute, policy = nativePolicy, fsOps = realFsOps)`,
  called from `loadRootSet` `:592` and `resolveWrite`'s creation arm `:1192` with
  `this.pathPolicy, this.fsOps`).
- **Site clusters** (176 code sites in 12 files; ADR-883's 214 also counts doc mentions; 16
  single-argument sites stay as they are):

  | File | Sites | Shape today → after |
  |---|---|---|
  | `src/index.node.ts` `openRepository` `:108` | 1 | `(roots, nativePolicy, undefined, canonical)` → `(roots, { pathPolicy: nativePolicy, rootsArePreResolved: canonical })`; the `:106-107` comment about the `undefined` third argument goes |
  | `src/index.node.ts` `makeWorktreeFs` `:145` | 1 | `([...], nativePolicy)` → `([...], { pathPolicy: nativePolicy })`; the existing comment above the array argument stays attached to it |
  | `test/unit/adapters/node/node-file-system-injected.test.ts` | 117 | `(root, policy, fakeFsOps(…))` → `(root, { pathPolicy: policy, fsOps: fakeFsOps(…) })`; 3 four-argument sites add `rootsArePreResolved` |
  | `test/unit/adapters/node/node-file-system-rename-kinds.test.ts` | 35 | three-argument, as above |
  | `test/unit/adapters/node/node-file-system.test.ts` | 13 | 6 migrate (`(root, policy)` ×3, `(root, undefined, fsOps)` ×2, `(root, undefined, fsOps, undefined, concurrency)` ×1 → `{ fsOps, removeTreeConcurrency: concurrency }`); 7 single-argument |
  | `src/adapters/node/node-adapter.ts` `:76`, `test/integration/posix-only/*` (4), `win-only/*` (3), `sha256-object-format-interop.test.ts` (1) | 9 | single-argument, unchanged |

- **Public surface:** `NodeFileSystem` is exported through `tsgit/adapters/node`, so a consumer
  passing positional arguments breaks: the commit is marked breaking (`!`) and the changelog
  entry shows the before/after call.
- **Tests:** no new behaviour, so the only new rows are the constructor's own: each option
  absent → its documented default is used (one row per field, asserting the observable effect:
  native policy resolution, real fs reached, roots re-resolved, default removal width), and each
  option present → honoured. Existing suites pass unchanged in meaning.
- **Gate:** `npm run check:types`, `npm run check` (biome), and the touched suites
  (`node-file-system*.test.ts`, `index.node` tests, the integration files above on their OS).
- **Probe:** none (no runtime change); `git grep -c 'new NodeFileSystem('` recorded before and
  after to prove the site count.

#### P2 — `TurnBudget`, `SyncIoPolicy`, `SyncFsOperations`

- **Files:** new `src/adapters/node/sync-io-budget.ts` (`TurnBudget`, `SyncIoPolicy`,
  `createTurnBudget`, `createSyncIoPolicy`, the 1 ms / 64 KiB constants of ADR-880);
  `src/adapters/node/fs-operations.ts` (add `SyncFsOperations`, `realSyncFsOps`).
- **Signatures:** D1 and D2's `SyncFsOperations` verbatim. `createTurnBudget(budgetMs, clock?,
  scheduleTurnEnd?)`; `createSyncIoPolicy(): SyncIoPolicy` (no parameters: the values are
  internal constants, ADR-880/881).
- **Tests:** new `test/unit/adapters/node/sync-io-budget.test.ts` with an injected clock and
  `scheduleTurnEnd` (collect callbacks, fire manually). Rows: under budget → `admit()` is
  `undefined`; at/over budget → the same promise for N callers; marker fires → spent resets and
  the promise resolves; one marker armed per turn; charge accumulates the clock delta.
  Mutation: the `>=` boundary needs an exactly-at-budget row.
- **Probe:** micro-bench of `admit()+charge()` overhead per op (expect ≤ 0.15 µs).

#### P3 — `NodeFileSystem` sync arms

- **Files:** `src/adapters/node/node-file-system.ts` (`NodeFileSystem` constructor, `read`,
  `readSlice`, `readUtf8`, `exists`, `lexists`, `isPresent`, `stat`, `lstat`, `readlink`,
  `openWithNoFollow` → `wrapNodeHandle`, `canonicalizeRoots`; new private `runSync`,
  `readRegularSmall`); `test/unit/adapters/node/node-fs-fakes.ts` (add `fakeSyncFsOps`).
- **Current signatures being changed:** `NodeFileSystemOptions` (after P1) gains
  `readonly syncIo?: SyncIoPolicy`, stored as the private `syncIo` field the D1 arm pattern reads.
  `function wrapNodeHandle(handle: fsPromises.FileHandle): FileHandle` gains `(handle, syncIo?:
  SyncIoPolicy)`.
- **Tests:** `test/unit/adapters/node/node-file-system.test.ts` calls
  `fileSystemContractTests(createSut)` a second time with a policy-bearing sut (the dual-mode
  requirement, R5). `node-file-system-injected.test.ts` gets one describe per arm: sync path taken
  (fake sync op called, async op not); budget exhausted → awaits the injected turn; errno
  table → identical codes; FIFO (fake `fstatSync` non-regular) → async fallback, and the fd is
  closed; above gate → async fallback; growth between fstat and EOF check → async fallback;
  `read` view vs copy on the async arm. A real FIFO row (a named pipe, posix-only): `readUtf8` on the
  FIFO with a writer attached resolves, and the loop keeps ticking meanwhile (a timer fires).
- **Probe:** `bench:ab` `rev-parse`, `cat-file`, `loose-read`, `status`; trace shim on
  `revParse('HEAD')` both modes. Run `test:parity:workers|deno|bun` (the adapter changed).

#### P4 — Option plumbing and the open path

- **Public option (ADR-881):** `readonly io?: 'sync-fast-path' | 'threadpool'` on
  `OpenNodeRepositoryOptions` (`src/index.node.ts`) and `NodeAdapterOptions`
  (`src/adapters/node/node-adapter.ts`), default `'sync-fast-path'`. `openRepository` strips it
  before forwarding to the core (the existing `const { cwd: _cwd, allowInsecureHttp: _a, … }`
  destructure). `'threadpool'` builds no `SyncIoPolicy`: the layout probe, the main adapter and
  every worktree adapter receive `undefined`.
- **Files:** `src/index.node.ts` (`OpenNodeRepositoryOptions`, `openRepository`,
  `nodeLayoutProbe` → a factory `createNodeLayoutProbe(syncIo?: SyncIoPolicy)`, `canonicalize`,
  `resolveNodeLayout`, `isDerivedFromCanonicalCwd`, `makeWorktreeFs` — both constructions pass
  `{ …, syncIo }` into the P1 options object);
  `src/adapters/node/node-adapter.ts` (`NodeAdapterOptions`, `createNodeContext`);
  `src/repository/validate-options.ts` (`ValidatableOptions` gains `io`; new `validateIo`
  following `validateBareRepositories`: `invalidOption('io', "must be 'sync-fast-path' or
  'threadpool'")`);
  `src/repository/find-layout.ts` (`findLayout`, `layoutFor`, `hasValidHead`, `resolveCommonDir`,
  `sharedDirsValid`); `src/repository/trust-verdict.ts` (`evaluateTrust`);
  `src/ports/layout-probe.ts` (`stat` result gains `isSymbolicLink` for the lstat-first probe —
  an internal port, not published).
- **Tests:** `test/unit/repository/find-layout.test.ts` (decision order under batching: a HEAD
  symlink with `refs/` text wins even when `stat(HEAD)` fails; the content read never runs on a
  non-file; the commondir-present path ignores the speculative stats);
  `test/unit/repository/resolve-layout-trust.test.ts` (first foreign path in order is reported
  when two are foreign); `test/unit/adapters/node/node-adapter.test.ts` + an `index.node` test
  (`io` absent and `'sync-fast-path'` build one policy; `io: 'threadpool'` wires no policy
  anywhere; the worktree fs shares the main adapter's budget);
  `validate-options` rows (`'sync-fast-path'` and `'threadpool'` accepted; any other string, a
  boolean and a number each refused `INVALID_OPTION` with the `io` data, one row per operand).
- **Docs (R13):** `docs/get-started/node.md` and `docs/understand/performance.md` describe the
  two modes and when to pick `'threadpool'`; `reports/api.json` regenerated.
- **Probe:** trace shim on open (13 → 12, serial rounds with `io: 'threadpool'`);
  `loose-read.bench` fresh-open row `bench:ab`.

#### P5 — `tryLstat` / `tryReadUtf8`

- **Files:** `src/ports/file-system.ts`; `src/adapters/node/node-file-system.ts`;
  `src/adapters/memory/memory-file-system.ts`; `src/adapters/browser/browser-file-system.ts`;
  `src/repository/wrap-fs-validator.ts` (forward like `lexists`, `:40-55`);
  `src/application/primitives/internal/read-capped-file.ts` `loadCappedUtf8`;
  `config-scoped-read.ts`, `shallow-file.ts`, `read-sparse-checkout.ts` (their
  `FILE_NOT_FOUND` catches); `reports/api.json` regenerated.
- **Tests:** `test/unit/ports/file-system.contract.ts`: rows that `tryX` equals the
  `X`-with-catch fallback on absent, present, dangling link, `ENOTDIR` ancestor and
  permission-denied (posix-only). The ADR-873 equivalence becomes a contract row. Callers get one
  row with the method removed (fallback path) and one with it present.
- **Probe:** `status.bench` `bench:ab`; unit count of `TsgitError` constructions in a 200-directory
  status (spy on the error factory): 200 → 0.

#### P6 — Pack-first, shared listing, pack-dir fault fold, `hasObject`, prefix scan

- **Files:** `src/application/primitives/object-resolver.ts` (`resolveObjectContentWithDepth`
  `:68-131`, arms swapped; `tryLoose` unchanged); `pack-registry.ts` (`createStoreGate`,
  `scanPacks`, `isMissingPackDir` → fold per ADR-887: every listing fault becomes an empty
  listing plus one `ctx.logger?.warn` per generation carrying the fault; new `packDirListing`
  memo cleared in `refresh()`); `internal/midx-source.ts` (`loadMidxSet(ctx, packsDir, listing)`, `probeFlat`,
  `readChainManifest`); `internal/loose-oid-cache.ts` (doc); `has-object.ts`;
  `resolve-oid-prefix.ts`.
- **Tests:** `test/unit/application/primitives/object-resolver.test.ts` (a packed hit never lists
  the fanout; a pack miss falls to loose; a corrupt loose copy of a packed object is never read);
  `pack-registry.test.ts` (one `readdir` shared by gate and scan; midx `stat` only when the
  listing has an entry; a symlink entry still stats; each listing fault — `FILE_NOT_FOUND`,
  `NOT_A_DIRECTORY`, `PERMISSION_DENIED`, an unmapped errno — yields an empty listing, and
  `ctx.logger.warn` is called once with the fault even across two lookups; no logger → no throw);
  `midx-source` tests (listing parameter);
  new `test/integration/object-precedence-interop.test.ts` (rows O1–O3, P1–P3, D1–D4 against real
  git, reconstructing git's answer from structured fields; the chmod rows are posix-only and
  skipped when `process.getuid() === 0`); `midx-interop.test.ts` (symlinked midx row).
- **Probe:** trace shim R8 (16 → ≤ 12); `midx-lookup.bench` loose-only rows and `pack-read.bench`
  cold rows `bench:ab`. A loose-only cold read must not regress: it trades 2 stats for 1 readdir.

#### P7 — Held-handle header and size, lazy `.idx`

- **Files:** `pack-registry.ts` (`loadPack`: `headerMemo`, `buildOffsetTable`, new `sizeMemo`;
  `lookupViaIndexedSnapshot` + `lookupViaUnclaimedPacks` → one lazy loop; `unclaimedIndexOrSkip`);
  `internal/pack-generation.ts` (`resolveIndexes` through `boundedMapFor`, order-preserving).
- **Tests:** `pack-registry.test.ts`: header and size issue no path `open`/`stat` when a handle
  exists; the browser-shaped fallback (`openWithNoFollow` → `UNSUPPORTED_OPERATION`) still reads
  header and size by path; a 3-pack no-midx lookup hitting pack 1 loads 1 `.idx`; a corrupt pack-1
  `.idx` warns once, and the hit comes from pack 2; `resolveIndexes` parallel output order and warn
  order equal candidate order under a deliberately reversed completion order (injected delays).
- **Probe:** trace shim R9 on `many-pack-no-midx-v3`; `midx-lookup.bench` no-midx rows.

#### P8 — Window cache and git's window keys (ADR-882)

- **Files:** new `src/application/primitives/internal/pack-window-cache.ts` (`createPackWindowCache
  ({ windowBytes, limitBytes })` → `read(pack, offset, length, load)` + `clear()`; named
  constants `DEFAULT_PACK_WINDOW_BYTES` = 64 KiB and `DEFAULT_PACK_WINDOW_LIMIT_BYTES` = 16 MiB);
  `pack-registry.ts` (`readSlice` through the cache, cleared in `refresh()`/`dispose()`; the
  effective sizes are `min(default, key)`); `config-read.ts` (two finders for
  `core.packedGitWindowSize` / `core.packedGitLimit` reusing the `pack.windowMemory`
  unsigned-long grammar of `findFirstInvalidPackInt`); `internal/repo-state.ts`
  `assertEagerConfigValid` (sixth candidate, `configBadNumericValue`, lowest-line ordering via
  `pickLowerLine`). No public option: `index.node.ts`, `node-adapter.ts` and `context.ts` are
  untouched (ADR-882).
- **Tests:** unit cache rows (contained request → view without load; crossing request → one
  page-aligned load; `len > W` → bypass; LRU eviction across two packs at the limit; `clear()`
  empties; a replaced pack after `refresh()` never serves stale bytes); clamp rows (a key below a
  default lowers it; a key above a default is clamped to the default; the boundary value equal to
  the default); eager-tier rows (a malformed key refuses `CONFIG_BAD_NUMERIC_VALUE` on a read
  command; lowest-line ordering against an earlier and a later malformed `core.compression`);
  interop rows for the malformed keys (the D7 pin table), reconstructed through
  `CONFIG_BAD_NUMERIC_VALUE` data.
- **Probe:** `delta-chain-read.bench` cold/warm/8-tips and `pack-read.bench` spread row, both
  modes; `log.bench`; trace R10.

#### P9 — Constant-factor riders (Node, domain)

- **Files:** `internal/concurrency-limiter.ts`; `internal/blob-source.ts`; `adapters/adler32.ts`
  (+ new `test/unit/adapters/adler32.properties.test.ts`); `adapters/inflate.ts`
  (`GrowableBuffer`, `inflateZlibMember`); `adapters/node/node-compressor.ts` (`inflate`,
  `createInflateStream` only).
- **Tests:** per D9's guard column.
- **Probe:** `adapter-inflate.bench` bundled rows; 40k-task limiter micro-probe;
  `diff-whitespace.bench`.

#### P10 — Browser riders and harness

- **Files:** `browser/browser-file-system.ts`; `browser/browser-hash-service.ts`;
  `tooling/profile-registry.ts` (new `open` workload; `pack-read` re-pointed at the packed read
  on an already-open repository, ADR-892); `docs/perf/baseline.*` regenerated.
- **Tests:** browser contract suite (`npm run test:e2e`, chromium + firefox locally; WebKit
  per the 1.62.1 note); a Playwright row counting `getFile()` calls for a depth-10 chain read.
- **Probe:** Playwright timing of the depth-10 chain before and after (local, recorded
  unpublished).

### Self-review log

- **Pass 1** found that the brief's "git is pack-first" was stated from memory, pinned it, found
  the streaming split, and moved `blob-source` out of the swap. It also found that pack-first
  exposes loose reads to `objects/pack` faults, and pinned D1–D5.
- **Pass 2** found that a raw sync `open` would drop the `FileHandle` GC safety net (DC-5), and
  that a FIFO would block the loop on `openSync` without `O_NONBLOCK` (R6). It also found that
  the old fs-count shim is blind to sync arms (D10).
- **Pass 3** found that git's window numbers are mmap reservations, not heap sizes (DC-2 splits
  "honour key" from "default"), and that the knobs are an **eager**-tier class, not a
  repo-settings one. It confirmed that the window cache's Node win is small under sync and argued
  its scope from the opt-out and browser paths.
- **Revision (decisions phase, ADR-879…892)** renamed the public option to `io?: 'sync-fast-path'
  | 'threadpool'` (ADR-881), moved `NodeFileSystem` to one options object with the site migration
  as a new mechanical P1 (ADR-883; parts 9 → 10, old P1–P9 → P2–P10), fixed the window defaults,
  clamp and eager refusal (ADR-882, no public window option, so P8 no longer waits on P4), named
  `ctx.logger?.warn` for the pack-directory fold (ADR-887), re-pointed `pack-read` (ADR-892),
  made P10 follow P5 (both edit `browser-file-system.ts`), and settled every decision candidate.

## Decision candidates

The sync fast path itself is **decided** (option (a), 2026-09-10) and is ratified as
**ADR-879**, not listed here. Every candidate below is now settled by ADR-880…892; the
"Recommendation" and "Why" columns are kept as the design-time record, and the "Settled" column
is binding. Two outcomes deviate from the recommendation (DC-1b, DC-3) and this revision carries
them through D0–D12. **No open decision candidates remain.**

| # | Choice | Alternatives (≤3) | Recommendation | Why | Settled |
|---|---|---|---|---|---|
| DC-1 | Budget value, size gate, budget mechanism | (a) 1 ms time-based budget, 64 KiB gate; (b) 2 ms / 128 KiB; (c) op-count budget (≈ 700 ops/turn), 64 KiB | **(a)** | The review's measured shape. The clock costs 0.13 µs per op against 1.1–1.4 µs ops. A count budget mis-sizes on slow disks, which is exactly where the bound matters. 64 KiB covers HEAD, refs, config, packed-refs, small `.idx`, `.rev` on small packs. | ADR-880 — (a), adopted as recommended |
| DC-1b | Public option name and shape | (a) `syncIo?: boolean` (default `true`) on `OpenNodeRepositoryOptions` and `NodeAdapterOptions`, values internal constants; (b) `io?: 'sync-fast-path' \| 'threadpool'`; (c) `syncIo?: false \| { budgetMs?: number; maxReadBytes?: number }` | **(a)** | Matches the house `hooks?: boolean` / `command?: boolean` shape. Exposing the tuning numbers (c) is YAGNI until a user reports a filesystem where the constants are wrong. (c) stays additive later. | ADR-881 — **(b)**, user judgment (deviates): `io?: 'sync-fast-path' \| 'threadpool'` |
| DC-2 | Window cache knobs and values | (a) tsgit-only options (`packWindowBytes`, `packWindowCacheMaxBytes`), git keys ignored as today; (b) honour `core.packedGitWindowSize` / `core.packedGitLimit` as **upper bounds** clamped by tsgit defaults (64 KiB window, 16 MiB limit), plus the eager refusal class; (c) (b) + explicit options that suppress the keys (ADR-858 precedent) | **(b)** | Git's key names and grammar (ADR-773 precedent) close a pre-existing refusal gap (pinned: every command dies on a malformed value). git's defaults are mmap figures, so tsgit keeps heap-sized defaults and only lets a user shrink them. An option override (c) has no requester. The 64 KiB vs 256 KiB window is settled by P8's probe on the spread row before merge. | ADR-882 — (b), user judgment, as recommended |
| DC-3 | `FsOperations` widening (ADR-047) | (a) separate `SyncFsOperations` type + optional sixth constructor parameter `syncIo?: SyncIoPolicy`; (b) same type, but convert the four trailing positional parameters into one options object; (c) add sync members to `FsOperations` itself as optional properties | **(a)** | Absent → today's path, so every existing double works unchanged. Keeps `FsOperations` a pure `Pick<typeof fsPromises>`. (b) is cleaner, but it churns 176 `new NodeFileSystem(` sites (mostly tests) for no behaviour. (c) mixes two modules in one `Pick` and makes "has sync" a per-method question. | ADR-883 — **(b)**, user judgment (deviates): options object, migration as P1 |
| DC-4 | Expected-miss cost | (a) optional `tryLstat` / `tryReadUtf8` port methods, ADR-873 shape, fallback in callers; (b) cheap stack-free `FILE_NOT_FOUND` construction inside the adapters (no port change); (c) both | **(a)** | The miss answer becomes data rather than an error, and stacks stay intact for real faults. (b) silently drops stacks on every not-found, including unexpected ones. Loose-ref misses (`openWithNoFollow`) stay uncovered; a `tryOpenWithNoFollow` is a follow-up if P5's probe shows ref misses matter. | ADR-884 — (a), adopted as recommended |
| DC-5 | Held-handle open | (a) async `open` (keeps `FileHandle`'s GC close), sync `read`/`fstat` via `handle.fd`; (b) fully sync raw fd (`openSync`), wrapped in the port `FileHandle`; (c) async everything on handles | **(a)** | The review's measured patch was (a): pread was the cost, open is one hop per pack/HEAD. (b) saves one hop per open but turns a forgotten `close` into a silent fd leak (no GC close hook). This repo has already paid for the FileHandle leak class once. | ADR-885 — (a), adopted as recommended |
| DC-6 | `readdir` sync arm | (a) out, stays pooled; (b) in, gated by an entry-count probe; (c) in, unconditionally | **(a)** | Not in the decided set. Its entry count is unbounded (a 256-dir fanout, `objects/pack` with thousands of packs). After P6 the cold path does 1–2 `readdir` calls. Revisit only if a trace shows serial `readdir` calls dominating. | ADR-886 — (a), adopted as recommended |
| DC-7 | Unusable `objects/pack` under pack-first | (a) fold every listing fault into an empty listing + logger `warn` carrying the fault (loose served, packed → `OBJECT_NOT_FOUND`); (b) catch on the pack-first arm, try loose, rethrow the listing fault if loose misses (keeps today's `PERMISSION_DENIED` for packed objects); (c) propagate (loose reads start refusing) | **(a)** | git's pinned shape on D1–D3 (error line, loose served, packed "not a valid object name"). (c) is a regression. (b) keeps a tsgit-only refusal code for no git reason. | ADR-887 — (a), adopted as recommended |
| DC-8 | Browser scope | (a) directory-handle LRU + hex table + single-copy streaming hasher, no `createSyncAccessHandle`; (b) (a) + memoised sync access handle per pack in dedicated workers; (c) defer all browser items | **(a)** | (a) is pure call-count/CPU work, testable in Playwright. Sync access handles exist only in dedicated workers and take an exclusive lock per file (a second tab or reader fails). That is a new failure surface that needs its own ADR and a real-browser host this slice does not have. | ADR-888 — (a), adopted as recommended |
| DC-9 | adler32 / `GrowableBuffer` rider | (a) in (P9, isolated, bit-identical, property-pinned); (b) defer to 31.6 with the compressor work | **(a)** | No file overlap with 31.6 (`adler32.ts`, `GrowableBuffer`). The measured 55 % self time of the bundled decoder is independent of the Node I/O work, and the property test proves identity. | ADR-889 — (a), adopted as recommended |
| DC-10 | Budget scope | (a) one budget per repository, shared by its layout probe and all its adapters; (b) one process-wide module singleton; (c) one per `NodeFileSystem` instance | **(a)** | (b) is mutable module state shared across unrelated repositories and test files. (c) lets a repository's worktree adapter and main adapter each take a full budget. (a) bounds the stall at 1 ms × concurrently active repositories, which is documented. | ADR-890 — (a), adopted as recommended |
| DC-11 | Seed the session config cache from the open-time `.git/config` read | (a) seed (the first command's gate stat then matches and skips the `readFile`); (b) leave, record as follow-up | **(b)** | It saves one `readFile` per open, but it crosses ADR-850's epoch contract and 31.2's cache ownership. It deserves its own small design rather than a rider. | ADR-891 — (b), adopted as recommended |
| DC-12 | `profile` workload for open | (a) add an explicit `open` workload, keep `pack-read`; (b) rename `pack-read` → `open-read`; (c) leave | **(a)** | Keeps the `pack-read` baseline series continuous and gives open its own honest profile. | ADR-892 — (a), adopted as recommended |

## Test strategy

- **Contract, both modes (R5).** `fileSystemContractTests` runs twice for Node, policy absent
  (`io: 'threadpool'`) and policy present (`'sync-fast-path'`), on every CI OS (windows-latest included). New `tryLstat`/`tryReadUtf8`
  equivalence rows run for all three adapters. ADR-812/824 rows stay exact-code.
- **Injected unit (ADR-047, ADR-883).** `node-file-system-injected.test.ts` + `fakeSyncFsOps`,
  passed as `{ fsOps, syncIo }`: one describe
  per arm × {sync taken, budget wait, errno table, non-regular fallback, above-gate fallback,
  growth fallback}. Every guard gets an isolated row for each operand (mutation pattern:
  `isFile && size <= gate` needs a non-file-small row **and** a file-large row).
- **Budget.** Pure unit with an injected clock and scheduler, plus one real-timer integration row
  (a timer scheduled before a 5000-lstat sweep fires before the sweep ends).
- **FIFO (posix-only).** A real named pipe; the loop keeps ticking while a read is pending.
- **Interop (faithfulness).** `object-precedence-interop.test.ts`: every D5 row, built in a
  `mktemp -d` repository by real git (scrubbed env, isolated `HOME`, signing off). The impostor
  objects are written with `zlib` directly, and each result is compared against git's own answer
  for the same command class. Window-key refusal rows (D7 table) are asserted on
  `CONFIG_BAD_NUMERIC_VALUE` `data` (key, source, value, reason), never on message text alone.
  `beforeAll` hooks get explicit 60 s timeouts (memory: validate concurrency).
- **Registry.** fs-call-shaped unit assertions through `instrumentedContext` (the 31.2 helper,
  `test/unit/application/primitives/fixtures.ts`): exact call names and counts per R8–R10.
- **Properties.** `adler32.properties.test.ts` (reference equality, lengths around NMAX multiples);
  a limiter FIFO property (admit order = release order for arbitrary interleaved orders). No new
  parser, so no other property sibling is owed. The window cache's contained-request identity
  (`read(o, l)` equals the bytes of a direct read at `(o, l)` for arbitrary `(o, l)` inside the
  file) is a property over a generated byte file.
- **Parity runtimes.** `test:parity:workers|deno|bun` after P1, P3, P5, P6 and P8 (adapter or
  registry change; they are not in `validate`).
- **Mutation.** Scoped Stryker per part (`.claude/workflow/mutation.md`), with a narrow vitest
  config per mutated file (CLAUDE.md debugging note). Equivalences expected and to be proven: the
  budget's `>=` vs `>` only if a row pins exactly-at-budget (write the row instead); the window
  alignment where `offset % W === 0`.

## Out of scope

- **Writes on the sync path.** Not in the decided set; writes are rare and not serial-hot.
- **`readdir` sync arm.** ADR-886; unbounded entry counts.
- **`createSyncAccessHandle`.** ADR-888; worker-only, exclusive-lock failure surface, no real-browser
  host here.
- **`streamInflate` per-entry cost and `crc32` port method.** 31.6 owns `node-compressor.ts:174-214`
  and the `Compressor` port change.
- **`.gitattributes` promise memo.** 31.5 per the backlog.
- **Config-cache seeding from the open-time read.** ADR-891; a backlog follow-up with its own design.
- **Pack re-scan on a miss.** A pre-existing divergence (git re-scans the pack directory before
  failing a lookup; tsgit re-scans only after a lazy fetch). Not pinned here; recorded.
- **midx-as-directory.** A pre-existing divergence (git dies, tsgit discards), pinned in D5 and
  unchanged.
- **`tryOpenWithNoFollow` for loose-ref misses.** ADR-884 follow-up, only if P5's probe shows it.
- **`status` refresh write-back, index extensions.** 31.4.
