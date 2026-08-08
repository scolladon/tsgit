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
> an `error()`-and-ignore tier (Pin G). Both facts are load-bearing and both are surfaced as
> decision candidates rather than decided here.
>
> Status: **draft** — every load-bearing choice is open. See §Decision candidates.

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
   larger than cost 1 in wall-clock and is **not** removed by a purely additive fast path
   (DC-6).

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
| pack registry | `src/application/primitives/pack-registry.ts` | the only structural change: generation composition, `lookup`, `all`, `health`, `indexFaults` |
| domain storage | `src/domain/storage/` (new `midx.ts`, `error.ts`, `index.ts`) | new parser + new error code + barrel exports |
| read path | `object-resolver.ts:73`, `internal/blob-source.ts:99`, `fetch-missing.ts:57`, `internal/fsck/object-cache.ts:95,163` | all reach the registry through `lookup` — **unchanged call sites**, changed answers in the stale case |
| enumeration | `enumerate-objects.ts:34` | reads `registry.all()` / `health().accessible` and `allObjectIds(pack.index)`; affected only if DC-1 changes `all()`'s membership |
| abbreviation | `resolve-oid-prefix.ts:43` | `findByPrefix(pack.index, …)` over `registry.all()`; same conditional |
| limits | `src/domain/engine-limits.ts`, `primitives/validators.ts` | new size / chain-length bound (DC-9) |

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
  `TsgitError.data.code`, never `catch {}`. **This is in direct tension with Pin G's Tier A**,
  where git kills every read — including loose ones — over a corrupt midx. DC-2 is that tension.
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
This is DC-1.

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
(DC-6c), and any design that does not must state that it inherits the `.idx` universe (which is
git's enumeration universe, and therefore faithful on that axis).

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
7. **Degradation posture is a single, stated rule** covering every Pin G row, and it is the same
   rule for a flat midx and for a chain layer. Whichever DC-2 option lands, no midx fault is
   handled by `catch {}` and no message is re-parsed: classification is a total function over the
   closed `MidxCheck` union plus the two I/O codes the registry already allow-lists (§D4), in the
   discipline ADR-575 fixed.
8. **A midx never changes an answer in a healthy repository.** For every object in every pack, the
   bytes returned with the midx present equal the bytes returned with it absent (Pin L2). This is
   the property the interop twin pins.
9. **Stale-midx behaviour is the option DC-1 ratifies, and it is asserted, not incidental.** The
   `DUP` fixture — one object in two packs, the midx naming one of them — is the only shape that
   can tell the options apart, and it is an interop row.
10. **The `.idx` read stays bounded and validated.** Whatever DC-6 lands, `readBoundedIdx`'s
    pre-`stat` and post-`read` size checks still run before any large allocation, and
    `parsePackIndex`'s guards are untouched. The midx read is bounded by its own limit (DC-9)
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
17. **No unintended public API change.** New domain exports (`MultiPackIndex`, `MidxCheck`,
    `parseMultiPackIndex`, …) appear in `reports/api.json` deliberately. `PackRegistry`'s five
    method signatures do not change shape. The **one** permitted movement, and only if DC-6(b)
    lands, is `RegisteredPack.index` becoming a `() => Promise<PackIndex>` — a deliberate change
    with exactly two consumers (`enumerate-objects.ts:34`, `resolve-oid-prefix.ts:43`), both of
    which are already inside `async` functions.
18. **Measured, not asserted.** The perf claim is carried by a bench over a many-pack repository
    (§D7), sourced from the CI nightly artefact, not a local run.

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
   the `digestLength` argument; `numChunks ≥ 1`; `numBaseFiles === 0` — the spec calls it
   "currently always zero" and Pin C confirms every layer git writes sets it to 0, so a non-zero
   value names a layering scheme tsgit does not implement and is refused rather than ignored
   (§D11.5 records the consequence).
3. chunk table fits: `12 + (numChunks + 1) * 12 ≤ bytes.length - digestLength`.
4. read the `numChunks + 1` entries. Every offset must be **strictly increasing**, ≥ the table's
   own end, and ≤ `bytes.length - digestLength`; the final entry's id must be `0`. (G7 and G14 are
   exactly these two checks.)
5. required chunks present: `PNAM`, `OIDF`, `OIDL`, `OOFF` (G11, G12).
6. `OIDF` is `1024` bytes and monotonic; `objectCount = F[255]` (G13).
7. `OIDL.length === objectCount * digestLength`; `OOFF.length === objectCount * 8`.
8. `PNAM` splits into exactly `numPacks` NUL-terminated names, all non-empty, the remainder ≤ 3
   NUL padding bytes (G9); for version 1 only, strictly increasing (D7/D8).
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

New error in `src/domain/storage/error.ts` (DC-8). It carries a **`check` discriminant** naming the
gate that fired, because the parser is the only thing that knows *which* check failed and the
application layer must never recover that by matching on a message:

```ts
export type MidxCheck =
  | 'size' | 'signature' | 'version' | 'base-files' | 'hash-version' | 'chunk-table'
  | 'required-chunk' | 'fanout' | 'chunk-length' | 'pack-names' | 'pack-int-id' | 'large-offset';

| { readonly code: 'INVALID_MULTI_PACK_INDEX'; readonly reason: string; readonly check: MidxCheck }

export const invalidMultiPackIndex = (check: MidxCheck, reason: string): TsgitError =>
  new TsgitError({ code: 'INVALID_MULTI_PACK_INDEX', check, reason });
```

plus barrel exports in `src/domain/storage/index.ts` beside the pack-index block. `check` is a
closed union, so §D4's tier mapping is exhaustive by the type-checker rather than by review — and
it keeps the tier decision (DC-2) out of the domain, where a policy call does not belong.

### §D2 — discovery, precedence and the chain: `src/application/primitives/internal/midx-source.ts`

A new internal primitive, ~150 lines, whose whole job is Pin J and Pin I. `pack-registry.ts` is
already 548 lines with two skip layers; this is a separable, separately-testable concern (DC-7).

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

1. **Flat.** `objects/pack/multi-pack-index`. If it exists, read bounded (DC-9) and parse. Success
   → `{ layers: [midx], kind: 'flat' }`, **return** — the chain is not touched (J2/J3/J4). A
   Tier-B fault → record and fall through to the chain (J5). A Tier-A fault → per DC-2.
2. **Chain.** `objects/pack/multi-pack-index.d/multi-pack-index-chain`. Absent, empty, or
   unreadable → `set: undefined`, silently (I5/I6). Split on `\n`; take the leading run of
   lines that are exactly `2 × digestLength` lowercase hex, stopping at the first that is not
   (I10). Cap the run at `MAX_MIDX_CHAIN_LAYERS` (DC-9).
3. For each digest, read + parse `multi-pack-index-<digest>.midx`. **Any** missing or Tier-B-faulty
   layer discards the whole set (I2/I4/I8), with one warn.
4. `{ layers, kind: 'chain' }`.

Layer digest → filename is the only place a chain line becomes a path; the hex-only shape check in
step 2 is therefore also the path-safety check (T-2). Deliberately *not* verified: that a layer's
trailer equals the digest in its name — git does not check it on read (G8 is the same class), and
checking would cost a hash over the whole file on every open.

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
  /** Names the midx claims — the DC-1(b) subtraction set. */
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
     `{ pack, offset }`; fault → **return `undefined`** under DC-1(b), or fall to step 3 under
     DC-1(a). This single branch *is* Pin H2–H4.
   - **miss** → step 3, restricted per DC-1.
3. The existing loop over `packs`, filtered by DC-1: under (b), skip any pack whose name is in
   `claimedNames`; under (a), no filter.

`all()`, `health()` and `indexFaults()` keep their current shapes and their current membership. In
particular **`all()` is not filtered by `claimedNames`** — it stays the "packs present on disk"
view, which is git's *enumeration* universe (Pin K), keeping `enumerateObjects` and
`resolveOidPrefix` faithful on the axis Pin K says they are faithful on, and keeping ADR-572's
gated-lookup/ungated-`all()` boundary exactly where it is.

**A midx fault is not a `PackHealth` entry.** `UnusablePack` is per-*pack* and its `layer` is
`'pack' | 'index'`; a discarded midx is neither, and inventing a third layer would be DC-10(b)
through the back door. Under DC-10(a) a midx fault reaches `ctx.logger?.warn?.` and nothing else,
so `fsck`'s universe and findings are byte-identical to today's.

The midx-derived offset is fed to the **unchanged** downstream: `resolvePackChain` →
`pack.offsetTable()` → `nextOffsetForEntry` → `pack.readSlice`. The offset is a pack offset in
both worlds, so nothing below `lookup` is aware a midx exists. That is the property that keeps the
blast radius one function wide.

Three edges this ordering settles, each matching a pinned git row:

- **A `PNAM` entry naming a pack the scan excluded** — an orphaned `.idx` (ADR-579) or one that
  failed to parse (ADR-575) — binds to `undefined`, falls to step 3, and finds nothing there
  either, because that pack is not in `packs`. Result: missing. That is Pin H3 exactly.
- **A claimed pack holding an oid the midx does not list.** Impossible in a git-written midx (it
  records every object of every pack it names) but reachable by mutation. Under DC-1(b) step 3
  skips the claimed pack, so the oid is missing — which is git's answer, since a claimed pack is
  reached only through the midx.
- **A pack written after the midx** is in `packs` and not in `claimedNames`, so step 3 serves it.
  Pin H8 / L4, and the property `materializePack` depends on (§D8 W-2).

### §D4 — degradation posture

Per DC-2. Whichever option lands, the mechanism is the same: **one total function from the closed
`MidxCheck` union (§D1) to a tier**, living in `midx-source.ts`. No message is ever re-parsed and
no arm is a `catch {}`.

| tier | `MidxCheck` members | git's pinned row |
|---|---|---|
| **B** — `error`, discard the midx, serve from `.idx` | `size` · `chunk-table` · `chunk-length` · `hash-version` | G6, G7, G14, G15, G5 |
| **B** — I/O, not a parse | `FILE_NOT_FOUND` / `PERMISSION_DENIED` on the midx or a layer | G16, I2 |
| **A** — `die` in git | `signature` · `version` · `required-chunk` · `fanout` · `pack-names` · `pack-int-id` | G1, G2, G3, G9, G11, G12, G13, G10 |
| **A by analogy — not pinned** | `base-files` · `large-offset` | no git row exists: git 2.55.0 never writes a non-zero `numBaseFiles`, and an out-of-range `LOFF` row could not be produced without also breaking a chunk-length check. Classified with the structural family they belong to, and flagged here so the ADR can move them rather than inherit them silently |

A fault outside every arm (an `EMFILE` mapped to `UNSUPPORTED_OPERATION`, a programming error)
propagates unchanged, exactly as `isUnsupportedOperation` guarantees today.

The trailer checksum is **not** verified on read (Pin G8, DC-11).

### §D5 — cache and invalidation

- The midx load lives **inside** `scanPacks`, so it is covered by the existing `scan`
  `createPromiseMemo`: single-flight, rejection never memoised, `refresh()` clears it together
  with the packs, `dispose()` terminal (PR #263's §9 invariant, unchanged).
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

| condition | today | after |
|---|---|---|
| object in a pack, no midx | `PackLookupHit` | unchanged |
| object in a midx-named, healthy pack | `PackLookupHit` (found by the `.idx` loop) | `PackLookupHit` (found by the midx), **same offset, same bytes** |
| object assigned by the midx to an unusable pack, present in another midx-named pack | `PackLookupHit` from the other pack | `undefined` → `OBJECT_NOT_FOUND` **under DC-1(b)**; unchanged under DC-1(a) |
| unresolvable `PNAM` entry | n/a | falls through to the `.idx` loop (Pin H7); one `warn` |
| Tier-B midx fault | n/a (midx ignored) | midx discarded, one `warn`, reads unchanged |
| Tier-A midx fault | n/a (midx ignored) | per DC-2 |

`OBJECT_NOT_FOUND` is the existing code (`object-resolver.ts:76`) and needs no widening: the
missing-object refusal git produces in Pin H2 is the ordinary one (`fatal: Not a valid object
name`), not a store-corruption error.

### §D7 — performance

The claim and how it is measured, not asserted:

- **Lookup.** P fanout-narrowed binary searches → 1. For a hit, `compareShaAtIndex` runs
  `O(log n_p)` times per pack today; the midx makes it `O(log N)` once. The win scales with P and
  is zero at P = 1.
- **Scan.** Under DC-6(b), `readBoundedIdx` moves from *P whole-file reads, eagerly* to *1 midx
  read + 1 `.idx` read per pack actually touched*. For a lookup-heavy workload over a repo with
  many packs where reads concentrate in a few, this is the dominant term.
- **Bench.** A new `test/bench/midx-lookup.bench.ts` over a generated many-pack fixture
  (`tooling/gen-bench-fixture.ts` extended), comparing the same repository with and without a
  midx. Published numbers must come from the **CI nightly `bench.yml` artefact**, never a local
  run — local measurement under session load has been shown to bias syscall-heavy paths by up to
  2.4×.
- **Regression guard.** The midx path must not slow the P = 1 case. Worst case for a repo with no
  midx at all is **two extra `exists` calls per `Context`** (flat file, then chain file); with a
  flat midx it is one `exists` + one `stat` + one whole-file `read`. All of it is amortised over
  the session by the scan memo, and the P = 1 bench row exists to prove the amortisation is real
  rather than assumed.

### §D8 — write-path symmetry (explicit checklist)

This change is read-only. The checklist exists because "read-only" is where write-side hazards
hide.

| # | write surface | interaction with a midx | verdict |
|---|---|---|---|
| W-1 | `serializePackfile` / `serializePackIndex` (`pack-writer.ts`) | produces `pack-*.pack` / `.idx` | untouched; no midx is written or updated |
| W-2 | `materializePack` (`fetch-pack.ts:158-175`) — writes a fetched pack into `objects/pack/` | the new pack is **not** in any existing midx | **safe, pinned**: Pin H8 / L4 — git unions packs the midx does not name. tsgit must do the same, which DC-1(b)'s `claimedNames` filter does by construction (a pack not in `claimedNames` is not skipped) |
| W-3 | `buildPack` (`build-pack.ts:38`) — push / `bundle create` | sources every object through `readObject` | fails closed with `OBJECT_NOT_FOUND` if a stale midx hides an object; a short pack is structurally impossible |
| W-4 | any future `gc` / `repack` / `prune` | **deletes packs** | the brief's constraint, and it now cuts both ways: (i) deleting a pack a midx names makes real git report those objects missing (Pin H2) even though tsgit could still serve them — so a tsgit repack **must** delete or rewrite the midx; (ii) under DC-1(b), tsgit itself would report them missing too, which turns a silent cross-tool hazard into a loud local one. Parking-lot constraint, restated in §Out of scope |
| W-5 | `tooling/audit-write-surfaces.ts` | scans for annotated write surfaces | no new write surface, so no new `@writes` annotation and no allowlist entry; the gate must stay green untouched |

### §D9 — hash-width genericity (explicit checklist)

| # | site | rule |
|---|---|---|
| H-1 | `parseMultiPackIndex` | takes `digestLength`; never reads `ctx.hashConfig`; never hard-codes 20 or 32 |
| H-2 | `hashVersion` byte | mapped `1 → 20`, `2 → 32` via a named constant map; a value outside `{1,2}` is a refusal, a *width mismatch with the argument* is a **Tier B** condition (Pin G5) resolved in `midx-source.ts` |
| H-3 | `MIDX_HEADER_SIZE = 12` | hash-independent: the header carries no digest (Pin B) |
| H-4 | chain filename / chain line | `2 × digestLength` hex, not `40` |
| H-5 | trailer | `digestLength` bytes, and it is not read (DC-11) |
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
| T-3 | **Unbounded allocation** | `numPacks` is u32 and `numChunks` is u8, both attacker-set. `PNAM` splitting is bounded by the chunk's own length, which is bounded by the file. The file is bounded by DC-9's limit, checked `stat`-then-`read`-then-recheck (the `readBoundedIdx` TOCTOU shape). `objectCount` comes from `F[255]` and is cross-checked against `OIDL.length / digestLength` **before** any array is sized by it (parse step 7). Chain layers are capped (DC-9), so a chain file cannot force N file reads. |
| T-4 | **Out-of-bounds `DataView` reads** | A `RangeError` from `getUint32` is not a `TsgitError`; it would escape every allow-list in the registry and surface as an unclassified crash. Requirement 1 forbids it structurally: parse step 4 proves every chunk's `[start, end)` lies inside `[tableEnd, len − digestLength)` and that offsets strictly increase, **before** any chunk body is read. The `LOFF` row bound and the `packIndex` bound are the two per-lookup checks that keep this true after parse. |
| T-5 | **A stale midx is a denial vector** | Under DC-1(b) an attacker who flips one byte of `PNAM` — or simply deletes a pack — makes a set of objects unreadable that the store still contains. This is **git's own property** (Pin H2–H4), so adopting it adds no exposure relative to canonical git; it does remove availability relative to *tsgit today*. Under DC-1(a) the vector does not exist and the divergence does. This trade is the substance of DC-1 and must be decided, not smuggled. |
| T-6 | **Tier A is a total denial vector** | Under DC-2(a), one byte in the midx signature makes **every** read fail, loose objects included — a strictly larger blast radius than ADR-575 permits for any pack artefact. git does exactly this (G1). The tension is DC-2 and it is the second thing that must be decided rather than assumed. |
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
2. **`fsck` says nothing about the midx.** git reports `incorrect checksum` (exit 32),
   `failed to load pack in position N` and `multi-pack-index file exists, but failed to parse`.
   This change adds no `fsck` finding (DC-10), so the residual divergence in that family — which
   28.1a narrowed to one item — gains a second.
3. **The trailer is never verified** (DC-11), so a midx corrupted in its body but not in a
   structurally-detectable way is used. git has the identical property (G8); a *different* bad
   answer is possible only if the corruption is simultaneously structure-preserving and
   semantically wrong, in which case git returns the same bad answer.
4. **Chain layer order is unobservable in git-written chains** (Pin C's de-duplication), so
   newest-first vs base-first is untestable against real git. §D2 records the choice and its
   reasoning; a future compacting writer could make it observable.
5. **`numBaseFiles` is always 0** in every layer git 2.55.0 writes. The parser accepts it as a
   documented-reserved field and refuses non-zero rather than pretending to implement a format
   nobody emits — but that means a future git that starts emitting it would be refused, not
   degraded. Whether that refusal is Tier A or Tier B is a DC-2 consequence worth naming here.
6. **The two bitmap-only chunks** (`{'B', 'T', 'M', 'P'}`, `{'R', 'I', 'D', 'X'}`) appear when bitmaps are written. They are ignored (the chunk table is
   self-describing), which is correct for reads and becomes load-bearing in 28.3.
7. **Alternates.** git supports a midx in an alternate object directory; tsgit has no alternates
   at all, so the case cannot arise **today** and will need re-deciding if alternates land.
8. **Concurrency with a live `git multi-pack-index write`.** The scan reads the flat file and then
   the chain; a concurrent write could interleave. The consequence is bounded — a torn read is a
   Tier-B fault and discards the midx — but the read is not atomic and this design does not make
   it so. git has the same property.

## Decision candidates

Every load-bearing choice this design raises. Nothing below is decided here.

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
  `digestLength`, `numChunks` 0, `numBaseFiles` 1.
- **Chunk-table refusals**: non-increasing offsets, an offset past `len − digestLength`, an offset
  before the table's end, final entry id non-zero, a required chunk absent (one row per required
  chunk — ADR-575's isolated-guard rule: `PNAM` and `OIDF` and `OIDL` and `OOFF` each get their own
  row, because one test tripping several does not prove each guard alone).
- **Chunk-content refusals**: `OIDF` non-monotonic (at index 0 and at index 255 — two rows, since a
  loop-boundary mutant survives a single-index test), `OIDL` length ≠ `objectCount · digestLength`,
  `OOFF` length ≠ `objectCount · 8`, `PNAM` yielding ≠ `numPacks` names, `PNAM` with an empty name,
  `PNAM` with > 3 padding bytes, v1 `PNAM` out of order **accepted under v2** (the D7/D8 pair, as
  two rows sharing one fixture).
- **Lookup**: first / last / middle oid; an oid below `OIDL[0]` and above `OIDL[n-1]`; an oid in a
  fanout bucket that is empty; `packIndex` out of range refuses.
- **Large offsets** (Pin F, both directions): `LOFF` present + bit 31 set → the 64-bit value;
  `LOFF` **absent** + bit 31 set → the literal `0x80000000`; `LOFF` row index ≥ `largeOffsetCount`
  refuses; a `high` word past the safe-integer bound refuses (mirroring `pack-index.ts:103`).
- **Error-data assertions use try/catch + direct `.data` reads** of both `check` and `reason`,
  never bare `toThrow(ErrorClass)` — a StringLiteral mutant on a reason survives a type-only check,
  and a wrong `check` is a silent re-tiering (§D4).
- **Exhaustiveness**: one row per `MidxCheck` member, so the tier table in `midx-source.ts` cannot
  gain an unreachable arm or lose a reachable one without a test moving.

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
- DC-1(b) rows: midx hit on a pack whose header gate fails → `undefined`, and the sibling pack
  holding the same oid is **not** consulted; a pack absent from `claimedNames` **is** consulted.
- Generation coherence: `refresh()` drops midx and packs together; a `lookup` racing a `refresh`
  never sees one generation's midx against another's packs.
- `dispose()` handle-count deltas unchanged (requirement 13).

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
- Per ADR-249 the git stderr transcripts (`error:` / `warning:` / `fatal:`) are reconstructed in
  the test from tsgit's structured fields and compared to git's — the library emits no such line.
- `@proves` block, following the house annotation: `surface: pack.readMultiPackIndex`,
  `bucket: cross-tool-interop`, `interopSurface: multi-pack-index`.
- **Timeout discipline**: this suite spawns git heavily; use one shared `beforeAll` repo per shape
  and a 60 s timeout, or it will flake under `validate`'s concurrency.

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
exports; `check:doc-coverage` page for the new surface; `check:test-pyramid` clean.

## Out of scope

- **Writing a midx.** No `git multi-pack-index write` analogue, no midx maintenance, no `expire` /
  `repack` / `compact`. §D8 W-4 is the constraint this leaves for the parking lot: **a future
  tsgit `gc` / `repack` that deletes a pack must delete or rewrite an existing midx**, or real git
  inherits a midx referencing deleted packs and reports live objects as missing (Pin H2).
- **The two bitmap-only chunks** (`{'B', 'T', 'M', 'P'}`, `{'R', 'I', 'D', 'X'}`) **and midx reachability bitmaps** — 28.3, which layers on this.
- **`.rev` reverse indexes** — 28.3.
- **`fsck` reporting of midx faults** — DC-10(a); named as a residual divergence in §D11.2.
- **`core.multiPackIndex`** as a config surface — tsgit's `readConfig` has no such key today and
  DC-1(c) is not the recommendation. Its *behaviour* (Pin G17, H5) is pinned only to prove which
  component hides an object.
- **Alternates.** git permits a midx in an alternate object directory; tsgit has no alternates.
- **SHA-256 pack support.** The midx parser is hash-generic (§D9) but `IDX_SHA_LENGTH = 20` keeps
  the surrounding subsystem SHA-1-only (B-7). Widening it is a separate backlog item.
- **Prefix/abbreviation resolution through the midx** — DC-6(c); §D11.1 records the resulting
  divergence.
- **Stderr transcript parity.** Per ADR-249, git's midx `error:` / `warning:` / `fatal:` lines are
  presentation. tsgit emits none and is not expected to.
