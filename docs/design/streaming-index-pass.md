# Design — streaming index pass for received packs

> Brief: the fetch/clone receive path already streams the pack to quarantine at O(window) RSS
> and walks it back from disk in bounded 256 KiB windows, but the *entry* pipeline still holds
> every entry's inflated content in memory at once. Replace it with a true bounded-memory
> indexer in `git index-pack`'s shape — a sequential first pass that hashes base entries and
> records delta positions, a second pass that resolves deltas without retaining the whole
> corpus, thin-pack external bases on the same seam.
> Status: **revised against ADRs 779–789** (every decision candidate ratified) → self-reviewed ×3

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

**Three fields, and none of them needs to be an object.** ADR-789 takes that one step further:
after this change `writePackSiblingArtifacts` consumes the same three fields as *parallel typed
arrays* (`PackIndexEntries`, §3a) rather than `N` objects carrying hex strings. `WalkedEntry`
survives only as `walkPackEntries`' return type, for `bundle verify` (ADR-783, §7a).

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
| **ADR-736** delta-base cache is additive, not a fraction | The reason a *new* byte budget must be justified rather than assumed free, **and the citation this design originally got wrong**: ADR-736 *considered* a fraction and **rejected** it, keeping `deltaBaseCache` at a full additive `deltaCacheMaxBytes`. The fraction siblings are ADR-726 (FlatTree, 1/16) and ADR-727 (parsed-object memo, 1/16). There is therefore **no sizing precedent to inherit** — ADR-788 |
| **ADR-727** parsed-commit memo is a byte-capped LRU | The *mechanical* shape only: `createLruCache(maxBytes, maxEntries)`, a byte cap paired with an entry cap, and an entry sizer carrying a fixed per-entry overhead term — its 2026-08-27 amendment records that omitting that term undercounts a typical entry by roughly an order of magnitude |
| **ADR-625** one shared pack-offset sort for `.idx` and `.rev` | One ordering definition feeds both serializers so the two artefacts cannot disagree about index positions. ADR-789 widens the *input shape* of that definition and **preserves the invariant** — §6a makes it structural rather than documentary |
| **ADR-776** `PackWriterEntry` becomes a union | The precedent for ADR-789's break: last release 3.6.0, the 4.0.0 release PR still open, so a published-type change costs no additional major bump |
| **ADR-770** the base index is two `Int32Array`s | The prior art for §3's record store: parallel typed arrays over an array of objects, chosen so iteration order is an array walk |
| **ADR-771** both readers accept git's full delta depth | `MAX_DELTA_CHAIN_DEPTH = 50` binds `collectDeltaChain` and fsck's `walkDeltaChain`. It does **not** bind this indexer today (§1f row 9, §8 row l) |
| **ADR-772** window memory bounds residency | Precedent for preferring git's own config key over a private constant — but `pack.windowMemory` is a *writer* key and is not this path's |
| **ADR-720** lazy `.rev`-first successor lookup | The read path a freshly indexed pack lands in; untouched |
| **ADR-722** caches key on a session token | ADR-788's base cache keys on `ctx.session`, never on `Context` identity — a `pull` derives a Context between its fetch and its merge, which is the bug family ADR-722 closed |
| `design/delta-writing-packer.md` §12 | Names this change and records the two seams it moved: `serializePackfile` still takes a materialised array, and `buildPack` gained a metadata pass structurally similar to §2's |

This design's own eleven choices are settled. Each is stated as a rule in §Decisions and cited
inline where it binds:

| ADR | Settles |
|---|---|
| **779** | Pass 2 is a root-down forest walk with a `resolved` duplicate-oid guard (§4) |
| **780** | The record arrays grow geometrically; the declared count is never an allocation input (§3, §9) |
| **781** | Base oids hash incrementally through `createHasher()` (§2) |
| **782** | Pass 2 reads at arbitrary offsets through `ctx.fs.readSlice` (§4) |
| **783** | The in-memory walk shares the indexer (§6, §11) |
| **784** | The unresolved-delta refusal is git's count, singular at one (§8) |
| **785** | A zero or forward OFS base offset refuses as `delta base offset is out of bound` (§2, §8) |
| **786** | No depth cap in the index pass; the unbounded retained-ancestor term is knowingly accepted (§5, §7, §9) |
| **787** | Two new modules: `internal/index-pack.ts` + `internal/pack-records.ts` (§6) |
| **788** | One byte-capped base cache on its own measured budget, replacing `bundle-verify`'s unbounded `Map` (§5) |
| **789** | The `.idx`/`.rev`/`.mtimes` serializers take the oid slab (§6a, §7, §11) |

---

## Requirements

Everything below is verifiable by a test named in §Test strategy.

**Memory**

- **R1** The index pass's peak retained bytes are bounded by §7's closed formula —
  `largestEntryInflatedBytes + Σ_{retained ancestors} contentBytes + N × RECORD_BYTES +
  D × DELTA_RECORD_BYTES + one read window + INDEX_PASS_BASE_CACHE_MAX_BYTES + idxAssembly` —
  and are **independent of Σ inflated over the pack**. Asserted by a bench-side memory scenario
  on the §1c fixtures, measured from a child process's kernel high-water mark (§1d's methodology
  note).
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

- **R4** For every pack the current pipeline accepts, the new one produces the **same
  `(oid, crc32, offset)` set** — read as a `WalkedEntry[]` through `walkPackEntries`, and as a
  `PackIndexEntries` slab on the `fetchPack` path (ADR-789). Proved by running both over the
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

**Contracts moved, deliberately**

- **R12** `reports/api.json` **moves, and the move is exactly six symbols** (ADR-789):
  `PackIndexWriterEntry`, `SortedEntry`, `sortPackIndexEntries`, `serializePackIndex`,
  `serializePackRevIndex` — the five ADR-789 names — plus **`serializeCruftMtimes`**, which
  ADR-789 does not name but which consumes `SortedEntry` and `PackIndexWriterEntry` in its own
  signature (`cruft-pack.ts:42,45`) and therefore cannot stay behind (§6a). This is a
  **breaking change to published types**, and it rides the pending **4.0.0** exactly as ADR-776
  reasoned for `PackWriterEntry`: the last release is 3.6.0, the 4.0.0 release PR is still open,
  so it costs one major bump rather than two. The commit carries the conventional-commit `!`
  breaking marker, as the two prior 4.0.0-bound breaks did.
  Three symbols are **added** alongside — `PackIndexEntries`, `SortedPackIndex` and
  `packIndexEntriesFrom` — which is additive, not breaking. The regenerated `reports/api.json`
  is committed, and its diff is the scope check: **those six moved and three added, and nothing
  else** (plus `BuildPackResult` if DC-A(b) is taken). Anything further in that diff means the
  change leaked past its blast radius. No *config* key is added.
- **R13** The `.idx`, `.rev` and `.mtimes` **bytes are unchanged for every entry set**, while the
  serializers' input shape widens to the oid slab. Concretely, all four must hold:
  - **R13a** Every existing byte-exact golden in `pack-writer.test.ts`, `rev-index.test.ts` and
    `cruft-pack.test.ts` keeps its expected bytes **verbatim**; only the arrangement that builds
    the input changes. A single moved byte means the change is wrong.
  - **R13b** `git verify-pack` / `git fsck --strict` / `git show-index` accept a tsgit-written
    `.idx` produced **from the indexer's own slab**, not only from a converted array
    (§Test strategy X1, X9).
  - **R13c** ADR-625's invariant holds and is **strengthened**: one ordering definition still
    feeds `.idx`, `.rev` and `.mtimes`, and the widened signature makes the pairing structural —
    the permutation travels *with* the entry set it was computed from, so a caller can no longer
    hand a serializer a permutation belonging to a different entry set.
  - **R13d** Exactly **one** implementation of the ordering and of each serializer exists.
    `check:duplicates` (jscpd) and a direct equivalence test are the oracles (§Test strategy).
- **R14** `fetch-pack.ts` ends **below** the repo's 800-line file ceiling — the byte-source seam
  moves with the indexer, not just the pipeline, or the file lands *on* the ceiling rather than
  under it (§6). No new module exceeds it either.
- **R15** The base cache is an **optimisation over an already-correct walk**: with
  `INDEX_PASS_BASE_CACHE_MAX_BYTES` forced to `0`, every §10 degenerate input, both §1c fixtures
  and the thin-pack fixtures produce **identical results** — same `WalkedEntry` set, byte-identical
  `.idx`/`.rev`, same refusals with the same `TsgitError.data` — and differ only in latency
  (ADR-788). This is a test, not a claim.

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
and V8's footprint high-water absorbs the churn rather than smoothing it. ADR-781 removes that
copy.

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
decisions and were settled separately: ADR-779 takes the memory-safe algorithm, ADR-788 adds one
byte-capped cache above it on its own measured budget. These numbers are why "no cache" was not
treated as the free option — it is a deliberate ~2× on clone latency.

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
| 15 | OFS distance **0** (self reference) | `fatal: pack has bad object at offset 37: delta base offset is out of bound` | 128 | `INVALID_PACK_HEADER` / **`unresolved entry at offset 37`** | ⚠️ **wrong refusal** — tsgit's guard is `baseOffset < PACK_HEADER_BYTES` only, so `37 − 0 = 37` passes it and the entry falls through to "base not yet resolved". Fixed by ADR-785 |
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
  not in queue order), so keeping today's strings byte-identical would have been a cost, not a
  default. **ADR-784 takes git's count**, singular at one, under the unchanged
  `INVALID_PACK_HEADER` code, and does **not** add structured `unresolvedCount` /
  `firstUnresolvedOffset` fields.
- **Row 15 is a real defect this design must fix.** git treats a zero distance as out-of-bound;
  tsgit reports the wrong reason for it. **ADR-785 widens the guard and adopts git's reason.**
- **Row 9 is why the indexer must not inherit `MAX_DELTA_CHAIN_DEPTH`.** git's indexer has no
  depth cap, and neither does tsgit's today. ADR-771 pins the *readers* at 50. Row 10 shows the
  consequence: tsgit will happily index a pack it cannot later read. That gap is pre-existing;
  **ADR-786 leaves it open** rather than closing it with a refusal git does not make.

Also pinned, and used in §7/§9:

- **Minimum pack entry = 9 bytes** (one type/size byte plus the 8-byte zlib stream of an empty
  payload) — measured on a hand-built pack of four zero-length blobs (68 bytes total = 12
  header + 4 × 9 + 20 trailer). So a pack of `T` bytes can hold at most
  `(T − 12 − digestLength) / 9` entries, regardless of what its header declares.
- `core.deltaBaseCacheLimit`, `man 1 git-config`, verbatim: *"Maximum number of bytes **per
  thread** to reserve for caching base objects that may be referenced by multiple deltified
  objects. … Default is 96 MiB on all platforms."* This is git's own key for *git's* base cache,
  and its "per thread" wording is the same multiplication the `--threads` man text describes.
  ADR-788 deliberately does **not** honour this key: it describes a cache whose hit pattern this
  design does not reproduce, so borrowing its number would imply a parity that is not there.
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
   - **base** (`COMMIT|TREE|BLOB|TAG`): compute the oid from `result.output` **incrementally**
     — `h = ctx.hash.createHasher(); h.update(headerBytes); h.update(result.output);
     await h.digestHex()` (ADR-781) — and store it in the record slab. `result.output` is then
     dropped, or offered to the base cache (§5) when the entry turns out to have children.
   - **OFS delta**: store `baseOffset = o − header.baseDistance`, **after** the widened guard:
     `baseOffset < PACK_HEADER_BYTES || baseOffset >= entryOffset` refuses **here**, at the
     entry, with git's reason `delta base offset is out of bound` (ADR-785). §8 row h is the
     defect it fixes. A base offset that is in range but lands mid-entry is *not* caught here —
     it stays an unresolved-delta count under ADR-784, which is the same split git makes.
   - **REF delta**: store `header.baseId`'s bytes.
5. `o = entryEnd`; loop. The existing `entryEnd > trailerStart` and
   `offset !== trailerStart` guards keep their exact positions and messages.

Nothing survives step 5 except fixed-width records. Peak during the pass is **one entry's
inflated payload** plus the read window.

`streamInflate` returns a whole buffer, so that one payload is materialised. `createInflateStream()`
would let the bytes flow into a hasher without ever existing whole — but it **does not report
`bytesConsumed`**, so it cannot drive a walk that must find the next entry. Pass 1 therefore
stays on `streamInflate`, and `largestEntryInflatedBytes` is an irreducible term of §7's bound.
What *is* removed is the **second** full copy `computeLooseObjectId` makes (ADR-781).

**The adapter asymmetry is recorded, not hidden** (ADR-781): Node's `createHasher()` wraps
`crypto.createHash` and is genuinely incremental; the memory and browser adapters implement it by
collecting chunks and concatenating at `digest()` time, because SubtleCrypto has no streaming
digest. So the change is a clear win on Node and *exactly neutral* elsewhere — it never
regresses, and it removes the copy on the runtime that clones large repositories. If those
adapters ever gain a true streaming digest they inherit the benefit with no call-site change.

### 3. The record store

One structure, allocated once, holding every fact pass 2 and the `.idx` writer need.

| Array | Type | Bytes/entry | Why |
|---|---|---|---|
| `offsets` | `Float64Array(N)` | 8 | Pack offsets exceed `2^32` for packs > 4 GiB, which the `.idx` v2 large-offset table already contemplates. `Uint32Array` would be a silent 4 GiB cliff |
| `crcValues` | `Int32Array(N)` | 4 | `crc32` is already a signed 32-bit value in `WalkedEntry` |
| `types` | `Uint8Array(N)` | 1 | 3 bits of pack entry type + a `resolved` flag bit. An all-zero oid slot is **not** a usable "unresolved" sentinel — the zero oid is a legal, if absurd, hash |
| `oids` | `Uint8Array(N × W)` | 20 (SHA-1) / 32 (SHA-256) | `W = ctx.hash.digestLength`. Flat slab, no per-entry allocation. **Under ADR-789 this slab is the `.idx`/`.rev` serializers' input** — hex is never derived on the fetch path at all (§3a) |
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

**The arrays are never sized from `header.objectCount`** (R3, §9). ADR-780: capacity grows
**geometrically** from a small initial size as entries are actually parsed; the declared count is
a loop bound and nothing else. The structural clamp — `(totalBytes − 12 − digestLength) / 9` from
§1f's pinned 9-byte minimum entry — is kept as a second bound *underneath* the growth, not
instead of it. A 50 M-entry claim over a 3-entry pack allocates for 3; the cost is a transient
1.5× during each doubling, bounded by the *real* entry count.

Because capacity exceeds `count`, the arrays are **over-allocated by construction**. Everything
downstream is bounded by an explicit `count`, never by `array.length` — §3a makes that part of
the type.

Building the two child indexes at the end of pass 1:

- **OFS children**: `Int32Array` of delta ordinals, sorted by `deltaBaseOffset`. Lookup is a
  binary search for the first ordinal whose base offset equals a given offset, then a linear
  walk while equal.
- **REF children**: `Int32Array` of REF-delta ordinals, sorted by base-oid bytes
  (`compareBytes` over slices of the slab). Same lookup shape.

Both are pure sorts over typed arrays. **No `Map`, no `Set`, no `push(...spread)`** — an
`arr.push(...children)` over an array sized by object count overflows the call stack near
125 k elements, which is well inside the range a real clone reaches.

#### 3a. What crosses the boundary

ADR-789 makes the slab the serializers' input, so its layout is load-bearing beyond pass 2 and
its type has to be **domain-owned** — the dependency rule is absolute: `domain` never imports
outward, so an application type may not reach inward.

**Three of the four per-entry arrays cross. The fourth, and every delta side table, never does.**

| Array | Crosses? | Why |
|---|---|---|
| `oids`, `crcValues`, `offsets` | **yes** | Exactly the `.idx`'s SHA table, CRC table and offset table |
| `types` (3 type bits + `resolved` flag) | no | Pass-2 bookkeeping; the `.idx` records no object type |
| `deltaEntry` / `deltaBaseOffset` / `refBaseOids` and the two child indexes | no | The delta forest is consumed and discarded inside pass 2 |

The carrier is a plain-typed-array value type in `src/domain/storage/pack-order.ts`:

```ts
/** One pack's index inputs in EMISSION order (ascending pack offset).
 *  Arrays may be longer than `count` — `count` is the only bound. */
export interface PackIndexEntries {
  readonly count: number;
  readonly digestLength: number;   // 20 | 32
  readonly oids: Uint8Array;       // >= count * digestLength
  readonly crcValues: Int32Array;  // >= count
  readonly offsets: Float64Array;  // >= count
}

/** An entry set paired with its own oid-ascending permutation:
 *  index position p holds entry ordinal `order[p]`. */
export interface SortedPackIndex {
  readonly entries: PackIndexEntries;
  readonly order: Uint32Array;     // length === entries.count
}
```

Four properties of this shape are the reason it is this shape and not another:

1. **Nothing but typed arrays and numbers crosses.** `PackIndexEntries` has zero platform
   dependencies and zero application imports, so it satisfies the domain's own invariant. The
   application-side record store (`internal/pack-records.ts`) *imports* it — application →
   domain, the permitted direction — and exposes its own arrays as a `PackIndexEntries` **view**:
   the same buffers, no copy, and no narrowing `subarray` (that is what `count` is for). Its
   store type, its `types` array and its child indexes stay application-owned and never appear in
   a domain signature.
2. **`count` is explicit, so geometric growth (ADR-780) needs no narrowing step.** A `subarray`
   would work too, but it makes "the view's length is the truth" a second invariant to hold; one
   `count` is cheaper to reason about and cheaper to mutation-test.
3. **`SortedPackIndex` carries the permutation *with* the entry set it was computed from.**
   Today `serializePackIndex(entries, checksum, presorted?)` documents "`presorted` MUST be
   `sortPackIndexEntries(entries)`" in a comment and enforces it nowhere. Pairing them in one
   value makes ADR-625's invariant **structural**: the `.idx` and the `.rev` cannot be handed
   orderings from different entry sets, because there is only one value to hand over.
4. **The slab is complete only after pass 2.** Delta entries' oid slots are filled as the forest
   walk resolves them, so the record store hands over a `PackIndexEntries` only once
   `resolvedCount === objectCount` — i.e. only on the path where ADR-784's refusal did not fire.

**The `.idx` and `.rev` are still written from ordinals, never from strings.** A serializer reads
entry `k` as `crcValues[k]`, `offsets[k]`, and the byte range
`[k * digestLength, (k + 1) * digestLength)` of `oids` — copied into the output with
`bytes.set(oids.subarray(…), …)`, which allocates a view object and never the 20 bytes.
`hexToBytes` leaves the path entirely, and with it the slab → hex → slab round-trip ADR-789
measured.

The record store also keeps a **strictly increasing** `offsets` array by construction (pass 1
walks forward), and so does `serializePackfile` for the other producer. `.rev`'s
`packPositionsByOffset` still **sorts** rather than assuming it: the assumption is a producer
invariant no serializer signature states, and the sort is already measured and typed-array-based.

### 4. Pass 2 — resolve from the roots down

Pass 2 is a depth-first walk of the delta forest (ADR-779), rooted at every base entry, with the
parent's content held on an explicit stack while its children resolve. Every byte it reads at an
arbitrary offset goes through `ctx.fs.readSlice`, reusing the existing `PackByteSource` seam and
its window ladder (ADR-782) — never a held `FileHandle`, which `browser-file-system.ts` cannot
provide (`openWithNoFollow` throws `UNSUPPORTED_OPERATION`) and which reopens a descriptor-leak
class this repository has already paid for once.

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
ADR-784's count into nonsense. An entry has exactly one base *reference*, so this is the only way
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
  optimisation, over a much smaller surface (§5). ADR-788 ships that optimisation; R15 is the
  test that keeps it an optimisation.
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
  delta was never reachable. ADR-784 makes that the refusal verbatim:
  `pack has <N> unresolved delta(s)`, **singular at one**, under the unchanged
  `INVALID_PACK_HEADER` code, where `N = objectCount − resolvedCount`. Three cases converge on
  it — a REF cycle, an all-deltas pack with no base entry, and an OFS base offset landing
  mid-entry (§1f rows 7, 8, 15b) — which is exactly what git does on the same bytes.

**Thin packs sit on the same seam.** Before declaring failure, every REF child whose base oid
matched no in-pack entry is offered to `externalBaseResolver(baseOid)`. A resolved external
base becomes an extra forest root: its `{ type, content }` is exactly what `walkSubtree` takes,
and `validateDeltaHeader` already enforces `base.length === sourceLength`, so a wrong-sized
external base refuses rather than producing garbage. The external content is the only object in
the pass whose bytes tsgit did not itself inflate; it is released when its subtree completes —
or, under ADR-788, handed to the one base cache, which is what makes the resolver's own
memoisation unnecessary (§5).

Ordering the roots by increasing offset keeps pass 2's *root* reads sequential; child reads jump
around, which is unavoidable — the delta forest's shape is the server's choice, not ours.

### 5. Delta chains

A chain `A ← B ← C ← D` is one root-to-leaf path in the forest. The walk descends it once:
`A`'s content resolves `B`; `B`'s content (already in hand) resolves `C`; and so on. **No
element's chain is ever re-resolved** — the arithmetic the brief asks for is that a chain of
depth `d` costs `d` delta applications, not `d(d+1)/2`.

Contrast the alternative the brief sketched — an ordinal sweep with a byte-capped base cache,
which ADR-779 rejected. Resolving `D` first must
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
case is what the root-down walk removes by construction, and it is why ADR-779 diverges from the
brief's sketch.

Depth is **not capped** (§1f row 9: git accepts depth 1 000; tsgit's indexer accepts it today).
ADR-786 keeps it that way: adding a refusal where git accepts is the divergence direction the
prime directive forbids by default, and ADR-771 set `MAX_DELTA_CHAIN_DEPTH = 50` from git's
*writer* default, which says nothing about what a reader or an indexer must accept. The walk uses
an explicit stack, so depth costs heap, not the JS call stack (R6). The heap it costs is §7's
retained-ancestor term, and ADR-786 accepts that term as **formally unbounded, knowingly** — §9
names the exposure it leaves undefended.

#### 5a. One base cache, on its own measured budget (ADR-788)

The walk leaves exactly one piece of re-work: **every base entry that has children is read from
disk twice** — once in pass 1 to compute its oid, once in pass 2 as a forest root. And the
thin-pack seam already carries a cache today, on the wrong side of the port and **unbounded**:
`bundle-verify.ts:170`'s `buildExternalBaseResolver` wraps `ExternalBaseResolver` in a
`Map<ObjectId, content>` that retains every externally-resolved base — and memoises `undefined`
results too — for the life of the verify.

ADR-788 collapses both into **one** structure:

| | |
|---|---|
| Shape | A single byte-capped `createLruCache<CachedBase>` inside the indexer, keyed on `ctx.session` (ADR-722), never on `Context` identity |
| Serves | pass-1 base contents carried into pass 2, **and** externally-resolved thin-pack bases |
| Replaces | `bundle-verify.ts:170`'s unbounded `Map`. Its resolver becomes a plain port call — `resolveExternalBase(ctx, baseOid)` with no memo of its own |
| Budget | **`INDEX_PASS_BASE_CACHE_MAX_BYTES`**, its own named constant, defaulted from the measurement below. Not a fraction of `deltaCacheMaxBytes`, and not equal to it |
| Entry sizer | `content.byteLength + INDEX_PASS_BASE_CACHE_ENTRY_OVERHEAD_BYTES`, paired with `INDEX_PASS_BASE_CACHE_MAX_ENTRIES` — ADR-727's 2026-08-27 amendment records that a byte cap without a fixed overhead term and an entry cap undercounts a typical entry by roughly an order of magnitude |

Deleting the `Map` is a **residency fix in its own right**, independent of the pack-size win: the
design's earlier claim that "a thin-base cache buys nothing" was measuring hit rate against the
wrong thing. There was never a question of *adding* retention to that path — there was an
unbounded retention already on it, and this bounds it.

**Two keyspaces, one cache.** In-pack bases key on `o:<passId>:<offset>`; external bases key on
`x:<oid>`. The `passId` is a per-invocation counter: two index passes sharing a session must not
collide on a raw pack offset, and external oids are already globally unique within the
repository. The pass `clear()`s the cache when it finishes — success or failure — so the byte
budget is never retained past the pass that needed it. That is what reconciles ADR-788's
`ctx.session` keying with its own "transient (one index pass)" consequence; it is safe under R15
precisely because dropping a live entry another pass is using can only cost a re-read, never a
different result.

**`ctx.session`, not `Context` identity.** A `pull` derives a Context between its fetch and its
merge; ADR-722 exists because nine identity-keyed caches were silently dropped by exactly that.
Be clear about what session-keying buys here: sharing between *overlapping* passes, and nothing
else, because the clear-on-exit makes the cache per-pass in every other respect. A purely
per-call cache — `bitmap-reconstruct.ts:46`'s `RECONSTRUCTION_CACHE_MAX_BYTES` shape, explicitly
*"never cached on a `Context`"* — would have been the alternative; ADR-788 names `ctx.session`,
so `ctx.session` it is.

##### The measurement the implementation owes

ADR-788 pins the *shape* and leaves the *number* to a measurement. The default is not chosen
until this runs, and it is recorded in the plan as a gating step, not as a nice-to-have.

**What is measured** — three quantities per fixture. Peak footprint comes from a **child
process's kernel high-water mark**; §1d's methodology note is binding here too, because an
in-process sampler cannot see this pipeline's peak. The first two come from instrumentation
inside the pass, not from memory sampling:

1. **The demand curve.** `Σ inflatedBytes(b)` over base entries `b` with at least one child —
   the total working set a perfect cache would hold. This is the ceiling the sweep approaches,
   and it is computable up front from `git verify-pack -v`'s chain listing as a cross-check on
   the instrumented run.
2. **Hit rate against budget.** Sweep `INDEX_PASS_BASE_CACHE_MAX_BYTES` over
   `{0, 1, 2, 4, 8, 16, 32, 64} MiB`, recording base re-reads avoided ÷ base-entries-with-children.
3. **Wall clock and peak footprint at each budget**, median of three, single-threaded.

**On which fixtures** — all four, because each isolates something different:

| Fixture | Isolates |
|---|---|
| **A** (§1c) | Deep chains (depth 50) over *small* objects — largest object 159 748 B, so every candidate budget can hold many roots |
| **B** (§1c) | The delta-free control: the cache must be **inert** here (no base has children), so any wall-clock or footprint movement is measurement noise or a bug |
| **C** (§1c) | A real clone pack whose largest object is **4.76 MiB** — the fixture that discriminates budgets, because a budget below that cannot hold even one large root |
| **thin** (§1f rows 16–17, plus a bundle with prerequisites) | The external-base half, which fixture C does not exercise at all |

**What makes a candidate default right:** it sits at the **knee** of the wall-clock curve — the
smallest budget within 5 % of the unbounded-cache wall clock on **both** A and C — and it leaves
fixture C's measured peak inside R2's class with headroom.

**What makes a candidate default wrong** — any one of these falsifies it, and each is a real
failure mode rather than a formality:

- **No knee.** If wall clock keeps improving roughly linearly all the way to the demand curve's
  total, the cache is "retain everything" wearing a budget, and the residency claim is hollow.
  The honest response is a much smaller budget and a documented smaller speed-up, not a bigger
  budget.
- **Below the largest object.** A budget under `largestEntryInflatedBytes` cannot hold one root
  on fixture C. This is exactly the falsifier ADR-788 records against the 1/16-fraction option:
  1 MiB at the default `deltaCacheMaxBytes` against a 4.76 MiB object holds almost nothing, so
  most second reads happen anyway.
- **Peak rises by more than the budget.** Then the entry sizer is wrong — the classic symptom
  ADR-727's amendment describes — and the constant is meaningless until the sizer is fixed.
- **Fixture B moves.** The cache must be inert on a pack with no deltas. Movement there means
  something is being cached that has no children.

The result is a number a future profile can revisit without reopening ADR-788's shape, and it is
published as a local sizing measurement — never as a performance claim, which per repo policy
comes only from CI's nightly bench artifact.

### 6. Where the code lives

`fetch-pack.ts` is already 1 036 lines against a 800-line ceiling. The split:

| Module | Contents | ≈ lines moved |
|---|---|---|
| `fetch-pack.ts` | negotiation, `receivePackToQuarantine`, quarantine lifecycle, `fetchPack`/`materializePack`, `verifyPackTrailer` | keeps ≈ 460 |
| `internal/index-pack.ts` (new) | `PackByteSource` and both implementations (`:484-825`), the two passes, the forest walk, the refusals, `WalkedEntry`, `ExternalBaseResolver` | ≈ 575 taken |
| `internal/pack-records.ts` (new, ADR-787) | the typed-array record store and the two child indexes — pure, no I/O, its own property tests. Exposes its slab as a domain `PackIndexEntries` view (§3a) | new |

The byte-source seam moves **with** the indexer, not with the receiver: it exists to feed the
walk, and moving only the pipeline would leave `fetch-pack.ts` at ~800 lines — on the ceiling,
not under it (R14). `walkQuarantinedEntries` becomes a one-line call into
`indexQuarantinedPack(ctx, tmpPath, totalBytes)`, and `bundle-verify.ts`'s import of
`walkPackEntries` re-points at the new module. `DISK_WALK_WINDOW_BYTES` moves with the disk
source and its ten test references re-point with it.

ADR-789 adds a **second** touched area, in the domain rather than the application layer:

| Module | Change |
|---|---|
| `src/domain/storage/pack-order.ts` | Gains `PackIndexEntries` and `SortedPackIndex` (§3a) and the adapter `packIndexEntriesFrom`; `sortPackIndexEntries` re-typed; `SortedEntry` deleted. Currently 28 lines |
| `src/domain/storage/pack-writer.ts` | `serializePackIndex` re-typed; its body indexes through the permutation instead of dereferencing `SortedEntry.entry` |
| `src/domain/storage/rev-index.ts` | `serializePackRevIndex` re-typed; `packPositionsByOffset` reads offsets from the slab through the permutation |
| `src/domain/storage/cruft-pack.ts` | `serializeCruftMtimes` re-typed — **not named by ADR-789, but forced by it** (§6a) |
| `src/application/primitives/internal/write-pack-artifacts.ts` | `buildIdx` / `buildRev` / `buildCruftMtimes` and the three `writePack*Artifacts` input types carry `PackIndexEntries`/`SortedPackIndex` instead of `PackIndexWriterEntry[]`/`SortedEntry[]` |

No new *domain* module is created: `pack-order.ts` is 28 lines today and is the ordering
definition's existing home, so ADR-625's "one shared helper" stays one file.

**Three Stryker equivalence proofs are falsified by this change and must be re-proved or
retired**, not carried forward — equivalence comments are structure-specific, and a
data-structure migration falsifies a carried-forward proof even when the verdict survives:

- `windowCovering`'s (`fetch-pack.ts:716`) asserts *"anchor only ever grows; `anchor <
  window.start` never occurs"*. Pass 2 reads backwards. The guard itself is already correct — a
  non-covering anchor falls through to a fresh fetch — but the proof is now false and the mutant
  is killable.
- `walkFromPending`'s (`fetch-pack.ts:844`, `:846`) asserts the offset sort and its comparator
  are unobservable. The records are filled in offset order by construction, so the sort
  disappears entirely along with its suppressions.
- `bundleVerify`'s (`bundle-verify.ts:76`) asserts that always building the external resolver
  *"only allocates a Map+closure `walkPackEntries` never invokes"*. ADR-788 deletes that Map, so
  the sentence describes code that no longer exists. The *verdict* may still hold — a
  0-prerequisite bundle's pack is self-contained, so the resolver is still never invoked — but
  the proof must be restated against the plain port call, or the suppression retired.

#### 6a. The widened serializers (ADR-789)

Today, and after:

```ts
// today
sortPackIndexEntries(entries: ReadonlyArray<PackIndexWriterEntry>): ReadonlyArray<SortedEntry>
serializePackIndex   (entries, packChecksum, presorted?: ReadonlyArray<SortedEntry>): Uint8Array
serializePackRevIndex(entries, packChecksum, presorted?: ReadonlyArray<SortedEntry>): Uint8Array
serializeCruftMtimes (entries, packChecksum, mtimeOf, presorted?: ReadonlyArray<SortedEntry>): Uint8Array

// after
packIndexEntriesFrom (entries: ReadonlyArray<PackIndexWriterEntry>, digestLength: number): PackIndexEntries
sortPackIndexEntries (entries: PackIndexEntries): SortedPackIndex
serializePackIndex   (sorted: SortedPackIndex, packChecksum: Uint8Array): Uint8Array
serializePackRevIndex(sorted: SortedPackIndex, packChecksum: Uint8Array): Uint8Array
serializeCruftMtimes (sorted: SortedPackIndex, packChecksum: Uint8Array, mtimeOf): Uint8Array
```

Four things about that diff are deliberate.

**1. The optional `presorted` parameter is gone, and the sort is mandatory.** It has to be:
`sortPackIndexEntries` can no longer be called from inside a serializer without also knowing the
digest width, and the `presorted ?? sortPackIndexEntries(entries)` fallback exists in **three**
serializers today with a comment in each saying *"`presorted` MUST be
`sortPackIndexEntries(entries)`"* — an invariant enforced by prose. Taking one `SortedPackIndex`
deletes three branches, three mutants and three prose invariants at once, and makes ADR-625's
guarantee structural (R13c). Every production call site already sorts once and passes `presorted`,
so no caller loses anything; the six test-side call sites that relied on the default
(`packfile-interop.test.ts:102,187`, `pack-fixture.ts:152`, `pack-pair.ts:71`,
`bitmap-closure.scenario.ts:158`, `fsck-degraded-store.scenario.ts:87`) gain one
`sortPackIndexEntries(packIndexEntriesFrom(…))` wrap, using the **production** adapter rather
than a test-local copy.

**2. Width is validated where it is already validated.** Each serializer derives
`digestLength` from `packChecksum.length` today and refuses anything but 20 or 32. It now also refuses a slab that disagrees with it:
`entries.digestLength !== packChecksum.length`, `oids.length < count * digestLength`,
`crcValues.length < count`, `offsets.length < count`, `order.length !== count`. These are cheap
structural guards on a value that now carries five coupled fields instead of one array, and each
gets its own isolated test with `error.data` asserted (never a bare `toThrow(Class)`).

**3. `serializeCruftMtimes` is dragged along, and keeps its `mtimeOf(oid)` contract.** ADR-789
names five symbols; this is the sixth, because its own signature mentions both
`PackIndexWriterEntry` and `SortedEntry`. Its body needs an `ObjectId` per index position to call
`mtimeOf`, which the slab does not carry — so it derives one with `bytesToHex` over the slab range
inside the write loop. That is a **transient** string per object, immediately unreferenced, where
today the same hex is *retained* for every object in the `PackIndexWriterEntry[]`; the cruft path
therefore gets strictly better, not worse. Changing `mtimeOf` to take an ordinal instead would
also work and would remove the hex entirely — it is not taken, because it moves a *published
callback contract* on a path this change is not about, and `gc-pipeline.ts:562`'s
`mtimeOrThrow(mtimes, id)` is naturally oid-keyed.

**4. There is exactly one implementation.** No overload, no union input, no private slab path
beside a public array path — that shape is the fork ADR-625 and `check:duplicates` both exist to
prevent, and ADR-789 names it as the outcome to avoid. Callers that hold a
`PackIndexWriterEntry[]` convert **once**, through `packIndexEntriesFrom`, before entering the
pipeline; from that point down there is one shape.

Which callers those are, and where the conversion belongs, is the one choice this revision could
not settle from the ratified record — **DC-A**, the sole entry in §Decision candidates.

### 7. The memory ceiling, stated honestly

```
R  =  largestEntryInflatedBytes            one entry's payload in flight (pass 1 or pass 2)
   +  Σ_{retained ancestors} contentBytes  ancestors still holding unvisited children
   +  N × RECORD_BYTES                     33 B (SHA-1) / 45 B (SHA-256)
   +  D × DELTA_RECORD_BYTES               12 B, plus 20/32 B per REF delta
   +  oneReadWindow                        DISK_WALK_WINDOW_BYTES, or the one grown window
   +  INDEX_PASS_BASE_CACHE_MAX_BYTES      ADR-788's named budget (§5a), 0 when disabled
   +  idxAssembly                          ADR-789: N × 4 B permutation + the artefact buffers
```

**This is not O(1) and the design does not claim it is.** Three terms are unavoidable:

- **A single object can be arbitrarily large.** `MAX_INFLATED_OBJECT_BYTES = 2 GiB` is the
  adapter's own cap; fixture C's largest object is 4.76 MiB, and a repository with a large
  binary blob pays that as a floor. No windowing removes it, because `applyDelta` needs the
  base whole and `streamInflate` returns the payload whole.
- **The retained-ancestor term.** An ancestor is held only while it still has unvisited
  children, so a **linear** chain retains two objects at a time regardless of depth, and only a
  **branching** delta forest retains more. The worst case is `chainDepth × largestObjectBytes`
  — a fully bushy tree — and with no depth cap (§1f row 9) that is formally unbounded.
  **ADR-786 accepts this knowingly**, and does not add a path-bytes budget to close it; if the
  unbounded term is ever judged unacceptable, that budget is the shape to revisit and it does not
  require reopening the depth semantics. §1e's controlled pairs say the typical case is far below it: git,
  with its cache off, pays **0.39 MB** on a fixture whose deepest chain is 50, and **18.28 MB**
  on a 15 074-object, 571 MiB-inflated fixture. The implementation must release a parent as
  soon as its last child is dequeued, or it will land on the worst case instead of the typical
  one — that is the single behaviour this term depends on.
- **`N × RECORD_BYTES` is linear in object count and cannot be avoided**, because the `.idx`
  must list every object. Fixture C: 497 KB. A 10 M-object monorepo: 330 MB for the records. git
  pays the same shape — §1e's delta-free fixture C control measures its fixed cost at ≈ 1 KB per
  object.

#### 7a. `idxAssembly`: the term ADR-789 changes in character

**The design's earlier "~2.3 MB" was an undercount, and the correction is what carried ADR-789.**
It counted only `sortPackIndexEntries`' own allocation and not the hex-bearing array beneath it.
Session-measured on fixture C's 15 074 objects:

| | fixture C, 15 074 objects | per entry |
|---|---|---|
| `PackIndexWriterEntry[]`, each with a 40-char hex id | **7.36 MB** | |
| `SortedEntry[]` + N × `Uint8Array(20)` from `hexToBytes(entry.id)` | **2.42 MB** | |
| **pair, today** | **9.79 MB** | **649 B** |
| at 1 000 000 objects | **421.89 MB** | |
| at 10 000 000 objects | **exhausts Node's default heap inside `entries.map()`** | |

So the pipeline runs slab → hex → slab per object, and the round-trip is also the term.

After ADR-789 the slab **is** the input, and it is already counted in `N × RECORD_BYTES` — it is
handed over as a view, not copied (§3a). The 649 B/entry pair disappears outright. What is left
is one new 4 B/entry array, plus the artefact buffers that were always there and are unchanged
by this decision:

| Component | Bytes/entry (SHA-1) | Before | After | Lifetime |
|---|---|---|---|---|
| `PackIndexWriterEntry[]` + `SortedEntry[]` + N × `Uint8Array(20)` | 649 | ✓ | **gone** | until the last artefact is written |
| `SortedPackIndex.order` — `Uint32Array(N)` | 4 | — | ✓ | whole artefact write; shared by `.idx`, `.rev` and `.mtimes` (ADR-625) |
| `.idx` body, `1052 + 28 N` | 28 | ✓ | ✓ | retained until `writeExclusive` returns |
| `buildIdx`'s trailer append (a second `body.length + digestLength` buffer) | 28 | ✓ | ✓ | transient, inside `buildIdx` |
| `.rev` body, `52 + 4 N` | 4 | ✓ | ✓ | written after the `.idx` |
| `packPositionsByOffset` scratch — `Uint32Array(N)` + `Float64Array(N)` | 12 | ✓ | ✓ | transient, inside `serializePackRevIndex` |
| **peak** (the `buildIdx` instant: pair + order + body + append) | | **705 B** | **60 B** | |

**705 B/entry → 60 B/entry, an 11.8× reduction of the term**, and `hexToBytes` leaves the path.
The reduction *is* the 649 B pair; the residual 60 B is 4 B of permutation over the 56 B of
artefact buffers this change does not touch.

On fixture C: **10.13 MiB → 0.86 MiB.** At 1 000 000 objects the pair alone is the measured
**421.89 MB**, so the assembly peak goes from ≈ 478 MB to ≈ 60 MB. At 10 000 000 the pair
**exhausts Node's default heap inside `entries.map()`**, where the post-789 term is ≈ 600 MB of
typed arrays — large, and honestly not small, but allocatable. That difference — heap exhaustion
versus a large `ArrayBuffer` — is the qualitative change, not the ratio.

⚠️ **The per-entry cost is not scale-invariant** — the pair measures 649 B/entry at 15 074
objects and 422 B/entry at 1 000 000. Extrapolating either figure to the other scale would be
wrong, so both are quoted from their own measurement and neither is derived from the other.

One place still materialises the old shape, deliberately: **`walkPackEntries` keeps its
`WalkedEntry[]` return** (ADR-783), and its single caller `bundle-verify.ts:78` discards it. That
is `N × ~490 B` of pure waste on the bundle path. ADR-783 considered collapsing
`walkPackEntries` to a validate-only entry point and explicitly deferred it as *"available at any
time after"* option 1 and not a prerequisite, so this design does not take it; `fetchPack` itself
never calls `walkPackEntries` and never builds the array.

Expected outcome on the fixtures, with the ancestor term taken at its measured-typical rather
than its worst case (the `largestEntryInflatedBytes` term double-counts the deepest ancestor, so
these are upper bounds). `B` is the ADR-788 budget, pending §5a's measurement:

| | largest object | ancestors | records | window | `idxAssembly` | ≈ ceiling | pre-789 ceiling | today |
|---|---|---|---|---|---|---|---|---|
| A | 0.15 MiB | ≤ 7.6 MiB worst / ~0.3 MiB linear | 0.03 MiB | 0.25 MiB | **0.05 MiB** | **< 8.1 MiB + B** | < 8.7 MiB | 75.4 MB |
| C | 4.76 MiB | ~18 MiB (git's measured figure on the same pack) | 0.47 MiB | 0.25 MiB | **0.86 MiB** | **< 24.4 MiB + B** | < 33.7 MiB | 799.5 MB |

The `pre-789 ceiling` column is the same formula with the corrected 705 B/entry term — i.e. what
this design would have shipped had it kept `PackIndexWriterEntry[]`, and **not** the "< 26 MiB"
the first draft printed, which carried the undercount. ADR-789 removes ≈ 9.3 MiB from fixture C's
ceiling, over a quarter of it.

**The assertion in R2 is a class with headroom, never a byte count** — the same discipline the
delta-writing packer's size assertions use, for the same reason: the peer moves, and here the
peer moves by a factor of four depending on one config key (§1e). `B` must be small enough that
`24.4 MiB + B` stays well inside R2's class; that is one of §5a's acceptance conditions.

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
| h | OFS distance 0 | **wrong refusal** (`unresolved entry at offset N`) | refused at the entry as `delta base offset is out of bound`, git's own reason and git's own split | **ADR-785** |
| i | OFS distance past the pack start | refused, tsgit-internal wording | same verdict, now with git's reason | **ADR-785** |
| j | unresolved deltas | `unresolved REF_DELTA: base <id> not in pack` / `unresolved entry at offset <n>` | `pack has <N> unresolved delta(s)`, singular at one, same `INVALID_PACK_HEADER` code. **No structured `unresolvedCount` / `firstUnresolvedOffset` fields** — offered as option 3 and not taken | **ADR-784** |
| k | duplicate oid in one pack | accepted (`.idx` carries the oid twice) | unchanged — git's default fetch accepts it too (`transfer.fsckObjects` defaults false) | — |
| l | delta depth in the indexer | uncapped, matching git | uncapped, unchanged | **ADR-786** |
| m | `.idx` / `.rev` / `.mtimes` bytes for a given entry set | — | **byte-identical** (R13); only the serializers' input shape widens | **ADR-789** |
| n | thin-pack external base resolution | `bundle-verify` memoises every resolved base, and every `undefined`, in an unbounded `Map` | one byte-capped LRU inside the indexer; the resolver is a plain port call. Same verdicts, bounded residency | **ADR-788** |

Row **j** carries one consequence worth stating plainly: `TsgitError.data.code` is unchanged, so
any consumer branching on the code is unaffected — a consumer matching the *reason text* sees a
new string. That text was never git-faithful, so there is no faithfulness debt being spent, only
tests being updated.

Row **l** deserves its own paragraph. `MAX_DELTA_CHAIN_DEPTH = 50` is enforced by
`object-resolver.ts:327` and `fsck/object-cache.ts:223` — the two readers ADR-771 aligned. It is
**not** enforced anywhere in `fetch-pack.ts`, and §1f row 9 confirms tsgit indexes a 1 000-deep
chain today exactly as git does. Row 10 is the consequence: those objects are then unreadable
through tsgit's own resolver. The gap is pre-existing, it is *surfaced* by writing this design
rather than created by it, and closing it at fetch time would be a new refusal on a path git
does not refuse. **ADR-786 leaves the gap open deliberately**, and records that whether
`MAX_DELTA_CHAIN_DEPTH` should bind the *readers* at all belongs to ADR-771's own record.

Row **n** is a residency change, not a faithfulness one — git has no `bundle verify` equivalent
to be faithful to here. It is listed because it is an observable retention the design originally
missed.

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

**ADR-780 takes both**: geometric growth is the sizing rule, with the structural clamp kept as a
second bound *underneath* it, not instead of it. The failure mode being defended is precise:
*a small pack with a huge declared count*, which is a one-packet DoS today only in CPU and would
become one in memory if the naive shape shipped. Under ADR-780 a 50 M-entry claim over a 3-entry
pack allocates for 3, and `maxObjectsPerPack`'s doc comment moves with the change because it no
longer guards "before `fetchPack` allocates per-entry state" — nothing allocates from the
declared count at all.

**Not defended, before or after**

- A **branching** delta forest whose ancestors are each near `MAX_INFLATED_OBJECT_BYTES` makes
  §7's retained-ancestor term enormous. The pack-size cap bounds the *compressed* input, not the
  inflated path, and a delta may declare a target far larger than its base. **ADR-786 accepts
  this exposure knowingly**: a path-bytes budget was the option that closes it and was not taken,
  because it would sit beside depth semantics that must stay git's. A *linear* chain is not
  exposed, because a parent is released at its last child (§4).
- A pack of many small objects still costs `N × 33 B` plus the `.idx` assembly — after ADR-789,
  `N × 60 B` rather than `N × 705 B` (§7a). That is inherent to writing an index.
- Cycles and unreachable deltas cost nothing new: the forest walk never visits them (§4).
- `INDEX_PASS_BASE_CACHE_MAX_BYTES` is a **hard** cap, not a target: a pack crafted to be all
  base-with-children fills it and then evicts; it never grows it. The entry cap is the second
  bound, for the reason ADR-736 and ADR-727's amendment both record — a byte cap alone
  under-defends against many small entries whose per-entry overhead the sizer under-counts.

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
| **OFS distance 0** | `delta base offset is out of bound` | wrong reason | refuses at the entry with git's reason (ADR-785) |
| **OFS base landing mid-entry** | `pack has 1 unresolved delta` | `unresolved entry at offset 64` | refuses — the child index is keyed on **entry** offsets, so a mid-entry base matches no root and the delta is never visited. Same verdict as git, reached differently |
| **object whose inflated size exceeds one read window** | accepts | accepts (window doubling ladder) | unchanged in pass 1; pass 2 must grow the window the same way for a **base** re-read, which today's ladder only ever exercises forward |

### 11. Blast radius

| Symbol | Kind | Change | Consumers to sweep |
|---|---|---|---|
| `fetchPack` | exported, in `api.json` | none | `clone.ts:200`, `fetch.ts:161`, `fetch-missing.ts:114`, `pull.ts` (via `fetch`), `commondir-writes.test.ts:358` |
| `FetchPackInput` / `FetchPackResult` | exported, in `api.json` | none | as above |
| `RepositoryConfig.maxObjectsPerPack` / `.maxResponseBytes` | in `api.json` | **doc comment only** — `maxObjectsPerPack`'s stated purpose changes (§9) | `ports/context.ts:142,150` |
| `walkPackEntries` | module export, **not** in `api.json` | body replaced; signature kept; **import path moves** to `internal/index-pack.ts` | `bundle-verify.ts:20,78`, `fetch-pack.test.ts` (≈10 references) |
| `ExternalBaseResolver` | module export, not in `api.json` | shape unchanged; **import path moves**. Its `bundle-verify.ts:170` implementation loses its unbounded `Map` and becomes a plain `resolveExternalBase(ctx, oid)` port call (ADR-788, §5a) | `bundle-verify.ts:18,170`, `fetch-pack.test.ts` |
| `buildExternalBaseResolver` | `bundle-verify.ts:170` module-private | **deleted** — with it the `undefined`-memoising `Map` and the Stryker suppression at `:76` that described it (§6) | `bundle-verify.ts:76,77` |
| `verifyPackTrailer` | module export, not in `api.json` | none — stays in `fetch-pack.ts` | `bundle-verify.ts:75` |
| `DISK_WALK_WINDOW_BYTES` | module export, not in `api.json` | value unchanged; **import path moves** with the disk source | `fetch-pack.test.ts` (≈10 references) |
| `WalkedEntry` | module-private **type**, but structurally the return of an exported function | shape unchanged; **`fetchPack` stops using it**. `walkPackEntries` still returns `WalkedEntry[]`, materialised from the slab for its one caller (ADR-783, §7a) | `bundle-verify.ts` binds it implicitly |
| `PendingEntry`, `ResolvedEntry` | module-private | **deleted** | — |
| `inflateAllEntries`, `resolveAllEntries`, `walkFromPending`, `tryResolveEntry`, `resolveDelta`, `computeLooseObjectId`, `firstUnresolvedError`, `refDeltaBaseId` | module-private | replaced / moved | — |
| `fetchPack`'s zero-entry guard | `fetch-pack.ts:181` | `entries.length === 0` becomes `indexed.count === 0` | quarantine-reap path, unchanged behaviour |

#### 11a. The ADR-789 surface — six published symbols

This is the half the design's first draft said would not move.

| Symbol | Kind | Change | Consumers to sweep |
|---|---|---|---|
| `PackIndexWriterEntry` | **in `api.json`** | leaves every serializer signature; survives only where DC-A leaves it | `pack-order.ts:3`, `pack-writer.ts:25,27,104`, `rev-index.ts:14,113`, `cruft-pack.ts:22,42`, `storage/index.ts:86`, `write-pack-artifacts.ts:18,32,59,83,118,160,170`, `cruft-pack-lifecycle.ts:15,232`, `build-pack.ts:18,42` |
| `SortedEntry` | **in `api.json`** | **deleted**, replaced by `SortedPackIndex` | `pack-order.ts:9`, `pack-writer.ts:25,107`, `rev-index.ts:13,115,152`, `cruft-pack.ts:21,45`, `write-pack-artifacts.ts:19,34,61,86,162`, `storage/index.ts:81` |
| `sortPackIndexEntries` | **in `api.json`** | `(PackIndexEntries) → SortedPackIndex` | `pack-writer.ts:117`, `rev-index.ts:129`, `cruft-pack.ts:56` (the three `presorted ??` fallbacks, all **deleted**), `write-pack-artifacts.ts:192,305`, `cruft-pack-lifecycle.ts:245` |
| `serializePackIndex` | **in `api.json`** | `(SortedPackIndex, packChecksum)` | `write-pack-artifacts.ts:37`; tests at `packfile-interop.test.ts:102,187`, `pack-fixture.ts:152`, `pack-pair.ts:71`, `bitmap-closure.scenario.ts:158`, `fsck-degraded-store.scenario.ts:87` |
| `serializePackRevIndex` | **in `api.json`** | `(SortedPackIndex, packChecksum)` | `write-pack-artifacts.ts:64`; `rev-index.test.ts`, `rev-index.properties.test.ts` |
| `serializeCruftMtimes` | **in `api.json`** | `(SortedPackIndex, packChecksum, mtimeOf)` — **the symbol ADR-789 does not name** (§6a) | `write-pack-artifacts.ts:85`; `cruft-pack.test.ts`, `cruft-pack.properties.test.ts` |
| `PackIndexEntries`, `SortedPackIndex`, `packIndexEntriesFrom` | **new, in `api.json`** | added (additive, not breaking) | `pack-records.ts`, the three serializers, DC-A's conversion sites |
| `buildIdx` / `buildRev` / `buildCruftMtimes` | internal | `(ctx, SortedPackIndex, packSha[, mtimeOf])` | `write-pack-artifacts.ts:37,64,85,164` |
| `WritePackArtifactsInput.entries`, `WritePackSiblingArtifactsInput.entries`, `writeCruftPack`'s `entries` | internal | `PackIndexEntries` | `fetch-pack.ts:193`, `pack-objects.ts:89`, `gc-pipeline.ts:485,528,562` |
| `BuildPackResult.entries` | **in `api.json`** | **unchanged under DC-A(a); becomes `PackIndexEntries` under DC-A(b)** | `pack-objects.ts:87`, `gc-pipeline.ts:484,527,560`. `push.ts:353` and `bundle-create.ts:312` read only `.bytes`/`.sha` and are unaffected either way |

**`reports/api.json` moves** (R12). The regenerated report is committed and diffed per the
standing pre-push gate, and the diff is now the *check on scope*: the six moved symbols plus the
three added ones under DC-A(a), plus `BuildPackResult` under DC-A(b). Anything else in that diff
is a leak.

#### 11b. Tests

`test/unit/application/primitives/fetch-pack.test.ts` is ~3 000 lines and is where most of the
indexer work lands. The window-behaviour tests (`requestedLengths` assertions around
`DISK_WALK_WINDOW_BYTES`) pin *pass 1's* read pattern and survive; pass 2 adds a second,
backward-jumping read pattern that needs its own assertions.

The ADR-789 half touches eleven test files, none of which may be weakened (R13, §Test strategy):
`pack-order.test.ts`, `pack-writer.test.ts`, `rev-index.test.ts`,
`rev-index.properties.test.ts`, `cruft-pack.test.ts`, `cruft-pack.properties.test.ts`,
`arbitraries.ts`, `write-pack-artifacts.test.ts`, `pack-fixture.ts`,
`packfile-interop.test.ts`, and the three parity scenarios `pack-pair.ts`,
`bitmap-closure.scenario.ts`, `fsck-degraded-store.scenario.ts`.

Not touched: `pack-registry.ts`'s `deltaBaseCache` (a *read*-path cache for already-indexed
packs, ADR-736's subject and outside `INDEX_PASS_BASE_CACHE_MAX_BYTES`'s budget entirely),
`object-resolver.ts`, `parsePackIndex` / `parsePackRevIndex` / `parseCruftMtimes` (the readers —
only the writers widen), and `serializePackfile`.

---

## Decisions

All eleven of this design's load-bearing choices are ratified. Each row states the **settled
rule** — not a preference, not a recommendation — and the section that implements it. Nothing
here is open.

| ADR | Settled rule | Where it binds |
|---|---|---|
| **779** | Pass 2 is a **child-indexed root-down forest walk**. Roots are the base entries, enumerated by entry *type* so a base sitting after its dependents is still found; children are located through the record store's two child indexes; a parent's content is released **the moment its last child is dequeued**. Recursion is an explicit stack, never the JS call stack. A `resolved` flag guards each child, because a pack may legally carry the same oid twice and a REF delta keyed on it would otherwise be a child of two parents, applied twice, with the resolved count overshooting the declared one. The cache half of the ratified option is settled by ADR-788 instead of a thin-pack-only structure. | §4, §5 |
| **780** | Record-array capacity **grows geometrically** from a small initial size as entries are actually parsed. `header.objectCount` is a **loop bound and never an allocation input**. The structural clamp `(totalBytes − 12 − digestLength) / 9` is kept as a second bound *underneath* the growth, not instead of it. `maxObjectsPerPack`'s doc comment moves with the change. | §3, §9 |
| **781** | Base and reconstructed-delta oids are computed by feeding header bytes and content into **`ctx.hash.createHasher()`** separately. `computeLooseObjectId`'s concatenated copy is deleted. The adapter asymmetry is recorded, not hidden: Node's hasher is genuinely incremental, the memory and browser adapters collect chunks and concatenate at `digest()` because SubtleCrypto has no streaming digest — so the change is a clear win on Node and exactly neutral elsewhere. It does **not** remove the `largestEntryInflatedBytes` term. | §2, §7 |
| **782** | Pass 2 reads at arbitrary offsets through **`ctx.fs.readSlice`**, reusing the `PackByteSource` seam and its window ladder. No held `FileHandle`: `browser-file-system.ts` throws `UNSUPPORTED_OPERATION` for `openWithNoFollow`, and holding handles across async boundaries re-opens a descriptor-leak class already paid for once. The ladder must learn to grow for a **backward** anchor. | §4, §6 |
| **783** | Both byte sources drive the **same** two-pass indexer. `walkPackEntries` keeps its signature and its `WalkedEntry` return; `bundle-verify.ts` changes only its import path. Collapsing `walkPackEntries` to a validate-only entry point remains available *after* this change and is **not** taken here. | §6, §7a, §11 |
| **784** | The unresolved-delta refusal is **git's count**: `pack has <N> unresolved delta(s)`, singular at one, under the unchanged `INVALID_PACK_HEADER` code, where `N = objectCount − resolvedCount`. Structured `unresolvedCount` / `firstUnresolvedOffset` fields were offered and **not** taken. Three cases converge on this one message — REF cycle, all-deltas-no-base, and an OFS base landing mid-entry — exactly as git does. | §4, §8 j |
| **785** | The OFS guard is **`baseOffset < PACK_HEADER_BYTES \|\| baseOffset >= entryOffset`**, refusing at the entry with git's reason **`delta base offset is out of bound`**. A base offset that is in range but lands mid-entry is *not* caught here and remains an unresolved-delta count under ADR-784 — the same split git makes. | §2, §8 h/i, §10 |
| **786** | The index pass applies **no depth cap**. Adding a refusal where git accepts is the divergence direction the prime directive forbids by default, and ADR-771 set `MAX_DELTA_CHAIN_DEPTH` from git's *writer* default. The cost is accepted knowingly: the retained-ancestor term stays **formally unbounded**, and a deliberately branching forest of near-maximal objects is undefended. The index/read depth gap stays open. | §5, §7, §8 l, §9 |
| **787** | Two new modules: **`internal/index-pack.ts`** (passes, byte sources, refusals) and **`internal/pack-records.ts`** (record store + child indexes, pure, I/O-free). `fetch-pack.ts` keeps negotiation, the quarantine lifecycle, `fetchPack`/`materializePack` and `verifyPackTrailer`. The byte-source seam moves **with the indexer**. Neither module is coverage-gated, so mutation is the gate. | §6 |
| **788** | **One** byte-capped LRU inside the indexer, keyed on `ctx.session`, serving **both** pass-1→pass-2 carry-over of in-pack bases **and** externally-resolved thin-pack bases. It **replaces** `bundle-verify.ts:170`'s unbounded `Map`, whose deletion is a residency fix in its own right; that resolver becomes a plain port call. Its budget is **`INDEX_PASS_BASE_CACHE_MAX_BYTES`**, its own named constant, defaulted from the §5a measurement — not a fraction of and not equal to `deltaCacheMaxBytes`. Because the cache is an optimisation over an already-correct walk, **disabling it must change latency and never results** (R15). | §5a |
| **789** | `sortPackIndexEntries`, `serializePackIndex`, `serializePackRevIndex` — and, forced by the same types, `serializeCruftMtimes` — take the **oid slab plus parallel crc/offset arrays**. The indexer never materialises `PackIndexWriterEntry[]` and `hexToBytes` leaves the path. Six published symbols move; the break rides the pending 4.0.0 exactly as ADR-776 reasoned. **ADR-625's invariant is preserved, not superseded** — one shared ordering definition still feeds every artefact — and §6a makes it structural. The byte-exact goldens and `git verify-pack` cross-tool pins are the regression net and none is weakened. | §3a, §6a, §7a, §11a |

Two corrections this revision carries, both recorded so they are not re-introduced:

- **The `deltaBaseCache` fraction citation was false.** The first draft cited "ADR-727/736's
  fraction pattern" as sizing precedent. ADR-736 *considered* a fraction and **rejected** it,
  keeping `deltaBaseCache` at a full additive `deltaCacheMaxBytes`; the fraction siblings are
  ADR-726 and ADR-727. There is no sizing precedent to inherit, which is why ADR-788's budget is
  measured rather than derived.
- **The `idxAssembly` term was undercounted 4×.** "~2.3 MB on fixture C" counted only
  `sortPackIndexEntries`' own allocation, not the hex-bearing array beneath it. The measured pair
  is **9.79 MB** (§7a), and that correction is what carried ADR-789 against the design's own
  recommendation.

---

## Decision candidates

**One**, surfaced by the ADR-789 revision and not settled by any ratified record. ADR-789 hands it
over explicitly: *"`build-pack.ts` and `cruft-pack-lifecycle.ts` call `sortPackIndexEntries`
without a slab and must be reconciled — either by building one or by a narrow adapter over the
widened entry point. That reconciliation is an engineering choice for the design revision, and it
must not fork the serializer into two implementations…"*

**The designer decides none of this.**

**The constraint both live options satisfy, and the third does not:** exactly one implementation
of the ordering and of each serializer (R13d). ADR-789 and `check:duplicates` both name the fork
as the outcome to avoid, and ADR-625's shared-ordering invariant is what a fork would break.

**The facts.** Four distinct caller paths reach `sortPackIndexEntries` from the application layer,
through three source lines, and only the indexer's path has a slab:

| Call site | Reached from | Has a slab? |
|---|---|---|
| `write-pack-artifacts.ts:192` (`writeSiblingsGiven`) | `fetch-pack.ts:193` — **the indexer** | **yes** |
| `write-pack-artifacts.ts:192` (same line) | `writePackArtifacts` ← `pack-objects.ts:89`, `cruft-pack-lifecycle.ts:238` | no |
| `write-pack-artifacts.ts:305` (`writePackArtifactsViaQuarantine`) | `gc-pipeline.ts:485,528` | no |
| `cruft-pack-lifecycle.ts:245` (`writeCruftPack`) | `gc-pipeline.ts:562` | no |

One correction to ADR-789's own wording, which does not change the decision: **`build-pack.ts`
never calls `sortPackIndexEntries`.** It is the *producer* whose `BuildPackResult.entries` —
`plan.ids.map((id, i) => ({ id, ...packfile.entries[i]! }))` at `build-pack.ts:58`, hex
`ObjectId`s it already holds joined to `serializePackfile`'s `{ crc32, offset }` metas — feeds
every slab-less call site. That is why it is where DC-A(b) would intervene.

`push.ts:353` and `bundle-create.ts:312` also call `buildPack` but read only `.bytes`/`.sha`, so
they are unaffected by either option.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DC-A** | **Where the slab is born for callers that do not have one** | **(a) A domain conversion at the write boundary.** `packIndexEntriesFrom(entries, digestLength)` is exported from `domain/storage/pack-order.ts`; `pack-objects.ts` and `gc-pipeline.ts`'s three call sites convert `pack.entries` once before calling `writePackArtifacts*` / `writeCruftPack`, which take `PackIndexEntries` only. `BuildPackResult` is unchanged. **(b) Move the slab birth into `buildPack`.** `BuildPackResult.entries` becomes `PackIndexEntries`; `buildPack` fills the slab from `plan.ids` and `packfile.entries` directly. No slab-less caller remains and `packIndexEntriesFrom` has no production caller. **(c) Let the serializers accept either shape** (overload, or a union narrowed inside). | **(a)** | (a) and (b) are both fork-free; (c) is not, and is listed only so its rejection is on the record — a union input puts two index-and-dereference paths inside each serializer, which is exactly the second implementation ADR-625 and `check:duplicates` exist to prevent, and it doubles the mutation surface of code carrying byte-exact goldens. Between (a) and (b): **(a) moves the smallest published surface** — the six R12 symbols plus three additive ones, with `BuildPackResult` untouched — and the conversion is one named domain function with its own round-trip property test. Its cost is honest: the gc and `pack-objects` paths keep `BuildPackResult`'s hex-bearing `N × 488 B` array, so §7a's 11.8× reduction lands on the **fetch** path only, and the same term survives on the path `gc` uses to repack a whole repository. **(b) removes that term everywhere** and is the better long-term shape — `buildPack` already holds both halves, so building the slab there costs the same `hexToBytes` per object that (a) pays one level up, with no extra allocation — but it moves a **seventh** published symbol in the same major, re-points four call sites that are otherwise pure pass-through, and leaves `packIndexEntriesFrom` published with no production caller (a smell, though not a `knip` finding: it is reachable from `domain/index.ts`). (a) does not foreclose (b): (b) can land afterwards by deleting the three conversion calls, without reopening ADR-789. Take (b) instead if the gc path's residency should move in this PR rather than a later one. |

---

## Test strategy

### Unit — `test/unit/application/primitives/internal/pack-records.test.ts` (new, ADR-787)

Pure, `describe('Given …')` > `describe('When …')` > `it('Then …')`, AAA, `sut`.

| Area | Cases |
|---|---|
| record store | store/read back `offset`, `crc32`, `type`, `oid` for entry 0, entry N−1, and a middle entry; SHA-1 (20 B) and SHA-256 (32 B) widths; the `resolved` flag distinguishing "unresolved" from "resolved to the all-zero oid" |
| growth (ADR-780) | capacity crossing exactly at the doubling boundary, one below, one above; contents preserved across every growth; the structural clamp binding *before* the declared count does |
| slab hand-over (ADR-789) | the exposed `PackIndexEntries` reports `count`, not `array.length`, when capacity exceeds `count`; entry `count − 1`'s oid range is the last `digestLength` bytes *within* `count`, never into the over-allocated tail |
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
- **`walkPackEntries` parity (ADR-783).** In-memory and disk sources produce identical results on
  the same bytes — the test that already exists (`fetch-pack.test.ts:2309`) extended to the
  fixtures with deep chains and forward REF references.
- **Thin packs (R7).** Base present → resolves; base absent → refuses; base present but the
  **wrong size** → refuses through `validateDeltaHeader`, not silently.
- **Untrusted count (R3, §9).** A pack declaring `objectCount = 50_000_000` with three real
  entries: the call refuses on the first bad inflate and total allocation stays proportional to
  three, asserted through a spy on the record store's capacity rather than through memory.

### Unit + property — the serializer regression net (ADR-789)

**The goldens and the cross-tool pins *are* the net. None of them is weakened to fit the new
shape** — that is R13, and it is the hardest constraint in this half of the change. How each is
re-expressed:

| Existing asset | What happens to it |
|---|---|
| Byte-exact goldens in `pack-writer.test.ts` (727 lines), `rev-index.test.ts` (650), `cruft-pack.test.ts` (479) | **Expected bytes stay verbatim.** Only the *Arrange* changes: the same `{ id, crc32, offset }` literals the test already declares are wrapped in `sortPackIndexEntries(packIndexEntriesFrom([...], 20))` — the **production** adapter, never a test-local copy. One moved expected byte means the change is wrong |
| `pack-order.test.ts` (78 lines) | Rewritten against the new return type, keeping all four existing cases: out-of-order input sorts ascending; each ordinal pairs with its own oid bytes (now `order[p]` selecting a slab range); the order is input-order-independent; the empty set returns an empty order |
| `rev-index.properties.test.ts`, `cruft-pack.properties.test.ts` | **Properties unchanged.** `arbPackIndexWriterEntries` (`arbitraries.ts:472`) keeps generating readable `{ id, crc32, offset }` triples — that is what gives the generator hex-domain coverage — and gains a `.map` into `PackIndexEntries`. Rewriting it to emit slabs directly would silently drop that coverage |
| `packfile-interop.test.ts:102,187` — `git fsck --strict` + `cat-file -p` readback | **Oracle unchanged**, call shape wrapped. Its whole contract is "git accepts what we wrote"; it must keep passing with zero change to its assertions |
| `pack-pair.ts:71`, `bitmap-closure.scenario.ts:158`, `fsck-degraded-store.scenario.ts:87` | Same wrap. Parity scenarios are cross-*adapter* and do not prove faithfulness, but they do prove the three adapters agree on the widened path |

Three new tests carry the weight the type change adds:

| # | Kind | Property |
|---|---|---|
| S1 | property, round-trip, `numRuns` **200** | `packIndexEntriesFrom(E, W)` — for every `i < E.length`: `oids[i*W … (i+1)*W)` equals `hexToBytes(E[i].id)`, `crcValues[i] === E[i].crc32`, `offsets[i] === E[i].offset`, `count === E.length`. Lens 1 |
| S2 | property, compositional, `numRuns` 100 | `sortPackIndexEntries(packIndexEntriesFrom(E, W)).order` reads out a **non-decreasing** oid byte sequence that is a permutation of `E`'s oids — including when `E` carries duplicate oids, which §10 pins as legal. Lens 2 |
| S3 | example, the anti-fork oracle | The same entry set built **two ways** — through `packIndexEntriesFrom` from an array, and written directly into a hand-built slab — produces `.idx`, `.rev` and `.mtimes` bytes that are `toEqual`. If a second implementation ever appears, this is what fails; `check:duplicates` is the mechanical half of the same guard |

### Unit — the base cache (ADR-788, R15)

- **R15 as a parameterised sweep.** Every §10 degenerate input, both §1c fixtures and both
  thin-pack fixtures run twice — `INDEX_PASS_BASE_CACHE_MAX_BYTES` forced to `0`, and at its
  default — asserting **identical** `WalkedEntry` sets, byte-identical `.idx`/`.rev`, and
  identical `TsgitError.data` on every refusal. Only latency may differ. This is the test that
  keeps the cache an optimisation.
- **Bounded, and observably so.** A pack whose base-with-children content exceeds the budget:
  `cache.currentSize <= maxSize` holds after every insertion, and the entry cap binds
  independently — a separate case with many tiny bases, since a byte cap alone does not defend
  entry-count overhead (ADR-736; ADR-727's amendment).
- **The two keyspaces do not collide.** Two index passes on one session, over different packs
  whose entries share a pack offset, must not read each other's bases. The
  `o:<passId>:<offset>` key is what makes that true, and only a test driving two passes and
  asserting distinct content proves it.
- **`clear()` on both exits.** Success and failure both leave `cache.currentSize === 0`. The
  failure case matters more: a refusing pack must not leave its bases resident.
- **`bundle verify` keeps its verdicts.** The existing `bundle-verify` tests pass unchanged after
  the `Map` is deleted — including the case where a prerequisite base is **absent**, since
  today's Map memoises that `undefined` and the replacement must still answer `undefined` on a
  repeat lookup rather than throwing.

### Integration — `test/integration/index-pack-interop.test.ts` (new)

Cross-tool, `describe.skipIf(!GIT_AVAILABLE)`, one shared `beforeAll` repo, 60 s timeout (the
known interop load→validate flake), `runGit` env-scrubbed per `interop-helpers.ts`. Carries a
`@proves` header in `packfile-interop.test.ts`'s grammar.

Every row of §1f becomes a case, with git as the peer on the same crafted bytes:

| # | Given | Then |
|---|---|---|
| X1 | a pack tsgit indexed | `git verify-pack <idx>` exits **0** with no output, and `git show-index < <idx>` lists the same `(offset, oid)` set tsgit recorded |
| X2 | the crafted OFS-distance-0 pack | both refuse; git's reason tail is `delta base offset is out of bound` and tsgit's `data.reason` is the same string (ADR-785) |
| X3 | the crafted REF-cycle pack and the all-deltas pack | both refuse; git says `pack has 2 unresolved deltas` and tsgit's reason is byte-identical (ADR-784) |
| X3b | a pack with exactly **one** unresolvable delta (§1f row 15b) | both say `pack has 1 unresolved delta` — the **singular**, which is the case a naive `${n} deltas` template gets wrong |
| X4 | the crafted forward-REF pack | both accept, same oid set |
| X5 | chains at depth 50 / 51 / 1 000 | both accept — no depth cap (ADR-786). Row 10's consequence is *recorded* in the same case: tsgit's own resolver refuses past 50, and that gap stays open deliberately |
| X6 | four identical zero-length blobs | git without `--strict` accepts, tsgit accepts; `git index-pack --strict` refuses and tsgit's divergence is **recorded, not asserted away** |
| X7 | a real thin pack (`pack-objects --thin --revs`) | tsgit refuses without a resolver; with the store's bases available it completes, and `git index-pack --stdin --fix-thin` accepts the same bytes |
| X8 | fixture C's pack indexed by tsgit | `git fsck --strict --no-progress` in the resulting repo exits **0** with zero output on both streams |
| X9 | fixture C's `.idx` and `.rev` written **from the indexer's own slab** (ADR-789), never from a converted array | `git verify-pack -v` and `git show-index` agree with tsgit's records, and `git cat-file --batch-all-objects --batch-check` reads every object back. This is the pin that proves the slab path and the array path emit the same artefact — R13b |

⚠️ Any case that corrupts an entry *header* must recompute the pack trailer, or git answers
`fatal: pack is corrupted (SHA1 mismatch)` and never reaches the condition under test — §1f
rows 11 and 13 are exactly that shape.

### Bench — `test/bench/fetch-pack.bench.ts`

Three scenarios, all on committed generators reproducing fixtures A, B and C:

- **Residency (R1, R2).** The assertion is a **class with headroom** against §7's formula, never
  a byte count, and it is measured with a **kernel high-water mark from a child process** —
  §1d's methodology note is binding: an in-process sampler cannot see this pipeline's peak.
- **Throughput.** Pass 1 + pass 2 wall clock against today's single pass, so the second read of
  every entry is priced rather than assumed free. Published numbers come from CI's nightly bench
  artifact; local runs are for the design only.
- **The ADR-788 budget sweep** (§5a). The demand curve, hit rate and wall clock across
  `{0, 1, 2, 4, 8, 16, 32, 64} MiB`, on all four fixtures including the thin-pack one. This is
  the measurement the implementation owes before `INDEX_PASS_BASE_CACHE_MAX_BYTES` gets a
  default, and it is a **gating step in the plan**, not a nice-to-have. Fixture B is the control:
  the cache must be inert there.

### Mutation

Target 0 survivors. Known-hazardous spots to write kill tests for up front:

- `RECORD_BYTES` and every field offset in the record store — each needs a case whose *output*
  changes when the constant does.
- The growth factor and the `capacity <= needed` comparison (ADR-780) — a case landing exactly on
  the boundary.
- The slab guards in each serializer (`oids.length < count * digestLength` and siblings, §6a) —
  a case landing exactly on equality, since `<` versus `<=` is the live mutant there.
- `baseOffset >= entryOffset` versus `>` (ADR-785) — the self-reference case (`distance === 0`) is
  the killer, and it is the defect §1f row 15 found.
- The **singular/plural** branch in ADR-784's message — a one-unresolved-delta pack and a
  two-unresolved-delta pack, since a `StringLiteral` mutant on either arm survives a test that
  only ever sees the plural.
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

**The ADR-789 half is the opposite case.** `pack-order.ts`, `pack-writer.ts`, `rev-index.ts` and
`cruft-pack.ts` are all under `domain/`, so **every new line and branch there is coverage-gated
at 100 %** — including each of §6a's structural guards. A guard added without a test does not
survive `npm run test:coverage`, which is a stronger signal than mutation alone and arrives
earlier.

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
- **Closing the index/read depth gap** (§1f row 10). ADR-786 settled that the indexer takes no
  cap; whether `MAX_DELTA_CHAIN_DEPTH` should bind the *readers* at all belongs to ADR-771's own
  record, not here.
- **A path-bytes budget on the retained-ancestor term.** ADR-786 records it as the shape to
  revisit if the unbounded term is ever judged unacceptable, and notes it would not require
  reopening the depth semantics.
- **`--strict`-class object checks.** git's `index-pack --strict` runs fsck checks (duplicate
  oid, malformed objects) that the default fetch path does not, because `transfer.fsckObjects`
  and `fetch.fsckObjects` both default to **false** (pinned, §1f row 5). tsgit has `fsck`; wiring
  a `--strict` equivalent into the fetch path is a config surface with its own faithfulness pins.
- **`--max-input-size` as a config key.** `maxResponseBytes` already covers the byte cap with a
  different message (§1f row 18). Aligning the message is a separable faithfulness item.
- **`walkPackEntries`'s existence.** ADR-783 keeps its signature and its `WalkedEntry` return;
  its one caller discards the result, and collapsing it to a validate-only gate is explicitly
  *available afterwards* and not a prerequisite. Until then it is the last place the hex-bearing
  array survives (§7a).
- **The gc / `pack-objects` half of `idxAssembly`**, if DC-A(a) is chosen. Those paths keep
  `BuildPackResult.entries`' hex-bearing array; DC-A(b) is the shape that closes it, and it can
  land later without reopening ADR-789.
- **`serializeCruftMtimes`' `mtimeOf(oid)` contract.** ADR-789's slab does not carry hex, so the
  serializer derives a transient one per index position (§6a). Re-keying the callback on an
  ordinal would remove even that, and is separable.
- **Anything in `pack-registry.ts`.** `deltaBaseCache` (ADR-736) serves the *read* path over
  already-indexed packs and is untouched by this change.
