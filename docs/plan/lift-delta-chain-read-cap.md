# Plan — lift the delta-chain read cap

> Source: design doc `docs/design/lift-delta-chain-read-cap.md` · ADRs 1019, 1020, 1021, 1022, 1023, 1024, 1025, 1026
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

<!-- cspell:ignore backticked deltify deltifies deltified mktemp fsck fscks idx OFS oids reprepare unpushed respawn worktree -->

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.
- A part should land in ~100 tool calls. More than ~5 RED→GREEN cycles, or more than 6
  files in its `### Context` block, is two parts. What counts is a backticked path:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## How this plan maps the design

The design's seven parts become nine: its Part 2 (G2) and Part 3 (lift) each edit more than six
files, so each is split into a resolver part and a header-walker part; its Part 5 (bookkeeping)
splits into the threaded `externalDepth` and the cached `chainDepth`; its Part 7 (interop pins) is
folded into the parts whose behaviour each pin proves (no test-only part).

| Part | Design part | Commit subject | Kind | Est. |
|---|---|---|---|---|
| 1 | P1 + pin 3 | `fix(pack): refuse an OFS_DELTA whose base distance is zero` | fix (G1, 3 walkers) | ~700 s |
| 2 | P2 (resolver) | `fix(object-resolver): refuse a REF_DELTA cycle instead of walking it` | fix (G2) | ~900 s |
| 3 | P2 (header walkers) | `fix(pack): refuse a REF_DELTA cycle in the header-only type walks` | fix (G2) | ~700 s |
| 4 | P3 (header walkers) | `fix(pack): type delta chains of any depth in readObjectMetadata and fsck` | fix (lift) | ~700 s |
| 5 | P3 (resolver) + pins 1, 2, 4 | `fix(object-resolver): read delta chains of any depth, as git does` | fix (lift) | ~1500 s |
| 6 | P4 + pin 5 | `fix(pack): honour pack.depth up to git's 4095 ceiling` | fix (writer) | ~900 s |
| 7 | P5 (externalDepth) | `refactor(object-resolver): stop threading a chain depth through REF_DELTA hops` | refactor | ~700 s |
| 8 | P5 (chainDepth) | `refactor(pack-registry): drop the chain depth from delta-base cache entries` | refactor | ~700 s |
| 9 | P6 | `fix(pack)!: remove the DELTA_CHAIN_TOO_DEEP error, which no read raises` | breaking (type) | ~500 s |

Requirement map: R1 → Parts 4, 5 (unit 51 / 5 000 hops per walker, pins 1, 2, 4); R2 → Part 1;
R3 → Parts 2, 3; R4 → Parts 1–4 (same fixtures, same refusals, fsck routing through
`CORRUPTION_CODES` unchanged); R5 → Part 5's 5 000-hop REF unit test (each hop awaits, so depth
costs heap, not stack; M5 measured 100 000 hops at 16.5 s, too slow for the unit suite);
R6 → Part 6; R7 → Parts 5, 6, 7, 8, 9; R8 → commit order below; R9 → pins 1–5 (Parts 1, 5, 6).

**Commit order is load-bearing (R8, ADR-1024).** Parts 1–5 are the behavioural fix and
cherry-pick onto a 5.0.x branch as-is: none of them touches the error union, the writer, or
`reports/api.json`, and on 5.0.x `MAX_DELTA_CHAIN_DEPTH` keeps its writer reader. Part 6 is
hotfix-optional and safe only after Part 5. Parts 7–8 are internal refactors. Part 9 is the
last commit and the only one carrying `!`.

Files shared by several parts (plan-lint's overlap warnings) and why they stay separate:

- object-resolver.ts and object-resolver.test.ts (Parts 1, 2, 5, 7, 8): G1, G2, the lift, and two
  independent deletions; each is one behaviour and its own commit, and the order is load-bearing.
- read-object.ts, object-cache.ts, read-object-metadata.test.ts, fsck.test.ts (Parts 1, 3, 4):
  G1, G2 and the lift are three refusal/acceptance behaviours that must land in R8's order.
- pack-fixture.ts (Parts 2, 4): each helper lands with its first caller.
- delta-chain-depth-interop.test.ts (Parts 1, 5): created with pin 3, extended with pins 1, 2, 4.
- storage error.ts (Parts 5, 9): the factory leaves with its last caller (5.0.x-safe); the variant
  leaves in the breaking commit.

## Public-vs-internal, decided up front

| New symbol | Part | Verdict | Gates |
|---|---|---|---|
| `enterRefBase` (function, src/application/primitives/object-resolver.ts) | 2 | internal — exported only so read-object.ts reuses it, as `ofsDeltaBaseOffset` already is. object-resolver.ts is on no barrel and absent from reports/api.json | none |
| `DELTA_BASE_CYCLE_REASON` (const, module-local in object-resolver.ts) | 2 | internal, not exported | none |
| `MAX_PACK_DEPTH` (const, module-local in src/domain/storage/delta-policy.ts) | 6 | internal, not exported (the storage barrel exports only `NO_RECENCY` from delta-policy.ts) | none |
| `syntheticBlobId`, `ofsChainSpecs`, `refChainSpecs`, `ChainSpec` (test helpers in test/unit/application/primitives/pack-fixture.ts) | 2, 4 | test-only | none (knip's project is `src/**`) |

Removed public surface: only the `DELTA_CHAIN_TOO_DEEP` member of the exported error-data union
(Part 9) → reports/api.json is regenerated in that commit (prepush `check:doc-typedoc`). The
factory `deltaChainTooDeep`, `MAX_DELTA_CHAIN_DEPTH`, `assertChainDepthWithinCap`,
`DeltaBaseCacheEntry.chainDepth` and `resolveObjectContentWithDepth`'s parameters are absent from
reports/api.json (verified: only `"value": "DELTA_CHAIN_TOO_DEEP"` at api.json:49759) — removing
them changes no surface gate.

## Repo-wide facts every part needs

- **Working tree:** the worktree root. Implementers have no MCP tools: use Read/Grep/Edit; the
  line numbers below were verified on this branch (only docs commits landed after `f9abe0fc`).
  After an earlier part lands, re-grep the symbol rather than trusting a line number.
- **Test conventions:** `describe('Given …')` > `describe('When …')` > `it('Then …')`; AAA comments;
  the system under test is `sut` where a function is bound (`const sut = resolveObject;` is fine).
  Error assertions go through try/catch and read `.data` (`code`, `id`, `offset`, `reason`) —
  never `toThrow(Class)` alone; after an `expect(data.code).toBe(X)` narrow with
  `if (data.code !== X) expect.fail(...)` before reading variant fields (house pattern at
  object-resolver.test.ts:4636-4641). No phase/ADR/backlog numbers in source or test text.
  No suppression comments of any kind. **One RED per function, run (and seen failing for the
  stated reason) before writing its code.**
- **Guard isolation:** every guard's fixture must make that guard the ONLY thing that can stop the
  walk: G1 fixtures carry no REF entry; G2 fixtures carry no zero distance and no OFS path into a
  cycle member except where the row says "entered after an OFS run"; acceptance fixtures carry no
  cycle and no zero distance.
- **Fixtures (read-only unless a part says otherwise):** test/unit/application/primitives/pack-fixture.ts —
  `buildSyntheticPack(ctx, entries)` returns `{ packBytes, idxBytes, ids, offsets }`;
  `writeSyntheticPack(ctx, name, entries)` writes `.git/objects/pack/pack-<name>.{pack,idx}` and
  returns `ids`. Entry specs: `{ kind: 'base', type, content }`,
  `{ kind: 'ofs-delta', baseIndex, targetContent, distanceOverride? }`,
  `{ kind: 'ref-delta', baseId, baseUncompressed, targetContent }`. A REF entry's id is the blob id
  of its `targetContent` (REF entries always resolve as `blob`, pack-fixture.ts:409-415), so a
  cycle needs ids computed BEFORE the build (Part 2 adds `syntheticBlobId`). Deltas are insert-only
  (`encodeDeltaFromScratch`), so the base bytes only set the declared source length.
  test/unit/application/primitives/fixtures.ts: `buildSeededContext()`. Resolver test helpers
  (object-resolver.test.ts): `soleSourceStore(ctx, registry)`, `createPackRegistry(ctx)`,
  `ENC` (TextEncoder), `stubRegistry`, `writeRawSingleEntryPack`.
  fsck.test.ts: `initBareCtx()` (L123), `packFilePath(ctx, name)` (L3072),
  `corruptTrailingPackEntryByte(ctx, path)` (L4729 — flips the last entry's final zlib byte, so the
  tip's first read decode-faults and fsck's header-only recovery walk runs), `withWarnLog(ctx)`
  (L4756 → `{ ctx, calls }`; the recovery degrade logs message `'fsck: stored type probe degraded'`
  with `context.reason`).
- **fsck routing:** a read that fails with any `CORRUPTION_CODES` code
  (src/application/commands/internal/fsck/stored-corruption.ts — `INVALID_PACK_ENTRY`,
  `OBJECT_NOT_FOUND` and `DELTA_CHAIN_TOO_DEEP` are all listed) sends a packed, non-loose object to
  `packedStoredType` → `typeFromEntry` → `walkDeltaChain` (object-cache.ts:240-283). No loose copy
  is needed to reach the walker. The dangling finding's `objectType` is `'unknown'` when the walker
  returns `untypedFault`.
- **Interop:** test/integration/interop-helpers.ts — `runGit(args, { input? })` (string out),
  `runGitBytes(args)` (bytes out), `tryRunGitWithExit(args)` (`{ stdout, stderr, exitCode }`),
  `runGitEnv()` (scrubbed `GIT_*`, isolated HOME/XDG, `GIT_CONFIG_NOSYSTEM`, signing off),
  `GIT_AVAILABLE`. tsgit on a bare dir: `createNodeContext({ workDir: dir, gitDir: dir, bare: true })`
  from src/adapters/node/node-adapter.js; reads via `readObject`, `readObjectMetadata`,
  `disposePackRegistry` (src/application/primitives/read-object.js) and `readBlob`
  (src/application/primitives/read-blob.js). Always `await disposePackRegistry(ctx)` in `finally`.
  Fast-import idiom: test/integration/index-pack-interop.test.ts:121-140 (`runFastImport`, stream
  file piped through a real fd with `runGitEnv()`). CI runs git 2.55, local is 2.56; every interop
  expectation below was measured on both. REF cycles are NOT pinned against git (git hangs).
- **Gates:** part gate = `npx vitest run <touched-tests> && npm run check:types &&
  ./node_modules/.bin/biome check <touched-files> && npm run check:spelling`. wireit caches
  `check:types` / `check:spelling`; when a cached replay is possible, run
  `npx tsc --noEmit -p tsconfig.typecheck.json` and `npx cspell --no-progress <touched-files>`
  instead. Phase gate: `npm run validate` (includes `check:size` / `check:tarball`, which have
  <100 B headroom on some rows: this change removes code, so a red size row means stale dist —
  `rm -rf dist .wireit` and re-run before believing it).
- **Mutation:** `vitest.stryker.config.ts` includes only `test/unit/**` — every behaviour below has
  a unit observable; interop pins are additive. Mutants that disable G1 or G2 turn their tests into
  non-terminating walks and surface as Stryker `Timeout` (detected); triage belongs to validation.

## Part 1 — G1: refuse a zero-distance OFS_DELTA in all three walkers

### Context

Design §2 (G1), §3, matrix M6/M7; ADR-1022. Today a distance-0 OFS_DELTA names its own offset, so
every walker revisits it until the 50 cap fires (`DELTA_CHAIN_TOO_DEEP`, depth 51); with the cap
gone it never terminates (M6: heap OOM). git: `cat-file -t`/`-p` exit 128 (2.55 and 2.56).

Files (edit / create):
- `src/application/primitives/object-resolver.ts` — `ofsDeltaBaseOffset(targetId, entryOffset, baseDistance)`
  (L940-947), shared by `collectDeltaChain` (L890) and read-object.ts `nextDeltaHit` (L598).
  Today: `const baseOffset = entryOffset - baseDistance; if (baseOffset < 0) throw objectNotFound(targetId);`.
  Update its doc comment ("never forward, never itself, and never off the front of the pack").
- `src/application/commands/internal/fsck/object-cache.ts` — `walkDeltaChain` OFS arm (L265-269):
  `if (baseOffset < 0) return untypedFault(ctx, id, 'OFS_DELTA base offset out of range');`.
- `test/unit/application/primitives/object-resolver.test.ts` — add to the `'OFS_DELTA base-offset guard'`
  block (L4608), beside the negative-offset and lands-on-offset-0 cases.
- `test/unit/application/primitives/read-object-metadata.test.ts` — new describe after the
  `'Given an OFS_DELTA chain of length 51'` block (L365-394).
- `test/unit/application/commands/fsck.test.ts` — new describe after
  `'Given a packed OFS_DELTA whose base distance points before the pack body…'` (L5223-5257).
- `test/integration/delta-chain-depth-interop.test.ts` — CREATE (pin 3). Imports:
  `buildSyntheticPack` from ../unit/application/primitives/pack-fixture.js (index-pack-interop.test.ts
  already crosses that boundary), helpers listed under Repo-wide facts. Top-level
  `describe.skipIf(!GIT_AVAILABLE)('delta chain depth interop', …)`. A local
  `installCraftedPack(packBytes, idxBytes)` helper: `mkdtemp` under `os.tmpdir()`,
  `runGit(['init', '-q', '--bare', '-b', 'main', dir])`, write the pack and index as
  objects/pack/pack-crafted.pack and .idx under it, return `{ dir, dispose }` (`rm -rf` in `finally`).

Mutation traps already pinned (must stay green): resolver "lands exactly on offset 0" →
`INVALID_PACK_INDEX` (L4647+), fsck "lands exactly on offset 0" → reason `'pack entry unreadable'`
(L5259+). So G1 is `baseDistance === 0`, never `baseOffset <= 0`.

### TDD steps

Shared fixture for every unit RED here (no REF entry, so only G1 can stop the walk):
`[{ kind: 'base', type: 'blob', content: ENC.encode('zero-distance base') }, { kind: 'ofs-delta', baseIndex: 0, targetContent: ENC.encode('zero-distance target'), distanceOverride: 0 }]`;
the delta's id is `ids[1]`.

1. RED (resolver) — Given that pack written with `writeSyntheticPack`, When `resolveObject(ctx, soleSourceStore(ctx, registry), ids[1], false)`,
   Then `data.code === 'OBJECT_NOT_FOUND'` and `data.id === ids[1]`. Fails today: `DELTA_CHAIN_TOO_DEEP`
   (depth 51) — the walk revisits the entry until the cap.
2. RED (metadata) — same pack, When `readObjectMetadata(ctx, ids[1])`, Then `OBJECT_NOT_FOUND` with
   `id === ids[1]`. Fails today: `DELTA_CHAIN_TOO_DEEP` depth 51 (`walkDeltaBaseType`'s counter).
3. GREEN — in `ofsDeltaBaseOffset`: `if (baseDistance === 0 || baseOffset < 0) throw objectNotFound(targetId);`
   (one refusal for "base offset not usable"; the zero check names the concept, no new constant
   needed). Steps 1 and 2 pass; the two offset-0 traps and the negative-offset tests stay green.
4. RED (fsck) — Given `initBareCtx()` and the same pack via `writeSyntheticPack`, wrapped with
   `withWarnLog`, When `fsck(logged, { connectivityOnly: true })`, Then the dangling finding for
   `ids[1]` has `objectType: 'unknown'` and the warn for it has `message === 'fsck: stored type probe degraded'`,
   `context.reason === 'OFS_DELTA base offset out of range'`. Fails today: reason
   `'delta chain exceeds max depth'` — fsck's own walker loops on the self-offset until its bound.
5. GREEN — in `walkDeltaChain`'s OFS arm: `if (header.baseDistance === 0 || baseOffset < 0) return untypedFault(…same reason…)`.
6. GUARD (interop, pin 3) — Given `buildSyntheticPack(createMemoryContext(), sameEntries)` installed
   with `installCraftedPack`, When git and tsgit read `ids[1]`, Then
   `tryRunGitWithExit(['-C', dir, 'cat-file', '-t', ids[1]]).exitCode === 128`, the same for `-p`,
   `cat-file -t ids[0]` exits 0 with stdout `blob\n` (the pack is otherwise sound), and tsgit
   `readObject(ctx, ids[1])` rejects with `data.code === 'OBJECT_NOT_FOUND'`, `data.id === ids[1]`.
   Passes after step 3 (measured: git 2.55 and 2.56 both exit 128 for `-t` and `-p`).
7. REFACTOR — `walkDeltaChain` is already 30 lines (L254-283): extract the OFS arm into
   `followOfsBase(ctx, id, hit, header)` returning `PackLookupHit | TypedOrUntyped` (discriminate
   with `'kind' in next`), so the loop body only dispatches. Behaviour unchanged; gate green.

### Gate

~~~
npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/commands/fsck.test.ts test/integration/delta-chain-depth-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts src/application/commands/internal/fsck/object-cache.ts test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/commands/fsck.test.ts test/integration/delta-chain-depth-interop.test.ts && npm run check:spelling
~~~

### Commit

`fix(pack): refuse an OFS_DELTA whose base distance is zero`

## Part 2 — G2 in the resolver: refuse a REF_DELTA cycle

### Context

Design §2 (G2), §3; ADR-1020 (per-walk set of REF base ids, created on the first REF hop, passed
down the REF recursion), ADR-1021 (`invalidPackEntry(offset, 'delta base cycle')`, `offset` = the
REF_DELTA entry that would close the cycle). The cap still exists in this part, so every RED fails
on `DELTA_CHAIN_TOO_DEEP`.

Files (edit):
- `src/application/primitives/object-resolver.ts`:
  - Add, next to `ofsDeltaBaseOffset` (L936-947), the module-local
    `const DELTA_BASE_CYCLE_REASON = 'delta base cycle';` and
    `export function enterRefBase(walked: Set<ObjectId> | undefined, baseId: ObjectId, entryOffset: number): Set<ObjectId>`:
    throws `invalidPackEntry(entryOffset, DELTA_BASE_CYCLE_REASON)` when `walked?.has(baseId)`,
    otherwise returns `(walked ?? new Set<ObjectId>()).add(baseId)`. Doc comment says why: a cycle
    must contain a REF hop (G1 makes OFS runs strictly decreasing), so REF base ids alone detect
    it; the set is per read, never shared; exported so read-object.ts's header walk reuses it.
    `invalidPackEntry` is already imported (L34).
  - Thread `refBases: Set<ObjectId> | undefined` through the REF recursion, next to `externalDepth`:
    `resolveObjectContentWithDepth` (L300 — add as a TRAILING optional parameter after
    `mode: LooseReadMode = 'buffered'`, see PC-1, so its 35 test call sites and 4 src callers are
    untouched), `tryResolveViaSources` (L378, also its two calls at L333 and L340),
    `tryResolveViaSource` (L404), `resolvePackChainWithDepth` (L976), `collectDeltaChain` (L824),
    `resolveBaseForRefDelta` (L1119). `resolvePackChain` (L948) passes `undefined` (it is a
    walk's top: blob-source.ts:645 and fsck verify-pack.ts:92 call it).
  - REF arm of `collectDeltaChain` (L897-930): first `const walked = enterRefBase(refBases, header.baseId, currentHit.offset);`,
    then the existing push and `resolveBaseForRefDelta(…, externalDepth + depth, walked)`.
    `resolveBaseForRefDelta` passes it on:
    `resolveObjectContentWithDepth(ctx, { ...store, sources: [source] }, baseId, false, maxBytes, externalDepth, 'buffered', refBases)`.
    The id-keyed `ctx.deltaCache` shortcut (L1129-1144) is unchanged: a hit ends the walk.
- `test/unit/application/primitives/pack-fixture.ts` — add
  `export async function syntheticBlobId(ctx: Context, content: Uint8Array): Promise<string>` =
  `ctx.hash.hashHex(prependObjectHeader(content, 'blob'))` (`prependObjectHeader` is module-private
  at L417; reuse it). Doc: the id a REF entry with this `targetContent` will get.
- `test/unit/application/primitives/object-resolver.test.ts` — new sibling describes right before
  `'OFS_DELTA base-offset guard'` (L4608).

### TDD steps

Fixture shapes (T, X, Y, Z are distinct `ENC.encode('…')` contents; `idOf = (c) => syntheticBlobId(ctx, c)`;
use `buildSyntheticPack` then write `.pack`/`.idx` under `${ctx.layout.gitDir}/objects/pack/pack-<name>.*`
with `ctx.fs.write` — the pattern at read-object-metadata.test.ts:334-344 — so `offsets` is known):
- self: `[{ kind: 'ref-delta', baseId: await idOf(T), baseUncompressed: T, targetContent: T }]` → `ids[0] === idOf(T)`.
- 2-cycle: `[{ ref-delta baseId: idOf(Y), baseUncompressed: Y, targetContent: X }, { ref-delta baseId: idOf(X), baseUncompressed: X, targetContent: Y }]`.
- after an OFS run: the 2-cycle plus `{ kind: 'ofs-delta', baseIndex: 0, targetContent: Z }` as entry 2.

1. RED — Given the self-referencing pack, When `resolveObject(ctx, soleSourceStore(ctx, registry), ids[0], false)`,
   Then `data.code === 'INVALID_PACK_ENTRY'`, `data.offset === offsets[0]`, `data.reason === 'delta base cycle'`.
   Fails today: `DELTA_CHAIN_TOO_DEEP` depth 51 (the REF hop re-enters the same entry until the cap).
2. RED — Given the 2-cycle, When resolving `ids[0]`, Then `INVALID_PACK_ENTRY` at `offsets[0]` with
   the same reason (trace: X→Y adds Y, Y→X adds X, X→Y finds Y). Fails today: `DELTA_CHAIN_TOO_DEEP`.
3. RED — Given the cycle entered after an OFS run, When resolving `ids[2]`, Then `INVALID_PACK_ENTRY`
   at `offsets[0]`. Fails today: `DELTA_CHAIN_TOO_DEEP`.
4. GREEN — `syntheticBlobId` was added before step 1 (test infra); now add `enterRefBase` and the
   threading above. Steps 1–3 pass.
5. GUARD — Given base content B written as a base entry in TWO packs (`writeSyntheticPack` twice,
   same content → same id) and a third pack holding `{ ref-delta baseId: ids of B, baseUncompressed: B, targetContent: T }`,
   When resolving T's id, Then `content` equals T. Passes: an acyclic walk never repeats a REF base
   id, however many copies exist (design edge matrix).
6. GUARD — Given a two-hop REF chain in one pack (base B, REF R1 onto B, REF R2 onto R1), When
   `Promise.all` resolves R2's id twice on the same ctx, Then both resolve to R2's bytes. Passes:
   each read builds its own memory (no shared set).
7. REFACTOR — none expected beyond keeping `collectDeltaChain`'s REF arm readable.

### Gate

~~~
npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/primitives/internal/blob-source.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts test/unit/application/primitives/pack-fixture.ts test/unit/application/primitives/object-resolver.test.ts && npm run check:spelling
~~~

(blob-source.test.ts is in the list because blob-source.ts calls `resolvePackChain`.)

### Commit

`fix(object-resolver): refuse a REF_DELTA cycle instead of walking it`

## Part 3 — G2 in the header-only walkers (readObjectMetadata, fsck)

### Context

Design §3 bullets 2–3; ADR-1020 (walk-local in the two header walkers), ADR-1021 (metadata throws
the resolver's refusal; fsck returns `untypedFault(ctx, id, 'delta chain cycle')`). Depends on
Part 2 (`enterRefBase`, `syntheticBlobId`). Cap still present: REDs fail on the cap.

Files (edit):
- `src/application/primitives/read-object.ts` — `walkDeltaBaseType(ctx, registry, hit, header, targetId)`
  (L552-574): keep a walk-local `let walked: Set<ObjectId> | undefined;` and, at the top of each
  iteration, when `currentHeader.type === PACK_ENTRY_TYPE.REF_DELTA`,
  `walked = enterRefBase(walked, currentHeader.baseId, currentHit.offset);` before
  `nextDeltaHit` (L590-603, unchanged). Import `enterRefBase` in the object-resolver.js import
  block (L18-29). `PACK_ENTRY_TYPE` is already imported (used by `nextDeltaHit`). The `depth`
  counter stays until Part 4.
- `src/application/commands/internal/fsck/object-cache.ts` — `walkDeltaChain` REF arm (L271-278):
  walk-local `let walked: Set<ObjectId> | undefined;` before the loop; in the REF arm, before the
  lookup: `if (walked?.has(header.baseId)) return untypedFault(ctx, id, 'delta chain cycle');`
  then `walked = (walked ?? new Set<ObjectId>()).add(header.baseId);`. Part 1 extracted the OFS
  arm into `followOfsBase`; extract the REF arm the same way into `followRefBase(ctx, registry, id, baseId, walked)`
  returning `{ hit, walked } | TypedOrUntyped` (or an equivalent shape) so `walkDeltaChain` stays
  ≤ 20 lines with nesting ≤ 2.
- `test/unit/application/primitives/read-object-metadata.test.ts` — new describes after the Part 1
  zero-distance describe.
- `test/unit/application/commands/fsck.test.ts` — new describes after the Part 1 zero-distance describe.

### TDD steps

Same self-reference and 2-cycle fixtures as Part 2 (`syntheticBlobId`, `buildSyntheticPack` +
`ctx.fs.write` to know `offsets`; for fsck use `initBareCtx()` and `writeSyntheticPack`).

1. RED (metadata) — Given the self-referencing pack, When `readObjectMetadata(ctx, ids[0])`, Then
   `INVALID_PACK_ENTRY` with `offset === offsets[0]`, `reason === 'delta base cycle'`. Fails today:
   `DELTA_CHAIN_TOO_DEEP` depth 51 from `walkDeltaBaseType`'s counter.
2. RED (metadata) — Given the 2-cycle, When `readObjectMetadata(ctx, ids[0])`, Then the same refusal
   at `offsets[0]`. Fails today: `DELTA_CHAIN_TOO_DEEP`.
3. GREEN — `walkDeltaBaseType` change above.
4. RED (fsck) — Given `initBareCtx()` + the self-referencing pack, wrapped with `withWarnLog`, When
   `fsck(logged, { connectivityOnly: true })`, Then the dangling finding for `ids[0]` is
   `objectType: 'unknown'` and its warn `context.reason === 'delta chain cycle'`. Fails today:
   reason `'delta chain exceeds max depth'` (the initial read now refuses with
   `INVALID_PACK_ENTRY`, which routes to the walker; the walker loops to its bound).
5. RED (fsck) — Given the 2-cycle, Then BOTH members are `'unknown'` with reason
   `'delta chain cycle'`. Fails today: `'delta chain exceeds max depth'`.
6. GREEN — `walkDeltaChain` / `followRefBase` change above.
7. GUARD — the existing `'Given a dangling REF_DELTA-encoded blob with a corrupt delta body, base intact'`
   fsck test (L5167) and `'Given a packed REF_DELTA entry'` metadata test (L263) stay green:
   an acyclic REF hop is never refused.
8. REFACTOR — the extraction in step 6 if not already done.

### Gate

~~~
npx vitest run test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/commands/fsck.test.ts test/unit/application/primitives/read-object.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/read-object.ts src/application/commands/internal/fsck/object-cache.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/commands/fsck.test.ts && npm run check:spelling
~~~

### Commit

`fix(pack): refuse a REF_DELTA cycle in the header-only type walks`

## Part 4 — lift the cap in the header-only walkers

### Context

Design §3; ADR-1019 (no reader applies a depth cap). With G1 (Part 1) and G2 (Part 3) in both
header walkers, their depth bounds are now redundant terminators that refuse well-formed packs.

Files (edit):
- `src/application/primitives/read-object.ts` — `walkDeltaBaseType`: delete `let depth = 1;`,
  `depth += 1;`, `assertChainDepthWithinCap(depth);`, the `assertChainDepthWithinCap` import (L19)
  and the doc-comment phrase "and `assertChainDepthWithinCap`" (L549-551; the walker still reuses
  `ofsDeltaBaseOffset` and `enterRefBase`).
- `src/application/commands/internal/fsck/object-cache.ts` — `walkDeltaChain`:
  `for (let depth = 0; depth <= MAX_DELTA_CHAIN_DEPTH; depth += 1)` → `for (;;)`; delete the
  trailing `return untypedFault(ctx, id, 'delta chain exceeds max depth');` and the
  `MAX_DELTA_CHAIN_DEPTH` import (L11).
- `test/unit/application/primitives/pack-fixture.ts` — add
  `export interface ChainSpec { readonly entries: ReadonlyArray<EntrySpec>; readonly tipContent: Uint8Array }`,
  `export function ofsChainSpecs(depth: number, label: string): ChainSpec` (base
  `ENC(label + '-base')`, then `depth` OFS deltas, level i targeting `ENC(label + '-' + i)` with
  `baseIndex: i`) and `export async function refChainSpecs(ctx: Context, depth: number, label: string): Promise<ChainSpec>`
  (same contents, each a `ref-delta` whose `baseId` is `syntheticBlobId(ctx, previous)`). Fixed
  small contents keep a 5 000-hop pack cheap (measured: build ~430 ms, resolver read ~170 ms).
- `test/unit/application/primitives/read-object-metadata.test.ts` — flip L365-394.
- `test/unit/application/commands/fsck.test.ts` — flip L5123-5166; delete L5092-5121.

fsck depth note (PC-5): fsck's unit tests stay at 51 hops. Measured with the cap mocked away
(memory adapter, tip-corrupt chain, `connectivityOnly`): 1 000 OFS hops → 16.6 s, 1 000 REF → 25.9 s,
5 000 OFS → 486 s — fsck reads every object of the chain, so its cost is quadratic in depth.

### TDD steps

1. RED (metadata) — flip `'Given an OFS_DELTA chain of length 51'` (L365): Then `type === 'blob'`
   and `uncompressedSize === tipContent.length` (use `ofsChainSpecs(51, 'meta-long-chain')`).
   Fails today: `DELTA_CHAIN_TOO_DEEP` depth 51.
2. RED (metadata) — Given `ofsChainSpecs(5_000, …)`, When `readObjectMetadata` on the tip, Then
   `blob` + tip length. Fails today: `DELTA_CHAIN_TOO_DEEP`.
3. RED (metadata) — Given `refChainSpecs(ctx, 5_000, …)` in one pack, same Then. Fails today:
   `DELTA_CHAIN_TOO_DEEP`.
4. GREEN — read-object.ts deletions above.
5. RED (fsck) — flip `'Given an OFS_DELTA chain one hop deeper than the walker can afford, tip corrupt'`
   (L5123): retitle to `'Given an OFS_DELTA chain of 51 hops, tip corrupt'`; Then dangling
   `objectType === 'blob'` (no warn assertion). Fails today: `'unknown'` — the walker's 51
   iterations stop one hop short of the base.
6. RED (fsck) — Given `refChainSpecs(ctx, 51, …)` with the tip corrupted
   (`corruptTrailingPackEntryByte`), Then the tip is dangling `'blob'`. Fails today: `'unknown'`
   with reason `'delta chain exceeds max depth'`.
7. GREEN — object-cache.ts change above. Delete the exactly-50 test (L5092-5121): it existed to pin
   the bound's `<=`.
8. REFACTOR — none.

### Gate

~~~
npx vitest run test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/commands/fsck.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/read-object.ts src/application/commands/internal/fsck/object-cache.ts test/unit/application/primitives/pack-fixture.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/commands/fsck.test.ts && npm run check:spelling
~~~

### Commit

`fix(pack): type delta chains of any depth in readObjectMetadata and fsck`

## Part 5 — lift the cap in the resolver; delete the factory; interop pins 1, 2, 4

### Context

Design §3, §6 Part 3, Test strategy pins 1, 2, 4; ADR-1019, ADR-1024 (the factory goes with its
last caller). After this part no code raises `DELTA_CHAIN_TOO_DEEP`.

Files (edit):
- `src/application/primitives/object-resolver.ts` — delete `assertChainDepthWithinCap(externalDepth + depth + cached.chainDepth);`
  (L857) with its comment (L850-856, keep the plain "probe before descending" sense),
  `assertChainDepthWithinCap(externalDepth + depth);` (L886), the function itself (L792-800 with
  its doc), and the imports `MAX_DELTA_CHAIN_DEPTH` (L31) and `deltaChainTooDeep` (L33). Leave
  `externalDepth` / `chainDepth` plumbing for Parts 7–8.
- `src/domain/storage/error.ts` — delete `deltaChainTooDeep` (L106-107). Keep the union member
  (L52) until Part 9.
- `test/unit/domain/storage/error.test.ts` — delete the `'Given deltaChainTooDeep(depth)'` describe
  (L70-80) and its import (L4).
- `test/unit/application/commands/internal/fsck/packed-ref-tips.test.ts` — delete the
  `['a delta chain too deep', deltaChainTooDeep(51)]` row (L151) and its import (L25) (PC-2).
- `test/unit/application/primitives/object-resolver.test.ts` — flips and deletions below.
- `test/integration/delta-chain-depth-interop.test.ts` — add pins 1, 2, 4 (the file exists from Part 1).

Resolver test triage (each `Then` asserting `DELTA_CHAIN_TOO_DEEP`):
- FLIP to "resolves with the expected bytes": L4048 (OFS 51 cold), L4077 (OFS 51 with position 25
  warmed — the warm-offset-cache row), L4193 (OFS 30 → REF → OFS 25 across two packs — the mixed
  row), L4252 (55 one-entry packs, nested REF hops). Retitle each without "cap"; assert
  `content`/`type` against the fixture's tip bytes.
- DELETE (they probe depth accounting only, DC-7): L3426 (exactly 50, the `>=` mutant),
  L4114 (60 warmed bottom-up), L4159 (45-level re-cache labelling), L4305 (within the cap across a
  REF hop — subsumed by the L4193 flip), L4349, L4410, L4474 (cache-resumption depth), L4540
  (cold refuses / warm admits).

Interop measurements (mktemp throwaways, `runGitEnv`-style isolation, git 2.55.0 and 2.56.0):
- Pin 1 shape: 2 000-line file `line <i>`, commit c0 then 100 commits each setting line 0 to
  `changed <c>`, one blob + one commit record per version on refs/heads/main, `git fast-import --quiet --depth=100`
  into `git init --bare -b main` → `verify-pack -v` tail `chain length = 100: 1 object` on both.
- Pin 2 shape: a 3-line file (`line <i> of the deep chain fixture`, i = 0..2) whose line 0 is
  `version <v>`, 4 100 `blob` records + one commit pointing `file.txt` at the last mark,
  `git fast-import --quiet --depth=8191` → 4 099 deltas, max `chain length = 4099`, one non-delta
  blob, pack ~130 KB, fast-import + verify-pack + cat-file each < 0.1 s on both versions. A 2-line
  file does NOT deltify (4 100 non-delta blobs); 3 lines is the smallest that does. tsgit
  `readBlob` + `readObjectMetadata` on the Node adapter, cap mocked away: whole test ~140 ms.
  Today (cap in place) the same read throws `DELTA_CHAIN_TOO_DEEP: delta chain too deep: 51`.

### TDD steps

1. RED (unit) — flip L4048: Given `ofsChainSpecs(51, …)` (or the existing inline loop), When
   `resolveObject` on the tip, Then `type === 'blob'` and `content` equals the tip bytes. Fails
   today: `DELTA_CHAIN_TOO_DEEP`.
2. RED (unit) — flip L4077, L4193, L4252 the same way (each fails today on `DELTA_CHAIN_TOO_DEEP`).
3. RED (unit) — Given `ofsChainSpecs(5_000, …)`, and separately `refChainSpecs(ctx, 5_000, …)` in
   one pack, When `resolveObject` on each tip, Then the tip bytes. Fail today: `DELTA_CHAIN_TOO_DEEP`.
4. RED (interop, pin 1) — Given the pin-1 bare repo, When `verify-pack -v` runs on its `.idx` and
   tsgit `readBlob(ctx, id)` reads `git rev-parse main:file.txt`, Then the histogram's max chain is
   > 50 (parse `/^chain length = (\d+): /m`) and `readBlob(...).content` equals
   `runGitBytes(['-C', dir, 'cat-file', '-p', 'main:file.txt'])`. Fails today: `DELTA_CHAIN_TOO_DEEP`.
5. RED (interop, pin 2) — Given the pin-2 bare repo, Then max chain > 4 095, `readBlob` bytes equal
   `git cat-file -p`, and `readObjectMetadata` returns `{ type: 'blob', uncompressedSize: <git cat-file -s> }`.
   Fails today on the `readBlob`. Per-test timeout 60 000 ms (measured ~140 ms; headroom for CI).
6. RED (interop, pin 4) — `describe.each([51, 1_000])`: Given `buildSyntheticPack(createMemoryContext(), ofsChainSpecs(depth, …).entries)`
   installed with Part 1's `installCraftedPack`, When git and tsgit read the tip, Then
   `readBlob` bytes equal `runGitBytes(['-C', dir, 'cat-file', '-p', tip])`. Fails today: `DELTA_CHAIN_TOO_DEEP`.
7. GREEN — object-resolver.ts deletions above. Steps 1–6 pass.
8. REFACTOR — delete the eight resolver tests listed under DELETE; delete the factory, its unit
   test and the packed-ref-tips row (all now dead). `grep -rn "deltaChainTooDeep\|assertChainDepthWithinCap" src test`
   must return nothing.

### Gate

~~~
npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/domain/storage/error.test.ts test/unit/application/commands/internal/fsck/packed-ref-tips.test.ts test/unit/application/primitives/read-object.test.ts test/integration/delta-chain-depth-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts src/domain/storage/error.ts test/unit/domain/storage/error.test.ts test/unit/application/commands/internal/fsck/packed-ref-tips.test.ts test/unit/application/primitives/object-resolver.test.ts test/integration/delta-chain-depth-interop.test.ts && npm run check:spelling
~~~

### Commit

`fix(object-resolver): read delta chains of any depth, as git does`

## Part 6 — writer: clamp pack.depth at git's 4095 ceiling

### Context

Design §4; ADR-1023 (named constant 4 095, silent clamp per ADR-249, `DEFAULT_PACK_DEPTH = 50`
stays, `MAX_DELTA_CHAIN_DEPTH` deleted). Hotfix-optional; safe only after Part 5. After Parts 4–5
the writer is `MAX_DELTA_CHAIN_DEPTH`'s last reader.

Files (edit):
- `src/domain/storage/delta-policy.ts` — drop `import { MAX_DELTA_CHAIN_DEPTH } from './delta.js';`
  (L8); add module-local `const MAX_PACK_DEPTH = 4095;` beside `DEFAULT_PACK_DEPTH` (L16) with a doc
  comment: git pack-objects' own ceiling (`pack.depth` above it is forced to it); `resolveDeltaPolicy`
  (L91-108): `maxDepth: Math.min(depth, MAX_PACK_DEPTH)`. Extend the function's doc comment with the
  clamp.
- `src/domain/storage/delta.ts` — delete `MAX_DELTA_CHAIN_DEPTH` and its doc (L3-7).
- `test/unit/domain/storage/delta-policy.test.ts` — L421 `'Given depth = 250, above tsgit reader cap'`
  and L436 `'Given depth = 10, below the reader cap'`.
- `test/unit/domain/storage/delta.test.ts` — delete the `'MAX_DELTA_CHAIN_DEPTH'` describe (L746-760)
  and the import (L6).
- `test/integration/delta-pack-interop.test.ts` — new describe inside
  `describe.skipIf(!GIT_AVAILABLE)('delta-writing packer, against real git', …)` (L332), after the
  X1–X3 blocks. Reuse in-file helpers: `churnRepo` (built in the outer `beforeAll`), `tmp(slug)`
  (L57), `trackedNodeContext(dir)` (L179), `solePackIdx(dir)`, `parseChainDepths(verifyOutput)`
  (L232 → `{ histogram, perObject }`), `maintenance(ctx, { tasks: ['gc'] })`,
  `disposePackRegistry(ctx)`, `runGit`, `tryRunGitWithExit`, `SETUP_TIMEOUT`.

Measured: the churn shape (500 lines, 199 edits) repacked by git 2.56 with
`-c pack.window=10 -c pack.depth=100 repack -a -d -f` reaches `chain length = 99`, so the corpus
can carry chains past 50 at depth 100.

### TDD steps

1. RED — flip L421: retitle `'Given depth = 250, below git's 4095 ceiling'`, Then `maxDepth === 250`.
   Fails today: 50.
2. RED — Given depth 4 095, Then `maxDepth === 4095`. Fails today: 50.
3. RED — Given depth 4 096, Then `maxDepth === 4095`. Fails today: 50.
4. RED (interop, pin 5) — Given a copy of `churnRepo` with `git config pack.depth 100` set BEFORE
   the tsgit context is created (config is memoised per session), gc'd by tsgit
   (`maintenance(gc)` then `disposePackRegistry`), When `git verify-pack -v` runs on the sole pack,
   Then the max key of `histogram` is > 50 and ≤ 100; `tryRunGitWithExit(['-C', dir, 'fsck', '--full'])`
   exits 0; `tryRunGitWithExit(['index-pack', '--strict', <copy of the pack in a scratch dir>])`
   exits 0. Fails today: max chain 50 (the clamp).
5. GREEN — delta-policy.ts change; delete `MAX_DELTA_CHAIN_DEPTH` from delta.ts and its test.
6. GUARD — L436 (depth 10 → 10, retitle "below git's ceiling") and the existing `pack.depth=50` rows
   stay green.
7. REFACTOR — none.

### Gate

~~~
npx vitest run test/unit/domain/storage/delta-policy.test.ts test/unit/domain/storage/delta.test.ts test/unit/application/primitives/build-pack.test.ts test/integration/delta-pack-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/delta-policy.ts src/domain/storage/delta.ts test/unit/domain/storage/delta-policy.test.ts test/unit/domain/storage/delta.test.ts test/integration/delta-pack-interop.test.ts && npm run check:spelling
~~~

### Commit

`fix(pack): honour pack.depth up to git's 4095 ceiling`

## Part 7 — delete the depth threaded through REF_DELTA hops

### Context

Design §5; ADR-1025. After Part 5 `externalDepth` has no reader. Pure refactor: no RED; the type
checker finds every stale call (a leftover `0` lands in the `mode: LooseReadMode` slot).

Files (edit):
- `src/application/primitives/object-resolver.ts` — remove the `externalDepth: number` parameter
  from `resolveObjectContentWithDepth` (L300; `mode` moves to slot 6, `refBases` stays trailing),
  `tryResolveViaSources` (L378 and its calls L333, L340), `tryResolveViaSource` (L404),
  `resolvePackChainWithDepth` (L976), `collectDeltaChain` (L824), `resolveBaseForRefDelta`
  (L1119); callers `resolveObject` (L548-556) and `resolveObjectWithSize` (L571-579) drop their
  `0`; `resolvePackChain` (L955-963) drops its `0`; the REF arm passes no depth. Rewrite the doc
  comments that explain depth threading: L285-299 (`resolveObjectContentWithDepth`), L905-911 (REF
  arm), L967-975 (`resolvePackChainWithDepth`), L1146-1148 (`resolveBaseForRefDelta`) — state what
  the walk memory does instead; no mention of a cap.
- `src/application/primitives/read-object.ts` — `readRawObject` (L222-229) and
  `metadataAfterFullMiss` (L507-515) drop their `0` argument.
- `test/unit/application/primitives/object-resolver.test.ts` — the 35 `resolveObjectContentWithDepth(`
  calls drop their sixth argument `0` (the line right after `undefined,` / the `maxBytes` argument).
- `test/integration/index-pack-interop.test.ts` — in `describe.each([50, 51, 1000])` (L712), rewrite
  the arrange comment (L716-722): keep "no depth cap on either indexer", delete the
  `MAX_DELTA_CHAIN_DEPTH` / "pre-existing gap" sentences (Part 5's pin 4 reads such packs).

test/unit/application/commands/rev-parse-search.test.ts:389-395 spies on
`resolveObjectContentWithDepth` with a rest-args passthrough — unaffected (read-only).

### TDD steps

1. GUARD — before editing, run the gate's test list: green.
2. REFACTOR — remove the parameter bottom-up (`collectDeltaChain` first), fixing each caller tsc
   reports; then the 35 test calls; then the comments.
3. GUARD — `grep -rn "externalDepth" src test` returns nothing; the gate's test list is green with
   the same test count as step 1.

### Gate

~~~
npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/commands/rev-parse-search.test.ts test/unit/application/commands/fsck.test.ts test/integration/index-pack-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/object-resolver.ts src/application/primitives/read-object.ts test/unit/application/primitives/object-resolver.test.ts test/integration/index-pack-interop.test.ts && npm run check:spelling
~~~

### Commit

`refactor(object-resolver): stop threading a chain depth through REF_DELTA hops`

## Part 8 — delete the chain depth from the delta-base cache and the resolver's results

### Context

Design §5; ADR-1025 (`deltify.ts`'s own `chainDepth` — the writer's emission depth — is NOT
touched). Pure refactor under the suite; `deltaBaseCacheEntrySize(content)` sizes content only, so
cache accounting is unchanged.

Files (edit):
- `src/application/primitives/pack-registry.ts` — `DeltaBaseCacheEntry` (L209-222): delete
  `chainDepth` and its doc comment.
- `src/application/primitives/internal/object-caches.ts` — `cacheDeltaBase(ctx, registry, key, type, content, chainDepth)`
  (L358-371): drop the last parameter and the field in the set call; the overhead doc (L314) says
  `{ type, content }` wrapper.
- `src/application/primitives/object-resolver.ts` — delete `Phase1Result.baseChainDepth` and its
  doc (L755-790) and every `baseChainDepth:` in `collectDeltaChain`'s returns; `insertLevel`'s third
  parameter and the per-level arithmetic + comment (L1005-1008, L1029-1041); drop `chainDepth` from
  every result type: `ObjectContent & { chainDepth: number; declaredSize: number }` →
  `ObjectContent & { declaredSize: number }` (L308, L354, L385, L411, L434, L501),
  `sizedByContent` (L432-440), `tryDeltaCacheHit` (L349-364, and its doc's "depth 0"),
  `resolveLooseArm` (L494-525, and its doc's "depth 0"), `resolvePackChainWithDepth`'s return
  (L984, L1052), `resolveBaseForRefDelta`'s return (L1126, L1143, L1165-1169) and its cache-hit
  comment (L1131-1141). The existing `Stryker disable next-line` comment at L1130: edit only its
  prose ("with chainDepth 0" → nothing); do not add, remove or widen any directive.
  REFACTOR (PC-6): fold `resolvePackChainWithDepth` into `resolvePackChain(ctx, store, source, hit, targetId, maxBytes, refBases?: Set<ObjectId>)`
  — the wrapper existed only to hide the depth; blob-source.ts:645 and verify-pack.ts:92 keep
  their six-argument calls.
- `test/unit/application/primitives/internal/object-caches.test.ts` — drop `chainDepth: 0` (L73,
  L100) and the trailing `0` argument of the three `cacheDeltaBase(` calls (L136, L155-162, L184-191).
- `test/unit/application/primitives/pack-registry.test.ts` — drop `chainDepth: 0` (L7558).

### TDD steps

1. GUARD — run the gate's test list before editing: green.
2. REFACTOR — delete the field from `DeltaBaseCacheEntry`; follow tsc through object-caches.ts,
   object-resolver.ts and the two test files; then the return-type intersections; then fold
   `resolvePackChainWithDepth`.
3. GUARD — `grep -rn "chainDepth" src test | grep -v deltify` returns only
   test/unit/application/primitives/build-pack.test.ts's local `chainDepthAt` helper; gate green.

### Gate

~~~
npx vitest run test/unit/application/primitives/object-resolver.test.ts test/unit/application/primitives/internal/object-caches.test.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/read-object.test.ts test/unit/application/primitives/read-object-metadata.test.ts test/unit/application/commands/fsck.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts src/application/primitives/internal/object-caches.ts src/application/primitives/object-resolver.ts test/unit/application/primitives/internal/object-caches.test.ts test/unit/application/primitives/pack-registry.test.ts && npm run check:spelling
~~~

### Commit

`refactor(pack-registry): drop the chain depth from delta-base cache entries`

## Part 9 — remove the `DELTA_CHAIN_TOO_DEEP` variant (breaking, last commit)

### Context

Design §6 Part 6; ADR-1024. Nothing raises the code since Part 5. This is the only commit with a
`!` marker and the only one changing reports/api.json.

Files (edit):
- `src/domain/storage/error.ts` — delete `| { readonly code: 'DELTA_CHAIN_TOO_DEEP'; readonly depth: number }` (L52).
- `src/domain/error.ts` — delete the two-line message arm for `'DELTA_CHAIN_TOO_DEEP'` (L366-367, the `delta chain too deep` template).
- `src/application/commands/internal/fsck/stored-corruption.ts` — delete `'DELTA_CHAIN_TOO_DEEP',` (L15).
- `test/unit/domain/exhaustiveness.ts` — delete `case 'DELTA_CHAIN_TOO_DEEP':` (L62).
- `test/unit/domain/error.test.ts` — delete the `'Given DELTA_CHAIN_TOO_DEEP'` describe (L546-556).
- `reports/api.json` — regenerate with `npx typedoc --json reports/api.json --disableSources --out reports/api-tmp && rm -rf reports/api-tmp`
  (= `npm run docs:json`) and commit it in this commit (prepush `check:doc-typedoc` diffs it; the
  large id churn is normal).

User docs (docs/use/errors.md:59 row, docs/understand/security.md:124 row, the new
`'delta base cycle'` reason on the `INVALID_PACK_ENTRY` row) are the documentation phase's (PC-9).

### TDD steps

1. GUARD — `grep -rln "DELTA_CHAIN_TOO_DEEP" src test` lists exactly the five files above.
2. REFACTOR — delete them; tsc must be clean (any surviving switch arm or literal over the union is
   a compile error).
3. Regenerate reports/api.json; `git diff --no-ext-diff --stat reports/api.json` shows a change and
   `grep -c DELTA_CHAIN_TOO_DEEP reports/api.json` returns 0.
4. GUARD — gate green.

### Gate

~~~
npx vitest run test/unit/domain/error.test.ts test/unit/domain/storage/error.test.ts test/unit/application/commands/internal/fsck/packed-ref-tips.test.ts test/unit/application/commands/fsck.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/storage/error.ts src/domain/error.ts src/application/commands/internal/fsck/stored-corruption.ts test/unit/domain/exhaustiveness.ts test/unit/domain/error.test.ts && npm run check:spelling
~~~

### Commit

`fix(pack)!: remove the DELTA_CHAIN_TOO_DEEP error, which no read raises`

## Verification (orchestrator, not parts)

- Phase gate: `npm run validate` after Part 9 (size rows: see Repo-wide facts).
- Bench, after Part 8: `npm run bench:ab -- f9abe0fc HEAD 5 delta-chain-read.bench.ts` (bench
  fixture unchanged, ADR-1026). Expect flat or better: the OFS-only hot path loses two assertions
  and a field and allocates nothing new.
- Hotfix check (R8): `git cherry-pick` Parts 1–5 onto a branch at the 5.0.0 tag compiles and passes
  their tests without Part 9.

## Decision candidates

Load-bearing choices the design and ADRs left open (PC-n, apart from the design's DC-n). The plan
proceeds with each recommendation; a different choice changes only the named part.

| # | Subject | Options | Recommendation |
|---|---|---|---|
| PC-1 | Where the walk memory sits on exported `resolveObjectContentWithDepth` | (a) trailing optional parameter after `mode`; (b) the `externalDepth` positional slot (callers pass `undefined`) | **(a)**: top-level callers never name it; Part 7 then only deletes `0`. ADR-1020's "slot" holds for the five private functions. Parts 2, 7 |
| PC-2 | packed-ref-tips.test.ts's `deltaChainTooDeep(51)` row | (a) delete it with the factory in Part 5; (b) rewrite it as `new TsgitError({ code: 'DELTA_CHAIN_TOO_DEEP', depth: 51 })` and delete it in Part 9 | **(a)**: the row pins how fsck classifies a fault no read raises after Part 5; (b) makes Part 9 seven files. Cost of (a): on a 5.0.x hotfix the `CORRUPTION_CODES` entry has no killing test — a mutant there is equivalent in practice (no code path produces the code). Parts 5, 9 |
| PC-3 | Breaking marker of Part 9 | (a) `fix(pack)!:`; (b) `feat!:`; (c) `refactor(pack)!:` (precedent `refactor(merge)!`) | **(a)**: lands in the Bug Fixes section next to the #321 fix it completes; all three bump major. Part 9 |
| PC-4 | Pin 4 location | (a) the new delta-chain-depth-interop.test.ts with `ofsChainSpecs`; (b) extend index-pack-interop.test.ts's `describe.each([50, 51, 1000])` as the design says | **(a)**: (b) pushes Part 5 to seven files; the index-pack block keeps its indexer assertion and only loses its stale comment (Part 7). Parts 5, 7 |
| PC-5 | fsck unit depth | (a) 51 hops (OFS flip + REF new); (b) 1 000 / 5 000 like the other walkers | **(a)**: measured 16.6 s / 486 s for 1 000 / 5 000 OFS hops (fsck reads every chain member). Part 4 |
| PC-6 | `resolvePackChainWithDepth` after Part 8 | (a) fold into `resolvePackChain` with an optional `refBases`; (b) keep the private wrapper | **(a)**: the wrapper existed only to return the depth. Part 8 |
| PC-7 | `resolveObjectContentWithDepth`'s name once no depth remains | (a) keep; (b) rename to `resolveObjectContent` in Part 7 | **(a)** in this change: (b) also edits rev-parse-search.test.ts's spy and comments in blob-source.ts, loose-oid-cache.ts and object-caches.ts, pushing Part 7 past six files; a follow-up rename is mechanical. Part 7 |
| PC-8 | Pin 2 fixture size | (a) 3 lines × 4 100 versions (smallest that deltifies, measured on 2.55 and 2.56); (b) 4+ lines for margin | **(a)**: both CI and local git deltify every version; a regression to non-delta storage fails the `> 4095` assertion loudly rather than passing vacuously. Part 5 |
| PC-9 | User-doc rows (errors.md, security.md, the new `INVALID_PACK_ENTRY` reason) | (a) documentation phase; (b) Part 9 | **(a)**: no gate reads them (grep of tooling and tests), and (b) makes Part 9 eight files. Part 9 |

## Out-of-scope observations

- fsck's cost grows quadratically with chain depth (memory adapter, tip-corrupt chain, cap mocked
  away: 1 000 OFS hops 16.6 s, 1 000 REF hops 25.9 s, 5 000 OFS hops 486 s). Proof against git
  would be timing `git fsck --full` on the pin-2 repository beside tsgit's `fsck`.
