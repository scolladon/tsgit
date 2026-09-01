# Design — delta-writing packer

> Brief: teach the pack writer to emit `OFS_DELTA` entries — a delta encoder, a window/depth
> selection policy, and a `pack.window`/`pack.depth` config surface — and use it from
> `maintenance`'s gc/consolidation path, retiring ADR-732's accepted size-inflation trade.
> Status: draft → self-reviewed ×3 → **accepted** (decisions ratified, ADRs 767–778)

## Context

### The write side today: every entry is a base entry

`src/domain/storage/pack-writer.ts` (167 lines) exposes
`serializePackfile(entries: ReadonlyArray<PackWriterEntry>): PackfileResult`, where

```ts
export interface PackWriterEntry {
  readonly type: BasePackEntryType;      // 1 | 2 | 3 | 4 — structurally excludes 6/7
  readonly uncompressedSize: number;
  readonly compressedData: Uint8Array;
}
```

`BasePackEntryType` (`pack-entry.ts:16-20`) is the union of `COMMIT | TREE | BLOB | TAG`. It
*structurally excludes* `OFS_DELTA` (6) and `REF_DELTA` (7), so the writer cannot express a
delta today — the gap is a type, not a missing branch.

`src/application/primitives/build-pack.ts` (86 lines) is the only assembler:
`buildPack(ctx, { oids })` reads each oid with `readObject`, re-serialises it with
`serializeObject`, strips the `<type> <size>\0` header, `ctx.compressor.deflate`s the
remainder, and pushes one base `PackWriterEntry` — **in the caller's `oids` order**. It
returns `{ bytes, sha, objectCount, entries }` where `entries: ReadonlyArray<PackEntryMeta>`
is per-entry `{ crc32, offset }` *in `input.oids` order*, which every caller zips positionally
against its own oid list to build the matching `.idx`.

Its module docblock promises the pack is "self-contained: no REF_DELTA references, no
OFS_DELTA back pointers, no thin-pack assumptions". That promise is load-bearing for the push
path (see §10) and must be re-examined per caller, not deleted wholesale.

### The read side already exists and is the round-trip oracle

`src/domain/storage/delta.ts` is **decode-only**: `applyDelta`, `parseDelta`,
`readDeltaTargetSize`, plus the private `readVariableLengthInt` / `decodeCopyFields` /
`validateCopyBounds` / `validateDeltaHeader`. **There is no encoder anywhere in `src/`.** The
instruction grammar this design must emit is exactly the one that file already parses, which
makes `applyDelta(base, encodeDelta(base, target)) === target` a natural round-trip property.

A hand-rolled instruction serialiser already exists on the **test** side —
`buildDelta` / `encodeDeltaVarInt` / `encodeCopyInstruction` / `encodeInsertInstruction` in
`test/unit/domain/storage/arbitraries.ts:118-…`. It is a duplicate of what this design puts in
`src/`, and the fixture must be re-pointed at the production serialiser (`check:duplicates`
watches this).

`src/application/primitives/object-resolver.ts` carries the reader's OFS arithmetic:
`ofsDeltaBaseOffset(targetId, entryOffset, baseDistance) → entryOffset - baseDistance`,
refusing a negative result with `OBJECT_NOT_FOUND`. `encodeOfsDistance` — the exact inverse of
the reader's `decodeOfsDistance` — **already exists and is exported**
(`pack-entry.ts:206-219`); the reftable writer reuses it for its own varints, and
`pack-entry.properties.test.ts` already round-trips it. Nothing new is needed for the back
pointer's encoding, only for choosing the distance.

### The sharpest constraint: three gc call sites use the pack sha as an identity key

`buildPack` has five callers. Three are in `src/application/commands/internal/gc-pipeline.ts`
and all three treat the resulting sha as a *content identity*:

| Site | Line | What the sha decides |
|---|---|---|
| `buildAndWriteNormalPack` | `:484` | `reuse = existingCruftShas.has(pack.sha) ? 'cruft' : existingNormalNames.has('pack-'+pack.sha) ? 'normal' : 'none'` — declassifies a resurrected cruft pack, and marks Pin W's no-op boundary |
| `buildAndWritePromisorPack` | `:527` | `reusedExistingName` — keeps the just-rebuilt promisor pack out of the retirement list |
| `buildAndWriteCruftPack` | `:560` | short-circuits the whole write when `existingCruftShas.has(pack.sha)` |

Their docblocks state the invariant plainly: *"`buildPack` is deterministic — same oid set,
same bytes"*, and *"a repeat run over an unchanged set reproduces the same sha"*. Both
`partitionOwned` (`:404-412`) and the promisor union (`:850-853`) sort their oid arrays for
exactly this reason, with a written note that an unsorted array would change the pack sha on
the next run "for no reason a caller could observe as a real content change".

**Therefore delta selection must be deterministic**: same object set + same options ⇒
byte-identical pack. Anything that draws on `Map`/`Set` iteration order over a
non-deterministically-populated container, on wall-clock, on concurrency completion order, or
on a size-varying window heap, is a correctness defect here — it silently breaks the
crash-recovery and no-op boundaries those pins encode.

Determinism is required *per adapter*, not across adapters: `ctx.compressor.deflate` already
produces different bytes on Node vs the Web `CompressionStream` adapters, and the pack surface
is declared `equivalent-under-readback` for precisely that reason
(`pack-writer.ts:1-12`, `packfile-interop.test.ts:1-14`, `pack-objects.ts:47-53`). This design
does not widen that gap; it inherits it.

### Governing decision records

| ADR / design | What it binds here |
|---|---|
| **ADR-732** gc consolidates existing packs | Names *this* work as the follow-up that retires the inflation trade. Pins pack-internal byte layout as a **non-surface**; placement, naming, sibling lifecycle, refusals and expiry are the pinned surfaces |
| **ADR-731** cruft packs | The cruft `.mtimes` sidecar lifecycle the cruft pack's sha short-circuit sits inside |
| **ADR-733** promisor repack | A second `buildPack` + `.promisor` marker; same sha-identity treatment |
| **ADR-720** lazy rev-first successor lookup | The reader path a delta-bearing pack now exercises on every gc-written pack |
| **ADR-728** clone pack quarantine | `writePackArtifactsViaQuarantine`, unchanged by this design |
| **ADR-736** delta base cache is additive | The read-side cache a delta-bearing pack now actually populates on gc-written packs |
| **ADR-471** deep delta chain fixture | `MAX_DELTA_CHAIN_DEPTH = 50` is set to git's default `pack.depth`; the fixture is pinned at max chain 43 |
| **ADR-353** first int config key | The int-config pattern: `parseGitInt`, `CONFIG_BAD_NUMERIC_VALUE`, `findFirstInvalid*` cold-path finders. Explicitly leaves `pack.compression` untouched |
| `design/int-config-valueless-refusal.md` (≈L332, L508) | Records that `build-pack.ts` stays on the no-level `deflate` because git's pack path uses `pack.compression`, a *different* key — out of scope there, in scope for a decision here |
| **ADR-249** structured data only | No rendered text, no display-steering options on any surface this adds |
| **ADR-226** git-faithfulness | Pin against the real binary; byte-identity with git's *packer* is explicitly excluded (see Requirements) |

### The two reader caps disagree with each other by one

`MAX_DELTA_CHAIN_DEPTH = 50` (`delta.ts:7`) is enforced by two different readers with two
different arithmetics:

| Reader | Site | Loop | Longest chain it accepts |
|---|---|---|---|
| `collectDeltaChain` (resolution) | `object-resolver.ts:344-407` | `for(;;)`, `depth += 1` then `assertChainDepthWithinCap(depth)` → throws when `depth > 50` | **50 delta hops** |
| `walkDeltaChain` (fsck stored-type) | `fsck/object-cache.ts:216-245` | `for (let depth = 0; depth < MAX_DELTA_CHAIN_DEPTH; depth += 1)`, one hop *or* the base per iteration | **49 delta hops** — a 50-hop chain exits the loop and reports `'delta chain exceeds max depth'` as an fsck fault |

This is latent today because tsgit never *writes* a delta. A writer honouring
`pack.depth = 50` would activate it: the object is readable, but `fsck` reports it untyped.
The design must not emit a chain that its own fsck refuses (§9).

---

## Ratified decisions — authoritative

Every decision candidate below was put to the user and settled. **This section overrides any
contrary recommendation later in this document**, including the Decision-candidates table,
which is kept only as the record of what was weighed. Where a ratified outcome differs from
the recommendation, the affected section is annotated inline.

| # | Ratified outcome | ADR | Diverges from the recommendation? |
|---|---|---|---|
| DC-1 | Delta emission is a per-call option, default off. gc (×3), `pack-objects` and `bundle-create` opt in; `push` stays base-only. | 767 | **Yes** — recommendation was gc only |
| DC-2 | Split: pure domain codec + comparator; primitive-internal `deltify.ts` owns the lazy window. | 768 | No |
| DC-3 | `buildPack` returns `{ id, crc32, offset }` triples **in emission order**; the positional-alignment contract is deleted and all five call sites key on `id`. | 769 | **Yes** — recommendation was permute-back |
| DC-4 | Two `Int32Array`s (`heads` + `next`) over fixed 16-byte blocks. No hash-keyed container anywhere in the selection path. | 770 | No |
| DC-5 | Fix the defect: `walkDeltaChain` becomes `depth <= MAX_DELTA_CHAIN_DEPTH`; the writer clamps to the configured `pack.depth` (50) with no adjustment. | 771 | **Yes** — recommendation was clamp-to-49 |
| DC-6 | `pack.windowMemory` bounds total window residency. **No** `MAX_DELTIFY_BYTES` constant. | 772 | **Yes** — recommendation was the constant |
| DC-7 | Surface is `pack.window` + `pack.depth` + `pack.windowMemory`. `pack.compression` stays out. | 773 | **Yes** — recommendation was window+depth only |
| DC-8 | `OFS_DELTA` only; `REF_DELTA` never emitted. Follows from DC-1 excluding `push`. | 774 | No |
| DC-9 | Two equality tests. No lint guard, no golden fixture. | 775 | No |
| DC-10 | `PackWriterEntry` **becomes** the discriminated union — breaking, folded into the already-pending major. | 776 | **Yes** — recommendation was additive |
| DC-11 | Exact acceptance: deflate both, emit the delta only when strictly smaller including header overhead. Ties go to the base. | 777 | No |
| DC-12 | New `readObjectMetadata` primitive. | 778 | No |

### Corrections to this document

1. **DC-6/DC-7's determinism objection to `pack.windowMemory` is false, and is retracted.**
   The table below claims a window bounded by memory "would make the pack sha depend on the
   host". It would not. `git-pack-objects(1)` documents `--window-memory=<n>` as scaling the
   window down against **a configured byte budget**, not against host pressure. Measured on
   git 2.55.0, one fixture, `pack.threads=1`, two independent runs per setting:

   | `pack.windowMemory` | run 1 | run 2 |
   |---|---|---|
   | `0` (unlimited) | 20 087 B | 20 087 B |
   | `8k` | 82 902 B | 82 902 B |
   | `64k` | 89 458 B | 89 458 B |

   Byte-identical every time; the key is deterministic for a fixed object set and
   configuration. It has a large effect on output — starving the window costs roughly ×4 here
   — which makes it worth exposing, not dangerous.

2. **§5's ordering section** is superseded by DC-3: metas are identified triples in emission
   order, not permuted back. R11's positional-alignment requirement is withdrawn.

3. **§7's residency formula** drops `MAX_DELTIFY_BYTES` (DC-6) and is bounded by
   `pack.windowMemory` instead: candidates evict oldest-first until the budget is met, and a
   candidate larger than the whole budget is skipped rather than admitted alone.

4. **§8's config surface** gains `pack.windowMemory` (DC-7) on the same first-malformed-line-
   is-fatal finder as the other two.

5. **§9's writer clamp** is 50, not 49, and `walkDeltaChain` is fixed in this change (DC-5).
   The widened fsck acceptance is pinned by interop, not asserted.

6. **§10's caller list** gains `pack-objects` and `bundle-create` (DC-1).

7. **§3's writer surface** re-shapes `PackWriterEntry` itself rather than adding a sibling
   (DC-10); the change is breaking and lands before the pending 4.0.0 release, so it costs no
   additional major bump.

---

## Requirements

Everything below is verifiable by a test named in §Test strategy.

**Encoder correctness**

- **R1** `serializeDelta` is the exact inverse of `parseDelta`: for every instruction list
  the domain can construct, `parseDelta(serializeDelta(…))` returns an equal list, and the
  emitted bytes contain no reserved `INSERT` opcode (`cmd === 0`) and no zero-length copy.
- **R2** `encodeDelta(base, target)` is **total** over the declared safe domain
  (`base.length ≤ 2^32-1`, `target.length ≤ MAX_TARGET_LENGTH`) — it never throws — and
  `applyDelta(base, encodeDelta(base, target))` byte-equals `target` for every such pair.
- **R3** A delta is emitted **only** when it is strictly smaller on disk than the base entry
  it replaces: `deflate(delta).length + MAX_OFS_OVERHEAD_BYTES < deflate(content).length` (§4c). A pack
  written by this design is therefore never larger than the same pack written today, entry for
  entry.

**Pack validity**

- **R4** In every emitted pack, a delta entry's base entry appears at a **strictly lower byte
  offset**; `baseDistance` is that positive backward distance, and `serializePackfile` computes
  it from the layout it is emitting rather than trusting a caller-supplied number.
- **R5** A delta entry's pack-entry header `size` field is the **inflated delta instruction
  stream's** length — not the target object's size (this is what `git verify-pack` checks).
- **R6** Real `git` accepts the result: `git index-pack --strict`, `git verify-pack -v` and
  `git fsck --strict` all exit 0 over a tsgit-written delta-bearing pack (§1g O1/O4/O6), and
  every object is recoverable through the full
  `git cat-file --batch-all-objects --batch-check='%(objectname)' | git cat-file --batch` pipe
  (§1g O7) — **not** through `--batch-check` alone, which §1g proves exits 0 even on a pack
  with corrupt delta payloads.
- **R7** tsgit's own readers resolve every emitted chain: the longest chain the writer emits is
  ≤ the **minimum** of the two reader caps (§9), and `tsgit fsck` reports no
  `delta chain exceeds max depth` finding on any pack this writer produced.
- **R8** No `REF_DELTA` is emitted by any path in this change (§10) — every delta is
  `OFS_DELTA`, so every pack stays self-contained and `thin-pack` stays un-advertised.

**Determinism**

- **R9** Same oid set + same config + same adapter ⇒ **byte-identical** pack bytes and
  therefore an identical sha, across repeated runs and across process restarts. Proved by
  running the full gc pipeline twice and byte-comparing, and by a direct `buildPack` ×2
  comparison over a shuffled input whose sorted order is the same.
- **R10** The three gc sha-identity pins (V/W/Y) still hold: a repeat gc over an unchanged
  object set reproduces the same normal/promisor/cruft pack sha and takes the same no-op
  branch.

**Contracts preserved**

- **R11** `buildPack`'s `entries` array stays **in `input.oids` order**. All five call sites
  (`gc-pipeline.ts:484,527,560`, `pack-objects.ts:82`, `bundle-create.ts:310`, `push.ts:353`)
  compile and behave unchanged without edits to their zip logic.
- **R12** `pack-writer.ts`'s `@writes` block stays accurate and the write-surfaces audit
  (`npm run check:write-surfaces`) stays green — `kind: equivalent-under-readback` remains
  correct and is *more* true after this change, not less.
- **R13** The public API delta is **additive**: no existing exported symbol changes shape in a
  way that breaks a consumer already passing base-only entries. `reports/api.json` is
  regenerated and committed.

**Config**

- **R14** `pack.window` and `pack.depth` are read from the local config through `readConfig`
  and honoured by the selection policy, defaulting to git's documented **10** and **50**
  (§1b). Either key set to **`0` or `-1`** disables delta emission entirely, exactly as git
  does (§1c), and the resulting pack is byte-identical to the pre-change writer's output.
- **R15** A malformed `pack.window` / `pack.depth` is refused **exactly as git refuses it**
  (§1c: `invalid unit` / `out of range`, C-`int` bounds, any malformed line fatal regardless of
  position) using the established `CONFIG_BAD_NUMERIC_VALUE` shape — never silently read back
  as absent-and-defaulted.

**Size and memory**

- **R16** On the three pinned fixtures (§1d), tsgit's gc-written pack lands within the
  recorded size class of git's own `repack -a -d` output, measured against a `pack.threads=1`
  git so the peer is reproducible at all. The assertion is a **class with headroom**, never a
  byte count: §1e measures git's own default-threaded output varying by 3.8 % on identical
  input.
- **R17** The deltify pass's steady-state residency is **O(window)** uncompressed object
  contents plus their indexes — not O(total inflated size). The bound is stated as a formula in
  §7 and asserted by a bench-side memory scenario.
- **R18** ADR-732's inflation note is retired: the ratio table in
  `docs/design/perf-remediation-2026-08.md` §"The size trade, measured", the
  `docs/use/commands/maintenance.md` §"The size trade" prose, and the ADR-732 consequence line
  are all replaced by re-measured numbers from this change.

---

## Design

### 1. The pinned matrix

Everything in this section was measured against the real binary, never recalled. Byte-identity
with git's packer is **not** the contract (backlog 30.4); the pins below are what *is* binding:
the config grammar, the refusal shapes, the acceptance oracles, and the size class.

#### 1a. Environment

| | |
|---|---|
| git | **2.55.0**, `/opt/homebrew/bin/git`, darwin arm64, 11 CPUs |
| Isolation | every state-mutating probe in a `mktemp -d` throwaway: isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, isolated `XDG_CONFIG_HOME`, all `GIT_*` scrubbed, `LC_ALL=C`, signing off. Confirmed afterwards that no tsgit checkout's `.git/config` was touched |
| Node | v22.22.3 |

#### 1b. Config defaults — none of them are on disk

```
$ git init -q . && for k in pack.window pack.depth pack.windowMemory pack.compression \
      pack.deltaCacheSize pack.deltaCacheLimit pack.threads repack.useDeltaBaseOffset; do
    git config --get "$k"; echo "$k exit=$?"; done
pack.window exit=1      pack.depth exit=1      pack.windowMemory exit=1
pack.compression exit=1 pack.deltaCacheSize exit=1  pack.deltaCacheLimit exit=1
pack.threads exit=1     repack.useDeltaBaseOffset exit=1
```

**Every one of these keys is unset by default.** The defaults live only in git's C source; a
reimplementation must hardcode them and cannot read them back. `git repack -h` and
`git pack-objects -h` document **no** defaults — the installed `man 1 git-config` is the only
source, and it says, verbatim:

| key | documented default | man-page wording |
|---|---|---|
| `pack.window` | **10** | *"The size of the window used by git-pack-objects(1) when no window size is given on the command line. Defaults to 10."* |
| `pack.depth` | **50**, **maximum 4095** | *"The maximum delta depth used by git-pack-objects(1) when no maximum depth is given on the command line. Defaults to 50. Maximum value is 4095."* |
| `pack.windowMemory` | **unlimited** (unset or `0`) | *"…there will be no limit."* Accepts a `k`/`m`/`g` suffix |
| `pack.compression` | **-1** (zlib default ≈ level 6), falling back to `core.compression` | *"An integer -1..9 … If not set, defaults to core.compression. If that is not set, defaults to -1"* |
| `repack.useDeltaBaseOffset` | **true** | *"By default, git-repack(1) creates packs that use delta-base offset."* |

`man 1 git-pack-objects` restates the first two: *"The default value for --window is 10 and
--depth is 50. The maximum depth is 4095."*

**This design adopts `pack.window = 10` and `pack.depth = 50` as its defaults** (R14), and
`OFS_DELTA` as its encoding (matching `repack`'s effective default, §1f).

#### 1c. Malformed-value refusals — the shape tsgit must reproduce

Method: fresh repo, the line appended directly to `.git/config`, then
`git repack -a -d 2>&1; echo exit=$?`.

| Value for `pack.depth` (identical for `pack.window`) | git's exact output | exit |
|---|---|---|
| valueless (`[pack]\n\tdepth\n`) | `fatal: bad numeric config value '' for 'pack.depth' in file .git/config: invalid unit` | **128** |
| `abc` | `fatal: bad numeric config value 'abc' for 'pack.depth' in file .git/config: invalid unit` | **128** |
| `5.0` | `…: invalid unit` | **128** |
| `2147483648`, `4294967296`, `9223372036854775807`, `99999999999999999999` | `fatal: bad numeric config value '<v>' for 'pack.depth' in file .git/config: out of range` | **128** |
| `2147483647` | accepted (then clamped, next row) | 0 |
| `4096`, `100000`, `1m`, `2147483647` | `warning: delta chain depth <n> is too deep, forcing 4095` | **0** |
| `4095` | silent | 0 |
| **`0`** and **`-1`** | silent | 0 |
| `1k`, `0x20`, `050`, `+50`, `" 50 "`, `"50 "` | silent — accepted as 1024 / 32 / 40 / 50 / 50 / 50 | 0 |

Four things this settles:

1. **The message is `parseGitInt`'s own grammar, verbatim.** `invalid unit` for anything the
   number parser rejects (including the empty string of a valueless key), `out of range` for a
   value that parses but overflows. tsgit's `configBadNumericValue(key, source, value, reason)`
   already produces exactly this pair, and `parseGitInt(null)` already returns
   `invalid unit` (`config-ini.ts:750-760`). **No new error code, no new reason string.**
2. **The bound is the C `int`, not int64.** `2147483647` is accepted and `2147483648` is
   `out of range` — precisely the `GIT_C_INT_MIN`/`GIT_C_INT_MAX` narrowing
   `findFirstInvalidGcAuto` and `findLastInvalidMaxTreeDepth` already layer on top of
   `parseGitInt`'s int64 bounds. Units (`k`/`m`/`g`), hex, octal and signs are all accepted,
   which `parseGitInt` already implements.
3. **Any malformed line dies, wherever it sits.** Pinned directly:

   ```
   [pack]              → fatal: bad numeric config value 'abc' for 'pack.depth' …  exit=128
     depth = abc
     depth = 50

   [pack]              → fatal: bad numeric config value 'abc' for 'pack.depth' …  exit=128
     depth = 50
     depth = abc
   ```

   Both orders die. `pack.window` behaves identically. These keys are therefore in the
   **`core.compression` family (first/any malformed line is fatal)**, not the
   `core.maxTreeDepth` last-write-wins family — so the finder is `findFirstInvalidPackInt`,
   scanning in file order and returning the first failure (§8). *(For contrast,
   `git config --get pack.depth` returns `50` in the first case and `abc` in the second, with
   exit 0 both times — `--get` is last-write-wins and is **not** the semantics `repack` uses.)*
4. **`0` and `-1` are legal and mean "no deltas".** Not an error, not "unlimited". Measured on
   the F1 object set below:

   | invocation | pack bytes | delta entries |
   |---|---|---|
   | defaults | 82 277 | 193 `ofs-delta` |
   | `--window=0` *or* `--depth=0` *or* both | 653 400 | **none** |
   | `pack.window=0`, `pack.window=-1`, `pack.depth=0`, `pack.depth=-1` (config, each alone) | 653 400 | **none** |
   | `pack.window=1` | 169 626 | 186, max chain 1 |

   Either key at `0` or `-1`, on its own, disables delta compression entirely. This is the
   disable switch X10 tests against, and it is what makes "turn the feature off" a *faithful*
   configuration rather than a tsgit-only escape hatch.

`pack.compression` is pinned too, because DC-7 offers it: `10` and `-2` give
`fatal: bad pack compression level <n>` (exit 128) — a **different** message from the generic
numeric one, so adopting that key would need its own error arm, not a reuse.

#### 1d. Size class — the number this change is judged against

Three fixtures were generated deterministically (same generator ⇒ same HEAD sha across
independent runs, verified). Each is repacked twice: once normally, once with
`--window=0 --depth=0`, which §1c proves is git's own delta-free mode — the exact shape
tsgit's writer produces today.

| Fixture | shape | objects | delta-free `.pack` | deltified `.pack` | **git's delta win** | max chain |
|---|---|---|---|---|---|---|
| **F1** text-churn | one ~500-line file, 200 commits, 5 lines edited + 1 appended each | 603 | **653 400 B** | **71 817 B** | **×9.10** | **50** — saturates the `pack.depth` default |
| **F2** many-small-files | 300 unique high-entropy 12-line files over 50 commits | 403 | **234 294 B** | **55 112 B** | **×4.25** | 2 |
| **F3** wide-tree-churn | 150 files in 10 nested dirs, 80 commits touching 3–5 files | 1 096 | **246 551 B** | **127 996 B** | **×1.93** | 11 |

*(All with `pack.threads=1` — see §1e. Object-type histograms: F1 201 commit / 201 tree /
3 blob / 198 `ofs-delta`; F2 51 / 2 / 301 / 49; F3 81 / 263 / 2 / 750. Zero `ref-delta` in any
of them.)*

**The size class this design must land in is therefore `×1.9 … ×9.1` of savings**, shape
dependent. Two readings matter:

- **F2 is the instructive one.** Only 49 of its 403 objects are deltas, and it still gets ×4.25
  — because its 51 near-identical *trees* delta almost perfectly even though its blobs are
  incompressible noise. A packer that deltifies only blobs would miss most of that win. Trees
  and commits are where the easy bytes are, and they are the objects gc consolidation has the
  most of.
- **F1's max chain is exactly 50.** git really does run its default `pack.depth` to the cap on
  delta-friendly content. §9's writer clamp is not theoretical — it will bind on this shape.

#### 1e. git's own packer is not deterministic, and that matters twice

The same on-disk repo, copied three times and repacked:

```
repack -a -d, threads = auto (11 CPUs)      repack -a -d, pack.threads=1
F1 copy1 82068   copy2 85078   copy3 81946  F1 copy1..3  71817  (identical)
F3 copy1..3 128150 (stable here)            F3 copy1..3 127997  (identical)
```

Default-threaded F1 spread **81 946 … 85 078** — 3.8 % on identical input, because the threaded
search partitions the object list and shrinks each thread's effective window reach.
Single-threaded is reproducible for a fixed on-disk repo, and is also **12.5 % smaller**
(71 817 vs ~82 000).

Two consequences, both binding:

- **R16's assertion must be a class with tolerance, never an equality.** Any test that compares
  tsgit's pack size to git's must pin `-c pack.threads=1` on the git side and still allow
  headroom; a byte-for-byte comparison would be asserting against a number git itself will not
  reproduce.
- **tsgit's determinism (R9) is a divergence *in tsgit's favour*, and should be stated as
  one.** git's packer trades reproducibility for parallelism; tsgit's gc cannot, because three
  call sites use the pack sha as an identity key. This is the clearest evidence that
  byte-identity with git's packer was rightly excluded from the contract.

Also pinned, and relevant to the retirement measurement: **`git repack -a -d` reuses existing
deltas** (`--reuse-delta` is on by default). It does not re-search unless the repository is
loose-only at repack time or `-f` is passed. Every number above was taken with that controlled.

#### 1f. OFS vs REF in the wild — `repack` and `pack-objects` disagree

| invocation, same F1 object set | pack bytes | delta type |
|---|---|---|
| `git repack -a -d -f` (default, `repack.useDeltaBaseOffset` unset) | 85 309 | 192 `ofs-delta` |
| `git -c repack.useDeltaBaseOffset=true repack -a -d -f` | 82 317 | 193 `ofs-delta` |
| `git -c repack.useDeltaBaseOffset=false repack -a -d -f` | 85 704 | 193 **`ref-delta`** |
| `git pack-objects` (no flags) | 85 576 | 193 **`ref-delta`** |
| `git pack-objects --delta-base-offset` | 82 097 | 193 `ofs-delta` |
| `git pack-objects --no-delta-base-offset` | 85 576 | 193 `ref-delta` |

Two findings:

- **`repack` emits `OFS_DELTA` by default; bare `pack-objects` emits `REF_DELTA`.** `repack` is
  what passes `--delta-base-offset`. Since this design's scope is gc/consolidation — the
  `repack` path — **`OFS_DELTA` is the faithful choice** (R8), and it is also the cheaper one:
  85 576 − 82 097 = 3 479 B over 193 deltas ≈ **18 B/delta** saved (a 20-byte oid versus a
  ~2-byte backward varint).
- `pack-objects --delta-base-offset` reproduced `repack`'s 82 097 exactly, confirming that flag
  is repack's only relevant addition.

**Thin packs use `REF_DELTA` for everything.** `git pack-objects --thin --revs --stdout` over a
5-commit range produced 1 890 B (versus 5 568 B non-thin), all 5 deltas `ref-delta`, zero
`ofs-delta`; `git index-pack --fix-thin` appended the one missing external base and left the
deltas as `REF_DELTA`. That is the shape DC-8 (b) would have to build, and it is why R8 keeps
it out.

#### 1g. The acceptance oracles — exact commands, exact expected shapes

Subject: F1's deltified pack (82 097 B).

| # | Command | Success | Failure (one byte flipped inside an `ofs-delta` payload) |
|---|---|---|---|
| O1 | `git index-pack --strict -v <pack>` (a pack **file**, works outside any repo) | stdout is the pack's own sha **bare**; stderr `Indexing objects: 100% (603/603), done.` + `Resolving deltas: 100% (193/193), done.`; **exit 0**. Writes `<stem>.idx` *and* `<stem>.rev` | `error: inflate: data stream error (incorrect data check)` then `fatal: pack has bad object at offset 81024: inflate returned -3`; **exit 128** (identical without `--strict`) |
| O2 | `git index-pack --strict -v --stdin < <pack>` (inside a repo) | stdout `pack\t<sha>` — **a different shape from O1**; stderr says `Receiving` rather than `Indexing`; exit 0 | same two error lines, exit 128 |
| O3 | `git verify-pack <idx>` | **no output at all**, exit 0 | — |
| O4 | `git verify-pack -v <idx>` | per-object lines + `chain length = N: M objects` histogram + `<pack>: ok`; exit 0 | stdout tail `<pack>: bad`, same two error lines on stderr; **exit 1 — not 128** |
| O5 | `git index-pack --verify <pack>` | no output, exit 0 | the two error lines, exit 128 |
| O6 | `git fsck --strict --no-progress` | **zero output on both streams**, exit 0 (with refs pointing at the pack) | **exit 6**, with `error: <pack> pack checksum mismatch`, `error: index CRC mismatch for object <oid> … at offset 81024`, `error: failed to unpack compressed delta at offset 81028`, `error: failed to read delta base object …`, plus `broken link from tree <oid> to blob <oid>` and `missing blob <oid>` on stdout |
| O7 | `git cat-file --batch-all-objects --batch-check='%(objectname)' \| git cat-file --batch > /dev/null` | exit 0 | exit 128 |

**Three different exit codes for the same corruption — `index-pack` 128, `verify-pack` 1,
`fsck` 6.** A test that asserts "non-zero" would pass on the wrong failure; each oracle's code
is pinned individually.

🔴 **`git cat-file --batch-check` is not a content oracle.** On the corrupted pack it still
exits **0** and prints all 603 lines, because it reads type and size from headers without
inflating delta payloads. R6's readback assertion must be the full O7 pipe, not
`--batch-check` alone.

🔴 **`git verify-pack -v` cannot tell `OFS_DELTA` from `REF_DELTA`.** It prints the *resolved*
type. A base entry is a 5-field line
(`<oid> <type> <size> <size-in-pack> <offset>`); a delta is a 7-field line
(`… <chain-depth> <base-oid>`) — OFS versus REF is invisible in both. The working oracle, and
the one the interop test must use, is **`git show-index < <idx>`** for every object's pack
offset, cross-read against the type nibble `(packBytes[offset] >> 4) & 7` in the `.pack`.
(`fsck-pack-accessibility-interop.test.ts:1024-1034` already parses the 7-field shape and can
be extended rather than duplicated.)

#### 1h. Refusals for a malformed OFS back pointer

Crafted against a real pack, **with the 20-byte pack trailer recomputed after each header edit**
— without that, every attempt is masked by `fatal: pack is corrupted (SHA1 mismatch)`, since
the trailer is verified before delta resolution.

| Crafted condition | `git index-pack --strict` |
|---|---|
| distance **> the delta's own offset** (base before the pack start) | `fatal: pack has bad object at offset 10414: delta base offset is out of bound`, exit 128 |
| distance **0** (base == self) | `fatal: pack has bad object at offset 13622: delta base offset is out of bound`, exit 128 |
| distance in range but landing **mid-object** (not an entry boundary) | indexing completes, then `fatal: pack has 3 unresolved deltas`, exit 128 |
| a **thin** pack whose bases are absent, indexed without `--fix-thin` | `fatal: pack has 5 unresolved deltas`, exit 128 — the **same message** as the misaligned case |

A **forward** base offset is structurally unrepresentable: `gitformat-pack(5)` defines the field
as *"a negative relative offset from the delta object's position"* and the varint is unsigned.
tsgit's own reader agrees — `ofsDeltaBaseOffset` refuses `entryOffset - baseDistance < 0` — and
R4 makes the writer's distance positive by construction.

#### 1i. The delta instruction grammar, from `gitformat-pack(5)`

`man 5 gitformat-pack` is installed and is the authority. The load-bearing paragraphs, verbatim:

> **Size encoding** — *"From each byte, the seven least significant bits are used to form the
> resulting integer. As long as the most significant bit is 1, this process continues; the byte
> with MSB 0 provides the last seven bits. The seven-bit chunks are concatenated. Later values
> are more significant."*

> **Copy instruction** — `| 1xxxxxxx | offset1 | offset2 | offset3 | offset4 | size1 | size2 |
> size3 |`. *"Offset and size are in little-endian order. All offset and size bytes are
> optional… The first seven bits in the first octet determine which of the next seven octets is
> present. If bit zero is set, offset1 is present. If bit one is set offset2 is present and so
> on."* … *"In its most compact form, this instruction only takes up one byte (0x80) with both
> offset and size omitted, which will have default values zero. **There is another exception:
> size zero is automatically converted to 0x10000.**"*

> **Insert instruction** — `| 0xxxxxxx | data |`. *"The first seven bits of the first octet
> determine the size of data in bytes. **The size must be non-zero.**"*

> **Reserved instruction** — `| 00000000 |`. *"This is the instruction reserved for future
> expansion."*

> **OFS_DELTA header** — *"n-byte offset … interpreted as a negative offset from the type-byte
> of the header of the ofs-delta entry (the size above is the size of the delta data that
> follows)."* Offset encoding: *"n bytes with MSB set in all but the last one. The offset is
> then the number constructed by concatenating the lower 7 bit of each byte, and for n >= 2
> adding 2^7 + 2^14 + … + 2^(7*(n-1)) to the result."*

Every clause here is already implemented on tsgit's read side —
`readVariableLengthInt`, `decodeCopyFields` (including the `size === 0 → 0x10000` exception),
`applyInsert`'s `cmd === 0` refusal, and `decodeOfsDistance`'s `((distance + 1) << 7) | …`
accumulation. **§2's encoder is written as the inverse of those functions, and the man page is
what certifies that the functions themselves are right.** It also confirms R5 directly: for a
delta entry *"the size above is the size of the delta data that follows"*, not the target's
size.

The pack header is confirmed as `PACK` / version 2 / object count — every pack measured in this
session read `version=2`, and `GENERATED_PACK_VERSION = 2` already matches.

### 2. Layer 1 — the instruction codec (`src/domain/storage/delta-encode.ts`)

A new **domain** module, pure, zero outward deps, sibling of `delta.ts`. Split deliberately
into two layers so each gets its own property lens.

#### 2a. `serializeDelta(sourceLength, targetLength, instructions): Uint8Array`

The exact inverse of `parseDelta`. Three private encoders, each the mirror of a `delta.ts`
decoder:

| Encoder | Mirrors | Rule |
|---|---|---|
| `encodeDeltaVarInt(value)` | `readVariableLengthInt` | 7 bits per byte, **least-significant group first**, `0x80` continuation on every byte but the last. Emits at most `MAX_VARINT_BYTES` (5) bytes — `readVariableLengthInt` refuses a 6th |
| `encodeCopy(offset, size)` | `decodeCopyFields` | `cmd = 0x80`; for `i` in `0..3`, if `(offset >>> (8 * i)) & 0xff` is non-zero, set bit `1 << i` and push that byte; for `i` in `0..2`, if `(size >>> (8 * i)) & 0xff` is non-zero, set bit `0x10 << i` and push that byte |
| `encodeInsert(data)` | `applyInsert` / `parseDelta`'s insert arm | `cmd = data.length` (1…127), then the literal bytes |

Two encoding subtleties, both forced by the decoder that already exists:

- **The `size === 0` shorthand is never emitted.** `decodeCopyFields` maps an all-zero size
  field to `0x10000`. The encoder sidesteps the special case entirely by never emitting a
  zero-length copy: a copy of exactly `0x10000` encodes its third size byte as `0x01`
  (`cmd |= 0x40`), which the decoder reconstructs as `0x10000` through the ordinary path. The
  shorthand is therefore *readable but never written* — one fewer branch to keep faithful,
  and one fewer mutant surface.
- **`cmd === 0` is unreachable by construction.** A copy always has `cmd & 0x80` set; an
  insert always carries `1 ≤ length ≤ 127`. `MAX_INSERT_BYTES = 127` and
  `MAX_COPY_BYTES = 0xffffff` are named constants, and the differ (§2b) is what splits longer
  runs — `serializeDelta` refuses an out-of-range instruction with `INVALID_DELTA` rather than
  silently truncating, because a caller handing it a 200-byte insert has a bug.

Header: `encodeDeltaVarInt(sourceLength)` then `encodeDeltaVarInt(targetLength)`.
`validateDeltaHeader` on the read side requires `base.length === sourceLength` **exactly**, so
the source length is the real base length, never a rounded or cached value.

#### 2b. `encodeDelta(base, target, maxSize?): Uint8Array | undefined`

The differ. Returns `undefined` when the emitted stream would exceed `maxSize` — that is the
search's early abort (§4b), not an error.

**The index over the base.** `createDeltaIndex(base)` builds a fixed-block hash index:

- The base is cut into non-overlapping blocks of `DELTA_BLOCK_BYTES = 16` (the same granularity
  git's rolling window uses; the last partial block is dropped, since a match shorter than a
  block is not worth an index probe).
- Each block's 4-byte rolling-ish hash is a plain multiplicative hash over its 16 bytes,
  computed with `Math.imul` — deterministic, no floating point, no locale, no `Map` ordering.
- Storage is two `Int32Array`s in git's classic open-chain shape: `heads[bucket]` holds the
  index of the most recent block in that bucket, `next[blockIndex]` chains backwards. Bucket
  count is the power of two ≥ `blockCount`, capped at `MAX_INDEX_BUCKETS`. **No `Map`, no
  `Set`, no object allocation per block** — the residency is `2 × 4 bytes × blockCount ≈
  base.length / 2`, and iteration order is an array walk, which is the determinism guarantee
  §6 needs.
- A bucket is walked most-recent-first for at most `MAX_CANDIDATES_PER_BUCKET = 6` entries.
  The cap bounds the pathological all-identical-blocks input (a 10 MiB run of zeros) from
  O(n²); it is a named constant, and because the walk order is fixed the cap changes *which*
  match is found, deterministically, never *whether* the encode succeeds.

**The match loop.** Walk `target` from position 0:

1. If fewer than `DELTA_BLOCK_BYTES` remain, the rest is literal — emit inserts and stop.
2. Hash `target[pos .. pos+16)`, probe the bucket. For each candidate block offset in the
   base, extend the match **forward** while bytes agree (bounded by `MAX_COPY_BYTES` and by
   both buffers' ends) and **backward** while bytes agree *and* the backward extension does not
   cross into already-emitted output. Keep the longest; break ties on the **lower base offset**
   (deterministic, and biases towards shorter offset encodings).
3. If the best match length is `< MIN_COPY_BYTES` (= `DELTA_BLOCK_BYTES`), the byte at `pos` is
   pending literal; advance one byte and continue.
4. Otherwise flush pending literals as `INSERT` instructions of at most 127 bytes, emit the
   `COPY`, advance by the match length.

Backward extension is what turns a 16-byte anchor into a match that starts mid-block, and it
is the single cheapest quality win over a naive block-only matcher; it is also why the
"pending literal" buffer must be *shrinkable* rather than already-emitted.

**The abort.** The encoder tracks its emitted length as it goes and returns `undefined` the
moment it exceeds `maxSize`. This is what makes trying ten candidates affordable: a hopeless
candidate dies after a few hundred bytes instead of producing a full-size delta that is then
thrown away.

**Totality (R2).** Every input in the safe domain produces *some* output, because the fallback
at every position is "emit the byte as a literal" — a delta consisting purely of inserts is
always valid, always applies, and is exactly `target.length + ceil(target.length/127) +
headerBytes` long. It will lose the acceptance test in §4c and never reach the pack, but
`encodeDelta` itself never throws.

R2 and `serializeDelta`'s refusals (§2a) are not in tension: `encodeDelta` splits literal runs
at `MAX_INSERT_BYTES` and truncates matches at `MAX_COPY_BYTES` **before** handing anything to
the serialiser, so it can never construct an instruction the serialiser refuses. Those refusals
guard the *other* caller — a fixture, or a future encoder — exactly as a guard against a caller
bug always does.

**The safe domain**, stated once: `base.length ≤ 2^32 - 1` (the widest value the header varint
survives — `readVariableLengthInt` accumulates with `>>> 0` and refuses a 6th byte) and
`target.length ≤ MAX_TARGET_LENGTH` (2 GiB, `delta.ts:143`, enforced by `validateDeltaHeader`
on the read side). `MAX_DELTIFY_BYTES` (§4c) keeps the packer far inside both, so the encoder's
domain limits are a property test's concern rather than an operational one.

### 3. Layer 2 — the writer surface (`pack-writer.ts`)

`PackWriterEntry` is a **public export** (it is in `reports/api.json`). To keep the delta
addition additive (R13) the union is introduced as a new named member rather than by
re-shaping the existing interface:

```ts
export interface PackWriterEntry {           // unchanged
  readonly type: BasePackEntryType;
  readonly uncompressedSize: number;
  readonly compressedData: Uint8Array;
}

export interface PackWriterDeltaEntry {      // new
  readonly type: typeof PACK_ENTRY_TYPE.OFS_DELTA;
  /** Inflated length of the DELTA INSTRUCTION STREAM — not the target object (R5). */
  readonly uncompressedSize: number;
  readonly compressedData: Uint8Array;
  /** Index of this delta's base **in the same entries array**; must be < this entry's index. */
  readonly baseIndex: number;
}

export type PackWriterInput = PackWriterEntry | PackWriterDeltaEntry;

export function serializePackfile(
  entries: ReadonlyArray<PackWriterInput>,
): PackfileResult;
```

An existing `ReadonlyArray<PackWriterEntry>` is still assignable to
`ReadonlyArray<PackWriterInput>`, so no caller and no consumer breaks; a consumer that *reads*
`PackWriterEntry` sees an unchanged shape.

**Why `baseIndex` and not `baseDistance`.** The distance is a function of the byte layout the
writer is producing — the base's own offset, plus the widths of every entry header between
them, one of which is the delta's own header whose width depends on the distance being encoded.
Making the caller predict that would be an invitation to an off-by-one that only `git
verify-pack` catches. `serializePackfile` already tracks `currentOffset`; it records each
entry's emitted offset as it goes and computes
`baseDistance = currentOffset - offsets[baseIndex]` at the moment it writes the delta (R4).

There is no fixed-point problem: `baseDistance` is the distance from the delta's **own entry
start** to the base's entry start, and the delta's entry start is `currentOffset` *before* its
header is written. The distance is fully known before a single byte of the delta's header is
emitted.

**Refusals.** `serializePackfile` throws `invalidPackEntry(offset, reason)` — the existing
`INVALID_PACK_ENTRY` code, no new error variant — when `baseIndex` is not a valid backward
reference:

| Condition | `reason` |
|---|---|
| `baseIndex >= i` (forward or self reference) | `OFS_DELTA base index N is not before entry M` |
| `baseIndex < 0` or non-integer | `OFS_DELTA base index N out of range` |

`offset` is the delta entry's own byte offset, which is what the reader-side factory means by
it.

**CRC and the entry bytes.** The `.idx` crc32 covers the whole entry as stored — for a delta
that is `typeAndSizeHeader ++ ofsDistanceVarint ++ compressedData`. The existing
`crc32(entryBytes)` call already covers whatever `entryBytes` is, so the only change is that
`entryBytes` gains the distance varint between the header and the payload. `encodeOfsDistance`
supplies those bytes unchanged from `pack-entry.ts`.

**The `@writes` block** stays exactly as it is —
`surface: packfile / kind: equivalent-under-readback / format: git-packfile-v2` — and its prose
("delta selection are implementation-defined") becomes literally true of tsgit rather than
merely of the format. One word changes: the docblock's claim that the writer "emits the v2 pack
body (header + entries)" is widened to name delta entries.

### 4. Layer 3 — the selection policy (`src/application/primitives/internal/deltify.ts`)

The policy is **not** domain code, because it needs to read objects lazily to honour R17. It is
a primitive-internal module with a pure domain core.

#### 4a. What is available to sort by — and what is not

git's packer sorts by type, then a **name hash** derived from the object's path, then size
descending. **tsgit's gc path has no paths.** `enumerateObjects` returns bare oids
(`enumerate-objects.ts:24-39`, `[...ids].sort()`), `partitionOwned` and the promisor union
carry only oids, and neither the cruft set nor the promisor set is derived from a tree walk at
all. `ClosureObject.path` exists (`closure-engine.ts:67-75`) but is documented as *not*
populated by the bitmap tier, which is `pack-objects`' default.

So the ordering this design can compute from `{ oids }` alone is:

```
(typeRank, uncompressedSize DESC, oid ASC)
```

with `typeRank = COMMIT < TREE < BLOB < TAG` (any fixed total order works; this one matches the
pack entry type numbering). `oid ASC` is the deterministic tie-break, replacing git's recency
ordering, which tsgit has no access to on this path.

The consequence is honest and must be stated: **for a many-distinct-files corpus this will
find fewer deltas than git does**, because size-adjacency is a weaker clustering signal than
name-adjacency. For an evolving-file corpus — the shape that produces the ×6.91 worst case
this change exists to retire — size-adjacency is *equivalent*, because successive revisions of
one file have near-identical sizes and land next to each other. §1's size-class table is the
measurement that says how much is lost; a path-hint variant is DC-3.

> **Trap — the sort key must be a function of the object, never of how it is stored.**
> A tempting shortcut is to take the *stored* size as the sort proxy: it is free (the pack
> offset table already yields each entry's in-pack byte span, and a loose object's `lstat`
> size is one syscall away), and it correlates well with the real size. It is also **fatal
> here**. A stored size depends on whether the object is loose or packed, on which pack, and
> on whether it is itself a delta — all of which *this very command changes*. gc run 1 would
> sort by pre-gc stored sizes; gc run 2 would read the same objects back out of the pack run 1
> wrote, get different stored sizes, sort differently, and emit a different pack sha for an
> unchanged object set. That is Pin W's no-op boundary breaking silently, which is the exact
> failure mode §Context warns about. The sort key is `(typeRank, uncompressedSize, oid)` and
> every one of the three is a property of the object's *content*.
>
> How the true `(type, uncompressedSize)` is obtained without either a second full read pass
> or unbounded residency is **DC-12** — the one open question this section leaves.

#### 4b. The sliding window

```
searchBound = floor(E.size * DELTA_ACCEPT_RATIO)

for each entry E in sorted order:
    candidates = the last W entries in sorted order that:
                   - have the same object type as E            (git refuses cross-type deltas)
                   - have chainDepth < effectiveMaxDepth
                   - are not themselves oversized (see 4c)
    best = undefined                                  // { delta, base }
    for C in candidates, most-recently-added first:
        maxSize = best === undefined ? searchBound
                                     : min(searchBound, best.delta.length - 1)
        d = encodeDelta(C.content, E.content, maxSize)
        if d === undefined: continue                  // aborted over maxSize
        best = { delta: d, base: C }                  // reaching here means d is strictly smaller
    emit(E, best)
```

- **`W`** is `pack.window`, default **10** (§1b). §1c pins `0` and `-1` as git's own
  delta-disable switch, so the resolved policy is: `window <= 0` **or** `depth <= 0` ⇒ the
  whole deltify pass is skipped and every object is emitted as a base entry, exactly as today.
  Otherwise `W = min(window, MAX_WINDOW)`. There is no clamp-to-1: clamping a legal `0` up to
  `1` would silently re-enable a feature the user turned off.
- **`DELTA_ACCEPT_RATIO = 0.5`** is the search's cheap upper bound: a delta bigger than half
  the target is very unlikely to survive the real acceptance test below, and bounding the
  search this way is what keeps the per-object cost near-constant.
- **The search bound forecloses ties.** Once `best` is set, `maxSize` is `best.delta.length - 1`,
  and `encodeDelta` returns `undefined` for anything that does not fit under it — so `d.length ===
  best.delta.length` can never hold, and a candidate only ever replaces `best` by being *strictly*
  smaller. Candidates are visited most-recently-added first over a deterministic list, so the
  policy is exactly "strictly smaller wins; ties go to the most recently admitted window member" —
  an older candidate that would have tied on length instead aborts against `maxSize` and never gets
  the chance to compete. No explicit chain-depth or oid comparison is needed to break a tie,
  because no tie can occur: earlier drafts of this design compared chain depth on a length-equal
  match and reasoned that a further oid tie-break on *that* would be a branch with no reachable
  state, which mutation testing would (correctly) flag as dead. That reasoning was right, and it
  applies one level further in than it realised — the chain-depth comparison itself is the dead
  branch, not just an oid comparison layered on top of it, which is why the shipped comparator has
  neither.
- The window is a plain ring buffer of fixed length `W`, not a heap and not a `Map`. Its
  eviction is positional, so its content is a pure function of the sorted order (R9).
- Each window member's delta index (§2b) is built **once**, when it enters the window, and
  discarded on eviction — not rebuilt per target. That is the whole reason the window is a
  window rather than an all-pairs search.

#### 4c. Acceptance — the rule that makes R3 exact

A candidate winning the search is not enough. The entry is emitted as a delta **only** when it
is smaller on disk:

```
deltaBytes = await deflate(best.delta)
baseBytes  = await deflate(E.content)          // computed anyway — it is the fallback
emit delta  iff  deltaBytes.length + MAX_OFS_OVERHEAD_BYTES < baseBytes.length
```

`MAX_OFS_OVERHEAD_BYTES = 5` is the widest `encodeOfsDistance` output the reader will accept
(`decodeOfsDistance` refuses more than `MAX_OFS_DISTANCE_BYTES = 4` continuation bytes,
i.e. 5 bytes total — `pack-entry.ts:121-146`). The real distance is not known at acceptance
time, because byte offsets are assigned inside `serializePackfile`; using the maximum makes the
test conservative in the safe direction. The entry's own type/size header is ignored in the
comparison because it can only *help*: the delta entry's header encodes the instruction
stream's length, which is smaller than the content length the base entry's header encodes, so
the delta's header is never wider.

Two deflates per deltified object instead of one is the price of an exact rule, and it is paid
only for objects that won the search. The upshot is a guarantee this design can state without
hedging: **the pack is never larger than today's**, entry for entry — and the "is a delta
worth it" question is answered on the bytes that actually reach the disk rather than on
uncompressed proxies.

An object is never deltified *and* never enters the window when its content
exceeds `MAX_DELTIFY_BYTES` — it is emitted as a base entry and never indexed. This is the
memory guard (§7) and the reason a 500 MiB blob cannot make gc allocate a 250 MiB index.

#### 4d. Depth tracking

Each emitted entry carries a computed `chainDepth`: `0` for a base entry,
`base.chainDepth + 1` for a delta. A candidate with `chainDepth >= effectiveMaxDepth` is not
offered as a base, so the emitted maximum chain length is exactly `effectiveMaxDepth` and is
enforced by construction, not by a post-hoc check.

### 5. Ordering, emission and the `entries` contract

`buildPack` gains an internal permutation and gives up nothing at its boundary:

```
input.oids  ──(metadata pass)──▶  metas[]  ──(sort)──▶  emissionOrder[]
                                                              │
                                              deltify + serializePackfile
                                                              │
                                                     packfile.entries (emission order)
                                                              │
                                              ──(inverse permutation)──▶
                                                     result.entries (input.oids order)
```

`buildPack` knows the permutation because it computed it, so `result.entries[i]` remains the
meta for `input.oids[i]` (R11). **No call site changes.** The three gc sites'
`indexEntriesFor(oids, pack.entries)` zip, `pack-objects.ts`'s
`oids.map((id, i) => ({ id, crc32: pack.entries[i]!.crc32, … }))`, and the two remaining
callers are all untouched.

`pack-objects.ts`'s `PackObjectsResult.packId` docblock — *"object order inside the pack is the
closure's own order, which differs between tiers"* — becomes **more** true, not less: the pack
order is now the sorted order, which is a function of the object *set* rather than of the
closure's traversal. That is a strict improvement for the tier-stability caveat it documents,
and the docblock is updated to say so.

**Sibling artefacts are untouched.** The `.idx` is built from `(id, crc32, offset)` triples and
is oid-sorted by `sortPackIndexEntries` regardless of emission order; the `.rev` permutes that
same sorted set; the cruft `.mtimes` sidecar is keyed by oid; the midx stores per-pack offsets.
None of them can observe entry *encoding*. `writePackArtifacts` /
`writePackArtifactsViaQuarantine` / `writeCruftPack` need no change.

**Degenerate inputs.** `oids: []` still produces the existing empty-pack result — the sort of
an empty array is empty and `serializePackfile([])` is unchanged. A single object has no
candidates and is emitted as a base. A corpus of one object type has one bucket. An object
equal to a window member (a duplicate oid, which no current caller produces) would delta to a
few bytes and is not special-cased — it is simply the best possible match.

**One quiet behaviour change worth naming: `readRawObject`, not `readObject` +
`serializeObject`.** Today `build-pack.ts` parses each object into a `GitObject`, re-serialises
it, and strips the header (`build-pack.ts:55-67`). The deltify pass wants raw content anyway,
and `readRawObject` hands it over directly — `content` is documented as "the object's content,
after its `<type> <size>\0` header" (`types.ts:89-95`) — skipping a parse and a re-serialise
per object.

For a well-formed object the two are byte-identical: the oid *is* the hash of exactly those
bytes. They can differ for an object whose stored bytes are not what tsgit's own serialiser
would emit, where the parse-and-re-emit path silently rewrites it into canonical form while the
raw path preserves it. The raw path is the git-faithful one — git's packer copies stored bytes
rather than round-tripping objects through a parser — so this is a small correctness
improvement riding along, not a regression. It is named here because it means the pack sha can
change for a repository holding such an object, independently of anything to do with deltas,
and a reviewer who sees that should recognise it rather than hunt for an encoder bug.

### 6. Determinism — the proof obligations

Every input to the emitted bytes must be a pure function of (object set, config, adapter). The
table below is the checklist a reviewer walks:

| Input | Deterministic because |
|---|---|
| Sorted order | `(typeRank, size DESC, oid ASC)` is a **total** order — no two distinct objects compare equal, because oids are unique |
| Metadata pass | Reads are order-independent; `boundedMapFor` has `Promise.all` semantics and returns results **in input order** regardless of completion order (`internal/concurrency.ts:53-58`) |
| Window content | Fixed-length ring buffer over the sorted sequence; positional eviction |
| Candidate visit order | Array walk, most-recent-first; no `Map`/`Set` iteration anywhere in the hot path |
| Index bucket walk | `Int32Array` chain, most-recent-first, capped at `MAX_CANDIDATES_PER_BUCKET` |
| Match tie-break | Lower base offset, then lower base index — total |
| Candidate tie-break | Strictly-smaller-only acceptance forecloses ties; most-recently-admitted window member wins by visit order |
| Acceptance | A comparison of two byte lengths |
| `deflate` | Deterministic **within** an adapter (already the pack surface's contract) |
| Config | Read once per `buildPack` call through the memoised `readConfig`; never re-read mid-pass |

Two anti-patterns are explicitly banned in the implementation and are the review's grep list:
**no `Date.now()` / no `performance.now()`** anywhere in the deltify path, and **no
`Promise.race` / no unbounded `Promise.all` whose *completion* order feeds a mutable
accumulator**.

**The window search is single-threaded, and that is the point.** §1e measures git's own
`repack -a -d` varying by 3.8 % in output size on byte-identical input, because
`pack.threads` partitions the object list and each thread sees a narrower window; git's
single-threaded mode is both reproducible *and* 12.5 % smaller on F1. tsgit has no
`pack.threads` (it is out of scope) and no thread pool in the deltify path, so it inherits
git's *better* branch by default. Where git chose parallelism over reproducibility, tsgit
cannot — three gc call sites key on the pack sha — and this is the concrete reason
byte-identity with git's packer was rightly excluded from the contract rather than merely
being inconvenient.

### 7. Memory

Steady-state residency during the deltify pass:

```
R  =  (W + 1) × avgContentBytes            uncompressed window contents + current target
   +  W × (avgContentBytes / 2)            delta indexes (two Int32Arrays per window member)
   +  Σ compressedEntryBytes               the output array — PRE-EXISTING, unchanged
   +  N × sizeof(meta)                     N × ~40 B for {id, type, size}
```

With git's default `W = 10` (§1) and `MAX_DELTIFY_BYTES` bounding `avgContentBytes` per member,
the window term is bounded and small. The `Σ compressedEntryBytes` term is today's behaviour
and is **not** improved here: `serializePackfile` still takes the whole entry array. That is
30.5's problem, and §12 says which seams this change moves under it.

The metadata term (`N × ~40 B`) is new and trivial — for tsgit's own history (14 324 objects)
it is well under a megabyte. What is **not** trivial is how those `(type, uncompressedSize)`
pairs are obtained, because tsgit has no cheap metadata primitive: `catFileBatch` calls
`readObject` and computes `payloadByteLength` from a fully-materialised object
(`cat-file-batch.ts:20-26`), so today the only way to learn an object's size is to read it
whole. The sort must run *before* the window does, so the metadata cannot be a by-product of
the window pass. **DC-12** is the choice, and R17's formula holds only under options (a) and
(c) of it; under (b) the residency is O(total inflated size) and R17 must be restated.

**Aliasing.** `readRawObject`'s `content` "may alias the object cache (`ctx.deltaCache` or a
loose-read buffer) — treat both as immutable and copy before mutating" (`types.ts:84-95`). The
window holds those references for up to `W` iterations. That is safe — nothing in the deltify
path mutates a buffer — and it is not a double count: a window member that is also a cache
entry is one allocation seen twice. The rule the implementation must keep is simply that the
window never writes through a retained reference.

`MAX_DELTIFY_BYTES` is the guard that keeps `R` bounded regardless of corpus: an object above
it is emitted as a base and never enters the window or gets indexed. Its value, and whether it
should be `core.bigFileThreshold` rather than a constant, is DC-6.

### 8. Config surface

Two new int-typed keys, following ADR-353's established pattern exactly — a lenient
`readConfig` merge plus a cold-path finder plus an eager assertion:

| Piece | Shape | Mirrors |
|---|---|---|
| `ParsedConfig.pack.window?: number` / `.depth?: number` | additive fields on the existing `pack` object (which already carries `writeReverseIndex`) | `config-read.ts:116-117` |
| `mergePack` extension | `parseGitInt(value)`; `if (parsed.ok) acc.pack = { …acc.pack, window: parsed.value }` — a valued-but-invalid int merges as **absent** (lenient) | `config-read.ts:1140-1146`, `applyLooseCompressionEntry` |
| `findFirstInvalidPackInt(ctx)` | walks the cached `[pack]` subsectionless tokens in file order, returns the first `window`/`depth` entry that fails `parseGitInt` or the pinned range | `findFirstInvalidGcAuto` (`config-read.ts:611-631`) |
| `assertValidPackIntConfig(ctx)` | throws `configBadNumericValue(key, source, value, reason)` | `assertValidGcAutoConfig` (`:637-642`) |
| Call site | top of the gc pipeline, beside the existing `await assertValidGcAutoConfig(ctx)` (`gc-pipeline.ts:91`) — before any write | same |

**Valueless keys.** §1c pins that git dies on a valueless `depth`, so the finder reports
`value: ''` with reason `'invalid unit'`. No special case is needed:
`parseGitInt(null)` already returns exactly that (`config-ini.ts:750-760`, whose own comment
documents the `?? ''` fallback), so the finder can pass `token.value` straight through the way
`findFirstInvalidGcAuto` does.

**First-vs-last-entry semantics: pinned to FIRST.** §1c shows both orders fatal — a malformed
`pack.depth` kills `repack` whether a valid line precedes or follows it. These keys are in the
`core.compression` family, not the `core.maxTreeDepth` last-write-wins family
(`config-read.ts:653-666`), so the finder is `findFirstInvalidPackInt` — a file-order scan
returning the first failure, structurally identical to `findFirstInvalidGcAuto`. Note that
`git config --get pack.depth` *is* last-write-wins and returns the valid line: `--get` is not
the semantics `repack` uses, and a test that pins the refusal through `git config --get` would
pin the wrong thing.

**Range narrowing.** `parseGitInt`'s own bounds are int64; §1c pins git's as the C `int`
(`2147483647` accepted, `2147483648` → `out of range`). The finder therefore layers
`GIT_C_INT_MIN`/`GIT_C_INT_MAX` on top, exactly as `findFirstInvalidGcAuto` and
`findLastInvalidMaxTreeDepth` already do — the same two lines, not a new mechanism.

**Legal values that are not defaults.** `0` and `-1` on either key disable delta emission
entirely (§1c) and must be accepted silently — they are not errors and not "unlimited". A value
above git's documented 4095 maximum is *also* accepted by git, which clamps it with a
`warning:` and exits 0; tsgit clamps further and silently (§9).

**Scope.** `readConfig` reads the **local** `${commonGitDir}/config` only — "NOT a multi-scope
merge: see `loadConfigEntry`'s own docstring for why local-only is deliberate"
(`config-read.ts:143-152`). git resolves `pack.depth` across system/global/local. That gap is
pre-existing and repository-wide, not something this change introduces or is entitled to fix
here; it matters only in that the interop tests must set these keys with
`git config` (local) and not `git config --global`, or they will pin a divergence that has
nothing to do with the packer.

`pack.windowMemory` and `pack.compression` are **not** introduced here (DC-7). ADR-353 and
`design/int-config-valueless-refusal.md` both record `pack.compression` as deliberately out of
scope; adding it would change the emitted pack bytes on the Node adapter for reasons unrelated
to deltas, and it is a strictly separable change.

### 9. The reader-cap collision

`effectiveMaxDepth = min(pack.depth, WRITER_MAX_CHAIN_DEPTH)`, evaluated only when
`pack.depth > 0` — a `depth` of `0` or `-1` disables delta emission outright (§4b), so it never
reaches this arithmetic.

`WRITER_MAX_CHAIN_DEPTH` must not exceed what **both** tsgit readers accept. From the Context
table that is **49**, one below `MAX_DELTA_CHAIN_DEPTH`, because `walkDeltaChain`'s
`for (let depth = 0; depth < MAX_DELTA_CHAIN_DEPTH; …)` needs one loop iteration for the base
entry itself.

Two ways to discharge it, and the choice is DC-5:

- **Clamp the writer to 49.** One named constant, one comment, zero behaviour change on the
  read side. Costs one delta level against git's default of 50 — an immeasurable size
  difference.
- **Fix `walkDeltaChain` to `depth <= MAX_DELTA_CHAIN_DEPTH`** so both readers agree on 50, then
  clamp the writer to 50. This is arguably the real bug fix — the two arithmetics disagreeing
  is a latent defect independent of this change — but it widens what `fsck` accepts, which is a
  behaviour change on a refusal surface and therefore wants its own pin against git's own
  `index-pack` depth handling.

Either way, `effectiveMaxDepth` is a single named constant read at one site, and a test asserts
that the longest chain the writer emits round-trips through **both** readers.

**The clamp is a documented divergence and must be written down as one.** §1c pins that git
accepts `pack.depth` up to 4095 outright, and above that clamps to 4095 with
`warning: delta chain depth <n> is too deep, forcing 4095` at **exit 0** — so *git already
clamps rather than refuses*, and tsgit is doing the same thing at a lower ceiling. A user
setting `pack.depth = 250` gets 49 (or 50) instead, observable only as
smaller-than-expected compression, never as an error.

Two sub-decisions fall out and neither is free:

- **tsgit clamps silently.** git prints a `warning:`; ADR-249 puts rendered text on the
  caller's side of the line, and `maintenance` returns structured data with no diagnostic
  channel. Adding one for this would be a new surface. The clamp is therefore documented in
  the ADR and in `docs/use/commands/maintenance.md` rather than emitted.
- **Refusing instead of clamping is worse**, and is not offered: it would turn a legal git
  config into a tsgit-only refusal on a repository-opening path, a far bigger faithfulness
  break than a heuristic that under-delivers.

§1d makes this concrete rather than theoretical: F1's deltified pack has a **max chain length
of exactly 50**, so git's default really does run to the cap on delta-friendly content and the
clamp will bind on that shape.

### 10. Which callers opt in

The brief scopes the *use* to gc/consolidation. The other four are not automatic:

| Caller | Site | Delta-safe? | Note |
|---|---|---|---|
| `gc-pipeline` normal pack | `:484` | **yes — in scope** | The pack is written to local disk and read back by tsgit and git alike |
| `gc-pipeline` promisor pack | `:527` | **yes — in scope** | ADR-733's second pack; identical situation |
| `gc-pipeline` cruft pack | `:560` | **yes — in scope** | Same, plus the `.mtimes` sidecar which is orthogonal to entry encoding |
| `pack-objects` | `pack-objects.ts:82` | yes, mechanically — but see below | Local pack write. §1f pins that **git's own bare `pack-objects` emits `REF_DELTA`**, not OFS: `repack` is what passes `--delta-base-offset`. A tsgit `packObjects` emitting OFS would therefore be *less* like git's `pack-objects` than staying base-only is. See DC-1 |
| `bundle-create` | `bundle-create.ts:310` | yes, mechanically | A bundle is index-packed by whoever reads it; `OFS_DELTA` inside a self-contained pack is universally readable |
| `push` | `push.ts:353` | **needs a capability gate** | See below |

**Push is the one that is not free.** `CLIENT_CAPABILITIES_PUSH` already lists `ofs-delta`
(`capabilities.ts:17-23`) and `selectPushCapabilities` *intersects* it with the server's
advertisement (`receive-pack-client.ts:39-51`). A pack containing `OFS_DELTA` entries may
therefore only be sent when `ofs-delta` survived that intersection. Emitting deltas
unconditionally on the push path would break against a server that does not advertise it.
`receive-pack-client.ts:31-33` also records that tsgit never advertises `thin-pack` *because*
it emits non-delta packs — that comment becomes wrong the moment push opts in, and R8 (no
`REF_DELTA`) is what keeps it merely imprecise rather than false.

The recommendation (DC-1) is **gc only in this change**, with the seam built so the other four
are a one-line opt-in.

§1f sharpens that recommendation into a faithfulness argument rather than a scoping one: the
gc/consolidation path *is* git's `repack` path, and `repack`'s effective default is
`OFS_DELTA` (`repack.useDeltaBaseOffset` defaults to true, measured). Emitting OFS there is
faithful. Emitting OFS from `packObjects` would not be — git's `pack-objects` defaults to REF —
and emitting REF there would violate R8. Two of the four remaining callers therefore have a
*right answer that this change deliberately does not implement*, which is a better reason to
leave them alone than "out of scope".

### 11. Retiring the inflation note

Four places record the trade, and all four are evidence-bearing rather than decorative:

| Where | What it says | What retires it |
|---|---|---|
| `docs/adr/732-gc-consolidates-existing-packs.md` §Consequences | "A delta-writing pack writer becomes the highest-value follow-up to this command" | A new ADR that **refines 732**, naming this change and carrying the re-measured table. 732's own text is not rewritten — it was true when ratified |
| `docs/design/perf-remediation-2026-08.md` §"The size trade, measured" (≈L3079-3122) and the DC-17/DC-18 rows (≈L3448-3449) | the ×1.29 / ×3.17 / ×6.91 table and "the single change that would take all three rows of the table above to ×1.00" | A pointer line to this design plus the re-measured ratios. The old table stays as the historical baseline it is |
| `docs/design/perf-remediation-2026-08.md` §Out of scope (≈L3547-3554) | "A delta-capable pack writer. ⏭️ The follow-up that retires ADR-732's size trade" | struck through and pointed here, in the same style that entry already uses for the two items ADR-731/732 moved into scope |
| `docs/use/commands/maintenance.md` §"The size trade" (L210-222) | the user-facing ×1.29…×6.91 prose | rewritten from the new measurements — this is the only *user-facing* copy and the one that must not lag |

**What counts as evidence, and over which corpora.** Not "deltas are now written" — a size
table. And it must cover **both** corpus families, because they are not the same:

- The **original three** the ×1.29 / ×3.17 / ×6.91 figures were taken over — the
  `DELTA_CHAIN_FIXTURE` shape, tsgit's own full history, and the `MEDIUM_FIXTURE` shape. Only
  re-measuring *those* retires *those* numbers; a new table over new fixtures would be a
  different claim wearing the same clothes.
- The **three §1d fixtures** (F1/F2/F3), which are what R16's size-class assertion is written
  against and are reproducible from a committed generator.

Both are produced the same way — `git -c pack.threads=1 repack -a -d` as the denominator
(§1e: default threading is not reproducible), tsgit `gc` as the numerator — plus the
directional assertion the existing maintenance interop test already makes, inverted: on the
delta-chain fixture `packBytesAfter` must now be **within the recorded class of**
`packBytesBefore` rather than multiples above it. The assertion stays a class, never a
threshold — the perf design's own note that a 5×-moving number is a flake generator applies
just as much to a shrinking one, and §1e adds a second reason: the peer itself moves.

`MaintenanceResult.packBytesBefore` / `packBytesAfter` (R33 of the perf design) keep their
meaning exactly and need no change; the ratio a caller computes from them simply approaches 1.

The backlog entry (`docs/BACKLOG.md` **30.4**) is ticked in the same pass, with the shipped
scope summarised the way 30.2 and 30.3 summarise theirs — including anything this design
discovered that the entry did not anticipate (the reader-cap collision of §9, and the absence
of path hints on the gc path of §4a, are both in that class).

### 12. Seams 30.5 will want, and what this change does to them

Backlog 30.5 (streaming index pass) is sequenced *after* this and is explicitly allowed to
reshape shared pack-write/read seams. This design moves two of them and should say so now:

- **`serializePackfile` still takes a materialised array.** This change adds `baseIndex`, which
  is an *array-relative* reference. A streaming writer would need offsets or a callback
  instead. The mitigation is that `baseIndex` is resolved to a byte distance entirely inside
  `serializePackfile`, in one place — a streaming variant re-implements that one arithmetic and
  nothing else.
- **`buildPack` gains a metadata pass.** 30.5's indexer has the same need on the *read* side
  (a first pass recording types, sizes and delta positions). The two passes are structurally
  the same shape and are worth unifying later; this design does **not** try to share them
  speculatively, because the read side's pass works from pack bytes and this one works from the
  object store.

Nothing here writes a new on-disk format, so 30.5 inherits no new file to parse.

---

## Decision candidates

Twelve load-bearing choices. **All twelve are now settled — see §Ratified decisions, which
overrides this table.** It is retained as the record of what was weighed, not as guidance.
The DC-6 determinism claim about `pack.windowMemory` is measured false and retracted there.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| **DC-1** | **Which `buildPack` callers emit deltas** | (a) **gc/consolidation only** — the three `gc-pipeline` sites; the other four keep today's base-only path behind an explicit `deltify: false` default. (b) **Every local-disk writer** — gc + `pack-objects` + `bundle-create`; `push` stays base-only. (c) **All five**, with `push` gated on `ofs-delta` surviving `selectPushCapabilities`. | **(a)** | It is the brief's scope, it is the only path with a measured inflation problem, and it keeps `push`'s wire behaviour and `receive-pack-client.ts:31-33`'s stated invariant untouched. (b) is a one-line follow-up once (a) has interop evidence. (c) adds a protocol-conditional code path whose failure mode is a rejected push against an old server — the worst place to discover a packer bug. |
| **DC-2** | **Where the selection policy lives** | (a) **Pure domain** `domain/storage/delta-select.ts` over `ReadonlyArray<{id,type,content}>` → a plan. (b) **Split**: domain owns `encodeDelta` + `createDeltaIndex` + the pure comparator; a primitive-internal `deltify.ts` owns the lazy sliding window that calls `readRawObject`. (c) **All inside `build-pack.ts`.** | **(b)** | (a) is the cleanest hexagonally but forces every object's content resident to call it, which contradicts R17 outright — the window's whole point is that it is lazy. (b) keeps every *decision* pure and testable (comparator, encoder, acceptance predicate are all pure functions) while the I/O orchestration sits where I/O belongs. (c) pushes `build-pack.ts` well past the file-size and function-size limits. |
| **DC-3** | **Object ordering, and what it costs the `entries` contract** | (a) **`(typeRank, size DESC, oid ASC)` internally, permute `entries` back to `input.oids` order** — no caller changes. (b) Same ordering, but **return `{ id, crc32, offset }` triples** in emission order and change all five call sites' zip logic. (c) **Widen `BuildPackInput`** to accept an optional per-oid path hint, add a git-style name hash to the sort key, and have `pack-objects`/`bundle-create` supply it from `ClosureObject.path` (gc cannot — §4a). | **(a)** | (a) is invisible to every caller and preserves R11 exactly; the permutation is `buildPack`'s own knowledge, so nothing is inferred. (b) is arguably a better long-term API (order-independent metas) but changes five call sites and their documented invariants for no capability gained. (c) genuinely improves the many-distinct-files size class — but it helps exactly the two callers DC-1 recommends excluding, and does nothing for gc, which has no paths anywhere in its pipeline. |
| **DC-4** | **The base index's data structure and its memory bound** | (a) **Two `Int32Array`s** (`heads` + `next` chain) over fixed 16-byte blocks — ≈ `base.length / 2` bytes, no per-block allocation. (b) A `Map<number, number[]>` keyed by block hash — simpler to read, ~4–6× the memory, and a `Map` in the determinism-critical path. (c) **Index only one window member at a time** — build the index for a single candidate, try it, discard, repeat — O(1) index memory at the cost of rebuilding W indexes per target instead of one per window admission. | **(a)** | (a) is git's own shape, is the only one whose iteration order is trivially deterministic (an array walk), and matches the repo's "zero-copy DataView / typed-array" performance priority. (b) puts a `Map` on the path §6 has to prove deterministic — defensible, but it is exactly the kind of container whose iteration order a reviewer must then argue about. (c) trades the whole point of a sliding window (build each index once, reuse it W times) for memory tsgit does not need to save; it is the escape hatch if the index term ever measures badly, not a starting position. |
| **DC-5** | **The chain-depth cap, given the two readers disagree by one (§9)** | (a) **Clamp the writer to 49** (`min(pack.depth, 49)`), leave both readers alone. (b) **Fix `walkDeltaChain`** to `depth <= MAX_DELTA_CHAIN_DEPTH` so both readers accept 50, then clamp the writer to 50. (c) Clamp to 49 **and** file the reader disagreement as its own follow-up. | **(a)** | One delta level is an immeasurable size difference, and (a) touches no refusal surface. (b) is the more honest fix — the readers disagreeing is a real latent defect — but it *widens what `fsck` accepts*, which is a faithfulness-relevant behaviour change and wants its own pin against git's own depth handling; folding that into a packer change mixes two risks. Per the repo's "no silent follow-ups" rule, (c) is only viable if the user explicitly wants the split. |
| **DC-6** | **What bounds the largest deltifiable object** | (a) A **named constant** `MAX_DELTIFY_BYTES` (proposed: 64 MiB) — no config surface. (b) **`core.bigFileThreshold`** (git's own key, documented default 512 MiB) read through the int-config pattern. (c) **`pack.windowMemory`** — bound the *window's total* rather than any single object. | **(a)** | The guard exists to keep §7's residency formula bounded, not to be tunable. (b) is the faithful answer if the user wants git's key honoured, but it is a second new int key with its own refusal pin, and git applies it well beyond delta selection. (c) bounds the right quantity but is the hardest to make deterministic — a memory-driven window that shrinks under pressure would make the pack sha depend on the host, which R9 forbids outright. |
| **DC-7** | **How wide the config surface is** | (a) **`pack.window` + `pack.depth` only.** (b) Those two **plus `pack.windowMemory`.** (c) Those two **plus `pack.compression`** (the pack-path deflate level ADR-353 deliberately left alone). | **(a)** | The brief names exactly these two, and each new key costs a finder, an eager assertion, an interop refusal pin and an `api.json` field. (b) is refused above on determinism grounds (DC-6c). (c) is a genuine faithfulness gap — git *does* deflate pack entries at `pack.compression` (default `-1`, §1b) rather than at the adapter default — but it changes emitted bytes independently of deltas, so folding it in makes the size measurement ambiguous about which change caused what, and §1c pins that its out-of-range refusal is a **different** message (`fatal: bad pack compression level <n>`) needing its own error arm rather than a reuse of `CONFIG_BAD_NUMERIC_VALUE`. |
| **DC-8** | **Is `REF_DELTA` ever emitted** | (a) **Never** — every delta is `OFS_DELTA`; packs stay self-contained; `thin-pack` stays un-advertised. (b) **Only for thin packs on the push path**, gated on the server advertising `thin-pack`. (c) Emit `REF_DELTA` for **cross-pack bases** during consolidation, so an existing delta chain can survive a repack without re-encoding. | **(a)** | (a) keeps R8, keeps `build-pack.ts`'s self-contained promise literally true, and keeps every pack readable standalone. (b) is a protocol feature, not a packer feature, and needs its own negotiation design. (c) would produce a pack that depends on another pack — which breaks the "every stored pack is self-contained" invariant `read-object.ts:64-70` relies on to interpret a resolver miss as a genuinely absent object. |
| **DC-9** | **What *pins* determinism, beyond writing careful code** | (a) **Two tests**: `buildPack` ×2 byte-equality, and a full gc ×2 sha-equality (the three existing Pin V/W/Y assertions). (b) (a) **plus a lint-shaped guard** — a `check:*` script asserting the deltify path contains no `Date.now`/`Math.random`/`Map` iteration. (c) (a) **plus a golden pack fixture** committed to the repo and byte-compared on every run. | **(a)** | The two tests catch the failure that matters, at the boundary that matters. (b) is cheap and catches the *class* rather than the instance — attractive if the user wants a standing guard, but it is a new bespoke audit script to own. (c) is the strongest signal and the worst maintenance: a committed golden pack turns every legitimate heuristic tweak into a fixture regeneration, and the repo already has a "byte-identity is not the contract" ruling for exactly this surface. |
| **DC-10** | **The public writer-type shape (`PackWriterEntry` is in `api.json`)** | (a) **Additive**: keep `PackWriterEntry` unchanged, add `PackWriterDeltaEntry` and a `PackWriterInput` union; `serializePackfile` takes the union. (b) **Re-shape**: make `PackWriterEntry` itself the union — smaller surface, but a consumer reading `entry.type` as `BasePackEntryType` breaks. (c) **Keep the public writer base-only** and add a separate internal `serializeDeltaPackfile`, leaving `serializePackfile`'s published contract untouched. | **(a)** | (a) is source-compatible in both directions — existing arrays still assign, existing readers still narrow — so it is a minor, not a major. (b) is cleaner to read and is a **breaking** change requiring a major bump. (c) avoids the API question entirely but forks the writer into two near-identical implementations, which is the duplication `check:duplicates` exists to catch. |
| **DC-11** | **The "is this delta worth it" acceptance rule** | (a) **Exact**: deflate the winning delta and the full content, emit the delta only if `deltaBytes + ofsOverhead < baseBytes` — two deflates per deltified object. (b) **Uncompressed proxy**: emit when the *uncompressed* delta is smaller than the uncompressed content by a margin — one deflate, but the on-disk answer can be wrong either way. (c) **Always emit** when the search found any delta under the search bound. | **(a)** | (a) is what makes R3 a guarantee rather than a hope: the pack provably never grows. Its cost is one extra deflate on objects that already won a window search, which is a minority of the corpus. (b) is faster and is what a size-only heuristic would do, but it can emit a delta that is *larger* on disk than the base entry — the exact failure this whole change exists to fix, in miniature. (c) is (b) without even the proxy. |
| **DC-12** | **How the sort key's `(type, uncompressedSize)` is obtained** (§4a's trap, §7's residency) | (a) **A second full read pass** — read every object once for metadata, sort, then read each again in the window pass. Simple; O(window) residency; **2× read cost**. (b) **One read pass, all content resident** — read once, keep everything, sort, deltify. Simplest and fastest; residency becomes O(total inflated size) and R17 is restated. (c) **A new `readObjectMetadata(ctx, id)` primitive** that avoids a full inflate where the store allows it: a packed **base** entry's size is in its pack header (free); a packed **delta** entry needs one small inflate plus the existing `readDeltaTargetSize`; a loose object still costs a full inflate. Then one content read in the window pass. | **(c)** | The repo's standing preference is perf on a hot path even at the cost of a substantial in-PR rewrite, and gc is the hottest whole-store pass tsgit has. (c) makes the metadata pass nearly free for the *packed* majority — exactly the objects consolidation is dominated by — and the pieces already exist (`parsePackEntryHeader`, `readDeltaTargetSize`, `nextOffsetForEntry`). It is also independently useful: `catFileBatch`'s own `--batch-check` shape wants it. (a) is the honest fallback if (c) measures as not worth its code. (b) is refused: it makes gc's peak memory proportional to the repository, which is the failure 30.5 exists to prevent, and it would be a regression relative to today's writer. |

---

## Test strategy

### Unit — `test/unit/domain/storage/delta-encode.test.ts`

Domain, pure, 100 % line/branch/function/statement, `describe('Given …')` >
`describe('When …')` > `it('Then …')`, AAA body, `sut`.

| Area | Cases |
|---|---|
| `encodeDeltaVarInt` | 0; 127 (1 byte); 128 (2 bytes, continuation set); a 5-byte value; the 6-byte value → `INVALID_DELTA` with the asserted `reason` |
| `encodeCopy` | offset 0 (no offset bytes, `cmd` offset bits clear); each of the four offset byte positions in isolation; each of the three size byte positions in isolation; size exactly `0x10000` → three size bytes `00 00 01`, decoded back as `0x10000`; size `0xffffff`; size `0x1000000` → refused |
| `encodeInsert` | 1 byte; 127 bytes; 128 bytes → refused (the differ splits, the serialiser does not) |
| `encodeDelta` | identical base and target → one copy, no inserts; disjoint content → all inserts; a prefix match; a suffix match; a match requiring **backward** extension (an anchor that starts mid-block); a target shorter than one block; empty target; empty base |
| `encodeDelta` abort | `maxSize` smaller than the header → `undefined` before any instruction; `maxSize` crossed mid-stream → `undefined` |
| `createDeltaIndex` | a base of all-identical blocks exercising `MAX_CANDIDATES_PER_BUCKET`; a base shorter than one block (empty index, encoder falls back to all-inserts) |

**Guard clauses get isolated tests.** `serializePackfile`'s two `baseIndex` refusals
(`baseIndex >= i`, `baseIndex < 0`) are separate tests, each triggering exactly one condition,
each asserting the error **data** (`code`, `offset`, `reason`) via try/catch — never a bare
`toThrow(Class)`.

### Property — `test/unit/domain/storage/delta-encode.properties.test.ts`

The codec is a textbook round-trip pair and hits three of CLAUDE.md's four lenses. Generators
live in the existing `test/unit/domain/storage/arbitraries.ts`.

| # | Lens | Property | `numRuns` |
|---|---|---|---|
| P1 | round-trip pair | `applyDelta(base, encodeDelta(base, target)) ≡ target` for arbitrary `(base, target)` byte arrays | **200** |
| P2 | round-trip pair | `parseDelta(serializeDelta(sourceLength, targetLength, instructions)) ≡ { sourceLength, targetLength, instructions }` for arbitrary valid instruction lists | **200** |
| P3 | total function | `encodeDelta(base, target)` never throws for any `(base, target)` in the safe domain, and always returns a `Uint8Array` when `maxSize` is omitted | **200** |
| P4 | counting invariant | the emitted delta never contains a `cmd === 0` byte at an instruction boundary, and every `INSERT` length is in `1..127` | 100 |
| P5 | invariant | `encodeDelta(x, x)` is strictly shorter than `x` for any `x` longer than `MIN_COPY_BYTES × 4` — the differ actually finds the trivial match | 100 |

To make P1 exercise real matching rather than degenerate all-insert cases, `target` is drawn
from a mutation arbitrary over `base` (splice, duplicate, truncate, append) as well as from
independent random bytes.

**No seed is ever committed.**

### Unit — `test/unit/domain/storage/pack-writer.test.ts` (extended)

- A two-entry pack, second entry an `OFS_DELTA` on the first: assert the emitted
  `baseDistance` bytes equal `encodeOfsDistance(offset₁ - offset₀)`, and that
  `parsePackEntryHeader` on the emitted bytes returns `{ type: 6, baseDistance }` matching.
- The crc32 of a delta entry covers header ++ distance ++ payload (asserted by recomputing
  over the exact slice).
- The two refusals above.

### Unit — `test/unit/application/primitives/build-pack.test.ts` (extended)

- **Order contract (R11):** for an input whose sorted order differs from `input.oids` order,
  `result.entries[i]` is the meta of `input.oids[i]` — asserted by looking each offset up in a
  freshly-parsed `.idx` built from the same result.
- **Determinism (R9):** two `buildPack` calls over the same oid set produce byte-identical
  `bytes` and equal `sha`; and a call over a *shuffled* oid array produces the same pack **body
  bytes** (offsets included) as the sorted one, since emission order is sort-derived.
- **Acceptance rule (R3):** a corpus of incompressible, unrelated blobs yields zero delta
  entries (asserted by walking the emitted pack's entry types), and the pack is not larger than
  the same corpus written by the pre-change path.
- **Depth cap:** a synthetic chain-forcing corpus emits no chain longer than
  `effectiveMaxDepth`, verified by resolving every object and by walking back-pointers in the
  emitted bytes.

### Integration — `test/integration/delta-pack-interop.test.ts` (new)

Cross-tool, `describe.skipIf(!GIT_AVAILABLE)`, one shared `beforeAll` repo and a 60 s timeout
(the known interop load→validate flake), `runGit` env-scrubbed per `interop-helpers.ts`. The
file carries a `@proves` header in the same grammar `packfile-interop.test.ts:9-14` uses
(`surface: packfile`, `bucket: cross-tool-interop`, `interopSurface: packfile`) so the
test-pyramid and parity-fixture audits classify it correctly.

Every row of §1's pinned matrix becomes a case here. The load-bearing ones:

| # | Given | Then |
|---|---|---|
| X1 | a repo tsgit `gc`'d | the pack contains at least one **`OFS_DELTA`** and zero `REF_DELTA` (R8) — asserted through the §1g oracle: `git show-index < <idx>` for every offset, then the type nibble `(packBytes[offset] >> 4) & 7` in the `.pack`. **Not** through `verify-pack`, which cannot see the distinction. This runs first; every row below is vacuous without it |
| X2 | the same pack copied into a scratch dir outside any repository | `git index-pack --strict -v <pack>` exits **0**, prints the pack's own sha bare on stdout, and writes `.idx` *and* `.rev` beside it (§1g O1) |
| X3 | the same repo | `git fsck --strict --no-progress` exits **0** with **zero output on both streams** (§1g O6) |
| X4 | the same repo | `git cat-file --batch-all-objects --batch-check='%(objectname)' \| git cat-file --batch` exits **0**, and the `--batch-check` listing equals the oid/type/size set that went in. The pipe is the readability oracle; the listing alone is not (§1g) |
| X5 | a tsgit-written delta pack | `git verify-pack -v`'s `chain length = N: M objects` histogram shows every `N ≤ effectiveMaxDepth`, and its 7-field lines' `<chain-depth>` column agrees |
| X6 | the same pack | tsgit's own `fsck` reports no delta-chain finding, and `readObject` resolves every oid — the R7 pair, both readers, on a corpus deliberately built to reach `effectiveMaxDepth` |
| X7 | the three §1d fixtures, gc'd by tsgit and repacked by `git -c pack.threads=1 repack -a -d` | tsgit's pack size is within the recorded size class of git's, with the §1e headroom (R16) |
| X8 | `pack.depth`/`pack.window` = `abc` (→ `invalid unit`), `2147483648` (→ `out of range`), valueless (→ `invalid unit`), each as the **first** and as the **last** of two lines | tsgit refuses with `CONFIG_BAD_NUMERIC_VALUE` carrying the pinned key/source/value/reason **in both orders**, and real `git repack -a -d` refuses the same value with the same reason tail and exit 128 (§1c) |
| X9 | `pack.depth` = `2147483647` and `100000` | tsgit accepts and clamps (no refusal), matching git's accept-and-clamp; `4095` is accepted by both |
| X10 | `pack.depth = 0`, `pack.depth = -1`, `pack.window = 0`, `pack.window = -1` — each alone | no delta entry is emitted, the pack is byte-identical to the pre-change writer's output for the same oid set, and real `git repack` with the same config also emits zero deltas (§1c) |
| X11 | `pack.window = 1` | at most one candidate is tried; chains stay shallow; git still accepts the pack |

X10 is the migration-safety case, and §1c is what makes it *faithful* rather than a tsgit
escape hatch: `0` and `-1` really are git's own delta-disable switch. It proves the delta path
can be turned off and that doing so recovers the old bytes exactly.

**Corruption oracles.** Three cases, because §1g pins **three different exit codes for the same
corruption**:

| Corruption | Oracle | Expected |
|---|---|---|
| one byte flipped inside an `ofs-delta` payload of a tsgit-written pack | `git index-pack --strict -v` | exit **128**, `error: inflate: data stream error (incorrect data check)` + `fatal: pack has bad object at offset <n>: inflate returned -3` |
| the same pack | `git verify-pack -v <idx>` | exit **1** (not 128), stdout tail `<pack>: bad` |
| the same pack installed in a repo | `git fsck --strict` | exit **6**, with `pack checksum mismatch` / `index CRC mismatch` / `failed to unpack compressed delta` on stderr |

These are what make X2/X3 meaningful rather than tests that would pass on arbitrary bytes.

⚠️ **Any test that corrupts an entry *header* (not a payload) must recompute the pack's 20-byte
trailer**, or git answers `fatal: pack is corrupted (SHA1 mismatch)` and never reaches the
condition under test — §1h hit exactly this. A payload flip does not need it, because inflate
fails during the indexing pass, before the trailer check.

### Integration — `test/integration/maintenance-interop.test.ts` (extended)

- The three gc sha-identity pins (R10) re-run with deltas on: repeat gc over an unchanged set
  reproduces the same normal / promisor / cruft pack sha, and takes the same no-op branch. The
  existing spies on `buildPack` (`maintenance.test.ts:1908-2009`) already express the shape.
- The directional size assertion, inverted (R18).

### Bench

Extends the existing `test/bench/maintenance.bench.ts`, whose docblock currently justifies its
delta-chain scenario with *"`buildPack` is base-only … so every run re-inflates every delta and
re-emits it as a full object"*. That sentence is exactly what this change falsifies, so the
scenario stays (it is now measuring the deltifying path's cost, which is the interesting
number) and the docblock is rewritten. A second scenario over `MEDIUM_FIXTURE`'s
barely-deltifiable shape bounds the *wasted* search cost — the case where the window finds
nothing and every candidate is a thrown-away encode.

Per the repo's rule, published numbers come from CI's nightly bench artifact, never a local
run; the size ratios in §1 and §11 are sizing measurements, not perf claims.

### Mutation

Target 0 survivors. Known-hazardous spots to write kill tests for up front:

- Every bit constant in `encodeCopy` (`0x01`…`0x40`, `0x80`) — a per-position test each, since
  a single combined case lets a flipped mask survive.
- `MIN_COPY_BYTES`, `DELTA_BLOCK_BYTES`, `MAX_CANDIDATES_PER_BUCKET`, `DELTA_ACCEPT_RATIO`,
  `MAX_INSERT_BYTES`, `MAX_COPY_BYTES` — each needs a case whose *output* changes when the
  constant does, not merely one that still passes.
- The `< ` vs `<=` in the acceptance rule (R3) — a case where delta and base deflate to exactly
  equal lengths must pick the base.
- `baseIndex >= i` vs `> i` — the self-reference case (`baseIndex === i`) is the killer.
- The depth comparison `chainDepth >= effectiveMaxDepth` — a corpus that lands exactly on the
  cap.

Loop-bound mutants inside the match-extension loops are the usual equivalent-mutant family; any
suppression must be **re-proved against this code**, never carried forward from another module.

**Coverage scope vs mutation scope.** The 100 %-coverage gate covers `domain/` and `adapters/`,
while Stryker mutates all of `src/`. `delta-encode.ts` is therefore coverage-gated *and*
mutated; `deltify.ts` and the `build-pack.ts` changes are mutated but not coverage-gated —
their tests must be written to the same standard anyway, because mutation is the gate that will
notice if they are not.

---

## Out of scope

- **Byte-identity with git's packer.** Explicitly not the contract (backlog 30.4): git's delta
  selection is heuristic and version-dependent. The contract is validity, readability through
  both tools, and the size *class*.
- **`REF_DELTA` emission and thin packs.** R8 bans it. Thin packs stay un-advertised on both
  the fetch and push sides; a thin-pack writer is a protocol change with its own negotiation
  surface.
- **`pack.compression`.** ADR-353 and `design/int-config-valueless-refusal.md` both put it out
  of scope deliberately; it changes emitted bytes for reasons unrelated to deltas and is
  separable. DC-7 offers it if the user wants it now.
- **`pack.windowMemory`, `pack.threads`, `pack.deltaCacheSize`, `pack.deltaCacheLimit`.** Each
  is a resource knob whose faithful behaviour needs its own pin; `MAX_DELTIFY_BYTES` covers the
  one memory hazard this change actually creates. Two of them also carry refusal shapes this
  change would have to reproduce and does not: `pack.windowMemory` **refuses** `-1`
  (`invalid unit`) where `pack.window` accepts it, and `pack.threads` refuses `-1` with
  `fatal: invalid number of threads specified (-1)`. `pack.threads` is doubly out of scope —
  tsgit's deltify pass is single-threaded by design (§6), which is also what makes it
  reproducible where git's is not (§1e).
- **`repack.useDeltaBaseOffset`.** Its default is `true` (§1f) and this design hard-codes that
  behaviour. Honouring `false` would mean emitting `REF_DELTA`, which R8 forbids; the key is
  therefore unread, and a repository setting it to `false` gets OFS anyway — a divergence worth
  recording in the ADR, and worth nothing else, since its documented purpose is compatibility
  with git older than 1.4.4.
- **Reusing existing deltas from source packs.** git's `--no-reuse-delta` inverse — carrying a
  delta chain across a repack without re-encoding it — is a large, separate optimisation that
  needs the reader to hand out raw delta payloads. This design always re-encodes from inflated
  content.
- **A bitmap or multi-pack-index writer.** Untouched; gc's only midx verb is still *delete*.
- **The streaming index pass (backlog 30.5).** Sequenced after this; §12 records the seams.
- **Object ordering by path/name hash.** Not available on the gc path (§4a). DC-3 offers it as
  a caller-supplied hint if the user wants the many-files size class closed too.
- **Retiring `MAX_DELTA_CHAIN_DEPTH` as a reader cap.** §9 clamps the *writer*; whether the
  reader's own cap should move is DC-5's second option and no wider.
