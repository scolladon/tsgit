# Design — multi-pack-index read support (flat + incremental chain)

> Brief: tsgit is **correct-by-ignoring** the multi-pack-index. The registry discovers packs by
> scanning `*.idx` (`pack-registry.ts`), git always keeps the per-pack `.idx` files alongside a
> midx, and so `catFile` / `log` / `fsck` answer correctly on both the flat
> `objects/pack/multi-pack-index` and the incremental `objects/pack/multi-pack-index.d/` chain.
> The gap is perf: a midx is **one** merged binary-searchable index over every pack, where tsgit
> probes each pack's fanout separately — lookup cost grows with pack count. Lift: a domain parser
> for the chunked midx format (PNAM/OIDF/OIDL/OOFF/LOFF), registry integration, chain-file
> layering for the incremental form, twin interop pins.
>
> **The brief's premise does not survive the pins.** "midx as a lookup fast path with per-pack
> `.idx` fallback" is *not* what git does. Pins H and L show the midx is **authoritative** for the
> packs it names: when a midx entry points at a pack that is gone, git reports the object
> **missing** even though a sibling pack in the same midx holds it. And a corrupt midx is not
> uniformly a "degrade to the `.idx` scan" event — git splits midx faults into a `die()` tier and
> an `error()`-and-ignore tier (Pin G). Both facts are load-bearing, both were surfaced as decision
> candidates, and both are now ratified **as git behaves**: authority by
> [ADR-592](../adr/592-midx-is-authoritative-for-named-packs.md), the two tiers by
> [ADR-593](../adr/593-midx-corruption-replicates-gits-two-tiers.md).
>
> Status: **accepted** — all eleven decision candidates are ratified as
> [ADR-592 … ADR-602](../adr/). Two ratifications went **against** the designer's recommendation
> (DC-2 → ADR-593, DC-10 → ADR-601) and this revision folds them through; §Decision candidates
> carries the DC → ADR → outcome table.
>
> **What the ADR round changed, and what it cost.** Ratifying git's Tier-A `die()` (ADR-593)
> turned three passages that read as *tensions to be resolved* into *designed behaviour*, and it
> forced two questions the draft never had to ask: how a thrown fault crosses a registry built
> entirely out of allow-lists (§D4.2), and what "die once per process" means for a library with no
> process to kill (§D4.3). Ratifying fsck reporting (ADR-601) required a **new pinned matrix**
> (Pins N, O, P) which turned up the mechanism that makes the two ratifications compose instead of
> collide: **`git fsck` runs `git multi-pack-index verify` as a child process**, so git's own
> `die()` is contained at a process boundary that tsgit can model exactly (§D12.1). The same
> matrix also **falsified** one classification the draft proposed and ADR-593 inherited —
> `numBaseFiles` — see §D4.4.

## Context

### What tsgit does today, and why it is correct

`createPackRegistry` (`src/application/primitives/pack-registry.ts:380`) is the single choke point
for every local pack read. Its `scanPacks` reads `objects/pack/`, keeps every entry that
`isCandidate` accepts (`isFile && name.endsWith('.idx') && isSafePackName(name)`), requires a
sibling `<base>.pack` in the same listing (ADR-579), and loads each surviving `.idx` in full
(`readBoundedIdx` → `parsePackIndex`). `lookup(id)` then walks that array, calling
`lookupPackIndex(pack.index, id)` on each — a fanout-bounded binary search per pack — and returns
the first hit whose header gate passes (ADR-572).

Nothing anywhere in `src/` reads the string `multi-pack-index`. The midx and the chain directory
are invisible to `isCandidate` (neither ends in `.idx`), so they are neither consulted nor
tripped over. That is why the current answers are right: the `.idx` files git keeps beside the
midx are a complete, independent index of the same packs.

### The cost the midx exists to remove

Two costs, and only the first is what the brief names:

1. **Lookup is O(P) binary searches**, P = pack count. `lookup` has no early structural exit — it
   asks every pack. A midx replaces that with one binary search over a merged, sorted oid list.
2. **The scan reads every `.idx` file whole.** `readBoundedIdx` does `ctx.fs.stat` + `ctx.fs.read`
   — the *entire* index into memory — for every pack, eagerly, on the first `lookup` through a
   `Context`. For a busy-fetch repo with 100 packs this is 100 whole-file reads before the first
   object is served. A usable midx makes that unnecessary for the lookup itself: only the pack
   the answer lands in needs its `.idx` (for `entryOffsets` → `nextOffsetForEntry`). Cost 2 is
   larger than cost 1 in wall-clock and is **not** removed by a purely additive fast path — which
   is why ADR-597 ratified lazy `.idx` loading rather than a pure lookup short-circuit.

Cost 2 has a hard floor that must be stated up front: **the midx does not replace the `.idx`.**
`nextOffsetForEntry` needs the containing pack's sorted entry offsets, which only its `.idx`
carries, and git has the same dependency — Pin L row L5 shows git failing with
`packfile … index unavailable` when a midx-named pack's `.idx` is deleted. The `.idx` read moves
from *eager, all packs* to *lazy, touched packs*; it does not disappear.

### Premises of the brief, checked against the code and against git

| # | brief premise | verdict |
|---|---|---|
| B-1 | *"the registry discovers packs by scanning `*.idx` (`pack-registry.ts`)"* | correct — `isCandidate`, `pack-registry.ts:194`. |
| B-2 | *"the midx is an additive acceleration layer"* | **false in the failure case.** Additive in a healthy repo (Pin L2 — byte-identical answers with and without it), but a midx **subtracts**: a pack named by a live midx is served *only* through the midx, so a stale entry hides an object that the pack set still contains (Pin H2 vs H5/H6). This is the single most consequential correction to the brief. |
| B-3 | *"git always keeps per-pack `.idx` files"* | correct, and stronger than stated — git *requires* them: deleting a midx-named pack's `.idx` gives `error: packfile … index unavailable` and the object goes missing (Pin L5). The midx is an index **over** packs, not a replacement **for** their indexes. |
| B-4 | *"a domain parser for the chunked midx format (PNAM/OIDF/OIDL/OOFF/LOFF)"* | correct, and the chunk set is exactly right. Two further chunk ids exist in 2.55.0 — the bitmap-packfile table `{'B', 'T', 'M', 'P'}` and the bitmap pack-order list `{'R', 'I', 'D', 'X'}` — and both are bitmap-only — out of scope, and safely ignorable because the chunk table is self-describing (Pin B). |
| B-5 | *"stale-midx repo handled as git does"* | this is the hard requirement, not a nicety — see B-2. Its price is that tsgit would start reporting *missing* for objects it finds today (DC-1). |
| B-6 | implicit: *midx version 1* | **incomplete.** git 2.55.0 recognises versions **1 and 2** on read and refuses everything else; it writes 1 by default (`midx.version`, Pin D). The packfile-format manual page shipped in the same build claims the write default is 2 — the doc is ahead of the binary. v2 differs from v1 in exactly one rule: v1 requires PNAM lexicographic, v2 does not (Pin D7/D8). |
| B-7 | implicit: the pack subsystem is hash-generic | **false, pre-existing.** `IDX_SHA_LENGTH = 20` is hard-coded in `pack-index.ts:10` and `pack-writer.ts:63`; the whole pack subsystem is SHA-1-only. The midx *format* is hash-generic (Pin E) and the parser must be written that way, but the surrounding subsystem's limit is neither widened nor narrowed here (§D9). |
| B-8 | *"any future repack/gc must expire or rewrite an existing midx"* | correct, and it is the **inverse** direction that this change makes newly load-bearing: see §D8. |

### Subsystems this touches

| subsystem | file | involvement |
|---|---|---|
| pack registry | `src/application/primitives/pack-registry.ts` | the main structural change: generation composition, `lookup`, `all`, `health`, `indexFaults`, plus two additions — `midxHealth()` (ADR-601, §D12.2) and `assertLoadable()` (ADR-593, §D4.5) |
| domain storage | `src/domain/storage/` (new `midx.ts`, `error.ts`, `index.ts`) | new parser + new error code + barrel exports |
| read path | `object-resolver.ts:73`, `internal/blob-source.ts:99`, `fetch-missing.ts:57`, `internal/fsck/object-cache.ts:95,163` | all reach the registry through `lookup` — **unchanged call sites**, changed answers in the stale case, and a new failure mode (Tier A) they all propagate |
| enumeration | `enumerate-objects.ts:34` | reads `registry.all()` / `health().accessible` and `allObjectIds(pack.index)`; **unaffected** — ADR-592 leaves `all()`'s membership on the `.idx` universe (§D3). Its one new behaviour is inherited: it awaits the generation, so a Tier-A midx rejects here (§D4.5) |
| abbreviation | `resolve-oid-prefix.ts:43` | `findByPrefix(pack.index, …)` over `registry.all()`; same as enumeration — membership unchanged, Tier A inherited |
| limits | `primitives/validators.ts` | new size / chain-length bound (ADR-600 — **not** `domain/engine-limits.ts`) |
| fsck | `commands/fsck.ts`, new `commands/internal/fsck/midx-health.ts`, `internal/fsck/types.ts`, `internal/fsck/exit-codes.ts` | ADR-601's pass: four finding variants, exit bit 32, one new registry accessor (§D12) |
| read entry | `object-resolver.ts` | ADR-593's Tier-A gate ahead of the loose probe (§D4.5) — the one call site outside the registry this change adds |

### Constraining prior decisions

- **[ADR-226](../adr/226-git-faithfulness-prime-directive.md) — git-faithfulness prime directive.**
  Binds this change hardest at exactly the point the brief got wrong (B-2): the observable answer
  in a stale-midx repo is `missing`, and matching it is the default.
- **[ADR-249](../adr/249-describe-structured-data-only.md) — structured data only.** No rendering
  option, no returned line. git's `error:` / `warning:` transcripts are reconstructed *inside the
  interop test*, never emitted by the library.
- **[ADR-572](../adr/572-local-pack-gate-sits-in-lookup.md)** — the pack gate sits in `lookup()`;
  `all()` stays ungated. The midx must not silently relocate that boundary.
- **[ADR-573](../adr/573-refused-pack-degrades-per-pack.md) /
  [ADR-575](../adr/575-full-per-pack-registry-degradation.md)** — a refused pack degrades *per
  pack*, never poisoning an unrelated read; the discriminators are allow-lists over
  `TsgitError.data.code`, never `catch {}`. Pin G's Tier A, where git kills every read — including
  loose ones — over a corrupt midx, sits outside that posture, and
  **[ADR-593](../adr/593-midx-corruption-replicates-gits-two-tiers.md) settles the boundary**:
  ADR-575 governs artefacts git itself degrades per-pack; git does not degrade a Tier-A midx, so
  neither does tsgit. The allow-list *discipline* is unchanged and in fact does the work — §D4.2
  shows the Tier-A fault escapes precisely **because** ADR-599 gave it a code no allow-list names.
- **The fsck pack-accessibility family
  ([ADR-581](../adr/581-per-pack-health-is-a-registry-accessor.md),
  [583](../adr/583-two-pack-finding-variants-by-layer.md),
  [584](../adr/584-the-finding-carries-the-pack-base-name.md),
  [585](../adr/585-fsck-narrows-its-universe-via-an-enumerate-objects-knob.md),
  [586](../adr/586-exit-bit-64-is-modeled-with-an-ungated-finding.md),
  [589](../adr/589-the-pack-pass-lives-in-internal-fsck.md),
  [590](../adr/590-fsck-rejects-on-undecodable-loose-objects-in-connectivity-only.md))** — the
  house vocabulary this change's fsck arm (ADR-601) must join, not invent beside:
  health is a **registry accessor** memoised per generation (581); a finding is
  `{ type, <artefact identifier>, reason }` and **one variant per layer** because layers compose
  differently on the exit axis (583/584); a **pass** lives in `commands/internal/fsck/` and
  `fsck.ts` gains three lines (589); a modelled bit may be **ungated** by mode when git's is
  (586); and where git `die()`s, **`fsck` rejects with no result** rather than inventing a finding
  (590). §D12 takes all six.
- **[ADR-579](../adr/579-orphaned-idx-excluded-at-scan-time.md) /
  [ADR-580](../adr/580-orphan-idx-filter-warns-once-per-generation.md)** — scan-time sibling-`.pack`
  rule; one structured `warn` per generation for an excluded artefact. The midx's exclusions
  follow the same warn discipline.
- **[ADR-577](../adr/577-local-gate-cross-checks-object-count.md)** — cross-checks belong in the
  registry, never inside a context-free domain parser. The midx parser gets `digestLength` passed
  in and compares nothing against the repo.
- **`pack-registry-single-flight.md` (PR #263)** — every lazy initialiser that crosses an `await`
  is a `createPromiseMemo`; a rejection is never memoised; `dispose()` is terminal. The midx load
  is a new lazy initialiser and inherits the rule verbatim.

### House patterns this must follow

- Zero-copy `DataView` parsing with `_bytes` / `_view` retained on the parsed value, exactly as
  `PackIndex` does (`pack-index.ts:13-21`). No per-object allocation on the lookup path.
- Branded `ObjectId` at the boundary; `hexToBytes` / `bytesToHex` from `domain/objects/encoding`.
- Fanout binary search first (CLAUDE.md performance priority 1) — the midx is that priority
  applied one level up.
- Files ≤ ~400 lines, functions < 20 lines, early returns, named constants, no magic values.
- Domain code has zero platform dependencies: the parser takes bytes and a digest length; all
  I/O, path construction and precedence live in the application layer.

## Pinned matrices — git 2.55.0, this host (darwin 25.5.0)

Every cell below was **executed**, not recalled. Method: a `mktemp -d` throwaway per probe,
isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` unset, `commit.gpgsign=false`,
`user.name`/`user.email` fixed, `init.defaultBranch=main`. Multi-pack repos are built by
`git repack -adq` for the first pack then `git repack -dq` with `.keep` files on the existing
packs, so each commit lands in its own pack. midx mutations rewrite the named field and re-stamp
the trailer over `midx[0 .. len − digestLength)` with the algorithm the `hashVersion` byte
selects. Probe scripts live under the session scratchpad; the recipes that the tests need are
reproduced in §Test strategy.

Three fixtures recur:

- **`BASE`** — 3 packs, 9 packed objects, 1 loose blob (`LOOSE`), one blob per pack (`OID1`,
  `OID2`, `OID3`), flat midx written.
- **`DUP`** — 2 packs where **the same blob is in both**; the midx assigns it to pack A. The only
  fixture that can distinguish "midx is an accelerator" from "midx is authoritative".
- **`CHAIN`** — an incremental chain built one layer at a time, in the `DUP` shape for the
  layered probes.

### Pin A — what is on disk

| shape | files |
|---|---|
| flat | `objects/pack/multi-pack-index` (no extension) |
| incremental | `objects/pack/multi-pack-index.d/multi-pack-index-chain` + `objects/pack/multi-pack-index.d/multi-pack-index-<hex>.midx`, one per layer |
| both | `git multi-pack-index write` (non-incremental) over a chain writes the flat file and **empties** `multi-pack-index.d/`, leaving the now-empty directory behind |

The `<hex>` in a layer's filename **is that layer's own trailer digest**, verified on all six
layers produced across the probes. The chain file is one lowercase hex digest per line,
**base first, newest last**; the trailing newline is present.

### Pin B — the flat midx, byte for byte

`BASE`, 3 packs / 18 objects / SHA-1, total 1772 bytes:

```
00000000: 4d49 4458 01 01 04 00 00000003   MIDX | ver=1 | hashVer=1 | chunks=4 | baseFiles=0 | packs=3
0000000c: "PNAM" 0000000000000048           chunk table: 5 entries × 12B (id:4 + offset:u64)
00000018: "OIDF" 00000000000000e0
00000024: "OIDL" 00000000000004e0
00000030: "OOFF" 0000000000000648
0000003c: 00000000 00000000000006d8         terminating label id=0, offset = trailer start
```

| field | value | rule |
|---|---|---|
| header | 12 bytes | `MIDX` · u8 version · u8 hashVersion · u8 numChunks · u8 numBaseFiles · u32BE numPacks |
| `numBaseFiles` | **0**, in every layer of every chain probed | spec says "currently always zero"; the chain file, not this byte, carries the layering |
| chunk table | `(numChunks + 1) × 12` at offset 12 | 4-byte ascii id + u64BE offset; last entry id `0x00000000`, offset = trailer start |
| first chunk offset | `12 + (numChunks + 1) × 12` = 72 | derived, matches |
| `PNAM` | 152 = 3 × 50 padded to ×4 | NUL-terminated names, **stored with the `.idx` suffix** (`pack-<40hex>.idx`), padded 0–3 NUL |
| `OIDF` | 1024 = 256 × u32BE | `F[i]` = count of oids with first byte ≤ i; `F[255]` = total (18) |
| `OIDL` | 360 = 18 × 20 | sorted oids, `digestLength` each |
| `OOFF` | 144 = 18 × 8 | u32BE pack-int-id (index into PNAM) + u32BE offset |
| `LOFF` | absent | optional; see Pin F |
| trailer | 20 bytes | digest over `[0, len − digestLength)` |

`PNAM` names are `.idx` names, not `.pack` names. Every consumer of them constructs a path.

### Pin C — the incremental chain

A chain built in three appends (2 packs, then +1, then +1):

| layer | file | `numPacks` | `numBaseFiles` | PNAM | objects |
|---|---|---|---|---|---|
| 1 | `…-118431d5….midx` | 2 | 0 | the 2 initial packs | 12 |
| 2 | `…-e8337cdd….midx` | 1 | 0 | the 3rd pack | 6 |
| 3 | `…-eabeb3e6….midx` | 1 | 0 | the 4th pack | 6 |

Each layer is a **complete, self-contained midx** in the Pin B format. `pack-int-id` in a layer's
`OOFF` indexes **that layer's own PNAM**, not a global list. Objects are **de-duplicated against
earlier layers by the writer**: in the `CHAIN`-shaped `DUP` fixture, layer 2's pack contains the
duplicate blob but layer 2's `OIDL` is **empty** (0 objects) because layer 1 already records it.
So in a git-written chain every oid appears in **at most one** layer — but a reader must not rely
on the writer for correctness (§D2).

### Pin D — midx versions

| row | midx version | git 2.55.0 |
|---|---|---|
| D1 | write default (`midx.version` unset) | writes **1** |
| D2 | `-c midx.version=2 … write` | writes 2; byte-identical to the v1 file **except** the version byte (both 1772 B) |
| D3 | `-c midx.version=3 … write` | `fatal: unknown MIDX version: 3`, exit 128 |
| D4 | read version **1** | accepted |
| D5 | read version **2** | accepted; `verify` exit 0; all objects read |
| D6 | read version **0** or **3** (trailer re-hashed) | `fatal: multi-pack-index version N not recognized`, exit 128 — **every** read dies, loose included |
| D7 | v1 with PNAM **not** lexicographic | `fatal: multi-pack-index pack names out of order: 'X' before 'Y'`, exit 128 |
| D8 | **the same bytes** with version = 2 | **accepted**, object reads succeed, exit 0 |

D7 vs D8 is the entire v1↔v2 delta: **v1 requires PNAM lexicographic order, v2 does not.**

### Pin E — hash width

| repo `--object-format` | midx `hashVersion` byte | `OIDL` stride | PNAM name length |
|---|---|---|---|
| sha1 | **1** | 20 | 49 (`pack-` + 40 hex + `.idx`) |
| sha256 | **2** | 32 | 73 (`pack-` + 64 hex + `.idx`) |

A `hashVersion` that disagrees with the repository is **not** fatal: see Pin G row G5. The header
carries no digest, so the 12-byte header parse is hash-independent.

### Pin F — large offsets (`LOFF`)

A 2 GiB pack is not needed to pin this. A valid `BASE` midx was **rebuilt** with a fifth chunk:
object #0's `OOFF` offset word replaced by `0x80000000` (large-offset row 0) and an 8-byte `LOFF`
chunk appended carrying its true offset (12), chunk table extended to 6 entries, trailer re-hashed.

| row | shape | git 2.55.0 |
|---|---|---|
| F1 | `LOFF` present, one entry, bit 31 set on that object | **all objects read, exit 0**; `multi-pack-index verify` exit 0; `fsck` exit 0 |
| F2 | bit 31 set, **no `LOFF` chunk** | `fatal: offset beyond end of packfile (truncated pack?)` — the masked bit is *not* stripped; `0x80000000` is taken literally |

**Rule.** Bit 31 of the `OOFF` offset word is an indirection flag **only when a `LOFF` chunk
exists**; otherwise it is part of the offset. This is the `.idx` v2 rule, and it is exactly what
`readOffset` (`pack-index.ts:93-108`) already implements — with one difference: the `.idx` v2
large-offset table is *always* present at a computed position, whereas the midx `LOFF` chunk is
*optional*. Reusing the `.idx` masking logic verbatim would produce F2's silent-corruption path.

### Pin G — corruption posture: **git has two tiers, and one of them kills the process**

`BASE`, one mutation per row, trailer re-stamped where the mutation would otherwise be masked by
the checksum. "reads" = `cat-file -p` on each of `OID1..3` and `LOOSE`, plus `--batch-check`.

| # | mutation | git message | reads | exit | tier |
|---|---|---|---|---|---|
| G1 | signature's 4th byte flipped (`0x4d494458` → `0x4d494459`) | `fatal: multi-pack-index signature 0x4d494459 does not match signature 0x4d494458` | **all fail, loose included** | 128 | **A — die** |
| G2 | version 3 | `fatal: multi-pack-index version 3 not recognized` | all fail | 128 | **A** |
| G3 | version 0 | `fatal: multi-pack-index version 0 not recognized` | all fail | 128 | **A** |
| G4 | version 2 | — | all succeed | 0 | accepted |
| G5 | `hashVersion` = 2 in a SHA-1 repo | `error: multi-pack-index hash version 2 does not match version 1` | **all succeed** | 0 | **B — ignore** |
| G6 | truncated to 8 bytes | `error: multi-pack-index file … is too small` | all succeed | 0 | **B** |
| G7 | truncated mid-`OIDL` | `error: improper chunk offset(s) 4e0 and 594` | all succeed | 0 | **B** |
| G8 | trailer digest flipped | **silent on read**; `fsck` `incorrect checksum` exit 32; `verify` exit 1 | all succeed, **midx still used** | 0 | **not checked on read** |
| G9 | `numPacks` = 99 | `fatal: multi-pack-index pack names out of order: '…' before ''` | all fail | 128 | **A** |
| G10 | `numPacks` = 1 (understated) | `fatal: bad pack-int-id: 2 (1 total packs)` | partial: the object in pack 0 reads; the others die | 128 | **A** |
| G11 | `PNAM` chunk id clobbered | `fatal: multi-pack-index required pack-name chunk missing or corrupted` | all fail | 128 | **A** |
| G12 | `OIDF` chunk id clobbered | `fatal: multi-pack-index required OID fanout chunk missing or corrupted` | all fail | 128 | **A** |
| G13 | `OIDF` fanout non-monotonic | `error: oid fanout out of order: fanout[0] = ffff > 0 = fanout[1]` then `fatal: … required OID fanout chunk missing or corrupted` | all fail | 128 | **A** |
| G14 | `numChunks` byte = 0 | `error: final chunk has non-zero id 504e414d` | all succeed | 0 | **B** |
| G15 | zero-length file | `error: multi-pack-index file … is too small` | all succeed | 0 | **B** |
| G16 | `chmod 000` | **silent** on read; `fsck`/`verify`: `error: multi-pack-index file exists, but failed to parse`, exit 32 / 1 | all succeed | 0 | **B, silent** |
| G17 | same signature flip **+ `core.multiPackIndex=false`** | — | all succeed | 0 | not read at all |

**Rule, as pinned.**

- **Tier A** — signature, version, required-chunk presence, `OIDF` monotonicity, `PNAM`
  well-formedness/order, and `pack-int-id` range: `die()`. Every read in the process fails,
  **including loose objects and objects in packs the midx never named**. This is the opposite of
  ADR-575's per-pack degradation posture.
- **Tier B** — file too small, unreadable, chunk offsets outside the file or out of order, final-chunk-id
  mismatch, hash-version disagreement: `error()` (or silence) and **the midx is discarded**;
  every read is served from the ordinary `.idx` pack list, exit 0.
- **The trailer is never verified on read** (G8). Only `fsck` and `multi-pack-index verify` check
  it. A midx with a wrong checksum is *used*.
- `core.multiPackIndex=false` short-circuits everything, including Tier A (G17).

The split is not arbitrary: Tier B is "I could not make sense of this file at all → pretend it
isn't there"; Tier A is "this file parsed far enough to be structurally self-inconsistent → the
object store's integrity is in question".

### Pin H — **the midx is authoritative for the packs it names**

The decisive matrix, run on `DUP`: one blob in **both** pack A and pack B; the midx assigns it to
pack A. If the midx were an accelerator with `.idx` fallback, every row would read the blob.

| # | shape | `cat-file --batch-check` |
|---|---|---|
| H1 | healthy (control) | `blob 9`, exit 0 |
| H2 | pack A **fully deleted** (`.pack` + `.idx` + `.rev`) | **`missing`** — pack B is not consulted |
| H3 | pack A's `.pack` deleted, `.idx` kept | **`missing`** |
| H4 | pack A's `.pack` `chmod 000` | **`missing`** |
| H5 | pack A deleted **+ `core.multiPackIndex=false`** | **`blob 9`** — pack B serves it |
| H6 | pack A deleted **+ midx file removed** | **`blob 9`** |
| H7 | `PNAM`'s first name mutated to a **name no file has** (same length) | **`blob 9`**, exit 0; `fsck` exit 32 + `failed to load pack in position 0`; `verify` exit 1 |
| H8 | a **new pack** written into the directory *after* the midx | its objects **read normally**, `count-objects` `packs: 3` |

**Rule.** The pack universe is `midx-named packs ∪ packs the midx does not name`. Packs the midx
names are reached **only through the midx**; their own `.idx` is never used as a second chance for
an oid the midx has already assigned elsewhere. H5/H6 prove the midx is what hides the object, and
H7 draws the line precisely: a `PNAM` entry that **cannot be resolved to a pack at all** falls out
of the midx's universe, so the real pack of that name becomes "a pack the midx does not name" and
is scanned normally — whereas a `PNAM` entry that resolves to a *known, unusable* pack keeps its
objects, and they report missing.

**Consequence for tsgit.** Ignoring the midx (today) is the H5/H6 column. Implementing it as a
pure accelerator with `.idx` fallback is *also* the H5/H6 column. Only authority reproduces H2–H4.
This was DC-1, and **ADR-592 ratified authority**.

### Pin I — chain degradation

`CHAIN`, three layers. `∅` = no message.

| # | mutation | message | reads | exit |
|---|---|---|---|---|
| I1 | healthy | ∅ | all succeed | 0 |
| I2 | a listed layer's `.midx` file **deleted** | `warning: unable to find all multi-pack index files` | all succeed | 0 |
| I3 | a layer with a **bad signature** | `fatal: multi-pack-index signature …` | **all fail** | 128 |
| I4 | a layer **truncated to 8 bytes** | `error: … is too small` + `warning: unable to find all multi-pack index files` | all succeed | 0 |
| I5 | chain file **deleted** (layers remain) | ∅ | all succeed | 0 |
| I6 | chain file **empty** | ∅ | all succeed | 0 |
| I7 | chain file lists only layer 1 | ∅ | all succeed | 0 |
| I8 | a bogus 40-hex digest appended to the chain | `warning: unable to find all multi-pack index files` | all succeed | 0 |
| I9 | chain reordered | ∅ | all succeed | 0 |
| I10 | a non-hex line (`garbage`) appended | ∅ — **silently ignored** | all succeed | 0 |

**The chain is all-or-nothing.** Proven on the `CHAIN`-shaped `DUP` fixture: with layer 1's pack
deleted the blob reads `missing` (chain live, authority per Pin H); delete **layer 2's `.midx`
file** as well and the same blob reads `blob 9` — the *entire* chain is dropped, not the missing
layer, and the packs return to the ordinary `.idx` scan. A layer that fails at Tier A still dies
(I3): tier classification happens per layer, chain-dropping only for Tier B / missing layers.

I10's silence is the chain parser stopping at the first malformed line; the layers before it are
still loaded, so nothing is reported.

### Pin J — flat vs chain precedence

Discriminator: a **broken** chain emits `warning: unable to find all multi-pack index files`
(Pin I2). If the warning disappears when a flat midx is added, the chain was never read.

| # | shape | warning? | reads |
|---|---|---|---|
| J1 | broken chain, **no** flat midx (control) | **yes** | succeed |
| J2 | broken chain **+ valid flat midx** | **no** | succeed |
| J3 | chain with a bogus digest line **+ valid flat midx** | **no** | succeed |
| J4 | chain layer with a **bad signature** (would `die()`) **+ valid flat midx** | **no**, exit 0 | succeed |
| J5 | **unparseable** flat midx (Tier B, too small) + intact chain, layer-1 pack deleted | `error: … is too small`, then **`missing`** | the chain *is* read |
| J6 | flat midx with a **bad signature** (Tier A) + intact chain | `fatal: … signature …`, exit 128 | all fail |

**Rule.** A flat `objects/pack/multi-pack-index` that loads at all **suppresses the chain
entirely** — J4 is the proof, since a Tier-A layer that is never read cannot `die()`. If the flat
file exists but is Tier-B-unusable, the chain **is** loaded (J5). If the flat file is Tier-A-bad,
nothing else happens (J6). Precedence is therefore: *flat, else chain, else `.idx` scan*, and it
is `try` semantics on the flat file, not mere existence.

### Pin K — lookup, enumeration and abbreviation disagree under a stale midx

`DUP`-shaped chain, layer-1's pack deleted:

| surface | answer |
|---|---|
| `cat-file --batch-check <oid>` | `missing` |
| `cat-file --batch-all-objects --batch-check` | **lists the oid**, annotated `missing` |
| `rev-parse --disambiguate=<prefix>` | **resolves to the full oid** |
| `count-objects -v` | `packs: 1`, i.e. counted from the loadable packs |

And on the flat `BASE` with a midx-named pack deleted, `--batch-all-objects` lists **7** objects —
the same 7 as with no midx at all — while `rev-parse --disambiguate` still resolves a prefix
belonging to the vanished pack.

**Rule.** git's *enumeration* runs over the loadable packs' own indexes, its *abbreviation*
resolution runs over the midx's oid list, and its *lookup* runs over the midx with pack authority.
These are three different universes and git does not reconcile them. Any tsgit design that routes
`enumerateObjects` / `resolveOidPrefix` through the midx must pick a universe deliberately
(the DC-6(c) option), and any design that does not must state that it inherits the `.idx` universe
(which is git's enumeration universe, and therefore faithful on that axis). **ADR-597 took (b), not
(c)**, so this design is the second case: it inherits the `.idx` universe deliberately, faithful for
`enumerateObjects` and not for `resolveOidPrefix` — §D11.1.

### Pin L — the rest of git's midx dependencies

| # | shape | git |
|---|---|---|
| L1 | midx present, `.rev` files present | irrelevant to reads; `.rev` is bitmap machinery (28.3) |
| L2 | midx present, healthy | reads byte-identical to the same repo with the midx removed — executed across all four `BASE` oids via `cat-file -p` and `--batch-check`, both exit 0, `count-objects -v` identical (`in-pack: 9`, `packs: 3`) |
| L3 | midx names 3 packs, one holds an object also present loose | the loose copy is served; no midx involvement |
| L4 | new pack added after the midx | found (Pin H8) — the midx never subtracts a pack it does not name |
| L5 | midx-named pack's **`.idx` deleted**, `.pack` kept | `error: packfile … index unavailable` ×2, object **missing** |
| L6 | midx in an alternate object directory | git supports it ("could be stored in the pack directory of an alternate … refers only to packfiles in that same directory"). **tsgit has no alternates support at all** (`grep -rn alternates src/` → zero hits), so the case cannot arise. |

### Pin M — tsgit today (structural, read off the code)

Not executed as a matrix because the answer is structural and total: `isCandidate`
(`pack-registry.ts:194`) admits only names ending `.idx`, so `multi-pack-index` and
`multi-pack-index.d` are filtered out at the scan, in every row above. tsgit's column is therefore
**identical to git's `core.multiPackIndex=false` column** for every Pin G, H, I and J row: reads
succeed, the `.idx` scan answers, nothing dies. That is why 28.2 is a perf item and not a bug —
and it is also why adopting Pin H's authority is a **behaviour change**, not a bug fix (DC-1).

## Pinned matrices — `git fsck`, commissioned by ADR-601

Pins A–M pin the **read** path. ADR-601 ratified fsck midx reporting into this change, and its
Decision section requires "a dedicated fsck pin matrix (per-row message, exit code, and finding
shape) before planning". Pins **N, O, P** are that matrix, executed against the same git 2.55.0 on
the same host, under the identical isolation discipline (one `mktemp -d` per row, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` unset, `commit.gpgsign=false`, `init.defaultBranch=main`).

Two fixtures, both re-derived for this matrix rather than reused by reference:

- **`BASE`** — 3 packs, 9 packed objects, 1 unreferenced loose blob, flat midx. Every row inherits
  a constant `dangling blob <LOOSE>` on stdout; the tables below report the **delta** from it.
- **`CHAIN`** — 2 packs, 2 chain layers, 1 unreferenced loose blob. Two layers is the **deepest
  chain this recipe reaches**: a third `git multi-pack-index write --incremental` append at this
  repo size collapses the chain into a flat file and empties `multi-pack-index.d/` (Pin A's
  compaction, reached by growth rather than by an explicit non-incremental write). Rows needing a
  third layer are therefore absent by construction, not by omission.

**One methodological warning, paid for once.** git writes chain layer files **`0444`** (the flat
`multi-pack-index` is `0644`). The first run of Pin P mutated layers without `chmod u+w`, every
write failed silently inside the row harness, and **four rows measured a healthy repo** — reported
as "Tier-A layer: exit 0, silent", which would have inverted Pin I3. Every layer mutation below is
preceded by `chmod -R u+w` **and** the harness fails the row when the mutation's exit status is
non-zero. This is the same trap the pack-accessibility matrix hit on `0444` loose objects.

### Pin N — the mechanism: fsck's midx pass is a **child** `multi-pack-index verify`

`GIT_TRACE=1 git fsck`, three shapes:

| # | probe | observed |
|---|---|---|
| N1 | healthy repo with a midx | `trace: run_command: git multi-pack-index verify --object-dir .git/objects --no-progress` — a **child process**, spawned after `git refs verify` and `git commit-graph verify` |
| N2 | repo with a faulty midx | the same child is spawned; its stderr is fsck's stderr **verbatim**, which is why the midx lines carry `error:` / `fatal:` / no prefix inconsistently — they are `verify`'s, not fsck's |
| N3 | healthy repo, **`core.multiPackIndex=false`** | **no child spawned** — no `multi-pack-index` line in the trace at all |

This one fact explains every row in Pins O and P, and it is the hinge on which ADR-593 and ADR-601
compose instead of colliding:

- **A non-zero child exit sets bit 32** (`ERROR_MULTI_PACK_INDEX`), whether the child exited **1**
  (a `verify` verdict) or **128** (a `die()` inside the child). The child's `die()` does **not**
  kill fsck.
- **fsck exits 128 only when the *parent's own* object-store access hits Tier A first** — the
  parent enumerates objects before it reaches the midx pass, so a midx that dies *at load* kills
  the parent and the child never runs (stdout empty, no findings at all). A midx that dies only
  when a *particular offset is decoded* (row O28) leaves the parent alive and is reported by the
  child as bit 32.
- The **only** gate is `core.multiPackIndex=false`. Mode is not a gate:

| repo shape | `fsck` | `--connectivity-only` | `--no-full` | `--strict` |
|---|---|---|---|---|
| healthy | 0 | 0 | 0 | 0 |
| flat Tier-B (truncated to 8 B) | **32** | **32** | **32** | **32** |
| trailer digest flipped | **32** | **32** | **32** | **32** |
| `PNAM` entry unresolvable | **32** | **32** | **32** | **32** |
| midx-named pack deleted | **42** | **42** | **42** | **42** |
| `LOFF` row out of range | **32** | **128** | **32** | **32** |

**Rules, as pinned.**

- **Bit 32 is ungated by mode** — the same posture as bit 64 (ADR-586), the opposite of bit 4.
- **Bit 32 composes by plain OR.** `42 = 2 | 8 | 32`, and the *same repo with the midx removed* is
  `10 = 2 | 8` (row O26) — the differential that proves bit 32 is the midx's own contribution and
  not a re-labelling of the connectivity bits.
- The `LOFF` row's lone `--connectivity-only` **128** is the *parent* dying (that mode decodes the
  offending offset in the parent walk), not the pass behaving differently. It is the cleanest
  single demonstration of the parent/child split.

### Pin O — `git fsck` over a **flat** midx, `BASE`

`fsck` = `git fsck` exit; `verify` = `git multi-pack-index verify` exit, recorded per row because
Pin N makes it the *cause* of fsck's bit 32. Messages are the midx-related stderr lines only.

| # | mutation | fsck | verify | git's midx line(s) | class |
|---|---|---|---|---|---|
| O1 | healthy (control) | **0** | 0 | — | clean |
| O2 | **no midx at all** (control) | **0** | 0 | — | clean |
| O3 | signature 4th byte flipped | **128** | 128 | `fatal: multi-pack-index signature 0x4d494459 does not match signature 0x4d494458` | **A, parent dies** |
| O4 | version 3 | **128** | 128 | `fatal: multi-pack-index version 3 not recognized` | A |
| O5 | version 0 | **128** | 128 | `fatal: multi-pack-index version 0 not recognized` | A |
| O6 | version 2 | **0** | 0 | — | accepted |
| O7 | `hashVersion` 2 in a SHA-1 repo | **32** | 1 | `error: multi-pack-index hash version 2 does not match version 1` **then** `error: multi-pack-index file exists, but failed to parse` | B + verdict |
| O8 | truncated to 8 bytes | **32** | 1 | `error: multi-pack-index file <path> is too small` + the same verdict | B |
| O9 | truncated mid-`OIDL` | **32** | 1 | `error: improper chunk offset(s) 4e0 and 594` + verdict | B |
| O10 | **trailer digest flipped** | **32** | 1 | `incorrect checksum` — **no prefix at all**, and the *only* line | verification-only |
| O11 | `numPacks` = 99 | **128** | 128 | `fatal: multi-pack-index pack names out of order: '<name>.idx' before ''` | A |
| O12 | `numPacks` = 1 (understated) | **128** | 128 | `fatal: bad pack-int-id: 1 (1 total packs)` — the index differs between the two commands (`2` under `verify`), so **only the class is data, not the integer** | A |
| O13 | `PNAM` chunk id clobbered | **128** | 128 | `fatal: multi-pack-index required pack-name chunk missing or corrupted` | A |
| O14 | `OIDF` chunk id clobbered | **128** | 128 | `fatal: multi-pack-index required OID fanout chunk missing or corrupted` | A |
| O15 | `OIDF` non-monotonic | **128** | 128 | `error: oid fanout out of order: fanout[0] = ffff > 0 = fanout[1]` **then** `fatal: … required OID fanout chunk missing or corrupted` | A |
| O16 | `numChunks` byte = 0 | **32** | 1 | `error: final chunk has non-zero id 504e414d` + verdict | B |
| O17 | zero-length file | **32** | 1 | `error: … is too small` + verdict | B |
| O18 | `chmod 000` | **32** | 1 | **only** `error: multi-pack-index file exists, but failed to parse` — git is silent about the cause | B, silent |
| O19 | signature flip **+ `core.multiPackIndex=false`** | **0** | 128 | — (fsck spawns no child; `verify` run by hand still dies) | not read |
| O20 | **`numBaseFiles` = 1** | **0** | **0** | — | **ignored** |
| O21 | `numBaseFiles` = 1 **+ a midx-named pack deleted** | **42** | 1 | byte-identical to O23 | **ignored** |
| O22 | `PNAM`[0] renamed to a name no file has, lexicographic order preserved | **32** | 1 | `failed to load pack in position 0` **then** `failed to load pack entry for oid[i] = <oid>` × 3 — neither prefixed | staleness |
| O23 | a midx-named pack fully deleted (`.pack` + `.idx` + `.rev`) | **42** | 1 | the same two families, plus the ordinary connectivity fallout (`missing blob` on stdout, `invalid sha1 pointer` on stderr) | staleness |
| O24 | a midx-named pack's `.pack` deleted, `.idx` kept | **42** | 1 | identical to O23 | staleness |
| O25 | a midx-named pack's **`.idx` deleted**, `.pack` kept | **110** | 1 | `error: packfile <p>.pack index unavailable` (many), `index not opened`, `unable to load rev-index`, **no** `failed to load pack in position`, but `failed to load pack entry for oid[i]` × 3 | staleness **+** pack layer |
| O26 | **no midx** + the same pack deleted (differential control for O23) | **10** | 0 | connectivity fallout only — **no bit 32, no midx line** | control |
| O27 | `LOFF` chunk appended, bit 31 set, row **in range** | **0** | 0 | — ; all objects still enumerate | accepted |
| O28 | same, row **out of range** (row 5, `largeOffsetCount` = 1) | **32** | **128** | `fatal: multi-pack-index large offset out of bounds` | **A, contained by the child** |

**Rules, as pinned.**

- **`failed to load pack in position N` and `failed to load pack entry for oid[i] = <oid>` are
  independent findings, not a header and its detail.** O25 emits the second without the first: the
  pack *resolved* (its `.pack` is on disk) but the entry could not be filled (no `.idx`). O22/O23
  emit both. Two variants, and the O25 row is what forbids collapsing them.
- **The `multi-pack-index file exists, but failed to parse` verdict is gated on the flat file
  existing**, not on "no midx is usable" — see P20, where a fully unusable chain with no flat file
  produces no verdict and **exit 0**.
- **`numBaseFiles` is ignored outright** (O20/O21, and P21–P23 on chain layers). git 2.55.0 does
  not read the byte on either form: a midx with `numBaseFiles = 1` loads, is used, stays
  **authoritative** (O21 reproduces O23's stale-midx answer exactly), and passes `verify`. §D4.4
  takes the consequence.
- **The trailer is a `verify`-time check only** (O10), exactly as Pin G8 pinned it for the read
  path — ADR-602's split is git's own.
- **Message cardinality is presentation.** A Tier-B cause line appears **three** times under
  `fsck` and **once** under `verify` (the parent's own load attempts, then the child's). The exit
  integer is stable; per ADR-249 tsgit reproduces the condition and the integer, and reconstructs
  the transcript in the interop test.

### Pin P — `git fsck` over a **chain**, `CHAIN`

| # | mutation | fsck | verify | git's midx line(s) | rule |
|---|---|---|---|---|---|
| P1 | healthy chain (control) | **0** | 0 | — | |
| P2 | **base** layer `.midx` deleted | **0** | 0 | `warning: unable to find all multi-pack index files` | chain dropped, **no bit** |
| P3 | **newest** layer `.midx` deleted | **0** | 0 | same warning | same |
| P4 | base layer `chmod 000` | **0** | 0 | same warning | same |
| P5 | bogus 40-hex digest appended to the chain file | **0** | 0 | same warning | same |
| P6 | chain file deleted, layers remain | **0** | 0 | — | silent |
| P7 | chain file emptied | **0** | 0 | — | silent |
| P8 | base layer **truncated to 8 bytes** (Tier B) | **0** | **0** | `error: multi-pack-index file <layer> is too small` **+** `warning: unable to find all multi-pack index files` | **an `error:` line with no exit bit** |
| P9 | base layer **bad signature** | **128** | 128 | `fatal: multi-pack-index signature …` | **A** |
| P10 | newest layer bad signature | **128** | 128 | same | A |
| P11 | base layer version 3 | **128** | 128 | `fatal: multi-pack-index version 3 not recognized` | A |
| P12 | **base** layer trailer flipped | **0** | **0** | — **silent** | only the chain **head** has its checksum verified |
| P13 | **newest** layer trailer flipped | **32** | 1 | `incorrect checksum` | |
| P14 | newest layer `PNAM` unresolvable | **32** | 1 | `failed to load pack in position 1` + `failed to load pack entry for oid[i]` × 3 | positions are **chain-global** |
| P15 | **base** layer `PNAM` unresolvable | **32** | 1 | `failed to load pack in position 0` + per-oid × 3 | base layers **are** verified |
| P16 | a midx-named pack deleted, chain intact | **42** | 1 | `failed to load pack in position 1` + per-oid + connectivity fallout | |
| P17 | **Tier-B flat midx + intact chain** | **0** | **0** | `error: multi-pack-index file …/multi-pack-index is too small` — and **no verdict line** | the chain loads, so the flat fault is not a finding |
| P18 | **Tier-A flat midx + intact chain** | **128** | 128 | `fatal: multi-pack-index signature …` | flat Tier A wins outright |
| P19 | broken chain (base truncated) **+ valid flat midx** | **0** | **0** | — **completely silent** | the flat file suppresses the chain; the broken layer is never opened |
| P20 | broken chain (base truncated), **no flat file** | **0** | **0** | the P8 lines | no verdict — it is gated on the flat file existing |
| P21 | `numBaseFiles` = 1, newest layer | **0** | 0 | — | ignored |
| P22 | `numBaseFiles` = 1, base layer | **0** | 0 | — | ignored |
| P23 | `numBaseFiles` = 2, newest layer | **0** | 0 | — | ignored |

**Rules, as pinned.**

- **A dropped chain is a non-event on the exit axis.** P2–P8 and P20 all exit **0**, whether the
  layer is missing, unreadable, bogus-in-the-chain-file or Tier-B-corrupt, and whether or not git
  printed an `error:` line about it. This is the same shape as the orphan-`.idx` rows in the pack
  matrix (J11/J12): git complains and scores nothing. **tsgit therefore emits no fsck finding for
  a dropped chain** — only the per-generation `warn` §D2 already specifies.
- **Only the chain head's trailer is verified** (P12 vs P13). A base layer with a wrong digest —
  and therefore a filename that no longer equals its own trailer — is completely silent. This
  bounds ADR-602's fsck-time verification to **one** digest per artefact set, not one per layer,
  and it is the reason §D12.4 hashes exactly one file.
- **Pack positions are chain-global** (P14 = position 1, P15 = position 0), while `pack-int-id`
  inside a layer's `OOFF` is layer-local (Pin C). The finding must carry the **global** position
  to match, so §D12.3 derives it as `Σ layers[0..k-1].numPacks + packIndex`.
- **P19 is the strongest confirmation of Pin J** available on the fsck axis: a chain broken badly
  enough to print two lines on its own (P20) prints **nothing** once a loadable flat midx is
  present, because the chain is never opened.

## Requirements

Verifiable at ship time.

1. **A midx is parsed, or provably ignored, and never mis-parsed.** `parseMultiPackIndex` accepts
   exactly the byte shapes git accepts (Pin B, D, E, F) and refuses every other, with a reason
   naming the observed field. No `DataView` read is issued at an offset the parser has not first
   proved to lie inside the buffer — a `RangeError` escaping the parser is a defect, not an error
   path (T-4).
2. **Version accept-set `{1, 2}`**, and the v1-only PNAM lexicographic rule is enforced for v1 and
   not for v2 (Pin D7/D8). Boundary rows 0 and 3 refuse.
3. **Hash-generic in the parser.** `digestLength` is a parameter; the parser never reads
   `ctx.hashConfig` and never branches on 20 vs 32. A `hashVersion` disagreeing with the
   repository is a **Tier B** condition resolved in the application layer, not a parse failure
   (Pin G5). The pack subsystem's pre-existing SHA-1-only limit (B-7) is neither widened nor
   narrowed.
4. **Large offsets are correct in both directions** (Pin F): with a `LOFF` chunk, bit 31 selects a
   row; without one, bit 31 is part of the offset. The `.idx` `readOffset` logic is **not** reused
   verbatim, because the `LOFF` chunk is optional where the `.idx` large table is not.
5. **Precedence matches Pin J**: flat first with `try` semantics, chain only if the flat file is
   absent or Tier-B-unusable, `.idx` scan only if neither loads.
6. **The chain is all-or-nothing** (Pin I): a missing layer file, an unusable layer, a chain digest
   with no file, or a malformed digest line drops the whole chain to the `.idx` scan. A chain line
   that is not exactly `2 × digestLength` lowercase hex terminates the chain (I10).
7. **Degradation posture replicates git's two tiers** (ADR-593), by the same rule for a flat midx
   and for a chain layer, covering every Pin G row:
   **Tier A throws** a `TsgitError` that fails the read — *including* a read that would otherwise
   have been served from a loose object (§D4.5) — and **Tier B** records a fault, warns once per
   generation, and discards the midx per Pin J. No midx fault is handled by `catch {}` and no
   message is re-parsed: classification is a total function over the closed `MidxCheck` union plus
   the two I/O codes the registry already allow-lists (§D4.1), in the discipline ADR-575 fixed. The
   Tier-A arm is verified to be **absent from every allow-list in the registry** by an explicit
   test row, not by inspection (§D4.2).
8. **A midx never changes an answer in a healthy repository.** For every object in every pack, the
   bytes returned with the midx present equal the bytes returned with it absent (Pin L2). This is
   the property the interop twin pins.
9. **Stale-midx behaviour is authority** (ADR-592), and it is asserted, not incidental. The
   `DUP` fixture — one object in two packs, the midx naming one of them — is the only shape that
   can tell authority from acceleration apart, and it is an interop row.
10. **The `.idx` read stays bounded and validated.** Under ADR-597's lazy loading, `readBoundedIdx`'s
    pre-`stat` and post-`read` size checks still run before any large allocation, and
    `parsePackIndex`'s guards are untouched. The midx read is bounded by its own limit (ADR-600)
    with the same stat-then-read-then-recheck shape.
11. **Path safety is total.** Every path derived from `PNAM` or from a chain line passes the same
    validation the `.idx` scan already applies (`isSafePackName`: no `/`, `\`, `..`, no control
    characters) **before** it is concatenated with a directory. A midx is attacker-controllable
    bytes; a `PNAM` entry is an arbitrary NUL-terminated string (T-1).
12. **No swallowed reason.** Wherever the design declines to propagate a fault, the reason reaches
    `ctx.logger?.warn?.` with the artefact name, once per generation (ADR-580's discipline).
13. **The #263 handle lifecycle is untouched.** The midx is read whole via `ctx.fs.read` and holds
    **no** `FileHandle`; opened-minus-closed handles stay 0 across every row of that design's
    lifecycle matrix. `refresh()` drops the midx with the generation; `dispose()` stays terminal.
14. **One generation, one midx.** The midx and the pack array are produced by the **same**
    `createPromiseMemo`, so no consumer can ever observe a midx from one scan against packs from
    another. A rejection is not memoised.
15. **Structured data only.** No rendering option, no returned line; git's `error:` / `warning:` /
    `fatal:` transcripts are reconstructed inside the interop test from structured fields
    (ADR-249).
16. **Write-path symmetry, explicitly.** tsgit gains no midx write surface, and every existing
    pack-writing path is audited against the constraint in §D8. `tooling/audit-write-surfaces.ts`
    stays green with no new annotation or allowlist entry.
17. **Every public API change is deliberate.** New domain exports (`MultiPackIndex`, `MidxCheck`,
    `parseMultiPackIndex`, …) and the new `FsckFinding` variants appear in `reports/api.json`
    deliberately. `PackRegistry`'s five existing method signatures do not change shape; it gains
    **one** accessor, `midxHealth()` (§D12.2). Two ratified movements: `RegisteredPack.index`
    becomes a `() => Promise<PackIndex>` (ADR-597), with exactly two consumers
    (`enumerate-objects.ts:34`, `resolve-oid-prefix.ts:43`), both already inside `async` functions;
    and `FsckResult.exitCode` gains bit 32, which is additive to a documented bitmask.
18. **Measured, not asserted.** The perf claim is carried by a bench over a many-pack repository
    (§D7), sourced from the CI nightly artefact, not a local run.
19. **`fsck` reports the midx** (ADR-601), reproducing every Pin O and Pin P row's **exit
    contribution** and one structured finding per condition git reports:
    a. bit **32** (`EXIT_MULTI_PACK_INDEX`) is set for exactly the rows where git's exit gains it,
       composes by plain OR, and is **ungated by mode** (Pin N) — `connectivityOnly`, `full: false`
       and `strict` all report it.
    b. A midx whose fault is Tier A **at load** makes `fsck` **reject** with that fault and return
       no result — the ADR-590 shape, matching git's exit 128 with empty stdout (rows O3–O5, O11–O15,
       P9–P11, P18). A Tier-A fault reached only **inside the pass** (row O28) becomes a finding and
       bit 32 instead, because git's own pass is a child process (Pin N, §D12.1).
    c. A **dropped chain** produces **no finding and no bit** (P2–P8, P20) — only §D2's warn.
    d. The `midx-unusable` finding is gated on the **flat file existing** (Pin O rule 2, P17, P20).
20. **The trailer is verified at fsck time and nowhere else** (ADR-602). `parseMultiPackIndex` and
    `loadMidxSet` never hash the file; the fsck pass hashes **one** artefact — the flat file, or the
    chain **head** only, never a base layer (P12 vs P13).
21. **`numBaseFiles` is accepted and ignored**, on both forms, for every value (Pin O20/O21,
    P21–P23). It is not a parse gate, not a `MidxCheck` member and not a fsck finding (§D4.4).

## Design

### §D1 — the domain parser: `src/domain/storage/midx.ts`

Mirrors `pack-index.ts` in shape so the two read as siblings.

```ts
export interface MultiPackIndex {
  readonly version: 1 | 2;
  readonly hashVersion: 1 | 2;
  readonly digestLength: number;
  readonly objectCount: number;
  /** As recorded in PNAM — `pack-<hex>.idx`, NOT a path and NOT validated here. */
  readonly packNames: ReadonlyArray<string>;
  readonly oidFanoutOffset: number;
  readonly oidLookupOffset: number;
  readonly objectOffsetsOffset: number;
  /** undefined when the file carries no LOFF chunk — the Pin F distinction. */
  readonly largeOffsetsOffset: number | undefined;
  readonly largeOffsetCount: number;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}

export function parseMultiPackIndex(bytes: Uint8Array, digestLength: number): MultiPackIndex;

export interface MidxEntry {
  readonly packIndex: number; // index into packNames
  readonly offset: number;
}
export function lookupMultiPackIndex(midx: MultiPackIndex, id: ObjectId): MidxEntry | undefined;
export function allMidxObjectIds(midx: MultiPackIndex): ReadonlyArray<ObjectId>;
export function findMidxByPrefix(midx: MultiPackIndex, prefix: string): ReadonlyArray<ObjectId>;
```

Parse order, each step gated on the previous (this ordering is what makes requirement 1 true):

1. `bytes.length ≥ MIDX_HEADER_SIZE (12)` → else refuse.
2. signature `MIDX`; version ∈ `{1, 2}`; `hashVersion` ∈ `{1, 2}` and its implied width **equals**
   the `digestLength` argument; `numChunks ≥ 1`. **`numBaseFiles` is read into the parsed value and
   never gated** — Pin O20/O21 and P21–P23 show git 2.55.0 ignores the byte outright on both forms,
   at every value tried, with the midx still loading, still used and still authoritative. The draft
   proposed refusing a non-zero value; the fsck matrix falsified that. §D4.4 records the reversal.
3. chunk table fits: `12 + (numChunks + 1) * 12 ≤ bytes.length - digestLength`.
4. read the `numChunks + 1` entries. Every offset must be **strictly increasing**, ≥ the table's
   own end, and ≤ `bytes.length - digestLength`; the final entry's id must be `0`. (G7 and G14 are
   exactly these two checks.)
5. required chunks present: `PNAM`, `OIDF`, `OIDL`, `OOFF` (G11, G12).
6. `OIDF` is `1024` bytes and monotonic; `objectCount = F[255]` (G13).
7. `OIDL.length === objectCount * digestLength`; `OOFF.length === objectCount * 8`.
8. `PNAM` splits into exactly `numPacks` NUL-terminated names, all non-empty; git never checks the
   remainder past the last name (corrected post-implementation — the draft's ≤3-NUL-padding-byte
   refusal was wrong, see **Post-implementation corrections (a)**); for version 1 only, strictly
   increasing (D7/D8).
9. `LOFF`, if present, has a length that is a multiple of 8; `largeOffsetCount = len / 8`.

`lookupMultiPackIndex` is `lookupPackIndex`'s structure with a wider stride and a two-word payload:
fanout-narrowed binary search over `OIDL`, byte-wise compare against `hexToBytes(id)`, then read
`OOFF[i]`. Offset decode, the Pin F rule stated as code:

```ts
const raw = view.getUint32(objectOffsetsOffset + i * 8 + 4);
if (midx.largeOffsetsOffset === undefined || (raw & 0x80000000) === 0) return raw >>> 0;
const row = raw & 0x7fffffff;
if (row >= midx.largeOffsetCount) throw invalidMultiPackIndex(`large offset row ${row} out of range`);
// …high/low u32 pair, with pack-index.ts's identical safe-integer guard on `high`
```

The `packIndex` bound (`< packNames.length`) is checked at read time, reproducing G10 as a parse-
class refusal rather than a crash.

New error in `src/domain/storage/error.ts` (ADR-599). It carries a **`check` discriminant** naming the
gate that fired, because the parser is the only thing that knows *which* check failed and the
application layer must never recover that by matching on a message:

```ts
export type MidxCheck =
  | 'size' | 'signature' | 'version' | 'hash-version' | 'chunk-table'
  | 'required-chunk' | 'fanout' | 'chunk-length' | 'pack-names' | 'pack-int-id' | 'large-offset';

| { readonly code: 'INVALID_MULTI_PACK_INDEX'; readonly reason: string; readonly check: MidxCheck }

export const invalidMultiPackIndex = (check: MidxCheck, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_MULTI_PACK_INDEX', check, reason });
```

plus barrel exports in `src/domain/storage/index.ts` beside the pack-index block. `check` is a
closed union, so §D4's tier mapping is exhaustive by the type-checker rather than by review — and
it keeps the tier decision (ADR-593) out of the domain, where a policy call does not belong.

**`base-files` is gone from the union** (requirement 21). It was in the draft only because the
draft refused a non-zero `numBaseFiles`; Pin O20 shows git accepts it. Eleven members remain, and
`large-offset` — the other member ADR-593 had to classify "by structural family, unpinned" — is now
**pinned Tier A** by row O28 (`fatal: multi-pack-index large offset out of bounds`). The union is
therefore fully pinned member-by-member, with no classification resting on analogy.

### §D2 — discovery, precedence and the chain: `src/application/primitives/internal/midx-source.ts`

A new internal primitive, ~150 lines, whose whole job is Pin J and Pin I. `pack-registry.ts` is
already 548 lines with two skip layers; this is a separable, separately-testable concern (ADR-598).

```ts
/** An ordered, fully-loaded midx set: one layer for a flat file, N for a chain (base first). */
export interface MidxSet {
  readonly layers: ReadonlyArray<MultiPackIndex>;
  readonly kind: 'flat' | 'chain';
}
/** One discarded midx artefact and why — the payload of the single per-generation warn. */
export interface MidxFault {
  readonly artefact: string;              // 'multi-pack-index' | 'multi-pack-index-<hex>.midx' | the chain file
  readonly data: TsgitErrorData;
}
export interface MidxLoadResult {
  readonly set: MidxSet | undefined;      // undefined ⇒ fall back to the .idx scan
  readonly faults: ReadonlyArray<MidxFault>;
}
export async function loadMidxSet(ctx: Context, packsDir: string): Promise<MidxLoadResult>;
```

Algorithm — `packsDir` is the directory `scanPacks` already established exists, so a midx cannot
be reached when `objects/pack/` is absent (the registry's existing early return still fires first):

1. **Flat.** `objects/pack/multi-pack-index`. If it exists, read bounded (ADR-600) and parse.
   Success → `{ layers: [midx], kind: 'flat' }`, **return** — the chain is not touched (J2/J3/J4).
   A Tier-B fault → record and fall through to the chain (J5/P17). A Tier-A fault → **propagates
   out of `loadMidxSet` unchanged** (J6/P18): the chain is not tried, no fault is recorded, and the
   scan memo's promise rejects (§D4.2).
2. **Chain.** `objects/pack/multi-pack-index.d/multi-pack-index-chain`. Absent, empty, or
   unreadable → `set: undefined`, silently (I5/I6). Split on `\n`; take the leading run of
   lines that are exactly `2 × digestLength` lowercase hex, stopping at the first that is not
   (I10). Cap the run at `MAX_MIDX_CHAIN_LAYERS` (ADR-600).
3. For each digest, read + parse `multi-pack-index-<digest>.midx`. **Any** missing or Tier-B-faulty
   layer discards the whole set (I2/I4/I8, P2–P8), with one warn. A **Tier-A** layer propagates,
   base layer included (I3, P9/P10/P11) — tier classification is per layer, chain-dropping is not.
4. `{ layers, kind: 'chain' }`.

Layer digest → filename is the only place a chain line becomes a path; the hex-only shape check in
step 2 is therefore also the path-safety check (T-2). Deliberately *not* verified **on this path**:
that a layer's trailer equals the digest in its name, or the trailer at all — git does not check it
on read (G8), and checking would cost a hash over the whole file on every open. ADR-602 moves that
check to fsck, where P12/P13 pin its scope to the **head** artefact only (§D12.4).

Chain lookup walks `layers` **newest-first** and returns the first hit. Git's writer de-duplicates
across layers (Pin C), so at most one layer can hit for a git-written chain and the direction is
unobservable there; newest-first is chosen because a hand-written or future compacting writer that
*did* duplicate would mean the later layer to be the current record, matching the pseudo-pack
ordering rule the spec states for bitmaps. The choice is recorded here rather than left implicit.

`pack-int-id` is **layer-local** (Pin C), so a chain hit is `(layerIndex, packIndex, offset)` and
resolves through that layer's own `packNames`.

### §D3 — registry integration

`PackGeneration` grows one field, and it is produced by the **same** `scanPacks` memo
(requirement 14):

```ts
interface PackGeneration {
  readonly packs: ReadonlyArray<RegisteredPack>;
  readonly indexFaults: ReadonlyArray<{ name: string; data: TsgitErrorData }>;
  readonly midx: LoadedMidx | undefined;   // NEW
}
```

where `LoadedMidx` binds each `MidxSet` layer's `packNames` to the `RegisteredPack` objects the
same scan produced:

```ts
interface LoadedMidx {
  readonly set: MidxSet;
  /** layerIndex → packIndex → the registered pack, or undefined when PNAM names nothing on disk. */
  readonly packsByLayer: ReadonlyArray<ReadonlyArray<RegisteredPack | undefined>>;
  /** Names the midx claims — ADR-592's subtraction set. */
  readonly claimedNames: ReadonlySet<string>;
}
```

The binding runs over the **`readdir` listing the scan already holds**, at zero extra I/O, exactly
as ADR-579's sibling-`.pack` rule does. A `PNAM` entry that (a) fails `isSafePackName`, or (b)
names no `.idx` the scan registered, binds to `undefined` and its name is **not** added to
`claimedNames` — which is precisely Pin H7's rule: an unresolvable `PNAM` entry drops out of the
midx's universe and the real pack of that name, if any, is scanned normally.

`lookup(id)` becomes, in order:

1. `const { packs, midx } = await currentGeneration()`.
2. If `midx !== undefined`: `midxLookup(midx, id)`.
   - **hit** → resolve to a `RegisteredPack`. `undefined` binding → fall to step 3 (Pin H7).
     Bound → run the existing `probeHeader` gate (ADR-572/577 unchanged); pass → return
     `{ pack, offset }`; fault → **return `undefined`** (ADR-592). This single branch *is* Pin
     H2–H4.
   - **miss** → step 3, restricted below.
3. The existing loop over `packs`, **skipping any pack whose name is in `claimedNames`**
   (ADR-592). A pack the midx does not name is served exactly as today.

`all()`, `health()` and `indexFaults()` keep their current shapes and their current membership. In
particular **`all()` is not filtered by `claimedNames`** — it stays the "packs present on disk"
view, which is git's *enumeration* universe (Pin K), keeping `enumerateObjects` and
`resolveOidPrefix` faithful on the axis Pin K says they are faithful on, and keeping ADR-572's
gated-lookup/ungated-`all()` boundary exactly where it is.

**A midx fault is still not a `PackHealth` entry**, even though ADR-601 now reports it.
`UnusablePack` is per-*pack* and its `layer` is `'pack' | 'index'`; a discarded midx is neither,
and widening that union would make every existing consumer of `health()` — including the bit-4 /
bit-64 arms of `runPackHealthPass` — silently start reporting midx faults as pack faults. ADR-601
gets its **own** accessor, `midxHealth()`, and its **own** finding variants and exit bit (§D12).
The two accessors are siblings over the same generation, not one widened.

**`all()` is not narrowed by the midx either**, and the fsck matrix confirms it is right not to be:
row O23's stdout still carries `dangling commit` for objects in the surviving packs and `missing
blob` for the hidden one, which is the ordinary connectivity outcome over the **`.idx`** universe.
So there is no `accessiblePacksOnly` analogue for the midx (contrast ADR-585, where git's fsck walk
*is* pack-accessibility-gated): fsck's universe is unchanged by this change, and the midx's effect
on it arrives only through root seeding, exactly as Pin M's rules describe for packs.

The midx-derived offset is fed to the **unchanged** downstream: `resolvePackChain` →
`pack.offsetTable()` → `nextOffsetForEntry` → `pack.readSlice`. The offset is a pack offset in
both worlds, so nothing below `lookup` is aware a midx exists. That is the property that keeps the
blast radius one function wide.

Three edges this ordering settles, each matching a pinned git row:

- **A `PNAM` entry naming a pack the scan excluded** — an orphaned `.idx` (ADR-579) or one that
  failed to parse (ADR-575) — binds to `undefined`, falls to step 3, and finds nothing there
  either, because that pack is not in `packs`. Result: missing. That is Pin H3 exactly.
- **A claimed pack holding an oid the midx does not list.** Impossible in a git-written midx (it
  records every object of every pack it names) but reachable by mutation. Step 3 skips the claimed
  pack, so the oid is missing — which is git's answer, since a claimed pack is reached only through
  the midx.
- **A pack written after the midx** is in `packs` and not in `claimedNames`, so step 3 serves it.
  Pin H8 / L4, and the property `materializePack` depends on (§D8 W-2).

### §D4 — degradation posture: git's two tiers, replicated (ADR-593)

ADR-593 ratified **against** the draft's recommendation of uniform Tier B. Faithfulness wins:
tsgit denies where git denies. This section is the whole mechanism, because "it throws" is the
easy half and the four questions after it are the design.

#### §D4.1 — the tier map, now fully pinned

**One total function from the closed `MidxCheck` union (§D1) to a tier**, living in
`midx-source.ts`. No message is ever re-parsed and no arm is a `catch {}`.

| tier | `MidxCheck` members / codes | git's pinned rows |
|---|---|---|
| **B** — warn, discard the midx, serve from `.idx` | `size` · `chunk-table` · `chunk-length` · `hash-version` | G5, G6, G7, G14, G15 · O7, O8, O9, O16, O17 |
| **B** — I/O, not a parse | `FILE_NOT_FOUND` / `PERMISSION_DENIED` on the midx or a layer | G16, I2 · O18, P2–P4 |
| **A** — throw; git `die()`s | `signature` · `version` · `required-chunk` · `fanout` · `pack-names` · `pack-int-id` · `large-offset` | G1, G2, G3, G9, G10, G11, G12, G13 · O3–O5, O11–O15, **O28**, P9–P11 |

Two changes from the draft's table, both evidence-driven and both **narrowing** the amount of this
design that rests on analogy to zero:

- **`large-offset` is no longer "Tier A by family, unpinned".** Row O28 constructs the shape the
  draft believed impossible to construct — a valid midx rebuilt with an 8-byte `LOFF` chunk and object 0's
  `OOFF` word set to `0x80000000 | 5` against a `largeOffsetCount` of 1 — and git answers
  `fatal: multi-pack-index large offset out of bounds`. Tier A, pinned.
- **`base-files` is no longer a member at all** — §D4.4.

A fault outside every arm (an `EMFILE` mapped to `UNSUPPORTED_OPERATION`, a programming error)
propagates unchanged, exactly as `isUnsupportedOperation` guarantees today — which under ADR-593 is
no longer a special case but the *same* behaviour as Tier A, reached by a different route.

The trailer checksum is **not** verified on this path (Pin G8, ADR-602); §D12.4 verifies it in fsck.

#### §D4.2 — the Tier-A error shape, and how it crosses a registry made of allow-lists

**The shape is the parser's own error, unwrapped:**
`TsgitError { code: 'INVALID_MULTI_PACK_INDEX', check: MidxCheck, reason: string }`. No new code,
no wrapper, no `cause` chain. Three reasons, in order of weight:

1. **`check` is the tier**, and it is already on the error. Wrapping would either drop the
   discriminant or duplicate it, and a duplicated discriminant is a re-tiering bug waiting for a
   parser change (ADR-599's whole argument).
2. **A wrapper would need its own code**, which would then need adding to the fsck pass's own
   discrimination — two closed unions to keep in step instead of one.
3. The consumer that must classify it — `runMidxHealthPass` (§D12) — is the *only* consumer that
   classifies it, and it wants `check`.

**Crossing the registry is a property of the code, not of a `try` block.** The registry's
discriminators are allow-lists over `TsgitError.data.code`:

| allow-list | site | members | admits `INVALID_MULTI_PACK_INDEX`? |
|---|---|---|---|
| `isSkippableIdxFault` | scan layer, per `.idx` candidate | `INVALID_PACK_INDEX`, `FILE_NOT_FOUND`, `PERMISSION_DENIED` | **no** — ADR-599 chose a distinct code precisely so it cannot |
| header-gate allow-list | `lookup`'s `probeHeader` | `INVALID_PACK_HEADER`, `FILE_NOT_FOUND`, `PERMISSION_DENIED` | **no** |
| `isTierBMidxFault` (new) | `midx-source.ts` | `INVALID_MULTI_PACK_INDEX` **with `tierOf(check) === 'B'`**, plus the two I/O codes | **only Tier B** |

So the Tier-A fault escapes **by construction**: there is no arm that catches it. The one new
discriminator is written as a *positive* test for Tier B and everything else rethrows —

```ts
try { return parseMultiPackIndex(bytes, digestLength); }
catch (err) { if (!isTierBMidxFault(err)) throw err; record(err); return undefined; }
```

— never `if (isTierA(err)) throw err`, which would silently swallow a future member the tier map
forgot. `tierOf` is exhaustive over the closed union, so adding a `MidxCheck` member without
classifying it is a **type error**, not a runtime surprise.

Two structural preconditions make this true rather than merely intended, and both are testable:

- **The midx load sits outside the per-candidate `.idx` `try`/`catch` in `scanPacks`.** It is a
  separate step in the same memo body, so `isSkippableIdxFault` never sees it. A midx load placed
  *inside* that loop would be swallowed into "skip one pack" — the exact hazard ADR-599 named.
- **Requirement 7's audit row**: a unit test asserts `isSkippableIdxFault` and the header-gate
  allow-list both return `false` for an `INVALID_MULTI_PACK_INDEX` error at **every** `MidxCheck`
  value. Inspection does not survive refactors; the row does.

#### §D4.3 — "die once per process", for a library with no process

git's Tier A is `die()`: the process aborts, and a second read cannot happen. tsgit is a library —
there is nothing to abort — so the faithful analogue must be chosen deliberately, and it collides
head-on with PR #263's rule that **a rejection is never memoised**.

The reconciliation, stated as the rule and then argued:

> **Every lookup re-attempts the scan and re-throws.** The scan memo's promise rejects; per #263
> the memo clears its slot on rejection; the next `lookup` re-runs `scanPacks`, re-reads the midx,
> re-parses it and throws the same error again. There is no memoised rejection and no negative
> cache.

Why this is right, and not merely rule-compliant:

- **The observable matches.** git's property is *"while the on-disk state is bad, every read
  fails"*. Re-attempting delivers exactly that, deterministically, with the identical error each
  time. Memoising the rejection would deliver the same observable **only** until someone called
  `refresh()`, and would then have to answer "what invalidates a poisoned memo?" — a question git
  never has to answer because its process is gone.
- **It preserves the recovery property in the right direction.** If the operator repairs or deletes
  the midx, the very next read succeeds without `refresh()` and without a new `Context`. Under a
  memoised rejection the `Context` would stay poisoned across a *fixed* repository. git's process
  has the same property trivially (the next process re-reads), so re-attempting is the closer
  analogue, not the looser one.
- **It is the same rule the read path already lives by.** The pack-accessibility design states it
  for the header probe: "the per-pack header memo still clears on rejection, so the READ path's
  no-negative-cache property is untouched — `lookup` re-probes per hit". A poisoned midx memo would
  be the first negative cache in the registry.

**The cost, bounded honestly.** Each failed read costs one `readdir`, one `stat` and one bounded
`read` of the midx, then throws. It does **not** cost the `.idx` loads — ADR-597 made those lazy,
and the throw happens before any of them, so the re-attempt is strictly cheaper than the scan this
design replaces. There is no internal retry loop: the error reaches the caller on the first
attempt, so "repeated" means *"the caller chose to call again after being told the store is
broken"*. A caller iterating a thousand objects over a Tier-A repo pays a thousand small reads and
gets a thousand identical errors; git's equivalent caller got one error and a dead process. The
divergence is in *throughput while failing*, which is not observable state, and it is named in
§D11.9 rather than hidden.

#### §D4.4 — the reversal ADR-593 did not have the evidence for: `numBaseFiles`

ADR-593's Consequences say: *"The […] rows (`base-files`, `large-offset` — shapes git never
writes) are classified with their structural family (Tier A) as the design proposed."* The premise
was that neither shape could be pinned. **The fsck matrix pinned both, and they went opposite ways:**

| member | draft + ADR-593 | pinned | rows |
|---|---|---|---|
| `large-offset` | Tier A by family | **Tier A** — confirmed | O28 |
| `base-files` | Tier A by family (parse step 2 refused non-zero) | **not a fault at all** — git ignores the byte | O20, O21, P21, P22, P23 |

Five rows, both forms, values 1 and 2, base layer and head: `git fsck` exit 0, `multi-pack-index
verify` exit 0, no message, and — the decisive one — **O21**, where a midx with `numBaseFiles = 1`
whose named pack has been deleted still produces byte-identical output to O23, proving the midx was
not merely tolerated but **loaded, used and authoritative**.

**Ruling: accept and ignore.** Refusing it would be a tsgit-invented gate on a byte canonical git
does not read — a divergence in refusal conditions, which is the precise thing ADR-226 forbids and
the precise principle ADR-593 was ratified to uphold. Classifying it Tier A would be *worse* than
the draft's own recommendation, since it would deny every read in a repository git reads fine.
So this correction **serves** ADR-593's ratio while contradicting one sentence of its Consequences;
it is called out here, in §D11.5 and in the DC table so the ADR can be amended rather than
silently outvoted by a design doc.

#### §D4.5 — Tier A must deny **loose** reads too, and today's read order does not

Pin G1's "reads" column is explicit — *all fail, **loose included*** — and ADR-593's Consequences
repeat it: *"Tier A propagates as a thrown `TsgitError` that fails the read (loose objects
included)"*. tsgit's read path does not do that for free:

```
resolveObjectBytes → empty-tree short-circuit → deltaCache hit → tryLoose(ctx, id) → registry.lookup(id)
```

`tryLoose` answers **before** the registry is ever consulted, so a loose object in a Tier-A-midx
repository would be served — a divergence, and one that hides exactly where a corrupt store is most
dangerous.

**Design: one gate, at the top of `resolveObjectBytes`.**

```ts
await registry.assertLoadable();   // awaits the scan generation, discards it
```

`assertLoadable()` is `currentGeneration()` awaited for its rejection and nothing else — it returns
`void`, so it cannot become a second way to reach the packs and it adds no coupling. Placement is
**before** the empty-tree short-circuit and before the `deltaCache` probe, because git dies during
object-store setup, ahead of any of those.

Cost, and why it is affordable **only because ADR-597 landed**:

- **First read in a `Context`:** forces the scan. Post-ADR-597 that is a `readdir` plus, if a midx
  exists, one bounded file read — the `.idx` files are no longer loaded eagerly. Before ADR-597
  this gate would have forced *P whole-file `.idx` reads* onto every loose-only read path, which
  would have been indefensible. The two ratifications are load-bearing for each other and that is
  worth stating rather than discovering.
- **Repository with no `objects/pack/` at all:** `scanPacks`'s existing early return fires; the
  cost is one failed `readdir`, once per `Context`.
- **Every subsequent read:** awaiting an already-settled promise — one microtask, no I/O, on a
  function that already awaits `tryLoose`. The P = 1 and loose-only bench rows in §D7 exist to hold
  this claim to account rather than assert it.

Two surfaces need **no** gate because they already reach the generation and therefore already
reject: `enumerateObjects` and `resolveOidPrefix` (both `await registry.all()`), and `fsck` through
the first of them — which is exactly what produces requirement 19b's *reject-with-no-result*.

### §D5 — cache and invalidation

- The midx load lives **inside** `scanPacks`, so it is covered by the existing `scan`
  `createPromiseMemo`: single-flight, rejection never memoised, `refresh()` clears it together
  with the packs, `dispose()` terminal (PR #263's §9 invariant, unchanged). Under ADR-593 that memo
  can now **reject**, which is new — §D4.3 is the reconciliation, and the invariant it relies on is
  #263's, taken verbatim rather than relaxed: a Tier-A generation is never cached, so nothing has
  to invalidate it.
- **`midxHealth()` is memoised per generation** and is the one accessor whose memo is *not* cleared
  on a fault, because its whole content **is** the fault set (§D12.2). It follows ADR-581's
  precedent exactly: one consistent verdict per generation, reset by `refresh()` with the scan.
- `refreshPackRegistry(ctx)` (`read-object.ts:41`) already runs after `fetchPack` writes a pack.
  It now also re-reads the midx — necessary, because a fetch that lands a pack **and** a midx (a
  server-side `git maintenance` is not involved, but a concurrent local `git multi-pack-index
  write` is possible) must not leave a stale set. Cost: one extra `exists` + at most one file read
  per refresh.
- **Per-`Context` caches are invalidated only by tsgit's own writes.** An interop test that has
  real `git` write or mutate a midx **must construct a fresh `Context` after those writes** — a
  `Context` built before the `git` subprocess ran holds a memoised generation that predates it.
  This is a recurring trap in this repo and it is a hard rule for §Test strategy, not a note.
- No `FileHandle`: the midx is read whole through `ctx.fs.read`, so the #263 lifecycle matrix is
  unaffected and `dispose()` has nothing new to close (requirement 13).

### §D6 — error semantics

| condition | today | after | git |
|---|---|---|---|
| object in a pack, no midx | `PackLookupHit` | unchanged | — |
| object in a midx-named, healthy pack | `PackLookupHit` (found by the `.idx` loop) | `PackLookupHit` (found by the midx), **same offset, same bytes** | L2 |
| object assigned by the midx to an unusable pack, present in another midx-named pack | `PackLookupHit` from the other pack | **`undefined` → `OBJECT_NOT_FOUND`** (ADR-592) | H2–H4 |
| unresolvable `PNAM` entry | n/a | falls through to the `.idx` loop; one `warn`; **`fsck` still reports it** (§D12.3) | H7, O22 |
| Tier-B midx fault | n/a (midx ignored) | midx discarded, one `warn`, reads unchanged; **`fsck` reports it + bit 32** | G5–G7, O7–O9 |
| **Tier-A midx fault, any read** | n/a (midx ignored) | **throws `INVALID_MULTI_PACK_INDEX { check, reason }`** — the read fails | G1–G3, G9–G13 |
| Tier-A midx fault, a **loose** object | n/a (loose served) | **throws** — the §D4.5 gate fires before `tryLoose` | G1's "loose included" |
| Tier-A midx fault, second and later reads | n/a | **throws again**, same error; scan re-attempted, never memoised (§D4.3) | git: process already dead |
| Tier-A midx fault, `enumerateObjects` / `resolveOidPrefix` / `fsck` | n/a | **rejects** — `registry.all()` awaits the same generation | O3, batch enumeration dies |
| Tier-A reached only at offset-decode time (`large-offset`) | n/a | read throws; **`fsck` reports it as a finding + bit 32**, not a reject (§D12.1) | O28 |
| `numBaseFiles` non-zero | n/a | **accepted, ignored** — no fault, no finding (§D4.4) | O20, O21, P21–P23 |

`OBJECT_NOT_FOUND` is the existing code (`object-resolver.ts:76`) and needs no widening: the
missing-object refusal git produces in Pin H2 is the ordinary one (`fatal: Not a valid object
name`), not a store-corruption error. `INVALID_MULTI_PACK_INDEX` is deliberately *not* mapped onto
it — a Tier-A store is not "this object is absent", and collapsing the two would make the denial
indistinguishable from an ordinary miss at every call site.

### §D7 — performance

The claim and how it is measured, not asserted:

- **Lookup.** P fanout-narrowed binary searches → 1. For a hit, `compareShaAtIndex` runs
  `O(log n_p)` times per pack today; the midx makes it `O(log N)` once. The win scales with P and
  is zero at P = 1.
- **Scan.** Under ADR-597, `readBoundedIdx` moves from *P whole-file reads, eagerly* to *1 midx
  read + 1 `.idx` read per pack actually touched*. For a lookup-heavy workload over a repo with
  many packs where reads concentrate in a few, this is the dominant term.
- **The §D4.5 loose gate, priced separately.** ADR-593 puts `await registry.assertLoadable()` ahead
  of `tryLoose` on every read. It is one microtask after the first read in a `Context`, but it
  makes the scan **unconditional** where it used to be lazy — so a loose-only workload that never
  touched a pack now pays one `readdir` (plus one bounded midx read where a midx exists) per
  `Context`. That is a real, if small, new cost and it gets its **own** bench row rather than
  hiding inside the many-pack win.
- **`fsck`, priced separately too.** ADR-601's pass costs one full-file hash of a **single**
  artefact (§D12.4) plus one pack-resolution walk over the midx's oid list, once per `fsck` run,
  ungated by mode. On the `BASE` fixture that is 1.5 KB hashed; it scales linearly with the midx,
  which is bounded by ADR-600. It is not on the read path and not in the read bench.
- **Bench.** A new `test/bench/midx-lookup.bench.ts` over a generated many-pack fixture
  (`tooling/gen-bench-fixture.ts` extended), comparing the same repository with and without a
  midx. Published numbers must come from the **CI nightly `bench.yml` artefact**, never a local
  run — local measurement under session load has been shown to bias syscall-heavy paths by up to
  2.4×.
- **Regression guard.** The midx path must not slow the P = 1 case. Worst case for a repo with no
  midx at all is **two extra `exists` calls per `Context`** (flat file, then chain file); with a
  flat midx it is one `exists` + one `stat` + one whole-file `read`. All of it is amortised over
  the session by the scan memo, and the P = 1 bench row exists to prove the amortisation is real
  rather than assumed. **Three bench rows, not one**: P = 1 with no midx, P = 1 loose-only (the
  §D4.5 gate in isolation), and the many-pack win.

### §D8 — write-path symmetry (explicit checklist)

This change is read-only. The checklist exists because "read-only" is where write-side hazards
hide.

| # | write surface | interaction with a midx | verdict |
|---|---|---|---|
| W-1 | `serializePackfile` / `serializePackIndex` (`pack-writer.ts`) | produces `pack-*.pack` / `.idx` | untouched; no midx is written or updated |
| W-2 | `materializePack` (`fetch-pack.ts:158-175`) — writes a fetched pack into `objects/pack/` | the new pack is **not** in any existing midx | **safe, pinned**: Pin H8 / L4 — git unions packs the midx does not name. tsgit must do the same, which ADR-592's `claimedNames` filter does by construction (a pack not in `claimedNames` is not skipped) |
| W-3 | `buildPack` (`build-pack.ts:38`) — push / `bundle create` | sources every object through `readObject` | fails closed with `OBJECT_NOT_FOUND` if a stale midx hides an object; a short pack is structurally impossible |
| W-4 | any future `gc` / `repack` / `prune` | **deletes packs** | the brief's constraint, and it now cuts both ways: (i) deleting a pack a midx names makes real git report those objects missing (Pin H2) even though tsgit could still serve them — so a tsgit repack **must** delete or rewrite the midx; (ii) under ADR-592, tsgit itself now reports them missing too, **and** under ADR-601 its own `fsck` reports the pack-resolution failure with bit 32 (row O23) — which turns a silent cross-tool hazard into a loud, locally-diagnosable one. Parking-lot constraint, restated in §Out of scope |
| W-5 | `tooling/audit-write-surfaces.ts` | scans for annotated write surfaces | no new write surface, so no new `@writes` annotation and no allowlist entry; the gate must stay green untouched |

### §D9 — hash-width genericity (explicit checklist)

| # | site | rule |
|---|---|---|
| H-1 | `parseMultiPackIndex` | takes `digestLength`; never reads `ctx.hashConfig`; never hard-codes 20 or 32 |
| H-2 | `hashVersion` byte | mapped `1 → 20`, `2 → 32` via a named constant map; a value outside `{1,2}` is a refusal, a *width mismatch with the argument* is a **Tier B** condition (Pin G5) resolved in `midx-source.ts` |
| H-3 | `MIDX_HEADER_SIZE = 12` | hash-independent: the header carries no digest (Pin B) |
| H-4 | chain filename / chain line | `2 × digestLength` hex, not `40` |
| H-5 | trailer | `digestLength` bytes. **Not read on the read path** (ADR-602); read by the fsck pass, which selects the digest algorithm from the `hashVersion` byte (`1 → sha1`, `2 → sha256`) via `ctx.hashService`, never from a hard-coded name (§D12.4) |
| H-6 | the surrounding subsystem | `IDX_SHA_LENGTH = 20` in `pack-index.ts` / `pack-writer.ts` is a **pre-existing** SHA-1-only limit (B-7). This change neither widens nor relies on it: the midx parser is generic, the fixtures are SHA-1 because the rest of the pack subsystem is, and a SHA-256 midx fixture is a parser-unit row only |

### §D10 — threat model

The subject is a parser over bytes an attacker with **repository write access** fully controls —
the midx is not a network artefact today (no transport delivers one), which bounds but does not
remove the exposure: a hostile `.git` directory arrives via a cloned tarball, a shared checkout, a
CI cache restore, or a malicious dependency's vendored fixture.

| # | concern | assessment |
|---|---|---|
| T-1 | **`PNAM` is a path-construction primitive** | The highest-severity item here. A `PNAM` entry is an arbitrary NUL-terminated byte string; naively doing `` `${packsDir}/${name}` `` with `name = '../../../../../../etc/passwd'` is a traversal. **Mitigation**: `PNAM` entries never construct a path. They are matched **by exact string equality** against the `readdir` listing the scan already holds, and only a match yields a `RegisteredPack` whose `packPath` was derived by the existing, already-audited `packBaseName` rule. An entry failing `isSafePackName` or matching nothing binds to `undefined` (Pin H7's behaviour, reached without touching the filesystem). This is a *stronger* guarantee than validation-then-concatenation and it costs nothing, because the listing is in hand. |
| T-2 | **Chain lines are path-construction primitives** | Same class, same discipline: a line becomes a filename only after passing `/^[0-9a-f]{2·digestLength}$/`. That regex admits no `/`, `\`, `.` or NUL, so the constructed `multi-pack-index-<line>.midx` is confined to the chain directory by construction. The leading-run rule (I10) means a malformed line ends the chain rather than being skipped, so no line past the first bad one is ever used. |
| T-3 | **Unbounded allocation** | `numPacks` is u32 and `numChunks` is u8, both attacker-set. `PNAM` splitting is bounded by the chunk's own length, which is bounded by the file. The file is bounded by ADR-600's limit, checked `stat`-then-`read`-then-recheck (the `readBoundedIdx` TOCTOU shape). `objectCount` comes from `F[255]` and is cross-checked against `OIDL.length / digestLength` **before** any array is sized by it (parse step 7). Chain layers are capped (ADR-600), so a chain file cannot force N file reads. |
| T-4 | **Out-of-bounds `DataView` reads** | A `RangeError` from `getUint32` is not a `TsgitError`; it would escape every allow-list in the registry and surface as an unclassified crash. Requirement 1 forbids it structurally: parse step 4 proves every chunk's `[start, end)` lies inside `[tableEnd, len − digestLength)` and that offsets strictly increase, **before** any chunk body is read. The `LOFF` row bound and the `packIndex` bound are the two per-lookup checks that keep this true after parse. |
| T-5 | **A stale midx is a denial vector — accepted** (ADR-592) | An attacker who flips one byte of `PNAM`, or simply deletes a pack, makes a set of objects unreadable that the store still contains. This is **git's own property** (Pin H2–H4), so adopting it adds no exposure relative to canonical git; it does remove availability relative to *tsgit today*. Ratified deliberately: the alternative was a permanent divergence on the hot path. The mitigation is diagnostic, not preventive, and it now exists — ADR-601's `fsck` reports the exact position and the exact oids (rows O22/O23), so the condition is discoverable instead of silent. |
| T-6 | **Tier A is a total denial vector — accepted** (ADR-593) | One byte in the midx signature makes **every** read fail, loose objects included (§D4.5), a strictly larger blast radius than ADR-575 permits for any *pack* artefact. git does exactly this (G1). Ratified as git's own property: ADR-575 governs artefacts git degrades per-pack, and a Tier-A midx is not one. Residual exposure is bounded by the same access requirement as every other row here — an attacker who can write `.git/objects/pack/multi-pack-index` can equally delete every pack — so Tier A converts a *silent* availability attack into a *loud* one, which is the better failure. |
| T-10 | **Tier A re-attempt is a work-amplification vector** (new, from §D4.3) | Because a rejection is never memoised, a caller looping over N objects against a Tier-A midx performs N `readdir` + `stat` + bounded-`read` cycles instead of one. It is **not** unbounded — each iteration is caller-driven and each returns an error immediately — and the file is bounded by ADR-600, so the amplification factor is 1 syscall triple per caller-initiated read, not per byte. Accepted as the price of no negative caching; the alternative (memoising the rejection) trades a bounded cost for an unbounded staleness. |
| T-7 | **Log injection via `PNAM` / chain lines** | Names reaching `ctx.logger?.warn?.` are top-level string values, which the Logger port sanitises; control characters are additionally rejected by `isControlChar` inside `isSafePackName`. Chain lines are hex-only before they are logged. Never nest a name inside `err.data` — that routes it around the sanitiser (the existing `faultContext` rule). |
| T-8 | **Symlinked midx / chain artefacts** | The `.idx` scan excludes non-regular entries via `entry.isFile`. The midx is opened by path, not from a listing, so a symlinked `multi-pack-index` pointing outside the repo would be read. `ctx.fs.read`'s node adapter enforces root containment, which bounds the damage to files inside the repo root, but the design should state whether it additionally requires a regular file. **Recommendation: read the chain directory with `readdir` and apply the same `isFile` filter, and `stat` the flat file before reading it** — it costs the `stat` the size bound already needs. |
| T-9 | **A degraded universe feeding a destructive computation** | tsgit has no `gc` / `repack` / `prune`, and `buildPack` fails closed (W-3), so the classic "reachability walk concludes objects are unreferenced and deletes them" hazard is structurally absent — and becomes a hard design constraint on any future pruning surface, which must consult a non-degraded view or refuse. |

### §D11 — blind spots, named

1. **Pin K's three universes.** With a stale midx, git's lookup, enumeration and abbreviation
   disagree, and this design deliberately keeps `all()` on the `.idx` universe (§D3). That is
   faithful for `enumerateObjects` and — by Pin K's `--disambiguate` row — **not** faithful for
   `resolveOidPrefix`, which git answers from the midx's oid list. tsgit would answer from the
   loadable packs, so a prefix belonging to a vanished midx-named pack resolves in git and not in
   tsgit. Narrow, real, and deliberately unclaimed by this change.
2. ~~**`fsck` says nothing about the midx.**~~ **Closed by ADR-601** — §D12 reports every condition
   git reports, with the exit bit and the finding shape pinned by Pins N/O/P. The residual is now
   much narrower and worth naming precisely: tsgit's fsck reproduces `multi-pack-index verify`'s
   **accessibility and integrity** verdicts, not its **object-CRC** half. git's `verify` also
   re-inflates and CRC-checks every object it can reach through the midx; that is the same
   capability boundary ADR-587 drew for packs (Pin N of the pack matrix), and it is drawn again
   here rather than silently widened. §Out of scope names it.
3. **The trailer is never verified on the read path** (ADR-602), so a midx corrupted in its body
   but not in a structurally-detectable way is *used* by reads. git has the identical property
   (G8), and both now report it in `fsck` (O10/P13). A *different* bad answer is possible only if
   the corruption is simultaneously structure-preserving and semantically wrong, in which case git
   returns the same bad answer. One asymmetry is pinned and inherited deliberately: in a chain,
   **only the head's** trailer is verified even at fsck time (P12), so a corrupted base layer is
   silent in both tools.
4. **Chain layer order is unobservable in git-written chains** (Pin C's de-duplication), so
   newest-first vs base-first is untestable against real git. §D2 records the choice and its
   reasoning; a future compacting writer could make it observable.
5. **`numBaseFiles` is always 0** in every layer git 2.55.0 *writes*, and — the part the draft got
   wrong — git does not *read* it either (§D4.4, rows O20/O21/P21–P23). The parser now accepts any
   value and ignores it. The blind spot that remains is the mirror image of the draft's: if a
   future git starts giving the byte meaning, tsgit will **silently mis-read** such a file rather
   than refuse it. That is the correct trade today (refusing diverges from the git that exists;
   ignoring diverges only from a git that does not), but it is a standing bet and 28.3's bitmap
   work should re-check the byte against whatever git it targets.
6. **The two bitmap-only chunks** (`{'B', 'T', 'M', 'P'}`, `{'R', 'I', 'D', 'X'}`) appear when bitmaps are written. They are ignored (the chunk table is
   self-describing), which is correct for reads and becomes load-bearing in 28.3.
7. **Alternates.** git supports a midx in an alternate object directory; tsgit has no alternates
   at all, so the case cannot arise **today** and will need re-deciding if alternates land.
8. **Concurrency with a live `git multi-pack-index write`.** The scan reads the flat file and then
   the chain; a concurrent write could interleave. The consequence is bounded — a torn read is
   *usually* a Tier-B fault and discards the midx — but ADR-593 sharpens the tail: a torn read that
   happens to land on a Tier-A shape now **throws** instead of degrading, so a concurrent
   maintenance run can make a read fail rather than merely slow down. The read is not atomic and
   this design does not make it so; git has the same property and the same tail.
9. **Throughput while failing is not faithful, and is not observable state.** §D4.3's re-attempt
   means a Tier-A repository costs O(reads) syscalls where git costs O(1) — because git's process
   is dead after the first. Every *observable* is identical (same error, every read, until the
   state is fixed); only the work done differs. Named here so it is a known trade rather than a
   review discovery.
10. **The fsck pass is a second reader of the same bytes.** `midxHealth()` re-derives the midx's
    view independently of the read path, which is what lets it report H7/O22 (where reads succeed)
    and O28 (where the load succeeded but a decode dies). The cost is that a corruption which
    affects only one of the two paths is reported by only one of them — deliberately, because that
    is precisely git's parent/child split (Pin N). It does mean "reads work" and "fsck is clean"
    are genuinely independent claims, and the interop rows assert them separately.
11. **The session delta cache can mask a deferred Tier-A midx fault.** A read served from
    `ctx.deltaCache` never touches the registry, so a cache hit answers correctly even when the
    underlying midx has a Tier-A fault only a fresh decode would trip (the `pack-int-id` /
    `large-offset` family, reached only inside a specific entry's resolution — §D12.1's "contained"
    arm): a delta base cached before the store went bad satisfies a later lookup git — decoding
    fresh every time — would `die()` on. `fsck` audits through a cache-bypassing `Context` view for
    exactly this reason; the ordinary read path keeps the cache, so the residual divergence from git
    is bounded to objects already cached in an already-corrupted store. See **Post-implementation
    corrections (d)**.

### §D12 — the `fsck` midx pass (ADR-601, ADR-602)

ADR-601 ratified **against** the draft's recommendation to defer. This section is the arm it
requires. It joins the vocabulary ADRs 581–591 established for pack accessibility rather than
inventing one beside it — every choice below cites the precedent it follows.

#### §D12.1 — the governing principle: git's pass is a **child process**

Pin N is the whole design in one fact. `git fsck` does not verify the midx inline; it runs

```
git multi-pack-index verify --object-dir <dir> --no-progress
```

as a child, and folds a non-zero child exit into bit 32. That boundary is what makes ADR-593 and
ADR-601 compose instead of collide, and tsgit models it exactly:

| where the Tier-A fault is reached | git | tsgit |
|---|---|---|
| the **parent's** own object-store load (signature, version, required chunk, fanout, `PNAM`, `pack-int-id`) | parent `die()`s → **exit 128**, stdout empty, child never runs | `enumerateObjects` at `fsck.ts:35` awaits the same generation → **`fsck` rejects** with the `INVALID_MULTI_PACK_INDEX` fault, no `FsckResult` |
| **inside the pass only** (`large-offset`, row O28) | child `die()`s → parent survives → **bit 32** | `runMidxHealthPass` **contains** the throw and emits a finding + bit 32 |

The reject arm is not an invention: it is **ADR-590's** shape, already shipped for the loose object
git dies on — *"`fsck` rejects with the recovery fault; n/a — no result; exit 128, stdout empty"*.
Reusing it means ADR-593's "Tier A throws" needs no exception carved for `fsck`; the ordering of
the existing passes produces the right answer for free.

The containment arm **is** deliberate and is the one place in this design where a Tier-A fault is
caught. It is narrow and stated as a rule: **`runMidxHealthPass` is the process boundary; nothing
else is.** Inside it, an `INVALID_MULTI_PACK_INDEX` of either tier becomes a finding; outside it,
Tier A propagates per §D4.2. The catch is scoped to the pass body, discriminated on the code (never
`catch {}`), and anything that is not a `TsgitError` still propagates — a `RangeError` from the
parser remains the defect T-4 forbids, not a finding.

**A contained throw ends the walk.** The pass resolves every oid the midx lists — that walk is what
makes O28 reachable at all, and it is the same `fill_midx_entry` loop git's child runs. When it
throws, the pass stops there and returns the findings already collected **plus** the
`midx-unusable` verdict. That is git's own shape (its child prints what it got, then dies) and it
makes the finding set a prefix of the healthy walk's, never a reordering of it.

#### §D12.2 — where it lives, and the accessor it consumes

Two files, mirroring the pack pass exactly (ADR-589 — *"the pack pass lives in `internal/fsck`"*):

```ts
// src/application/commands/internal/fsck/midx-health.ts
export async function runMidxHealthPass(
  ctx: Context,
  opts: FsckOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }>;
```

`fsck.ts` gains three lines — call it, spread its findings, OR its bit — beside the three
`runPackHealthPass` already occupies.

**The signature takes `opts` for symmetry only, and the pass ignores it.** Pin N's mode table is
flat: bit 32 fires identically under default, `--connectivity-only`, `--no-full` and `--strict`.
That is ADR-586's *ungated* shape (bit 64), not ADR-585's gated one (bit 4). Stated explicitly
because a reviewer who has just read `runPackHealthPass` — where `opts` carries two different gates
— will expect a gate here and must be told the pin says otherwise. `core.multiPackIndex` is the
only gate git has (N3), and tsgit has no such config key (§Out of scope), so the pass is
unconditional.

**The state comes from a new registry accessor**, `midxHealth()`, following ADR-581 (*"per-pack
health is a registry accessor"*) and its memoisation rule (*"the verdict is memoised per
generation … both consumers see ONE consistent report"*):

```ts
interface MidxHealth {
  /**
   * The artefact actually **in use** — the flat file, or the chain head.
   * `undefined` means *no usable midx*, which covers both "there is none" and
   * "every candidate was Tier-B-unusable"; `flatFilePresent` separates them.
   */
  readonly artefact: string | undefined;
  /** Tier-B faults the read path discarded (§D4.1) — the `midx-unusable` source. */
  readonly faults: ReadonlyArray<MidxFault>;
  /** Whether a flat `multi-pack-index` file exists — the verdict gate (Pin O rule 2). */
  readonly flatFilePresent: boolean;
  /** Chain-global pack positions whose PNAM entry resolves to no usable pack. */
  readonly unresolvedPacks: ReadonlyArray<{ position: number; pack: string }>;
  /** Oids the midx assigns to a pack that cannot serve them. */
  readonly unresolvedEntries: ReadonlyArray<ObjectId>;
  /** ADR-602's fsck-time check; `undefined` when there is no artefact to hash. */
  readonly checksumOk: boolean | undefined;
}
```

It is a **sibling** of `health()`, not a widening of it — §D3 gives the reason: `UnusablePack.layer`
is `'pack' | 'index'`, and adding a midx member there would make every existing consumer of
`health()` start emitting midx faults as pack faults.

#### §D12.3 — the finding shapes

Four variants, added to `FsckFinding`. The house shape is `{ type, <artefact identifier>, … }` with
a free-text `reason` where git's cause is ours to word (ADR-249) and a structured identifier where
git's is data (ADR-584 — *"the finding carries the pack base name"*).

```ts
| { readonly type: 'midx-unusable';  readonly artefact: string; readonly reason: string }
| { readonly type: 'midx-checksum-mismatch'; readonly artefact: string }
| { readonly type: 'midx-pack-unresolved';   readonly artefact: string;
    readonly position: number; readonly pack: string }
| { readonly type: 'midx-entry-unresolved';  readonly artefact: string; readonly id: ObjectId }
```

| variant | git's line | rows | why it is its own variant |
|---|---|---|---|
| `midx-unusable` | `error: multi-pack-index file exists, but failed to parse` | O7–O9, O16–O18, **O28** | the verdict; carries `reason` because git's cause line is absent in O18 and worded inconsistently elsewhere |
| `midx-checksum-mismatch` | `incorrect checksum` | O10, P13 | ADR-602's check; **no `reason`** — there is exactly one way to fail it |
| `midx-pack-unresolved` | `failed to load pack in position N` | O22, O23, O24, P14, P15, P16 | fires when the PNAM entry resolves to no usable pack |
| `midx-entry-unresolved` | `failed to load pack entry for oid[i] = <oid>` | O22–O25, P14–P16 | **row O25 forbids collapsing this into the previous one** — there, the pack resolves but the entry does not, so the second fires without the first |

Four decisions inside those shapes, each with its pin:

- **`position` is chain-global**, computed `Σ layers[0..k−1].numPacks + packIndex`, because P14
  reports position 1 for the newest layer's only pack while P15 reports 0 for the base layer's.
  Layer-local `pack-int-id` (Pin C) is the *parser's* numbering and must not leak into the finding.
- **`pack` carries the `PNAM` name**, which is `pack-<hex>.idx` — ADR-584's precedent is the pack
  *base* name, so the `.idx` suffix is stripped to match its doc-comment's contract, and the value
  inherits the same `isSafePackName` vetting (T-1). An entry that fails that vetting still produces
  the finding, with the name replaced by its safe-rendered form; it must never reach the logger or
  a path without that vetting.
- **`midx-entry-unresolved` carries the oid, not git's `oid[i]` index.** The index is a position in
  the midx's own `OIDL` ordering, fully reconstructable by the interop test from the artefact it
  already parses, and per ADR-249 an index into a rendered list is presentation. The oid is the
  data. (The same call was made for `pack` in ADR-584.)
- **`artefact` on every variant** is the file the finding is about — `multi-pack-index` or
  `multi-pack-index-<hex>.midx` — because in a chain the head and a base layer are different files
  and P12/P13 make the distinction observable.

**The `midx-unusable` predicate, spelled out**, because it is the subtlest logic in the pass and
every one of its four inputs is pinned:

```
emit midx-unusable  ⟺  artefact === undefined  &&  flatFilePresent
```

| shape | `artefact` | `flatFilePresent` | emit? | row |
|---|---|---|---|---|
| Tier-B flat, no chain | undefined | true | **yes** | O7–O9, O16–O18 |
| Tier-B flat, chain loads | chain head | true | **no** | P17 |
| dropped chain, no flat file | undefined | false | **no** | P2–P8, P20 |
| broken chain, loadable flat | flat file | true | **no** | P19 |
| no midx at all | undefined | false | **no** | O2 |

`flatFilePresent` is a `stat`, not a successful read — which is why O18's `chmod 000` file still
counts as present and still emits, exactly as git's `stat`-then-`error()` does. The one emission
that does **not** come from this predicate is O28's, which arrives from the contained throw
(§D12.1); both produce the same variant, so the finding set stays uniform.

**No finding for a dropped chain.** P2–P8 and P20 exit 0 with no bit, exactly as the orphan-`.idx`
rows (J11/J12) do at the pack layer, and ADR-579/580's warn is already the answer there. §D2's
per-generation `warn` remains the only report. This is the single most important negative in this
section: a chain that git merely *warns* about must not become a tsgit finding, or every
`--incremental` repo mid-maintenance would score bit 32.

#### §D12.4 — trailer verification at fsck time (ADR-602)

Read path: never (§D2, requirement 20). fsck: **once, over exactly one artefact.**

- The digest covers `[0, len − digestLength)` and is compared to the trailing `digestLength` bytes,
  the algorithm selected from the `hashVersion` byte through `ctx.hashService` (§D9 H-5).
- **Scope is the flat file, or the chain head — never a base layer.** P12 (base layer trailer
  flipped → completely silent, `verify` exit 0) against P13 (head flipped → `incorrect checksum`,
  bit 32) pins it. Verifying base layers would be a *stricter*-than-git divergence, and stricter is
  still a divergence.
- It is **not** the `<hex>` filename check either: a chain layer's filename is its own trailer
  digest (Pin A), but git checks neither the correspondence nor the base layer's digest, so tsgit
  checks neither.
- Cost: one full-file hash per `fsck` run, bounded by ADR-600's `MAX_MIDX_BYTES` (§D7).

#### §D12.5 — exit-code semantics

`internal/fsck/exit-codes.ts` gains one constant, in the file's existing pinned-comment convention:

```ts
// bit 32 = multi-pack-index verification failure (git's ERROR_MULTI_PACK_INDEX)
export const EXIT_MULTI_PACK_INDEX = 32;
```

- Set **once** per run regardless of how many findings the pass produced (O22 emits four lines and
  scores 32 once) — the same cardinality rule as bit 4 (J14).
- Composes by plain **OR** with every other bit, proven differentially: O23 is `42 = 2 | 8 | 32`
  and the identical repository with the midx removed (O26) is `10 = 2 | 8`. O25 reaches
  `110 = 2 | 4 | 8 | 32 | 64`, exercising the midx bit alongside **both** pack bits in one row.
- The file's header comment already distinguishes bits pinned against 2.54.0 from those pinned
  against 2.55.0; bit 32 joins the 2.55.0 group and the comment says so rather than widening the
  older claim.

#### §D12.6 — composition with the pack pass, and the ordering that matters

Both passes read the same registry generation and both are independent. Two interactions are worth
fixing in writing:

1. **Row O25 is the composition row** — a midx-named pack whose `.idx` is deleted produces a
   `pack-index-unusable` **and** a `pack-rev-index-unusable` finding from `runPackHealthPass`
   (bits 4 | 64) *and* `midx-entry-unresolved` findings from `runMidxHealthPass` (bit 32), for the
   same pack, in the same run. They are not duplicates: one says "this pack's index is unusable",
   the other says "the midx routed these oids to it anyway". git emits both families too.
2. **Pass order does not affect the result** — findings are concatenated and bits OR'd — but the
   midx pass must run **after** `enumerateObjects` has already succeeded, which it does by sitting
   in `fsck.ts`'s existing sequence. That ordering is what implements §D12.1's reject arm: a
   Tier-A-at-load midx has already rejected the run before the pass is reached.

#### §D12.7 — the pass, row by row, as the implementer will need it

| condition | findings | bit | git row |
|---|---|---|---|
| healthy midx, or no midx | none | 0 | O1, O2, P1 |
| version 2, `numBaseFiles` ≠ 0, `LOFF` row in range | none | 0 | O6, O20, O27, P21–P23 |
| Tier-B flat fault, **no** usable chain | one `midx-unusable` (reason names the check) | 32 | O7–O9, O16–O18 |
| Tier-B flat fault, **chain loads** | **none** — the chain is the usable midx | **0** | P17 |
| dropped chain (missing / unreadable / bogus digest / Tier-B layer), no flat file | **none** — warn only | **0** | P2–P8, P20 |
| broken chain **+ loadable flat midx** | **none** — the chain is never opened | **0** | P19 |
| trailer digest wrong (flat, or chain head) | one `midx-checksum-mismatch` | 32 | O10, P13 |
| trailer digest wrong (chain **base** layer) | **none** | **0** | P12 |
| `PNAM` entry resolves to no usable pack | one `midx-pack-unresolved` + one `midx-entry-unresolved` per affected oid | 32 | O22, P14, P15 |
| midx-named pack deleted / `.pack` gone | as above, plus the ordinary connectivity findings | 32 (\| 2 \| 8) | O23, O24, P16 |
| midx-named pack's `.idx` gone | `midx-entry-unresolved` × N **without** `midx-pack-unresolved`, plus the pack pass's two findings | 32 \| 4 \| 64 (\| 2 \| 8) | O25 |
| `large-offset` row out of range | one `midx-unusable` — the Tier-A throw contained by the pass | 32 | O28 |
| Tier-A fault at load (signature, version, chunk, fanout, `PNAM` order, `pack-int-id`) | **none — `fsck` rejects**, no `FsckResult` | n/a | O3–O5, O11–O15, P9–P11, P18 |

## Decision candidates

All eleven candidates the draft raised are ratified. **Two went against the designer's
recommendation** and this revision folds them through the whole document; the rest were adopted as
recommended.

| DC | Choice | ADR | Ratified outcome |
|---|---|---|---|
| DC-1 | Lookup authority | [592](../adr/592-midx-is-authoritative-for-named-packs.md) | **as recommended** — authoritative (option b). Packs the midx names are served only through it; `all()` keeps the `.idx` universe |
| DC-2 | Degradation posture | [593](../adr/593-midx-corruption-replicates-gits-two-tiers.md) | **AGAINST recommendation** — replicate git's two tiers (option 1), not uniform Tier B. Tier A throws and fails every read, loose included; Tier B warns and discards. Folded through §D4, §D6, requirement 7, T-6 |
| DC-3 | Incremental-chain scope | [594](../adr/594-flat-and-incremental-chain-ship-together.md) | **as recommended** — flat + chain together |
| DC-4 | `LOFF` / large offsets | [595](../adr/595-large-offsets-ship-with-optional-loff-rule.md) | **as recommended** — ship now, with the optional-`LOFF` rule |
| DC-5 | Version accept-set | [596](../adr/596-midx-version-accept-set-1-2-with-v1-name-ordering.md) | **as recommended** — `{1, 2}`, PNAM ordering enforced for v1 only |
| DC-6 | Does the midx defer `.idx` loading? | [597](../adr/597-usable-midx-defers-idx-loading.md) | **as recommended** — lazy `.idx` (option b), with `health()` forcing the loads to keep `indexFaults()` complete |
| DC-7 | Where the code lives | [598](../adr/598-midx-discovery-lives-in-midx-source.md) | **as recommended** — domain parser + `primitives/internal/midx-source.ts` |
| DC-8 | Error shape for a refusal | [599](../adr/599-invalid-multi-pack-index-carries-check-discriminant.md) | **as recommended** — `INVALID_MULTI_PACK_INDEX { reason, check }` with a closed `check` union |
| DC-9 | Size and chain bounds | [600](../adr/600-dedicated-midx-size-and-chain-bounds.md) | **as recommended** — dedicated `MAX_MIDX_BYTES` + `MAX_MIDX_CHAIN_LAYERS` in `validators.ts` |
| DC-10 | Does `fsck` learn about the midx? | [601](../adr/601-fsck-reports-midx-findings.md) | **AGAINST recommendation** — ship fsck midx findings **in this change**, with a dedicated pin matrix. Delivered as Pins N/O/P + §D12 |
| DC-11 | Trailer checksum verification | [602](../adr/602-midx-trailer-unverified-on-read-verified-in-fsck.md) | **as recommended, refined** — never on read; **fsck verifies it**, which is git's own placement |

**One correction this revision carries that no ADR ratified**, because the evidence did not exist
when the ADRs were written: ADR-593's Consequences classify `base-files` as Tier A "by structural
family, [not pinnable]". Pins O20/O21 and P21–P23 pin it — git **ignores** the byte — so §D4.4 rules
*accept and ignore* and drops `base-files` from `MidxCheck` entirely. This serves ADR-593's ratio
(never diverge in refusal conditions) while contradicting one sentence of its Consequences; it is
flagged for amendment rather than absorbed silently. The same matrix **confirms** the other
never-pinned member, `large-offset`, as Tier A (row O28), so no classification now rests on analogy.

### The candidate table as put to the ADR round

Retained verbatim, because each ADR's "Options considered" refers to these letters and because the
two ratifications that went the other way are only legible against the argument they overruled. The
**Recommendation** column is the designer's, **not** the outcome — read the table above for that.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | **Lookup authority** — is the midx an accelerator or the truth? | **(a) Accelerator with `.idx` fallback** (the brief's wording): a midx miss, or a midx hit on an unusable pack, falls through to the existing per-pack loop. **(b) Authoritative** (git, Pin H): packs the midx names are served only through it; a hit on an unusable pack returns `undefined`; only unnamed packs are scanned. **(c) (b) plus an opt-out** `Context` flag mirroring `core.multiPackIndex` | **(b)** | Pin H is unambiguous and it is the prime directive's subject matter: with a stale midx git returns `missing`, and (a) returns the object. (a) is not "safer" — it is a *new permanent divergence* installed on the hot path, and it is the exact divergence the brief asked to close ("stale-midx repo handled as git does"). The price must be stated plainly: **tsgit would begin reporting `OBJECT_NOT_FOUND` for objects it finds today**, in repos where a midx outlived its packs. (c) buys the escape hatch for one config read but adds a surface tsgit has no precedent for (`core.multiPackIndex` is not in `readConfig`'s vocabulary today) and hands users a way to be unfaithful on purpose |
| DC-2 | **Degradation posture for a corrupt midx** | **(a) Replicate both tiers** (Pin G): Tier A throws and fails every read including loose; Tier B warns and discards the midx. **(b) Uniform Tier B**: every midx fault warns and discards; tsgit stays available where git dies. **(c) Uniform hard failure**: any midx fault throws | **(b)** — with the divergence recorded in its own ADR | The only place this design recommends *against* git, and the reason is that ADR-575 already litigated this exact question one layer down and answered it the other way: "a corrupt pack artefact must not deny every object in the repository, loose ones included." Tier A is that denial, triggered by one flipped byte in an accelerator whose whole content is redundant with the `.idx` files sitting beside it — a worse failure mode than the one #263 and #265 were written to remove. Stated honestly rather than cleanly: discarding a Tier-A midx does **not** cost only speed. Under DC-1(b) it also drops that midx's *subtraction*, so a repo with a corrupt-**and**-stale midx becomes as permissive as tsgit is today — git would have died, tsgit would answer, and the answers would differ. That is the price of (b), it is bounded to a doubly-broken repository, and it buys availability everywhere else. (c) is strictly worse than both. Note the asymmetry with DC-1 and why it is not inconsistency: authority is about *which answer is right* and faithfulness wins; Tier A is about *whether to answer at all under corruption*, where the repo has a standing decision |
| DC-3 | **Incremental-chain scope** | **(a) Flat + chain now**, one loader, chain = N layers and flat = 1 (§D2). **(b) Flat now, chain deferred** — a `multi-pack-index.d/` present is ignored, as today. **(c) Chain now, flat via the chain loader with a synthetic 1-layer chain** | **(a)** | The chain is ~40 lines on top of the flat loader (a file read, a hex-line filter, a loop) and shares every parser row. (b) is tempting until DC-1(b) lands: a repo whose *only* midx is a chain would then be served by the `.idx` scan while a flat-midx repo is served by the midx — two lookup semantics in one product, and the divergence appears in exactly the repos big enough to use chains. (c) inverts the precedence rule of Pin J and would have to special-case it back |
| DC-4 | **`LOFF` / large offsets** | **(a) Ship now** — parse `LOFF`, honour the optional-chunk rule (Pin F). **(b) Defer, refusing**: any `OOFF` word with bit 31 set is a Tier-B fault and the midx is discarded. **(c) Defer, ignoring**: mask bit 31 and read `LOFF` never | **(a)** | It is the ~12 lines already sketched in §D1, it mirrors `readOffset` that ships today, and Pin F pins it empirically without a 2 GiB pack. (c) is a silent-corruption bug — F2 shows the two readings differ. (b) is defensible but means every repository with a >2 GiB pack silently loses the whole feature, which is the repository class the feature exists for |
| DC-5 | **midx version accept-set** | **(a) `{1, 2}`, PNAM ordering enforced for v1 only** (git exactly, Pin D7/D8). **(b) `{1, 2}`, ordering never enforced.** **(c) `{1}` only** | **(a)** | (a) is git. (b) accepts a v1 file git refuses — a divergence with no upside, and the check is one comparison in a loop already running. (c) refuses files git writes when `midx.version=2` is set, and the packfile-format manual page shipped in this very build already claims 2 is the write default — so (c) is a bet against the direction upstream is documented to be moving |
| DC-6 | **Does the midx defer `.idx` loading?** | **(a) Additive only** — keep the eager scan; the midx short-circuits `lookup`'s pack loop. **(b) Lazy `.idx`** — when a usable midx covers the directory, a pack's `.idx` is read only when that pack is touched. **(c) Fully midx-backed** — also serve `all()` / `resolveOidPrefix` / `enumerateObjects` from `OIDL` | **(b)** | The dominant cost is *P whole-file reads at scan time*, not the P binary searches (§Context). (a) leaves it entirely on the table and ships a change whose bench win is small and whose risk is the same. (b) is contained: `RegisteredPack.index` becomes a `createPromiseMemo` — the pattern the file already uses four times — and every existing consumer of `.index` is an `await` away. (c) has to pick a universe where Pin K shows git itself has three, and it changes `all()`'s contract, which ADR-572 deliberately fixed; it belongs in its own brief. **Caveat to weigh**: under (b) the eager scan's `.idx`-fault classification (ADR-575's scan layer) becomes lazy too, so `indexFaults()` would no longer be complete until every pack is touched — `health()` must force the loads, and that must be stated in the ADR |
| DC-7 | **Where the code lives** | **(a) Domain parser + chain/precedence folded into `pack-registry.ts`.** **(b) Domain parser + a new `primitives/internal/midx-source.ts`** owning discovery, precedence and chain assembly; the registry consumes a `MidxLoadResult`. **(c) Everything in `pack-registry.ts`** | **(b)** | `pack-registry.ts` is 548 lines carrying two skip layers, a handle lifecycle and a health memo; Pin J's precedence and Pin I's all-or-nothing chain rule are a separable state machine with ~20 testable rows of their own. `internal/` already holds exactly this class of building block (`promise-memo`, `bounded-map`, `bounded-reader`). (c) puts a domain parser in the application layer, which the dependency rule forbids |
| DC-8 | **Error shape for a midx refusal** | **(a) New `INVALID_MULTI_PACK_INDEX { reason, check }`** with `check` a closed union naming the gate that fired (§D1). **(b) Reuse `INVALID_PACK_INDEX { reason }`.** **(c) New code with `reason` only**, tier classified in the application layer by re-deriving it from the parse site | **(a)** | (b) is an active hazard, not merely imprecise: `isSkippableIdxFault` (`pack-registry.ts:60`) allow-lists `INVALID_PACK_INDEX` at the **scan layer**, so a midx parse failure would be silently classified as a per-pack `.idx` fault and could exclude an innocent pack from the generation. (c) forces §D4's tier table to be keyed on message text or on a duplicated check-order in the caller — the failure mode being that a parser change silently re-tiers a fault. The `check` union makes the mapping exhaustive at the type level and costs one field. Its price, stated: `check` is public surface in `api.json`, so its members are a compatibility commitment |
| DC-9 | **Size and chain bounds** | **(a) Reuse `exceedsMaxPackIdxBytes` (64 MiB, `validators.ts:129`) for the midx; cap the chain at a named constant.** **(b) Size cap only, chain unbounded** (git has no cap). **(c) New dedicated `MAX_MIDX_BYTES` + `MAX_MIDX_CHAIN_LAYERS` beside it in `primitives/validators.ts`**, with `REASON_*` strings following `REASON_PACK_IDX_EXCEEDS_MAX` | **(c)** | The arithmetic decides it: a midx over N objects is `1024 + N·(digestLength + 8) + names` bytes, so 64 MiB caps out around **2.3 M objects** — and a repository smaller than that has little reason to own a midx. Reusing the `.idx` bound would make the feature refuse exactly the repositories it exists for. (b) leaves a chain file of a million hex lines as a free file-descriptor amplifier (T-3). (c) sets both explicitly next to the policy limits that already live there — **not** in `domain/engine-limits.ts`, whose doc-comment scopes it to limits "the JavaScript engine imposes, as opposed to anything this library chooses" |
| DC-10 | **Does `fsck` learn about the midx?** | **(a) No** — the midx contributes no finding; the gap is documented (ADR-572's precedent). **(b) Yes** — extend the fsck pack pass with midx findings mirroring git's `incorrect checksum` / `failed to load pack in position N`. **(c) Only the cheap one**: report an unusable midx, not per-position pack-binding failures | **(a)** | 28.1a (PR #267) has just closed the pack-accessibility reporting gap after a 2 268-line design; a midx-reporting arm needs its own pin matrix (git's midx findings span three exit bits and two commands) and would double this change's surface. (b) also forces DC-11 open, because git's `incorrect checksum` finding *is* the trailer verification this design declines to do on read |
| DC-11 | **Trailer checksum verification** | **(a) Never on read** (git, Pin G8). **(b) Verify on read** — reject a midx whose trailer disagrees. **(c) Verify once per `Context`, behind the `health()` accessor** | **(a)** | Faithful and free. (b) costs a full-file hash on every `Context` that touches a pack — the exact hot path this change exists to speed up — and it *changes answers*: G8's repo reads fine under git and would stop reading the midx under tsgit. (c) is the honest home for it if DC-10 ever flips to (b), and is a no-op until then |

## Test strategy

### Unit — `test/unit/domain/storage/midx.test.ts` (new)

Fixtures are **crafted in-test**, per tier, with the digest length taken from the fixture's own
hash config — ADR-578's precedent, applied to a second format. A small in-test `buildMidx(spec)`
builder emits the Pin B layout; every negative row is that builder plus one named mutation, so the
only thing wrong with a fixture is exactly what the row claims.

Rows, one `describe('Given …') > describe('When …') > it('Then …')` group each:

- **Accept**: v1 and v2; 0 packs / 0 objects; 1 pack; 3 packs; SHA-256 (`hashVersion: 2`,
  32-byte stride) — the one row that exercises H-1's genericity.
- **Header refusals**, each asserting `.data.check` **and** the *reason string*, not just the
  class: short file, signature, version 0 / 3 / 255, `hashVersion` 0 / 3, width disagreeing with
  `digestLength`, `numChunks` 0.
- **`numBaseFiles` acceptance**, its own positive rows rather than a refusal row: values 1, 2 and
  255 all **parse**, and the parsed value is exposed unchanged (requirement 21, §D4.4). A refusal
  row here would re-introduce the divergence Pin O20 disproved, so the rows are written as accepts
  deliberately and the reason is in the test title.
- **Chunk-table refusals**: non-increasing offsets, an offset past `len − digestLength`, an offset
  before the table's end, final entry id non-zero, a required chunk absent (one row per required
  chunk — ADR-575's isolated-guard rule: `PNAM` and `OIDF` and `OIDL` and `OOFF` each get their own
  row, because one test tripping several does not prove each guard alone).
- **Chunk-content refusals**: `OIDF` non-monotonic (at index 0 and at index 255 — two rows, since a
  loop-boundary mutant survives a single-index test), `OIDL` length ≠ `objectCount · digestLength`,
  `OOFF` length ≠ `objectCount · 8`, `PNAM` yielding ≠ `numPacks` names, `PNAM` with an empty name,
  v1 `PNAM` out of order **accepted under v2** (the D7/D8 pair, as two rows sharing one fixture).
  `PNAM` with trailing bytes past the last name is an **accept** row, not a refusal — corrected
  post-implementation, see **Post-implementation corrections (a)**.
- **Lookup**: first / last / middle oid; an oid below `OIDL[0]` and above `OIDL[n-1]`; an oid in a
  fanout bucket that is empty; `packIndex` out of range refuses.
- **Large offsets** (Pin F, both directions): `LOFF` present + bit 31 set → the 64-bit value;
  `LOFF` **absent** + bit 31 set → the literal `0x80000000`; `LOFF` row index ≥ `largeOffsetCount`
  refuses; a `high` word past the safe-integer bound refuses (mirroring `pack-index.ts:103`).
- **Error-data assertions use try/catch + direct `.data` reads** of both `check` and `reason`,
  never bare `toThrow(ErrorClass)` — a StringLiteral mutant on a reason survives a type-only check,
  and a wrong `check` is a silent re-tiering (§D4).
- **Exhaustiveness**: one row per `MidxCheck` member — **eleven**, `base-files` having left the
  union — so the tier table in `midx-source.ts` cannot gain an unreachable arm or lose a reachable
  one without a test moving.

### Property — `test/unit/domain/storage/midx.properties.test.ts` (new)

Lens 1 (round-trip pair) and lens 3 (total function over a grammar) both fit, and the oracle is not
a copy of the SUT: the builder is a *writer*, the parser a *reader*.

- `parseMultiPackIndex(buildMidx(spec), digestLength)` recovers `spec`'s packs, oids and offsets,
  over arbitrary pack counts (0–8), object counts (0–64) and offsets — `numRuns: 200`.
- `lookupMultiPackIndex(parse(build(spec)), oid)` equals `spec`'s mapping for every oid in `spec`
  and `undefined` for arbitrary oids outside it — `numRuns: 100`.
- **Totality**: `parseMultiPackIndex` over arbitrary byte strings up to 4 KiB either returns or
  throws `INVALID_MULTI_PACK_INDEX` — it never throws `RangeError` and never returns a value whose
  chunk offsets lie outside the buffer. This is requirement 1 and T-4 as an executable property,
  and it is the single highest-value test in this file — `numRuns: 200`.
- Generators live in the directory's `arbitraries.ts` (creating it, or extending the one the
  pack-entry properties file introduces).

### Unit — `test/unit/application/primitives/internal/midx-source.test.ts` (new)

Pin J and Pin I as a table over the memory adapter, using `buildSeededContext` (`./fixtures.js`):
flat only · chain only · flat + broken chain (J2/J4: the chain must never be read — asserted by a
`readdir`/`read` call ledger on `ctx.fs`, not by an outcome) · Tier-B flat + chain (J5) · missing
layer · unusable layer · empty chain file · malformed chain line mid-list and at the end (I10) ·
chain over the layer cap · a chain line with `../` or a NUL (T-2, must never reach `ctx.fs`).

### Unit — `test/unit/application/primitives/pack-registry.test.ts` (extend)

- `lookup` served by the midx returns the **same** `{ pack, offset }` the `.idx` loop returns —
  the requirement-8 property at unit scale.
- `PNAM` naming an unregistered pack → falls through to the `.idx` loop (Pin H7), one `warn`.
- `PNAM` failing `isSafePackName` → binds to `undefined`, **no path is constructed** (asserted via
  the `ctx.fs` ledger, T-1).
- ADR-592 rows: midx hit on a pack whose header gate fails → `undefined`, and the sibling pack
  holding the same oid is **not** consulted; a pack absent from `claimedNames` **is** consulted.
- Generation coherence: `refresh()` drops midx and packs together; a `lookup` racing a `refresh`
  never sees one generation's midx against another's packs (shipped as a structural guarantee, not
  an executable race test — see **Post-implementation corrections (e)**).
- `dispose()` handle-count deltas unchanged (requirement 13).

### Unit — the ADR-593 Tier-A rows (new, and the ones most likely to be got wrong)

These carry the two ratifications' sharp edges and none of them is implied by a happy-path test.

- **Allow-list audit (requirement 7).** For **every** `MidxCheck` value, assert
  `isSkippableIdxFault(err)` is `false` and the header-gate discriminator is `false`. Parameterised
  over the union, so a new member cannot be added without appearing here (§D4.2).
- **Tier A escapes the scan.** A Tier-A flat midx beside a perfectly healthy `.idx` → `lookup`
  **rejects** with `INVALID_MULTI_PACK_INDEX`, and the healthy pack is *not* silently dropped from
  a successfully-returned generation — the failure mode that would make a swallowed Tier-A fault
  look like a passing test.
- **Tier B does not escape.** The mirror row: a Tier-B flat midx → `lookup` resolves, one `warn`,
  answers served from the `.idx` scan. One row per Tier-B `MidxCheck` member, isolated (ADR-575's
  isolated-guard rule).
- **Loose reads are denied (§D4.5).** A repo whose object is **loose** and whose midx is Tier-A →
  `readObject` rejects. Its control: the same repo with a Tier-**B** midx → the loose object reads.
  Without both rows the gate can be present and inert, or absent and untested.
- **No memoised rejection (§D4.3).** Call `lookup` three times against a Tier-A midx and assert
  three rejections **and** three `ctx.fs` read attempts on the midx via the call ledger — the
  ledger is what proves re-attempt rather than a replayed memo. Then repair the file *without*
  `refresh()` and assert the fourth call succeeds. That last assertion is the whole argument of
  §D4.3 made executable.
- **Tier A on a chain layer** — base layer and head, separately (P9/P10) — and the negative that
  matters: a Tier-A layer **suppressed by a loadable flat midx** must **not** throw (P19/J4),
  asserted through the `ctx.fs` ledger showing the layer was never read.

### Unit — `test/unit/application/commands/fsck.test.ts` (extend, ADR-601)

Over the memory adapter, one group per §D12.7 row. The rows that carry real risk:

- **The two negatives first**, because they are what a naive implementation gets wrong: a dropped
  chain produces **no finding and exit bit 0** (P2–P8, P20), and a Tier-B flat fault **rescued by a
  loadable chain** produces none either (P17). Both are easy to implement as findings and both
  would be wrong.
- **`midx-entry-unresolved` without `midx-pack-unresolved`** (O25) — the row that justifies two
  variants. Its converse (both present) is O22.
- **Mode is ungated**: every finding-producing row repeated under `connectivityOnly`, `full: false`
  and `strict`, asserting an **identical** bit and finding set (Pin N). This is the direct
  counterpart of the pack pass's gated rows and the contrast is the point.
- **Bit composition**: O25's `2 | 4 | 8 | 32 | 64` in one repo, and the O23/O26 differential pair
  (`42` with the midx, `10` with it removed) asserted as *the same repository twice*, since only
  the difference proves bit 32 is the midx's own.
- **The reject arm** (§D12.1): a Tier-A-at-load midx → `fsck` **rejects**, asserted with try/catch
  on `.data.code` and `.data.check`, and **no** partial `FsckResult`. Its contrast row is O28,
  where the same error class becomes a `midx-unusable` finding + bit 32 — one union, two outcomes,
  decided purely by where the throw happens.
- **Trailer scope** (§D12.4): head-flipped → `midx-checksum-mismatch`; base-layer-flipped → **no
  finding** (P12 vs P13). The second row is the one that stops a well-meaning implementation from
  verifying every layer.

### Integration / interop — `test/integration/midx-interop.test.ts` (new)

The twin pins. Structure follows `pack-version-interop.test.ts`: one seeded repo per shape,
mutated per row, every row asserting **both** git's observable outcome and tsgit's structured
outcome from the identical on-disk state.

- **Rule, non-negotiable**: every row builds its `Context` **after** the last `git` subprocess has
  written, because per-`Context` caches are invalidated only by tsgit's own writes.
- `runGit` / `runGitEnv` from `interop-helpers.ts` — `GIT_*` scrubbed, isolated `HOME`,
  `GIT_CONFIG_NOSYSTEM=1`, signing off. Goldens are computed with signing **off**.
- New shared helpers beside `pack-fixture-helpers.ts`: `writeMultiPackIndex(dir)`,
  `writeMidxChain(dir, layers)`, `mutateMidx(path, op, …)` (re-stamping the trailer), and the
  `LOFF`-crafting rebuild from Pin F.
- **Rows**: the healthy twin (requirement 8 — every object, with and without a midx, byte-for-byte
  and via `git cat-file -p`); Pin G's 17 rows; Pin H's 8 rows on the `DUP` fixture; Pin I's 10 rows;
  Pin J's 6 rows; Pin D's read rows; Pin F's two rows; Pin L5.
- **Tier-A rows assert a refusal on both sides**: git's exit 128 with the object unserved, and
  tsgit's thrown `INVALID_MULTI_PACK_INDEX` with the matching `check`. The `LOOSE` blob is read in
  every Tier-A row — that is §D4.5's cross-tool proof and it cannot be made at unit scale, because
  only real git can confirm the loose read genuinely fails there too.
- Per ADR-249 the git stderr transcripts (`error:` / `warning:` / `fatal:`) are reconstructed in
  the test from tsgit's structured fields and compared to git's — the library emits no such line.
- `@proves` block, following the house annotation: `surface: pack.readMultiPackIndex`,
  `bucket: cross-tool-interop`, `interopSurface: multi-pack-index`.
- **Timeout discipline**: this suite spawns git heavily; use one shared `beforeAll` repo per shape
  and a 60 s timeout, or it will flake under `validate`'s concurrency.

### Integration / interop — `test/integration/midx-fsck-interop.test.ts` (new, ADR-601)

A **separate** file from the read-path twin, following 28.1a's precedent of giving the fsck axis its
own interop suite. It is the executable form of Pins N, O and P.

- **Rows**: all 28 Pin O rows and all 23 Pin P rows, each asserting **both** `git fsck`'s exit
  integer and tsgit's `FsckResult.exitCode`, plus the finding set against §D12.7. The Pin N mode
  table is a fourth axis over the six shapes it names.
- **Assert the exit integer, reconstruct the transcript.** The integer is data the prime directive
  binds; the `error:` / `warning:` / `fatal:` lines and their **cardinality** are presentation (Pin
  O rule 5 — the same cause line appears three times under `fsck` and once under `verify`), so they
  are rebuilt from tsgit's structured findings and compared, never emitted by the library.
- **Two mutation disciplines are mandatory** and both come from a row that lied before it was
  fixed: `chmod -R u+w` before every chain-layer mutation (layers are `0444`), and a mutation
  helper that **throws on a failed write** rather than returning silently. A shared
  `mutateMidxOrThrow` in the helper module, used by both interop suites.
- **The differential pair** (O23 vs O26) runs as one row over one repository, midx removed between
  the two halves, because only the difference isolates bit 32.
- **The `verify` cross-check.** Every row also records `git multi-pack-index verify`'s exit, and the
  suite asserts the Pin N mapping directly: *verify non-zero ⟺ fsck gains bit 32*, whenever the
  parent survives. This is a cheap invariant over the whole matrix and it would catch a future git
  changing the child-process arrangement, which is the one assumption §D12.1 rests on.
- Fresh `Context` after every `git` subprocess — §D5's hard rule, and this suite mutates between
  the two tools constantly.

### Parity — cross-adapter

A midx-bearing fixture added to `tooling/parity-fixtures` so node / memory / browser agree. The
browser adapter has no `openWithNoFollow`, but the midx path uses `ctx.fs.read` only, so the
fallback machinery is not exercised — which is itself the assertion.

### Bench

`test/bench/midx-lookup.bench.ts` over a generated many-pack repository, with and without a midx,
for both a hit-in-the-first-pack and a hit-in-the-last-pack workload. Numbers for the docs come
from the CI nightly artefact.

### Mutation

The parser is guard-dense, so the two recurring traps apply: isolated tests per guard (never one
fixture tripping several), and exact `.data.reason` assertions. Equivalent mutants are expected on
the fanout binary search's `lo` narrowing — `pack-index.ts` already carries the proven-equivalent
comment for the identical shape, and it must be **re-proved against the midx's stride**, not copied:
a structure-specific proof does not transfer for free.

### Gates

`npm run validate` green before any commit; `reports/api.json` regenerated for the new public
exports — which now include the **four `FsckFinding` variants** and `EXIT_MULTI_PACK_INDEX`'s
effect on the documented `FsckResult.exitCode` bitmask, not just the domain parser;
`check:doc-coverage` page for the new surface; `check:test-pyramid` clean.

## Out of scope

- **Writing a midx.** No `git multi-pack-index write` analogue, no midx maintenance, no `expire` /
  `repack` / `compact`. §D8 W-4 is the constraint this leaves for the parking lot: **a future
  tsgit `gc` / `repack` that deletes a pack must delete or rewrite an existing midx**, or real git
  inherits a midx referencing deleted packs and reports live objects as missing (Pin H2).
- **The two bitmap-only chunks** (`{'B', 'T', 'M', 'P'}`, `{'R', 'I', 'D', 'X'}`) **and midx reachability bitmaps** — 28.3, which layers on this.
- **`.rev` reverse indexes** — 28.3.
- **`git multi-pack-index verify`'s object-CRC half.** ADR-601 brings the accessibility and
  integrity verdicts in scope (§D12); git's `verify` additionally re-inflates and CRC-checks every
  object reachable through the midx, and folds that into the same bit 32. tsgit claims the
  verdicts, not the re-inflation — the same capability boundary ADR-587 drew for packs, drawn
  explicitly rather than left implicit. §D11.2 names the residual.
- **A `multi-pack-index verify` command surface.** git has one; the ratification was to report
  through `fsck`, not to add a second command. The pass is internal.
- **`core.multiPackIndex`** as a config surface — tsgit's `readConfig` has no such key today and
  ADR-592 took plain authority, not the DC-1(c) opt-out. Its *behaviour* (Pin G17, H5, N3) is
  pinned only to prove which component hides an object — and, in N3, that it is the sole gate on
  git's fsck midx pass, which is why §D12.2's pass is unconditional.
- **Alternates.** git permits a midx in an alternate object directory; tsgit has no alternates.
- **SHA-256 pack support.** The midx parser is hash-generic (§D9) but `IDX_SHA_LENGTH = 20` keeps
  the surrounding subsystem SHA-1-only (B-7). Widening it is a separate backlog item.
- **Prefix/abbreviation resolution through the midx** — the DC-6(c) option ADR-597 declined;
  §D11.1 records the resulting divergence.
- **Stderr transcript parity.** Per ADR-249, git's midx `error:` / `warning:` / `fatal:` lines are
  presentation. tsgit emits none and is not expected to.

## Post-implementation corrections — 2026-08-09

Measured-reality corrections the implementation and review phases surfaced after this design was
accepted. The pinned matrices above (Pins A–P) are left exactly as originally recorded — a pin is a
transcript of one probe run, and a wrong reading belongs in that transcript's history, not erased
from it. Corrections land here instead.

**a. §D1 parse step 8 — the `PNAM` padding-byte refusal was wrong.** The draft's step 8 and the Test
strategy's chunk-content-refusals row both claimed a `PNAM` chunk with more than 3 NUL padding bytes
past its declared `numPacks` names refuses. Verified twice empirically against git 2.55.0:
`read_chunk_pack_names` reads exactly `numPacks` NUL-terminated names and stops — it never
inspects, counts, or cross-checks the chunk's remaining bytes, whether that remainder is ordinary
4-byte alignment padding or, when `numPacks` understates the chunk's real content, unread real data.
Shipped behaviour accepts any trailing bytes; `parsePackNames`
(`src/domain/storage/midx.ts`) carries the correction inline, with the reasoning recorded next to
the code. §D1 step 8 and the Test-strategy chunk-content-refusals bullet are corrected in place to
point here rather than repeat the wrong rule.

**b. Pin O rows O12 / O28 — git's *parent* fsck exit is topology-bimodal.** Both rows were pinned
against one fixture generation as a clean split — 128 (O12) on the parent, 32 (O28) contained by the
child. Re-running the same mutations across regenerated fixtures shows the *parent's* own exit is
not fixed: it depends on whether git's own connectivity walk happens to dereference the poisoned oid
**through the midx** before `multi-pack-index verify` gets to it — a function of `repack`'s delta
topology on that fixture, not of the mutation itself. Both **128 and 32** were measured on the
parent for the same mutation across different regenerations. What does **not** vary: the
`multi-pack-index verify` **child** always dies at 128 for these rows, and tsgit's own behaviour is
deterministic regardless of topology — it always takes the contained shape, a `midx-unusable`
finding plus bit 32 (§D12.1's "reached only inside the pass" arm), because tsgit's own connectivity
walk never routes through the midx decode the way git's optionally does. The pin's *intent* — git
has a die-at-load path and a contained-in-the-pass path for the same `MidxCheck` member — still
holds; only the claim that a given fixture always lands on one side of it does not.

**c. Pin O row O25 — git's exact fsck integer is fixture-variant; the bit-32 pin is the stable
one.** Re-running O25 (a midx-named pack's `.idx` deleted, `.pack` kept) across regenerated fixtures
measured **110** (as pinned) and **102** on different runs — the missing-object contribution comes
and goes with the fixture. The unstable component is git's own connectivity-walk cardinality on this
fixture shape, not the midx pass: bit 32 and the `midx-pack-unresolved` / `midx-entry-unresolved`
finding families are stable across every regeneration. The stable pin is therefore the bit and the
finding families, not the literal integer. Separately, and unrelated to the integer drift: this row
is where git's fsck also emits pack-layer stderr lines tsgit structurally cannot reproduce
(`error: packfile … index unavailable`, `unable to load rev-index`) — pack discovery in tsgit
requires the sibling `.idx` to exist at scan time, so there is no "pack found, index missing" state
to narrate a message for. This is an accepted divergence, of the same family the pack-health suite
already accepts for its own `.idx`-less rows (ADR-587's capability boundary), not a new one this
change introduces.

**d. §D4.2/§D11 — the session delta cache can mask a deferred Tier-A midx fault.** A read served
from `ctx.deltaCache` never touches the registry at all, so a cache hit answers correctly even when
the underlying midx has a Tier-A fault that only a fresh decode would trip (the `pack-int-id` /
`large-offset` family, reached only inside a specific entry's resolution — §D12.1's "contained" arm).
Concretely: a delta base cached by an earlier, pre-corruption read satisfies a later lookup that git
— decoding fresh every time — would `die()` on. This is why `fsck` (`fsck.ts`) audits through a
**cache-bypassing `Context` view**: `{ ...ctx, deltaCache: NO_DELTA_CACHE }`, sharing the *same*
pack registry via `adoptPackRegistry` (so the scan is not duplicated and no handle is doubled) but
forcing every object through a live decode. The ordinary read path is unaffected and keeps the cache
— this is deliberately not "fixed" there — so the residual divergence from git is bounded to objects
already cached before the store went bad, in a store that is already corrupted. Recorded as blind
spot 11 in §D11.

**e. §D3/§D5 — generation coherence is a structural invariant, not a concurrency test.** The Test
strategy's `pack-registry.test.ts` row promised "a `lookup` racing a `refresh` never sees one
generation's midx against another's packs" as a race scenario. What shipped instead is the
structural guarantee §D3 already specifies: `PackGeneration.midx` and `PackGeneration.packs` are two
fields of the *same* object, produced inside the *same* `scanPacks()` call and read together off the
*same* `currentGeneration()` await — so there is no interleaving in which a caller can observe one
without the other belonging to the same scan. This is asserted **by construction** (the type and the
single call site), not by an executable interleaving test, because there is no scheduling point
between reading `.midx` and reading `.packs` off one already-resolved `PackGeneration` for a test to
race against. No behaviour changed; the test-strategy row overstated what needed proving.

**f. Chunk-table gates — three additional git parse gates shipped, all Tier B (`chunk-table`).**
Beyond the gates §D1 lists (offsets strictly increasing, final entry id zero), the parser pins and
enforces three more, matching `read_table_of_contents` exactly:

- a **duplicate chunk id** across two rows refuses;
- each **real** row's offset must be 4-byte aligned — but git never alignment-checks the
  **terminating sentinel** row, only the `numChunks` real rows before it, and the parser matches
  that asymmetry rather than aligning every row uniformly;
- a **terminating id-0 row appearing before the final row** (an early sentinel) refuses, rather than
  being accepted as a short chunk table.

All three are classified `check: 'chunk-table'`, Tier B (warn, discard, fall back to the `.idx`
scan) — the same tier §D4.1 already assigns the chunk-table family, so this is additional coverage
within an existing tier, not a new tier or a new `MidxCheck` member.

**g. `numBaseFiles`.** Already correctly specified by §D4.4 — accepted and ignored, dropped from
`MidxCheck` entirely. No correction; named here only so this section's silence on `numBaseFiles` is
not read as an oversight.
