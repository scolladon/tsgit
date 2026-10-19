# Design — lift the delta-chain read cap

> Brief: GitHub #321 — every tsgit read of a packed object whose delta chain is deeper than 50
> refuses with `DELTA_CHAIN_TOO_DEEP: delta chain too deep: 51`, while git reads the same pack.
> `MAX_DELTA_CHAIN_DEPTH = 50` is git's *writer* default (`pack.depth`); git's read path has no
> depth cap. Goal: every pack git reads, tsgit reads — and every malformed chain still
> terminates, which today only the cap guarantees.
> Status: draft → self-reviewed ×3

## Context

### Where the cap binds today

`MAX_DELTA_CHAIN_DEPTH = 50` (`src/domain/storage/delta.ts:7`, doc comment: *"Matches git's own
default"*) is enforced by three delta-chain walkers and one writer clamp. Verified at `f9abe0fc`:

| Site | Symbol | What it does with the cap |
|---|---|---|
| `src/application/primitives/object-resolver.ts:796-800` | `assertChainDepthWithinCap(depth)` | throws `deltaChainTooDeep(depth)` when `depth > 50` |
| `object-resolver.ts:824-935` | `collectDeltaChain` | `for (;;)` loop over OFS hops; asserts at `:857` (cache-hit resumption: `externalDepth + depth + cached.chainDepth`) and `:886` (per level: `externalDepth + depth`) |
| `object-resolver.ts:898-930` → `:1119-1176` | REF hop → `resolveBaseForRefDelta` → `resolveObjectContentWithDepth` (`:300`) → `tryResolveViaSources` → `tryResolveViaSource` → `resolvePackChainWithDepth` (`:976`) → `collectDeltaChain` | async recursion; `externalDepth` carries the accumulated depth into the next frame |
| `src/application/primitives/read-object.ts:552-574` | `walkDeltaBaseType` (under `readObjectMetadata`) | header-only `for (;;)`; `depth += 1; assertChainDepthWithinCap(depth)`; REF hop via `nextDeltaHit` → `registry.lookup(baseId)` |
| `src/application/commands/internal/fsck/object-cache.ts:254-283` | `walkDeltaChain` (fsck stored-type recovery) | `for (let depth = 0; depth <= MAX_DELTA_CHAIN_DEPTH; …)`; exhaustion → `untypedFault(ctx, id, 'delta chain exceeds max depth')` |
| `src/domain/storage/delta-policy.ts:104` | `resolveDeltaPolicy` | writer `maxDepth: Math.min(depth, MAX_DELTA_CHAIN_DEPTH)` — `pack.depth` above 50 is silently honoured as 50 |

The receive path's indexer (`src/application/primitives/internal/index-pack.ts`) has **no** cap
(ADR-786), so tsgit already indexes packs its own resolver then refuses to read.

### Bookkeeping that exists only to serve the cap

- `DeltaBaseCacheEntry.chainDepth` (`src/application/primitives/pack-registry.ts:209-222`) — its doc
  comment says it exists so a warm cache cannot hide depth.
- `cacheDeltaBase(…, chainDepth)` (`src/application/primitives/internal/object-caches.ts:358-371`)
  stores it; `probeDeltaBaseCache` returns it.
- `Phase1Result.baseChainDepth` (`object-resolver.ts:757-790`) and the `chainDepth` arithmetic in
  `resolvePackChainWithDepth` (`:1005-1052`).
- `externalDepth: number` threaded through `resolveObjectContentWithDepth` (`:300`),
  `tryResolveViaSources` (`:378`), `tryResolveViaSource` (`:404`), `resolvePackChainWithDepth`
  (`:976`), `collectDeltaChain` (`:824`), `resolveBaseForRefDelta` (`:1119`); every return type
  carries `chainDepth`.
- `enforcePackDeltaPreApplyCap(targetId, instructions, maxBytes, depth)` (`:620`) uses `depth` only
  as `depth !== 1` (fire once per walk, on its outermost delta). That is the walk's **local**
  `depth`, not `externalDepth` — it survives the change.

### The cap is also the only terminator

The cap is not just a refusal: for two malformed shapes it is the only thing that stops the walk.

- **OFS_DELTA distance 0.** `ofsDeltaBaseOffset` (`object-resolver.ts:936-947`) refuses only
  `baseOffset < 0`; fsck's walker (`object-cache.ts:266-267`) does the same. A zero distance names
  the entry itself, so the walk revisits the same offset forever. The index pass already refuses
  this shape (ADR-785, `streaming-index-pass.md` §1f row 15) — the read path can still meet it in
  any `.idx` it did not write.
- **REF_DELTA cycles** (self-reference, A→B→A). The index pass makes them structurally
  unreachable (ADR-779/784: the walk is root-down, unresolved deltas are refused as a count), but a
  hand-built or locally corrupted `.idx` reaches the read path.

Measured (§Design 1, M6): with the cap disabled, `readObject` on a zero-distance OFS_DELTA never
returns — the worker died of `FATAL ERROR: Ineffective mark-compacts near heap limit` after
~8.5 min, because each loop iteration inflates and retains another copy of the instruction
stream.

### Prior decisions this refines

- **ADR-771** aligned both readers on 50 and clamped the writer to 50, recording the clamp as a
  knowing divergence; it says raising the ceiling "belongs to another decision record".
- **ADR-786** keeps the indexer uncapped, pinned at 50/51/100/1 000
  (`test/integration/index-pack-interop.test.ts:713-740`), and says whether the cap should bind
  readers "belongs to ADR-771's own record".
- **ADR-779** walks pass 2 with an explicit stack *because* depth is uncapped.
- **ADR-471** pins the deep-chain bench fixture at max chain 43 "because tsgit refuses deeper"
  (`test/bench/delta-chain-read.bench.ts`, `test/bench/support/fixture-generator.ts`).
- Prose that documents the gap: `docs/design/delta-writing-packer.md` §9 (`:1029-1066`) and DC-5
  (`:1175`); `docs/design/streaming-index-pass.md` §1f rows 9-10 (`:413-414`), its settled-facts
  bullet (`:435-438`), §8 row l and its paragraph (`:1179`, `:1190-1198`); user docs
  `docs/use/errors.md:59`, `docs/understand/security.md:124`,
  `docs/use/commands/maintenance.md:288-292`.

### Public surface

`DELTA_CHAIN_TOO_DEEP` is a member of the exported error-data union
(`src/domain/storage/error.ts:52`), listed in `reports/api.json` (`:49759`). `MAX_DELTA_CHAIN_DEPTH`,
`deltaChainTooDeep`, `assertChainDepthWithinCap`, `DeltaBaseCacheEntry` and
`resolveObjectContentWithDepth` are **not** in `reports/api.json` — internal. Release context:
this lands in cut 1 of `docs/BACKLOG.md` §Release order (6.0.0, whose breaking commit #322 is on
`main`), with a possible 5.0.1 hotfix carrying #321 alone.

Two pre-existing doc drifts the documentation phase will rewrite anyway: `docs/use/errors.md:59`
lists fields `depth, limit` (the variant carries only `depth`, `error.ts:52`), and
`docs/understand/security.md:124` says the cap is "configured" (it is a constant).

## Requirements

- **R1 — no depth refusal.** Any pack-resident object whose chain git reads (pinned up to 5 000
  hops written by git itself, M3) resolves through `readObject` / `readRawObject` / `readBlob` /
  `readObjectStreamed`, types through `readObjectMetadata`, and types through fsck's stored-type
  recovery — with bytes equal to `git cat-file -p`.
- **R2 — zero-distance OFS terminates.** All three walkers refuse an OFS_DELTA of distance 0 at the
  entry, in O(1) hops.
- **R3 — REF cycles terminate.** All three walkers refuse a REF_DELTA cycle (self-reference and
  longer) at the first repeated REF base, in time and memory proportional to the cycle's length,
  never to the size of the store.
- **R4 — one answer.** The three walkers accept exactly the same chains and refuse the same two
  malformed shapes; each refusal is classified by fsck's `isStoredCorruption`
  (`src/application/commands/internal/fsck/stored-corruption.ts`) as stored corruption.
- **R5 — no JS stack growth with depth.** A chain of 100 000 REF hops resolves without
  `RangeError` (pinned today, M5; must stay true).
- **R6 — writer.** `pack.depth` is honoured up to git's pack-objects ceiling (DC-5).
- **R7 — no dead code.** No residual cap constant, depth bookkeeping, factory or error variant
  survives without a reader (DC-6, DC-7).
- **R8 — separable.** The behavioural fix (Parts 1-3) lands as commits that cherry-pick onto a 5.0.x
  branch without the type-level API change (Part 6).
- **R9 — pinned.** Each behaviour in the §Design 1 matrix that CI can run deterministically is an
  interop test.

## Design

### 1. Pinned matrix (git 2.56.0 local; git 2.55.0 = CI where marked)

Method: every git subprocess with `GIT_*` scrubbed, `HOME`/`XDG_CONFIG_HOME` isolated,
`GIT_CONFIG_NOSYSTEM=1`, `-c user.name=a -c user.email=a@b -c commit.gpgsign=false
-c tag.gpgsign=false`, in `mktemp -d` throwaways. Crafted packs are `buildSyntheticPack`
(`test/unit/application/primitives/pack-fixture.ts:99`) output — `.pack` + `.idx` — dropped into a
fresh `git init --bare` repo's `objects/pack/`. tsgit rows ran on the memory adapter
(`buildSeededContext`) at `f9abe0fc`; "cap lifted" rows ran the same build with
`MAX_DELTA_CHAIN_DEPTH` replaced through `vi.mock` (a throwaway probe, not committed). Each git
call had a 20 s ceiling.

| # | Input | git | tsgit today (cap 50) | tsgit, cap lifted |
|---|---|---|---|---|
| M1 | **Issue repro**: 2 000-line file, `c0` + 100 commits each rewriting line 1; `git fast-export --all \| git fast-import --depth=100` into a bare repo | fast-import exit 0; `verify-pack -v` max `chain length = 100: 1 object`; `cat-file -p HEAD:file.txt` → `changed 100`, exit 0 — fast-import and cat-file identical on **2.56 and 2.55** (both packs verified by 2.56's `verify-pack`). The issue reports chain 99 because its history has one commit fewer | `readBlob` (Node adapter, `openRepository`) → `DELTA_CHAIN_TOO_DEEP: delta chain too deep: 51`, `data = { code, depth: 51 }` | (covered by M4) |
| M2 | `fast-import --depth=<n>` on an empty stream | `--depth=10000` → `fatal: --depth cannot exceed 8191`, exit 128 (2.56); `--depth=8192` same (2.55); `--depth=4096` and `4095` exit 0 (both) | — | — |
| M3 | 5 000 successive versions of a 2 000-line file as `blob` commands, `fast-import --depth=8191` | exit 0; `verify-pack` max **`chain length = 4999`**; `cat-file -p <deepest>` exit 0; `fsck --full` exit 0 (5 000 `dangling blob` lines + one `notice:`, no errors); pack 153 750 B (2.56 only) | `readBlob` → `DELTA_CHAIN_TOO_DEEP`, depth 51 | (covered by M4) |
| M4 | crafted linear OFS chain, depth 51 / 5 000 | `cat-file -t/-s/-p` exit 0; `fsck --full` exit 0; `cat-file --batch-all-objects --batch-check` exit 0 | 51: `readObject` and `readObjectMetadata` → `DELTA_CHAIN_TOO_DEEP` depth 51 | 5 000: `readObject` ok, 232 ms; `readObjectMetadata` ok, 7 ms |
| M5 | crafted linear REF chain in one pack, depth 51 / 5 000; plus fixed-size-content REF chains of 20 000 / 100 000 | 51 / 5 000: same as M4 | 51: refuses, depth 51 | 5 000: ok 252 ms. 20 000: ok 2.96 s, metadata 141 ms. **100 000: ok 16.5 s, metadata 645 ms, no `RangeError`** — each REF hop `await`s, so recursion costs heap, not stack |
| M6 | OFS_DELTA with **distance 0** (self) | `cat-file -t` / `-s` → `fatal: git cat-file: could not get object info`, exit 128; `-p` → `fatal: Not a valid object name <id>`, exit 128; `fsck --full` exit 1: `error: failed to validate delta base reference at offset 26 from ./objects/pack/pack-probe.pack` + `error: cannot unpack <id> from ./objects/pack/pack-probe.pack at offset 25` | `DELTA_CHAIN_TOO_DEEP` depth 51 — terminates only because of the cap, with the wrong reason | **never terminates**: heap OOM after ~8.5 min |
| M7 | OFS_DELTA whose distance equals its own offset (base at byte 0) | identical to M6 | `INVALID_PACK_INDEX`, `reason: 'offset not in pack index: corrupt index'` — `nextOffsetForEntry` admits only `.idx`-listed offsets | unchanged |
| M8 | REF_DELTA naming **its own** id | `cat-file -t`, `cat-file -p`, `fsck --full`, `cat-file --batch-all-objects --batch-check`: **no exit within 20 s** (killed; 2.56); `cat-file -s` exit 0 (size read from the delta header, no walk). `cat-file -p` RSS sampled each second for 6 s at ~90 % CPU, still running at 6 s: 2.56 ≈ 170 → 280 MB, 2.55 ≈ 266 → 648 MB | `DELTA_CHAIN_TOO_DEEP` depth 51 | not run — same loop shape as M6 |
| M9 | two REF_DELTAs naming each other | same as M8 (20 s matrix on 2.56; `cat-file -t` RSS sampling on both versions, same growth) | `DELTA_CHAIN_TOO_DEEP` depth 51 | not run |

Three settled facts:

- **git's read path has no depth cap**, and git itself writes chains past 4 095: `pack-objects`
  clamps `--depth` at 4 095 (`delta-writing-packer.md` §1c), but `fast-import` accepts up to 8 191
  (M2) and wrote a 4 999-deep chain that git reads and fscks clean (M3). Any fixed read bound below
  8 191 refuses a pack git wrote and reads.
- **git refuses zero-distance OFS on the read path** (M6) as an unreadable object — `cat-file`
  reports it the way it reports a missing object.
- **git does not terminate on a REF_DELTA cycle** (M8, M9): it spins at full CPU with growing RSS.
  There is no git behaviour to be faithful to here; any terminating answer is a divergence, and a
  library cannot hang. The divergence direction is forced — the open choice is only the refusal's
  shape (DC-3).

### 2. Termination without a cap

Claim: with the two guards below, every walk terminates, and no acyclic chain is refused.

1. **OFS runs are finite.** With distance ≥ 1 each OFS hop strictly lowers the offset, and every
   walker refuses an offset below 0 — so an OFS run is finite whatever bytes it lands on. This
   holds for fsck's walker too, which reads headers by raw `readSlice` and can land mid-entry; the
   resolver and metadata walkers are tighter still, since `nextOffsetForEntry`
   (`src/application/primitives/internal/pack-offset-table.ts:223`) refuses any offset the `.idx`
   does not list (`offset not in pack index: corrupt index`, M7).
2. **So an infinite walk takes infinitely many REF hops.** Each REF hop resolves a base by id
   against a fixed store (`registry.lookup` in the two header walkers; `tryResolveViaSources` with
   `sources: [source]` in the resolver). The continuation from an id is a pure function of the id:
   no id on the current path has been resolved yet, so neither the id-keyed `ctx.deltaCache` nor
   the offset-keyed base cache can answer for it differently the second time.
3. **The store holds finitely many ids**, so an infinite walk repeats a REF base id; and by (2) a
   repeat means the walk would loop. A walk that never repeats a REF base id is acyclic and is
   never refused.

Hence two guards suffice, in all three walkers:

- **G1 (OFS):** refuse `baseDistance === 0` at the entry (R2).
- **G2 (REF):** remember the REF base ids this walk has hopped through; refuse a hop to an id
  already remembered (R3). Detection fires at the second visit of the first repeated id — after
  at most one trip round the cycle.

Every cycle must contain a REF hop (an all-OFS cycle needs a non-decreasing offset, which G1 and
(1) rule out), so G2 only needs REF base ids — not every visited `(pack, offset)`. An OFS-only
chain — what `git repack`, `git gc` and tsgit's own writer emit (`repack.useDeltaBaseOffset`
defaults true) — never touches the set, so the hot path allocates nothing new (DC-2).

The retry-after-rescan arm (`retryOnceAfterRescan`) can swap the store mid-walk; a rescan only
fires on a *full miss*, which ends that branch of the walk rather than continuing it, so (2) holds.

### 3. The three walkers after the change

```
collectDeltaChain(ctx, store, source, hit, targetId, maxBytes, refBases)   // refBases replaces externalDepth
  for (;;)
    probe offset cache → hit: return { deltas, baseContent }               // no depth arithmetic
    base entry → return
    depth += 1                                                             // local; feeds enforcePackDeltaPreApplyCap only
    OFS: ofsDeltaBaseOffset(...)   — G1: distance 0 refused (DC-4)
    REF: G2: refBases.has(baseId) → refuse (DC-3); else add, resolveBaseForRefDelta(..., refBases)
```

- **Resolver** (`object-resolver.ts`): `externalDepth: number` becomes the walk's REF-base memory
  on the same six functions; the cap assertions at `:857` / `:886` are deleted, and so is
  `assertChainDepthWithinCap`. The memory is created at the top-level call and passed down the
  REF recursion; it is per-read (two concurrent reads never share one), so it is not shared mutable
  state. Whether it is allocated eagerly or only on the first REF hop is an implementation detail
  the plan settles under DC-2.
- **Metadata walker** (`read-object.ts:552-574`): the `depth` counter and its assertion are
  deleted; `nextDeltaHit` (`:590-603`) applies G1 through the shared `ofsDeltaBaseOffset` and G2
  through a walk-local set. It stops importing `assertChainDepthWithinCap`.
- **fsck walker** (`object-cache.ts:254-283`): `for (let depth = 0; depth <= MAX_DELTA_CHAIN_DEPTH;
  …)` becomes `for (;;)`; the OFS arm's guard widens from `baseOffset < 0` to also cover distance 0
  (same reason `'OFS_DELTA base offset out of range'`); the REF arm gains G2, returning
  `untypedFault(ctx, id, <cycle reason>)`. The trailing `'delta chain exceeds max depth'` return
  goes away with the bound.

**Error semantics.** G1 throws what the same function already throws for a negative offset —
`objectNotFound(targetId)` — under DC-4 (a). G2 throws per DC-3 (a)
`invalidPackEntry(offset, 'delta base cycle')`, where `offset` is the REF entry that would close the
cycle. Both codes are already in `CORRUPTION_CODES`, so fsck classifies them as stored corruption
without edits there (R4), and `docs/use/errors.md`'s `INVALID_PACK_ENTRY` row gains the new
reason; `typeFromEntry`'s wrapper (`object-cache.ts:240-252`) is unaffected,
since `walkDeltaChain` returns its own faults instead of throwing.

**Adjacent guards whose meaning shifts** (each walked, not assumed):

| Guard | Today | After |
|---|---|---|
| Offset-cache resumption (`:850-865`) | asserts the cap on `externalDepth + depth + cached.chainDepth` | plain resume; nothing to count |
| id-keyed `ctx.deltaCache` hit in `resolveBaseForRefDelta` (`:1129-1144`) | reports depth 0 — the documented "refuses cold, admits warm" inconsistency (test `object-resolver.test.ts:4540-4606`) | the inconsistency disappears with the cap; the hit still terminates the walk |
| `enforcePackDeltaPreApplyCap(…, depth)` (`:620`) | `depth !== 1` on the local counter | unchanged — the local counter stays |
| `CORRUPTION_CODES` (`stored-corruption.ts:15`) | lists `DELTA_CHAIN_TOO_DEEP` | entry removed with the variant in Part 6; the G1/G2 codes are already listed |
| `retryOnceAfterRescan` | never triggered by a depth refusal | never triggered by G1/G2 (thrown inside a hit, not a miss) |
| `checkAborted(ctx)` per level (`:837`) | bounded loop | the only interrupt for a legitimately deep chain — unchanged, still per level |

### 4. Writer

`resolveDeltaPolicy` (`delta-policy.ts:104`) clamps to a new named constant equal to git's
pack-objects ceiling, 4 095 (DC-5 a) — the value `delta-writing-packer.md` §1c pinned
(`warning: delta chain depth <n> is too deep, forcing 4095`, exit 0). tsgit clamps silently, as it
already does (ADR-249: no diagnostic channel for rendered text). With the readers uncapped, ADR-771's
reason for the 50 clamp — never write what the readers refuse — no longer applies, and the
remaining clamp is git's own. `MAX_DELTA_CHAIN_DEPTH` then has no reader and is deleted from
`delta.ts`. `DEFAULT_PACK_DEPTH = 50` (`delta-policy.ts:16`) stays: it is git's documented default.

### 5. Removing the depth bookkeeping (DC-7 a)

`chainDepth` leaves `DeltaBaseCacheEntry`, `cacheDeltaBase`'s parameter list, `insertLevel`,
`Phase1Result.baseChainDepth`, and every `{ chainDepth }` intersection on the resolver's return
types. `deltaBaseCacheEntrySize(content)` (`object-caches.ts`) sizes the content only, so cache
accounting does not change. `src/application/primitives/internal/deltify.ts`'s own `chainDepth`
is the writer's emission depth — a different concept — and is not touched.

### 6. Parts

Each part is one RED → GREEN → REFACTOR, one commit. Parts 1-3 are the behavioural fix and
cherry-pick onto a 5.0.x branch (R8); Part 4 is a writer behaviour change that is safe only after
Part 3 and is hotfix-optional; Part 5 is internal-only; Part 6 is the only type-level change.

**Part 1 — G1: refuse a zero-distance OFS_DELTA in all three walkers.**
- Files: `src/application/primitives/object-resolver.ts` (`ofsDeltaBaseOffset`, `:936-947`, shared
  by the resolver and `read-object.ts:598`); `src/application/commands/internal/fsck/object-cache.ts`
  (`walkDeltaChain` OFS arm, `:265-269`).
- RED: `object-resolver.test.ts` "OFS_DELTA base-offset guard" block (`:4608+`) gains a
  distance-0 case expecting `OBJECT_NOT_FOUND` (today `DELTA_CHAIN_TOO_DEEP`);
  `read-object-metadata.test.ts` the same for `readObjectMetadata`; `fsck.test.ts` beside the
  negative-offset case (`:5257`) a distance-0 tip-corrupt case expecting reason
  `'OFS_DELTA base offset out of range'`.
- Fixture: `buildSyntheticPack` / `writeSyntheticPack` with `{ kind: 'ofs-delta', baseIndex: 0,
  targetContent, distanceOverride: 0 }` (`pack-fixture.ts:51-76`); fsck's tip-corrupt arrangement
  from `fsck.test.ts:5092-5120` (`initBareCtx`, `corruptTrailingPackEntryByte`, `packFilePath`).
- Mutation trap: the existing "lands exactly on offset 0" test (`object-resolver.test.ts:4647+`)
  must stay `INVALID_PACK_INDEX`; G1 is `baseDistance === 0`, not `baseOffset <= 0`.

**Part 2 — G2: refuse a REF_DELTA cycle in all three walkers.**
- Files: `object-resolver.ts` (`collectDeltaChain` REF arm `:898-930`; add the walk memory as a
  parameter next to `externalDepth` on `resolveObjectContentWithDepth`, `tryResolveViaSources`,
  `tryResolveViaSource`, `resolvePackChainWithDepth`, `collectDeltaChain`,
  `resolveBaseForRefDelta` — Part 5 then deletes `externalDepth`, leaving the memory in its
  place); `read-object.ts` (`walkDeltaBaseType` / `nextDeltaHit`);
  `object-cache.ts` (`walkDeltaChain` REF arm).
- RED (cap still at 50, so each RED fails on today's `DELTA_CHAIN_TOO_DEEP`): self-reference and
  2-cycle for `resolveObject`, `readObjectMetadata`, and fsck stored-type recovery.
- Fixture: REF entries carry `baseId` as a free string (`pack-fixture.ts:78-85`), so a cycle is
  `[{ kind: 'ref-delta', baseId: id(T2), baseUncompressed: T2, targetContent: T1 },
  { kind: 'ref-delta', baseId: id(T1), baseUncompressed: T1, targetContent: T2 }]`, ids computed
  as `hash('blob <len>\0' + T)` before the build (REF entries resolve as `blob`,
  `pack-fixture.ts:409-415`).
- Memory hint: arrange so G2 is the **only** thing that can stop the walk — a REF cycle whose
  members are also reachable by an OFS path proves nothing about G2.

**Part 3 — lift the read cap.**
- Files: `object-resolver.ts` (delete the `:857` / `:886` assertions,
  `assertChainDepthWithinCap`, and the `:31` / `:33` imports of `MAX_DELTA_CHAIN_DEPTH` /
  `deltaChainTooDeep`); `read-object.ts` (delete the counter and import);
  `object-cache.ts` (`for (;;)`, delete the exhaustion return and the `MAX_DELTA_CHAIN_DEPTH`
  import); `src/domain/storage/error.ts` (delete the `deltaChainTooDeep` factory — its last caller
  is gone; the union variant stays until Part 6 so the 5.0.x branch keeps its type surface).
- RED: the refusal pins flip to acceptance —
  `object-resolver.test.ts:4048-4606` (length-51 refusal; cache-warmed 51/60 variants; REF-hop
  cumulative refusals asserting depth 51/54/56; the cold-refuses/warm-admits pair at `:4540`) become
  "resolves with the right bytes" at depths past 50, collapsing the variants that only existed to
  probe depth accounting (DC-7); `:3425-3460` "exactly 50 (at cap)" loses its `>=`-mutant rationale;
  `read-object-metadata.test.ts:365-395` flips to a typed answer; `fsck.test.ts:5120-5165` (51 →
  `'delta chain exceeds max depth'`) flips to `blob`; `test/unit/domain/storage/error.test.ts:77`
  (factory) is deleted.
- Add a deep non-regression: a 5 000-hop OFS chain and a 5 000-hop REF chain (the
  `buildOfsChain` shape at `test/integration/index-pack-interop.test.ts:189-200`, REF variant as in
  Part 2) resolving to the expected bytes — the unit-level observable the mutation gate can see
  (`vitest.stryker.config.ts` includes only `test/unit/**`).

**Part 4 — writer clamp to 4 095.**
- Files: `src/domain/storage/delta-policy.ts` (`:8` import, `:104`); `src/domain/storage/delta.ts`
  (delete `MAX_DELTA_CHAIN_DEPTH`, `:3-7`).
- RED: `test/unit/domain/storage/delta-policy.test.ts:421-433` (`depth = 250` → 50) flips to 250;
  add `4095 → 4095` and `4096 → 4095` boundary cases. `test/unit/domain/storage/delta.test.ts:746-760`
  (constant equals 50) is deleted.

**Part 5 — delete the depth bookkeeping.**
- Files: `pack-registry.ts:209-222` (`DeltaBaseCacheEntry.chainDepth`); `object-caches.ts:314`,
  `:358-371` (`cacheDeltaBase` parameter); `object-resolver.ts` (`Phase1Result.baseChainDepth`,
  `externalDepth`, every `chainDepth` return field, `insertLevel`'s third parameter, the
  `:1034-1041` arithmetic, and the doc comments at `:285-299`, `:755-790`, `:967-975`, `:1129-1148`
  that explain the cap).
- Tests: `test/unit/application/primitives/internal/object-caches.test.ts:73,100` and
  `test/unit/application/primitives/pack-registry.test.ts:7558` drop `chainDepth: 0` from their
  literals. A pure refactor under the Part 3 suite: no new RED, the type checker is the gate.

**Part 6 — remove the `DELTA_CHAIN_TOO_DEEP` variant (6.0.0 only).**
- Files: `src/domain/storage/error.ts:52`; `src/domain/error.ts:366` (message arm);
  `stored-corruption.ts:15`; `test/unit/domain/exhaustiveness.ts:62`;
  `test/unit/domain/error.test.ts:546-560`; `reports/api.json` regenerated (`npm run
  check:doc-typedoc` diff on pre-push); `docs/use/errors.md:59`, `docs/understand/security.md:124`.
- `feat!`/`fix!` commit marker per the repo's release conventions — the variant is public.

**Part 7 — interop pins** (new `test/integration/delta-chain-depth-interop.test.ts`, plus the
index-pack extension). See §Test strategy.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | **Read-path depth cap** (binds all three walkers) | (a) **None** — termination by G1 + G2 (§2). (b) **Hard bound at 8 191** (`fast-import`'s maximum, M2) as defence in depth on top of G1 + G2. (c) **Keep 50, add a knob** (an option or config key) as the issue suggests. | **(a)** | git reads any depth (M3, M4); §2 proves G1 + G2 terminate every walk, so a bound would only refuse well-formed packs. The brief's 4 095 bound is refuted by M3: git wrote and reads a 4 999-deep chain. (b) is the smallest bound no pinned git writer exceeds, but it refuses packs `index-pack` accepts (ADR-786 pinned 1 000; nothing stops other writers going deeper) — a knowing divergence that buys nothing G2 does not already give. (c) keeps the defect as the default; git has no such key, and a tsgit-only knob whose only use is to undo a refusal git never makes is the shape ADR-226 forbids. |
| DC-2 | **How G2 remembers REF bases** | (a) **Per-walk set of REF base ids**, created lazily on the first REF hop, passed down the recursion in place of `externalDepth`. (b) **Hop counter bounded by the store's total entry count** (Σ `objectCount`) — no set, keeps `externalDepth`'s plumbing. (c) **Per-walk set of every visited `(pack instance, offset)`**, OFS hops included. | **(a)** | §2 shows a cycle must contain a REF hop, so REF base ids are enough; OFS-only chains — the norm, git's and tsgit's writers both emit OFS — allocate nothing. (b) adds no allocation but detects a 2-cycle only after Σ entries hops, each one inflating and keeping an instruction stream — in a large repo that is the M6 OOM again, just bounded. (c) is correct but pays a set insertion per OFS level on every read of the hottest path, to catch cycles G1 already makes impossible. |
| DC-3 | **What a REF cycle refuses with** (git hangs, M8/M9 — any answer is a divergence) | (a) **`INVALID_PACK_ENTRY { offset, reason: 'delta base cycle' }`** via the existing `invalidPackEntry`; fsck reason `'delta chain cycle'`. (b) **A new variant** `DELTA_BASE_CYCLE { id }`. (c) **Repurpose `DELTA_CHAIN_TOO_DEEP`** for the cycle. | **(a)** | It is the existing structured code for "this pack entry is unusable", already in `CORRUPTION_CODES`, and needs no API change — so it ships unchanged on a 5.0.x branch. (b) is more precise for a caller that wants to branch on cycles specifically, but adds a public variant for a shape only a hand-built `.idx` produces (the index pass refuses cycles at fetch, ADR-784). (c) keeps a name that says "too deep" for a walk that is not deep, and a `depth` field with no meaning. |
| DC-4 | **What a zero-distance OFS_DELTA refuses with** | (a) **`OBJECT_NOT_FOUND`** — widen `ofsDeltaBaseOffset`, which already throws it for a negative offset. (b) **`INVALID_PACK_ENTRY` with `'delta base offset is out of bound'`** — the wording ADR-785 adopted for the index pass. | **(a)** | git's read path answers M6 the way it answers a missing object (`could not get object info` / `Not a valid object name`), and one function keeps one refusal for "base offset not usable". Cost, shared with today's negative-offset arm: on a partial clone `withLazyFetchRetry` (`read-object.ts:140-165`) treats it as a miss and attempts one lazy fetch before rethrowing. (b) avoids that fetch and aligns the read path's wording with the indexer's, but the indexer's wording comes from `git index-pack`, which is a different git surface from the one this path mirrors. |
| DC-5 | **Writer clamp** (`delta-policy.ts:104`) | (a) **Clamp at 4 095**, git's pack-objects ceiling, silently. (b) **Leave at 50.** | **(a)** | ADR-771 clamped to 50 only so the writer never wrote what the readers refused; with the readers uncapped that reason is gone, and 4 095 is git's own clamp — closing ADR-771's recorded divergence. (b) keeps a divergence that no longer protects anything; the default `pack.depth = 50` is identical under both. |
| DC-6 | **The `DELTA_CHAIN_TOO_DEEP` variant** | (a) **Remove it in 6.0.0** (Part 6), keeping it type-only on a 5.0.x hotfix. (b) **Keep it as a never-thrown type.** (c) **Repurpose it** (= DC-3 c). | **(a)** | Nothing throws it once Part 3 lands; a public error variant no code path produces tells consumers to handle a case that cannot occur, which the house style treats as dead code. The 6.0.0 cut is already breaking (#322), so the removal costs nothing extra now and a major later. (b) is the zero-churn answer, and the only honest one *for the hotfix branch*. |
| DC-7 | **The depth bookkeeping** (`externalDepth`, `chainDepth`, `baseChainDepth`, `DeltaBaseCacheEntry.chainDepth`) | (a) **Delete it in this change** (Part 5), internal only. (b) **Leave it** — computed, never read. | **(a)** | Its sole reader is the cap; left in place it is dead code with doc comments explaining a guarantee that no longer exists. All of it is internal (absent from `reports/api.json`), so deleting it is not an API change and does not block a hotfix. (b) shrinks the diff by ~150 lines and nothing else. |
| DC-8 | **ADR-471's bench fixture** (max chain 43, "tsgit refuses deeper") | (a) **Keep the fixture**; the superseding record notes its rationale is now "a realistic default-packed repo". (b) **Add a deep scenario** (e.g. `fast-import --depth=1000`) beside it. | **(a)** | The fixture measures what `git gc` produces at defaults, which is still the case that matters; only its stated reason changes. (b) measures a shape rare in practice and adds bench runtime; worth doing if a deep-chain perf complaint arrives, not before (no measurement says it is needed). |

## Test strategy

**Unit** (the mutation gate's view — `vitest.stryker.config.ts` includes only `test/unit/**`): every
guard has its own isolated RED (Parts 1-4). Per guard, the fixture is arranged so that guard is
the only thing that can stop the walk: G1 tests use a pack with no REF entries; G2 tests use REF
cycles whose members no OFS chain reaches; the acceptance tests use chains past 50 with no cycle and
no zero distance. Error assertions read `.data` through try/catch (`code`, `offset`, `reason`), never
`toThrow(Class)`.

Edge matrix, each across the three walkers:

| Case | Expected |
|---|---|
| OFS chain 51, 5 000 | resolves; bytes equal the fixture's target |
| REF chain 51, 5 000 | resolves |
| OFS → REF → OFS mixed chain past 50 | resolves |
| warm offset cache mid-chain, chain past 50 | resolves (the warm-cache refusal tests collapse into this) |
| OFS distance 0 | DC-4 refusal; fsck `'OFS_DELTA base offset out of range'` |
| OFS distance = own offset | `INVALID_PACK_INDEX` (unchanged, M7) |
| REF self-reference | DC-3 refusal; fsck cycle reason |
| REF 2-cycle | DC-3 refusal |
| REF cycle entered after an OFS run | DC-3 refusal |
| REF chain whose base id is also stored in a second pack | resolves — the lookup is deterministic, so an acyclic walk never repeats a REF base id however many copies exist |
| `pack.depth` 250 / 4 095 / 4 096 | `maxDepth` 250 / 4 095 / 4 095 |

**Interop** (`test/integration/delta-chain-depth-interop.test.ts`, new; isolation via
`runGitEnv()` / `tryRunGitWithExit` from `test/integration/interop-helpers.ts`):

1. **Issue repro (M1)** — build the repo through one `git fast-import --depth=100` stream (the
   fast-import idiom `index-pack-interop.test.ts` already uses for Fixture A, so no 100× `git
   commit`); assert `verify-pack -v` reports a chain > 50, then `readBlob` bytes equal `git cat-file
   -p HEAD:file.txt` bytes.
2. **Past git's pack-objects ceiling (M3)** — a `blob`-only fast-import stream at `--depth=8191`,
   ~4 200 versions (the smallest count that clears 4 095) — M3 used a 2 000-line file; the plan
   pins the smallest file for which `fast-import` still deltifies every version (not measured here)
   and its CI runtime before fixing the count; `verify-pack` max chain > 4 095; tsgit read equals `git cat-file -p`.
3. **Zero distance (M6)** — crafted pack; `git cat-file -t` exit 128, tsgit DC-4 refusal.
4. **`index-pack-interop.test.ts:713-740`** — the `describe.each([50, 51, 1000])` block keeps its
   `index-pack` assertion and adds: install pack + `.idx` in a bare repo, read the tip through
   tsgit's resolver, compare with `git cat-file -p`. Its comment about the "pre-existing gap" goes.
5. **Writer (Part 4)** — `test/integration/delta-pack-interop.test.ts` (`:373` runs
   `pack.depth=50`): add a `pack.depth=100` run over the same churn fixture; assert tsgit's pack
   has a chain > 50 and ≤ 100 (`verify-pack -v`), and passes `git fsck --full` and
   `git index-pack --strict`.

REF cycles (M8, M9) are **not** pinned against git in CI: git's answer is a hang, and asserting a
hang means spending a timeout per case on every CI run. This document is the record of that
behaviour; tsgit's side is pinned by unit tests.

**Bench**: no bench change (DC-8). The resolver's hot path loses arithmetic and a field and gains
nothing on OFS-only chains (DC-2 a), so no regression is expected; the plan runs `bench:ab` on
`delta-chain-read` after Part 5 to confirm.

**Property tests**: none — no parser, decoder or serializer is added or changed.

## Out of scope

- **OFS distance equal to the entry's own offset** (M7): tsgit refuses with `INVALID_PACK_INDEX`
  where git reports an unreadable object; pre-existing, already pinned at
  `object-resolver.test.ts:4647+`, and not a termination issue.
- **git's failover to another copy of a bad delta's object** (git marks the entry bad and retries
  other packs): not pinned here; the same gap already exists for a negative OFS offset.
- **`readDeclaredObjectSize` on a cycle**: `git cat-file -s` answers from the delta header without
  walking (M8); tsgit's size-only path is not touched by this change.
- **A diagnostic for the writer clamp**: git prints `warning: … forcing 4095`; tsgit stays silent
  per ADR-249, as it already does at 50.
- **Rewriting ADRs 771/786/471 and the prose in `delta-writing-packer.md` §9 / DC-5 and
  `streaming-index-pass.md` §1f / §8 row l**: the ADR phase records the superseding decision; the
  documentation phase updates those files and the three user docs named in Context.
