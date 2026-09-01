# Design — streaming index pass for received packs

> Brief: the fetch/clone receive path already streams the pack to quarantine at O(window) RSS
> and walks it back from disk in bounded 256 KiB windows, but the *entry* pipeline still holds
> every entry's inflated content in memory at once. Replace it with a true bounded-memory
> indexer in `git index-pack`'s shape — a sequential first pass that hashes base entries and
> records delta positions, a second pass that resolves deltas without retaining the whole
> corpus, thin-pack external bases on the same seam.
> Status: draft → self-reviewed ×3

## Context

### What the receive path does today

`src/application/primitives/fetch-pack.ts` (1 036 lines) is the whole story. Four stages:

| Stage | Symbol | Line | Residency |
|---|---|---|---|
| receive | `receivePackToQuarantine` | `:364` | **O(chunk + digest)** — streams to `objects/pack/tmp_pack_<random>`, hashes the trailer incrementally behind a sliding tail buffer. Already bounded (ADR-728) |
| read back | `diskPackByteSource` | `:680` | **O(window)** — `DISK_WALK_WINDOW_BYTES = 256 KiB`, doubling ladder re-anchored per entry, capped at `trailerStart` |
| inflate | `inflateAllEntries` | `:860` | **O(Σ inflated)** — `out.push({ offset, header, inflated, crc32 })` for every one of `header.objectCount` entries |
| resolve | `resolveAllEntries` | `:904` | **O(Σ inflated) again** — `byOffset` and `byId` each retain every `ResolvedEntry`, and `ResolvedEntry` carries `content` |

**The backlog entry under-counts the problem.** It names only `resolveAllEntries`. But
`inflateAllEntries` is the *first* offender: by the time delta resolution starts, the entire
pack is already resident as `PendingEntry[]`. `resolveAllEntries` then builds a **second**
full retention on top of it. Base entries alias (`content` is the same buffer as `inflated`,
no copy); delta entries do not — the instruction stream stays alive in `PendingEntry` while
the reconstructed target is a fresh allocation. So the true steady state is

```
Σ inflated(base entries) + Σ deltaStream(delta entries) + Σ content(all entries)
  + N × (2 Map nodes + PendingEntry + ResolvedEntry + PackEntryHeader)
```

`walkFromPending` (`:835`) is the shared tail, and its doc comment says the residency
"is unrelated to the read-back windowing above and is out of scope here." **Retiring that
sentence is this change.**

### The lever: the output needs no content at all

```ts
interface WalkedEntry {
  readonly id: string;
  readonly crc32: number;
  readonly offset: number;
}
```

That is everything `walkFromPending` returns, and everything `writePackSiblingArtifacts`
consumes to build the `.idx`/`.rev`. Every inflated byte in the pipeline exists for exactly
two reasons: to compute an oid, and to serve as a delta base. Neither requires retention past
the moment it is used.

### The two entry points and who reaches them

| Entry point | Line | Source | Callers |
|---|---|---|---|
| `walkQuarantinedEntries` | `:218` | `diskPackByteSource` | module-private; reached from `fetchPack` → `clone.ts:200`, `fetch.ts:161`, `fetch-missing.ts:114`, and `pull.ts` via `fetch` |
| `walkPackEntries` | `:851` | `inMemoryPackByteSource` | exported from the module; **exactly one production caller**, `bundle-verify.ts:78`, which discards the returned array and uses the call purely as a validation gate |

`walkPackEntries` is **not** re-exported through `src/application/primitives/index.ts` (only
`fetchPack` and its two input/result types are) and does not appear in `reports/api.json`.
`DISK_WALK_WINDOW_BYTES`, `ExternalBaseResolver` and `verifyPackTrailer` are module exports
consumed by `bundle-verify.ts` and by `test/unit/application/primitives/fetch-pack.test.ts`.

### Governing decision records

| ADR / design | What it binds here |
|---|---|
| **ADR-226** git-faithfulness | Pin every refusal against the real binary; §1 is that pin |
| **ADR-249** structured data only | The indexer returns fields, never rendered text; `TsgitError.data.reason` *is* observable and is what §8 argues about |
| **ADR-728** clone pack quarantine | `tmp_pack_<random>` → verify → rename. Unchanged: this design starts *after* the trailer verifies |
| **ADR-718** read-path hash verification is opt-in | The indexer is a *write* path — it computes oids because it must, not to verify. `bundle-verify` passing `verifyHash: true` is a different surface |
| **ADR-736** delta-base cache is additive, not a fraction | The prior art for any byte-capped cache added here, and the reason a *new* additive budget must be justified rather than assumed free |
| **ADR-727** parsed-commit memo is a byte-capped LRU | Same shape; `createLruCache(maxBytes, maxEntries)` with a fixed per-entry overhead term |
| **ADR-770** the base index is two `Int32Array`s | The prior art for §3's record store: parallel typed arrays over an array of objects, chosen so iteration order is an array walk |
| **ADR-771** both readers accept git's full delta depth | `MAX_DELTA_CHAIN_DEPTH = 50` binds `collectDeltaChain` and fsck's `walkDeltaChain`. It does **not** bind this indexer today (§1f row 9, §8 row l) |
| **ADR-772** window memory bounds residency | Precedent for preferring git's own config key over a private constant — but `pack.windowMemory` is a *writer* key and is not this path's |
| **ADR-720** lazy `.rev`-first successor lookup | The read path a freshly indexed pack lands in; untouched |
| **ADR-722** caches key on a session token | If a cache is introduced it keys on `ctx.session`, never on `Context` identity |
| `design/delta-writing-packer.md` §12 | Names this change and records the two seams it moved: `serializePackfile` still takes a materialised array, and `buildPack` gained a metadata pass structurally similar to §2's |

---

## Requirements

Everything below is verifiable by a test named in §Test strategy.

**Memory**

- **R1** The index pass's peak retained bytes are bounded by §7's closed formula —
  `largestEntryInflatedBytes + Σ_{retained ancestors} contentBytes + N × RECORD_BYTES +
  D × DELTA_RECORD_BYTES + one read window + cacheBudget` — and are **independent of Σ inflated
  over the pack**. Asserted by a bench-side memory scenario on the §1c fixtures, measured from a
  child process's kernel high-water mark (§1d's methodology note).
- **R2** On fixture **C** (§1c — a real `git clone` pack of tsgit's own history: 27.7 MB pack,
  15 074 objects, 571 MiB total inflated), peak process footprint over baseline does **not
  exceed** `git index-pack --threads=1`'s peak on the same pack at git's defaults — §1e:
  126 MB, against a git baseline small enough (~1.5 MB) that the comparison is fair without
  subtracting it — and the design targets the class git reaches with its base cache disabled,
  33 MB. Today tsgit is at 799 MB (§1d). The assertion is a class with headroom, never a byte
  count.
- **R3** No allocation is ever sized from `header.objectCount` alone — a server-controlled
  `uint32` (§9).

**Correctness — unchanged observable behaviour**

- **R4** For every pack the current pipeline accepts, the new one returns the **same
  `WalkedEntry` set** (same oids, same crc32s, same offsets). Proved by running both over the
  §1c fixtures and the existing synthetic pack fixtures and comparing sets.
- **R5** A REF delta whose in-pack base appears at a **higher** offset still resolves (§1f
  pin 6 — git accepts this, and today's fixed-point loop does too). A single forward pass
  cannot do it; pass 2 must.
- **R6** A delta chain of arbitrary depth still indexes without a JS stack overflow, matching
  git (§1f pin 9: git accepts depth 1 000). Recursion is replaced by an explicit stack.
- **R7** Thin packs still complete through `ExternalBaseResolver`, with the same
  `bundle verify` behaviour: base present → resolves; base absent → refuses.
- **R8** Every entry's payload is read from disk **at most twice** (once in pass 1, once in
  pass 2) and every delta is applied **exactly once** — no chain is re-resolved per element
  (§5).

**Refusals**

- **R9** Every refusal the current code raises still fires on the same input, with the same
  `TsgitError.code`, unless §8 records a deliberate change ratified by an ADR.
- **R10** A pack whose deltas cannot all be resolved refuses — including the three cases a
  fixed-point loop and a root-down walk reach differently: a REF cycle, an all-deltas pack with
  no base entry, and an OFS base offset landing mid-entry (§1f rows 7, 8, 15b).
- **R11** A cyclic REF graph cannot make the indexer loop or allocate unboundedly; termination
  is structural, not a no-progress check (§5).

**Contracts preserved**

- **R12** `reports/api.json` is **unchanged** — no exported symbol's shape moves (§11). If a
  decision adds a config key this requirement is restated, not silently broken.
- **R13** `writePackSiblingArtifacts`, `buildIdx`, `buildRev`, `sortPackIndexEntries`,
  `serializePackIndex` and `serializePackRevIndex` are untouched; the indexer still hands them
  `ReadonlyArray<PackIndexWriterEntry>`.
- **R14** `fetch-pack.ts` ends **below** the repo's 800-line file ceiling — the byte-source seam
  moves with the indexer, not just the pipeline, or the file lands *on* the ceiling rather than
  under it (§6). No new module exceeds it either.

---

## Design

### 1. The pinned matrix

Everything in this section was measured, never recalled.

#### 1a. Environment

| | |
|---|---|
| Machine | Apple M3 Pro, 11 cores, 18 GiB, darwin 25.5.0 (arm64) |
| git | **2.55.0**, `/opt/homebrew/bin/git` |
| Node | **v22.22.3** |
| Isolation | every state-mutating probe in a `mktemp -d` under the session scratchpad: isolated `HOME` and `XDG_CONFIG_HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed, `LC_ALL=C`, `commit.gpgsign=false`, `gc.auto=0`. No tsgit checkout's `.git/config` was written |
| Memory oracle | macOS `/usr/bin/time -l`, reading **peak memory footprint** (primary) and **maximum resident set size** (secondary). Both are kernel high-water marks, not sampled |

🔴 **Every number below is a LOCAL measurement on that machine.** Per the repo rule, published
performance numbers come from CI's nightly bench artifact; these are sizing and residency
measurements taken to make a design decision, and they are labelled as local.

#### 1b. Two measurements that reproduced perfectly and were both wrong

Recorded because each cost an hour and each would have shipped a wrong design.

**A number that reproduces is not a number that is validated.** The first residency pass ran
`git index-pack --strict --no-progress <pack>` and reported **7.13 / 7.16 / 7.13 MB** peak RSS
— reproducible to three significant figures. It was nonsense: `git index-pack` has **no
`--no-progress` flag** (`-v` is its only progress switch), so all three runs printed the usage
text and exited without writing an `.idx`. The number was the cost of git printing usage. Fix,
applied to every git measurement below: **the probe asserts its own output exists**
(`git show-index < <idx> | wc -l` equals the expected object count) before the timing line is
believed.

**A model that fits the data is not a model that is confirmed.** The corrected numbers gave
`11.09 − 2.51 = 8.58 MB` as fixture A's delta-resolution cost, against
`maxChainDepth × largestObject = 50 × 159 748 = 7.99 MB` — a 7 % fit, from which this document's
first draft concluded that git holds one root-to-leaf path of reconstructed content. **It was a
coincidence.** §1e's controlled sweep over `core.deltaBaseCacheLimit` shows the 8.58 MB was the
delta base cache filling; with the cache off the same figure is **0.39 MB**, twenty times below
what the "path" model predicts. The model was replaced with one that survives a knob sweep, not
one that matched a single subtraction.

**Third-party discipline used throughout:** every degenerate input in §10 is an *enumerated*
case built by hand — empty pack, zero-length object, single entry, all-deltas, cycle, forward
reference, self reference — not a corner sampled out of a random corpus.

#### 1c. Fixtures

All three are reproducible.

| | Shape | Objects | `.pack` bytes | Σ inflated | Max chain | Largest object |
|---|---|---|---|---|---|---|
| **A** | text-churn: one 2 000-line generated file, 300 commits, 20 lines rewritten + 1 appended each; `git -c pack.threads=1 repack -a -d` | 903 (301 commit / 301 tree / 301 blob) | **506 635** | **45 380 904** (43.28 MiB) | **50** — saturates `pack.depth` | 159 748 |
| **B** | fixture A repacked `--window=0 --depth=0` (§ git's own delta-free mode) | 903 | **13 376 274** | 45 380 904 | 0 | 159 748 |
| **C** | **a real clone pack**: `git clone --no-local --bare file:///…/tsgit` — negotiated over the local transport, so it is exactly the shape `fetchPack` receives | 15 074 (295 commit / 5 037 tree / 9 742 blob) | **27 744 524** (26.46 MiB) | **598 540 715** (570.81 MiB) | 48 | 4 991 842 |

Fixture A's generator is a 12-line deterministic Python script seeded at `1234`; two
independent runs produce the same HEAD sha.

The ratio that matters: **Σ inflated is 89.6× the pack for A and 21.6× for C.** The brief's
"typically larger than the pack itself" is an understatement for any real repository.

Object-type split for A's deltified pack, via `git verify-pack -v`: 301 commit / 301 tree /
**5** blob as base entries (757 319 B of base blob content), **296** blob delta entries. So
`inflateAllEntries` alone retains only ~1.3 MB on fixture A — the 45 MB arrives entirely in
`resolveAllEntries`. On fixture B, where every entry is a base, the retention is
`inflateAllEntries`'. Both halves are real; neither is sufficient on its own.

#### 1d. Today's residency — measured

Node probe: reads the pack, builds a `createNodeContext`, runs one of two paths, exits.
`fetchPack` is driven through a fake `NegotiatePackBytes` that yields the pack body in 64 KiB
chunks — the real receive path, quarantine and disk-windowed read-back included. Median of
three runs; the `none` mode (read the pack, do nothing) is the baseline subtracted.

| Fixture | mode | peak footprint | over baseline | max RSS |
|---|---|---|---|---|
| A | `none` (baseline) | 22.3 MB | — | 56.3 MB |
| A | `walkPackEntries` (in-memory source) | 87.6 MB | **65.3 MB** | 125.7 MB |
| A | `fetchPack` (quarantine + disk windows) | 97.7 MB | **75.4 MB** | 136.0 MB |
| B | `none` | 48.2 MB | — | 82.0 MB |
| B | `walkPackEntries` | 149.3 MB | **101.1 MB** | 187.9 MB |
| B | `fetchPack` | 150.4 MB | **102.2 MB** | 189.0 MB |
| C | `none` | 77.0 MB | — | 110.8 MB |
| C | `walkPackEntries` | 865.2 MB | **788.2 MB** | 898.9 MB |
| C | `fetchPack` | 876.5 MB | **799.5 MB** | 888.5 MB |

**Cloning tsgit's own repository costs ~800 MB of JS residency for a 27.7 MB pack** — 1.40× the
total inflated size, 30× the pack. Fixture A is 1.74× inflated and **156× the pack**.

The two entry points land within 11 MB of each other on **every** fixture, including fixture C
where the pack is 26.46 MiB. The probe reads the pack file before branching on mode, so the
whole-pack buffer is inside the baseline for both — the residual ~10 MB is `fetchPack`'s
receive-and-write half (quarantine streaming, `.idx`/`.rev` assembly, rename) and is roughly
constant in pack size. **The windowed disk read-back's O(window) discipline is entirely swamped
by the entry pipeline** — that is the finding this design exists to fix, stated in numbers
rather than asserted.

Why the multiple exceeds 1.0× even on fixture B, where a base entry's `content` aliases its
`inflated` buffer and is not copied: the largest identified contributor is
`computeLooseObjectId` (`:1026`), which allocates a **full second copy** of every object
(`headerBytes ++ content`) purely to hand `ctx.hash.hashHex` one buffer. 43.28 MiB live plus
43.28 MiB of transient copies plus per-entry object overhead lands near the measured 102 MiB,
and V8's footprint high-water absorbs the churn rather than smoothing it. See DC-3.

> ⚠️ **Methodology note, recorded because it cost an hour.** An in-process sampler
> (`setImmediate` loop over `process.memoryUsage()`) reported 6.3 MiB for `walkPackEntries` on
> fixture A and 54 MiB for `fetchPack` — an 8× spread between two paths that share the same
> pipeline. The sampler was wrong: `resolveAllEntries` awaits only already-resolved promises,
> so the loop drains as **microtasks** and the event loop never turns; `setImmediate` never
> fires during the phase that holds the peak. `fetchPack` only appeared honest because real
> I/O follows the walk. **Do not measure this pipeline with an in-process sampler.** The kernel
> high-water mark is the only oracle that cannot miss the peak, and it is what the bench-side
> assertion for R1/R2 must use.

#### 1e. What `git index-pack` actually costs, decomposed

Same fixtures, same machine, `--strict`, `.idx` existence asserted on every run.

| Fixture | invocation | peak footprint | max RSS |
|---|---|---|---|
| A | `--threads=1` (defaults) | **11.09 MB** | 16.70 MB |
| A | `--threads=2` / `4` / `8` / default (11) | 19.3 / 35.2 / 40.8 / 40.1–42.0 MB | 24.9 / 40.8 / 46.4 / 45.2–47.5 MB |
| B | `--threads=1` (no deltas in the pack) | **2.51 MB** | 8.11 MB |
| C | `--threads=1` (defaults) | **126.09 MB** | 131.6 MB |
| C | default threads | 143.6–147.4 MB | 149.0–152.8 MB |

Three things fall out, and all three are load-bearing.

**1. Per-thread scaling is real and documented.** `man 1 git-index-pack`, `--threads=<n>`,
verbatim: *"The required amount of memory for the delta search window is however multiplied by
the number of threads."* Measured: fixture A costs +8.2 MB for the second thread and plateaus
near 40 MB. This is why §Out of scope keeps pass 2 single-threaded.

**2. The delta base cache is the dominant memory term, and it is a knob.** `git index-pack`
honours `core.deltaBaseCacheLimit` — *"Maximum number of bytes **per thread** to reserve for
caching base objects that may be referenced by multiple deltified objects … Default is 96 MiB
on all platforms"* (`man 1 git-config`). Swept at `--threads=1`:

| `core.deltaBaseCacheLimit` | fixture A peak | fixture C peak |
|---|---|---|
| `96m` (default) | **11.14 MB** | **126.01 MB** |
| `16m` | — | 59.49 MB |
| `1m` | 3.87 MB | 35.29 MB |
| `0` (disabled) | **2.90 MB** | **33.44 MB** |

**3. With the cache off, git's delta resolution costs a handful of objects — not the chain
depth, and not Σ inflated.** The controlled pairs:

```
fixture A:  2.90 MB (cache off, deltified)  −  2.51 MB (no deltas at all)  =  0.39 MB
fixture C: 33.44 MB (cache off, deltified)  − 15.16 MB (no deltas at all)  = 18.28 MB
```

Fixture C's delta-free control is the same 15 074 objects and the same 570.81 MiB inflated,
repacked `--window=0 --depth=0` into an 82.9 MiB pack; it costs **15.16 MB** to index, with or
without the cache (nothing to cache). So git's fixed cost is ≈ 1 KB per object, and its delta
resolution adds a few objects' worth of live content — 0.39 MB on fixture A whose deepest chain
is 50, which rules out any model holding a whole root-to-leaf path. The natural reading is that
a parent is released as soon as its **last** child is reconstructed, so a *linear* chain retains
two objects at a time and only a branching one retains ancestors. §7 states the bound that way.

**The cache buys speed, not safety.** Wall clock at `--threads=1`, median of three:

| | `deltaBaseCacheLimit=96m` | `=0` | ratio |
|---|---|---|---|
| fixture A | 110.0 ms | 202.2 ms | **1.84×** |
| fixture C | 1 366 ms | 2 831 ms | **2.07×** |

So git's own shape is a memory-safe resolution algorithm **plus** an optional byte-capped base
cache that trades up to 96 MiB per thread for roughly 2× wall clock. Those are two separable
decisions, and this design keeps them separable: DC-1 picks the algorithm, DC-11 decides whether
the cache ships now and under which budget.

Fixture B remains the sharpest single number: **2.51 MB to index 903 objects totalling 45.4 MB
inflated.** git retains O(1) per object; tsgit retains all of it.

#### 1f. Refusal and acceptance matrix — pinned against the binary

Packs crafted byte-by-byte in the throwaway (`PACK` + v2 + count, entries, recomputed SHA-1
trailer), then fed to both tools. `git index-pack --strict <file>`; tsgit through
`walkPackEntries` on the same bytes, error read as `TsgitError.data`.

| # | Input | `git index-pack --strict` | exit | tsgit today | Verdict |
|---|---|---|---|---|---|
| 1 | base blob + `OFS_DELTA` on it | bare sha on stdout | 0 | 2 entries, 2 oids | agree |
| 2 | **empty pack** (`objectCount = 0`) | bare sha | 0 | 0 entries | agree |
| 3 | single base entry | bare sha | 0 | 1 entry | agree |
| 4 | **zero-length object** | bare sha | 0 | 1 entry | agree |
| 5 | **four identical zero-length blobs** (duplicate oid) | `fatal: The same object e69de29… appears twice in the pack` | **128** | 4 entries, **1 distinct oid** | ⚠️ diverges — but only under `--strict`; **without** `--strict` git accepts (exit 0), and `transfer.fsckObjects`/`fetch.fsckObjects` both default to **false**, so tsgit matches git's *default fetch* behaviour |
| 6 | `REF_DELTA` whose base is a **later** entry | bare sha | 0 | 2 entries | agree — **R5's pin** |
| 7 | `REF_DELTA` cycle (two deltas naming each other's oid) | `fatal: pack has 2 unresolved deltas` | 128 | `INVALID_PACK_HEADER` / `unresolved REF_DELTA: base aaaa… not in pack` | both refuse, **different reason** |
| 8 | all deltas, no base entry | `fatal: pack has 2 unresolved deltas` | 128 | same string as #7 | both refuse, different reason |
| 9 | OFS chain of depth **50 / 51 / 100 / 1 000** | bare sha, all four | 0 | 51 / 52 / 101 / 1 001 entries, all four | agree — **no depth cap on either indexer** |
| 10 | deep chain installed in a repo, then read back | `cat-file --batch-all-objects \| cat-file --batch` exit 0 | 0 | tsgit's **object resolver** refuses past `MAX_DELTA_CHAIN_DEPTH = 50` | ⚠️ pre-existing gap (§8) |
| 11 | extra bytes between last entry and trailer | `fatal: pack is corrupted (SHA1 mismatch)` | 128 | `INVALID_PACK_HEADER` / `extra bytes between last entry and trailer` | both refuse, different reason |
| 12 | declared count **>** actual entries | `error: inflate: data stream error (incorrect header check)` + `fatal: pack has bad object at offset 37: inflate returned -3` | 128 | `DECOMPRESS_FAILED` / `incorrect header check` | both refuse, near-identical class |
| 13 | declared count **<** actual entries | `fatal: pack is corrupted (SHA1 mismatch)` | 128 | `INVALID_PACK_HEADER` / `extra bytes between last entry and trailer` | both refuse, different reason |
| 14 | OFS distance **>** the delta's own offset | `fatal: pack has bad object at offset 37: delta base offset is out of bound` | 128 | `INVALID_PACK_HEADER` / `OFS_DELTA at offset 37 points before pack body: distance 99999` | both refuse, different reason |
| 15 | OFS distance **0** (self reference) | `fatal: pack has bad object at offset 37: delta base offset is out of bound` | 128 | `INVALID_PACK_HEADER` / **`unresolved entry at offset 37`** | ⚠️ **wrong refusal** — tsgit's guard is `baseOffset < PACK_HEADER_BYTES` only, so `37 − 0 = 37` passes it and the entry falls through to "base not yet resolved" |
| 15b | OFS distance in range but landing **mid-entry** (base offset 15 inside an entry starting at 12) | `fatal: pack has 1 unresolved delta` | 128 | `INVALID_PACK_HEADER` / `unresolved entry at offset 64` | both refuse; note git's **singular** `delta` at N = 1 |
| 16 | thin pack (`pack-objects --thin`), 5 REF deltas, bases absent | `fatal: pack has 5 unresolved deltas` | 128 | n/a (external resolver path) | — |
| 17 | same thin pack, `--stdin --fix-thin` into a repo holding the bases | `pack\t<sha>` on stdout | 0 | n/a | — |
| 18 | any pack, `--max-input-size=500000` on a 506 635 B pack | `fatal: pack exceeds maximum allowed size (488.28 KiB)` | 128 | `PACK_TOO_LARGE` from `maxResponseBytes`, different message | both refuse |

Three settled facts:

- **The two unresolved-delta messages are tsgit-internal, not git-faithful.** git counts, and
  uses the singular at one (`pack has 1 unresolved delta` / `pack has 2 unresolved deltas`);
  tsgit names the
  first offending base or offset. Rows 7, 8, 15b and 16 pin it. The redesign changes *which*
  entry would be named first anyway (a root-down walk discovers unresolved entries as a set,
  not in queue order), so keeping today's strings byte-identical is a cost, not a default —
  **DC-6**.
- **Row 15 is a real defect this design must fix.** git treats a zero distance as out-of-bound;
  tsgit reports the wrong reason for it — **DC-7**.
- **Row 9 is why the indexer must not inherit `MAX_DELTA_CHAIN_DEPTH`.** git's indexer has no
  depth cap, and neither does tsgit's today. ADR-771 pins the *readers* at 50. Row 10 shows the
  consequence: tsgit will happily index a pack it cannot later read. That gap is pre-existing
  and is **DC-8**, not something this change may quietly close.

Also pinned, and used in §7/§9:

- **Minimum pack entry = 9 bytes** (one type/size byte plus the 8-byte zlib stream of an empty
  payload) — measured on a hand-built pack of four zero-length blobs (68 bytes total = 12
  header + 4 × 9 + 20 trailer). So a pack of `T` bytes can hold at most
  `(T − 12 − digestLength) / 9` entries, regardless of what its header declares.
- `core.deltaBaseCacheLimit`, `man 1 git-config`, verbatim: *"Maximum number of bytes **per
  thread** to reserve for caching base objects that may be referenced by multiple deltified
  objects. … Default is 96 MiB on all platforms."* This is git's own key for exactly the cache
  DC-1(b) would introduce, and its "per thread" wording is the same multiplication the
  `--threads` man text describes.
- `git index-pack` writes `.idx` **and** `.rev` beside the pack. `--stdin` prints
  `pack\t<sha>`; the file form prints the sha bare.

### 2. Pass 1 — sequential scan, retain nothing

Pass 1 is today's `inflateAllEntries` loop with the `out.push` deleted. It keeps the same
`PackByteSource` seam, the same forward-only window ladder, the same trailer and
`offset !== trailerStart` guards.

For entry `i` at absolute offset `o`:

1. `header = await source.entryHeader(o)` — type, declared `size`, `dataOffset`, plus
   `baseDistance` (OFS) or `baseId` (REF).
2. `result = await source.inflateEntry(o, header.dataOffset, header.size)`.
   **`bytesConsumed` is the reason this pass cannot be skipped**: a pack stores no entry
   lengths, so the only way to learn where entry `i+1` starts is to inflate entry `i` and see
   how many input bytes the zlib member consumed. git pays the same cost.
3. `entryEnd = header.dataOffset + result.bytesConsumed`, then
   `crc = await source.entryCrc32(o, entryEnd, result.crcContext)` — unchanged; the window that
   satisfied the inflate necessarily spans `[o, entryEnd)`. **`bytesConsumed` is counted from
   `dataOffset`, not from the entry start** — the current loop (`:879`) already does this, and
   getting it wrong shifts every subsequent offset by the header width.
4. Classify:
   - **base** (`COMMIT|TREE|BLOB|TAG`): compute the oid from `result.output` and store it in
     the record slab. `result.output` is then dropped.
   - **OFS delta**: store `baseOffset = o − header.baseDistance`. Whether an out-of-range value
     refuses *here* rather than falling through to the unresolved path is **DC-7**; §8 row h is
     the defect it addresses.
   - **REF delta**: store `header.baseId`'s bytes.
5. `o = entryEnd`; loop. The existing `entryEnd > trailerStart` and
   `offset !== trailerStart` guards keep their exact positions and messages.

Nothing survives step 5 except fixed-width records. Peak during the pass is **one entry's
inflated payload** plus the read window.

`streamInflate` returns a whole buffer, so that one payload is materialised. `createInflateStream()`
would let the bytes flow into a hasher without ever existing whole — but it **does not report
`bytesConsumed`**, so it cannot drive a walk that must find the next entry. Pass 1 therefore
stays on `streamInflate`, and `largestEntryInflatedBytes` is an irreducible term of §7's bound.
What *is* removable is the **second** full copy `computeLooseObjectId` makes — DC-3.

### 3. The record store

One structure, allocated once, holding every fact pass 2 and the `.idx` writer need.

| Array | Type | Bytes/entry | Why |
|---|---|---|---|
| `offsets` | `Float64Array(N)` | 8 | Pack offsets exceed `2^32` for packs > 4 GiB, which the `.idx` v2 large-offset table already contemplates. `Uint32Array` would be a silent 4 GiB cliff |
| `crcValues` | `Int32Array(N)` | 4 | `crc32` is already a signed 32-bit value in `WalkedEntry` |
| `types` | `Uint8Array(N)` | 1 | 3 bits of pack entry type + a `resolved` flag bit. An all-zero oid slot is **not** a usable "unresolved" sentinel — the zero oid is a legal, if absurd, hash |
| `oids` | `Uint8Array(N × W)` | 20 (SHA-1) / 32 (SHA-256) | `W = ctx.hash.digestLength`. Flat slab, no per-entry allocation; hex is derived once, at the end, for `PackIndexWriterEntry.id` |
| | | **33 / 45** | |

Plus per-delta side tables (`D` deltas, `D_ref` of them REF):

| Array | Type | Bytes | Why |
|---|---|---|---|
| `deltaEntry` | `Int32Array(D)` | 4 | which entry index this delta is |
| `deltaBaseOffset` | `Float64Array(D)` | 8 | OFS base offset; a sentinel for REF |
| `refBaseOids` | `Uint8Array(D_ref × W)` | 20 / 32 | REF base oid bytes |

Two things deliberately **not** stored, because pass 2 re-derives them from a header re-parse
that costs a few varint bytes inside a window it already holds: `dataOffset` and `size`.

The shape follows ADR-770 (`heads`/`next` `Int32Array`s over an array of objects) for the same
reason it did there: iteration is an array walk, so nothing on the path has a container whose
order a reviewer must reason about, and there is no per-entry object allocation. For fixture C
that is `15 074 × 33 B ≈ 497 KB` against today's ~15 074 × (2 Map nodes + 3 objects).

**The array must not be sized from `header.objectCount`** (R3, §9). See DC-2.

Building the two child indexes at the end of pass 1:

- **OFS children**: `Int32Array` of delta ordinals, sorted by `deltaBaseOffset`. Lookup is a
  binary search for the first ordinal whose base offset equals a given offset, then a linear
  walk while equal.
- **REF children**: `Int32Array` of REF-delta ordinals, sorted by base-oid bytes
  (`compareBytes` over slices of the slab). Same lookup shape.

Both are pure sorts over typed arrays. **No `Map`, no `Set`, no `push(...spread)`** — an
`arr.push(...children)` over an array sized by object count overflows the call stack near
125 k elements, which is well inside the range a real clone reaches.

### 4. Pass 2 — resolve from the roots down

The recommended shape (DC-1a) is a depth-first walk of the delta forest, rooted at every base
entry, with the parent's content held on an explicit stack while its children resolve.

```
for each entry b with a base type, in increasing offset:        # the forest roots
    content = inflate(b)                                        # one disk re-read
    walkSubtree(oidOf(b), typeOf(b), content, offsetOf(b))

walkSubtree(oid, type, content, offset):                        # explicit stack, not recursion
    children = ofsChildren(offset) ++ refChildren(oid)
    for each child c in children:
        if resolved(c): continue                                # duplicate-oid guard, see below
        delta        = inflate(c)                               # one disk read
        childContent = applyDelta(content, delta)               # delta dropped here
        childOid     = hash(type, childContent)
        record(c, childOid, type, resolved = true)
        walkSubtree(childOid, type, childContent, offsetOf(c))
        release childContent
    release content                                             # <- the load-bearing line
```

**The `resolved(c)` guard is not defensive padding.** §1f row 5 pins that a pack may legally
carry the *same oid twice* (git's default fetch accepts it, `transfer.fsckObjects` being false).
A REF delta keyed on that oid is then a child of **two** parents, and without the guard it would
be applied twice and `resolvedCount` would overshoot `objectCount` — breaking R8 and turning
DC-6's count into nonsense. An entry has exactly one base *reference*, so this is the only way
a child is reachable twice, and one flag bit closes it.

The `release content` line is what §7's ancestor term depends on: **a parent is released the
moment its last child is dequeued.** Get it wrong and residency becomes `depth × objectSize` for every chain
instead of two objects for a linear one — the difference between §1e's measured 0.39 MB and the
7.99 MB a naive path model predicts. With an explicit stack the equivalent is a per-frame
"children remaining" counter, decremented as each child is popped.

Five properties fall out, and each answers a question the brief asks:

- **No cache is *required*.** A base's content is on the stack exactly while its children need
  it, so nothing has to be re-derived. The "size-budgeted cache" the brief sketches is what an
  *ordinal* sweep needs to be correct-and-fast; a root-down walk needs it only as an
  optimisation, over a much smaller surface (§5's carry-over) — DC-1 picks the algorithm,
  DC-11 decides whether the optimisation ships.
- **Each entry's payload is read at most twice** (pass 1, pass 2) and **applied exactly once**
  (R8). A base with no children is read once and never revisited.
- **Forward REF references resolve** (R5): roots are enumerated by entry *type*, and children
  are found by oid, so a base sitting after its dependents is found on the same pass.
- **Cycles are structurally unreachable** (R11): the walk only ever descends *from* content it
  already holds, so an entry that is not reachable from a base is simply never visited. It
  terminates because it visits each entry at most once, not because a no-progress counter says
  so. Today's `while (unresolved.length > 0)` loop is O(passes × entries) and relies on the
  progress flag.
- **Unresolved detection is a count.** After the walk, `resolvedCount < objectCount` means some
  delta was never reachable. That is exactly git's `pack has <N> unresolved deltas` shape
  (§1f rows 7, 8, 16) — see DC-6.

**Thin packs sit on the same seam.** Before declaring failure, every REF child whose base oid
matched no in-pack entry is offered to `externalBaseResolver(baseOid)`. A resolved external
base becomes an extra forest root: its `{ type, content }` is exactly what `walkSubtree` takes,
and `validateDeltaHeader` already enforces `base.length === sourceLength`, so a wrong-sized
external base refuses rather than producing garbage. The external content is the only object in
the pass whose bytes tsgit did not itself inflate; it is released when its subtree completes.

Ordering the roots by increasing offset keeps pass 2's *root* reads sequential; child reads jump
around, which is unavoidable — the delta forest's shape is the server's choice, not ours.

### 5. Delta chains

A chain `A ← B ← C ← D` is one root-to-leaf path in the forest. The walk descends it once:
`A`'s content resolves `B`; `B`'s content (already in hand) resolves `C`; and so on. **No
element's chain is ever re-resolved** — the arithmetic the brief asks for is that a chain of
depth `d` costs `d` delta applications, not `d(d+1)/2`.

Contrast the alternative the brief sketches (DC-1b): an ordinal sweep resolving `D` first must
reconstruct `C`, which needs `B`, which needs `A` — `d` applications for one delta. With a
cache large enough, the sweep amortises to the same total; with a cache that misses, the cost
is `Σ_i depth(i)` applications and the same number of inflations. On fixture A that sum is
exactly computable from `git verify-pack -v`'s chain histogram — 5 objects at each depth 1…40,
then 7/9/10/10/10/10/11/12/14/3 at depths 41…50:

```
Σ depth  =  5 × (1 + … + 40)  +  (41×7 + 42×9 + 43×10 + 44×10 + 45×10 + 46×10
                                 + 47×11 + 48×12 + 49×14 + 50×3)
         =  4 100 + 4 374  =  8 474        delta applications, against 296 in a root-down walk
```

**Twenty-nine times the work** on a 903-object fixture, in the fully-missing case. That worst
case is what the root-down walk removes by construction, and it is why the recommendation
diverges from the brief.

**Where a cache still earns its keep in design (a):** every base entry that has children is
read from disk twice — once in pass 1 to compute its oid, once in pass 2 as a forest root. A
budget-capped carry-over of pass 1's base contents into pass 2 removes exactly that second read,
and nothing else. That is a much smaller and better-defined cache than DC-1(b)'s, and it is
what DC-11 puts to the user, priced against §1e's measured 2× wall-clock / 96 MiB trade in git.

Depth is **not capped** (§1f row 9: git accepts depth 1 000; tsgit's indexer accepts it today).
The walk uses an explicit stack, so depth costs heap, not the JS call stack (R6). The heap it
costs is §7's ancestor term, and DC-8 is where a ceiling on it would go.

### 6. Where the code lives

`fetch-pack.ts` is already 1 036 lines against a 800-line ceiling. The split:

| Module | Contents | ≈ lines moved |
|---|---|---|
| `fetch-pack.ts` | negotiation, `receivePackToQuarantine`, quarantine lifecycle, `fetchPack`/`materializePack`, `verifyPackTrailer` | keeps ≈ 460 |
| `internal/index-pack.ts` (new) | `PackByteSource` and both implementations (`:484-825`), the two passes, the forest walk, the refusals, `WalkedEntry`, `ExternalBaseResolver` | ≈ 575 taken |
| `internal/pack-records.ts` (new, DC-9b) | the typed-array record store and the two child indexes — pure, no I/O, its own property tests | new |

The byte-source seam moves **with** the indexer, not with the receiver: it exists to feed the
walk, and moving only the pipeline would leave `fetch-pack.ts` at ~800 lines — on the ceiling,
not under it (R14). `walkQuarantinedEntries` becomes a one-line call into
`indexQuarantinedPack(ctx, tmpPath, totalBytes)`, and `bundle-verify.ts`'s import of
`walkPackEntries` re-points at the new module. `DISK_WALK_WINDOW_BYTES` moves with the disk
source and its ten test references re-point with it.

**Two Stryker equivalence proofs are falsified by this change and must be re-proved or
retired**, not carried forward — equivalence comments are structure-specific:

- `windowCovering`'s (`:716`) asserts *"anchor only ever grows; `anchor < window.start` never
  occurs"*. Pass 2 reads backwards. The guard itself is already correct — a non-covering anchor
  falls through to a fresh fetch — but the proof is now false and the mutant is killable.
- `walkFromPending`'s (`:844`, `:846`) asserts the offset sort and its comparator are
  unobservable. The records are filled in offset order by construction, so the sort disappears
  entirely along with its suppressions.

### 7. The memory ceiling, stated honestly

```
R  =  largestEntryInflatedBytes            one entry's payload in flight (pass 1 or pass 2)
   +  Σ_{retained ancestors} contentBytes  ancestors still holding unvisited children
   +  N × RECORD_BYTES                     33 B (SHA-1) / 45 B (SHA-256)
   +  D × DELTA_RECORD_BYTES               12 B, plus 20/32 B per REF delta
   +  oneReadWindow                        DISK_WALK_WINDOW_BYTES, or the one grown window
   +  cacheBudget                          0 unless DC-11 admits one
   +  idxAssembly                          PRE-EXISTING: N × PackIndexWriterEntry + N × SortedEntry
```

**This is not O(1) and the design does not claim it is.** Three terms are unavoidable:

- **A single object can be arbitrarily large.** `MAX_INFLATED_OBJECT_BYTES = 2 GiB` is the
  adapter's own cap; fixture C's largest object is 4.76 MiB, and a repository with a large
  binary blob pays that as a floor. No windowing removes it, because `applyDelta` needs the
  base whole and `streamInflate` returns the payload whole.
- **The retained-ancestor term.** An ancestor is held only while it still has unvisited
  children, so a **linear** chain retains two objects at a time regardless of depth, and only a
  **branching** delta forest retains more. The worst case is `chainDepth × largestObjectBytes`
  — a fully bushy tree — and with no depth cap (§1f row 9) that is formally unbounded; DC-8 is
  where a ceiling would go. §1e's controlled pairs say the typical case is far below it: git,
  with its cache off, pays **0.39 MB** on a fixture whose deepest chain is 50, and **18.28 MB**
  on a 15 074-object, 571 MiB-inflated fixture. The implementation must release a parent as
  soon as its last child is dequeued, or it will land on the worst case instead of the typical
  one — that is the single behaviour this term depends on.
- **`N × RECORD_BYTES` is linear in object count and cannot be avoided**, because the `.idx`
  must list every object. Fixture C: 497 KB. A 10 M-object monorepo: 330 MB for the records and
  more for the final `PackIndexWriterEntry[]`. git pays the same shape — §1e's delta-free
  fixture C control measures its fixed cost at ≈ 1 KB per object.

The last term is today's behaviour, unchanged: `writePackSiblingArtifacts` takes
`ReadonlyArray<PackIndexWriterEntry>` and `sortPackIndexEntries` wraps each in a `SortedEntry`
carrying a fresh 20-byte `Uint8Array` from `hexToBytes(entry.id)`. On fixture C that is ~2.3 MB
transient; on a 10 M-object repo it is the dominant term and would need the slab handed
straight to the serializer — DC-10, recommended out of scope here.

Expected outcome on the fixtures, with the ancestor term taken at its measured-typical rather
than its worst case (the `largestEntryInflatedBytes` term double-counts the deepest ancestor, so
these are upper bounds):

| | largest object | ancestors | records | window | `.idx` assembly | ≈ ceiling | today |
|---|---|---|---|---|---|---|---|
| A | 0.15 MiB | ≤ 7.6 MiB worst / ~0.3 MiB linear | 0.03 MiB | 0.25 MiB | ~0.14 MiB | **< 8.2 MiB** | 75.4 MB |
| C | 4.76 MiB | ~18 MiB (git's measured figure on the same pack) | 0.50 MiB | 0.25 MiB | ~2.3 MiB | **< 26 MiB** | 799.5 MB |

**The assertion in R2 is a class with headroom, never a byte count** — the same discipline the
delta-writing packer's size assertions use, for the same reason: the peer moves, and here the
peer moves by a factor of four depending on one config key (§1e).

### 8. Faithfulness — what changes and what must not

| # | Behaviour | Today | After | Ratified by |
|---|---|---|---|---|
| a | trailer verification before any entry is read | `receivePackToQuarantine`, incremental | unchanged | ADR-728 |
| b | quarantine lifecycle, `tmp_pack_<random>` → rename | unchanged | unchanged | ADR-728 |
| c | `.idx` + `.rev` written, `.rev` last | unchanged | unchanged | — |
| d | empty pack / zero-entry pack suppressed, quarantine reaped | unchanged | unchanged | — |
| e | `PACK_TOO_LARGE` on `maxResponseBytes` / `maxObjectsPerPack` | unchanged | unchanged (§9 revisits what each still defends) | — |
| f | `DECOMPRESS_FAILED` for a corrupt zlib member | unchanged | unchanged — pass 1 still inflates every entry in order | — |
| g | `extra bytes between last entry and trailer` | tsgit-internal string; git says `pack is corrupted (SHA1 mismatch)` | unchanged (out of scope) | — |
| h | OFS distance 0 | **wrong refusal** (`unresolved entry at offset N`) | whatever DC-7 ratifies; the recommendation refuses it as out-of-bound at pass 1, matching git's class | **DC-7** |
| i | OFS distance past the pack start | refused, tsgit-internal wording | verdict unchanged; the wording is DC-7's second half | **DC-7** |
| j | unresolved deltas | `unresolved REF_DELTA: base <id> not in pack` / `unresolved entry at offset <n>` | whatever DC-6 ratifies; the recommendation is git's counting shape, singular at one | **DC-6** |
| k | duplicate oid in one pack | accepted (`.idx` carries the oid twice) | unchanged — git's default fetch accepts it too (`transfer.fsckObjects` defaults false) | — |
| l | delta depth in the indexer | uncapped, matching git | **DC-8** |

Row **l** deserves its own paragraph. `MAX_DELTA_CHAIN_DEPTH = 50` is enforced by
`object-resolver.ts:327` and `fsck/object-cache.ts:223` — the two readers ADR-771 aligned. It is
**not** enforced anywhere in `fetch-pack.ts`, and §1f row 9 confirms tsgit indexes a 1 000-deep
chain today exactly as git does. Row 10 is the consequence: those objects are then unreadable
through tsgit's own resolver. The gap is pre-existing, it is *surfaced* by writing this design
rather than created by it, and closing it at fetch time would be a new refusal on a path git
does not refuse. DC-8 puts the choice to the user rather than taking it.

### 9. Threat model

The bytes are attacker-supplied: a remote server chooses the pack, and `fetchPack` is reached
from `clone`, `fetch`, `pull` and `fetch-missing`.

**Still binding after the redesign**

| Cap | Value | What it defends |
|---|---|---|
| `maxResponseBytes` | 512 MiB default | Total pack body. Enforced during receive, before a single entry is parsed. Unchanged, and it is the outermost bound on everything below |
| adapter `MAX_INFLATED_OBJECT_BYTES` | 2 GiB | One entry's inflated payload — the first term of §7 |
| `streamInflate(…, declaredSize)` | per entry | Every source already narrows the cap to the entry header's declared size, so a mismatched stream aborts at that size rather than the adapter default |
| `MAX_TARGET_LENGTH` (`delta.ts:143`) | 2 GiB | A delta's declared target size, checked by `validateDeltaHeader` before any output buffer is allocated |
| `base.length === sourceLength` | exact | A delta cannot be applied to a base of the wrong size — this is what makes the external-base seam safe |
| trailer verification | before the walk | The `entry extends past pack trailer` guard is defence-in-depth on top of it |

**Changes meaning**

`maxObjectsPerPack` (default 50 000 000) is documented as bounding the point "before
`fetchPack` allocates per-entry state". Today it bounds a `push` loop, so a lying header just
loops until the first inflate fails (§1f row 12). **After this change it would bound a real
up-front allocation** — 50 M × 33 B = 1.65 GB — if the record arrays were sized from
`header.objectCount`. They must not be (R3). Two bounds are available and both are free:

1. **A structural clamp.** §1f pins the minimum entry at 9 bytes, so a pack of `T` bytes holds
   at most `(T − 12 − digestLength) / 9` entries. Combined with `maxResponseBytes` that is
   ≈ 59.6 M entries at the default — tighter than the declared field, still large.
2. **Geometric growth.** Size the arrays from a small initial capacity and grow as entries are
   actually parsed. A header declaring 50 M entries over a 3-entry pack then allocates for 3.
   Cost is a transient 1.5× during a copy.

DC-2 chooses between them. The failure mode being defended is precise: *a small pack with a
huge declared count*, which is a one-packet DoS today only in CPU and would become one in
memory if the naive shape shipped.

**Not defended, before or after**

- A **branching** delta forest whose ancestors are each near `MAX_INFLATED_OBJECT_BYTES` makes
  §7's retained-ancestor term enormous. The pack-size cap bounds the *compressed* input, not the
  inflated path, and a delta may declare a target far larger than its base. DC-8(c) is the only
  option that closes it. A *linear* chain is not exposed, because a parent is released at its
  last child (§4).
- A pack of many small objects still costs `N × 33 B` plus the `.idx` materialisation. That is
  inherent to writing an index.
- Cycles and unreachable deltas cost nothing new: the forest walk never visits them (§4).

### 10. Degenerate inputs, enumerated

Every row is a test case, and every row was run against real git in §1f.

| Input | git | tsgit today | Must be after |
|---|---|---|---|
| **empty pack** (`objectCount = 0`) | accepts | 0 entries, quarantine reaped, empty result | unchanged — pass 1 loops zero times, `offset === trailerStart` holds |
| **single base entry, no deltas** | accepts | 1 entry | pass 2 walks one root with no children |
| **pack that is all deltas** (no base entry) | `pack has 2 unresolved deltas` | refuses (different string) | refuses — the forest has **no roots**, so `resolvedCount` is 0 |
| **zero-length inflated object** | accepts | 1 entry | accepted. `streamInflate(bytes, off, 0)` narrows the cap to 0; zero output does not *exceed* zero. Needs its own test — the `<=` vs `<` in the cap is a live mutant |
| **delta whose base is the last entry** | accepts | accepts | accepted — only reachable as a REF delta (OFS is structurally backward); roots are enumerated by type, not position |
| **REF delta whose base is a later entry** | accepts | accepts | accepted (R5) |
| **duplicate oid** | accepts (default), refuses under `--strict` | accepts | unchanged verdict, but the child index must tolerate two entries with equal oid bytes and the walk must apply each child **once** — the `resolved(c)` guard in §4, without which `resolvedCount` overshoots `objectCount` |
| **chain of depth 1** | accepts | accepts | one root, one child |
| **chain saturating `pack.depth` (50)** | accepts | accepts | fixture A is exactly this shape |
| **chain of depth 1 000** | accepts | accepts | accepted; explicit stack (R6) |
| **REF cycle** | `pack has 2 unresolved deltas` | refuses | refuses, structurally (§4) |
| **OFS distance 0** | `delta base offset is out of bound` | wrong reason | DC-7 |
| **OFS base landing mid-entry** | `pack has 1 unresolved delta` | `unresolved entry at offset 64` | refuses — the child index is keyed on **entry** offsets, so a mid-entry base matches no root and the delta is never visited. Same verdict as git, reached differently |
| **object whose inflated size exceeds one read window** | accepts | accepts (window doubling ladder) | unchanged in pass 1; pass 2 must grow the window the same way for a **base** re-read, which today's ladder only ever exercises forward |

### 11. Blast radius

| Symbol | Kind | Change | Consumers to sweep |
|---|---|---|---|
| `fetchPack` | exported, in `api.json` | none | `clone.ts:200`, `fetch.ts:161`, `fetch-missing.ts:114`, `pull.ts` (via `fetch`), `commondir-writes.test.ts:358` |
| `FetchPackInput` / `FetchPackResult` | exported, in `api.json` | none | as above |
| `RepositoryConfig.maxObjectsPerPack` / `.maxResponseBytes` | in `api.json` | **doc comment only** — `maxObjectsPerPack`'s stated purpose changes (§9) | `ports/context.ts:142,150` |
| `walkPackEntries` | module export, **not** in `api.json` | body replaced; signature kept; **import path moves** to `internal/index-pack.ts` | `bundle-verify.ts:20,78`, `fetch-pack.test.ts` (≈10 references) |
| `ExternalBaseResolver` | module export, not in `api.json` | shape unchanged; **import path moves** | `bundle-verify.ts:18,170`, `fetch-pack.test.ts` |
| `verifyPackTrailer` | module export, not in `api.json` | none — stays in `fetch-pack.ts` | `bundle-verify.ts:75` |
| `DISK_WALK_WINDOW_BYTES` | module export, not in `api.json` | value unchanged; **import path moves** with the disk source | `fetch-pack.test.ts` (≈10 references) |
| `WalkedEntry` | module-private **type**, but structurally the return of an exported function | none | `bundle-verify.ts` binds it implicitly; `writePackSiblingArtifacts` consumes it as `PackIndexWriterEntry` |
| `PendingEntry`, `ResolvedEntry` | module-private | **deleted** | — |
| `inflateAllEntries`, `resolveAllEntries`, `walkFromPending`, `tryResolveEntry`, `resolveDelta`, `computeLooseObjectId`, `firstUnresolvedError`, `refDeltaBaseId` | module-private | replaced / moved | — |
| `writePackSiblingArtifacts` | internal | none (R13) | — |

**`reports/api.json` does not move** (R12) — the only public shapes involved are `fetchPack`
and its two types, and none changes. The regenerated report is still committed and diffed, per
the standing pre-push gate; a zero diff is the expected result and is itself the check.

`test/unit/application/primitives/fetch-pack.test.ts` is ~3 000 lines and is where most of the
work lands. The window-behaviour tests (`requestedLengths` assertions around
`DISK_WALK_WINDOW_BYTES`) pin *pass 1's* read pattern and survive; pass 2 adds a second,
backward-jumping read pattern that needs its own assertions.

Not touched: `pack-registry.ts`'s `deltaBaseCache` (a *read*-path cache for already-indexed
packs), `object-resolver.ts`, `build-pack.ts`, and every `.idx`/`.rev` serializer.

---

## Decision candidates

Eleven load-bearing choices. **The designer decides none of these.**

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DC-1** | **How pass 2 resolves deltas** | (a) **Child-indexed forest walk**: roots are base entries, children found by base offset / base oid, a parent's content held on an explicit stack and released when its last child is done. **No cache.** (b) **Offset-ordered sweep with a byte-capped LRU base cache** (the brief's shape), sized on ADR-736's additive pattern, keyed on `ctx.session` per ADR-722. (c) **Hybrid**: forest walk, plus an LRU only for externally-resolved thin-pack bases. | **(a)** | (a) applies each delta exactly once and reads each entry at most twice, with no budget to tune and no config key to pin (§5). §1e's `core.deltaBaseCacheLimit` sweep is the evidence: with git's cache **off**, delta resolution costs 0.39 MB on fixture A and 18.28 MB on fixture C — so a memory-safe root-down algorithm is what git's own indexer rests on, and the cache is a speed layer above it (DC-11). (b) is what the brief sketches and keeps pass 2 a flat loop, but a fully-missing cache costs `Σ_i depth(i)` delta applications — **8 474 against 296** on fixture A (§5) — and needs a budget whose only faithful key is `core.deltaBaseCacheLimit`, which brings an int-config finder, an eager assertion and a refusal pin. (c) buys nothing (a) does not already give: an external base is a root like any other, and there is exactly one per unresolved REF oid. |
| **DC-2** | **How the record arrays are sized, given `objectCount` is attacker-controlled** | (a) Allocate up front at `min(header.objectCount, maxObjectsPerPack, structuralMax)` where `structuralMax = (totalBytes − 12 − digestLength) / 9` (§1f). (b) **Grow geometrically** from a small capacity; `header.objectCount` is only a loop bound. (c) Array of `{ offset, crc32, type, oid }` objects — no sizing question, ~5× the bytes. | **(b)** | (b) is the only one where a lying header costs nothing: a 50 M-entry claim over a 3-entry pack allocates for 3. Its cost is a transient 1.5× during each doubling, bounded by the *real* entry count. (a) is exact and free but still lets a 512 MiB pack claim ~59.6 M entries → 1.97 GB of records before a single byte is validated; the clamp is worth keeping as a second bound *under* (b), not instead of it. (c) abandons ADR-770's precedent and roughly quintuples §7's `N` term for no gain. |
| **DC-3** | **How a base entry's oid is computed** | (a) **Incremental**: `h = ctx.hash.createHasher(); h.update(headerBytes); h.update(content); await h.digestHex()`. (b) Keep `computeLooseObjectId`'s concatenated `headerBytes ++ content` buffer. (c) (a) on Node, (b) elsewhere, behind a capability probe. | **(a)** | The port already has `createHasher()`. On Node it is `crypto.createHash`, genuinely incremental, and (a) removes a **full second copy of every object** — measurable in §1d's fixture-B multiple (2.36× Σ inflated for a corpus with zero deltas). **The asymmetry must be stated, not hidden**: the memory and browser hash adapters implement `createHasher` by pushing chunks into an array and concatenating at `digest()` time, because SubtleCrypto has no streaming digest. So (a) is a clear win on Node and *exactly neutral* elsewhere — it never regresses, and it removes the copy on the runtime that clones large repositories. (c) is (a) with a branch that buys nothing. Note that neither option removes §7's `largestEntryInflatedBytes` term: `createInflateStream()` could, but it does not report `bytesConsumed`, so it cannot drive pass 1. |
| **DC-4** | **How pass 2 reads bytes at arbitrary offsets** | (a) **`ctx.fs.readSlice`** through the existing `PackByteSource` seam — one `open`+`read`+`close` per window fetch on Node. (b) Hold one `ctx.fs.openWithNoFollow(path, 'read')` `FileHandle` for the whole pass. (c) Add an optional `FileSystem` capability for scoped random reads, with (a) as the fallback. | **(a)** | **(b) is not portable: `browser-file-system.ts:201` throws `UNSUPPORTED_OPERATION` for `openWithNoFollow`**, so it would break clone/fetch in the browser unless paired with an (a) fallback anyway — two code paths for one job. `readSlice` is implemented by every adapter and is already the primitive `object-resolver`'s hot path uses. (b) also reopens the `FileHandle` GC-leak class the repo has already paid for once, and the port's own doc says *"Holding handles open across async boundaries can leak file descriptors on Node — keep usage tight."* (c) is the honest escape hatch if a measured syscall profile demands it, but it is a port change (three adapters plus the memory fake) for a cost nobody has measured yet. |
| **DC-5** | **Does `walkPackEntries` (in-memory, `bundle-verify`'s only gate) share the new path?** | (a) **Share** — one indexer over the existing `PackByteSource` seam, two sources. (b) Keep the old pipeline for the in-memory source. (c) Replace `walkPackEntries` with a validate-only entry point that returns nothing, since its one caller discards the array. | **(a)** | The seam exists precisely so the walk is written once (`fetch-pack.ts:484-499`), and `bundle verify` has the *same* residency problem: on a bundle of tsgit's history it would hold 571 MiB today. (a) fixes it for free and keeps one code path to mutation-test. (b) preserves two implementations of the same logic, which `check:duplicates` exists to catch. (c) is a genuine simplification — `bundle-verify.ts:78` really does discard the result — but it changes a module export's contract for a caller count of one, and it can be done any time after (a). |
| **DC-6** | **The unresolved-delta refusal** | (a) Keep both strings **byte-identical** (`unresolved REF_DELTA: base <id> not in pack`, `unresolved entry at offset <n>`). (b) Adopt git's shape: one reason, `pack has <N> unresolved deltas`, same `INVALID_PACK_HEADER` code. (c) (b) plus structured fields on `TsgitError.data` (`unresolvedCount`, `firstUnresolvedOffset`). | **(b)** | §1f rows 7/8/16 pin git's wording as a **count**, and today's strings are tsgit-internal — there is no faithfulness debt to preserve, only tests. The forest walk produces the count for free; naming "the first" unresolved entry requires an extra scan and is *less* meaningful than today, because a DFS discovers unreachable entries as a set with no queue order to be first in. (a) costs that extra scan to preserve a string that was never faithful. (c) is (b) plus more, and ADR-249 favours structured fields — take it if the user wants a machine-readable count; the extra fields are additive on an error `data` shape that is not in `api.json`. |
| **DC-7** | **The OFS base-offset guard** | (a) Widen the guard to `baseOffset < PACK_HEADER_BYTES \|\| baseOffset >= entryOffset` and keep tsgit's current message. (b) (a) **plus** adopt git's reason (`delta base offset is out of bound`). (c) Leave the guard as-is; a zero distance keeps falling through to the unresolved path. | **(b)** | §1f row 15 is a defect: git refuses a zero distance as out-of-bound at the entry, tsgit reports `unresolved entry at offset 37` — the wrong diagnosis for a structurally invalid pack, and one that would now be folded into DC-6's count and lose the offset entirely. (a) fixes the *verdict*; (b) also fixes the *reason*, and since DC-6 already opens the refusal-wording question, doing both in one change keeps one ADR instead of two. (c) is only defensible if the user wants zero refusal-surface movement in this change. |
| **DC-8** | **Delta depth in the index pass** | (a) **No cap**, matching git (§1f row 9 pins acceptance at depth 1 000). (b) Refuse beyond `MAX_DELTA_CHAIN_DEPTH` (50), so tsgit never indexes a pack its own resolver cannot read. (c) No depth cap, but a **path-bytes budget**: refuse when the walk's retained content exceeds a budget, bounding §7's retained-ancestor term. | **(a)** | (a) is what git does and what tsgit does today; changing it would add a refusal on a path git accepts, which is the divergence direction ADR-226 forbids by default. But (a) leaves §7's retained-ancestor term formally unbounded, which §9 names as undefended. (b) closes the §1f row-10 gap — a pack tsgit indexes but cannot read — at the cost of refusing a legal pack; note that ADR-771 deliberately set `MAX_DELTA_CHAIN_DEPTH` to git's *writer* default, which is not a statement about what a reader must accept. (c) bounds the memory without touching the depth semantics, and is the option to take if R1's formula must have no unbounded term; its cost is a new budget with no git key to borrow — `core.deltaBaseCacheLimit` describes a cache, not a path. |
| **DC-9** | **Module layout** | (a) One new module, `internal/index-pack.ts`. (b) Two: `internal/index-pack.ts` (passes, I/O) + `internal/pack-records.ts` (typed-array store + child indexes, pure). (c) Keep everything in `fetch-pack.ts`. | **(b)** | (c) is out: `fetch-pack.ts` is 1 036 lines against an 800 ceiling and this adds more than it removes. (b) puts the record store and the two child indexes — sorted typed arrays with binary-search lookup — behind a pure boundary that takes property tests naturally (round-trip: every recorded entry is retrievable; invariant: a child index lookup returns exactly the ordinals whose base key matches). (a) is fine and smaller, but folds a pure data structure into an I/O module and loses that lens. Neither module is coverage-gated (the 100 % gate covers `domain/` and `adapters/`), so mutation is the gate that will notice. |
| **DC-10** | **Does the `.idx`/`.rev` writer keep taking `PackIndexWriterEntry[]`?** | (a) **Yes** — one final materialisation of N objects with hex oids, exactly as today. (b) Widen `sortPackIndexEntries`/`serializePackIndex`/`serializePackRevIndex` to accept the oid **slab** plus parallel `crc`/`offset` arrays, removing §7's last O(N)-objects term. | **(a)** | (a) keeps R13 true and the domain serializers untouched; the term it leaves is **pre-existing**, not a regression, and it is ~2.3 MB on fixture C. (b) is the right long-term shape — `sortPackIndexEntries` currently calls `hexToBytes(entry.id)` to re-derive bytes the record store already holds, so (b) removes a round-trip as well as an allocation — but it moves three domain serializers with their own goldens and cross-tool pins, and it is cleanly separable from the residency problem this change is about. Take (b) only if the user wants the `N`-term closed in the same PR. |
| **DC-11** | **Does a delta-base cache ship in this change, and on what budget?** | (a) **No cache.** Take git's cache-off profile: fixture C at ~33 MB and ~2× the wall clock of git's default. (b) **A pass-1→pass-2 carry-over cache** of base contents, bounded by an internal budget derived from `ctx.deltaCache.maxSize` (ADR-727/736's fraction pattern), keyed on `ctx.session` (ADR-722). Removes the second read of every base that has children — the only re-work design (a) has. (c) (b) but bounded by **`core.deltaBaseCacheLimit`**, git's own key, honoured with its 96 MiB default and its `k`/`m`/`g` unit grammar. | **(b)** | §1e prices the trade in git precisely: **1.84× and 2.07× wall clock** for up to 96 MiB per thread. That is a real cost, so (a)'s "no cache" is not free — it is a deliberate 2× on clone latency. But (b)'s cache is a *different, smaller* cache than git's: design (a) already reads each entry at most twice, so the only re-work available to save is one re-read per base-with-children, and a modest budget captures most of it. (b) keeps the residency knob on tsgit's existing `deltaCacheMaxBytes` axis, which ADR-736 already documents as the one dial for this family, and adds no config surface (R12 stays true). (c) is the faithful-key answer and has ADR-772's precedent behind it — prefer git's key over a private constant — but git's key describes *git's* cache, whose hit pattern this design does not reproduce, so honouring the number would imply a parity that is not there; it also costs an int-config finder, an eager assertion and a refusal pin, and moves `api.json`. Ship (b) if the 2× matters; ship (a) if the first PR should change exactly one thing. |

---

## Test strategy

### Unit — `test/unit/application/primitives/internal/pack-records.test.ts` (new, DC-9b)

Pure, `describe('Given …')` > `describe('When …')` > `it('Then …')`, AAA, `sut`.

| Area | Cases |
|---|---|
| record store | store/read back `offset`, `crc32`, `type`, `oid` for entry 0, entry N−1, and a middle entry; SHA-1 (20 B) and SHA-256 (32 B) widths; the `resolved` flag distinguishing "unresolved" from "resolved to the all-zero oid" |
| growth (DC-2b) | capacity crossing exactly at the doubling boundary, one below, one above; contents preserved across every growth |
| OFS child index | zero children; one; two children of the same base (adjacent ordinals); children of *different* bases interleaved by offset; a base offset present in the delta table but with no matching entry |
| REF child index | same five shapes over oid bytes; **two entries with equal oids** (§10's duplicate row) |
| guard clauses | `baseOffset < PACK_HEADER_BYTES` and `baseOffset >= entryOffset` as **separate** tests, each triggering exactly one condition, each asserting `error.data` via try/catch — never a bare `toThrow(Class)` |

### Property — `test/unit/application/primitives/internal/pack-records.properties.test.ts` (new)

The record store is a compositional store/lookup pair and the child indexes are compositional
matchers, so lenses 1 and 2 apply. Generators in a sibling `arbitraries.ts`.

| # | Lens | Property | `numRuns` |
|---|---|---|---|
| P1 | round-trip | for an arbitrary list of `(offset, crc32, type, oid)` records, reading index `i` back returns exactly what was written | **200** |
| P2 | compositional matcher | `ofsChildren(k)` returns exactly the ordinals whose recorded base offset equals `k`, for an arbitrary collection of base offsets — empty input returns empty; appending a record with base `k` grows the result by one | 100 |
| P3 | compositional matcher | same for `refChildren(oid)` over arbitrary oid byte arrays, duplicates included | 100 |
| P4 | counting invariant | `Σ_k |ofsChildren(k)| + Σ_o |refChildren(o)| = D` for any collection of deltas | 100 |

No seed is ever committed.

### Unit — `test/unit/application/primitives/fetch-pack.test.ts` (extended)

The existing ~3 000-line file already builds synthetic packs (`pack-fixture.ts`,
`buildSyntheticPack`, `EntrySpec`) and drives `fetchPack` through a fake negotiator. Extend
rather than duplicate.

- **Equivalence (R4).** For every existing synthetic fixture *and* for fixture A's real pack,
  the new indexer's `WalkedEntry` set equals the old one's. This is the regression net; it runs
  before anything else.
- **Every §10 row** as its own case, through both entry points.
- **Pass-2 read pattern.** The existing `requestedLengths` spies pin pass 1's forward window
  ladder; add assertions that pass 2 issues *backward* anchors and that no single requested
  length exceeds one grown window.
- **`walkPackEntries` parity (DC-5a).** In-memory and disk sources produce identical results on
  the same bytes — the test that already exists (`fetch-pack.test.ts:2309`) extended to the
  fixtures with deep chains and forward REF references.
- **Thin packs (R7).** Base present → resolves; base absent → refuses; base present but the
  **wrong size** → refuses through `validateDeltaHeader`, not silently.
- **Untrusted count (R3, §9).** A pack declaring `objectCount = 50_000_000` with three real
  entries: the call refuses on the first bad inflate and total allocation stays proportional to
  three, asserted through a spy on the record store's capacity rather than through memory.

### Integration — `test/integration/index-pack-interop.test.ts` (new)

Cross-tool, `describe.skipIf(!GIT_AVAILABLE)`, one shared `beforeAll` repo, 60 s timeout (the
known interop load→validate flake), `runGit` env-scrubbed per `interop-helpers.ts`. Carries a
`@proves` header in `packfile-interop.test.ts`'s grammar.

Every row of §1f becomes a case, with git as the peer on the same crafted bytes:

| # | Given | Then |
|---|---|---|
| X1 | a pack tsgit indexed | `git verify-pack <idx>` exits **0** with no output, and `git show-index < <idx>` lists the same `(offset, oid)` set tsgit recorded |
| X2 | the crafted OFS-distance-0 pack | both refuse; git's reason tail is `delta base offset is out of bound` and tsgit's `data` matches DC-7's ratified shape |
| X3 | the crafted REF-cycle pack and the all-deltas pack | both refuse; git says `pack has 2 unresolved deltas` and tsgit's count agrees (DC-6) |
| X4 | the crafted forward-REF pack | both accept, same oid set |
| X5 | chains at depth 50 / 51 / 1 000 | both accept (DC-8a); if DC-8b is ratified instead, this row inverts and becomes the divergence pin |
| X6 | four identical zero-length blobs | git without `--strict` accepts, tsgit accepts; `git index-pack --strict` refuses and tsgit's divergence is **recorded, not asserted away** |
| X7 | a real thin pack (`pack-objects --thin --revs`) | tsgit refuses without a resolver; with the store's bases available it completes, and `git index-pack --stdin --fix-thin` accepts the same bytes |
| X8 | fixture C's pack indexed by tsgit | `git fsck --strict --no-progress` in the resulting repo exits **0** with zero output on both streams |

⚠️ Any case that corrupts an entry *header* must recompute the pack trailer, or git answers
`fatal: pack is corrupted (SHA1 mismatch)` and never reaches the condition under test — §1f
rows 11 and 13 are exactly that shape.

### Bench — `test/bench/fetch-pack.bench.ts`

Two scenarios, both on committed generators reproducing fixtures A and C:

- **Residency (R1, R2).** The assertion is a **class with headroom** against §7's formula, never
  a byte count, and it is measured with a **kernel high-water mark from a child process** —
  §1d's methodology note is binding: an in-process sampler cannot see this pipeline's peak.
- **Throughput.** Pass 1 + pass 2 wall clock against today's single pass, so the second read of
  every entry is priced rather than assumed free. Published numbers come from CI's nightly bench
  artifact; local runs are for the design only.

### Mutation

Target 0 survivors. Known-hazardous spots to write kill tests for up front:

- `RECORD_BYTES` and every field offset in the record store — each needs a case whose *output*
  changes when the constant does.
- The growth factor and the `capacity <= needed` comparison (DC-2b) — a case landing exactly on
  the boundary.
- `baseOffset >= entryOffset` versus `>` (DC-7) — the self-reference case (`distance === 0`) is
  the killer, and it is the defect §1f row 15 found.
- `resolvedCount < objectCount` versus `!==` — a pack where the walk resolves *more* entries
  than declared is unreachable, so prove the equivalence or restructure rather than suppress.
- Binary-search bounds in both child indexes — the classic loop-bound equivalent family. Any
  suppression is **re-proved against this code**, never carried forward; the same rule retires
  `windowCovering`'s existing proof (§6).
- The `declaredSize`/`maxOutputBytes` cap on a zero-length object (`<=` vs `<`).

**Coverage scope vs mutation scope.** The 100 % gate covers `domain/` and `adapters/`; Stryker
mutates all of `src/`. Both new modules live under `application/primitives/internal/`, so they
are mutated but not coverage-gated — their tests must be written to the same standard anyway,
because mutation is the gate that will notice if they are not.

---

## Out of scope

- **Parallel delta resolution.** git's own `--threads` multiplies residency: `man 1
  git-index-pack` says so in as many words, and §1e measures fixture A going from 11.1 MB at
  one thread to 42 MB at eleven. Trading the memory this change exists to reclaim for wall
  clock, in the same change, would make the R2 measurement unreadable. A bounded pool over
  forest roots through `ctx.concurrency` is a clean follow-up once the sequential ceiling is
  pinned.
- **Two-phase progress reporting.** git shows `Indexing objects` then `Resolving deltas`; tsgit
  reports one op for the whole receive. Adding progress ops is a surface change with its own
  ADR-249 question (what structured fields does a caller get?) and is separable.
- **`extra bytes between last entry and trailer`** (§8 row g). tsgit hashes the whole body minus
  the digest, so its trailer check passes where git's — which hashes only the declared entries —
  fails with `pack is corrupted (SHA1 mismatch)`. Both refuse; the divergence is in which check
  fires and predates this change.
- **Closing the index/read depth gap** (§1f row 10). Whether `MAX_DELTA_CHAIN_DEPTH` should
  bind the indexer is DC-8; whether it should bind the *readers* at all belongs to ADR-771's own
  record, not here.
- **`--strict`-class object checks.** git's `index-pack --strict` runs fsck checks (duplicate
  oid, malformed objects) that the default fetch path does not, because `transfer.fsckObjects`
  and `fetch.fsckObjects` both default to **false** (pinned, §1f row 5). tsgit has `fsck`; wiring
  a `--strict` equivalent into the fetch path is a config surface with its own faithfulness pins.
- **`--max-input-size` as a config key.** `maxResponseBytes` already covers the byte cap with a
  different message (§1f row 18). Aligning the message is a separable faithfulness item.
- **The `.idx`/`.rev` serializers' entry shape** (DC-10b). Removing the last O(N)-objects term
  means moving three domain serializers with their own goldens; separable from residency.
- **`walkPackEntries`'s existence** (DC-5c). Its one caller discards the result; collapsing it
  to a validate-only gate is a follow-up, not a prerequisite.
- **Anything in `pack-registry.ts`.** `deltaBaseCache` (ADR-736) serves the *read* path over
  already-indexed packs and is untouched by this change.
