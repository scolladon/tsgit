# Design — reverse-index (`.rev`) + pack bitmap read support

> Brief: `.rev` and `.bitmap` are "currently ignored harmlessly (neither is required for object
> reads)". `.rev` maps pack position ↔ index position; `.bitmap` accelerates reachability closure.
> Lift: a `.rev` parser + generation check against git's, an EWAH bitmap parser, and interop pins
> comparing enumeration/reachability against real git with and without the auxiliary files.
>
> Status: draft → self-reviewed ×3
>
> **Two of the brief's premises do not survive the pins, and the second one reframes the whole
> entry.**
>
> 1. *"Ignored harmlessly"* is true for **reads** and false for **`fsck`**. git 2.55.0 writes
>    `.rev` **by default** (Pin A), and a corrupt `.rev` sets `git fsck` exit **bit 64** — a bit
>    tsgit already models, from the wrong cause. [ADR-586](../adr/586-exit-bit-64-is-modeled-with-an-ungated-finding.md)
>    closed with *"28.3's real `.rev` reader lands with nothing to correct."* Pin H falsifies that
>    sentence: today tsgit exits **0** where git exits **64**, on the commonest corruption shape of
>    a file every modern git writes unasked. There is a second, wholly unreported bit —
>    **128 (`ERROR_BITMAP`)** — for `.bitmap` (Pin J). This entry's payload is therefore not
>    speculative acceleration; it is closing two live faithfulness gaps in a surface that shipped
>    three weeks ago.
> 2. *"Value materialises only when tsgit enumerates or serves objects at scale."* Half right. There
>    is **no** consumer for bitmaps — tsgit has no `rev-list`, no `pack-objects`, no negotiation
>    (§D1) — and git's own `fsck` needs **no EWAH parser** to do its whole job (Pin J). But `.rev`
>    has a concrete consumer today: `buildOffsetTable` (`pack-registry.ts:219`) sorts every pack's
>    offsets to build in memory exactly what the `.rev` already holds on disk (§D7).
>
> **What the brief calls a "generation check" does not exist.** A `.rev` carries no generation
> number and no version beyond `1`. Its only staleness signal is the embedded copy of the pack
> checksum — and **`git fsck` does not check it** (Pin H row R10b). §D4 takes the consequence.

## Context

### What tsgit does today, and where it is silent

`runPackHealthPass` (`src/application/commands/internal/fsck/pack-health.ts:30`) already emits a
`pack-rev-index-unusable` finding and sets `EXIT_PACK_REV_INDEX = 64`. It does so on **one**
trigger:

```ts
if (entry.layer === 'index') {
  findings.push({ type: 'pack-rev-index-unusable', pack: entry.name, reason });
  exitBit |= EXIT_PACK_REV_INDEX;
}
```

— i.e. a `.idx` the scan could not parse or open. Nothing in `src/` reads a `.rev` or a `.bitmap`
file: `isCandidate` (`pack-registry.ts:194`) admits only names ending `.idx`, so both artefacts are
invisible to discovery, and `grep -rn "\.rev\|bitmap" src/` finds only the constant, its
doc-comment and the finding type.

That is exactly correct for the **read** path — Pin H's `cat-file` / `batch-all` columns are `0` in
every measured row, with and without either artefact — and it is **incomplete** for `fsck`:

| repo shape | git 2.55.0 `fsck` | tsgit today | gap |
|---|---|---|---|
| corrupt `.idx` | 78 (`2\|4\|8\|64`) | bit 64 set (via the `entry.layer === 'index'` arm) | none — ADR-586 is right about this cause |
| corrupt `.rev`, healthy `.idx` | **64** | **0** | **bit 64 never fires** |
| corrupt `.bitmap` | **128** | **0** | **bit 128 does not exist as a constant** |
| both | **192** | **0** | both |

### The cost `.rev` exists to remove, in tsgit's own terms

`buildOffsetTable` (`pack-registry.ts:219-232`) is the one place tsgit needs pack-order:

```ts
const raw = entryOffsets(index);                       // O(n) reads out of the .idx
const sortedOffsets = [...raw].sort((a, b) => a - b);  // O(n log n), once per pack per Context
```

`sortedOffsets` is consumed by `nextOffsetForEntry` (`pack-registry.ts:320`) — a binary search for
"where does the entry at this offset end" — on **every packed object read**. The `.rev` is that
sort, precomputed by git: `sortedOffsets[p] = raw[rev[p]]`, an O(n) gather instead of an O(n log n)
sort. The win is real and bounded, and it is **not free**: it costs one extra file read (4 bytes per
object, against the `.idx`'s 24+) and it is only correct if the `.rev` is trusted or verified (§D7,
DC-4). It is a decision candidate (DC-2), not a foregone conclusion.

Note what the `.rev` does **not** buy: `entryOffsets(index)` is still required, so the `.idx` load is
not avoided. This is the same hard floor ADR-597 hit for the midx — the auxiliary file indexes the
pack, it does not replace the pack's index.

### Premises of the brief, checked against git and against the code

| # | brief premise | verdict |
|---|---|---|
| B-1 | *"both currently ignored harmlessly (neither is required for object reads)"* | **half true.** Harmless for reads (Pin H/J `cat-file` columns); **not** harmless for `fsck`, where tsgit is silent on two of git's eight exit bits. |
| B-2 | *"`.rev` maps pack position ↔ index position"* | correct, and the on-disk direction is **one-way**: `rev[packPosition] = indexPosition` (Pin B). The inverse needs an O(n) invert. |
| B-3 | *"accelerating offset→oid resolution (`verify-pack`-style enumeration, midx bitmaps)"* | tsgit has **neither** surface: no `verify-pack` command (`ls src/application/commands/`), no bitmap consumer. The real tsgit analogue is `buildOffsetTable` (§D7). |
| B-4 | *"pack bitmaps accelerate reachability closure (object counting for `pack-objects`, fetch/push negotiation)"* | correct — and tsgit has **none** of those three surfaces. §D1. |
| B-5 | *"midx bitmaps layer on the midx"* | correct, and stronger than stated: the midx's reverse index is a **chunk inside the midx** (`{'R','I','D','X'}`), **not** a sibling `multi-pack-index-<hex>.rev` file (Pin F). 28.2's parser already skips past it, so nothing there needs changing. |
| B-6 | *"`.rev` parser + **generation check** against git's"* | **there is no generation.** `.rev` version is `1` and only `1` (Pin H R2/R3); the only staleness field is the embedded pack checksum, which git's `fsck` **does not verify** (R10b). "Generation check" has no referent; §D4 replaces it with the three checks git actually runs. |
| B-7 | *"bitmap (EWAH-compressed) parser"* | **not required for faithfulness.** git's `fsck` bitmap obligation is the file's trailing checksum and **nothing else** — every restamped structural corruption exits 0 (Pin J rows B14–B19). An EWAH parser is optional payload with no consumer (DC-3). |
| B-8 | *"interop pins comparing enumeration/reachability results against real git with and without the auxiliary files"* | those results are **identical** in every healthy row and in every corrupt row (Pin H/J). The observable difference is entirely in `fsck`'s exit integer, so that is what the interop pins must compare. |
| B-9 | implicit: the artefacts are rare / opt-in | **false.** `pack.writeReverseIndex` defaults **on**: a bare `git repack -adq` writes `.rev` (Pin A). Essentially every repository touched by git ≥2.35 has them. |
| B-10 | implicit: the pack subsystem is hash-generic | **false, pre-existing.** `IDX_SHA_LENGTH = 20` is hard-coded in `pack-index.ts:10` / `pack-writer.ts:63`. Both new formats *are* hash-generic (Pin G) and their parsers must be written that way; the surrounding limit is neither widened nor narrowed here (§D10). |

### Subsystems this touches

| subsystem | file | involvement |
|---|---|---|
| domain storage | `src/domain/storage/` (new `rev-index.ts`, `error.ts`, `index.ts`) | the `.rev` parser + a new error code + barrel exports (DC-7, DC-8) |
| pack registry | `src/application/primitives/pack-registry.ts` | a new per-pack accessor for the `.rev` verdict, and — under DC-2(a) — `buildOffsetTable` |
| pack scan | `pack-registry.ts` `scanPacks` / `isCandidate` (:194) | the sibling-artefact listing the discovery step consumes at zero extra I/O (ADR-579's shape) |
| midx binding | `src/application/primitives/internal/midx-binding.ts:298` | `verifyMidxTrailer` is the verbatim precedent for hashing an artefact at fsck time; the midx-bitmap filename derives from the same `head._bytes` trailer slice (Pin K) |
| fsck | `commands/fsck.ts`, `internal/fsck/pack-health.ts`, new `internal/fsck/bitmap-health.ts`, `internal/fsck/types.ts`, `internal/fsck/exit-codes.ts` | the whole payload: one new bit-64 cause (DC-5), one new bit-128 pass |
| limits | `primitives/validators.ts` | new artefact bounds (DC-9), beside `MAX_MIDX_BYTES` |
| read path | `object-resolver.ts`, `internal/blob-source.ts` | **unchanged** under every scope option — `.rev`/`.bitmap` faults never fail a read in git (Pin H/J) |

### Constraining prior decisions

- **[ADR-226](../adr/226-git-faithfulness-prime-directive.md) — git-faithfulness.** Binds the
  **exit integer** here, which is the entire observable. Both gaps in the table above are
  divergences in a refusal/exit condition, which is the directive's core subject.
- **[ADR-249](../adr/249-describe-structured-data-only.md) — structured data only.** git's
  `error: reverse-index file … has unknown signature` and `error: bitmap file … has invalid
  checksum` are presentation. tsgit ships `{ type, pack, reason }` and the interop test reconstructs
  the transcript.
- **[ADR-586](../adr/586-exit-bit-64-is-modeled-with-an-ungated-finding.md) — bit 64 is modelled,
  ungated.** The direct parent. Its ungated posture (`connectivityOnly` / `full: false` / `strict`
  all report) is **re-confirmed** by Pin I for the `.rev` cause and holds for bit 128 too (Pin L Y1).
  Its closing sentence is the one thing this design must correct (DC-5).
- **[ADR-583](../adr/583-two-pack-finding-variants-by-layer.md) / [584](../adr/584-the-finding-carries-the-pack-base-name.md)** —
  one finding variant **per layer**, carrying the pack **base name** with its doc-comment's safety
  contract. Pin H's two distinct `.rev` message families are the test of whether that rule wants a
  second variant here (DC-5).
- **[ADR-589](../adr/589-the-pack-pass-lives-in-internal-fsck.md)** — a pass lives in
  `commands/internal/fsck/` and `fsck.ts` gains three lines. The bitmap pass follows verbatim.
- **[ADR-575](../adr/575-full-per-pack-registry-degradation.md)** — per-pack degradation via
  **allow-lists** over `TsgitError.data.code`, never `catch {}`. `.rev`/`.bitmap` faults are the
  purest case yet: git degrades them per-artefact **and** never lets them fail a read.
- **[ADR-593](../adr/593-midx-corruption-replicates-gits-two-tiers.md)** — the midx's Tier A/Tier B
  split. **Neither new artefact has a Tier A**: Pin H and Pin J have no row where a read fails.
  Stated explicitly because a reader arriving from 28.2 will look for one.
- **[ADR-599](../adr/599-invalid-multi-pack-index-carries-check-discriminant.md)** — a refusal
  carries a **closed `check` discriminant**, so tier/finding mapping is exhaustive by the
  type-checker. DC-8 asks whether `.rev` earns the same.
- **[ADR-600](../adr/600-dedicated-midx-size-and-chain-bounds.md)** — a new declared-count bound gets
  its **own** named constant with arithmetic in its doc-comment, not a reused generic cap. DC-9.
- **[ADR-602](../adr/602-midx-trailer-unverified-on-read-verified-in-fsck.md)** — trailer unverified
  on read, verified in fsck. Pin H R9b and Pin J B9 show git has the **identical** split for both
  new artefacts, so this precedent is inherited rather than re-litigated (DC-4 states it as the
  recommendation, not as a settled fact).
- **`pack-registry-single-flight.md` (PR #263)** — every lazy initialiser crossing an `await` is a
  `createPromiseMemo`; a rejection is never memoised; `dispose()` is terminal.

### House patterns this must follow

- Zero-copy `DataView` parsing with `_bytes` / `_view` retained, exactly as `PackIndex`
  (`pack-index.ts:13-21`) and `MultiPackIndex` do.
- Domain code takes bytes + a `digestLength`; all I/O, path construction and policy live in the
  application layer (ADR-577's rule: no cross-check inside a context-free parser).
- Files ≤ ~400 lines, functions < 20 lines, early returns, named constants.
- `ctx.hash.hash(bytes)` (`ports/hash-service.ts`) for artefact digests, algorithm from
  `ctx.hashConfig`, never a hard-coded name.

## Pinned matrices — git 2.55.0, this host (darwin 25.5.0)

Every cell below was **executed**, not recalled. Method: one `mktemp -d` throwaway per row, isolated
`HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` unset, `commit.gpgsign=false`,
`init.defaultBranch=main`, `gc.auto=0`. The fixture (`build_repo`) is 2 commits / 6 blobs / 3 trees
→ 12 objects in one pack, built with `git repack -adq --write-bitmap-index`.

**RESTAMPED** rows recompute the artefact's trailing digest over `[0, len − digestLength)` after the
mutation, which separates *load-time structural checks* from *checksum detection*. A control row
proves the restamp algorithm is git's own: restamp-with-no-other-change leaves both `fsck` and
`verify-pack` at exit 0. **Without that separation every row below reads as "checksum failure" and
the entire matrix is uninterpretable** — the same methodological trap Pin P of the midx design paid
for once.

`.rev` chain files, layer permissions and midx chains are not re-pinned here; 28.2's Pins A–P stand.

### Pin A — what is on disk, and when git writes it

| trigger | artefacts produced |
|---|---|
| `git repack -adq` (**no flags**) | `pack-<hex>.idx`, `.pack`, **`.rev`** |
| `git repack -adq --write-bitmap-index` | the above **+ `pack-<hex>.bitmap`** |
| `git -c pack.writeReverseIndex=false repack -adq` | `.idx` + `.pack` only |
| `git index-pack --rev-index …` | `.idx` + `.rev` |
| `git index-pack --no-rev-index …` | `.idx` only |
| `git multi-pack-index write --bitmap` | `multi-pack-index` **+ `multi-pack-index-<midx-checksum>.bitmap`** — and **no** `multi-pack-index-*.rev` |

**`pack.writeReverseIndex` defaults to true.** This is the single most consequential row: `.rev`
files are not an opt-in, they are the default output of the commonest maintenance command, so the
`fsck` gap in §Context is reachable in any repository, not an exotic one.

The midx bitmap's `<hex>` **is the midx's own trailer digest**, verified byte-for-byte against
`multi-pack-index`'s last 20 bytes. Pin K makes the *source* of that name load-bearing.

### Pin B — `pack-*.rev`, byte for byte

12 objects, SHA-1, total **100** bytes:

```
00000000: 5249 4458 | 0000 0001 | 0000 0001    R I D X | version=1 | hashId=1
0000000c: 0000 0001 0000 0009 0000 000b …      body: 12 × u32BE
0000003c: fca834f4…4636                        embedded pack checksum (= .pack trailer, verified)
00000050: 8e737319…7b31                        the .rev's own digest over [0, len−20)
```

| field | rule |
|---|---|
| magic | `{'R','I','D','X'}` = `0x52494458` |
| version | u32BE, **`1` and only `1`** (Pin H R2/R3 refuse 0 and 2) |
| hash id | u32BE, `1` = SHA-1, `2` = SHA-256 |
| body | `objectCount` × u32BE. `body[p]` = the **index position** of the object at **pack position** `p` |
| trailer | `digestLength` bytes: a copy of the pack checksum, then `digestLength` bytes: the digest of everything before it |
| total size | `12 + 4·N + 2·digestLength` — exactly (Pin H R17: one extra byte is `is corrupt`) |

The body is a **permutation** of `[0, N)` in a healthy file, and it is sorted by pack offset:
correlating it against `git verify-pack -v` gives offsets `12, 152, 263, 287, 306, 325, 344, 363,
379, 559, 602, 657` — strictly increasing. Confirmed on the 12-object fixture and on a 2-object one
(size 60 = 12 + 8 + 40).

### Pin C — the three orderings, and which artefact uses which

This is the subtlety the whole family turns on, and it is **not symmetric**:

| ordering | definition | who uses it |
|---|---|---|
| **index position** | rank in the `.idx`'s oid-sorted list | `.idx` fanout lookup; the `.rev` **body values**; a `.bitmap` **entry header's** 4-byte position |
| **pack position** | rank by offset in the `.pack` | the `.rev` **body indices**; every **bit inside every bitmap** |
| **midx / pseudo-pack position** | rank in the midx's pseudo-pack concatenation | midx `{'R','I','D','X'}` chunk; every bit in a **midx** bitmap |

Decoded from the fixture's bitmap and cross-checked against `verify-pack -v`:

- commits EWAH `bit_size=2`, one literal word `0x3` → bits **0, 1** = pack positions 0 and 1 = the
  two commits (git writes commits first). ✓
- trees EWAH `bit_size=11`, word `0x700` → bits 8, 9, 10 = the three trees. ✓
- blobs EWAH `bit_size=12`, word `0x8fc` → bits 2–7 and 11 = the seven blobs. ✓
- the two per-commit-bitmap **entry headers** carry `1` and `9`, which are the two commits'
  **index** positions (`161e025d…` at 1, `f0b4445f…` at 9) — **not** their pack positions (0, 1).

**Rule.** A bitmap's bits are pack positions; its entry headers are index positions. Reading a
bitmap therefore requires the `.rev` (or an equivalent in-memory reverse index) *and* the `.idx`.
This is the coupling the brief names, stated precisely enough to implement.

### Pin D — `pack-*.bitmap`, byte for byte

Same 12-object fixture, total **272** bytes:

| offset | field |
|---|---|
| 0 | magic `{'B','I','T','M'}` = `0x4249544d` |
| 4 | **u16BE** version = `1` |
| 6 | **u16BE** option flags — `0x0005` by default |
| 8 | u32BE entry count = 2 |
| 12 | `digestLength` bytes: the **pack** checksum (for a midx bitmap, the **midx** checksum) |
| 32 | four EWAH streams, in order: **commits, trees, blobs, tags** |
| … | `entryCount` × { u32BE index position, u8 XOR offset, u8 flags, EWAH stream } |
| … | extensions selected by the flag word (here: hash cache = `objectCount` × u32BE) |
| `len − digestLength` | the file's own digest over `[0, len − digestLength)` |

An **EWAH stream** on disk is `u32BE bitSize · u32BE wordCount · wordCount × u64BE · u32BE
rlwPosition`. Each word is either a run-length word (bit 0 = run value, bits 1–32 = clean-word run
length, bits 33–63 = following literal-word count) or a literal. Verified by decoding
`0x0000000200000000` as *0 clean words, 1 literal word* and the following literal as the type
bitmaps above.

The empty **tags** stream is `bitSize=0, wordCount=1, word=0, rlw=0` — 20 bytes, not 12. An
implementation that special-cases "empty ⇒ zero words" mis-parses git's own output.

### Pin E — bitmap option flags, as git 2.55.0 writes them

| configuration | flag word |
|---|---|
| default (`--write-bitmap-index`) | `0x0005` |
| `pack.writeBitmapHashCache=false` | `0x0001` |
| `pack.writeBitmapLookupTable=true` | `0x0015` |
| `bitmapPseudoMerge.<name>.*` configured | `0x0025` |

⇒ `0x1` = full-DAG (mandatory), `0x4` = hash cache, `0x10` = lookup table, `0x20` = pseudo-merges.
`0x2` was **not produced by any probed configuration** — recorded as unobserved, not as reserved.

Two behaviours worth carrying:

- **`0x1` is mandatory.** Clearing it makes git 2.55.0 abort: `BUG: pack-bitmap.c:270: unsupported
  options for bitmap index file (Git requires BITMAP_OPT_FULL_DAG)`, **exit 134, an abort**, on
  `rev-list`, `rev-list --test-bitmap` and `pack-objects` alike (rows B5/B19). It is a git *assert*,
  not a refusal; nothing in tsgit should replicate an abort.
- **An unknown flag changes the parse.** `flags = 0xffff` produces `error: corrupted bitmap index
  file (too short to fit pseudo-merge table)` — the flag word selects which trailing extensions the
  reader expects, so it is a length-determining field, not an advisory one (row B6).

### Pin F — the midx's reverse index is a **chunk**, not a file

`git multi-pack-index write --bitmap` on the fixture yields a 6-chunk midx:

```
PNAM              0x60  (52)     OIDF  0x94  (1024)   OIDL  0x494 (360)
OOFF              0x5fc (144)    {'R','I','D','X'} 0x68c (72)
{'B','T','M','P'} 0x6d4 (8)     [terminator]      0x6dc
```

- **`{'R','I','D','X'}`** = `objectCount` × u32BE, the same shape and the same semantics as a `.rev` body, with
  midx positions substituted for index positions. On the single-pack fixture its 18 values are
  **byte-identical** to the pack's own `.rev` body.
- **`{'B','T','M','P'}`** = `numPacks` × 2 × u32BE = `{ bitmap_pos, bitmap_nr }`. Measured 8 bytes for 1 pack
  → **two** u32s. The shipped pack-format manual page's prose says *"three pieces of information"*
  while its own worked-example table lists two; the binary agrees with the table. **Doc astray from
  the binary — the binary wins**, the same call Pin D of the midx design made for `midx.version`.
- **No `multi-pack-index-*.rev` file is written**, and the shipped spec states the reason outright
  (paraphrased to keep the four-byte chunk id out of running prose): the multi-pack-index's reverse
  index lives in an **optional chunk inside the midx itself**, not in a sibling file.

28.2's parser already ignores both chunks (the chunk table is self-describing), so this pin
**closes** blind spot §D11.6 of the midx design rather than opening work.

### Pin G — hash width

| repo `--object-format` | `.rev` hash id | `.rev` size (12 objects) | `.bitmap` checksum field | fsck rows |
|---|---|---|---|---|
| sha1 | `1` | 100 = 12 + 48 + 20 + 20 | 20 bytes | H, J |
| sha256 | `2` | 124 = 12 + 48 + 32 + 32 | 32 bytes | S0–S5 |

Every SHA-256 row reproduces its SHA-1 twin exactly: bad signature → 64, trailer flipped → 64
(`invalid checksum`), body out of range restamped → 64 (`invalid rev-index position at 0: <expected> != 999`),
bitmap trailer flipped → 128, bitmap magic flipped **restamped** → **0**. Nothing branches on width
except the width itself.

### Pin H — `.rev` fault matrix

`cat-file` = `cat-file -p <blob>`; `batch-all` = `cat-file --batch-all-objects --batch-check`;
`rev-list-bm` = `rev-list --use-bitmap-index --count --objects HEAD`.

| # | mutation | cat-file | batch-all | rev-list-bm | `fsck` | `verify-pack` | git's fsck line(s) |
|---|---|---|---|---|---|---|---|
| R0 | healthy (control) | 0 | 0 | 0 | **0** | 0 | — |
| R11 | `.rev` **deleted** | 0 | 0 | 0 | **0** | 0 | — |
| R12 | `.rev` **`chmod 000`** | 0 | 0 | 0 | **0** | 1 | — (**silent**) |
| R13 | **orphan** `.rev` (no such pack) | 0 | 0 | 0 | **0** | 0 | — |
| R1 | signature 4th byte flipped | 0 | 0 | 0 | **64** | 1 | `reverse-index file <p>.rev has unknown signature` + `unable to load rev-index for pack '<p>.pack'` |
| R2 | version = 2 | 0 | 0 | 0 | **64** | 1 | `… has unsupported version 2` + `unable to load …` |
| R3 | version = 0 | 0 | 0 | 0 | **64** | 1 | `… has unsupported version 0` + `unable to load …` |
| R5 | hashId = 0 | 0 | 0 | 0 | **64** | 1 | `… has unsupported hash id 0` + `unable to load …` |
| R16 | hashId = **2 in a SHA-1 repo**, RESTAMPED | 0 | 0 | 0 | **0** | 1 | — |
| R6 | truncated to 8 bytes | 0 | 0 | 0 | **64** | 1 | `… is too small` + `unable to load …` |
| R7 | truncated mid-body | 0 | 0 | 0 | **64** | 1 | `… is too small` + `unable to load …` |
| R8 | zero-length | 0 | 0 | 0 | **64** | 1 | `… is too small` + `unable to load …` |
| R7d | truncated to **51** = `12 + 2·dl − 1` | 0 | 0 | 0 | **64** | 1 | `… is **too small**` + `unable to load …` |
| R7c | truncated to **52** = `12 + 2·dl` exactly | 0 | 0 | 0 | **64** | 1 | `… is **corrupt**` + `unable to load …` |
| R7b | truncated to 60 (≥ 52, ≠ 100) | 0 | 0 | 0 | **64** | 1 | `… is corrupt` + `unable to load …` |
| R17 | 4 extra bytes appended, RESTAMPED | 0 | 0 | 0 | **64** | 1 | `… is corrupt` + `unable to load …` |
| R9b | **own digest** flipped | 0 | 0 | 0 | **64** | 1 | `invalid checksum` + `invalid rev-index for pack '<p>.pack'` |
| R10b | **embedded pack checksum** flipped, RESTAMPED | 0 | 0 | 0 | **0** | 1 | — |
| R14 | `body[0] = 999` (out of range), RESTAMPED | 0 | 0 | 0 | **64** | 1 | `invalid rev-index position at 0: <expected> != 999` + `invalid rev-index for pack …` |
| R15 | `body[0] = body[1]` (non-permutation), RESTAMPED | 0 | 0 | 0 | **64** | 1 | `invalid rev-index position at 0: <expected> != <body[1]>` + `invalid rev-index for pack …` |
| N1 | **two** body positions wrong, RESTAMPED | 0 | 0 | 0 | **64** | 1 | **two** `invalid rev-index position` lines + one `invalid rev-index for pack` |
| N2 | digest bad **and** body bad | 0 | 0 | 0 | **64** | 1 | `invalid checksum`, **then** `invalid rev-index position …`, then `invalid rev-index for pack` |
| C1 | `.idx` corrupt, `.rev` intact | n/m | n/m | n/m | **78** | n/m | `non-monotonic index <p>.idx` (bit 64 arrives from the `.idx`) |
| C2 | `.idx` corrupt **and** `.rev` corrupt | n/m | n/m | n/m | **78** | n/m | byte-identical to C1 — the `.rev` fault is **not separately reported** |

`n/m` = not measured (the row's subject is the exit integer). `<expected>` is **fixture-dependent**:
the value is the index position the `.idx` implies for that pack position, so it changes with every
freshly-built repository. **Only the message *shape* and the finding *cardinality* are data**; an
interop assertion that pins the literal integer pair against a rebuilt fixture will flake.

**Rules, as pinned.**

1. **No `.rev` fault ever fails a read.** `cat-file` and `batch-all` are `0` in every measured row. There is
   no Tier-A analogue and `rev-list` degrades to a normal walk (exit 0) with an `error:` line.
2. **A missing, unreadable or orphaned `.rev` is a non-event** (R11–R13): exit 0, and R12 is
   *silent* — git `stat`s/opens and falls back with no message at all. Only a `.rev` that **exists
   and is readable and is wrong** scores.
3. **Two independent check families, both scoring bit 64, with different messages** —
   *load* (signature / version / hash-id / size, family `unable to load rev-index for pack`) and
   *verify* (own digest, body cross-check, family `invalid rev-index for pack`). N2 shows they
   compose within one run.
4. **The version accept-set is `{1}`.** R2 refuses `2`; there is no v2.
5. **`hashId` is checked for membership in `{1, 2}` but never against the repository** — R5 (0)
   refuses, R16 (2 in a SHA-1 repo, restamped) is **clean**. This is *laxer* than the midx's
   hash-version handling (the **midx design's** Pin G5 at least emits an `error:`), and copying that posture here
   would be a stricter-than-git divergence.
6. **The embedded pack checksum is not verified by `fsck`** (R10b). The one field that could detect
   a `.rev` paired with the wrong pack is unused — the brief's "generation check" has no referent.
7. **The size rule is exact, and its two failures split at a pinned boundary**: `< 12 + 2·digestLength`
   → `is too small`; anything at or above that but `≠ 12 + 4·N + 2·digestLength` → `is corrupt`.
   R7d (51 bytes) versus R7c (52 bytes) is the boundary itself, measured one byte apart. Both score
   bit 64 and both belong to the *load* family, so the split is a **reason** distinction, not an
   exit one — but it is git's data and §D2 keeps it.
8. **The body cross-check is exhaustive and per-position** (N1): git rebuilds the reverse index from
   the `.idx` and reports **every** mismatch, then one summary line. Bit 64 is set **once**.
9. **An unusable `.idx` masks the `.rev` entirely** (C1 vs C2, byte-identical). git never loads a
   `.rev` for a pack whose index it could not load, so the two causes never double-report.
10. `verify-pack` is stricter than `fsck` — it fails on R10b and R16 too, with a single
    indistinguishable `fatal: sha1 file '<p>.rev' validation error`. **tsgit has no `verify-pack`
    surface** (`ls src/application/commands/`), so this column is context, not obligation.

### Pin I — `.rev` at `fsck`: mode gating and cardinality

`--no-full` adds a constant `2` on this all-packed fixture (it stops looking in packs); the table
reports raw exits so the constant is visible in the control.

| # | mutation | `fsck` | `--connectivity-only` | `--no-full` | `--strict` |
|---|---|---|---|---|---|
| M0 | healthy (control) | 0 | 0 | **2** | 0 |
| M1 | bad signature | **64** | **64** | **66** | **64** |
| M2 | own digest flipped | **64** | **64** | **66** | **64** |
| M3 | body out of range | **64** | **64** | **66** | **64** |
| M4 | `.rev` deleted | 0 | 0 | 2 | 0 |
| M5 | `chmod 000` | 0 | 0 | 2 | 0 |
| M7 | bad signature, **`.bitmap` removed** | **64** | **64** | **66** | **64** |
| M8 | bad signature, **midx present** | **64** | **64** | **66** | **64** |

Separately, on a midx repository with the `core.multiPackIndex=false` column measured instead of
`--strict`: row **X9** (bad signature on a **midx-named** pack) gives `full=64`, `conn=64`,
`no-full=66`, **`core.multiPackIndex=false` = 64**.

Multi-pack composition, two packs each with a corrupt `.rev`: **exit 64**, **two** `unknown
signature` lines. One bit, N findings.

**Rules.** Bit 64 is **ungated by mode** — exactly ADR-586's posture, re-confirmed for the cause
ADR-586 could not test. It is ungated by the presence of a bitmap (M7), by the presence of a midx
(M8), and by `core.multiPackIndex` (X9) — unlike the *midx-bitmap* arm, which that key does gate
(Pin K rule 2).

### Pin J — `.bitmap` fault matrix: `fsck` checks the checksum and **nothing else**

| # | mutation | cat-file | `fsck` | `rev-list-bm` | `--test-bitmap` | git's fsck line |
|---|---|---|---|---|---|---|
| B0 | healthy (control) | 0 | **0** | 0 | 0 | — |
| B1 | `.bitmap` deleted | 0 | **0** | 0 | 128 | — |
| B12 | `chmod 000` | 0 | **0** | 0 (warns) | 128 | — (**silent**) |
| B23 | **orphan** `.bitmap` (no such pack) | 0 | **0** | 0 | 0 | — |
| B2 | magic flipped | 0 | **128** | 0 | 128 | `bitmap file '<p>.bitmap' has invalid checksum` |
| B3 | version = 2 | 0 | **128** | 0 | 128 | *the same line* |
| B4 | version = 0 | 0 | **128** | 0 | 128 | *the same line* |
| B7 | entryCount = 99 | 0 | **128** | 0 | 128 | *the same line* |
| B10 | truncated to 20 bytes (= `digestLength`) | 0 | **128** | 0 | 128 | *the same line* |
| B25 | truncated to **10** bytes (**< `digestLength`**) | 0 | **128** | 0 | 128 | *the same line* |
| B11 | zero-length | 0 | **128** | 0 | 128 | *the same line* |
| B9 | embedded pack checksum flipped | 0 | **128** | 0 | 0 | *the same line* |
| **B14** | magic flipped, **RESTAMPED** | 0 | **0** | 0 | 128 | — |
| **B15** | version = 2, **RESTAMPED** | 0 | **0** | 0 | 128 | — |
| **B16** | embedded pack checksum flipped, **RESTAMPED** | 0 | **0** | 0 | **0** | — |
| **B17** | entryCount = 99, **RESTAMPED** | 0 | **0** | 0 | 128 | — |
| **B18** | truncated, **RESTAMPED** | 0 | **0** | 0 | 128 | — |
| **B19** | flags = 0, **RESTAMPED** | 0 | **0** | **134** | 134 | — |
| B21 | first EWAH `wordCount = 0x7fffffff`, RESTAMPED | 0 | **0** | 0 | 128 | — |
| B22 | first EWAH `bitSize = 0xffffffff`, RESTAMPED | 0 | **0** | 0 | 0 | — |
| B13 | `.rev` **deleted**, `.bitmap` kept | 0 | **0** | 0 | 0 | — |

**Rules, as pinned — and this is the scope-defining pin of the whole design.**

1. **`git fsck`'s entire bitmap obligation is `hash(file[0 .. len−digestLength)) == file[len−digestLength ..]`.**
   Every restamped structural corruption — wrong magic, wrong version, absurd entry count, a
   truncated file, an EWAH word count of 2³¹ — exits **0**. The six RESTAMPED rows are the proof and
   they are the reason **no EWAH parser is needed for faithfulness** (DC-3).
2. **One message for every cause**, so the cause is not observable through `fsck` at all. Per
   ADR-249 tsgit reproduces the condition and the integer; there is nothing else to reproduce.
3. **Absent / unreadable / orphaned is clean and silent** (B1, B12, B23) — the same shape as `.rev`.
4. **Bit 128 is ungated**: by mode — default, `--connectivity-only` and `--strict` all give **128**,
   `--no-full` gives **130** against a control of **2** (Pin L row Y1) — and by
   `core.multiPackIndex` for a *pack* bitmap (Pin K X8). A healthy `.bitmap` needs no `.rev` at all
   (B13).
5. **No bitmap fault fails a read.** `cat-file` is 0 in every row; `rev-list --use-bitmap-index`
   silently degrades to a full walk and still exits 0 with the right answer.
6. **B19 is git aborting, not refusing** (`BUG:`, exit 134 — an abort, not a refusal). Not a behaviour to replicate.
7. B21 shows git's own bound: an oversized EWAH word count is caught as `eof in data
   (17179868944 bytes short)` against the mapped file length — the file size is the bound, and
   tsgit's own bound must be at least as tight (DC-9, T-3).

### Pin K — the midx bitmap

| # | mutation | `fsck` | `midx verify` | `--connectivity-only` | `--no-full` | `core.multiPackIndex=false` |
|---|---|---|---|---|---|---|
| X0 | healthy (midx + midx bitmap + pack bitmap) | 0 | 0 | 0 | 2 | 0 |
| X1 | midx bitmap magic flipped | **128** | 0 | **128** | **130** | **0** |
| X2 | midx bitmap magic flipped, **RESTAMPED** | **0** | 0 | 0 | 2 | 0 |
| X3 | embedded **midx** checksum flipped, RESTAMPED | **0** | 0 | 0 | 2 | 0 |
| X4 | midx bitmap trailer flipped | **128** | 0 | **128** | **130** | **0** |
| X5 | midx bitmap deleted | 0 | 0 | 0 | 2 | 0 |
| X6 | midx bitmap `chmod 000` | 0 | 0 | 0 | 2 | 0 |
| X7 | midx bitmap **renamed** to a different hash | **0** | 0 | 0 | 2 | 0 |
| X8 | **pack** bitmap trailer flipped (midx present) | **128** | 0 | **128** | **130** | **128** |
| X10 | **midx trailer** flipped **+** midx bitmap magic flipped | **32** | 1 | 32 | 34 | 0 |
| X11 | midx trailer flipped only | **32** | 1 | 32 | 34 | 0 |

**Rules.**

1. The midx bitmap is checked by the **same** checksum-only rule (X2 restamped → 0), scoring the
   **same** bit 128 (X1), and it is **ungated by mode**.
2. **The midx bitmap check *is* gated by `core.multiPackIndex`; the pack bitmap check is not**
   (X1 vs X8). That is the **midx design's** Pin N3 shape, applied one layer out.
3. **Discovery is by the midx's *stored* trailer bytes.** X7 (rename) and X10 (flip the midx's own
   trailer, corrupt the bitmap, get **32 and not 128**) both prove it: git composes
   `multi-pack-index-<hex(stored trailer)>.bitmap` and simply does not find anything else. A
   midx whose trailer is wrong therefore *hides* its bitmap from `fsck` entirely — bit 32 fires,
   bit 128 does not. §D5 must reproduce that, and it is the least obvious row in the design.
4. `git multi-pack-index verify` never looks at bitmaps (0 in X1–X8); the bitmap verdict lives only
   in `fsck`'s own pass, unlike the midx verdict, which Pin N of 28.2 showed is a child process.

### Pin L — exit-bit composition, and the interaction with pack accessibility

| # | repo shape | `fsck` | `--connectivity-only` | `--no-full` | `--strict` |
|---|---|---|---|---|---|
| Y0 | healthy (control) | 0 | 0 | **2** | 0 |
| Y1 | `.bitmap` trailer flipped | **128** | **128** | **130** | **128** |
| Y3 | **`.pack` `chmod 000`** (header-gate refusal), artefacts intact | 14 | 10 | 10 | 14 |
| Y2 | `.bitmap` trailer flipped **+ `.pack` `chmod 000`** | **142** | **138** | **138** | **142** |
| Y5 | `.rev` bad signature **+ `.pack` `chmod 000`** | **78** | **74** | **74** | **78** |
| Y4 | `.bitmap` trailer flipped **+ `.pack` deleted** (`.idx` kept) | **10** | 10 | 10 | 10 |
| Y6 | `.rev` bad signature **+ `.pack` deleted** (`.idx` kept) | **10** | 10 | 10 | 10 |
| B20/B24 | `.rev` **and** `.bitmap` both corrupt | **192** | — | — | — |
| C1 | `.idx` corrupt (carries bit 64 itself) | **78** | — | — | — |
| X10 | midx trailer flipped **+** midx bitmap corrupt | **32** — *not* 160 | 32 | 34 | — |

**Rules, as pinned.**

1. **Plain OR, one bit per cause, regardless of finding count.** `142 = 2|4|8|128`, `138 = 2|8|128`,
   `78 = 2|4|8|64`, `192 = 64|128`. Bit 128 is a peer of bits 4/32/64, not a sub-bit of any.
2. **Bits 64 and 128 fire for a pack refused at the header gate** (Y2, Y5): a `.pack` that exists
   but cannot be opened still has its `.rev`/`.bitmap` checked. Their term is **ungated** while
   bit 4's is not — Y3's `14 → 10` swing between full and `--connectivity-only` is bit 4 dropping
   out while bits 2|8 remain, exactly ADR-585/586's split.
3. **Bits 64 and 128 do *not* fire when the `.pack` is absent** (Y4, Y6 → `10`, no artefact bit),
   even though the `.rev`/`.bitmap`/`.idx` are all still on disk. git's pack set requires the
   `.pack`, so an orphaned `.idx`'s sibling artefacts are never named. **This is the same universe
   ADR-579 already gives tsgit** — an orphaned `.idx` is excluded at scan time — so the two agree
   for free, and §D4/§D5's universe choice is what keeps them agreeing.
4. Together with Pin H C1 ≡ C2, the universe is now fully pinned from both ends: the artefact checks
   run over packs whose **`.idx` loads and whose `.pack` exists**, and are independent of whether
   the `.pack` *opens*.

### Pin M — tsgit today (structural, read off the code)

Not run as a matrix because the answer is structural and total: `isCandidate`
(`pack-registry.ts:194`) admits only `*.idx`, and no file in `src/` opens a `.rev` or a `.bitmap`.
tsgit's column is therefore **`0` for every Pin H, I, J and K row except the `.idx`-caused ones** —
i.e. identical to git's `.rev`-deleted / `.bitmap`-deleted column. The read-path rows are faithful
by accident and stay faithful; the `fsck` rows are the divergence.

## Requirements

Verifiable at ship time.

1. **The exit integer matches git on every Pin H/I/J/K/L row.** Bit 64 fires for a `.rev` that
   exists, is readable and fails any of git's three check families; bit 128 fires for a `.bitmap`
   (pack or midx) whose own digest disagrees. Both compose by plain OR and are **ungated by mode** —
   default, `--connectivity-only`, `--no-full` and `--strict` (Pin I, Pin L Y1).
2. **Absent, unreadable and orphaned artefacts are non-events** — no finding, no bit, no rejection
   (R11–R13, B1, B12, B23, X5–X7). An unreadable artefact is silent even in the logger, because
   git is (R12).
3. **`.rev` version accept-set is exactly `{1}`**; `hashId` accept-set is `{1, 2}` and is **not**
   cross-checked against the repository (R16). Neither is stricter nor laxer than git.
4. **The `.rev` size rule is exact** — `12 + 4·N + 2·digestLength` — with the short case and the
   wrong-length case distinguished at the `12 + 2·digestLength` boundary (R7d vs R7c, R6/R8 vs R17),
   because they are separate refusal conditions with separate git messages.
5. **The `.rev` body cross-check is exhaustive**: every position whose stored value differs from
   the value derived from the `.idx` yields its own finding (N1), and the bit is set once.
6. **A `.rev` for a pack whose `.idx` is unusable produces no additional finding** (C1 ≡ C2).
7. **No `.rev` or `.bitmap` fault ever fails a read**, changes a lookup result, or changes
   `enumerateObjects`' output. Byte-identical results with and without both artefacts, in health
   and in every corruption row — this is the property the interop twin pins.
8. **The bitmap obligation is the digest and nothing else** (Pin J rules 1–2). tsgit reads no
   bitmap header, no EWAH stream and no flag word unless DC-3 rules otherwise; the six RESTAMPED
   rows are interop rows precisely so a future EWAH parser cannot silently make tsgit stricter.
9. **A midx bitmap is found via the midx's *stored* trailer bytes**, so a midx with a wrong trailer
   hides its bitmap (X10 → 32, not 32\|128), and the check is skipped where git skips it.
10. **Hash-generic in the parser**: `digestLength` is a parameter; no branch on 20 vs 32 (Pin G).
    The pack subsystem's pre-existing SHA-1-only limit (B-10) is neither widened nor narrowed.
11. **Path safety is total.** Both artefact names are derived from a pack base name the scan already
    vetted with `isSafePackName`, or from a midx trailer rendered as hex — never from bytes inside
    either artefact. Neither format contains a name (§D12 T-1).
12. **Bounded reads.** Each artefact is `stat`-then-read-then-rechecked against its own named bound
    before any allocation sized by a declared count (ADR-600's shape, DC-9).
13. **No `DataView` read at an unproven offset.** A `RangeError` escaping the parser is a defect,
    not an error path (T-4).
14. **No swallowed reason.** Where a fault is not propagated it reaches `ctx.logger?.warn?.` with
    the artefact name — **except** where git is silent (R12/B12/X6), which tsgit matches.
15. **Structured data only** (ADR-249): findings carry `{ type, pack | artefact, reason }`; git's
    `error:` lines are reconstructed inside the interop test.
16. **The #263 handle lifecycle is untouched.** Both artefacts are read whole via `ctx.fs.read` and
    hold no `FileHandle`; opened-minus-closed stays 0.
17. **Write-path symmetry**: tsgit gains no `.rev`/`.bitmap` write surface, and §D11's checklist is
    green with no new `@writes` annotation.
18. **Every public API change is deliberate** — new `FsckFinding` variants and any new domain export
    appear in `reports/api.json` on purpose, and `FsckResult.exitCode`'s doc-comment gains bit 128.
19. **The pass universe is `registry.all()`** (§D4): a pack refused at the header gate **still** has
    both artefacts checked (Pin L Y2/Y5); a pack whose `.idx` is unparseable, or whose `.pack` is
    missing, has **neither** (Pin H C1 ≡ C2, Pin L Y4/Y6). Neither pass ever opens a `.pack`.

## Design

### §D1 — the scope boundary, stated before anything else

The brief asks for honesty about whether the payload is a live acceleration path or a
verify-and-report surface. **It is overwhelmingly the latter**, and the evidence is a consumer
census, not a judgement:

| capability the artefacts accelerate | tsgit surface | verdict |
|---|---|---|
| `verify-pack`-style enumeration | none — no such command | no consumer |
| reachability closure / object counting | `fsck`'s reachability pass | **must not** use a bitmap: fsck's job is to verify the graph, not to trust a cached answer about it |
| `pack-objects` object selection | `buildPack` (`build-pack.ts`) sources every object through `readObject` | no bitmap entry point; a bitmap gives reachability, not bytes |
| fetch/push negotiation | `fetch-pack.ts` / `push` | tsgit negotiates by ref advertisement, not by bitmap |
| full-universe enumeration | `enumerateObjects` | served directly from `allObjectIds(index)` — a bitmap is strictly less information |
| **offset → pack position** | **`buildOffsetTable` (`pack-registry.ts:219`)** | **the one real consumer**, and it is `.rev`'s, not the bitmap's (§D7) |

So, plainly:

- **`.bitmap`: no consumer exists or is foreseeable in tsgit's current command set.** Its entire
  faithful payload is *"hash the file, compare the trailer, emit bit 128"* — Pin J rule 1. Building
  an EWAH parser would be code with one caller (its own test). DC-3 puts "ship the verdict only"
  against "ship the parser dark" against "defer the whole artefact".
- **`.rev`: one genuine consumer** (`buildOffsetTable`) plus the `fsck` obligation. DC-2 separates
  the two, because the `fsck` arm is required for faithfulness and the acceleration arm is not.

This is the honest shape of the entry, and it inverts the brief's cost model: the *parsers* are the
optional part and the *verdicts* are the obligation.

### §D2 — the `.rev` domain parser: `src/domain/storage/rev-index.ts`

Mirrors `pack-index.ts` and `midx.ts` so all three read as siblings.

```ts
export interface PackRevIndex {
  readonly version: 1;
  readonly hashId: 1 | 2;
  readonly digestLength: number;
  readonly objectCount: number;
  /** The embedded copy of the pack checksum. Retained, NOT compared (Pin H R10b). */
  readonly packChecksum: Uint8Array;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}

/** `objectCount` comes from the pack's own `.idx` — the parser cannot derive it
 *  (Pin B: the file carries no count, only a length that implies one). */
export function parsePackRevIndex(
  bytes: Uint8Array,
  digestLength: number,
  objectCount: number,
): PackRevIndex;

/** Index position of the object at pack position `p`. Bounds-checked. */
export function revIndexPositionAt(rev: PackRevIndex, p: number): number;
```

Parse order, each step gated on the previous (this ordering is what makes requirement 13 true):

1. `bytes.length >= REV_HEADER_SIZE (12) + 2 * digestLength` → else `check: 'size'`, reason
   `too small` (rows R6/R7/R8/**R7d**).
2. magic `{'R','I','D','X'}` → `check: 'signature'` (R1).
3. version `=== 1` → `check: 'version'` (R2/R3). **Not** `{1,2}` — this is the one place a reader
   arriving from the midx will over-generalise.
4. `hashId ∈ {1, 2}` → `check: 'hash-id'` (R5). **No comparison against `digestLength`** — R16
   pins that git accepts the disagreement. Recorded as a field, never a gate.
5. `bytes.length === 12 + 4 * objectCount + 2 * digestLength` → `check: 'size'`, reason `corrupt`
   (rows **R7c**/R7b/R17). Distinct reason from step 1's, because git's two messages are distinct,
   and R7d↔R7c pins the boundary between them one byte apart.

`revIndexPositionAt` reads `view.getUint32(12 + 4 * p)` after `p < objectCount`; the **value** is
not range-checked here (a value ≥ `objectCount` is a *verification* verdict, §D4, not a parse
refusal — R14 is reported by `fsck`, not by the loader).

**`objectCount` is a parameter, not a derived value.** It could be derived as
`(len − 12 − 2·digestLength) / 4`, but then step 5 becomes tautological and R17 could never be
detected. Passing it in is ADR-577's rule (cross-checks belong to the caller, which holds the
`.idx`) and it is what makes the format self-checking at all.

**No EWAH / bitmap parser ships** under the recommended scope (§D1, DC-3). If DC-3 rules otherwise,
Pin D and Pin E are the complete specification and the parser belongs in a sibling
`src/domain/storage/bitmap.ts` with the same shape.

### §D3 — discovery: a sibling-artefact listing, at zero extra I/O

Both artefacts are named entirely from things the registry already holds, so **neither format ever
contributes a path component** (requirement 11):

| artefact | name | source |
|---|---|---|
| pack `.rev` | `<packBaseName>.rev` | `packBaseName(idxEntryName)` (`pack-shared.ts:69`), already `isSafePackName`-vetted |
| pack `.bitmap` | `<packBaseName>.bitmap` | same |
| midx `.bitmap` | `multi-pack-index-<hex>.bitmap` | `bytesToHex` of the **stored** trailer slice of the in-use midx layer — the same `head._bytes.subarray(bodyEnd)` `verifyMidxTrailer` (`midx-binding.ts:298-303`) already takes (Pin K rule 3) |

`scanPacks` already does one `readdir` of `objects/pack/` and keeps the entry list to apply ADR-579's
sibling-`.pack` rule. **Presence** of `<base>.rev` / `<base>.bitmap` is read off that same listing —
no extra syscall, and `entry.isFile` excludes symlinks and directories exactly as the `.idx` filter
does (T-8). The artefacts are then *read* only when a consumer asks (the fsck pass, or §D7).

Where the code lives is DC-7; the recommendation and its shape are argued there.

### §D4 — the `fsck` `.rev` pass

**The universe first, because it is pinned from both ends and it is the easiest thing to get wrong.**
The pass runs over **`registry.all()`** — packs the scan admitted (`.idx` present *and* parseable,
sibling `.pack` present per ADR-579) — and **not** over `health().accessible`:

| shape | git | tsgit's matching universe |
|---|---|---|
| `.idx` unparseable | no `.rev` check (Pin H C1 ≡ C2) | the pack is never registered — `indexFaults`, not `all()` |
| `.pack` absent, `.idx` present | no `.rev`/`.bitmap` check (Pin L Y4/Y6) | ADR-579 excludes the orphaned `.idx` at scan time |
| `.pack` present but unopenable | **`.rev`/`.bitmap` checked** (Pin L Y2/Y5) | in `all()`; refused only by the header gate, which `all()` does not apply (ADR-572) |

So `all()` is exactly right, ungated, in every mode — and it must **not** be narrowed by
`packAccessibilityReported`, or Y2/Y5 would lose their bits in `connectivityOnly`. Note the cost
this inherits rather than introduces: `all()` under ADR-597 is lazy, and the `.rev` size rule needs
`objectCount`, so the pass forces every `.idx` parse in every mode. That is precisely the trade
ADR-586's post-review note already accepted for bit 64 (*"read and parse every `.idx` but never open
a `.pack`"*), and **neither new pass ever opens a `.pack`**, so the note's guarantee is preserved
verbatim.

git's three check families (Pin H rule 3) then map onto three steps per pack:

```
for each pack p in registry.all() with a <base>.rev present and readable:
  index = await p.index()                       // ADR-597 made this a lazy accessor
  1. load    parsePackRevIndex(bytes, digestLength, index.objectCount)
             → refusal ⇒ finding{reason = the check's reason}, bit 64, next pack
  2. digest  hash(bytes[0 .. len−dl)) == bytes[len−dl ..]
             → false ⇒ finding{reason = 'invalid checksum'}, bit 64
  3. body    expected = indexPositionsInPackOrder(index)
             for each position q in [0, N): stored[q] != expected[q]
             ⇒ one finding per mismatch, bit 64
```

Four things this shape settles, each against a pinned row:

- **Steps 2 and 3 both run** even when 2 fails (N2 emits `invalid checksum` *then* the position
  lines). Step 1 failing **skips** 2 and 3 — git cannot verify a file it could not load.
- **`expected` is the index positions ordered by offset.** Concretely: sort the index positions
  `[0, N)` by `entryOffsets(index)[i]`; the resulting array **is** the healthy `.rev` body (Pin B's
  correlation is exactly this). tsgit already computes the sorted *offsets*
  (`buildOffsetTable`) and discards which index position each came from; this pass needs the
  positions, so it is a **new derivation**, not a reuse — naming it here so the implementer does not
  try to thread it through `PackOffsetTable`, whose shape ADR-572's consumers depend on.
- **An out-of-range stored value is a step-3 mismatch, not a parse refusal** — R14 produces
  `invalid rev-index position at 0: <expected> != 999`, i.e. git compares it like any other value. Refusing
  it at parse time would move the finding into the wrong family and change the message.
- **`packChecksum` is never compared** (R10b). It is parsed and retained so a future
  `verify-pack`-class surface has it, and its non-use is asserted by an interop row rather than left
  to inspection.

Whether this widens `pack-rev-index-unusable` or adds a variant is DC-5.

### §D5 — the `fsck` bitmap pass: `internal/fsck/bitmap-health.ts`

ADR-589's shape, and the smallest pass in the codebase:

```ts
export async function runBitmapHealthPass(
  ctx: Context,
  _opts: FsckOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }>;
```

`opts` is taken for symmetry and **ignored** — Pin J/K's mode rows are flat, the ADR-586 posture.

Its whole body, in order — over the **same `registry.all()` universe** §D4 argues for, for the same
reason and with the same Pin L Y2/Y4 evidence:

1. For each pack in `registry.all()` with `<base>.bitmap` present **and readable**: hash
   `[0, len − digestLength)`, compare to the trailing `digestLength` bytes. Mismatch ⇒
   `{ type: 'bitmap-checksum-mismatch', artefact: '<base>.bitmap' }` and `exitBit |= 128`.
   **`len < digestLength` is a mismatch, not an arithmetic edge** — a zero-length file and a
   10-byte file both score 128 under git (B11, B25), so the length guard must come *first* and
   produce the finding, never a negative `subarray` bound. This is the one place the "hash and
   compare" one-liner is wrong.
2. If a usable midx exists, compose `multi-pack-index-<hex(storedTrailer)>.bitmap` and do the same.
   **Not present ⇒ nothing** — which is how X7 and X10 come out right without a special case: a
   renamed file, or a midx whose stored trailer is wrong, simply names a file that is not there.
   **The trailer bytes come from `LoadedMidx`, not from `MidxHealth`** — `midxHealth()` exposes the
   artefact *name* and a `checksumOk` boolean, not the layer's `_bytes`, so this step needs the
   generation's `midx` (or a new accessor). That asymmetry is one of DC-7's inputs.
3. Unreadable ⇒ nothing, silently (B12, X6).

**No header parse, no version gate, no flag gate, no EWAH.** Pin J rows B14–B19 are the licence,
and they become interop rows so that a later EWAH parser cannot make tsgit stricter than git without
turning a test red.

**Ordering matters for exactly one thing and it is not correctness**: the pass must run where a
usable midx's identity is already settled (`registry.midxHealth()` or the generation), which
`fsck.ts`'s existing sequence guarantees — `runMidxHealthPass` is already at line 106.

The `core.multiPackIndex` gate on step 2 (Pin K rule 2) has no tsgit analogue: `readConfig` has no
such key and ADR-592 declined to add one. Step 2 is therefore **unconditional**, matching git's
default configuration and diverging only from an explicitly-disabled one — the same call §D12.2 of
the midx design made, restated rather than assumed.

### §D6 — degradation posture on the read path

**There is no Tier A here, and there is no Tier B either — there is nothing.** Pin H and Pin J have
no row where a read fails, no row where a lookup result changes, and no row where enumeration
changes. Both artefacts are, on the read path, *purely* advisory.

Concretely, under the recommended scope:

| condition | read path |
|---|---|
| `.rev` absent / unreadable / corrupt in any way | unchanged — `buildOffsetTable` sorts, as today |
| `.bitmap` absent / unreadable / corrupt in any way | unchanged — never opened |
| either artefact orphaned | unchanged — never named |

Under DC-2(a) (`.rev` as a live accelerator), exactly one arm appears and it is the classic
per-artefact degradation ADR-575 fixed: `loadRevIndex` returns `undefined` on **any** fault, the
sort runs, one `warn` is recorded, and the fault is discriminated by a **positive** allow-list over
`TsgitError.data.code` (`INVALID_PACK_REV_INDEX`, `FILE_NOT_FOUND`, `PERMISSION_DENIED`) with
everything else rethrown — never `if (isFatal) throw`, which would swallow a future member. That
inversion is ADR-599's §D4.2 argument, reused verbatim.

### §D7 — the acceleration arm, priced (DC-2)

`buildOffsetTable` becomes, when a usable `.rev` is present:

```ts
const raw = entryOffsets(index);                 // unchanged — the .idx is still required
const sortedOffsets = new Array<number>(n);
for (let p = 0; p < n; p += 1) sortedOffsets[p] = raw[revIndexPositionAt(rev, p)]!;
```

| | today | with `.rev` |
|---|---|---|
| CPU | `Array.prototype.sort` — O(n log n) on numbers | O(n) gather |
| I/O | 0 extra | 1 extra file read, `4n + 12 + 2·dl` bytes (≈ 1/6 of the `.idx`) |
| memoisation | once per pack per `Context` | unchanged |

**The claim must be measured, not asserted** — a many-pack, many-object bench row (§Test strategy),
sourced from the CI nightly artefact, never a local run. The honest prior is that this is a **small**
win on a path that already runs once per pack per `Context`, and that it could be a **loss** on a
repository with many small packs, where the extra `open`/`read` per pack outweighs sorting a few
hundred numbers. That risk is the substance of DC-2, and the bench is its resolution.

**A trusted `.rev` is a correctness surface.** `sortedOffsets` feeds `nextOffsetForEntry`, which
decides where a packed entry's compressed data ends. A `.rev` with a wrong body silently produces
wrong slice bounds — inflate then fails, or worse, succeeds on a truncated stream. Git accepts that
exposure (it trusts the `.rev` on read; R14 reads fine and only `--test-bitmap` notices). DC-4 asks
whether tsgit does too, and what verification, if any, it buys back.

### §D8 — error semantics

| condition | today | after | git |
|---|---|---|---|
| any read, any `.rev`/`.bitmap` state | succeeds | **unchanged** | Pin H/J `cat-file` |
| `fsck`, `.rev` fails a load check | exit 0, no finding | `pack-rev-index-unusable`-class finding + bit **64** | R1–R8, R7b–R7d, R17 |
| `fsck`, `.rev` digest wrong | exit 0 | finding + bit **64** | R9b |
| `fsck`, `.rev` body wrong | exit 0 | **one finding per mismatched position** + bit **64** | R14, R15, N1 |
| `fsck`, `.rev` hashId 2 in a SHA-1 repo | exit 0 | **exit 0, no finding** | R16 |
| `fsck`, `.rev` embedded pack checksum wrong | exit 0 | **exit 0, no finding** | R10b |
| `fsck`, `.idx` unusable (`.rev` state irrelevant) | bit 64 (existing) | **unchanged** — no second finding | C1 ≡ C2 |
| `fsck`, `.bitmap` digest wrong (pack or midx) | exit 0 | `bitmap-checksum-mismatch` + bit **128** | B2–B11, X1, X4, X8 |
| `fsck`, `.bitmap` structurally corrupt but digest valid | exit 0 | **exit 0, no finding** | B14–B19 |
| `fsck`, midx trailer wrong **and** midx bitmap corrupt | exit 0 | bit **32** only, **never 128** | X10 |
| either artefact absent / unreadable / orphaned | exit 0 | **exit 0, no finding, no warn** | R11–R13, B1, B12, B23, X5–X7 |
| `fsck`, artefact corrupt **+ `.pack` refused at the header gate** | bit 4 (existing) | bit 4 **and** the artefact bit | Y2 (142), Y5 (78) |
| `fsck`, artefact corrupt **+ `.pack` absent** (orphaned `.idx`) | exit 0 | **no artefact bit** — the pack is not in `all()` | Y4, Y6 (10) |
| `fsck`, `.bitmap` shorter than one digest | exit 0 | `bitmap-checksum-mismatch` + bit **128** | B11, B25 |

**Six rows in this table end `exit 0, no finding`** (R16, R10b, B14–B19, X10, Y4/Y6) and they are
the design's hardest-won content: each is a place where an obvious-looking check would make tsgit
*stricter* than git, and stricter is still a divergence. They outnumber the rows that add a bit.

### §D9 — cache and invalidation

- Artefact presence is settled inside `scanPacks`, so it rides the existing scan
  `createPromiseMemo`: single-flight, rejection never memoised, cleared by `refresh()`, `dispose()`
  terminal (PR #263 §9, unchanged).
- Under DC-2(a), the per-pack `.rev` load is a **new** `createPromiseMemo` beside `indexMemo` /
  `headerMemo` / `offsetTable` — the pattern `registered-pack` already uses four times.
- The fsck passes' verdicts are memoised **per generation** if they gain a registry accessor
  (DC-5/DC-7), following ADR-581. If they read files directly in the pass, they are not memoised at
  all, which is fine because `fsck` runs each pass once.
- **No `FileHandle`.** Both artefacts are read whole via `ctx.fs.read` (requirement 16).
- **Interop tests that let real `git` write or mutate these artefacts must build a fresh `Context`
  afterwards** — a `Context` constructed before the subprocess holds a memoised generation that
  predates it. Hard rule, not a note.

### §D10 — hash-width genericity (explicit checklist)

| # | site | rule |
|---|---|---|
| H-1 | `parsePackRevIndex` | takes `digestLength`; never reads `ctx.hashConfig`; never hard-codes 20 or 32 |
| H-2 | `.rev` `hashId` field | recorded, **never** mapped to a width and **never** compared to anything (R16). The one field a midx-trained reader will wrongly gate on |
| H-3 | `REV_HEADER_SIZE = 12` | hash-independent (Pin B) |
| H-4 | `.rev` size rule | `12 + 4·N + 2·digestLength` — **two** digests, not one; and the too-small/corrupt split is at `12 + 2·digestLength` (R7c/R7d) |
| H-5 | both trailer verifications | `ctx.hash.hash(bytes.subarray(0, len − digestLength))` with the algorithm from **`ctx.hashConfig`** — the repository's, exactly as `verifyMidxTrailer` (`midx-binding.ts:301`). **This is the opposite of the midx rule** (§D9 H-5 of `midx-read-support.md` selects the algorithm from the midx's own `hashVersion` byte). Pinned, not assumed: R16 restamps a `hashId = 2` `.rev` with **SHA-1** and git accepts it, so git is using the repo's algorithm and ignoring the field. Copying the midx's rule here would refuse a file git reads |
| H-6 | midx bitmap filename | `2 × digestLength` hex, not `40` |
| H-7 | `.bitmap` header offsets | checksum at byte 12, body at `12 + digestLength` — the **only** width-dependent offset in the format, and unused under the recommended scope |
| H-8 | the surrounding subsystem | `IDX_SHA_LENGTH = 20` stays a pre-existing SHA-1-only limit (B-10); neither widened nor relied on. SHA-256 rows are parser/pass units, per Pin G |

### §D11 — write-path symmetry (explicit checklist)

Read-only. The checklist exists because "read-only" is where write-side hazards hide.

| # | write surface | interaction | verdict |
|---|---|---|---|
| W-1 | `serializePackfile` / `serializePackIndex` (`pack-writer.ts`) | writes `.pack` + `.idx`, **no `.rev`**, **no `.bitmap`** | **a live cross-tool hazard, and it is pre-existing**: git writes `.rev` by default (Pin A), so a tsgit-written pack lands beside git-written packs that all have one. Harmless today (R11: a missing `.rev` is a non-event) and it stays harmless — but it means a tsgit repository is *distinguishable* from a git one, and any future tsgit `repack` must decide whether to write `.rev`. Named, not fixed. |
| W-2 | `materializePack` (`fetch-pack.ts`) | writes a fetched pack | no `.rev`/`.bitmap` arrives with it (they are local artefacts, never transported); nothing stale can be created |
| W-3 | **overwriting a pack in place** | would orphan a stale `.rev`/`.bitmap` | structurally impossible — pack file names are content-addressed, so a rewritten pack has a new name and its own (absent) artefacts |
| W-4 | any future `gc` / `repack` / `prune` | **deletes packs** | a deleted pack's `.rev`/`.bitmap` must be deleted with it, or the directory accumulates orphans. Orphans are *harmless* (R13/B23: git ignores both), so this is hygiene, not correctness — a strictly weaker constraint than the midx's (§D8 W-4 there), and it is worth recording that the two differ. Parking-lot constraint, restated in §Out of scope. |
| W-5 | `tooling/audit-write-surfaces.ts` | scans for annotated write surfaces | no new write surface ⇒ no new `@writes` annotation, no allowlist entry; the gate stays green untouched |

### §D12 — threat model

The subject is two binary formats an attacker with **repository write access** fully controls. They
are **not** network artefacts — no transport delivers either (W-2) — which bounds but does not remove
the exposure: a hostile `.git` arrives via a cloned tarball, a shared checkout, a CI cache restore,
or a vendored fixture.

| # | concern | assessment |
|---|---|---|
| T-1 | **Neither format contains a name or a path** | The single biggest structural advantage over the midx, and it is worth stating as a *finding*, not an omission: `PNAM` made traversal the midx's top risk (its T-1); `.rev` and `.bitmap` carry only integers and digests. Every filename involved is composed from an already-vetted pack base name or from hex-rendered digest bytes (§D3), so the traversal class is **absent by construction**, not mitigated. |
| T-2 | **Unbounded allocation from a declared count** | `.rev` has **no declared count** — its length implies one, and step 5 pins it against the `.idx`'s. So the only allocation is bounded by the file, and the file by its own bound (DC-9). `.bitmap` **does** declare counts (`entryCount`, per-stream `wordCount`) and B21's `0x7fffffff` is the live shape — but under the recommended scope tsgit never reads them. If DC-3 ships a parser, every stream length must be validated against the remaining buffer **before** allocation, git's own `eof in data` check; that requirement moves from theoretical to binding the moment DC-3 flips. |
| T-3 | **Decompression-bomb-shaped EWAH runs** | An RLW can declare a clean run of 2³² words = 2³⁸ bits. Materialising that as a JS array is 32 GiB. **Mitigation under the recommended scope: none needed — nothing decodes EWAH.** Under DC-3(b)/(c) the mitigation is mandatory and specific: decode **lazily** (iterate runs, never materialise), and bound the total decoded bit count by the pack's `objectCount`, which is knowable and small. This is the highest-severity item in the whole design and it exists **only** in the scope options that ship an EWAH parser — which is itself an argument for DC-3(a). |
| T-4 | **Out-of-bounds `DataView` reads** | `.rev` parse steps 1 and 5 prove the exact file length before any body read, and `revIndexPositionAt` bounds `p` against `objectCount`. A `RangeError` escaping the parser is a defect (requirement 13). |
| T-5 | **Integer overflow in offset arithmetic** | `.rev` values are u32 index positions, not offsets — they index `entryOffsets`, whose own 64-bit handling (`readOffset`, `pack-index.ts:93-108`) is untouched. `.bitmap` positions are likewise u32 bit indices. **No offset arithmetic is introduced by either format**, which is why this row is short: the hazard lives one layer down and is not reached differently. |
| T-6 | **A non-permutation `.rev` body** (duplicates / gaps / out-of-range) | The *correctness* hazard, and its severity is entirely a function of DC-2/DC-4. Under DC-2(b) (dark) it is inert — nothing consumes the body except the fsck pass, which is *comparing* it, not trusting it. Under DC-2(a) + DC-4(a) (trust, like git) a hostile body redirects `sortedOffsets`, so `nextOffsetForEntry` returns wrong slice bounds and a read either fails to inflate or inflates a truncated stream. That is **git's own exposure** (R14 reads fine under git), so adopting it is not a new class — but tsgit would be adopting it *by choice*, on a path where the alternative (sorting) is already correct and already shipped. Weighed explicitly in DC-4. |
| T-7 | **A stale `.rev`/`.bitmap` paired with the wrong pack** | Undetectable by design: git stores the pack checksum in both files and **checks neither** (R10b, B16). Since a pack's filename is its content hash, a stale artefact can only arise from a deliberate rename, which requires the same write access as replacing the pack. Accepted, matching git; the residual is that tsgit cannot warn about it either without diverging. |
| T-8 | **Symlinked artefacts** | Presence comes from the `readdir` listing with `entry.isFile` (§D3), which excludes symlinks exactly as the `.idx` filter does, so a symlinked `.rev` pointing outside the repository is never opened. This is a *stronger* posture than the midx's flat-file open-by-path (its T-8) and it costs nothing because the listing is in hand. |
| T-9 | **Log injection** | Neither format carries text. The only string in any finding is a pack base name already vetted by `isSafePackName` (control characters rejected) or a hex digest. `faultContext`'s "never nest a name inside `err.data`" rule still applies. |
| T-10 | **A degraded universe feeding a destructive computation** | Structurally absent: tsgit has no `gc`/`prune`, and neither artefact can *remove* an object from any universe — unlike the midx, which subtracts (ADR-592). Both are additive-or-ignored, in every pinned row. Becomes a hard constraint on any future pruning surface that would consult a bitmap for reachability: **it must not**, for the same reason `fsck` must not (§D1). |
| T-11 | **Work amplification at `fsck` time** | The `.rev` body cross-check is O(n) per pack and the digest checks are O(file) — one full hash of every `.rev` and every `.bitmap` in the repository, per `fsck` run. On a large repository with bitmaps that is tens of MiB of hashing. git pays exactly the same (`verify_bitmap_files` hashes every bitmap), so this is parity, not overhead; it is named because `fsck`'s cost profile changes measurably and the bench should see it. |

### §D13 — blind spots, named

1. **`verify-pack` is stricter than `fsck` and tsgit models neither.** Rows R10b and R16 exit 0
   under `fsck` and 1 under `verify-pack`. tsgit has no `verify-pack` surface, so it inherits
   `fsck`'s laxity by default. If a `verify-pack`-class command ever lands it must re-pin this,
   because the two commands genuinely disagree about what a valid `.rev` is.
2. **The `.rev`'s embedded pack checksum is dead data in both tools.** §D2 retains it precisely so
   that a future consumer does not have to re-parse; today its non-use is a deliberate divergence
   from what the field *appears* to be for.
3. **`0x2` in the bitmap flag word was never observed.** Pin E is a matrix over configurations git
   2.55.0 offers, not over the format's value space. Under DC-3(a) this does not matter (no flag is
   read); under DC-3(b)/(c) it is an unpinned bit and the parser must not assume its meaning.
4. **git aborts (`BUG:`, exit 134) on a bitmap without the mandatory full-DAG option** (B19). That is not
   behaviour to replicate and tsgit cannot replicate it faithfully — a library has no process to
   abort. Under the recommended scope the row is unreachable. Under DC-3(b)/(c) tsgit must choose,
   and no choice is faithful; naming it here rather than discovering it in review.
5. **Pin K rule 3's midx-trailer coupling is transitive and fragile.** If ADR-602's trailer
   verification ever moves onto the read path, or if the midx's in-use artefact selection changes,
   the midx bitmap's *discoverability* changes with it — a bitmap can be hidden by a fault in a
   different file. The interop row for X10 exists to catch that, and it is the row most likely to
   look like a test bug when it eventually fails.
6. **`fsck --no-full` adds a constant on an all-packed fixture** (Pin I M0 = 2), which makes raw
   exit comparisons in that mode read oddly. The interop assertions must compare **bit-wise**
   against a per-mode control, not against literals — the trap that would otherwise make M1's `66`
   look like a new bit.
7. **Bit ordering versus future bits.** git's `fsck` bitmask is `1, 2, 4, 8, 16, 32, 64, 128`.
   tsgit models `1, 2, 4, 8, 32, 64` today and **seven of the eight** after this change; **16
   (commit-graph) stays never modelled**, as does anything above 128. Worth stating so nobody reads
   "all bits modelled" into a denser `exit-codes.ts`.
8. **`pack.writeReverseIndex` could flip back.** The default is a git policy, not a format
   guarantee. Nothing here depends on the default — every row with the artefact absent is clean —
   but the *urgency* argument in §Context does.

## Decision candidates

Ten load-bearing choices. **None is decided here.** The recommendation column is the designer's
argument, not an outcome; ADR numbering continues from **603**.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | **Scope boundary** — what "read support" means for this entry | **(a) Verify-and-report only**: both artefacts are parsed/hashed solely to produce `fsck` findings and exit bits; the read path is untouched. **(b) (a) + `.rev` acceleration** of `buildOffsetTable`. **(c) Full read support**: (b) plus an EWAH parser and a bitmap-backed reachability path | **(a)** | The consumer census (§D1) is decisive: the only faithfulness debt is two `fsck` exit bits, and (a) pays it completely. (b) adds a correctness surface (T-6) and an unproven perf claim to a change whose value is otherwise certain — it is separable and should be separated. (c) builds an EWAH parser whose only caller would be its own test, and drags T-3 (decompression-bomb runs) into a design that currently has no such hazard. If (b) or (c) is wanted, take it as its own decision — which is exactly what DC-2 and DC-3 are |
| DC-2 | **`.rev` as a live accelerator, or dark** | **(a) Live**: `buildOffsetTable` consumes a usable `.rev` (§D7). **(b) Dark**: the parser ships, used only by the `fsck` pass. **(c) Live, behind an opt-in `Context` flag** | **(b)** | The win is O(n log n) → O(n) on a per-pack, per-`Context`, memoised path, bought with an extra file `open`+`read` per pack — plausibly a **net loss** on many-small-packs repositories, which is the shape that also has the most packs to pay it on. It is not "free speed"; §D7 prices it honestly and only a CI bench can settle it. (b) keeps every byte of the fsck payload and defers the risk at zero cost to the deliverable, and the parser it ships is the same parser (a) would need — so choosing (b) now costs nothing later. (c) is the worst of both: it keeps T-6's exposure while guaranteeing the fast path is under-exercised in tests and in the field |
| DC-3 | **Does an EWAH / bitmap parser ship at all?** — subsumes *"what is the bitmap version / flag accept-set"*, which has an answer only under (b)/(c) | **(a) No** — the bitmap pass hashes the file and nothing more (Pin J rule 1). **(b) Ship a header+EWAH parser dark**, exercised only by unit tests. **(c) Ship it and use it** for some reachability surface | **(a)** | Pin J rows B14–B19 are unambiguous: git's `fsck` exits **0** on a bitmap with a flipped magic, a bad version, an absurd entry count and a truncated body, provided the digest is restamped. A parser therefore buys **zero** faithfulness and can only make tsgit stricter than git — the failure mode ADR-593's `numBaseFiles` reversal was written about. It also imports T-3, the one genuinely dangerous allocation shape in this family. (b) is dead code by the project's own guardrail. (c) has no consumer (§D1) and would put a *trusted cached reachability answer* inside `fsck`, whose entire job is to distrust it |
| DC-4 | **Verify-or-trust the `.rev` body on the read path** — *only live if DC-2 = (a)* | **(a) Trust** (git's posture, R14). **(b) Verify the digest once per pack** before first use, then trust. **(c) Verify the body** against the sorted `.idx` before use | **(b)** | (a) is faithful but hands an attacker T-6 on a path where the safe alternative already ships. (c) is self-defeating: computing the expected body *is* the sort the `.rev` exists to avoid, so it costs more than it saves — a full O(n log n) plus a full comparison. (b) is the ADR-602 shape one layer out (verify the artefact's integrity, then trust its content), costs one hash of a file that is ~1/6 the `.idx`'s size, catches every accidental corruption, and diverges from git only in *refusing to use* a file git would use — never in an answer, because the fallback is the correct sort. That last clause is what makes (b) defensible under ADR-226 and it should be the ADR's ratio |
| DC-5 | **How bit 64's new cause is reported** | **(a) Widen the existing `pack-rev-index-unusable` variant** — same shape `{ pack, reason }`, new causes. **(b) Add a second variant** (e.g. `pack-rev-index-invalid`) distinguishing "the `.idx` made the rev-index unavailable" from "the `.rev` file itself is wrong". **(c) Widen, plus an optional `position` field** for the per-position body mismatches | **(b)** | ADR-583's rule is *one variant per layer, because layers compose differently on the exit axis* — and these two genuinely are different layers: C1 ≡ C2 proves an `.idx` fault **suppresses** the `.rev` check entirely, so a consumer that sees both variants knows something a single widened variant cannot express. git's own messages split the same way (`unable to load rev-index for pack` from an `.idx` fault versus `reverse-index file … has <cause>` from the file). (a) makes the two indistinguishable and quietly re-uses a doc-comment that promises a different cause. (c) is right about the data — N1's per-position findings need somewhere to put the position — but an optional field on a variant that mostly lacks it is the primitive-obsession shape ADR-584 avoided; if per-position findings ship, they want their own variant, which makes (c) a worse-spelled (b) |
| DC-6 | **Are per-position body mismatches individual findings?** | **(a) One finding per mismatched position**, carrying `{ pack, position, expected, stored }`. **(b) One finding per pack**, carrying a count. **(c) One finding per pack**, carrying no detail | **(a)** | N1 pins git emitting one line per mismatch with both integers, and per ADR-249 those integers are **data**, not presentation — the same call ADR-584 made for the pack name and ADR-601 made for `midx-entry-unresolved`'s oid. (b) and (c) throw away the only diagnostic content the check produces, on a check whose whole purpose is diagnosis. The cost of (a) is a finding array that can be O(objectCount) on a maximally-corrupt `.rev`; that is bounded by the pack and matches git's own output volume, but it is the one consequence the ADR should acknowledge |
| DC-7 | **Where the code lives** | **(a) Domain parser + everything else inline in the two fsck passes**, reading files through `ctx.fs` directly. **(b) Domain parser + a new `primitives/internal/rev-index-source.ts`** owning discovery, bounded read and fault classification, consumed by the passes (and by `buildOffsetTable` under DC-2(a)). **(c) Domain parser + new registry accessors** `revHealth()` / `bitmapHealth()`, memoised per generation | **(b)** | ADR-598's precedent for exactly this shape, one artefact family later, and it is the only option that stays correct across DC-2: under (b) the accelerator and the fsck pass share one loader, one bound and one fault classifier. (a) duplicates discovery and bounds into two passes and has no home for the accelerator. (c) is ADR-581's shape and would be right if the verdict were *shared* between consumers — but unlike `health()` / `midxHealth()`, nothing outside `fsck` wants these verdicts, so a registry accessor adds public surface and a memo for a single caller. Worth stating the counter-argument: (c) becomes correct the moment a second consumer appears |
| DC-8 | **Error discriminant shape for a `.rev` refusal** | **(a) New `INVALID_PACK_REV_INDEX { reason, check }`** with `check` a closed union (`'size' \| 'signature' \| 'version' \| 'hash-id'`), ADR-599's shape. **(b) New code with `reason` only.** **(c) Reuse `INVALID_PACK_INDEX { reason }`** | **(a)** | (c) is an active hazard, identically to ADR-599's argument: `isSkippableIdxFault` (`pack-shared.ts:37`) allow-lists `INVALID_PACK_INDEX` at the scan layer, so a `.rev` refusal would be laundered into "skip this pack" and could remove a healthy pack from the generation. (b) works today because the fsck pass only needs `reason` for display — but it makes the size/`corrupt` versus size/`too small` distinction (requirement 4) live in a string, and R17 vs R6 are *different git messages*, i.e. data. (a) costs one field and makes the mapping exhaustive at the type level. Its price, stated: `check` is public surface in `api.json` and its members become a compatibility commitment. **A weaker (b) is genuinely defensible here** in a way it was not for the midx, because no tier decision hangs off this union — the ADR should weigh that rather than inherit ADR-599 by reflex |
| DC-9 | **Bounds strategy for the two artefacts** | **(a) Dedicated `MAX_PACK_REV_BYTES` / `MAX_BITMAP_BYTES`** in `validators.ts` beside `MAX_MIDX_BYTES`, with the arithmetic in the doc-comment. **(b) Derive the `.rev` bound from the pack's `objectCount`** (the exact expected size is known — requirement 4) and give the bitmap a dedicated constant. **(c) Reuse `MAX_PACK_IDX_BYTES` (64 MiB) for both** | **(b)** | ADR-600's ratio is *"a new declared-count bound gets a bound sized by its own arithmetic, not a borrowed cap"* — and `.rev` can do better than a cap: its size is **exactly** `12 + 4·N + 2·digestLength`, with `N` already in hand from the `.idx`. A `stat`, then refusing anything whose size is not exactly that value, is both the bound **and** requirement 4's check, with no constant to justify and no repository class refused — and it is *transitively* bounded, because `objectCount` comes from an `.idx` already capped at `MAX_PACK_IDX_BYTES` (64 MiB ⇒ ~2.3 M objects ⇒ a `.rev` under ~9 MiB), so the ceiling exists without being invented. The bitmap has no such exact relation and does need a dedicated constant — sized from `objectCount` as a soft upper bound (a full bitmap over N objects is ~N/8 bytes plus per-commit bitmaps and the hash cache's 4N) rather than a flat number. (a) is correct but invents a constant where arithmetic exists; (c) repeats the mistake ADR-600 was written to correct |
| DC-10 | **Does the midx-bitmap check inherit git's `core.multiPackIndex` gate?** | **(a) No gate** — the pass always runs (matches git's default config). **(b) Add `core.multiPackIndex` to `readConfig`** and gate on it, matching git exactly. **(c) Skip the midx-bitmap arm entirely**, reporting only pack bitmaps | **(a)** | ADR-592 already declined to add `core.multiPackIndex` as a config surface, and §D12.2 of the midx design already made this exact call for the midx pass; making the same call twice from the same premise is consistency, not laziness. (b) is *more* faithful in the strict sense but adds a config key, a precedence question and a surface tsgit has no other use for — and the divergence it closes exists only in a configuration where the user has explicitly disabled the feature. (c) drops a real bit-128 cause (X1) to avoid a gate, which is the wrong trade. This is nonetheless a **named, deliberate divergence** and the ADR should record it as one rather than let it pass as an implementation detail |

**Coverage of the choices the brief named**, so none reads as dropped: *scope boundary* → DC-1;
*live-acceleration vs dark* → DC-2; *bitmap version/flag support matrix* → DC-3 (it exists only if a
parser ships); *verify-vs-trust posture* → DC-4; *fsck integration* → DC-5, DC-6, DC-10; *where
discovery lives* → DC-7; *error discriminants* → DC-8; *bounds strategy* → DC-9.

**One choice is deliberately *not* a candidate, because precedent settles it**: the bitmap finding's
identifier field. It carries `artefact` (the file name), not `pack`, and carries **no `reason`** —
the exact shape of `midx-checksum-mismatch` (`internal/fsck/types.ts:91`), for the exact same two
situations: a midx bitmap has no pack to name, and there is precisely one way to fail a checksum
(Pin J rule 2). Recorded here rather than left as a silent implementation choice.

## Test strategy

### Unit — `test/unit/domain/storage/rev-index.test.ts` (new)

Fixtures **crafted in-test** (ADR-578's precedent), from a `buildRevIndex({ objectCount, digestLength, hashId, body })` helper emitting Pin B's layout; every negative row is that builder plus one named mutation.

- **Accept**: 0 objects; 1 object; 12 objects; `hashId: 2` with `digestLength: 32` (the H-1 genericity row); **`hashId: 2` with `digestLength: 20`** — the R16 row, an *accept*, written as an accept deliberately with the reason in the title so a later "hardening" pass cannot silently turn it into a refusal.
- **Refusals**, each asserting `.data.check` **and** the reason string (never `toThrow(Class)`): zero-length; 11 bytes; `12 + 2·dl − 1` bytes (`too small`); `12 + 2·dl` exactly with `objectCount > 0` (`corrupt` — the R7c/R7d boundary, two rows one byte apart); one byte long; one byte short; bad magic; version 0; version 2; `hashId` 0; `hashId` 3.
- **Guard isolation**: the size guard has two arms with two different reasons (`too small` vs `corrupt`); each gets a row that triggers **only** it.
- `revIndexPositionAt` at `0`, `N−1`, and `N` (bounds refusal).

### Property — `test/unit/domain/storage/rev-index.properties.test.ts` (new)

Lens 1 (round-trip pair) and lens 3 (total function over a grammar) both fit:

- Round-trip: `parsePackRevIndex(buildRevIndex(spec))` reproduces every header field of `spec`, and `revIndexPositionAt` reproduces every body word, for arbitrary `objectCount ∈ [0, 500]`, `digestLength ∈ {20, 32}`, and **arbitrary body words including non-permutations and out-of-range values** — the parser must not care (§D2's `revIndexPositionAt` note). `numRuns: 200`.
- Totality: for any byte string in the declared safe subset, `parsePackRevIndex` either returns a `PackRevIndex` or throws a `TsgitError` with a `check` from the closed union — never a `RangeError` (requirement 13). `numRuns: 100`.

Generators live in a shared `arbitraries.ts` in the same directory.

### Unit — the passes

- `test/unit/application/commands/internal/fsck/bitmap-health.test.ts` (new): a table over Pin J/K — digest mismatch on a pack bitmap, on a midx bitmap, absent, unreadable, orphaned, **and every RESTAMPED structural corruption asserting no finding**. The RESTAMPED rows are the regression guard for DC-3(a).
- `test/unit/application/commands/fsck.test.ts` (extend): bit composition (64, 128, 192), and the **mode matrix** — each new bit asserted under default / `connectivityOnly` / `full: false` / `strict`, bit-wise against a per-mode control (blind spot 6).
- `test/unit/application/primitives/pack-registry.test.ts` (extend): under DC-2(a) only — `buildOffsetTable` produces **identical** `sortedOffsets` with and without a `.rev`, and falls back on each fault class.
- **Allow-list audit row** (ADR-599's precedent): `isSkippableIdxFault` and `isSkippablePackFault` return `false` for an `INVALID_PACK_REV_INDEX` error at **every** `check` value. Asserted, not inspected.

### Integration / interop — `test/integration/rev-bitmap-fsck-interop.test.ts` (new)

The faithfulness surface. One shared `beforeAll(fn, 60_000)` building the fixture repo with real
`git` (scrubbed `GIT_*`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off), then one row per
mutation, each in its own copy. **A fresh `Context` after every `git` subprocess** (§D9).

Per row: run real `git fsck`, run `tsgit.fsck()`, assert **`exitCode` equality** and assert the
tsgit findings reconstruct git's stderr lines (ADR-249 — reconstruction lives in the test).

Rows, from the pins: R0, R1, R2, R5, R6, R8, R9b, **R10b**, R11, R12, R13, R14, R15, N1,
**R16**, R17, C1, **C2**, and multi-pack composition. Then B0, B1, B2, B9, B12, B23, **B14**,
**B16**, **B18**, B24. Then X0, X1, **X2**, X4, X5, **X7**, X8, **X10**. Then the composition rows
Y1, Y2, Y3, **Y4**, Y5, **Y6**.

The **bolded** rows assert an exit code with **no** artefact bit where a naive implementation would
score one — they are the majority of the design's risk and they must not be trimmed. `R14`/`R15`/`N1`
assert the **cardinality** of the findings and the message *shape*, never the fixture-dependent
integer pair (Pin H's note).

### Integration / interop — `test/integration/rev-bitmap-read-invariance-interop.test.ts` (new)

Requirement 7, as a property over the corruption matrix: for every row above, `catFile` on every
object and `enumerateObjects` return **byte-identical** results to the same repository with both
artefacts deleted, in both tools. This is the twin the brief asks for, restated onto the axis where
a difference is actually observable.

### Bench

Only if DC-2 = (a): a `buildOffsetTable` row over a many-pack repository, and a many-small-packs
row, from the **CI nightly artefact** — never a local run, and reported as absolute wall-clock main
versus branch, never a self-share delta.

### Gates

`npm run validate`; 100% coverage on new domain/adapter code; Stryker scoped to the new files with
0 surviving mutants (equivalents proven against *this* structure, never carried forward);
`reports/api.json` regenerated for the new `FsckFinding` variants and any new domain export.

## Out of scope

- **Writing `.rev` or `.bitmap`.** No `--write-bitmap-index` analogue, no `pack.writeReverseIndex`
  behaviour. §D11 W-1 records the resulting cross-tool asymmetry (tsgit-written packs have no
  `.rev` where git's do) and W-4 leaves the parking-lot constraint: a future `gc`/`repack` should
  delete an outgoing pack's `.rev`/`.bitmap` — hygiene, not correctness, since orphans are ignored
  by both tools (R13, B23).
- **Any bitmap-backed reachability, counting or negotiation path** — DC-3's (c) option; no consumer
  exists (§D1), and `fsck` must not be one.
- **A `verify-pack` command surface.** git's is stricter than its own `fsck` (R10b, R16); tsgit
  models the `fsck` verdicts only. §D13.1 names the residual.
- **`git multi-pack-index verify`'s bitmap arm** — there isn't one (Pin K rule 4); the bitmap
  verdict lives only in `fsck`.
- **`core.multiPackIndex`** as a config surface — DC-10's (b) option, declined for the second time
  from the same premise as ADR-592.
- **The midx `{'R','I','D','X'}` and `{'B','T','M','P'}` chunks as *used* structures.** Pin F documents them and confirms
  28.2's parser correctly ignores them; consuming them requires a midx-bitmap reader, which is
  DC-3(c).
- **SHA-256 pack support.** Both parsers are hash-generic (§D10) but `IDX_SHA_LENGTH = 20` keeps the
  surrounding subsystem SHA-1-only (B-10). SHA-256 rows are parser and pass units.
- **Stderr transcript parity.** Per ADR-249, git's `error:` lines are presentation; tsgit emits none.
- **git's `BUG:`-and-abort behaviour on a bitmap without the mandatory full-DAG option** (B19) — not
  replicable by a library, and unreachable under the recommended scope. §D13.4.
