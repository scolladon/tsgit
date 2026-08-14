# Design — cold-read first-access

> Brief: make tsgit's first object access pay-per-use instead of eagerly building the whole
> object-store scaffolding, correct the `readBlob:cold-cache` benchmark's unit-of-work
> asymmetry, and refresh `docs/understand/performance.md` with post-containment numbers.
> Status: draft → self-reviewed ×3

## Context

### Where this sits

The git-parity containment change (PR #273, `a4c924a7`) removed a per-read `realpath` that was
stricter than canonical git. Every benchmark scenario improved or held, and the remaining
`readBlob:cold-cache` deficit is now a **different** cost: one-time object-store setup paid
lazily inside the first object read.

Post-change CI nightly (`bench.yml` run 31818556244, 2026-08-14, `linux-x64`, AMD EPYC 7763,
Node 22.23.2, isomorphic-git 1.41.3). tsgit/iso, >1 means tsgit faster:

| Scenario | ratio |
|---|---|
| `readBlob:cold-cache` (fresh repo, empty LRU) | 0.39× ← primary target |
| `readBlob:cold-cache` (small pack) | 0.74× ← secondary target |
| `delta-chain` (cold) | 0.36× (out of scope — see below) |
| `status:clean` (medium / small) | 0.59× / 0.63× |
| `status:dirty-25-files` | 3.49× |
| `log:walk` (medium) | 18.56× |
| `readBlob:cold-cache` (medium pack) | 25.51× |

### Subsystems this touches

| Path | Role |
|---|---|
| `src/application/primitives/read-object.ts` | `readObject` / `readRawObject` / `getPackRegistry` / `refreshPackRegistry` / `disposePackRegistry` / `adoptPackRegistry` / `withLazyFetchRetry` |
| `src/application/primitives/object-resolver.ts` | `resolveObjectBytes` — the ordering site (line 61) |
| `src/application/primitives/internal/blob-source.ts` | `openBlobSource` — the **second** gate call site (line 86) |
| `src/application/primitives/pack-registry.ts` | `createPackRegistry`, `scanPacks`, `assertLoadable`, `refresh`, `dispose`, `RegisteredPack` |
| `src/application/primitives/internal/pack-generation.ts` | `PackGeneration`, `emptyGeneration`, `resolveIndexes`, `NO_PACKS` |
| `src/application/primitives/internal/midx-source.ts` | `loadMidxSet`, `probeFlat`, Tier-A/Tier-B classification (`tierOf`) |
| `src/application/primitives/internal/loose-oid-cache.ts` | ADR-509 fanout set — `probeLooseOid` / `invalidateLooseOid` / `forgetLooseOidPrefix` |
| `src/adapters/node/node-file-system.ts` | `loadRootSet` / `canonicalizeRoots` — root canonicalisation, paid on the first port call |
| `src/repository/layout-roots.ts` | `layoutRootsOf` — the containment-minimised root set |
| `src/index.node.ts` | `openRepository` shim, `resolveNodeLayout`, `canonicalize`, `nodeLayoutProbe` |
| `test/bench/loose-read.bench.ts` | the primary-target scenario |
| `test/bench/pack-read.bench.ts` | the secondary-target scenario |
| `docs/understand/performance.md` | published numbers + methodology |

### Prior decisions that constrain this design

- **ADR-226 / CLAUDE.md prime directive** — replicate canonical git's observable behaviour
  byte-for-byte unless an ADR diverges and says why.
- **ADR-249** — the byte-for-byte binding is on data, on-disk state and refusal conditions, not
  on human-readable stdout. tsgit's analogue of git's stderr diagnostics is a structured
  `ctx.logger.warn` call, not a rendered line.
- **ADR-509** — loose-first object-store precedence is pinned; the per-object probe is the
  per-fanout-dir `readdir`-backed membership set. Pack-first reordering is foreclosed unless a
  future ADR revisits it. This design does **not** revisit it.
- **ADR-510** — persistent per-pack `FileHandle`s; `refresh()`/`dispose()` own their lifecycle.
- **ADR-483** — published benchmark numbers are hand-transcribed from a dated CI nightly
  artifact, never a local run.
- **ADR-501 / ADR-505** — `docs/perf/hot-paths.json` is derived from nightly absolute timings
  and re-derived per major version.
- **`docs/design/checkcontainment-hot-path.md` Lever 5c** — the trusted-internal-path fast-path
  must arrive as its own security-reviewed proposal with an explicit trust boundary and user
  sign-off. Out of scope here (see *Out of scope*).

### The load-bearing tension the brief asked to resolve

`object-resolver.ts:58-61` justifies calling `registry.assertLoadable()` **before** the
empty-tree short-circuit, the `deltaCache` probe and `tryLoose`:

> "Git dies during object-store setup, ahead of every read — a structurally self-inconsistent
> multi-pack-index must deny loose reads too, so this gate sits before the empty-tree
> short-circuit and the deltaCache probe."

The brief asserts the opposite: "canonical git reads a loose object without enumerating packs".
Both cannot be right. They were pinned against the real binary — see §2. **The in-code comment is
right and the brief's premise is wrong**, but only for the multi-pack-index; the rest of the
pack-store scaffolding *is* deferrable, and deferring it removes two places where tsgit is
currently **stricter** than git.

---

## Requirements

When this ships:

1. A first `readObject`/`readRawObject`/`openBlobSource` that **hits** a loose object performs no
   `objects/pack` directory listing and constructs no `RegisteredPack`.
2. A structurally self-inconsistent (Tier-A) multi-pack-index still denies **every** read,
   loose ones included, with the same `INVALID_MULTI_PACK_INDEX` error data as today.
3. A Tier-B midx fault is still discarded in favour of the next source, still does not deny a
   loose read, and **still emits its `packRegistry: discarding unusable multi-pack-index` warn on
   a loose hit** — git prints its Tier-B midx diagnostic on a loose read (Pin B rows A4/E3), so
   this warn must not become collateral damage of the deferral.
4. Loose-first precedence (ADR-509) and the readdir-backed fanout membership set are unchanged.
5. `refresh()` invalidates both the store gate and the pack scan together; no read can pair one
   generation's midx with another generation's packs.
6. `dispose()` still closes every persistent pack handle, and still opens nothing for a Context
   that never touched a pack.
7. Partial-clone lazy-fetch retry (`withLazyFetchRetry`) is unchanged: an `OBJECT_NOT_FOUND`
   after a loose miss still reaches `registry.lookup`, still triggers `promisor.fetch`, still
   calls `registry.refresh()`, still retries exactly once.
8. A pack directory that cannot be listed (`EACCES`) no longer denies a loose read — matching
   git (pinned, §2 row C4/E5).
9. `test/bench/loose-read.bench.ts` is preserved unchanged in intent; the unit-of-work asymmetry
   is either given a companion scenario or documented, or both (DC-4).
10. `docs/understand/performance.md` carries post-change numbers from one dated nightly, its
    pre-change banner removed and its causal story rewritten.
11. Absolute wall-clock `main`-vs-branch deltas are reported. No self-share percentages.

---

## Design

### §1 The traced first-access cost — measured baseline

**How measured.** `openRepository`+`readBlob`×2+`dispose` against the `setupSmallRepo({commits:50})`
fixture reproduced verbatim from `test/bench/fixtures.ts`, 150 warmup iterations then 600 measured
iterations, `performance.now()` around each phase, on this laptop (darwin 25.5.0, arm64,
Node 22.22.3). Syscall inventories come from a counting `fsOps` injected through
`NodeFileSystem`'s third constructor parameter, with the **production** root set
(`layoutRootsOf({workDir, gitDir})`). Component costs are from a second run of 4000 iterations
each after warmup.

> **These numbers are directional only and must never be published.** The citable source is the
> CI nightly `bench.yml` artifact (ADR-483). They exist to locate cost and to be re-measured
> `main`-vs-branch on the same machine after each change.

#### §1.1 Phase breakdown (ms/iteration, n=600)

| Phase | ms | note |
|---|---|---|
| `openRepository` | 0.1333 | |
| **first `readBlob`** | **0.2113** | ← the target |
| second `readBlob` | 0.0862 | same handle, steady state |
| `dispose` | 0.0124 | |
| total | 0.4432 | what the bench scenario measures |

This reproduces the brief's split (0.141 / 0.209 / 0.085 / 0.013) within run-to-run variance.
The **first-vs-second delta is 0.1251 ms** — the one-time cost to account for.

#### §1.2 Raw `node:fs` syscalls, production root set

First `readBlob` — **7 syscalls**; second `readBlob` — **1**:

```
realpath(<repo>)                                          ← NodeFileSystem.loadRootSet
stat(<repo>/.git/objects/pack)                            ← scanPacks: ctx.fs.exists
stat(<repo>/.git/objects/pack/multi-pack-index)           ← loadMidxSet: probeFlat
readdir(<repo>/.git/objects/pack)                         ← scanPacks: ctx.fs.readdir
stat(<repo>/.git/objects/pack/multi-pack-index.d/multi-pack-index-chain)  ← loadMidxSet: chain
readdir(<repo>/.git/objects/c2)                           ← probeLooseOid  (ADR-509)
readFile(<repo>/.git/objects/c2/981a…)                    ← readLooseCompressed
```

**Only the last two produce the answer.** Four of seven are object-store setup; the fifth
(`realpath`) is root canonicalisation (§4).

The same trace through `ctx.fs` (port level) on a **repacked repo with a healthy midx**, reading
a **loose** oid, is 6 calls — identical shape, with `read(multi-pack-index)` replacing the
absent-chain stat. Reading a **packed** oid is 10 calls: the same 5 setup calls, then five calls
replacing the single loose `read` — `stat` + `read` of the `.idx`, `readSlice` and `stat` of the
`.pack`, and `openWithNoFollow`.

> **Gotcha for anyone re-running this.** The fanout membership set is memoised per `Context`
> and is invalidated only by tsgit's own `writeObject`. A probe that writes objects with real
> `git` subprocesses **must build a fresh `Context` after those writes**, or the membership set
> is stale and the trace is wrong. Every trace above does this.

#### §1.3 Component costs, measured in isolation (ms/iter, n=4000)

| Operation | ms | removable? |
|---|---|---|
| `ctx.fs.exists(objects/pack)` | 0.0110 | **yes** — §3 |
| `ctx.fs.readdir(objects/pack)` | 0.0300 | **yes** — §3 |
| `ctx.fs.stat(objects/pack/multi-pack-index)` (ENOENT) | 0.0211 | no — pinned, §2 |
| `ctx.fs.stat(…/multi-pack-index.d/multi-pack-index-chain)` (ENOENT) | 0.0181 | no — pinned, §2 |
| the four above, in the current sequencing | 0.0644 | |
| `ctx.fs.readdir(objects/xx)` (fanout probe) | 0.0282 | no — ADR-509 |
| `realpath(workDir)` — the production root | 0.0163 | **yes** — §4 |
| `realpath(gitDir)` — a second root only on a linked worktree | 0.0173 | **yes** — §4 |
| `ctx.fs.read(loose path)` direct | 0.0555 | no |

**Accounting for the 0.1251 ms delta:** 0.0644 (registry probes) + 0.0282 (fanout readdir) +
0.0163 (one redundant root realpath) = **0.109 ms**, i.e. 87% of it. The ~0.016 ms remainder is
JavaScript construction: the `createPackRegistry` closure set, four `createPromiseMemo`
instances per generation, the `fileNames` `Set`, and the fanout `Set`.

**Correction to the brief's pre-chewed context.** `read-object.ts:140`'s
`getPackRegistry(ctx)` is *not* the eager cost — `createPackRegistry` performs no I/O; it only
builds closures. The I/O is entirely inside `resolveObjectBytes`'s `await registry.assertLoadable()`
(`object-resolver.ts:61`) and its twin in `openBlobSource` (`blob-source.ts:86`), both of which
force `currentGeneration()` → `scanPacks`.

Note also that `layoutRootsOf` collapses a **normal** repo to a single root (`gitDir` is
contained in `workDir`), so there is one redundant realpath, not two. A **linked worktree**
resolves to `[workDir, commonDir]` — two roots, two realpaths, both already canonicalised
upstream.

---

### §2 Git faithfulness matrix — pinned, not remembered

**Binary:** `git version 2.55.0`, `/opt/homebrew/bin/git`, darwin arm64.
**Method:** every probe ran in a `mktemp -d` throwaway with an isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1` and every other `GIT_*` scrubbed. Never inside a worktree — a worktree
shares `.git/config` with the main checkout and every sibling through the common dir.
**Fixture:** three packed commits, `git repack -adq`, `git multi-pack-index write`, then one
**loose** object written with `git hash-object -w --stdin`. Each row reports
`git cat-file -p <loose-oid>` (the loose read) and `git cat-file -t <packed-oid>` as a control.

#### Pin A — a structurally self-inconsistent multi-pack-index **denies the loose read**

| # | Store fault | loose read | stderr |
|---|---|---|---|
| A1 | midx signature corrupted | **exit 128, no output** | `fatal: multi-pack-index signature 0x58585858 does not match signature 0x4d494458` |
| A2 | midx version byte → 9 | **exit 128, no output** | `fatal: multi-pack-index version 9 not recognized` |
| A3 | midx fanout corrupted mid-file | **exit 128, no output** | `error: oid fanout out of order: fanout[19] = ffffffff > 0 = fanout[20]` + `fatal: multi-pack-index required OID fanout chunk missing or corrupted` |

The control (packed read) produces byte-identical stderr in all three. **The in-code
justification at `object-resolver.ts:58-61` is empirically correct: the midx gate must stay ahead
of `tryLoose`.** The brief's premise — that git reads a loose object without consulting the pack
store — is false at 2.55.0 for the midx.

tsgit's current behaviour matches: a Tier-A signature corruption makes a **loose** read throw
`{ code: 'INVALID_MULTI_PACK_INDEX', check: 'signature' }`, exactly as the packed read does.

#### Pin B — every *other* object-store fault **serves the loose read**

| # | Store fault | loose read | stderr | tsgit today |
|---|---|---|---|---|
| A4 | midx truncated to 40 B (Tier B) | exit 0, content | `error: improper chunk offset(s) 48 and 7c` | serves; **warns** `discarding unusable multi-pack-index` |
| E3 | `multi-pack-index.d/` chain file garbage, no flat | exit 0, content | `warning: multi-pack-index chain file too small` | serves; **warns** `discarding unusable multi-pack-index` |
| C1 | `.idx` signature corrupted, no midx | exit 0, content | `error: non-monotonic index …idx` (×2) | serves, emits no warn |
| C2 | `.idx` truncated to 20 B, no midx | exit 0, content | `error: index file …idx is too small` (×2) | serves, emits no warn |
| C3 | `.idx` unreadable (`chmod 000`), no midx | exit 0, content | *(silent)* | serves |
| C5 | `.pack` deleted (orphan `.idx`), no midx | exit 0, content | *(silent)* | serves, warns `skipping pack index with no pack file` |
| C6 | `.idx` corrupted **and claimed by a healthy midx** | exit 0, content | *(silent)* | serves |
| E1 | healthy midx names a **deleted** pack | exit 0, content | *(silent)* | serves |
| E2 | healthy midx names a **renamed** pack | exit 0, content | *(silent)* | serves |
| E4 | no midx, healthy packs | exit 0, content | *(silent)* | serves |
| E6 | no `objects/pack` directory at all | exit 0, content | *(silent)* | serves |
| **E7** | **`objects/pack` replaced by a REGULAR FILE** | **exit 0, content** | `error: unable to open object pack directory: …: Not a directory` | **denied `NOT_A_DIRECTORY`** ← divergence |
| **C4/E5** | **`objects/pack` listing refused (`chmod 000`)** | **exit 0, content** | `error: unable to open object pack directory: …: Permission denied` | **throws `PERMISSION_DENIED`** ← divergence |

Two conclusions:

1. **Only the midx load+parse is a gate.** Everything else about the pack store — the directory
   listing, candidate construction, `.idx` parsing, pack binding — is invisible to a successful
   loose read's *outcome*. Git surfaces some of it as stderr diagnostics; under ADR-249 tsgit's
   analogue is a `ctx.logger.warn`, which is data, not stdout bytes.
   **Corollary for the seam:** git's *midx* diagnostics (rows A4/E3) DO appear on a loose read,
   while its *pack/`.idx`* diagnostics (rows C3/C5/C6/E1/E2) do not. The `packRegistry: discarding
   unusable multi-pack-index` warn therefore belongs on the gate side of the seam; the orphan-`.idx`
   warn belongs on the deferred side. Splitting them that way is what makes the deferral
   faithfulness-preserving rather than faithfulness-losing.
2. **tsgit is currently stricter than git in one place (C4/E5):** a pack directory whose listing is refused
   makes `scanPacks`'s `ctx.fs.readdir` reject, `assertLoadable` reject, and the loose read fail
   with `PERMISSION_DENIED` — where git serves the object with exit 0. Deferring the listing
   behind the loose miss **closes** this divergence rather than opening one.

#### Pin C — the diagnostic delta this design does *not* change

Rows C1/C2: git prints `error: non-monotonic index …` on a **loose** read; tsgit emits nothing,
because `scanPacks` never forces `generation.indexed` (`.idx` parsing is memoised behind
`indexed`, forced only by `lookup`/`all`/`health`). That divergence exists today, is a
diagnostic-only difference under ADR-249, and is **unchanged** by this design — the deferral
moves the readdir, not the `.idx` parse, which was already lazy.

Row C5: tsgit warns `packRegistry: skipping pack index with no pack file` on a loose read where
git is silent. After the deferral tsgit will be silent too — another divergence closed. Consumers
reading that warn on a loose-hit path lose it; they still get it on any read that reaches the
pack store.

---

### §3 The lazy split — one seam, per artefact

#### §3.1 What is eager today

`createPackRegistry`'s single `scan = createPromiseMemo(scanPacks)` produces a whole
`PackGeneration` in one shot. `scanPacks` does, in order:

```
ctx.fs.exists(packsDir)                     → emptyGeneration() when false
Promise.all([ loadMidxSet(ctx, dir),        ← the ONLY pinned part
              ctx.fs.readdir(dir) ])
fileNames = Set(entries.filter(isFile).map(name))
packs     = entries.filter(isCandidate).map(loadCandidatePack)   ← orphan warn fires here
midx      = bindMidx(ctx, packs, midxLoad.set, fileNames)
{ packs, midxLoad, midx, indexed, warnedIdx, fileNames, midxBitmap }
```

`assertLoadable()` is `await currentGeneration()` — it forces **all** of that, for its rejection
alone.

#### §3.2 The proposed seam

Split the one memo into two, with the gate as a strict prefix of the scan:

| Memo | Contents | Forced by | Cost on a loose hit |
|---|---|---|---|
| **`storeGate`** | `loadMidxSet(ctx, packsDir(commonGitDir(ctx)))` → `MidxLoadResult`, **plus the `discarding unusable multi-pack-index` warn loop over `midxLoad.faults`** | `assertLoadable()` and, transitively, the scan | 2 stats (no midx) / 1 stat + 1 read (flat midx) |
| **`scan`** (existing) | `readdir` + `fileNames` + candidate `packs` (**and the orphan-`.idx` warn**) + `bindMidx` + `indexed` + `midxBitmap`, consuming `storeGate`'s already-loaded `MidxLoadResult` | `lookup` / `all` / `health` / `indexFaults` / `midxHealth` / `midxBitmap` | **not forced** |

`assertLoadable()` becomes `await storeGate()` and keeps returning `void` — it must never become
a second way to reach the packs. Its doc gains the pinned fact: the gate is exactly the
multi-pack-index load, because that is exactly what git dies on.

**Where each warn lands is load-bearing, not incidental.** The `midxLoad.faults` warn loop
(`pack-registry.ts:486-491`) must move *into* the gate, because git emits its Tier-B midx
diagnostic on a loose read (Pin B, rows A4/E3). The orphan-`.idx` warn inside `loadCandidatePack`
must stay on the deferred side, because git is silent about it on a loose read (row C5). Getting
this backwards would trade a 0.041 ms win for a faithfulness regression. Cardinality is unchanged
either way: each warn still fires at most once per generation, and `refresh()` resets both.

`PackGeneration.midxLoad` stays a field on the generation, populated from the gate's resolved
value — so `computeMidxHealth`, which reads it, still sees one consistent verdict per generation.

**`ctx.fs.exists(packsDir)` disappears entirely.** Its only job was to short-circuit to
`emptyGeneration()`. `probeFlat` already maps `FILE_NOT_FOUND` to `{kind:'absent'}`, so a repo
with no `objects/pack` resolves through the gate with two ENOENT stats and no special case
(git agrees — row E6). The scan's own `ctx.fs.readdir` then needs the fault split the `exists`
gate used to hide:

| `readdir(objects/pack)` outcome | Scan behaviour | Why |
|---|---|---|
| `FILE_NOT_FOUND` / `NOT_A_DIRECTORY` | empty listing → `emptyGeneration()`-equivalent | what the removed `exists` guard produced **for the absent case only** (row E6). It did NOT produce this for a regular file at `objects/pack` — there `exists` returned `true` and the scan's own `readdir` rejected, denying every read. Row E7 pins git serving that shape at exit 0, so the fold is the faithful behaviour and the old guard was the divergence. |
| anything else (`PERMISSION_DENIED`, …) | **propagate** | the fault is real; it now reaches only the consumers that actually need the pack store |

That second row is where the **C4/E5 divergence closes**. A `chmod 000` on `objects/pack` today
makes `readdir` reject inside the eager scan and denies the loose read; afterwards the loose read
never lists the directory. The *gate* still probes it — `stat(objects/pack/multi-pack-index)`
returns `PERMISSION_DENIED`, which `isTierBMidxFault` already classifies as Tier B, so the gate
records a discard and resolves. The loose read then succeeds, exit-0-equivalent, exactly as git
does. **No new tolerance code is needed on the gate side; the existing Tier-B classifier already
covers it.**

#### §3.3 Invariants the seam must preserve

| Invariant | How the seam keeps it |
|---|---|
| **Tier-A denies every read** (Pin A) | The gate *is* `loadMidxSet`; a Tier-A error propagates out of it unchanged, so `assertLoadable` rejects before `tryLoose`, before the empty-tree short-circuit, before the `deltaCache` probe. Ordering inside `resolveObjectBytes` does **not** move. |
| **Tier-B is a recorded discard, with its warn** | `loadMidxSet` already folds Tier-B into `MidxLoadResult.faults`; the warn loop moves **into the gate** so it still fires on a loose hit, matching git (rows A4/E3). |
| **Terminal disposal binds the gate too** | The gate mirrors `currentGeneration()`'s post-dispose rule: once `disposed`, never start a new gate load — a populated memo keeps returning its value (including a pending load whose rejection reaches these callers as it reaches pre-dispose joiners), an empty one resolves to an empty `MidxLoadResult`. Without this a post-dispose read through a raw `Context` would start fresh midx I/O against a torn-down adapter. |
| **One generation never pairs one midx with another's packs** | The scan must capture the gate promise it awaited, and `refresh()` must clear **both** memos in one synchronous step. A scan in flight keeps its own captured `MidxLoadResult`; a scan started after `refresh()` gets a fresh gate. |
| **ADR-509 loose-first precedence** | `resolveObjectBytes`'s body order is untouched: gate → empty-tree → `deltaCache` → `tryLoose` → `registry.lookup`. Only what the gate *costs* changes. |
| **ADR-509 fanout membership set** | `probeLooseOid` / `invalidateLooseOid` / `forgetLooseOidPrefix` are untouched. |
| **ADR-510 handle lifecycle** | Handles live on `RegisteredPack`, which lives on the scan generation. `dispose()` keeps peeking the **scan** memo only — the gate holds no handles, so a Context that never reached the pack store still disposes without listing `objects/pack`. This gets *strictly better*: today a loose-only Context always scanned. |
| **`refresh()` closes outgoing handles** | Unchanged — it clears the scan memo and tracks the close batch; it additionally clears the gate. |
| **`withLazyFetchRetry`** | Unchanged. A loose miss still reaches `registry.lookup`, which forces the scan; `OBJECT_NOT_FOUND` still triggers `promisor.fetch` + `registry.refresh()` + one retry. The retry now re-forces both memos, which is required: a lazily-fetched pack may ship a new midx. |
| **`adoptPackRegistry`** | Unchanged — it aliases the whole registry facade, so both memos are shared by construction. |
| **`openBlobSource` parity** | The streamed path calls the same `assertLoadable()`; it inherits the split with no edit, and its own comment ("same store-setup gate as `resolveObjectBytes`") stays true. |

#### §3.4 What this buys, and what it does not

Removed from a loose first read: `exists` (0.0110) + `readdir` (0.0300) = **0.041 ms** of
*issued* I/O — but the `readdir` previously ran CONCURRENTLY with the midx load inside one
`Promise.all`, so its marginal serial cost was 0.0116, not 0.0300. The honest serial saving from
the seam is therefore **≈0.021 ms**, with a further ≈0.014 ms of JS-side saving (the generation
object, the `fileNames` `Set`, two extra `createPromiseMemo`s, the candidate loop) that §9's
original table credited at zero.
Not removed: the two midx presence stats (pinned), the fanout readdir (ADR-509), the loose read.

**It does not help the secondary target — and it mildly hurts it.** `readBlob:cold-cache`
(small pack) reads a **packed** object: the loose probe misses, `registry.lookup` forces the scan,
and every deferred call is paid anyway — one tick later. Worse, the `readdir` LOSES its overlap
with the midx load: on `main` the two ran together inside one `Promise.all`, whereas now
`assertLoadable` has already settled the gate by the time `scanPacks` runs from `lookup()`, so the
listing is serial. Measured at **+0.0108 ms** on every read that reaches the pack store. Against
§4's −0.0163 ms that leaves a cold packed read at ≈**−0.005 ms** — a wash, not the −0.0165 this
design first projected. Restoring the overlap would mean issuing the pack `readdir` before the
loose probe, i.e. restoring the very eagerness being removed, so this is accepted rather than
fixed. The small-pack row's only real lever is §4, and it is a small one.

#### §3.5 Blast radius per adapter

| Adapter | §3 (the seam) | §4 (root canonicalisation) |
|---|---|---|
| `node` | applies — the measured case | applies; `NodeFileSystem.loadRootSet` is the only realpath-based root resolver |
| `memory` | applies; saves the same logical calls, cheaper in absolute terms | n/a — no realpath |
| `browser` (OPFS) | applies; one fewer directory enumeration per cold loose read. Whether that is a *larger* relative win than on Node is **unmeasured** and is not claimed here | n/a — `BrowserFileSystem` has no realpath-based root set |

The seam lives entirely in `src/application/primitives/` (platform-agnostic), so no adapter needs
a code change for it. §4 is node-shim-only. The browser e2e scenario surface is unaffected: no
public API, no exported type, and no `reports/api.json` entry changes.

---

### §4 The redundant root canonicalisation

`src/index.node.ts`'s `openRepository` already canonicalises:

- `resolvedCwd = await realpath(nodePath.resolve(cwd))`
- `resolveNodeLayout` → `canonicalize(discovered.gitDir)` and `canonicalize(discovered.commonDir)`
- `workDir` is derived by walking up from the already-realpathed `cwd` — "an ancestor of a
  realpath is itself real" (the shim's own comment).

It then hands `layoutRootsOf(layout)` to `new NodeFileSystem(...)`, whose `loadRootSet()` calls
`canonicalizeRoots()` and **realpaths every root again** on the first port call. Measured:
**0.0163 ms** for a normal repo (one root), ~0.034 ms for a linked worktree (two roots). That is
13% of the first-access delta, and unlike §3 it is paid by **every** first read — loose or
packed — so it is the only lever that touches the small-pack row at all.

It is also **conditional**: the hand-off applies only when every `realpath` the shim performed
returned successfully, which is false whenever the cwd does not yet exist — i.e. exactly the
`init`/`clone` callers. They keep today's behaviour and gain nothing here, so `clone:small-repo`
should not be expected to move.

This is *not* Lever 5c. Lever 5c proposes **skipping the containment check** for paths lexically
under the canonical gitDir — a narrowing of the security boundary. This is: do not compute the
same canonical prefix twice. The check still runs, against the same canonical prefixes, on every
path. The only question is whether the caller may assert "these roots are already canonical", and
that assertion is what DC-2 puts to the user.

**How the "cannot widen" property is actually obtained — corrected after security review.**
The first draft of this section argued that a wrong assertion "fails closed, because a lexical
root prefix is never semantically broader than its realpathed form". That argument is sound for a
BOOLEAN flag (same root value, realpath skipped) and **false for a hand-off of resolved values**,
which is what DC-2 option (b) proposed. `loadRootSet` computes
`all = unionRootPrefixes(getRootDirPrefixes(), canonical)` and every containment verdict consults
`all` — so a caller-supplied `canonical` array is an ADDITIVE confinement input, not a
computation shortcut. Executed counterexample against the option-(b) implementation:

```
new NodeFileSystem(['/tmp/r1'], nativePolicy, undefined, ['/etc']).readUtf8('/etc/hosts')
  → 213 bytes returned
new NodeFileSystem(['/tmp/r1'], nativePolicy).readUtf8('/etc/hosts')
  → PERMISSION_DENIED
```

The shipped shape is therefore option **(a)**: a private `rootsArePreResolved` boolean, with
`canonicalizeRoots()` returning `getRootDirPrefixes()` unchanged when it is set. The union then
collapses to `raw ∪ raw = raw`, so a wrongly-set flag can only ever **narrow** the containment
set, never widen it — the property is structural rather than argued. `NodeFileSystem` is exported
via the `adapters/node` subpath, so a consumer can reach the parameter; under (a) that is
harmless, because the same consumer already chooses `rootDir` outright and the flag cannot
introduce a prefix that `rootDir` did not already permit. Nothing is added to
`OpenNodeRepositoryOptions`.

---

### §5 `openRepository` — traced, and why its 0.133 ms is not deferrable

The brief asks for this explicitly rather than letting it be silently dropped.

Decomposition (ms/iter, n=3000 after 300 warmup, same machine):

| Component | ms |
|---|---|
| `realpath(nodePath.resolve(cwd))` | 0.0163 |
| `findLayout` walk (`stat` × 5: `.git`, `commondir`, `HEAD`, `objects`, `refs`) | 0.0566 |
| `canonicalize(gitDir)` | 0.0173 |
| **discovery I/O subtotal** | **0.090** |
| remainder: adapter construction, ~40 bound command closures, `deepFreeze`, `Object.freeze`, `AbortController`, 16 MiB `LruCache` allocation | ~0.043 |
| total | 0.133 |

**Deferrable? Essentially no, and here is the evidence.**

- The 5-stat discovery walk is git's own `setup_git_directory` — git performs the same walk on
  every invocation. It cannot move behind the first read without making `ctx.layout` a promise:
  `layout` is read **synchronously** by `commonGitDir(ctx)` and by every path helper in
  `path-layout.ts`, by `layoutRootsOf` before the adapter is constructed, and by
  `computeConfigScopePaths`. Threading a promise through those is a whole-codebase change with
  no faithfulness payoff.
- `realpath(cwd)` and `canonicalize(gitDir)` are required to build the containment roots — and
  §4 already removes their duplicate, which is the only real waste here.
- The ~0.043 ms remainder is dominated by the eager binding of the command surface. It is
  measurable and it *is* addressable (lazy getters on the frozen `Repository` facade), but the
  facade is `Object.freeze`d, its shape is gated by `reports/api.json`, and every bound method
  carries a `guard()` closure. DC-6 puts it to the user; the recommendation is to leave it,
  because 0.043 ms is 10% of the scenario and the change touches the entire public surface.

**Honest consequence.** `openRepository` (0.133) + `dispose` (0.012) = 0.145 ms of stateful-handle
lifecycle that isomorphic-git's `git.readBlob({fs, dir, oid})` never pays. That is 33% of the
0.443 ms scenario and it is *architectural*, not wasteful. §7 is the response.

---

### §6 Threat model

This change reorders a refusal gate. What follows is what an attacker-controlled repository can
and cannot do afterwards.

**What still refuses, unchanged.**

- A Tier-A multi-pack-index (bad signature, bad version, missing/corrupt required chunk, fanout
  out of order, unresolvable pack-names) denies **every** read including loose ones, before the
  empty-tree short-circuit and before the delta cache is consulted. Verified against git 2.55.0
  (Pin A) and against tsgit today.
- Object size caps (`enforceLooseCap`, `enforcePackBaseCap`, `enforcePackDeltaPreApplyCap`,
  the post-apply cap) are untouched — they live below the gate.
- `verifyHash` is untouched. A loose object served without a pack scan is still hashed and
  compared to the requested oid.
- Delta-chain depth cap, `.idx` size cap (`exceedsMaxPackIdxBytes`), midx size cap
  (`exceedsMaxMidxBytes`), chain-layer cap (`MAX_MIDX_CHAIN_LAYERS`) — all untouched.
- Path containment. The loose path is still built by `looseObjectPath(commonGitDir(ctx), id)` and
  read through `ctx.fs.read`, which still runs the (post-#273, lexical) containment gate. §4
  removes a duplicate canonicalisation, not a check.
- `abort` honouring: `checkAborted(ctx)` still fires first in `resolveObjectBytes`.

**What stops being checked on a loose hit, and why that is safe.**

- The `objects/pack` directory listing. An attacker who can plant files in `objects/pack` can
  already plant a loose object; withholding the listing from a loose read grants no new
  capability. Git does list it, but the listing's *outcome* is unobservable on a successful loose
  read except as stderr diagnostics (Pin B).
- Orphan-`.idx` and unreadable-`.idx` warnings on a loose-hit path. These are diagnostics, and
  git is silent about them on a loose read too (rows C3/C5/C6). Any read that reaches the pack
  store still emits them.

**What newly succeeds that previously refused.** Two cases, both pinned against git 2.55.0 and
both relaxations toward it. First, an `objects/pack` whose listing is refused (`EACCES`) no longer
denies a loose read (row C4/E5). Second, an `objects/pack` that is a REGULAR FILE no longer denies
one either (row E7) — that shape reached the gate's own midx `stat` as `NOT_A_DIRECTORY`, which
was not classified Tier-B and so propagated; it now is, because git prints
`error: unable to open object pack directory: …: Not a directory` and still serves the object at
exit 0. This is a **loosening**, and it is deliberate: git serves the object with exit 0 (row
C4/E5), so today's refusal is a divergence in the stricter direction, which ADR-226 requires
closing. An attacker who can make `objects/pack` unreadable cannot use that to make tsgit read
the *wrong* bytes — the loose read is oid-addressed and hash-verified. The refusal returns the
moment the read needs the pack store.

**What §4's already-resolved flag risks.** Nothing that `rootDir` does not already permit. Under
the shipped boolean shape the flag only suppresses recomputation of the SAME prefixes
(`canonicalizeRoots` returns `getRootDirPrefixes()`), so the union in `loadRootSet` is
`raw ∪ raw = raw`: setting it wrongly can only narrow the containment set. This is a structural
property, not an argument about path lengths — see §4 for the counterexample that killed the
earlier value-hand-off shape, where a caller-supplied array WAS additive and did widen.

**Non-goal.** This design does not narrow the containment boundary. Lever 5c remains out of
scope and unproposed.

---

### §7 Correcting the benchmark's framing

`test/bench/loose-read.bench.ts` compares:

```ts
// tsgit — stateful handle
const repo = await openRepository({ cwd: fixture.cwd });
try { await repo.primitives.readBlob(blobId); } finally { await repo.dispose(); }

// isomorphic-git — stateless one-shot
await git.readBlob({ fs, dir: fixture.cwd, oid: fixture.firstBlobId });
```

These are different units of work. 33% of the tsgit side is handle lifecycle the peer never
performs. The row therefore reads as a straight throughput loss when part of it is an
architectural difference — and the part that *is* a real cost (first-touch) is invisible inside
the aggregate.

**The existing scenario stays, unweakened.** First-touch cost is real and worth tracking, and it
is the thing this design attacks.

**The measured consumer shape.** On the same machine, a `readBlob` on an already-open handle
costs **0.061–0.086 ms** (§1.1 second-read, and a longer steady-state run). The brief's own
directional measurement puts isomorphic-git's one-shot at 0.111 ms on comparable hardware — a
number this design did not re-measure and does not rely on beyond direction. If it holds, tsgit is
ahead on the shape real consumers use and the aggregate row hides it. A companion scenario would
put a measured number on that instead of an inherited one. DC-4 chooses between a companion
scenario, a methodology note, or both.

Whichever is chosen, `test/bench/support/bench-dsl.ts`'s contract binds: the two `bench()` names
must stay exactly `tsgit` / `isomorphic-git` (the summary script, `benchmark-compare` and the
snapshot converter key on them), and only the `describe` title varies. A companion scenario is
therefore a new `benchScenario(...)` call in the same file with a distinct Given/When-Then title,
not a third `bench()` inside the existing one.

**Gate asymmetry.** `docs/perf/hot-paths.json` lists
`[log, status, pack-read, blame, describe, name-rev, diff-recursive]`. `loose-read` is not there,
so the fresh-repo row is **ungated** by the `benchmark-compare` PR check and must be read off the
nightly artifact by hand. DC-7 asks whether that should change.

---

### §8 `docs/understand/performance.md` refresh plan

Exact edits, against the file as committed at `a4c924a7` (114 lines):

| Lines | Edit |
|---|---|
| 5–12 | **Delete** the "The table below predates the git-parity containment change" block quote entirely. |
| 18 | **Replace** the provenance line with the new nightly's: `linux-x64`, AMD EPYC 7763, Node 22.23.2 · isomorphic-git 1.41.3 · captured 2026-08-14 (`bench.yml` run 31818556244). |
| 20–34 | **Transcribe every row afresh** from that one run. The brief supplies 7 of the 13 (fresh repo 0.39×, small pack 0.74×, medium pack 25.51×, delta-chain cold 0.36×, status:clean small 0.63× / medium 0.59×, status:dirty 3.49×, log:walk medium 18.56×). The remaining rows (`clone:small-repo`, `log:walk` small, both `readBlob:warm-cache`, `delta-chain` warm) **must be read off the same artifact** — mixing two runs in one table is not citable under ADR-483. |
| 49–55 | **Add** a methodology bullet stating the unit-of-work asymmetry: `readBlob:cold-cache` (fresh repo) compares a stateful `openRepository` + `readBlob` + `dispose` against isomorphic-git's stateless `git.readBlob({fs, dir, oid})`; the handle lifecycle is measured on the tsgit side only. Conditional on DC-4 choosing (b) or (c). |
| 70–75 | **Rewrite** the "Why status:clean / readBlob:cold / delta-chain:cold trailed" section (see below). |
| 96 | **Update** the Phase 26.4 target line, whose "(currently 0.60× small pack / 20.48× medium pack)" parenthetical is now stale. |

Rewrite of §"Why … trailed":

- Drop the directional laptop A/B note (currently inside line 72: "~2× (medium) to ~2.5×
  (small) … the fresh-repo `readBlob:cold` at ~1.4×"). Real numbers now exist; the placeholder
  has done its job.
- Restate the causal story to match the new numbers. `status:clean` moved 0.40× → 0.59× (medium)
  and 0.45× → 0.63× (small): the containment collapse and walker changes landed, and what remains
  is per-entry stat work. `readBlob:cold` (fresh repo) moved 0.33× → 0.39×: the residual is
  **repository-open fixed cost plus first-object-access store setup**, not containment — with the
  §1 breakdown as the evidence (name the split: open ≈ 30%, first read ≈ 48%, steady-state read
  already ahead of the peer).
- Keep the existing Lever-5c paragraph (line 75) verbatim: its trust-boundary language is why
  5c stays out of scope here, and it is still accurate.
- Keep the gate-asymmetry sentence, updating the quoted ratios (0.33× → 0.39×, 0.35× → 0.36×).

Every number lands by hand from the dated artifact. No local run reaches this page.

---

### §9 Projected outcome — and an honest acceptance calibration

Directional projection on this machine, from §1.3:

| | ms | vs baseline |
|---|---|---|
| baseline scenario total | 0.4432 | |
| − seam, serial component (§3.4 — the `readdir` was concurrent, so its marginal serial cost was 0.0116, not 0.0300) | −0.021 | |
| − seam, JS-side construction (generation object, `fileNames` Set, two memos, candidate loop) | −0.014 | |
| − duplicate root canonicalisation (§4) | −0.0163 | |
| projected total | **~0.392** | −11.5% |

An ~11.5% wall-clock cut moves the fresh-repo ratio from 0.39× to roughly **0.45×** (the measured
same-machine delta was −0.0528 ms, and the nightly landed the row at 0.45×). It does **not**
reach 1.0×, and no honest reading of §1 says it could: reaching parity would require removing
~0.27 ms, which is more than `openRepository` + `dispose` + the entire first-access delta
combined. On a packed cold read the same seam costs +0.0108 ms (§3.4), so the small-pack row nets a wash rather than an improvement.

The brief's acceptance wording — "move **materially toward** or past 1.0×" — is
satisfiable; "past 1.0×" is not, on this scenario, without changing the unit of work. That is
precisely what §7 exists to make visible.

The small-pack row (0.74×) nets ≈**−0.005 ms**: §4's −0.0163 ms less the +0.0108 ms the
deferral costs it by serialising the pack listing behind the settled gate (§3.4). Expect it to
read as a wash on the nightly, not as an improvement — it did (0.74× → 0.76×).

Verification is a same-machine `main`-vs-branch absolute wall-clock A/B before and after each
change, plus the CI nightly artifact for the citable number. Never a self-share percentage.

---

## Decision candidates

> **All seven ratified by the user on 2026-08-14, each as the recommended option:** DC-1 (a) split
> `storeGate` + `scan`; DC-2 (a) adapter flag: roots are already resolved; DC-3 (a) keep the midx probes
> sequential; DC-4 (c) companion scenario **and** methodology note; DC-5 (a) one ADR —
> [ADR-635](../adr/635-object-store-gate-is-the-multi-pack-index-load.md), which also carries DC-2;
> DC-6 (a) leave `openRepository` eager; DC-7 (b) leave the fresh-repo row ungated. No deviations,
> so nothing folds back into the sections above.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | **Where the store-setup seam goes** — what `assertLoadable()` is allowed to force | (a) Split `createPackRegistry` into a `storeGate` memo (`loadMidxSet` only) + the existing `scan` memo, gate as a strict prefix (§3.2). (b) Keep one `scan` memo but restructure `PackGeneration` so `packs`/`fileNames`/`midx` sit behind a nested `PromiseMemo`, leaving `midxLoad` eager. (c) Leave `assertLoadable` forcing the whole scan; accept the 0.041 ms. | **(a)** | (a) makes the gate's contract legible — it *is* the midx load, which is exactly what git dies on (Pin A) — and keeps `refresh()`/`dispose()` reasoning to two memos cleared together. (b) achieves the same I/O but buries the pinned fact inside a generation struct whose "same `scanPacks` call" invariant then reads false. (c) forgoes the only lever available to the primary target. |
| DC-2 | **Removing the duplicate root canonicalisation** (§4) — the lever for *both* target rows | (a) Internal, non-public `alreadyCanonical` construction flag on `NodeFileSystem`, set at exactly one call site (`src/index.node.ts`'s `openRepository`), skipping `canonicalizeRoots`. (b) Have the node shim pass its already-computed canonical roots down as a pre-resolved `RootSet`, so no flag is needed and the adapter simply has nothing left to resolve. (c) Do nothing — keep the duplicate realpath. | **(a)** — reversed on security evidence after (b) was first ratified | (b) reads like a data hand-off, but `loadRootSet` UNIONS the supplied prefixes into the containment set, making it an **additive confinement input**: `new NodeFileSystem(['/tmp/r1'], policy, undefined, ['/etc']).readUtf8('/etc/hosts')` returned content where the two-argument form denied it. (a) skips recomputing the SAME prefixes, so the union collapses to `raw ∪ raw = raw` and a wrongly-set flag can only narrow — the property is structural rather than argued. (c) leaves the only lever that touches the small-pack row on the table. See §4. |
| DC-3 | **Sequencing of the two midx presence probes** — flat `stat` then chain `stat` (0.0392 ms sequential) | (a) Keep strictly sequential: probe flat, and only on absence probe the chain. (b) Issue both concurrently and discard the chain result whenever the flat file loads. (c) Derive flat-midx presence from the scan's `readdir` listing (as `.rev`/`.bitmap` presence already is) instead of a `stat`. | **(a)** | (a) preserves the precedence semantics literally — the chain is only consulted when the flat file is absent or discarded — at a cost of ~0.018 ms in the common no-midx case. (b) saves that but makes a repo with a healthy flat midx pay an extra speculative `stat`, and inverts the "flat wins if it *loads*" reading. (c) is cheaper on this fixture (one 0.0300 ms readdir beats two 0.0392 ms stats) but re-introduces the readdir the whole design is deferring, scales with pack count, and would silently change symlinked-midx handling (`readdir` presence is no-follow; `probeFlat`'s `stat` follows) — a behaviour change needing its own pin. |
| DC-4 | **Benchmark-framing correction** (§7) | (a) Add a companion `benchScenario` to `test/bench/loose-read.bench.ts` that opens once and reads N times. (b) Document the asymmetry in `docs/understand/performance.md`'s methodology section only. (c) Both. | **(c)** | The methodology note explains the row to a reader; the companion scenario *measures* the shape real consumers use and puts a number on tsgit's advantage there (0.061–0.086 ms vs the peer's one-shot). Either alone leaves half the correction unmade. (a) alone adds a row nobody knows how to read; (b) alone asserts an advantage without measuring it. Cost: one new scenario appears in the nightly and the snapshot converter. |
| DC-5 | **Whether this needs an ADR, and how many** | (a) One ADR recording the pinned git-2.55.0 matrix and the three divergences it closes (refused pack-dir listing; a regular file at `objects/pack`, row E7; orphan-`.idx` warn on a loose hit), refining ADR-226 and ADR-509. (b) No ADR — treat it as a pure performance change under the existing ADRs. (c) Two ADRs: one for the gate narrowing, one for DC-2's containment-adjacent change. | **(a)** | The change alters three observable fault behaviours; even though all three move *toward* git, ADR-226 wants the reasoning pinned and citable, and the matrix in §2 is the durable artifact. (b) leaves the next reader to re-derive Pin A the hard way and re-propose the reordering a third time. DC-2 did land as (a)-with-a-flag, which does not reopen this: the flag only suppresses recomputing prefixes the adapter would have derived anyway, so the containment surface still barely moves and one ADR carries both. |
| DC-6 | **`openRepository`'s ~0.043 ms of eager construction** (§5) | (a) Leave it eager. (b) Lazy getters for the ~40 bound command closures on the frozen `Repository` facade. (c) Defer only the namespace binders (`branch`, `bundle`, `config`, `merge`, `notes`, `rebase`, `remote`, `cherryPick`). | **(a)** | 0.043 ms is ~10% of the scenario, but the facade is `Object.freeze`d, its shape is gated by `reports/api.json`, and every method carries a `guard()` closure — lazy getters change the public object's own shape for a fraction of a fraction. (c) is the cheap middle if the user wants movement; (b) is the largest surface risk in this design for the smallest measured return. |
| DC-7 | **Gate the fresh-repo row?** `docs/perf/hot-paths.json` omits `loose-read`, so the primary target is ungated by `benchmark-compare` | (a) Add `loose-read` to `hotOperations`. (b) Leave it ungated; read the nightly by hand, as today. (c) Add it and re-derive the whole list per ADR-505's per-major-version rule. | **(b)** | ADR-501 derives the list from *absolute* nightly timings cross-checked against revealed optimisation effort — `loose-read` is a micro-scenario whose absolute time is tiny, so adding it on the strength of one PR's attention inverts the methodology. (a) also makes an advisory, same-runner-noisy check gate a scenario at the noise floor. (c) is the principled route but is a re-derivation exercise, not part of this change. **The user may reasonably prefer (a)** if the intent is to stop this row regressing silently. |

---

## Test strategy

### Interop — the only tier that proves faithfulness

Parity tests are cross-adapter and prove nothing about git. Each pinned row below becomes an
assertion in a cross-tool interop test.

**New: `test/integration/loose-read-store-gate-interop.test.ts`**, following the shape of
`test/integration/loose-corrupt-precedence-interop.test.ts` (`@proves` header block,
`GIT_AVAILABLE` guard, `runGitAsync` / `runGitEnv` from `interop-helpers.ts`, one shared
`beforeAll` repo, 60 s timeout — interop tests that spawn git are flaky with per-test repos).

| Pin | Assertion |
|---|---|
| A1 | Corrupt the midx signature; assert **both** `git cat-file -p <loose-oid>` exits 128 **and** tsgit's `readObject` on the same loose oid throws `{ code: 'INVALID_MULTI_PACK_INDEX', check: 'signature' }`. |
| A3 | Same for a fanout corruption (`check: 'fanout'`), proving the gate is not signature-specific. |
| A4 | Truncated midx (Tier B): git exits 0 with content; tsgit returns the same blob bytes **and emits the `discarding unusable multi-pack-index` warn on the loose hit** (git prints its own Tier-B diagnostic here — the warn must survive the deferral). |
| E3 | Garbage midx chain file, no flat file: same as A4 — git exits 0 with a `warning:` line; tsgit serves the blob and warns. |
| C4/E5 | `chmod 000` on `objects/pack`: git exits 0 with content; tsgit returns the same blob bytes. **This assertion fails on `main` and passes on the branch** — it is the divergence closure, and it is the single most important test in this change. Skip it when the test process is running as the superuser (mode bits are ignored there), and restore the mode in `finally`. |
| C5 | Orphan `.idx` (delete the `.pack`, keep the `.idx`): git silent, exit 0; tsgit returns the blob **and emits no logger warn** on the loose-hit path. |
| E6 | Remove `objects/pack` entirely: git exits 0; tsgit returns the blob. |

Every tsgit-side assertion in this file must build a **fresh `Context` after** the real-`git`
subprocess writes — the fanout membership set is per-`Context` and is invalidated only by tsgit's
own `writeObject`, so a `Context` created before the `git hash-object -w` sees a stale set and the
probe silently measures the wrong thing.

`runGitEnv()` already scrubs `GIT_*`; do not rely on `-C <path>` to override an inherited
`GIT_DIR`, because it does not.

### Unit — pinning the laziness by call count

`test/unit/application/primitives/object-resolver.test.ts` already stubs `assertLoadable: async () => {}`
in several places (lines 125, 1225, 1294, 1368, 1438) and already reasons about `exists()` call
counts (line 818) — extend that ledger rather than inventing a second one.

| Test | Assertion |
|---|---|
| loose hit, cold Context | `ctx.fs.readdir` is called exactly once, with `objects/<xx>`, and **never** with `objects/pack`; `ctx.fs.exists` is never called. |
| loose hit, cold Context | No `RegisteredPack` is constructed — assert via zero `ctx.fs.stat`/`read` against any `*.idx` path. |
| loose **miss** | `objects/pack` **is** listed, exactly once, and `registry.lookup` resolves — the deferral must not become a skip. |
| Tier-A midx + loose hit | Throws before `probeLooseOid` runs: assert zero `readdir(objects/<xx>)` calls. This is the ordering pin in unit form. |
| Tier-B midx + loose hit | Resolves; `objects/pack` still not listed. |
| `readdir(objects/pack)` rejects `PERMISSION_DENIED` + loose hit | Resolves with the blob (the C4/E5 closure, unit-level). |
| `openBlobSource` | Same loose-hit ledger as `readObject` — the two gates must not drift (`blob-source.ts:86`). |
| `refresh()` | Clears **both** memos: after `refresh()`, the next loose read re-probes the midx **and** the next miss re-lists `objects/pack`. |
| `dispose()` on a Context that only ever hit loose objects | Performs no `objects/pack` listing (strengthens the existing "disposes without scanning" property). |
| `withLazyFetchRetry` | Loose miss → `OBJECT_NOT_FOUND` → `promisor.fetch` → `refresh()` → exactly one retry, unchanged. |

`test/unit/application/primitives/pack-registry.test.ts:3904` currently asserts
*"assertLoadable does not force any `.idx` load: the ledger shows the readdir, one midx read, and
zero `.idx` reads"*. **That test must be updated**: after the split the ledger shows one midx read
and **no** readdir. Its `@proves`/title must be reworded, not deleted — the "zero `.idx` reads"
half is still the point.

If DC-2 lands, add a `test/unit/adapters/node/` assertion that the production construction path
performs exactly one `realpath` per distinct root across `openRepository` + first read, and that a
symlinked repo root still resolves (macOS `/var` → `/private/var` is the regression this guards).

### Property tests

Applying the four lenses from CLAUDE.md: this change touches memo lifecycle and call ordering,
not a parser, matcher, round-trip pair, or algebraic grammar. **No `*.properties.test.ts` sibling
is warranted** — the honest lens here is call-count ledgers and the interop matrix. Recording the
negative explicitly so the review pass does not flag the gap.

### Benchmarks

- `test/bench/loose-read.bench.ts` — existing scenario **unchanged**. Plus, if DC-4 lands as (a)
  or (c), one new `benchScenario` opening once and reading N times, with the `bench()` names still
  exactly `tsgit` / `isomorphic-git`.
- `test/bench/midx-lookup.bench.ts` already prices the `assertLoadable` gate in isolation
  ("When `readBlob()` resolves a loose object with no packs (the `assertLoadable` gate,
  isolated)") against the `LOOSE_ONLY_FIXTURE` from `test/bench/support/fixture-generator.ts`.
  **That row is the sharpest local signal for this change** — re-measure it `main`-vs-branch.
  Its comment referencing the gate stays accurate; only what the gate costs changes.
- Report every result as absolute wall-clock, same machine, `main` vs branch. Never a self-share
  percentage — that framing has misled this project before.
- The citable number is the CI nightly artifact and nothing else.

### Gates

`npm run validate` (100% coverage on `domain`/`adapters`, Stryker over all of `src`). The new
branches introduced by the seam — a `readdir` fault reaching only pack-store consumers, a gate
cleared by `refresh` — need isolated tests per the guard-clause rule; a single test that trips
two conditions proves neither.

---

## Out of scope

- **Lever 5c** — the trusted-internal-path containment fast-path. `docs/design/checkcontainment-hot-path.md`
  requires it to arrive as its own security-reviewed proposal with an explicit trust boundary and
  user sign-off. It is a further security-boundary narrowing, not a git-parity fix. §4 is
  deliberately *not* 5c: it removes a duplicated canonicalisation, it does not skip a check.
- **`delta-chain` (cold) at 0.36×** — dominated by deep-delta replay (~43-deep chain at
  `--depth=50 --window=250`), not first-access cost. Its object is packed, so the §3 deferral is
  paid back one tick later on the loose miss; only §4's single realpath touches it. The §1 trace
  confirms the brief's expectation rather than contradicting it: nothing in the first-access
  inventory scales with chain depth. Not chased.
- **Reordering loose-vs-pack precedence** — ADR-509 forecloses it; it has been proposed and
  rejected twice. Not revisited. The fanout `readdir` (0.0282 ms per cold prefix) is recorded in
  §1.3 as a known residual so its size is visible, not as a proposal.
- **Making `ctx.layout` asynchronous** to defer repository discovery — evidence in §5; a
  whole-codebase change with no faithfulness payoff.
- **The `.idx`-parse diagnostic gap** (Pin C, rows C1/C2: git prints `error: non-monotonic index`
  on a loose read, tsgit is silent). Pre-existing, diagnostic-only under ADR-249, and unchanged
  by this design. Worth its own decision later; not folded in here.
- **`objects/info/packs`** — tsgit does not read it and git's use of it is confined to the dumb
  HTTP transport. Untouched.
