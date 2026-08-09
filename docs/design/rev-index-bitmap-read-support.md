# Design — reverse-index (`.rev`) + pack bitmap read support

> Brief: `.rev` and `.bitmap` are "currently ignored harmlessly (neither is required for object
> reads)". `.rev` maps pack position ↔ index position; `.bitmap` accelerates reachability closure.
> Lift: a `.rev` parser + generation check against git's, an EWAH bitmap parser, and interop pins
> comparing enumeration/reachability against real git with and without the auxiliary files.
>
> Status: **revised against ADRs 603–619** (all ratified, no open escalations) → self-reviewed
>
> **This revision supersedes the draft's scope.** Seventeen decisions were ratified; several deviate
> from the draft's recommendations and invalidate whole sections of it. What changed, in one place:
>
> | the draft said | the ratified decision |
> |---|---|
> | verify-and-report only; the read path is untouched | **full read support** — both `fsck` arms, the live accelerator, an EWAH parser, two new commands ([ADR-603](../adr/603-full-read-support-for-both-pack-auxiliary-artefacts.md)) |
> | `.rev` ships dark | `.rev` is a **live accelerator** in `buildOffsetTable`, with a **measured** perf claim ([ADR-604](../adr/604-rev-index-is-a-live-accelerator-for-the-pack-offset-table.md)) |
> | no EWAH parser (no consumer) | an EWAH parser **ships**, for consumption only — `fsck` still hashes and never parses ([ADR-605](../adr/605-an-ewah-bitmap-parser-ships-with-real-consumers.md)) |
> | verify the `.rev` digest before use | **trust**, exactly as git does; verification stays in `fsck` ([ADR-606](../adr/606-the-rev-index-body-is-trusted-on-the-read-path.md), [ADR-615](../adr/615-bitmap-closures-are-trusted-exactly-as-git-does.md)) |
> | midx bitmaps are `fsck`-verified only | midx bitmaps are **consumed**, via the midx reverse-index chunk ([ADR-617](../adr/617-midx-bitmaps-are-consumed-via-the-midx-reverse-index-chunk.md)) |
> | no new commands | **two** new Tier-1 commands: `rev-list` ([ADR-613](../adr/613-rev-list-ships-the-reachability-core-only.md)) and `pack-objects` ([ADR-614](../adr/614-pack-objects-ships-closure-to-pack-only.md)) |
>
> **Two later decisions settle the forks the first revision could not.**
> [ADR-618](../adr/618-closure-tier-selection-matches-git-per-command.md) makes the closure tier a
> **per-command** property — `rev-list` walks unless the caller asks for the bitmap, `pack-objects`
> uses a bitmap unless the caller refuses it — because that is what git itself does, measured in both
> directions (Pin AJ). [ADR-619](../adr/619-the-object-path-is-optional-and-absent-on-the-bitmap-tier.md)
> makes the object `path` **optional and absent on the bitmap tier**, again matching git. Both amend
> ADR-613 and ADR-616 in place: ADR-616's global *"automatic everywhere"* and its **unconditional**
> identical-sets obligation are **superseded** by a conditional, stronger invariant (requirement 16).
>
> **The draft's §D1 consumer census is falsified.** `enumeratePushObjects`
> (`src/application/primitives/enumerate-push-objects.ts`) and `enumerateBundleObjects`
> (`src/application/primitives/enumerate-bundle-objects.ts`) *are* reachability closures — exactly
> what a pack bitmap encodes. §D9 states the real consumer set and what this entry does about it.
>
> **Two of the brief's premises still do not survive the pins, and they still matter.**
>
> 1. *"Ignored harmlessly"* is true for **reads** and false for **`fsck`**: git 2.55.0 writes `.rev`
>    **by default** (Pin A) and a corrupt `.rev` sets `git fsck` exit **bit 64**, which tsgit today
>    sets only from the wrong cause. Bit **128** (`.bitmap`) is wholly unreported (Pin J).
> 2. **What the brief calls a "generation check" does not exist.** A `.rev` carries no generation
>    number and no version beyond `1`. Its only staleness signal is the embedded copy of the pack
>    checksum — and **`git fsck` does not check it** (Pin H row R10b). §D2 takes the consequence.
>
> **One new pin reframes the acceleration story and it is the most important sentence in this
> document**: on the bitmap path git's `rev-list --objects` emits **bare object ids with no path
> names at all** (Pin AA, re-measured as Pin AJ7). A bitmap carries reachability and type; it carries
> no paths. ADR-619 ratifies the consequence — an optional `path` — and everything §D7 says about
> `rev-list --objects` follows from that measurement.

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
file: `isCandidate` (`pack-registry.ts:177`) admits only names ending `.idx`, so both artefacts are
invisible to discovery, and there is no EWAH code anywhere in the repository.

That is exactly correct for the **read** path — Pin H's `cat-file` / `batch-all` columns are `0` in
every measured row, with and without either artefact — and it is **incomplete** for `fsck`:

| repo shape | git 2.55.0 `fsck` | tsgit today | gap |
|---|---|---|---|
| corrupt `.idx` | 78 (`2\|4\|8\|64`) | bit 64 set (via the `entry.layer === 'index'` arm) | none — ADR-586 is right about this cause |
| corrupt `.rev`, healthy `.idx` | **64** | **0** | **bit 64 never fires** |
| corrupt `.bitmap` | **128** | **0** | **bit 128 does not exist as a constant** |
| both | **192** | **0** | both |

### The real consumer set — the census, corrected

The draft concluded "no bitmap consumer exists or is foreseeable". That was wrong about the code in
front of it. Corrected, with the shape of each closure measured off the source:

| capability a bitmap accelerates | tsgit surface | closure semantics today | can a bitmap serve it? |
|---|---|---|---|
| push object selection | `enumeratePushObjects` (`enumerate-push-objects.ts:77`) | walks commits `from: wants, until: haves`, then walks **every interesting commit's whole tree** and emits everything not yet emitted. The haves' object closure is **never subtracted** ⇒ a strict **superset** of the exact difference | yes, but the emitted set shrinks — see §D9 |
| bundle object selection | `enumerateBundleObjects` (`enumerate-bundle-objects.ts:172`) | two-phase: `collectUninteresting` builds the haves' full object closure, then `walkInteresting` filters against it ⇒ the **exact** difference. Also returns `boundary`, the prerequisite commits | partly — the bitmap gives the object set, **not** the boundary (§D9) |
| `pack-objects` object selection | **absent** — `buildPack` (`build-pack.ts`) takes an oid list a caller already computed | — | **this entry adds the command** (ADR-614) |
| `rev-list` | **absent** | — | **this entry adds the command** (ADR-613) |
| fetch/push negotiation | `fetch-pack.ts` / `push.ts` | negotiates by ref advertisement | no — negotiation is a wire protocol, not a closure |
| full-universe enumeration | `enumerateObjects` | served from `allObjectIds(index)` | no — a bitmap is strictly less information |
| **offset → pack position** | **`buildOffsetTable` (`pack-registry.ts:219`)** | sorts `entryOffsets(index)` | **`.rev`'s consumer, not the bitmap's** (§D10) |

So the honest shape of the entry is now the inverse of the draft's: the parsers are the payload and
the `fsck` verdicts are one of four arms.

### The cost `.rev` exists to remove, in tsgit's own terms

`buildOffsetTable` (`pack-registry.ts:219-232`) is the one place tsgit needs pack order:

```ts
const raw = entryOffsets(index);                       // O(n) reads out of the .idx
const sortedOffsets = [...raw].sort((a, b) => a - b);  // O(n log n), once per pack per Context
```

`sortedOffsets` is consumed by `nextOffsetForEntry` (`pack-registry.ts:320`) — a binary search for
"where does the entry at this offset end" — on **every packed object read**. The `.rev` is that sort,
precomputed by git: `sortedOffsets[p] = raw[rev[p]]`, an O(n) gather instead of an O(n log n) sort.
Pin AI measures the identity that makes the swap legal.

Note what the `.rev` does **not** buy: `entryOffsets(index)` is still required, so the `.idx` load is
not avoided. Same hard floor ADR-597 hit for the midx — the auxiliary file indexes the pack, it does
not replace the pack's index.

### Premises of the brief, checked against git and against the code

| # | brief premise | verdict |
|---|---|---|
| B-1 | *"both currently ignored harmlessly (neither is required for object reads)"* | **half true.** Harmless for reads (Pin H/J `cat-file` columns); **not** harmless for `fsck`, where tsgit is silent on two of git's eight exit bits. |
| B-2 | *"`.rev` maps pack position ↔ index position"* | correct, and the on-disk direction is **one-way**: `rev[packPosition] = indexPosition` (Pin B). The inverse needs an O(n) invert. |
| B-3 | *"accelerating offset→oid resolution (`verify-pack`-style enumeration, midx bitmaps)"* | tsgit still has no `verify-pack`; the real tsgit analogue is `buildOffsetTable` (§D10). Midx bitmaps **are** now in scope (ADR-617, §D4). |
| B-4 | *"pack bitmaps accelerate reachability closure (object counting for `pack-objects`, fetch/push negotiation)"* | correct, and the draft's "tsgit has none of those surfaces" is **falsified**: two closures exist (§Context census) and two commands are added here. Negotiation stays out (§Out of scope). |
| B-5 | *"midx bitmaps layer on the midx"* | correct, and stronger than stated: the midx's reverse index is a **chunk inside the midx** (`{'R','I','D','X'}`), not a sibling file (Pin F). ADR-617 makes reading that chunk mandatory (Pin AG). |
| B-6 | *"`.rev` parser + **generation check** against git's"* | **there is no generation.** `.rev` version is `1` and only `1` (Pin H R2/R3); the only staleness field is the embedded pack checksum, which git's `fsck` **does not verify** (R10b). §D11 replaces "generation check" with the three checks git actually runs. |
| B-7 | *"bitmap (EWAH-compressed) parser"* | **not required for faithfulness** (Pin J rows B14–B19: every restamped structural corruption exits 0) — but required for **capability**, which is what ADR-605 bought. The two roles are kept provably apart (§D12). |
| B-8 | *"interop pins comparing enumeration/reachability results against real git with and without the auxiliary files"* | correct, and now the load-bearing suite. Pins AA–AH measure the axes where a difference is actually observable; Pin AB shows two of git's own paths **disagree**. |
| B-9 | implicit: the artefacts are rare / opt-in | **false.** `pack.writeReverseIndex` defaults **on**: a bare `git repack -adq` writes `.rev` (Pin A). |
| B-10 | implicit: the pack subsystem is hash-generic | **false, pre-existing.** `IDX_SHA_LENGTH = 20` is a module-private constant in `pack-index.ts:10` and again in `pack-writer.ts:65`. Both new formats *are* hash-generic (Pin G) and their parsers must be written that way; the surrounding limit is neither widened nor narrowed here (§D16). |

### Subsystems this touches

| subsystem | file | involvement |
|---|---|---|
| domain storage | `src/domain/storage/rev-index.ts` (new) | the `.rev` parser (§D2) |
| domain storage | `src/domain/storage/bitmap.ts` (new) | the header + EWAH reader (§D3) |
| domain storage | `src/domain/storage/midx.ts` | one more chunk id and its readers — the reverse-index chunk (§D4) |
| domain storage | `src/domain/storage/error.ts`, `index.ts` | two new error codes with closed `check` unions (ADR-610) + barrel exports |
| artefact source | `src/application/primitives/internal/pack-artefact-source.ts` (new) | discovery, bounded read, fault classification — one loader for four consumers (ADR-609, §D5) |
| pack registry | `src/application/primitives/pack-registry.ts` | `buildOffsetTable` gathers via the `.rev` (ADR-604); a sibling memo exposes the pack-position map to the bitmap layer (§D10) |
| pack scan | `pack-registry.ts` `scanPacks` / `isCandidate` (:177) | the sibling-artefact listing the discovery step consumes at zero extra I/O (ADR-579's shape) |
| midx binding | `src/application/primitives/internal/midx-binding.ts:298` | `verifyMidxTrailer` is the precedent for hashing an artefact at `fsck` time; the midx-bitmap filename derives from the same `head._bytes` trailer slice (Pin K, ADR-617) |
| closure engine | `src/application/primitives/internal/closure-engine.ts` (new) | the shared bitmap-or-walk closure (§D6) |
| commands | `src/application/commands/rev-list.ts`, `pack-objects.ts` (new) | ADR-613, ADR-614 |
| fsck | `commands/fsck.ts`, `internal/fsck/pack-health.ts`, new `internal/fsck/bitmap-health.ts`, `internal/fsck/types.ts`, `internal/fsck/exit-codes.ts` | one new bit-64 cause (ADR-607/608), one new bit-128 pass (§D12) |
| limits | `primitives/validators.ts` | the bitmap bound + the closure caps (ADR-611, §D3) |
| read path | `object-resolver.ts`, `internal/blob-source.ts` | **unchanged** — no `.rev`/`.bitmap` fault ever fails a read in git (Pin H/J) or in tsgit (§D13) |

### Constraining prior decisions

The seventeen ratified decisions are binding and are cited inline where they bite. The earlier ones
that still shape the work:

- **[ADR-226](../adr/226-git-faithfulness-prime-directive.md) — git-faithfulness.** Binds the `fsck`
  exit integer, the refusal conditions, and the object sets the new commands return. Pin AB is where
  it gets hard: git's own two paths disagree, so "match git" needs a chosen referent — and ADR-618
  chooses it **per command**, because that is how git itself resolves it (Pin AJ).
- **[ADR-249](../adr/249-describe-structured-data-only.md) — structured data only.** Both new
  commands return fields, never lines. git's `error:` transcripts are reconstructed inside interop
  tests. The per-command tier control ADR-618 adds is **not** cosmetic — it changes the returned
  set, not its rendering — so ADR-249 does not bar it.
- **[ADR-572](../adr/572-local-pack-gate-sits-in-lookup.md)** — `all()` does not apply the header
  gate; §D11's universe argument depends on that.
- **[ADR-575](../adr/575-full-per-pack-registry-degradation.md)** — per-artefact degradation via
  **positive allow-lists** over `TsgitError.data.code`, never `catch {}`.
- **[ADR-577](../adr/577-local-gate-cross-checks-object-count.md)** — a context-free parser takes
  bytes plus a width and performs no cross-check; the caller holds the cross-check inputs.
- **[ADR-578](../adr/578-pack-version-fixtures-crafted-in-test.md)** — binary fixtures are crafted
  in-test by a builder, not committed as blobs.
- **[ADR-579](../adr/579-orphaned-idx-excluded-at-scan-time.md)** — an orphaned `.idx` is excluded at
  scan time; this is what makes Pin L Y4/Y6 come out right for free.
- **[ADR-581](../adr/581-per-pack-health-is-a-registry-accessor.md)** — a *shared* verdict earns a
  memoised registry accessor. ADR-609 declined it here and named the condition to revisit.
- **[ADR-583](../adr/583-two-pack-finding-variants-by-layer.md)** /
  **[ADR-584](../adr/584-the-finding-carries-the-pack-base-name.md)** — one finding variant per
  layer, carrying the pack base name. ADR-607 applies the rule; ADR-608 sets the cardinality.
- **[ADR-585](../adr/585-fsck-narrows-its-universe-via-an-enumerate-objects-knob.md)** /
  **[ADR-586](../adr/586-exit-bit-64-is-modeled-with-an-ungated-finding.md)** — bit 64 is ungated by
  mode. Pin I re-confirms it for the cause ADR-586 could not test.
- **[ADR-589](../adr/589-the-pack-pass-lives-in-internal-fsck.md)** — a pass lives in
  `commands/internal/fsck/`; `fsck.ts` gains three lines.
- **[ADR-592](../adr/592-midx-is-authoritative-for-named-packs.md)** — the midx is authoritative for
  the packs it names; ADR-612 inherits its `core.multiPackIndex` posture.
- **[ADR-593](../adr/593-midx-corruption-replicates-gits-two-tiers.md)** — the midx's Tier A / Tier B
  split. **Neither new artefact has a Tier A**: Pin H, Pin J and Pins AA–AH contain no row where a
  read fails or an answer is lost. Stated explicitly because a reader arriving from 28.2 looks for one.
- **[ADR-597](../adr/597-usable-midx-defers-idx-loading.md)** — `all()` is lazy; §D11 pays the
  `.idx` parse it forces and says so.
- **[ADR-598](../adr/598-midx-discovery-lives-in-midx-source.md)** — the precedent ADR-609 follows.
- **[ADR-599](../adr/599-invalid-multi-pack-index-carries-check-discriminant.md)** — a refusal
  carries a closed `check` discriminant. ADR-610 applies it to `.rev`; §D3 applies the same ratio to
  the bitmap.
- **[ADR-600](../adr/600-dedicated-midx-size-and-chain-bounds.md)** — a new declared-count bound gets
  a bound sized by its own arithmetic. ADR-611 refines it into an exact size for `.rev`.
- **[ADR-601](../adr/601-fsck-reports-midx-findings.md)** — integers inside a finding are data.
- **[ADR-602](../adr/602-midx-trailer-unverified-on-read-verified-in-fsck.md)** — trailer unverified
  on read, verified in `fsck`. ADR-606 and ADR-615 extend the same split one layer out.
- **`pack-registry-single-flight.md` (PR #263)** — every lazy initialiser crossing an `await` is a
  `createPromiseMemo`; a rejection is never memoised; `dispose()` is terminal.

### House patterns this must follow

- Zero-copy `DataView` parsing with `_bytes` / `_view` retained, exactly as `PackIndex`
  (`pack-index.ts:13-21`) and `MultiPackIndex` do.
- Domain code takes bytes + a `digestLength`; all I/O, path construction and policy live in the
  application layer (ADR-577).
- Files ≤ ~400 lines, functions < 20 lines, early returns, named constants, no `any`, branded types.
- `ctx.hash.hash(bytes)` (`ports/hash-service.ts`) for artefact digests, algorithm from
  `ctx.hashConfig`, never a hard-coded name.
- Errors classify structurally on `data.code`; never `instanceof` across module graphs.

## Pinned matrices — git 2.55.0, this host (darwin 25.5.0)

Every cell below was **executed**, not recalled. Method: one `mktemp -d`-class throwaway per row,
isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` unset, `commit.gpgsign=false`,
`init.defaultBranch=main`, `gc.auto=0`. Pack files land mode `0444`; every mutation `chmod u+w`s
first, or the mutation silently no-ops and the whole row reads as a false `0`.

**Pins A–M** were measured for the draft and independently re-verified this run; they are reproduced
verbatim and their fixture is 2 commits / 6 blobs / 3 trees → 12 objects in one pack.
**Pins AA–AJ** are new: they cover **consumption**, which Pins A–M do not touch at all. Their
fixtures are named where used:

- **F1** — 30 commits, `git repack -adq --write-bitmap-index`; 124 objects, **30** bitmap entries.
- **F2** — 400 commits (built by `git fast-import` for speed), one branch, one annotated tag,
  `git repack -adq --write-bitmap-index`; **1606** objects, **108** bitmap entries. Each commit
  writes a unique file **and** rewrites a shared file with one of five recurring contents, so blob
  content **repeats across any have boundary** — which is what makes Pin AB's divergence visible at
  all (blind spot 10).
- **F3** — F2 plus 5 more commits repacked incrementally into a second pack, then
  `git multi-pack-index write --bitmap`; 2 packs, 1 pack bitmap, 1621 midx objects, 1 midx bitmap.
- **F4** — 76 commits including one real merge, `git repack -adq --write-bitmap-index`.
- **F5** — the ratification run's own fixture for Pin AJ: a history that **repeats blob content
  across the have boundary**, `git repack -adq --write-bitmap-index`; **367** objects reachable from
  `HEAD`. Same repetition property as F2, at a size small enough to enumerate by hand.

**RESTAMPED** rows recompute the artefact's trailing digest over `[0, len − digestLength)` after the
mutation, which separates *load-time structural checks* from *checksum detection*. A control row
proves the restamp algorithm is git's own: restamp-with-no-other-change leaves both `fsck` and
`verify-pack` at exit 0. **Without that separation every row below reads as "checksum failure" and
the entire matrix is uninterpretable.**

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

28.2's parser walks past both chunks (the chunk table is self-describing). ADR-617 turns that from a
documented blind spot into work: Pin AG reads the reverse-index chunk and uses it.

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
    surface**, so this column is context, not obligation.

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

**Rules, as pinned.**

1. **`git fsck`'s entire bitmap obligation is `hash(file[0 .. len−digestLength)) == file[len−digestLength ..]`.**
   Every restamped structural corruption — wrong magic, wrong version, absurd entry count, a
   truncated file, an EWAH word count of 2³¹ — exits **0**. The six RESTAMPED rows are the proof and
   they are why ADR-605 keeps the `fsck` pass **parse-free** while shipping a parser for consumption.
2. **One message for every cause**, so the cause is not observable through `fsck` at all. Per
   ADR-249 tsgit reproduces the condition and the integer; there is nothing else to reproduce.
3. **Absent / unreadable / orphaned is clean and silent** (B1, B12, B23) — the same shape as `.rev`.
4. **Bit 128 is ungated**: by mode — default, `--connectivity-only` and `--strict` all give **128**,
   `--no-full` gives **130** against a control of **2** (Pin L row Y1) — and by
   `core.multiPackIndex` for a *pack* bitmap (Pin K X8). A healthy `.bitmap` needs no `.rev` at all
   (B13, and Pin AF measures the consumption side of the same fact).
5. **No bitmap fault fails a read.** `cat-file` is 0 in every row; `rev-list --use-bitmap-index`
   silently degrades to a full walk and still exits 0 with the right answer.
6. **B19 is git aborting, not refusing** (`BUG:`, exit 134 — an abort, not a refusal). Not a behaviour to replicate — and, usefully, the only clean *detector* of whether git loaded a given bitmap at all (Pins AF, AG use it as one).
7. B21 shows git's own bound: an oversized EWAH word count is caught as `eof in data
   (17179868944 bytes short)` against the mapped file length — the file size is the bound, and
   tsgit's own bound must be at least as tight (ADR-611, T-3).

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
   (X1 vs X8). That is the **midx design's** Pin N3 shape, applied one layer out. ADR-612 declines
   the gate; Pin AG measures what that costs on the read path.
3. **Discovery is by the midx's *stored* trailer bytes.** X7 (rename) and X10 (flip the midx's own
   trailer, corrupt the bitmap, get **32 and not 128**) both prove it: git composes
   `multi-pack-index-<hex(stored trailer)>.bitmap` and simply does not find anything else. A
   midx whose trailer is wrong therefore *hides* its bitmap from `fsck` entirely — bit 32 fires,
   bit 128 does not. §D12 must reproduce that, and it is the least obvious row in the design.
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
   for free, and §D11/§D12's universe choice is what keeps them agreeing.
4. Together with Pin H C1 ≡ C2, the universe is now fully pinned from both ends: the artefact checks
   run over packs whose **`.idx` loads and whose `.pack` exists**, and are independent of whether
   the `.pack` *opens*.

### Pin M — tsgit today (structural, read off the code)

Not run as a matrix because the answer is structural and total: `isCandidate`
(`pack-registry.ts:177`) admits only `*.idx`, and no file in `src/` opens a `.rev` or a `.bitmap`.
tsgit's column is therefore **`0` for every Pin H, I, J and K row except the `.idx`-caused ones** —
i.e. identical to git's `.rev`-deleted / `.bitmap`-deleted column. The read-path rows are faithful
by accident and stay faithful; the `fsck` rows are the divergence.

---

The next nine pins are **new**. They measure consumption, which Pins A–M do not touch: every row
above holds the query fixed and varies the artefact; every row below holds the artefact healthy and
varies the query.

### Pin AA — on the bitmap path git emits **no path names**

Fixture **F2**. `--use-bitmap-index` selects the bitmap path; plain `rev-list` is the walk (rev-list
has no `--no-use-bitmap-index`; the walk is its default).

| # | query | lines | lines carrying a name | oid set |
|---|---|---|---|---|
| AA1 | `rev-list --objects HEAD` (walk) | 1605 | **805** | reference |
| AA2 | `rev-list --objects --use-bitmap-index HEAD` | 1605 | **0** | **identical to AA1** |
| AA3 | `rev-list --count --objects HEAD` / with `--use-bitmap-index` | — | — | both **1605** |
| AA4 | `rev-list --count HEAD` / with `--use-bitmap-index` | — | — | both **400** |
| AA5 | ordered oid sequence, AA1 vs AA2 | — | — | **differs** (the bitmap emits in bitmap order) |
| AA6 | `--objects` on a want with **no bitmap entry** (F2, 425 objects) | 425 | **0** | identical to the walk's 425 |

**Rules.**

1. **A bitmap carries reachability and type. It carries no paths.** git's bitmap path prints the oid
   and stops. The `--objects` name field is a **walk-only product**, produced by the tree traversal
   that the bitmap exists to avoid.
2. The **set** is identical; the **order** is not. Order is presentation-adjacent and tsgit returns
   structured data, so the order rule tsgit needs is only "deterministic", not "git's".
3. AA6 matters twice: the bitmap serves a want that has no entry of its own (Pin AD explains how),
   and it still emits no names.

This is the pin that decides how much of `rev-list --objects` the acceleration can actually serve.
ADR-619 takes the consequence: the entry's `path` is **optional**, populated by the walk tier and
absent on the bitmap tier — git's own behaviour on both paths (§D7).

### Pin AB — bitmap and walk **disagree** once `not`/haves are present

Fixture **F2**. "exact" = `closure(want) \ closure(have)`, computed independently by two full
`rev-list --objects` runs and a set subtraction.

| # | query | bitmap | walk | exact | verdict |
|---|---|---|---|---|---|
| AB1 | `--objects HEAD --not HEAD~50` | **200** | **204** | **200** | bitmap **==** exact; the walk over-reports |
| AB2 | `--objects HEAD --not <a commit with an entry>` | 1308 | 1312 | — | same shape, same delta |
| AB3 | `--objects HEAD --not <a commit with no entry>` | 1180 | 1184 | — | same shape, same delta |
| AB4 | `--objects --all` (no haves) | 1606 | 1606 | — | identical |
| AB5 | `--objects HEAD --not --all` (empty result) | 0 | 0 | — | identical |
| AB6 | the four objects only the walk emits | — | — | — | all **blobs**, all **reachable from the have** |
| AB7 | `pack-objects --revs` **with** haves | **200** | **204** | — | the same divergence, one layer up |
| AB8 | `pack-objects --revs` **without** haves | 1605 | 1605 | — | identical |
| AB9 | F4 (`HEAD --not topic`) | 122 | 122 | — | identical — the divergence is **fixture-dependent** |
| AB10 | `pack-objects --revs --stdout` with a want fully covered by its have | — | — | 0 | exit **0**, a **32-byte** pack: `PACK`, version 2, **0 objects** — an empty closure is not an error |

**Rules.**

1. **The bitmap computes the exact set difference. git's own walk does not.** The walk marks the
   haves' commits and root trees uninteresting but does not enumerate the haves' whole blob set, so
   a blob reachable from both sides is emitted again. The bitmap, being a plain bit-and-not over two
   reachability sets, cannot make that mistake.
2. The divergence appears only when an object is reachable from **both** sides, so a fixture without
   repeated content shows none (AB9). **An interop suite that only uses AB9-shaped fixtures will
   miss this entirely** — the fixture must deliberately repeat blob content across the have boundary.
3. For `pack-objects` the difference is **pack size**, not correctness: both packs are valid.
   For `rev-list --objects` the difference **is the answer**.
4. tsgit's own two closures sit on opposite sides of this line: `enumeratePushObjects` over-reports
   even more than git's walk (it never subtracts the haves' objects at all), while
   `enumerateBundleObjects` computes the exact difference. §D9 takes the consequence.

### Pin AC — which `rev-list` options the bitmap answers

Fixtures **F2** (linear) and **F4** (one real merge). Two independent oracles: *loaded* — set the
bitmap's flag word to 0 and restamp, then `exit 134` proves git loaded it (Pin J rule 6);
*answered* — on `--objects`, zero name-carrying lines proves the bitmap produced the answer (Pin AA).

| option (F4 unless noted) | loaded | answered | bitmap answer == walk answer |
|---|---|---|---|
| `--objects <want>` | yes | **yes** | yes (227 = 227) |
| `--count` | yes | **yes** | yes |
| `--count --objects` | yes | **yes** | yes |
| `--all` | yes | **yes** | yes |
| `--not` / haves | yes | **yes** | **no** — Pin AB |
| `--max-count=<n>` | **no** — git abandons the bitmap | no | n/a (16 = 16, both walked) |
| `--first-parent` | yes | **yes** | **no** — **227 vs 183** objects, **76 vs 61** commits |
| `--no-walk` | yes | **yes** | **no** — **227 vs 7** objects, **76 vs 2** commits |
| `--reverse` | yes | yes | yes (order only) |
| `--objects-edge` | yes | — | — |

**Rules.**

1. `--max-count` is the only option in ADR-613's set for which **git itself** declines the bitmap.
2. `--first-parent` and `--no-walk` are worse: git loads the bitmap, uses it, and **silently returns
   the wrong answer for the option** — the full reachability closure, as though the option were
   absent. On F2 (linear, no merges) `--first-parent` looks correct; only the merge fixture exposes it.
3. Every row above is the **opted-in** behaviour (`--use-bitmap-index`); git's `rev-list` default is
   the walk column throughout (Pin AJ1). Under ADR-618 `rev-list` walks by default too, so tsgit's
   default answer for all three options is already git's default answer, with no special case. The
   one special case that survives is `--max-count`, where **git itself** declines the bitmap even
   when asked (row 6) — §D7 reproduces that decline rather than inventing one.

### Pin AD — entry grammar: selection, XOR chains, and a full reconstruction proof

| # | measurement | value |
|---|---|---|
| AD1 | F1 (30 commits) → entry count | **30** — every commit selected, every `xorOffset` = 0 |
| AD2 | F2 (400 commits) → entry count | **108** — partial coverage |
| AD3 | F2 `xorOffset` histogram | `{0: 4, 1: 104}` |
| AD4 | F2 entry `flags` histogram | `{0: 108}` |
| AD5 | stored bit counts along a chain | 297, 701, 957, then 128, 64, 32, 16, 8, 4, 4, 4 … — deltas, not closures |
| AD6 | reconstruction rule | `resolved[i] = stored[i]` if `xorOffset == 0`, else `stored[i] XOR resolved[i − xorOffset]` |
| AD7 | **verification** | all **108** reconstructed sets equal `git rev-list --objects <commit>` **exactly** (108 / 108) |
| AD8 | Pin C's header rule at scale | entry headers are **index** positions; bits are **pack** positions — re-confirmed on 1606 objects |

**Rules.**

1. **Coverage is partial by design.** git selects every commit only in small repositories; at 400
   commits it keeps 108. A design that assumes "the want has an entry" is wrong on any real repo.
2. **`xorOffset` counts entries backwards, never forwards**, so chains are acyclic by construction
   and `i − xorOffset < 0` is a refusal, not a cycle check.
3. Chains are **long and shallow-stepped**: 104 consecutive entries at offset 1 means resolving the
   last entry touches ~104 predecessors. Reconstruction must be **iterative**, and its cost model is
   "walk back to the nearest offset-0 or cached entry, then fold forward" (§D3).
4. AD7 is the empirical licence for the whole consumption story: the grammar in Pin D plus the rule
   in AD6 reproduces git's answers exactly, with no residue.

### Pin AE — the four type streams are a total partition, and they are the type oracle

Fixture **F2** (1606 objects):

| stream | `bitSize` | set bits |
|---|---|---|
| commits | 401 | 400 |
| trees | 1606 | 800 |
| blobs | 906 | 405 |
| tags | 12 | 1 |
| **sum of set bits** | — | **1606 = objectCount** |

Checked against `cat-file --batch-check=%(objecttype)` for **all 1606** pack positions: the stream
owning a position predicts its type correctly **1606 / 1606**. Same result for F3's midx bitmap
(sum of set bits = 1621 = the midx's object count).

**Rule.** The type of every object in the artefact is available from the bitmap alone, with no object
read. Type is free; **path is not available at any price** (Pin AA).

### Pin AF — the `.rev` is an accelerator for consumption, never a precondition

Fixture **F2**.

| # | shape | `rev-list --objects --use-bitmap-index` | set | `fsck` |
|---|---|---|---|---|
| AF1 | `.rev` deleted, `.bitmap` healthy | exit 0, **0 name-carrying lines** ⇒ bitmap answered | identical to the with-`.rev` set | **0** |
| AF2 | `.rev` deleted **+** bitmap flag word 0, restamped | **134** ⇒ the bitmap was still loaded | — | 0 |
| AF3 | the second pack's `.rev` deleted while a bitmap covers the first (F3) | exit 0, bitmap answered | identical | 0 |

**Rule.** git builds the reverse index in memory when the file is absent, so a `.bitmap` without a
`.rev` is fully usable. Pin J B13 said the same thing from the `fsck` side; this says it from the
consumption side, which is the side that matters for §D10's fallback.

### Pin AG — midx bitmap preference, and the reverse-index chunk

Fixture **F3** (2 packs; pack bitmap on the larger pack; midx + midx bitmap).

| # | shape | detector | verdict |
|---|---|---|---|
| AG1 | both bitmaps healthy; **midx** bitmap flag word 0, restamped | exit **134** | the **midx** bitmap is loaded |
| AG2 | both bitmaps healthy; **pack** bitmap flag word 0, restamped | exit **0** | the pack bitmap is **never loaded** |
| AG3 | midx bitmap **deleted**; pack bitmap flag word 0 | exit **134** | falls back to the pack bitmap |
| AG4 | midx **file** deleted (bitmap orphaned); pack bitmap flag word 0 | exit **134** | falls back to the pack bitmap |
| AG5 | `core.multiPackIndex=false`; midx bitmap flag word 0 | exit **0** | the midx tier is off, midx bitmap not loaded |
| AG6 | `core.multiPackIndex=false`; pack bitmap flag word 0 | exit **134** | falls back to the pack bitmap |

Structure, measured off F3's midx:

| # | measurement | value |
|---|---|---|
| AG7 | `multi-pack-index write` **without** `--bitmap` | chunks `PNAM, OIDF, OIDL, OOFF` — **no reverse-index chunk** |
| AG8 | `multi-pack-index write --bitmap` | adds **`{'R','I','D','X'}`** and **`{'B','T','M','P'}`** |
| AG9 | reverse-index chunk length | `6484 = 4 × 1621` = `objectCount × u32BE` |
| AG10 | reverse-index chunk semantics | `chunk[p]` = the **midx position** of the object at **pseudo-pack position `p`**; the sequence is strictly increasing in `(packIndex, offset)` |
| AG11 | `{'B','T','M','P'}` content | `{0, 15}` then `{15, 1606}` — per pack, `{ first pseudo-pack position, count }`; totals 1621 |
| AG12 | midx bitmap entry headers | **midx positions**, not pseudo-pack positions: **108 / 108** entries matched under the midx reading, **0 / 108** under the other |
| AG13 | end-to-end reconstruction | bits → reverse-index chunk → midx position → oid: all **108** closures equal real `rev-list --objects` runs |
| AG14 | midx bitmap embedded checksum | equals the midx's **stored** trailer, which is also its filename in hex |

**Rules.**

1. **Preference order is midx bitmap ≻ pack bitmap**, and it is exclusive: with a usable midx bitmap
   present git does not even open the pack bitmap (AG2). ADR-617's assertion is measured.
2. **Fallback is by artefact, not by tier**: remove the midx bitmap (AG3) or break the midx's
   discoverability (AG4) and the pack bitmap is used.
3. `core.multiPackIndex=false` removes the midx tier and the pack bitmap takes over (AG5/AG6).
   ADR-612 declines that key, so tsgit consumes a midx bitmap where such a repository's git would
   consume the pack bitmap. Both produce the same object set, so the divergence is in *which file is
   read*, never in an answer — that is the whole residual, and it is smaller than it looks.
4. **A bit resolves to an oid with the reverse-index chunk alone**; `{'B','T','M','P'}` is not needed
   for that and is not consumed here (§Out of scope).
5. AG7 is a free structural invariant: no reverse-index chunk ⇒ no midx bitmap was ever written, so
   a midx bitmap found beside a chunk-less midx is not consumable and the pack tier takes over.

### Pin AH — completeness beyond the artefact, and the extension layout

| # | shape | result |
|---|---|---|
| AH1 | F3 with the midx removed: a pack bitmap covering 1606 of the 1621 objects in two packs | bitmap answered; **1620 = the walk's 1620**; 0 name-carrying lines |
| AH2 | F2 plus a **loose** commit on top (3 loose objects) | bitmap answered; **1608 = the walk's 1608**; bitmap still loaded (flag-0 detector = 134) |
| AH3 | AH1 with the other pack's `.rev` also deleted | unchanged |

**Rule.** git extends a bitmap with an in-memory index for objects that have no position in it —
objects in other packs, and loose objects. **A bitmap never truncates the answer**; it only
accelerates the part of the answer it covers.

Extension layout, F2 (1606 objects, 108 entries), measured by parsing to the end of the entries:

| configuration | flag word | type streams end | **entries end** | trailing extension bytes |
|---|---|---|---|---|
| default | `0x0005` | 240 | **9824** | 6424 = `4 × objectCount` (hash cache) |
| `pack.writeBitmapHashCache=false` | `0x0001` | 240 | **9824** | 0 |
| `+ pack.writeBitmapLookupTable=true` | `0x0015` | 240 | **9824** | 8152 = 6424 + `16 × entryCount` |

**Rule.** **Every flag-selected extension is trailing.** The per-commit entries sit at the same
offset under every flag word, so a consumer that reads header → four type streams → entries never
has to interpret the flag word at all. Pin E's row B6 (`flags = 0xffff` → *"too short to fit
pseudo-merge table"*) is git validating trailing data tsgit never reaches.

### Pin AI — the accelerator identity

Fixture **F2**, 1606 objects: `entryOffsets(index)[revBody[p]]` is **strictly increasing in `p`**
across all 1606 positions. That is exactly ADR-604's claim
`sortedOffsets[p] = entryOffsets(index)[revIndexPositionAt(rev, p)]`, and it is the whole of the
accelerator's correctness. (Verified on F1 and on Pin B's 12-object fixture too.)

### Pin AJ — the default tier is a **per-command** property

Fixture **F5**, measured by the run that ratified ADR-618. The fixture's **repeated blob content
across the have boundary** is load-bearing: without it every row below collapses to a single column,
because the two tiers then agree — the same trap Pin AB9 measures and blind spot 10 restates. A
reader reproducing this pin on a fresh linear fixture will see no disagreement and conclude, wrongly,
that the pin is stale.

| # | command | tier git chooses | objects |
|---|---|---|---|
| AJ1 | `rev-list --objects HEAD --not HEAD~50` | **walk** | **156** |
| AJ2 | `rev-list --use-bitmap-index --objects HEAD --not HEAD~50` | **bitmap** | **150** |
| AJ3 | `pack-objects --revs` (same wants and haves) | **bitmap** | **150** |
| AJ4 | `pack-objects --revs --no-use-bitmap-index` | **walk** | **156** |
| AJ5 | either command, **no haves** | either | **367 = 367** |
| AJ6 | the six objects only the walk emits | — | all **blobs**, all reachable from the have |
| AJ7 | name-carrying `--objects` lines, walk versus bitmap | — | **127** versus **0** |

**Rules, as pinned.**

1. **git resolves the walk/bitmap disagreement per command, not globally.** `rev-list` walks by
   default; `pack-objects` uses a bitmap by default. Both defaults are confirmed **in both
   directions**: each command carries a flag that flips it and produces the other command's number,
   so neither default is an artefact of how the command was invoked.
2. AJ5 separates "the two tiers disagree" from "the fixture is odd": with no haves they agree
   exactly. The disagreement is a property of **have composition**, never of the bitmap alone.
3. AJ6 pins the *direction* and the *content* of the disagreement: the walk's answer is a strict
   **superset**, and every extra object is reachable from a have. That is what makes `pack-objects`'
   smaller pack safe — the receiver already has everything the bitmap omitted.
4. AJ7 reproduces Pin AA on this fixture: the bitmap tier carries no paths, for either command.

**This pin is the whole of ADR-618 and ADR-619's empirical basis**, and it is the reason the design
carries a tier control per command instead of one global policy.

## Requirements

Verifiable at ship time. 1–12 are `fsck` and parsing; 13–23 are consumption and public surface;
24–28 stand across everything.

1. **The exit integer matches git on every Pin H/I/J/K/L row.** Bit 64 fires for a `.rev` that
   exists, is readable and fails any of git's three check families; bit 128 fires for a `.bitmap`
   (pack or midx) whose own digest disagrees. Both compose by plain OR and are **ungated by mode**.
2. **Absent, unreadable and orphaned artefacts are non-events** — no finding, no bit, no rejection
   (R11–R13, B1, B12, B23, X5–X7). An unreadable artefact is silent even in the logger, because git
   is (R12).
3. **`.rev` version accept-set is exactly `{1}`**; `hashId` accept-set is `{1, 2}` and is **not**
   cross-checked against the repository (R16). Neither stricter nor laxer than git.
4. **The `.rev` size rule is exact** — `12 + 4·N + 2·digestLength` — with the short case and the
   wrong-length case distinguished at the `12 + 2·digestLength` boundary (R7d vs R7c, R6/R8 vs R17).
5. **The `.rev` body cross-check is exhaustive**: every position whose stored value differs from the
   value derived from the `.idx` yields **its own** finding carrying `{ pack, position, expected,
   stored }` (N1, ADR-608), and the bit is set once. The array is built by loop-drain, never by
   `push(...spread)`.
6. **A `.rev` for a pack whose `.idx` is unusable produces no additional finding** (C1 ≡ C2).
7. **Three `.rev` finding variants after this change** (ADR-607 composed with ADR-608): the existing
   one keeps its `.idx`-caused meaning; one new one reports a fault in the `.rev` **file**; one new
   one carries a **per-position** body mismatch (requirement 5), whose integers cannot ride in a
   `reason` string. `EXIT_PACK_REV_INDEX`'s doc-comment no longer says tsgit has no reverse-index
   reader.
8. **The `fsck` bitmap pass never parses.** It hashes `[0, len − digestLength)` and compares
   (ADR-605). Every Pin J RESTAMPED row is an interop row asserting **no** finding, so a future
   refactor cannot fuse the parse path into the verdict path.
9. **A midx bitmap is found via the midx's *stored* trailer bytes**, so a midx with a wrong trailer
   hides its bitmap (X10 → 32, never 32\|128), and a renamed bitmap is simply not found (X7).
10. **Bounded reads.** The `.rev` is refused unless its size is **exactly**
    `12 + 4·N + 2·digestLength`; the bitmap gets a dedicated named constant whose arithmetic is in
    its doc-comment (ADR-611). No allocation is ever sized by a declared count that has not been
    validated against the remaining buffer.
11. **No `DataView` read at an unproven offset** in either parser. A `RangeError` escaping either is
    a defect, not an error path — the totality property test is the guard.
12. **A `.rev` refusal carries a dedicated error code with a closed `check` discriminant**
    (ADR-610), and so does a bitmap refusal (§D3, on ADR-610's ratio). **Neither**
    `isSkippableIdxFault` **nor** `isSkippablePackFault` returns `true` for **either** code at
    **any** `check` value — asserted, not inspected.
13. **`buildOffsetTable` consumes a usable `.rev`** (ADR-604). With a **healthy** `.rev` the
    resulting `sortedOffsets` is **identical** to the sort's, on every fixture (Pin AI). With an
    absent, unreadable or **refused** `.rev` the sort runs, so no result depends on the artefact's
    presence. A `.rev` that parses but whose body is wrong is **trusted** and produces what that
    body implies — that is requirement 14, not a violation of this one.
14. **The `.rev` body and bitmap closures are used as found** (ADR-606, ADR-615). No pre-use digest
    verification exists on either path. Parse-time bounds still apply in full.
15. **The `.rev` accelerator is measured, not asserted**: absolute wall-clock, main versus branch,
    from the CI nightly artefact, over a many-object shape **and** a many-small-packs shape. A
    measured regression is fixed in this PR.
16. **The two tiers stand in the pinned relation, which is conditional on haves** (ADR-618, amending
    ADR-616's unconditional obligation). ADR-616's double run stands — every closure test runs on a
    fixture carrying a bitmap and on the same repository with the bitmap removed — and asserts:
    - with **no `not`**: the two tiers agree **exactly**;
    - with **`not` non-empty**: the walk result is a **superset** of the bitmap result, **and** every
      object in the difference is reachable from a `not` tip;
    - in both cases the comparison is on **object id and type only, never on path** (ADR-619), and it
      is a **set** comparison, since order is deterministic per tier and not equal across tiers (§D6).
17. **Tier defaults reproduce git per command** (ADR-618, Pin AJ): `rev-list` walks unless the caller
    asks for the bitmap; `pack-objects` uses a usable bitmap unless the caller refuses it. Both
    commands carry the control, sharing one option name and differing only in default — exactly git's
    `--use-bitmap-index` / `--no-use-bitmap-index` split. With the default tier, tsgit's answer for
    `--max-count`, `--first-parent` and `--no-walk` is git's default answer, which is the walk's; when
    the caller does ask for the bitmap, `--max-count` still walks because **git itself** declines the
    bitmap for it (Pin AC row 6).
18. **A bitmap never truncates an answer** (Pin AH): objects in other packs and loose objects are
    included, exactly as git includes them.
19. **Artefact preference inside the bitmap tier is midx bitmap ≻ pack bitmap** (Pin AG), and a fault
    at either falls through to the other **without changing the result**. A fall-through all the way
    to the walk is result-preserving only when `not` is empty; with haves it yields the walk's
    superset, which is precisely what git does when it cannot load a bitmap (Pin AJ4).
20. **`rev-list` and `pack-objects` return structured fields only** (ADR-249) — oids, types, counts,
    booleans; never a rendered line, never a `--pretty`/`--format`/`--abbrev`/`--date` option. The
    tier control is the one option that survives that rule, because it changes the returned **set**
    rather than its rendering (ADR-618). The object **`path` is optional**, populated by the walk
    tier and absent on the bitmap tier (ADR-619) — the result type is deliberately not total in that
    field, and its doc-comment says which tier fills it.
21. **`pack-objects` writes a `.pack` and an `.idx` and nothing else** (ADR-614): no `.rev`, no
    `.bitmap`, no delta entries, no new `@writes` annotation, no write-surface allowlist entry.
22. **Both new commands pay the full Tier-1 surface tax**: barrel, facade + facade surface-lock test,
    `docs/use/commands/<kebab>.md` + index row, a parity scenario invocation, the README count, and a
    regenerated `reports/api.json`. Each page states its **tier default** (ADR-618), and `rev-list`'s
    states plainly that the bitmap tier cannot populate `path` and why (ADR-619) — a documentation
    obligation the ADR imposes, not a nicety.
23. **Every other public-surface change is deliberate**: the two new `FsckFinding` variants, the
    bitmap finding variant, both new error codes with their `check` unions, `EXIT_BITMAP`, the
    `useBitmapIndex` option on both command option types with its **opposite defaults**, the optional
    `path` on the `rev-list` entry, and any new domain export appear in `reports/api.json` on purpose,
    and `FsckResult.exitCode`'s doc-comment gains bit 128.

Standing, across all of the above:

24. **No `.rev` or `.bitmap` fault ever fails a read** or changes a lookup result (Pin H/J).
25. **No swallowed reason.** Where a fault is not propagated it reaches `ctx.logger?.warn?.` with the
    artefact name — **except** where git is silent (R12/B12/X6), which tsgit matches. Silence about
    the *strategy* is not silence about a *fault* (ADR-616).
26. **Path safety is total.** Every artefact name is composed from a pack base name the scan already
    vetted with `isSafePackName`, or from a midx trailer rendered as hex — never from bytes inside
    any artefact.
27. **The #263 handle lifecycle is untouched.** All three artefacts are read whole via `ctx.fs.read`
    and hold no `FileHandle`; opened-minus-closed stays 0.
28. **Hash-generic in every parser**: `digestLength` is a parameter; no branch on 20 vs 32 (Pin G).

## Design

### §D1 — what "read support" means after the ratification

Four arms, all in this entry, none deferred:

| arm | artefact | ADR | section |
|---|---|---|---|
| the reverse-index accelerator | `.rev` | 604 | §D10 |
| bitmap-backed reachability behind two new commands | `.bitmap`, midx `.bitmap` | 603, 613, 614, 615, 616, 617, 618, 619 | §D6–§D9 |
| the `fsck` reverse-index pass (exit bit 64) | `.rev` | 607, 608 | §D11 |
| the `fsck` bitmap pass (exit bit 128) | both bitmaps | 605, 612 | §D12 |

The load-bearing structural rule that keeps these four from contaminating each other:

> **The parser exists for consumption. The `fsck` bitmap pass does not parse.** (ADR-605)

Everything downstream follows. Because `fsck` never parses a bitmap, **no structural strictness in
the parser can produce a finding git would not produce** — that half of the asymmetry is
unconditional, and it is why T-3's mitigation can be aggressive without costing a point of `fsck`
faithfulness. The parser's only refusal behaviour is to **decline and fall back**.

ADR-618 puts a price on the other half, and it is small but no longer zero: a decline that reaches
the walk tier changes a **have-bearing** answer from the exact difference to git's superset (§D13).
So "decline freely, nothing observes it" — ADR-616's original licence — now reads *"decline where git
declines"*. Pin J is the map and it is nearly total: every structural corruption §D3 refuses (bad
magic, bad version, a missing full-DAG flag, an overrunning stream) is a row where git also refuses
or aborts, so the two decline together. The one row where git shrugs and tsgit must too is B22's
oversized `bitSize`, which §D3 explicitly does **not** treat as a refusal. It is stated here, once,
because three later sections lean on it.

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

Parse order, each step gated on the previous (this ordering is what makes requirement 11 true):

1. `bytes.length >= REV_HEADER_SIZE (12) + 2 * digestLength` → else `check: 'size'`, reason
   `too small` (rows R6/R7/R8/**R7d**).
2. magic `{'R','I','D','X'}` → `check: 'signature'` (R1).
3. version `=== 1` → `check: 'version'` (R2/R3). **Not** `{1,2}` — the one place a reader arriving
   from the midx will over-generalise.
4. `hashId ∈ {1, 2}` → `check: 'hash-id'` (R5). **No comparison against `digestLength`** — R16 pins
   that git accepts the disagreement. Recorded as a field, never a gate.
5. `bytes.length === 12 + 4 * objectCount + 2 * digestLength` → `check: 'size'`, reason `corrupt`
   (rows **R7c**/R7b/R17). Distinct reason from step 1's, because git's two messages are distinct and
   R7d↔R7c pins the boundary one byte apart.

`revIndexPositionAt` reads `view.getUint32(12 + 4 * p)` after `p < objectCount`; the **value** is not
range-checked here — a value ≥ `objectCount` is a *verification* verdict (§D11), not a parse refusal
(R14 is reported by `fsck`, not by the loader). This is the single most important line in the file
for ADR-606: the read path **trusts** that value, and §D10 says what that costs.

**`objectCount` is a parameter, not a derived value.** It could be derived as
`(len − 12 − 2·digestLength) / 4`, but then step 5 becomes tautological and R17 could never be
detected. Passing it in is ADR-577's rule and it is what makes the format self-checking at all.

Step 5 doubles as the allocation bound (ADR-611): the exact-size test is simultaneously git's own
size check and the proof that every subsequent `getUint32` is in range. `N` is transitively bounded
because it comes from an `.idx` already capped at `MAX_PACK_IDX_BYTES`.

### §D3 — the bitmap domain parser: `src/domain/storage/bitmap.ts`

Pins D, E, AD, AE and AH are the complete specification. Shape:

```ts
export interface PackBitmap {
  readonly version: 1;
  readonly optionFlags: number;
  readonly entryCount: number;
  readonly digestLength: number;
  /** The embedded pack (or midx) checksum. Retained, NOT compared (Pin J B16). */
  readonly checksum: Uint8Array;
  /** Byte offsets of the four type streams, in order: commits, trees, blobs, tags. */
  readonly typeStreamOffsets: readonly [number, number, number, number];
  /** Byte offset of the first per-commit entry. */
  readonly entriesOffset: number;
  readonly _bytes: Uint8Array;
  readonly _view: DataView;
}

export interface BitmapEntryHeader {
  /** Index position (pack bitmap) or midx position (midx bitmap) of the commit. */
  readonly position: number;
  readonly xorOffset: number;
  readonly flags: number;
  /** Byte offset of this entry's EWAH stream. */
  readonly streamOffset: number;
}

export function parsePackBitmap(bytes: Uint8Array, digestLength: number): PackBitmap;
export function bitmapEntryHeaders(bitmap: PackBitmap): ReadonlyArray<BitmapEntryHeader>;

/** Folds one EWAH stream into `into` with the given operation. Never allocates. */
export function foldEwahStream(
  bitmap: PackBitmap,
  streamOffset: number,
  into: Uint32Array,
  op: 'or' | 'xor',
): void;
```

Parse order:

1. `bytes.length >= 12 + digestLength` → else `check: 'size'`.
2. magic `{'B','I','T','M'}` → `check: 'signature'`.
3. u16BE version `=== 1` → `check: 'version'`.
4. u16BE option flags: **`0x1` (full-DAG) must be set** → else `check: 'options'`. git *aborts* here
   (Pin E, B19); a library cannot abort, so tsgit **declines** the artefact and falls back
   (ADR-605, ADR-616). No other bit is interpreted — Pin AH proves every flag-selected extension is
   trailing, so the flag word is never length-determining for anything tsgit reads.
5. u32BE entry count; `digestLength` bytes of embedded checksum, retained and never compared.
6. Four EWAH streams in order (commits, trees, blobs, tags), each **skipped by arithmetic**:
   `next = at + 8 + 8·wordCount + 4`, with `next <= bytes.length` proved **before** the word count
   is used for anything (git's own `eof in data` check, Pin J B21). The empty stream is
   `bitSize=0, wordCount=1` — 20 bytes, not 12 (Pin D); a parser that special-cases "empty means
   zero words" mis-parses git's output.
7. `entryCount` entry headers, each `{ u32 position, u8 xorOffset, u8 flags }` followed by a stream
   skipped the same way. Refuse if `xorOffset > i` (Pin AD rule 2 — the base must precede) or if any
   arithmetic would leave the buffer.

**Everything after the last entry is ignored.** The hash cache, the lookup table and the pseudo-merge
table are trailing (Pin AH) and none of them is consumed (§Out of scope).

**EWAH decoding is lazy, never materialised** (ADR-611, T-3). `foldEwahStream` walks run-length
words and folds directly into a caller-owned `Uint32Array` sized from the artefact's **object count**,
not from the stream's declared `bitSize`:

- a clean run of value 1 fills whole words with `0xffffffff`, **clamped at the destination's end**;
- a clean run of value 0 advances the cursor and writes nothing;
- literals are folded word by word, also clamped;
- a run-length word declaring 2³² clean words costs a bounded number of writes because the
  destination is bounded — the bomb (T-3) is defused by the **destination**, not by validating the
  declared length, which is exactly why the mitigation cannot be forgotten.

Refusals carry a dedicated error code with a closed `check` union
(`'size' | 'signature' | 'version' | 'options' | 'stream' | 'entry'`) — ADR-610's ratio, applied one
artefact over, and for the same reason: reusing `INVALID_PACK_INDEX` would be laundered by
`isSkippableIdxFault` into "skip this pack" and could remove a healthy pack from the generation.
The same "neither skip predicate admits it at any `check` value" assertion applies.

**The bound** (ADR-611, requirement 10). `MAX_PACK_BITMAP_BYTES` joins `validators.ts` beside
`MAX_MIDX_BYTES`, sized from the artefact's object count rather than as a flat number, with the
arithmetic **and its measurement** in the doc-comment:

```
maxBitmapBytes(objectCount) = BITMAP_HEADROOM_BYTES_PER_OBJECT * objectCount + BITMAP_FLOOR_BYTES
```

Measured density, so the headroom is a factor and not a guess: **16268 bytes / 1606 objects ≈ 10.1
bytes per object** for F2's pack bitmap and **16176 / 1621 ≈ 10.0** for F3's midx bitmap. A headroom
constant of 64 bytes per object is ~6× the measured density and still bounds a 2 M-object repository
at ~128 MiB — generous, finite, and derived rather than invented. The file is `stat`ed against this
bound before it is read; `objectCount` is itself bounded transitively through the `.idx` cap.

**A too-large `bitSize` is harmless, not a refusal.** The engine sizes its bit space from the
artefact's object count and clamps every fold at that boundary (T-3), so a stream claiming
`bitSize = 0xffffffff` (Pin J B22, which git also shrugs at) costs bounded work and contributes bits
only where they can mean something. The parser therefore does **not** cross-check `bitSize` against
the object count: it has no object count to check against (ADR-577), and the engine does not need
the check.

**File budget.** Header + entry headers + EWAH folding is comfortably under 400 lines; if it is not,
the EWAH reader splits into `src/domain/storage/ewah.ts` and the bitmap file keeps the container.

### §D4 — position mapping

Three mappings, one per artefact family. All of them are *application-layer* concerns (they need the
`.idx` or the midx, which a context-free parser must not reach for — ADR-577).

**Pack bitmap.** `bit p` is a **pack position**. Resolution:

```
oid = allObjectIds(index)[ revIndexPositionAt(rev, p) ]        // .rev usable
oid = allObjectIds(index)[ packPositionMap(index)[p] ]         // .rev absent/refused
```

`packPositionMap` is the index positions `[0, N)` ordered by `entryOffsets(index)[i]` — the same
information the `.rev` body holds (Pin B), computed in O(n log n) when the file is not there. Pin AF
is the licence: git does exactly this, and a bitmap without a `.rev` is fully usable.

Entry headers go the other way: an entry's `position` is an **index position**, so finding "the entry
for commit `c`" is `lookupPackIndex(index, c)` then a scan (or a prebuilt map) over entry headers.

**Midx bitmap.** `bit p` is a **pseudo-pack position**. Resolution needs the midx's reverse-index
chunk (ADR-617, Pin AG):

```
oid = midxOidAt(midx, midxReverseIndexAt(midx, p))
```

Entry headers are **midx positions** (Pin AG12), so `midxOidAt(midx, header.position)` names the
commit directly — no reverse-index hop. Getting this backwards is the single most likely
implementation bug in the entry, and AG12 is the assertion that catches it (108 / 108 one way, 0 /
108 the other).

`src/domain/storage/midx.ts` gains, following the existing optional-chunk pattern that `LOFF` uses:

```ts
// Same shape as CHUNK_ID_PNAM / CHUNK_ID_OIDF / CHUNK_ID_OIDL / CHUNK_ID_OOFF.
// The literal is Pin F's four bytes. The project dictionary carries those four
// chunk ids and NOT this one, so the same change adds the token to cspell.
const CHUNK_ID_REVERSE_INDEX = /* Pin F's {'R','I','D','X'} */;
// on MultiPackIndex:
readonly reverseIndexOffset: number | undefined;
export function midxReverseIndexAt(midx: MultiPackIndex, position: number): number;
```

Validation: the chunk, when present, must be exactly `objectCount × 4` bytes (Pin AG9); anything else
is a `check: 'chunk-length'` refusal in the existing union. **Absence is not a fault** — Pin AG7
shows a midx written without `--bitmap` has no such chunk, which is the common case. A midx bitmap
found beside a midx with no reverse-index chunk is simply not consumable, and the pack tier takes
over (Pin AG rule 5).

**Objects with no position.** Pin AH: a closure can contain objects that are in another pack or
loose. Those get positions appended after the artefact's object count in the engine's own bit space
(§D6), and their type comes from the object header, not from a type stream.

### §D5 — artefact discovery and fault classification (ADR-609)

`src/application/primitives/internal/pack-artefact-source.ts` owns discovery, the bounded read and
fault classification for all three artefacts, and is consumed by **four** callers: `buildOffsetTable`,
the closure engine, the `fsck` reverse-index pass and the `fsck` bitmap pass.

Names never come from inside a format (requirement 25):

| artefact | name | source |
|---|---|---|
| pack `.rev` | `<packBaseName>.rev` | `packBaseName(idxEntryName)` (`pack-shared.ts`), already `isSafePackName`-vetted |
| pack `.bitmap` | `<packBaseName>.bitmap` | same |
| midx `.bitmap` | `multi-pack-index-<hex>.bitmap` | `bytesToHex` of the **stored** trailer slice of the in-use midx layer — the same `head._bytes.subarray(bodyEnd)` `verifyMidxTrailer` (`midx-binding.ts:298-303`) already takes (Pin K rule 3, ADR-617) |

`scanPacks` already performs one `readdir` of `objects/pack/` and keeps the entry list to apply
ADR-579's sibling-`.pack` rule. **Presence** is read off that same listing filtered on
`entry.isFile` — no extra syscall, and symlinks and directories are excluded exactly as the `.idx`
filter excludes them (T-8). Artefacts are *read* only when a consumer asks.

Per-pack loads are single-flighted with `createPromiseMemo` (ADR-609, PR #263): a rejection is never
memoised, `refresh()` clears, `dispose()` is terminal.

Fault classification is one function shared by every consumer: `{ kind: 'absent' | 'unreadable' |
'refused' | 'usable', … }`, where `unreadable` is silent (git is — R12/B12/X6) and `refused` carries
the `TsgitError` for the caller to log or map to a finding. Consumers **never** re-classify.

### §D6 — the shared closure engine

`src/application/primitives/internal/closure-engine.ts`. One engine, two commands (ADR-613, ADR-614).

```ts
export type ClosureTier = 'bitmap' | 'walk';

export interface ClosureRequest {
  readonly wants: ReadonlyArray<ObjectId>;
  readonly not: ReadonlyArray<ObjectId>;
  /** Include trees and blobs, not just commits and tags. */
  readonly objects: boolean;
  /** The tier the **command** asks for. The engine holds no default (ADR-618). */
  readonly tier: ClosureTier;
}
export interface ClosureObject {
  readonly id: ObjectId;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  /** Walk tier only — a bitmap encodes reachability and type, never names
   *  (ADR-619, Pins AA/AJ7). */
  readonly path?: FilePath;
}
export interface ClosureResult {
  readonly objects: ReadonlyArray<ClosureObject>;
  /** The tier that actually answered: a `'bitmap'` request still answers `'walk'` after a
   *  silent fallback. Internal — neither command surfaces it. */
  readonly tier: ClosureTier;
}
```

**The engine answers both tiers; it decides no policy.** `tier` is an input, and the *command*
supplies it — `rev-list` from its caller-facing control (default `'walk'`), `pack-objects` from its
own (default `'bitmap'`). That split is the whole of ADR-618 in the code: two commands with opposite
defaults over one engine, because git has two commands with opposite defaults over one closure. An
engine that chose for itself could reproduce at most one of them.

**Within `tier: 'bitmap'`**, artefact preference follows Pin AG's measured order, each falling
through silently on any fault:

1. a usable midx bitmap for the in-use midx generation, if the midx carries a reverse-index chunk;
2. a usable pack bitmap;
3. the walk — the terminal fallback, which is result-preserving when `not` is empty and yields the
   walk's superset otherwise, exactly as git degrades (Pin AJ4).

Artefact selection is **not** conditional on the wants having entries — Pin AA6 and Pin AD1/AD2 show
git uses a bitmap for wants it has never heard of. ADR-616's phrase "covers the requested tips" is
therefore read as *"can be extended to the tips by a bounded partial walk"*, which is what git does.

**The bitmap algorithm**, pinned precisely enough to implement:

```
fill(tips) -> bit set B over [0, objectCount + extendedCount):
  pending = []
  for t in tips:
    e = entryFor(t)                     // §D4's header lookup
    if e: B |= reconstruct(e)
    else: pending.push(t)
  if pending is non-empty:
    walk commits from pending:
      on a commit that HAS an entry:  B |= reconstruct(entry); do NOT traverse its parents
      otherwise:                      set the commit's bit; if `objects`, walk its tree and
                                      set a bit for every non-gitlink entry
  return B

closure(request):
  W = fill(request.wants)
  N = fill(request.not)
  result bits = W AND NOT N            // Pin AB/AJ: the exact set difference
  for each set bit p: oid = §D4 mapping; type = §D3 type streams (Pin AE) or the object header
                      path is NOT produced — the artefact has none (ADR-619)
```

`W AND NOT N` is the **only** difference a bitmap can compute, and Pin AJ2/AJ3 confirm it is the one
git's bitmap tier reports (150). It is therefore not a choice this design makes; it is the tier's
semantics.

**Edges, each with its rule:**

- **Wants are peeled before anything else.** A want may be an annotated tag; `resolveTagChain`
  (`internal/object-emit.ts`) peels it, the tag oids join the result, and the peeled commit is what
  `fill` looks up. This is the existing enumerators' behaviour, reused rather than re-derived, and
  Pin AE's tags stream is the artefact's side of the same fact.
- **A want that resolves to a tree or a blob** has no bitmap entry and no parents. It contributes
  itself, plus its own subtree under `objects`, and nothing else.
- **Empty `wants`** yields an empty result — not an error, and not "everything".
- **`wants` fully covered by `not`** yields an empty result (Pin AB5 measures git doing this).
- **A revision that does not resolve** refuses, on either side. Revision resolution is a caller
  error and is **never** a degradation arm — degradation is about artefacts, never about revisions.
- **An unborn `HEAD` / empty repository**: `all` supplies no tips, so the result is empty.

`reconstruct(entry)` resolves the XOR chain (Pin AD6) **iteratively**: walk `xorOffset` links
backwards until an entry with `xorOffset === 0` or a cached reconstruction is reached, then fold
forward with `foldEwahStream(..., 'xor')` into a single reused `Uint32Array`. Chains of ~100 links
are normal (Pin AD3), so recursion is not an option.

Caching: a bounded LRU of reconstructed sets, sized by a named constant, because a reconstructed set
is `ceil(bitCount / 32)` words and caching all entries of a large repository's bitmap is
`entryCount × objectCount / 8` bytes — the one place in this design where an innocent-looking memo
is a memory bomb. The bound is a constant with its arithmetic in the doc-comment, ADR-600's shape.

**Extended positions** (Pin AH): objects the partial walk reaches that have no position in the
artefact are appended after `objectCount` in the engine's own bit space, with a side table
`extendedOids: ObjectId[]` and their types taken from the object header. The bit space is grown in
whole words; the cap is the existing `MAX_PUSH_OBJECTS`-class bound, reused rather than reinvented.

**The walk tier is git's walk — not the bitmap's answer recomputed by walking.** It marks the `not`
tips uninteresting along with their trees, recursing through those trees to mark their contents, then
walks the interesting commits and emits every object it reaches that carries no mark. It therefore
emits the **superset**: an object reachable from an *ancestor* of a `not` tip but absent from that
tip's own trees is never marked, so it is emitted again (Pin AB rule 1; Pin AJ1/AJ6 count it at
156 versus 150, all six extras blobs). The recursion through the marked trees is not optional and
the numbers say so: marking only the root tree *object* would re-emit that tip's entire tree, which
is far more than six objects. Under ADR-618 that over-report is the answer `rev-list`
returns by default, so **computing the exact difference here would be the divergence**, not the fix.
The walk tier also produces the `path` (§D7), which is the other thing the bitmap tier cannot.

The two tiers therefore share `fill`'s traversal machinery, the emit-dedupe and the type/oid mapping,
and deliberately **do not** share the difference step. That is still why one engine exists rather
than two commands growing their own: the shared half is the expensive, bug-prone half, and the
unshared half is four lines whose correctness is pinned from both sides by requirement 16's
superset invariant. The walk tier's fidelity is not argued, it is asserted — every have-bearing
interop row compares it against real `git rev-list --objects` with no tier flag.

**Order is deterministic per tier and is *not* equal across tiers.** The bitmap tier emits in
ascending bit position (Pin AA5 shows git's own two paths differ likewise); the walk tier emits in
walk order. Nothing sorts, because sorting a repository-sized array to satisfy a comparison no ADR
asks for is a real cost for no gain: the surviving obligation is on the object **set**, compared on
id and type (requirement 16), and ADR-249 puts ordering-for-display on the caller.

### §D7 — `rev-list` (ADR-613)

`src/application/commands/rev-list.ts`. Reachability core only: `wants`, `not`, `--objects`,
`--count`, `--max-count`, `--first-parent`, `--all`, `--no-walk`. Structured output (ADR-249):

```ts
export interface RevListOptions {
  readonly wants?: ReadonlyArray<string>;   // revisions; `all` supplies them when set
  readonly not?: ReadonlyArray<string>;
  readonly objects?: boolean;
  readonly count?: boolean;
  readonly maxCount?: number;
  readonly firstParent?: boolean;
  readonly all?: boolean;
  readonly noWalk?: boolean;
  /** Ask for the bitmap tier. **Defaults to `false`** — git's `rev-list` walks unless asked
   *  (ADR-618, Pin AJ1/AJ2). The bitmap tier returns the exact set difference and **no
   *  `path`**; a caller that needs paths must leave this off (ADR-619). It also changes what
   *  `firstParent` and `noWalk` mean, exactly as git's flag does (Pin AC rows 7/8). */
  readonly useBitmapIndex?: boolean;
}
export interface RevListEntry {
  readonly id: ObjectId;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  /** Present on the walk tier under `objects`; **absent on the bitmap tier**, which carries
   *  no names at any price (ADR-619, Pins AA/AJ7). */
  readonly path?: FilePath;
}
export interface RevListResult {
  readonly entries: ReadonlyArray<RevListEntry>;
  /** `entries.length`. With `objects` it counts objects; without it, commits and tags. */
  readonly count: number;
}
```

No `--pretty`, `--format`, `--date`, `--abbrev`, `--header`, `-z`, `--object-names`: every one of
those is presentation and ADR-249 bars it independently of ADR-613. `useBitmapIndex` is the one new
option and it is **not** in that family — it selects which of git's two disagreeing answers the
caller gets (Pin AJ), so it changes the data, not its rendering.

`count` is the entry count, and Pin AA3/AA4 pin that it moves with `objects`: **1605** with, **400**
without, on the same fixture and the same tip. `count: true` does not change *what* is computed, only
what the caller reads, so `entries` is populated either way and the caller may ignore it — there is
no separate count-only fast path, because the bitmap already computes the whole set to count it.

`all` supplies tips from every ref (branches, tags, remotes, `HEAD`) and composes with explicit
`wants` by union, exactly as git's `rev-list --all <rev>` does. A `--max-count` of `0` yields an
empty result rather than an unbounded one.

**The tier is the caller's, and the default is the walk** (ADR-618). `rev-list` passes
`tier: useBitmapIndex ? 'bitmap' : 'walk'` to the engine and nothing else decides. Two consequences,
each measured rather than reasoned:

- **By default, every option is already git-faithful with no special case.** git's `rev-list` walks
  too (Pin AJ1), so the walk tier's answer *is* git's answer for `--max-count`, `--first-parent` and
  `--no-walk` alike — the three rows Pin AC shows the bitmap getting wrong. The eligibility predicate
  the previous revision needed is gone: it was compensating for a missing tier control.
- **With `useBitmapIndex` set, tsgit composes as git composes.** `maxCount` still walks, because
  **git itself** abandons the bitmap for it (AC row 6) — declining there is reproduction, not policy.
  `firstParent` and `noWalk` keep git's measured behaviour: git loads the bitmap, answers from it and
  returns the full reachability closure as though the option were absent (AC rows 7/8, 227 versus 183
  and 227 versus 7). No ADR diverges from that, so ADR-226 settles it — and the option's doc-comment
  says so plainly, because it is the one place where asking for the bitmap changes what the *other*
  options mean.

Ordering: the returned array is **deterministic per tier** and is not git's, and it is not equal
across tiers (§D6). Pin AA5 shows git's own two paths order differently, so there is no single "git
order" to be faithful to, and ADR-249 puts ordering-for-display on the caller. Documented as
unspecified so a caller does not build on it, and asserted as a **set** in every equality test.

### §D8 — `pack-objects` (ADR-614)

`src/application/commands/pack-objects.ts`. Closure → pack, nothing else:

```ts
export interface PackObjectsOptions {
  readonly wants: ReadonlyArray<string>;
  readonly not?: ReadonlyArray<string>;
  /** Directory to write into; defaults to the repository's pack directory. */
  readonly outputDirectory?: string;
  /** Use the bitmap tier. **Defaults to `true`** — git's `pack-objects --revs` uses a usable
   *  bitmap unless told not to (ADR-618, Pin AJ3/AJ4). Setting it `false` mirrors git's
   *  `--no-use-bitmap-index` and yields the walk's larger, equally valid pack. */
  readonly useBitmapIndex?: boolean;
}
export interface PackObjectsResult {
  readonly packId: ObjectId;          // the pack's own checksum
  readonly objectCount: number;
  readonly packBytes: number;
  readonly indexBytes: number;
}
```

It composes what already exists: the closure engine (§D6) → `buildPack` (`build-pack.ts`) →
`serializePackfile` / `serializePackIndex` (`pack-writer.ts`). No progress line, no summary line
(ADR-249).

**The default tier here is the bitmap**, the opposite of `rev-list`'s and for the same reason: it is
git's (Pin AJ3). `pack-objects` carries none of the three options that defeat the bitmap, so nothing
narrows the default; the caller's only control is refusing it outright. Pin AB7/AB8 and Pin AJ3/AJ4
measure the composition: with no haves the two tiers agree exactly; with haves the bitmap pack holds
**150** objects against the walk's **156** and both packs are valid.

**Sending the smaller pack is safe, and the pin is why.** Every object the bitmap omits is reachable
from a `not` tip (Pin AJ6), so a peer that supplied those haves already has them. This is the one
place in the design where a *smaller* answer is the correct one, and it is git's own default
behaviour, not a tsgit optimisation.

Edges:

- An **empty closure** writes a valid 0-object pack and its index rather than refusing, matching git
  (Pin AB10). A caller that wants "nothing to send" reads `objectCount === 0`.
- **`packId` is stable for a fixed tier and is *not* stable across tiers.** Object order inside the
  pack is the closure's order, and §D6 pins that order differs between the bitmap tier and the walk
  tier — so the same closure written twice by different tiers yields packs with the same contents and
  **different names**. Assertions therefore read the object set back out of the written `.idx`, never
  `packId`: **equal** across tiers with no haves, and requirement 16's superset relation with haves,
  since the two tiers then legitimately pack different object counts. Naming this here because
  "content-addressed" invites the opposite assumption.
- Because ADR-614 excludes delta compression, nothing inside the pack depends on order beyond the
  identity above — and nothing in the pack writer wants a name, so ADR-619's optional `path` costs
  `pack-objects` nothing at all. The command never reads the field.

`.rev` and `.bitmap` writing and delta compression are excluded **permanently**, with ADR-614's
reasons, in §Out of scope. Because nothing is written beyond `.pack` and `.idx`, no `@writes`
annotation and no write-surface allowlist entry is added and that gate stays green untouched.

### §D9 — the two existing closures: **not** refactored, and why

**Recommendation: leave `enumeratePushObjects` and `enumerateBundleObjects` alone.** Three pinned
reasons, in descending force:

1. **`enumeratePushObjects` would change what tsgit pushes, on *either* tier.** It walks commits
   `until: haves` and then emits every object in every interesting commit's tree, never subtracting
   the haves' object closure — a strict **superset** of the exact difference, and a superset of even
   git's own over-reporting walk (Pin AB, Pin AJ1). ADR-618 does not soften this, it sharpens it:
   the engine now offers two tiers and **both** are subsets of what push emits, so there is no tier
   to substitute that leaves the pushed pack unchanged. It shrinks either way. That is a behaviour
   change by construction; it cannot be *proven* behaviour-preserving because the observable — the
   bytes on the wire — provably differs. The only honest proof available would be "a receiver accepts
   both", which is a weaker claim than behaviour preservation and is not what a refactor pass is
   licensed to land.
2. **`enumerateBundleObjects` needs something a bitmap does not encode.** It returns
   `{ objects, boundary }`, where `boundary` is the set of uninteresting commits that are direct
   parents of interesting ones. A bitmap encodes reachability, not parent edges (Pin AD/AE: bits and
   types, nothing else), so the commit walk survives the substitution and only the cheap half of the
   function would be accelerated.
3. **ADR-603's decision text enumerates five deliverables** — two `fsck` arms, the accelerator, the
   parser, and two commands — and this refactor is not among them. Leaving them alone is the ADR's
   own scope, not a narrowing of it.

**The cost, stated plainly:** tsgit ends this entry with *two* closure semantics in the codebase —
the engine's exact difference and `enumeratePushObjects`' superset — plus `enumerateBundleObjects`'
third, which is exact but carries a boundary. That is duplication, and a reviewer should see it named
rather than discover it. What the refactor pass **may** unify without touching semantics: the tree
recursion, the gitlink filter, the emit-dedupe (`internal/object-emit.ts`) and the depth bound, all
of which are already shared or trivially shareable. What it must **not** unify: the difference
semantics. The engine ships exactly one difference mode, because a second, unused mode is dead code
by the project's own guardrail.

### §D10 — the `.rev` accelerator in `buildOffsetTable` (ADR-604)

```ts
const raw = entryOffsets(index);                 // unchanged — the .idx is still required
const sortedOffsets = new Array<number>(n);
for (let p = 0; p < n; p += 1) sortedOffsets[p] = raw[revIndexPositionAt(rev, p)]!;
```

Pin AI is the correctness statement: `entryOffsets[revBody[p]]` is strictly increasing over all 1606
positions of F2. Absent, unreadable or refused `.rev` falls back to the existing sort — **the
fallback is the correct answer, so no result ever depends on the artefact's presence** (ADR-604).

| | today | with `.rev` |
|---|---|---|
| CPU | `Array.prototype.sort` — O(n log n) on numbers | O(n) gather |
| I/O | 0 extra | 1 extra file read, `4n + 12 + 2·dl` bytes (≈ 1/6 of the `.idx`) |
| memoisation | once per pack per `Context` | unchanged |

**The claim is measured, not asserted** (requirement 15): absolute wall-clock, main versus branch,
from the CI nightly artefact, over (a) a many-object repository and (b) a many-small-packs
repository, which is the shape where the extra `open`+`read` per pack can outweigh sorting a few
hundred numbers. A measured regression is a defect fixed in this PR.

**Two memos, one loader.** `buildOffsetTable` keeps ADR-604's exact fallback (the plain sort). The
bitmap layer needs a different derived value — the pack-position map (§D4) — and gets its own memo,
which uses the `.rev` body when usable and computes the offset-ordered index positions otherwise.
Both memos call the same `pack-artefact-source` loader, so the file is read at most once per pack per
generation and classified once.

**A trusted `.rev` is a correctness surface, and ADR-606 accepts it.** `sortedOffsets` feeds
`nextOffsetForEntry`, which decides where a packed entry's compressed data ends; a wrong body
produces wrong slice bounds and a read that either fails to inflate or inflates a truncated stream.
That is git's own exposure (R14 reads fine under git) and ADR-606 adopts it deliberately. T-6 records
it as **accepted, not mitigated**; a security review that flags it should be closed against ADR-606
rather than re-argued.

### §D11 — the `fsck` reverse-index pass

**The universe first, because it is pinned from both ends and it is the easiest thing to get wrong.**
The pass runs over **`registry.all()`** — packs the scan admitted (`.idx` present *and* parseable,
sibling `.pack` present per ADR-579) — and **not** over `health().accessible`:

| shape | git | tsgit's matching universe |
|---|---|---|
| `.idx` unparseable | no `.rev` check (Pin H C1 ≡ C2) | the pack is never registered — `indexFaults`, not `all()` |
| `.pack` absent, `.idx` present | no `.rev`/`.bitmap` check (Pin L Y4/Y6) | ADR-579 excludes the orphaned `.idx` at scan time |
| `.pack` present but unopenable | **`.rev`/`.bitmap` checked** (Pin L Y2/Y5) | in `all()`; refused only by the header gate, which `all()` does not apply (ADR-572) |

So `all()` is exactly right, ungated, in every mode, and it must **not** be narrowed by
`packAccessibilityReported` or Y2/Y5 lose their bits under `connectivityOnly`. The cost it inherits
rather than introduces: `all()` is lazy (ADR-597) and the `.rev` size rule needs `objectCount`, so
the pass forces every `.idx` parse in every mode — precisely the trade ADR-586's post-review note
accepted (*"read and parse every `.idx` but never open a `.pack`"*), and **neither new pass ever
opens a `.pack`**, so that guarantee is preserved verbatim.

git's three check families (Pin H rule 3) map onto three steps per pack:

```
for each pack p in registry.all() with a <base>.rev present and readable:
  index = await p.index()
  1. load    parsePackRevIndex(bytes, digestLength, index.objectCount)
             → refusal ⇒ finding{reason = the check's reason}, bit 64, next pack
  2. digest  hash(bytes[0 .. len−dl)) == bytes[len−dl ..]
             → false ⇒ finding{reason = 'invalid checksum'}, bit 64
  3. body    expected = index positions ordered by entryOffsets(index)
             for each position q in [0, N): stored[q] != expected[q]
             ⇒ one finding per mismatch, bit 64
```

Four things this shape settles, each against a pinned row:

- **Steps 2 and 3 both run** even when 2 fails (N2 emits `invalid checksum` *then* the position
  lines). Step 1 failing **skips** 2 and 3 — git cannot verify a file it could not load.
- **`expected` is the index positions ordered by offset**, i.e. exactly the pack-position map §D4
  already needs. This is the one derivation shared between the accelerator layer and the `fsck`
  layer, and sharing it is what keeps the two from drifting.
- **An out-of-range stored value is a step-3 mismatch, not a parse refusal** — R14 produces
  `invalid rev-index position at 0: <expected> != 999`, i.e. git compares it like any other value.
- **`packChecksum` is never compared** (R10b); its non-use is asserted by an interop row rather than
  left to inspection.

**Findings** (ADR-607 + ADR-608 composed). Three variants exist after this change:

| variant | cause | shape |
|---|---|---|
| `pack-rev-index-unusable` (existing) | the `.idx` made the reverse index unavailable | `{ pack, reason }` |
| `pack-rev-index-invalid` (new, ADR-607) | a fault in the `.rev` **file**: steps 1 and 2 | `{ pack, reason }` |
| `pack-rev-index-position-mismatch` (new, ADR-608) | step 3, one per mismatched position | `{ pack, position, expected, stored }` |

ADR-607 adds the second; ADR-608's per-position integers are **data**, not presentation, so they
cannot ride in a `reason` string and therefore need the third — which is exactly the argument the
draft's DC-5 used to reject its option (c). All three set bit 64; the bit is set once regardless of
finding count (Pin H rule 8). The findings array is built by loop-drain, never `push(...spread)`
(ADR-608: a spread over a repo-sized array overflows the call stack near 125k elements).

`EXIT_PACK_REV_INDEX`'s doc-comment is rewritten in the same change: the promise the code did not
keep is now kept, and the comment must stop saying otherwise (ADR-607).

### §D12 — the `fsck` bitmap pass: `internal/fsck/bitmap-health.ts`

ADR-589's shape, and the smallest pass in the codebase:

```ts
export async function runBitmapHealthPass(
  ctx: Context,
  _opts: FsckOptions,
): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }>;
```

`opts` is taken for symmetry and **ignored** — Pin J/K's mode rows are flat, the ADR-586 posture.

Its whole body, in order, over the **same `registry.all()` universe** §D11 argues for:

1. For each pack in `registry.all()` with `<base>.bitmap` present **and readable**: hash
   `[0, len − digestLength)`, compare to the trailing `digestLength` bytes. Mismatch ⇒
   `{ type: 'bitmap-checksum-mismatch', artefact: '<base>.bitmap' }` and `exitBit |= 128`.
   **`len < digestLength` is a mismatch, not an arithmetic edge** — a zero-length file and a
   10-byte file both score 128 under git (B11, B25), so the length guard comes *first* and produces
   the finding, never a negative `subarray` bound. This is the one place the "hash and compare"
   one-liner is wrong.
2. If a usable midx exists, compose `multi-pack-index-<hex(storedTrailer)>.bitmap` and do the same.
   **Not present ⇒ nothing** — which is how X7 and X10 come out right with no special case: a
   renamed file, or a midx whose stored trailer is wrong, simply names a file that is not there.
   The trailer bytes come from `LoadedMidx`, not from `MidxHealth` (which exposes a name and a
   boolean, not the layer's `_bytes`).
3. Unreadable ⇒ nothing, silently (B12, X6).

**No header parse, no version gate, no flag gate, no EWAH — even though the parser now exists three
files away.** Pin J rows B14–B19 are the licence and ADR-605 is the rule. This is the separation the
whole design leans on (§D1), so the RESTAMPED rows are **interop** rows, not unit rows: only the
interop harness can prove that tsgit and git agree that a structurally broken but correctly-stamped
bitmap is a non-event.

The finding carries `artefact` (the file name) and **no `reason`** — the exact shape of
`midx-checksum-mismatch` (`internal/fsck/types.ts:92`), for the same two situations: a midx bitmap
has no pack to name, and there is precisely one way to fail a checksum (Pin J rule 2).

**Ordering matters for exactly one thing and it is not correctness**: step 2 must run where the
in-use midx layer's identity is already settled, which `fsck.ts`'s existing sequence guarantees —
`runMidxHealthPass` already precedes the point where the new pass is inserted.

`EXIT_BITMAP = 128` joins `exit-codes.ts`; `FsckResult.exitCode`'s doc-comment gains the bit.

Step 2 is **unconditional** — ADR-612 declines the `core.multiPackIndex` gate, as a named deliberate
divergence. Pin AG5/AG6 now put a number on what that widens: with the key set to `false`, git reads
the *pack* bitmap where tsgit reads the *midx* one. Both yield the same object set (Pin AG13 versus
Pin AD7), so the divergence is in which file is opened, never in an answer.

### §D13 — degradation posture

**No Tier A, and no Tier B either.** Pins H, J, AA–AH contain no row where a read fails, no row where
a lookup result changes, and no row where an answer is lost. Every artefact is advisory in both
tools.

| condition | read path | closure path |
|---|---|---|
| `.rev` absent / unreadable / refused | `buildOffsetTable` sorts (ADR-604) | the pack-position map is computed (Pin AF) |
| `.rev` body wrong but well-formed | **trusted** — wrong slice bounds are possible (ADR-606, T-6) | same body, same exposure |
| pack `.bitmap` absent / unreadable / refused | unchanged — never opened | fall through to the next tier |
| midx `.bitmap` absent / unreadable / refused / undiscoverable | unchanged | fall through to the pack bitmap, then the walk |
| midx present without a reverse-index chunk | unchanged | midx tier unusable; pack tier takes over (Pin AG rule 5) |
| either artefact orphaned | unchanged — never named | never named |

**A fall-through *between the two bitmap artefacts* preserves the answer; a fall-through to the walk
changes it when haves are present — and that is faithful.** Both bitmap artefacts compute
`W AND NOT N`, so which one answers is unobservable. Reaching the walk yields git's superset instead
(Pin AJ4 measures git doing exactly this under `--no-use-bitmap-index`), which is why requirement 16
states a *relation* between the tiers rather than equality. ADR-616's "no result changes" survives
only in the no-haves case; ADR-618 amended it for the other.

Every degradation arm is a **positive allow-list** over `TsgitError.data.code` — the new `.rev` code,
the new bitmap code, `FILE_NOT_FOUND`, `PERMISSION_DENIED` — with everything else rethrown. Never
`if (isFatal) throw`, which silently swallows a future member (ADR-575, ADR-610). Codes are compared
structurally on `data.code`, never with `instanceof`, because these errors cross module graphs.

Faults are logged with the artefact name **except** where git is silent (R12/B12/X6). ADR-616's rule
restated: silence about the *strategy* (which tier answered) is total and deliberate; silence about a
*fault* is only where git is silent.

### §D14 — error semantics

| condition | today | after | git |
|---|---|---|---|
| any read, any `.rev`/`.bitmap` state | succeeds | **unchanged** | Pin H/J `cat-file` |
| `fsck`, `.rev` fails a load check | exit 0, no finding | `pack-rev-index-invalid` + bit **64** | R1–R8, R7b–R7d, R17 |
| `fsck`, `.rev` digest wrong | exit 0 | `pack-rev-index-invalid` + bit **64** | R9b |
| `fsck`, `.rev` body wrong | exit 0 | **one `pack-rev-index-position-mismatch` per position** + bit **64** | R14, R15, N1 |
| `fsck`, `.rev` hashId 2 in a SHA-1 repo | exit 0 | **exit 0, no finding** | R16 |
| `fsck`, `.rev` embedded pack checksum wrong | exit 0 | **exit 0, no finding** | R10b |
| `fsck`, `.idx` unusable (`.rev` state irrelevant) | bit 64 (existing) | **unchanged** — no second finding | C1 ≡ C2 |
| `fsck`, `.bitmap` digest wrong (pack or midx) | exit 0 | `bitmap-checksum-mismatch` + bit **128** | B2–B11, X1, X4, X8 |
| `fsck`, `.bitmap` structurally corrupt but digest valid | exit 0 | **exit 0, no finding** | B14–B19 |
| `fsck`, midx trailer wrong **and** midx bitmap corrupt | exit 0 | bit **32** only, **never 128** | X10 |
| either artefact absent / unreadable / orphaned | exit 0 | **exit 0, no finding, no warn** | R11–R13, B1, B12, B23, X5–X7 |
| `fsck`, artefact corrupt **+ `.pack` refused at the header gate** | bit 4 (existing) | bit 4 **and** the artefact bit | Y2 (142), Y5 (78) |
| `fsck`, artefact corrupt **+ `.pack` absent** (orphaned `.idx`) | exit 0 | **no artefact bit** | Y4, Y6 (10) |
| `fsck`, `.bitmap` shorter than one digest | exit 0 | `bitmap-checksum-mismatch` + bit **128** | B11, B25 |
| **closure**, bitmap structurally broken (restamped) | n/a | **silent fallback to the walk** — identical answer with no haves, git's superset with haves | B14–B22, AJ4 |
| **closure**, bitmap without the full-DAG flag | n/a | **silent fallback** (git aborts — not replicable) | B19 |
| **closure**, caller asks `rev-list` for the bitmap tier | n/a | exact difference, **no `path`** | AJ2, AJ7 |
| **closure**, caller refuses `pack-objects`' bitmap tier | n/a | the walk's superset, packed and valid | AJ4 |
| **closure**, `.rev` absent, bitmap healthy | n/a | **bitmap still used** | Pin AF1 |

**Seven rows end `exit 0, no finding`** (R16, R10b, B14–B19, X10, Y4/Y6) and they remain the design's
hardest-won content: each is a place where an obvious-looking check would make tsgit *stricter* than
git, and stricter is still a divergence. They still outnumber the rows that add a bit.

### §D15 — cache and invalidation

- Artefact **presence** is settled inside `scanPacks`, so it rides the existing scan
  `createPromiseMemo`: single-flight, rejection never memoised, cleared by `refresh()`, `dispose()`
  terminal.
- Per-pack `.rev` load, pack-position map and `.bitmap` load are each a `createPromiseMemo` beside
  `indexMemo` / `headerMemo` / `offsetTable` — the pattern `registered-pack` already uses four times.
- The **midx bitmap** is memoised per **generation**, not per pack, because its identity depends on
  the midx layer in use (Pin K rule 3). A `refresh()` that changes the midx changes the artefact
  name, so the memo must hang off the generation and not outlive it.
- Reconstructed entry bit sets live in the bounded LRU of §D6, which is per closure **call**, not per
  `Context`: a closure is a one-shot computation and a cross-call cache would pin repo-sized memory
  for the life of a `Context`.
- The `fsck` passes are not memoised; `fsck` runs each pass once.
- **No `FileHandle`.** All three artefacts are read whole via `ctx.fs.read` (requirement 26).
- **Interop tests that let real `git` write or mutate these artefacts must build a fresh `Context`
  afterwards** — a `Context` constructed before the subprocess holds a memoised generation that
  predates it. Hard rule, not a note.

### §D16 — hash-width genericity (explicit checklist)

| # | site | rule |
|---|---|---|
| H-1 | `parsePackRevIndex` | takes `digestLength`; never reads `ctx.hashConfig`; never hard-codes 20 or 32 |
| H-2 | `.rev` `hashId` field | recorded, **never** mapped to a width and **never** compared to anything (R16) |
| H-3 | `REV_HEADER_SIZE = 12` | hash-independent (Pin B) |
| H-4 | `.rev` size rule | `12 + 4·N + 2·digestLength` — **two** digests, not one; the too-small/corrupt split is at `12 + 2·digestLength` |
| H-5 | both trailer verifications | `ctx.hash.hash(bytes.subarray(0, len − digestLength))` with the algorithm from **`ctx.hashConfig`** — the repository's, exactly as `verifyMidxTrailer`. **The opposite of the midx rule**, which selects from the artefact's own `hashVersion` byte. Pinned, not assumed: R16 restamps a `hashId = 2` `.rev` with SHA-1 and git accepts it |
| H-6 | midx bitmap filename | `2 × digestLength` hex, not `40` |
| H-7 | `.bitmap` header offsets | checksum at byte 12, first type stream at `12 + digestLength` — the **only** width-dependent offset in the format, and now live |
| H-8 | `.bitmap` entry headers and EWAH words | width-independent: u32 positions, u8 offsets, u64 words |
| H-9 | midx reverse-index chunk | width-independent (u32 per object); the midx's `digestLength` is already carried on `MultiPackIndex` |
| H-10 | the surrounding subsystem | `IDX_SHA_LENGTH = 20` stays a pre-existing SHA-1-only limit (B-10); neither widened nor relied on. SHA-256 rows are parser and pass units, per Pin G |

### §D17 — write-path symmetry (explicit checklist)

| # | write surface | interaction | verdict |
|---|---|---|---|
| W-1 | `serializePackfile` / `serializePackIndex` (`pack-writer.ts`) | writes `.pack` + `.idx`, **no `.rev`**, **no `.bitmap`** | **a live cross-tool asymmetry, pre-existing and now permanent** (ADR-614): git writes `.rev` by default (Pin A), so a tsgit-written pack lands beside git-written packs that all have one. Harmless in both tools (R11, B1) and it stays harmless — but a tsgit repository is *distinguishable* from a git one. Recorded, excluded permanently with ADR-614's reason |
| W-2 | `materializePack` (`fetch-pack.ts`) | writes a fetched pack | no `.rev`/`.bitmap` arrives with it (they are local artefacts, never transported); nothing stale can be created |
| W-3 | **`pack-objects`** (new) | writes `.pack` + `.idx` into the pack directory | same as W-1 by construction. It must **not** invalidate a sibling midx: a new pack the midx does not name is simply not in the midx's universe, which ADR-592 already handles. The registry `refresh()` contract is what makes the new pack visible |
| W-4 | **overwriting a pack in place** | would orphan a stale `.rev`/`.bitmap` | structurally impossible — pack names are content-addressed, so a rewritten pack has a new name and its own (absent) artefacts |
| W-5 | any future `gc` / `repack` / `prune` | **deletes packs** | a deleted pack's `.rev`/`.bitmap` must be deleted with it or the directory accumulates orphans. Orphans are *harmless* (R13/B23), so this is hygiene, not correctness — strictly weaker than the midx's equivalent constraint, which is a correctness one (ADR-614) |
| W-6 | `tooling/audit-write-surfaces.ts` | scans for annotated write surfaces | `pack-objects` writes through the **existing** annotated pack-writing surface; no new artefact kind is written, so no new `@writes` annotation and no allowlist entry (ADR-614) |

### §D18 — threat model

The subject is three binary formats an attacker with **repository write access** fully controls, two
of which now steer **which objects a pack contains**. They are **not** network artefacts — no
transport delivers any of them (W-2) — which bounds but does not remove the exposure: a hostile
`.git` arrives via a cloned tarball, a shared checkout, a CI cache restore, or a vendored fixture.

| # | concern | assessment |
|---|---|---|
| T-1 | **No format contains a name or a path** | Still the biggest structural advantage over the midx, and it survives the scope expansion untouched: `.rev`, `.bitmap` and the reverse-index chunk carry only integers and digests. Every filename is composed from an already-vetted pack base name or from hex-rendered digest bytes (§D5), so the traversal class is **absent by construction**, not mitigated |
| T-2 | **Unbounded allocation from a declared count** | `.rev` has no declared count; its exact-size rule (§D2 step 5) is simultaneously the bound. `.bitmap` declares `entryCount` and a per-stream `wordCount`, and B21's `0x7fffffff` is the live shape. **Mitigation, binding (ADR-611):** every declared length is validated against the **remaining buffer** before it is used for anything — git's own `eof in data` check — and no array is ever allocated from a declared count |
| T-3 | **Decompression-bomb EWAH runs** — *live, and the highest-severity item in this design* | A run-length word can declare 2³² clean words = 2³⁸ bits ≈ 32 GiB if materialised. **Mitigation, concrete and implementable:** (a) EWAH streams are **never materialised**; `foldEwahStream` folds directly into a caller-owned `Uint32Array` whose length is `ceil(bitCount / 32)` with `bitCount` derived from the artefact's **object count**, never from the stream's declared `bitSize`; (b) fills are **clamped at the destination's end**, so a 2³²-word run costs a bounded number of writes and then stops; (c) the stream's declared `wordCount` is bounds-checked against the remaining buffer before any word is read; (d) the totality property test (§Test) asserts no input in the declared safe subset produces a `RangeError` or an allocation failure. The destination bound is what defuses the bomb, which is deliberate: it cannot be forgotten, because without it the fold has nowhere to write |
| T-4 | **Out-of-bounds `DataView` reads** | Both parsers prove every offset before reading it (§D2 steps 1/5, §D3 steps 1/6/7). A `RangeError` escaping either is a defect (requirement 11), and the totality properties are the guard |
| T-5 | **Integer overflow in offset arithmetic** | `.rev` values and bitmap bits are u32 positions, not offsets — they index `entryOffsets`/`allObjectIds`, whose own 64-bit handling (`readOffset`, `pack-index.ts:93-108`) is untouched. Bit-space arithmetic uses word indices bounded by the object count. **No new offset arithmetic is introduced** |
| T-6 | **A non-permutation `.rev` body redirects slice bounds** | Live under ADR-604. A hostile body makes `nextOffsetForEntry` return wrong bounds, so a read either fails to inflate or inflates a truncated stream. **Accepted, not mitigated** (ADR-606): it is git's own exposure (R14 reads fine under git), and an attacker who can rewrite a `.rev` can rewrite the `.pack` and `.idx` it describes. A security review that flags this closes it against ADR-606 |
| T-7 | **A hostile bitmap produces a wrong object set — and therefore a wrong pack** | Live under ADR-613/614. A crafted bitmap can omit objects from `pack-objects`' output (producing an incomplete pack) or add unrelated ones (leaking objects the caller did not ask for, bounded to objects already in the repository). **Accepted, not mitigated** (ADR-615), symmetric with T-6 and on the same ratio: the attacker who can rewrite the bitmap can rewrite the pack. **Residual, stated:** the fast path is silent and, under ADR-618, it is `pack-objects`' **default**, so nothing warns and nothing opts in; the *only* thing standing between a decoder bug and a wrong pack is ADR-615's walk oracle and requirement 16's double run — now a superset-plus-reachability check rather than a plain equality, which is *harder* to satisfy accidentally. Those tests are load-bearing security controls, not hygiene, and trimming them is a security regression |
| T-8 | **A stale artefact paired with the wrong pack** | Undetectable by design: git stores the pack/midx checksum in `.rev` and `.bitmap` and **checks neither** (R10b, B16). A pack's filename is its content hash, so a stale artefact requires a deliberate rename, which requires the same write access as replacing the pack. Accepted, matching git |
| T-9 | **Symlinked artefacts** | Presence comes from the `readdir` listing with `entry.isFile` (§D5), which excludes symlinks exactly as the `.idx` filter does, so a symlinked artefact pointing outside the repository is never opened. A *stronger* posture than open-by-path, at no cost |
| T-10 | **Log injection** | No format carries text. The only string in any finding is a pack base name already vetted by `isSafePackName` or a hex digest. `faultContext`'s "never nest a name inside `err.data`" rule still applies |
| T-11 | **A degraded universe feeding a destructive computation** | tsgit still has no `gc`/`prune`, and `pack-objects` only *writes*. A bitmap can shrink a computed closure (T-7), which matters for what a pack contains but cannot delete anything. **Hard constraint on any future pruning surface: it must not consult a bitmap for reachability**, for the same reason `fsck` must not — a cached answer is not a verified one |
| T-12 | **`fsck` must not consult a bitmap** | Structural, and it is now enforceable rather than hypothetical because a parser exists in the same package. `fsck`'s reachability pass verifies the graph; a bitmap is a cached claim about it. ADR-605 keeps the bitmap pass parse-free, and the RESTAMPED interop rows are the mechanical guard: fusing the paths turns them red |
| T-13 | **Work amplification at `fsck` time** | The `.rev` body cross-check is O(n) per pack and the digest checks are O(file) — one full hash of every `.rev` and every `.bitmap` per `fsck` run. git pays exactly the same (`verify_bitmap_files` hashes every bitmap), so this is parity, not overhead; named because `fsck`'s cost profile changes measurably and the bench should see it |
| T-14 | **Memory amplification at closure time** | Reconstructed bit sets are `ceil(bitCount/32)` words each; caching all entries of a large repository's bitmap is `entryCount × objectCount / 8` bytes. **Mitigation:** the bounded per-call LRU of §D6 with its size as a named constant, plus the per-call (not per-`Context`) lifetime of §D15 |

### §D19 — blind spots, named

1. **`verify-pack` is stricter than `fsck` and tsgit models neither.** R10b and R16 exit 0 under
   `fsck` and 1 under `verify-pack`. tsgit inherits `fsck`'s laxity. A future `verify-pack`-class
   command must re-pin this, because the two commands genuinely disagree about what a valid `.rev`
   is.
2. **The `.rev`'s and the bitmap's embedded checksums are dead data in both tools.** Retained by both
   parsers so a future consumer need not re-parse; their non-use is a deliberate match to git.
3. **`0x2` in the bitmap flag word was never observed.** Pin E is a matrix over configurations git
   2.55.0 offers, not over the format's value space. §D3 reads only `0x1` and ignores the rest, which
   makes this blind spot harmless — but a future consumer of the extensions inherits it live.
4. **git aborts on a bitmap without the full-DAG flag** (B19, exit 134). Not replicable by a library.
   tsgit declines and falls back (ADR-605/616). The row is reachable now that a parser exists, so it
   is an interop row asserting tsgit answers correctly where git dies.
5. **Pin K rule 3's midx-trailer coupling is transitive and fragile**, and ADR-617 widens it: a midx
   bitmap's *discoverability* now gates a read-path accelerator, not just an `fsck` bit. If ADR-602's
   trailer verification ever moves onto the read path, or the in-use midx layer selection changes,
   the accelerator's availability changes with it. X10's interop row is the guard and it is the row
   most likely to look like a test bug when it fails.
6. **`fsck --no-full` adds a constant on an all-packed fixture** (Pin I M0 = 2). Interop assertions
   must compare **bit-wise** against a per-mode control, not against literals.
7. **Bit ordering versus future bits.** git's mask is `1, 2, 4, 8, 16, 32, 64, 128`; tsgit models
   seven of eight after this change. **16 (commit-graph) stays never modelled.**
8. **`pack.writeReverseIndex` and `pack.writeBitmapHashCache` are git policy, not format guarantees.**
   Nothing here depends on either default — every artefact-absent row is clean — but the urgency
   argument in §Context does.
9. **The bitmap's commit selection is git's policy and is not pinned as a rule.** Pin AD measures
   *that* selection is partial (108 of 400) and that a 30-commit repository gets full coverage; the
   selection *algorithm* is deliberately not modelled, because tsgit never writes a bitmap and a
   consumer must work for any selection. A test fixture that happens to select every commit would
   hide the entire partial-coverage path — which is why F2 (400 commits) is the mandatory closure
   fixture and F1 is not sufficient.
10. **The tier divergence is fixture-dependent** (AB9 shows none; F5 was built to show it). Any
    closure fixture used for have-bearing queries **must** repeat blob content across the have
    boundary, or the disagreement ADR-618 exists to resolve goes unmeasured — and requirement 16's
    superset invariant degenerates into an equality that passes for the wrong reason.
11. **The `{'B','T','M','P'}` chunk is parsed by nobody.** §D4 resolves bits without it. If verbatim
    pack reuse ever arrives it becomes load-bearing, and Pin AG11 is the head start.

## Test strategy

### Unit — `test/unit/domain/storage/rev-index.test.ts` (new)

Fixtures **crafted in-test** (ADR-578), from a `buildRevIndex({ objectCount, digestLength, hashId, body })`
helper emitting Pin B's layout; every negative row is that builder plus one named mutation.

- **Accept**: 0 objects; 1 object; 12 objects; `hashId: 2` with `digestLength: 32`; **`hashId: 2`
  with `digestLength: 20`** — the R16 row, written as an *accept* deliberately, with the reason in
  the title, so a later "hardening" pass cannot silently turn it into a refusal.
- **Refusals**, each asserting `.data.check` **and** the reason string (never `toThrow(Class)`):
  zero-length; 11 bytes; `12 + 2·dl − 1` (`too small`); `12 + 2·dl` exactly with `objectCount > 0`
  (`corrupt` — the R7c/R7d boundary, two rows one byte apart); one byte long; one byte short; bad
  magic; version 0; version 2; `hashId` 0; `hashId` 3.
- **Guard isolation**: the size guard's two arms each get a row that triggers only it.
- `revIndexPositionAt` at `0`, `N−1`, `N` (bounds refusal), and an **out-of-range stored value**
  asserting it is *returned*, not refused (§D2's ADR-606 line).

### Unit — `test/unit/domain/storage/bitmap.test.ts` (new)

A `buildBitmap({ digestLength, flags, entries, typeStreams })` builder emitting Pin D's layout, with
an `encodeEwah(bits)` helper that produces run-length and literal words (needed for the round-trip
property below and for realistic negatives).

- **Accept**: the Pin D 12-object shape; the empty tags stream as `bitSize=0, wordCount=1`
  (a row whose title says *20 bytes, not 12*); flags `0x0001`, `0x0005`, `0x0015`, `0x0025` — all
  four accepted identically, with a row asserting `entriesOffset` is **the same** under each
  (Pin AH's rule, as a unit assertion).
- **Refusals** with `.data.check`: short header; bad magic; version 0; version 2; **flags without
  `0x1`**; a stream `wordCount` that overruns the buffer; an entry whose stream overruns; an
  `xorOffset` greater than the entry's own index; a **non-zero** `xorOffset` on entry 0.
- **The bomb row, as a unit test**: an entry stream whose run-length word declares 2³² clean words,
  asserting the fold **returns**, fills the destination to its end and writes nothing past it — the
  T-3 mitigation with an explicit test rather than an implicit one.
- **Fold**: `foldEwahStream` with `'or'` and `'xor'` into a pre-sized array; a clean run longer than
  the destination asserting it is **clamped, not thrown** and costs bounded work; a literal-only
  stream; a run-of-zeros stream.

### Unit — XOR-chain reconstruction and mapping

`test/unit/application/primitives/internal/closure-engine.test.ts`:

- reconstruction of a hand-built chain `A(xor 0) ← B(xor 1) ← C(xor 1)` equals the intended sets
  (Pin AD6), including a chain of length > 64 to prove the walk is iterative;
- entry-header interpretation: a **pack** bitmap header resolves through the `.idx`, a **midx**
  bitmap header resolves through `midxOidAt` **without** the reverse-index hop (Pin AG12) — the two
  assertions that catch the likeliest bug in the entry;
- extended positions: a want reachable only through a loose object yields it with the right type;
- artefact preference inside the bitmap tier: midx bitmap ≻ pack bitmap ≻ walk, with each refused in
  turn (Pin AG1–AG6);
- **the engine holds no tier default**: the same request answered with `tier: 'walk'` and
  `tier: 'bitmap'` returns the walk's and the bitmap's answers respectively, and neither command's
  default leaks into the engine — the assertion that keeps ADR-618's policy in the commands.

### Property tests

Per the four lenses, `*.properties.test.ts` siblings with a shared `arbitraries.ts`:

- **`rev-index.properties.test.ts`** — lens 1 (round-trip): `parsePackRevIndex(buildRevIndex(spec))`
  reproduces every header field and `revIndexPositionAt` reproduces every body word, for arbitrary
  `objectCount ∈ [0, 500]`, `digestLength ∈ {20, 32}`, and **arbitrary body words including
  non-permutations and out-of-range values** — the parser must not care. `numRuns: 200`.
  Lens 3 (totality): any byte string in the declared safe subset either parses or throws a
  `TsgitError` with a `check` from the closed union — never a `RangeError`. `numRuns: 100`.
- **`bitmap.properties.test.ts`** — lens 1: `foldEwahStream(encodeEwah(bits)) ≡ bits` for arbitrary
  sparse and dense bit sets over `[0, 5000)`, `numRuns: 200`. Lens 3 (**the strongest fit in this
  entry**): for any byte string in the declared safe subset, `parsePackBitmap` returns a `PackBitmap`
  or throws a closed-`check` `TsgitError` — never a `RangeError`, never an unbounded run. The
  bounded-work half is assertable rather than aspirational: the destination array is
  **caller-owned**, so the property asserts its `length` is unchanged by every fold and that no bit
  is set at or beyond it, whatever the stream declares. `numRuns: 100`.
- **XOR chains** — lens 2 (compositional): folding a chain is associative in the sense that
  `reconstruct(i)` is independent of which cached ancestor the walk starts from; and lens 4
  (idempotence): reconstructing the same entry twice returns equal sets. `numRuns: 100`.

### Unit — the passes

- `test/unit/application/commands/internal/fsck/bitmap-health.test.ts` (new): a table over Pin J/K —
  digest mismatch on a pack bitmap, on a midx bitmap, absent, unreadable, orphaned, **and every
  RESTAMPED structural corruption asserting no finding**.
- `test/unit/application/commands/internal/fsck/pack-health.test.ts` (extend): the three `.rev`
  families, the three variants, per-position cardinality, and C1 ≡ C2.
- `test/unit/application/commands/fsck.test.ts` (extend): bit composition (64, 128, 192) and the
  **mode matrix** — each new bit asserted under default / `connectivityOnly` / `full: false` /
  `strict`, bit-wise against a per-mode control (blind spot 6).
- `test/unit/application/primitives/pack-registry.test.ts` (extend): `buildOffsetTable` produces
  **identical** `sortedOffsets` with and without a `.rev`, and falls back on each fault class.
- **Allow-list audit rows** (ADR-599/610's precedent): `isSkippableIdxFault` and
  `isSkippablePackFault` return `false` for the new `.rev` code **and** the new bitmap code at
  **every** `check` value. Asserted, not inspected.

### Integration / interop — `test/integration/rev-bitmap-fsck-interop.test.ts` (new)

One shared `beforeAll(fn, 60_000)` building the fixture repo with real `git` (scrubbed `GIT_*`,
isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off), then one row per mutation, each in its own
copy. **A fresh `Context` after every `git` subprocess** (§D15).

Per row: run real `git fsck`, run `tsgit.fsck()`, assert **`exitCode` equality** and assert the tsgit
findings reconstruct git's stderr lines (ADR-249 — reconstruction lives in the test).

Rows: R0, R1, R2, R5, R6, R8, R9b, **R10b**, R11, R12, R13, R14, R15, N1, **R16**, R17, C1, **C2**,
and multi-pack composition. Then B0, B1, B2, B9, B12, B23, **B14**, **B16**, **B18**, B24. Then X0,
X1, **X2**, X4, X5, **X7**, X8, **X10**. Then Y1, Y2, Y3, **Y4**, Y5, **Y6**.

The **bolded** rows assert an exit code with **no** artefact bit where a naive implementation would
score one — they are the majority of the design's `fsck` risk and must not be trimmed. R14/R15/N1
assert finding **cardinality** and message *shape*, never the fixture-dependent integer pair.

### Integration / interop — `test/integration/rev-bitmap-closure-interop.test.ts` (new)

The consumption faithfulness surface, and under ADR-615 a **security control**. Fixtures F2 (400
commits, **repeated blob content across the have boundary** — blind spot 10), F3 (two packs + midx +
midx bitmap), F4 (a real merge) and F5 (Pin AJ's fixture), each built once in a
`beforeAll(fn, 60_000)`.

**The cross-tier invariant, stated once and asserted everywhere** (requirement 16, ADR-618 amending
ADR-616). Every closure row runs on both tiers and asserts, on **object id and type only — never on
`path`** (ADR-619):

1. `not` **empty** ⇒ the two tiers return **exactly** the same set;
2. `not` **non-empty** ⇒ `bitmapSet ⊂ walkSet`, **and** every object in `walkSet \ bitmapSet` is
   reachable from a `not` tip — asserted by an independent full `rev-list --objects <not-tip>`
   closure, not by inspection;
3. neither direction is asserted on order, on `packId`, or on `path`.

Part 2 is the one that would silently pass on a fixture without repeated content, so it runs on F2
and F5 and is **asserted to be non-trivial**: the difference set is asserted **non-empty** on those
fixtures, which is what turns a vacuous superset check into a real one.

| obligation | rows |
|---|---|
| **ADR-616 double run** — every closure test runs twice, once on a fixture carrying a bitmap and once on the same repository with the bitmap removed, under the invariant above | every row below, ×2 |
| **ADR-615 walk oracle** — the bitmap-accelerated closure compared against a full walk closure **on oid and type**, under the invariant above | every row below |
| set equality against real git, no haves | AA1/AA2, AA6, AH1, AH2, AJ5 |
| **type** correctness for every returned object | AE, against `cat-file --batch-check` |
| have-bearing queries, **per-command referent** | AB1–AB5, AB9, AJ1–AJ4: `rev-list` with no tier option compared against plain `git rev-list`, `rev-list` with the tier option against `git rev-list --use-bitmap-index`, `pack-objects` against `git pack-objects --revs`, `pack-objects` with the tier refused against `--no-use-bitmap-index` |
| **`path` presence is tier-determined** | AJ7: the walk tier populates it under `objects`, the bitmap tier returns entries with none, and the count of path-carrying entries is asserted on both (127 versus 0 on F5) |
| option composition | AC: `--max-count`, `--first-parent`, `--no-walk` asserted **equal to git's default** with no tier option; with the tier option, `--max-count` asserted still equal (git declines the bitmap itself) and the other two asserted equal to `git rev-list --use-bitmap-index` |
| artefact preference | AG1–AG6 |
| midx mapping | AG12/AG13 — the midx bitmap's answer equals the pack bitmap's on F3 |
| `.rev`-free consumption | AF1, AF3 |
| degradation | every Pin J RESTAMPED corruption asserting the answer falls back to **the walk's**, plus B19 (flags without full-DAG) asserting tsgit answers where git aborts |
| `pack-objects` | AB7/AB8, AJ3/AJ4: the written pack's object set on both tiers, and `git index-pack --verify` accepting the pack tsgit wrote |

The first two rows are **obligations, not conveniences** — ADR-616's double run as amended and
ADR-615's walk oracle — and under ADR-615 they are the only thing between a decoder bug and a wrong
pack. They are named as such **in the test titles**, so a future trimming pass has to delete a
sentence that says why they exist.

### Parity

Both new commands are invoked from a `test/parity/scenarios/*.scenario.ts` `run()` (or allowlisted
with a reason). A closure scenario that builds a small pack + bitmap in memory proves node / memory /
browser agreement. Any new runtime gate lands in **all five** dist-bundle drivers.

### Bench

From the **CI nightly artefact**, absolute wall-clock, main versus branch — never a local run, never
a self-share delta:

1. `buildOffsetTable` over a many-object repository (ADR-604);
2. `buildOffsetTable` over a many-small-packs repository (ADR-604 — the shape where the extra
   `open`+`read` per pack can lose);
3. closure with a bitmap versus closure by walk, on F2-scale and larger, to price the acceleration
   the two commands exist to deliver;
4. `fsck` on a repository with `.rev` + `.bitmap` present, to see T-13's added hashing.

### Gates

`npm run validate`; 100% coverage on new domain/adapter code; Stryker scoped to the new files with 0
surviving mutants (equivalents proven against *this* structure, never carried forward); the Tier-1
surface tax for **both** commands — barrel, facade + the sorted `Object.keys(sut)` surface-lock in
`test/unit/repository/repository.test.ts`, `docs/use/commands/rev-list.md` and
`docs/use/commands/pack-objects.md` + index rows, parity scenario invocations, the README Tier-1
count, and a regenerated `reports/api.json` (a prepush gate, so it is pre-paid in the slice that adds
the export).

## Out of scope

Everything below is excluded **permanently, with its reason**. Nothing here is deferred to a
follow-up entry.

- **Writing `.rev` or `.bitmap`** (ADR-614). Reason: it needs an EWAH *encoder* and an annotated
  write surface, and the consequence of not having it is a non-event in both tools (R11, B1). The
  cross-tool asymmetry is recorded at W-1 rather than fixed, and this stays a read-side entry by
  construction.
- **Delta compression in `pack-objects`** (ADR-614). Reason: it is a pack-*writer* concern, not a
  bitmap one; the pack writer currently emits base entries only, and changing that belongs to
  whatever entry takes the writer on.
- **`rev-list` options beyond the reachability core** (ADR-613) — date/author/grep filters,
  `--boundary`, `--merges`/`--no-merges`, parent/child annotation, `--left-right`, `--bisect*`,
  ordering (`--topo-order`, `--date-order`), simplification, path limiting, `--disk-usage`,
  `--unpacked`, `--stdin`. Reason, per option class: the filters **defeat bitmap acceleration**
  (git abandons the bitmap for them, Pin AC's `--max-count` row is the measured instance), the
  ordering and simplification options need machinery tsgit does not have, and every
  formatting option is barred by ADR-249 independently.
- **Refactoring `enumeratePushObjects` / `enumerateBundleObjects` onto the closure engine** (§D9).
  Reason: for push it is a **behaviour change, not a refactor** — the pushed pack provably shrinks
  (Pin AB) — and for bundle a bitmap cannot supply the `boundary` set at all, so the substitution
  would accelerate only the half that is already cheap.
- **Bitmap-backed reachability inside `fsck`** (T-12). Reason: `fsck`'s job is to verify the graph,
  not to trust a cached claim about it. Structural, permanent, and mechanically guarded by ADR-605's
  parse-free bitmap pass.
- **Fetch/push negotiation via bitmaps.** Reason: negotiation is a wire protocol; tsgit negotiates by
  ref advertisement and a bitmap answers a different question.
- **The bitmap's trailing extensions — hash cache, lookup table, pseudo-merges** (Pin AH). Reason,
  one each: the hash cache exists to steer **delta selection**, which is excluded permanently above;
  the lookup table is a lazy-load index over entries this design already parses in full; pseudo-merges
  are an alternative encoding of the same reachability whose absence never changes an answer. All
  three are **trailing** (Pin AH), so ignoring them costs nothing and risks nothing.
- **The midx `{'B','T','M','P'}` chunk.** Reason: it exists for verbatim pack reuse in
  `pack-objects`, which is a copy optimisation in the excluded delta family; a bit resolves to an oid
  with the reverse-index chunk alone (Pin AG rule 4).
- **`core.multiPackIndex` as a config surface** (ADR-612). Reason: declined for the second time from
  ADR-592's premise — it would add a config key, a precedence question and a surface with no other
  use, to close a divergence that exists only where a user has explicitly disabled the feature. The
  residual is measured at Pin AG5/AG6 and is "which file is opened", never an answer.
- **A `verify-pack` command surface.** Reason: git's `verify-pack` is stricter than git's own `fsck`
  (R10b, R16), so modelling it means modelling a second, disagreeing verdict for the same file.
  tsgit models the `fsck` verdicts; §D19.1 names the residual.
- **`git multi-pack-index verify`'s bitmap arm.** Reason: there isn't one (Pin K rule 4).
- **SHA-256 pack support.** Reason: pre-existing. Every new parser is hash-generic (§D16), but
  `IDX_SHA_LENGTH = 20` keeps the surrounding subsystem SHA-1-only (B-10). SHA-256 rows are parser
  and pass units.
- **Stderr transcript parity.** Reason: ADR-249 — git's `error:` lines are presentation; tsgit emits
  none and the interop tests reconstruct them.
- **git's `BUG:`-and-abort on a bitmap without the full-DAG option** (B19). Reason: a library has no
  process to abort; tsgit declines the artefact and falls back, which is the only available
  behaviour. The answer then becomes the walk tier's — identical with no haves, git's superset with
  haves (Pin AJ4) — which is what git itself returns whenever it cannot load a bitmap.
- **Any tier control finer than the per-command one** — forcing a specific artefact (midx bitmap
  versus pack bitmap), or surfacing which tier answered. Reason: ADR-618 ships exactly what git
  ships, one boolean per command, because that boolean selects between two *answers*; artefact
  choice selects between two computations of the **same** answer (§D13), so exposing it would be
  strategy, which ADR-249's spirit and ADR-616's surviving half both refuse.
