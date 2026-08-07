# Plan — `fsck` pack-accessibility reporting

> Source: design doc `docs/design/fsck-pack-accessibility-reporting.md` · ADRs 581 … 591
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the part schema — the plan phase cannot close without it.

## Sizing

Seven parts. Five carry a `src/` delta with their own tests folded in; two are
test-infra-only (cross-tool interop suites + the cross-adapter parity scenario + the
lifted pack-fixture helpers) and are standalone by the template's own exception —
they have no implementation part to fold into, and they cover behaviour spanning
Parts 1–5, so neither can live inside a single code part.

Parts are **sequential in one working tree**; each builds on the last. Several parts
touch the same files (`fsck.ts`, `internal/fsck/types.ts`, `fsck.test.ts`,
`fsck-pack-accessibility-interop.test.ts`) — `plan-lint`'s cross-part overlap warning
is expected and is not a defect: the change is one behaviour delivered in five
observable increments, and each increment leaves those files green.

**Why Parts 3 and 4 both touch `internal/fsck/types.ts` and are still separate.** They
make *disjoint* edits to it under *different* ADRs: Part 3 **adds three variants**
(ADR-583/586, the pack axis) while Part 4 **widens two existing fields** and adds
`UnreadableMode` (ADR-588, the unreadable-object axis). Merging them would fuse two
behaviours whose mode gates are provably disjoint — the pack pass keys on
`full !== false && connectivityOnly !== true`, the classification on
`connectivityOnly === true` alone — into one commit, which is precisely the conflation
the design names as the change's most inversion-prone reading (§D11.11), and would make
the resulting part's ~21 unit rows unreviewable as one diff. The shared file is a type
declaration, not shared logic.

**No test assertion written by an earlier part is flipped by a later one.** That
constraint drove the split: Part 4 deliberately avoids the undecodable-zlib fixture
(Part 5 makes it reject) and Part 4's `'unknown'` rows are exactly the rows ADR-591
keeps `'unknown'` forever (§D13.8's two boundaries). Rows whose `objectType` ADR-591
changes to a real type appear for the first time in Part 5.

## Shared conventions (bind every part)

- **Serena is ALREADY ACTIVATED** on this worktree. Do NOT call `activate_project`.
  Use `find_symbol` / `find_referencing_symbols` / `replace_symbol_body` /
  `insert_after_symbol` as the default for every TypeScript read/navigate/edit (test
  files too); `get_diagnostics_for_file` after each source edit. `Read`/`Grep` only for
  markdown/JSON/generated artefacts. Diagnostics are advisory — ground truth is
  `npm run check:types`.
- **Test conventions**: `describe('Given <context>')` > `describe('When <action>')` >
  `it('Then <expected>')` (the 2-level `Given …, When …` shortcut is allowed when only
  one expectation lives under the When). Body is AAA with `// Arrange` / `// Act` /
  `// Assert` comments. The system under test is named `sut` — the function/object
  under test, never the result (`result` holds the result). `createPackRegistry`,
  `getPackRegistry`, `createNodeContext`, `createMemoryContext` and
  `buildSeededContext` are already on the `sutBindsResult` allowlist in
  `test-pyramid-budgets.json`; nothing new needs adding.
- **Error assertions**: never `toThrow(TsgitError)`. Use `try`/`catch` +
  `expect((caught as TsgitError).data).toEqual({ code: …, reason: … })`, or
  `.data.code` + `.data.reason` separately. A type-only assertion cannot tell the two
  abort classes apart and is banned by the pyramid gate's `bareClassToThrow`
  heuristic.
- **Isolated-guard rule**: for `if (A || B)`, write one `it` per operand with an
  arrangement that triggers that operand alone. Every row in the matrices below that
  says **own `it`** is there for this reason; merging two of them returns a mutant to
  surviving.
- **No provenance refs in code**: never write `ADR-5xx`, `§D13`, `Pin R7`, `28.1`,
  `Phase …` or a backlog id inside `src/` or `test/`. Comments explain *why* in prose
  (e.g. "git types a corrupt packed entry from its entry header, so a recovered type
  wins over `'unknown'`"). The commit message is the join point.
- **No suppression directives** of any flavour (`@ts-ignore`, `v8 ignore`,
  `stryker-disable`, `biome-ignore`). Two *existing* `// Stryker disable` comments are
  **deleted** by this change (Parts 4 and 5) — deleted, not re-justified.
- **Public-surface pre-payment**: Parts 2, 3 and 4 change exported types, so each of
  them runs `npm run docs:json` and commits the regenerated `reports/api.json` in the
  same commit (a large typedoc-id diff is normal). `check:doc-typedoc` is a **prepush**
  gate, not a `validate` gate — a stale report passes local validate and rejects at
  push. No other surface gate fires: `PackRegistry` / `RegisteredPack` /
  `PackHealth` have 0 occurrences in `reports/api.json` (verified), no new Tier-1
  command is added (no barrel/facade/`repository.test.ts` key/README count change),
  `check:doc-coverage` needs no new page (ADR-589 keeps the pass command-internal, the
  knob is a field on an already-documented interface), and `audit-browser-surface`
  already sees `repo.fsck` in `test/parity/scenarios/fsck.scenario.ts`.
  `docs/use/commands/fsck.md` and `docs/use/primitives/internals.md` are the
  documentation phase's, **not** any part's.
- **`tooling/audit-write-surfaces.ts` must stay green with no annotation and no
  allowlist edit** — this change writes nothing (design requirement 15).
- **Coverage**: `vitest.config.ts` gates 100% on `src/domain`, `src/ports`,
  `src/adapters/node`, `src/adapters/memory`, `src/operators` only. Everything this
  change touches is under `src/application`, so no coverage threshold pressure — but
  Stryker mutates all of `src`, which is why the matrices below name their mutants.
- **Never commit on a red gate. Never `--no-verify`.**
- Blockers escalate as `{ part, reason, ≤3 options }` — never spin, never silently
  drop a row.

## Decision candidates

**None.** All ten decision candidates plus the residual are settled as ADRs 581 … 591,
and the design's §D1 … §D13.8 fix every mechanism this plan schedules. The shapes below
are *derived* from the design, not chosen by it — each is listed with the design line
that determines it, so a reviewer can check the derivation rather than re-litigate it.

## Derived shapes (not decisions)

| shape | value | derived from |
|---|---|---|
| health record | `interface UnusablePack { readonly name: string; readonly layer: 'pack' \| 'index'; readonly data: TsgitErrorData }`, `interface PackHealth { readonly accessible: ReadonlyArray<RegisteredPack>; readonly unusable: ReadonlyArray<UnusablePack> }` | §D1's two set equations + §D2's layer table. Both `export`ed from `pack-registry.ts` — required, because declaration emit rejects an exported signature referencing a file-local type — but re-exported from **no barrel**, so `reports/api.json` gains nothing. Knip's `ignoreExportsUsedInFile: true` covers their same-file use. |
| finding fields | all three variants are `{ readonly type: …; readonly pack: string; readonly reason: string }` | ADR-584 (base name only, `isSafePackName`-vetted, §D10 T-3 forbids a path); §D6's reason column. |
| `reason` for an io fault | the error **code** string, never `data.path` | §D6 rows *"reason carries the io code"* + §D10 T-3 (a path discloses the gitdir layout). Concretely `'reason' in data ? data.reason : data.code`. |
| `pack-rev-index-unusable` carries `reason` too | yes | requirement 13 (*no swallowed reason*): in `connectivityOnly` this variant is the **only** finding emitted for an index fault, so without `reason` the cause would be unreachable in that mode. |
| knob name | `EnumerateObjectsOptions.accessiblePacksOnly?: boolean` (default `false` = today) | ADR-585 + requirement 9 (*default enumeration unchanged*). |
| retention-arm failure | any fault inside the pack-entry type walk yields `'unknown'` + one `ctx.logger?.warn?.` — it never propagates and never aborts | §D13.8: *"It is an allow-list, so it fails toward today. A parse code missing from it yields `'unknown'` … never a wrong type and never an abort."* Logging (not swallowing) satisfies the no-swallowed-errors guardrail. |
| abort gate placement | the two-code test (`DECOMPRESS_FAILED` / `INVALID_OBJECT_HEADER`) is applied to the **probe's own** error inside `recoverStoredType`'s `catch`; the caller's entry gate is the wider `isDecodeFault` | §D13.1 step 0 + §D13.8's entry-gate paragraph. A *second* copy of the test against the original error would be a provably unreachable branch (every `isDecodeFault` member outside the pair is raised only *after* `parseHeader` already succeeded, so the probe's own `parseHeader` cannot then fail on the same bytes) — dead code the house rules forbid. The pin the step defends (Pin P2's `chmod 000` object must not be re-read) is served by `isDecodeFault`, which excludes every `ctx.fs` code. |

## Part 1 — `PackRegistry.health()`

### Context

**Goal.** ADR-581/582 + §D1: retain the scan layer's index-fault verdicts (today
discarded) and add one eager accessor that probes every registered pack's header memo.
Nothing on the read path changes. Requirements 9, 10, 11, 13.

**File to change:** `src/application/primitives/pack-registry.ts` (436 lines).

Current shape, by symbol name-path (line numbers are point-in-time — verify):

- `isUnsupportedOperation` (`:29`), `isSkippableIoFault` (`:37`),
  `isSkippablePackFault` (`:49`, = `INVALID_PACK_HEADER` ∪ io), `isSkippableIdxFault`
  (`:61`, = `INVALID_PACK_INDEX` ∪ io). **Reuse verbatim. Do NOT union them** — §D10
  T-5: a DRY pass that merged them would make a mid-read `INVALID_PACK_INDEX` from
  `nextOffsetForEntry` skippable at the lookup layer, converting a detected corruption
  into a silent miss.
- `faultContext(data)` (`:70`) → `{ code, reason }` or `{ code }`. Flat, string-valued
  on purpose: the Logger port sanitises **top-level string values only**.
- `interface RegisteredPack` (`:79`) — `name`, `index`, `packPath`, `idxPath`,
  `header(): Promise<PackHeader>` (memoised 12-byte `ctx.fs.readSlice`, **no
  FileHandle**), `offsetTable()`, `readSlice()`, `close()`.
- `interface PackRegistry` (`:118`) — `all()`, `lookup()`, `refresh()`, `dispose()`.
- `isSafePackName` (`:134`) rejects `/`, `\`, `..`, and every char < `0x20`.
- `loadPack` (`:166`) builds `headerMemo` via `createPromiseMemo` (`:173-181`) —
  `parsePackHeader(readSlice(packPath, 0, 12))` plus the `objectCount` cross-check that
  throws `invalidPackHeader('object count disagrees with index: pack N, index M')`.
- `NO_PACKS` (`:287`) — frozen empty array.
- `loadCandidatePack` (`:295-318`) returns `RegisteredPack | undefined`, collapsing
  **three** outcomes: orphan (no sibling `.pack` → warn
  `'packRegistry: skipping pack index with no pack file'`), skippable idx fault (warn
  `'packRegistry: skipping unreadable pack index'`), and success. An unrecognised fault
  re-throws.
- `createPackRegistry` (`:320`) — `scanPacks` (`:321-338`), `scan =
  createPromiseMemo(scanPacks)` (`:339`), `disposed`/`pendingCloses`/`trackClose`/
  `drainPendingCloses`, `allPacks()` (`:369-372`, terminal-disposal aware:
  `disposed ? (scan.peek() ?? Promise.resolve(NO_PACKS)) : scan.get()`), then the
  returned object with `all: allPacks`, `refresh` (`scan.clear()` → close outgoing),
  `lookup` (`:393`), `dispose` (`:412`, `scan.peek()` → close all).

**The edit** (widen the return type, do not add logic — both branches already exist):

```ts
type PackCandidateOutcome =
  | { readonly kind: 'registered'; readonly pack: RegisteredPack }
  | { readonly kind: 'orphaned' }
  | { readonly kind: 'index-fault'; readonly name: string; readonly data: TsgitErrorData };

interface PackGeneration {
  readonly packs: ReadonlyArray<RegisteredPack>;
  readonly indexFaults: ReadonlyArray<{ readonly name: string; readonly data: TsgitErrorData }>;
}
```

- `loadCandidatePack` returns `PackCandidateOutcome`; the orphan arm keeps its warn and
  contributes **nothing** (`'orphaned'` is never retained — requirement 3, Pin J11).
  The orphan arm and the index-fault arm sit five lines apart and both `return
  undefined` today; §D11.1 names this the most likely way the change ships subtly
  wrong.
- `scanPacks` returns a `PackGeneration`; `scan` memoises it. Every existing consumer
  of the memo now reads `.packs`: `allPacks()`, `refresh()`'s `outgoing.then(packs =>
  …)`, `dispose()`'s `pending.catch(() => …)` + `packs.map(p => p.close())`. Add
  `const EMPTY_GENERATION: PackGeneration = Object.freeze({ packs: NO_PACKS, indexFaults: Object.freeze([]) })`
  and keep `all()` returning `generation.packs` — **the same array shape it returns
  today** (requirement 9).
- New `health(): Promise<PackHealth>` on the `PackRegistry` interface, implemented as:
  awaits the same `allPacks`-style generation accessor (so terminal disposal is
  honoured — ADR-569: a disposed registry reports the peeked generation and starts no
  scan), maps `generation.indexFaults` to `layer: 'index'` entries, then **sequentially**
  awaits `pack.header()` for each `generation.packs` entry, pushing to `accessible` on
  success and, on an `isSkippablePackFault`, warning
  `'packRegistry: skipping unusable pack'` with `{ pack: pack.name, ...faultContext(err.data) }`
  (the same message `lookup` emits — §D4 accepts the duplicate warn) and pushing a
  `layer: 'pack'` entry. **Anything else re-throws** (requirement 13, §D10 T-6:
  `mapErrno` folds `EMFILE`/`EIO` into `UNSUPPORTED_OPERATION { operation: 'filesystem' }`
  and a descriptor exhaustion must never be reported as a corrupt pack).
- Doc-comment on `health()` must say: it is the ONE caller that opens packs a lookup
  would have left alone, never call it from a read path; costs one 12-byte
  `ctx.fs.readSlice` per registered pack whose header memo is unsettled; opens no
  `FileHandle`; rejects — never reports — on a fault outside the allow-lists; the
  `name` it hands out is `isSafePackName`-vetted, which is what makes it safe as data.
- **`lookup`'s body is unchanged** (requirement 10). `health()` awaits the *same*
  `header()` memo, so a successful probe warms it and a failed probe clears it — no
  negative cache.

**Blast radius outside the file (verified, do not rediscover).** Widening the
`PackRegistry` **interface** breaks four hand-built registry literals in
`test/unit/application/primitives/object-resolver.test.ts` (`:1163`, `:1220`, `:1282`,
`:1340`), each of the shape
`const registry: PackRegistry = { all, refresh, lookup, dispose }`. Add a `health`
member to each — `health: async () => ({ accessible: [pack], unusable: [] })` — and
keep that test file in this part's gate. No other `: PackRegistry` annotation exists in
`src/` or `test/` beyond the parameter positions in `object-resolver.ts`,
`read-object.ts`, `internal/blob-source.ts` and `fetch-missing.ts`, which are unaffected
because they only *consume* the interface.

**Test file:** `test/unit/application/primitives/pack-registry.test.ts` (2382 lines).
Add a new top-level `describe('PackRegistry.health — per-pack accessibility', …)`
after the existing `describe('PackRegistry.scan — per-pack idx degradation and orphan
exclusion', …)` block (`:353`). `sut` = the registry from `createPackRegistry(ctx)`.

Fixtures already in the file (import list at `:1-30`):
- `buildSeededContext` from `./fixtures.js`;
- `writeSyntheticPack(ctx, name, entries)` and `restampPackHeader(ctx, packPath, { magic?, version?, objectCount? })` from `./pack-fixture.js` (the restamp re-fixes the pack trailer over `[0, len − digestLength)` so the only thing wrong is what the row asked for);
- `handle-ledger.ts` in the same directory — a `Context` wrapper whose accessors are exactly `opens()`, `closes()`, `outstanding()`, `readdirCalls()`, `perCallReads()`, `slices()` (every `ctx.fs.readSlice` call in order, so a test can separate the 12-byte header probe from an entry read on the same pack) and `readdirGate`. Use it for the memo-warming, no-negative-cache, disposed-registry and handle rows;
- the fs-wrapper idiom for injecting a fault, copied verbatim from `:430-462`:
  ```ts
  const wrapped: Context = { ...ctx, logger: { warn }, fs: { ...ctx.fs,
    read: async (p: string) => { if (p.endsWith('.idx')) throw permissionDenied(p); return ctx.fs.read(p); } } };
  ```
  (`permissionDenied` / `fileNotFound` / `unsupportedOperation` come from
  `src/domain/error.js`; `invalidPackIndex` from `src/domain/storage/error.js`.)
- A pack-layer io fault is injected by making `readSlice` reject for `*.pack`, or by
  `ctx.fs.rm(packPath)` after the scan (the `pack-degraded-idx` parity scenario's arm 3
  idiom).
- The oversize-`.idx` row copies the stat-lying wrapper at `:208-256` and asserts
  `REASON_PACK_IDX_EXCEEDS_MAX` (from `src/application/primitives/validators.js`).

### TDD steps

RED first. The gate runs `npm run check:types`, so a test calling a method that does
not exist is a compile error — that **is** the RED, with the expected failure
`TS2339: Property 'health' does not exist on type 'PackRegistry'`.

1. **RED** — write the health matrix, one `it` per row (rows marked *own `it`* may not
   share an arrangement with any other row):

   | row | arrangement | Then |
   |---|---|---|
   | healthy | one good pack | `accessible` names = `[thatPack]`; `unusable` = `[]` |
   | v99 | `restampPackHeader(..., { version: 99 })` | one `unusable`, `layer: 'pack'`, `data.code === 'INVALID_PACK_HEADER'`, `data.reason` contains `unsupported version: expected 2 or 3, got 99` |
   | count disagreement — **own `it`** | `restampPackHeader(..., { objectCount: index.objectCount + 1 })` | `layer: 'pack'`; `data.reason` names **both** counts (`object count disagrees with index: pack 2, index 1`) |
   | bad signature | `restampPackHeader(..., { magic: 0x5041435a })` | `layer: 'pack'`; reason contains `invalid magic` |
   | short pack | truncate the `.pack` to 8 bytes | `layer: 'pack'`; reason contains `truncated` |
   | `.pack` `FILE_NOT_FOUND` — **own `it`** | `readSlice` rejects `fileNotFound` for `*.pack` | `layer: 'pack'`, `data.code === 'FILE_NOT_FOUND'` |
   | `.pack` `PERMISSION_DENIED` — **own `it`** | `readSlice` rejects `permissionDenied` | `layer: 'pack'`, `data.code === 'PERMISSION_DENIED'` |
   | `.idx` unparseable | overwrite the `.idx` with a same-length byte ramp | `layer: 'index'`, `INVALID_PACK_INDEX`; the pack is **absent from `accessible`** |
   | `.idx` `PERMISSION_DENIED` — **own `it`** | `read` rejects for `*.idx` | `layer: 'index'` |
   | `.idx` vanishes at `stat` — **own `it`** | `stat` rejects `fileNotFound` for `*.idx` | `layer: 'index'` |
   | `.idx` oversize | `stat` reports > `MAX_PACK_IDX_BYTES` | `layer: 'index'`, `data.reason === REASON_PACK_IDX_EXCEEDS_MAX`, **and the recorded read list is `[]`** — the pre-read allocation guard survives verbatim |
   | **orphan `.idx`** — **own `it`** | `.idx` written, `.pack` never present | **absent from `unusable` AND from `accessible`** |
   | **idx-less `.pack`** | `.pack` only | absent from both |
   | unrecognised fault, pack layer | `readSlice` rejects `unsupportedOperation('filesystem', …)` | `health()` **rejects**; `try`/`catch` + `.data` asserted exactly |
   | unrecognised fault, index layer | `read` rejects the same | `health()` **rejects** |
   | non-`TsgitError` | `read` rejects `new Error('boom')` | propagates (asserted for `health()`, not only for the existing scan test) |
   | memo warming | healthy pack; `health()` then `lookup(id)` | exactly **one** 12-byte `readSlice` of the `.pack` in total (requirement 10) |
   | no negative cache | v99; `health()` then `lookup(id)` | **two** header probes — the memo cleared on rejection |
   | `all()` unchanged | v99 pack | `all()` still lists it (requirement 9) — fails if the filter is wired into the wrong accessor |
   | disposed registry | `dispose()` then `health()` | resolves against the peeked generation; **no new `readdir`** |
   | handle ledger | any row above | `opens() − closes() === 0` after `dispose()` (requirement 11) |
   | `refresh()` | corrupt the `.idx` → `health()` → repair the file → `refresh()` → `health()` | the pack moves from `unusable` to `accessible`; nothing remembers it as bad |
   | two unusable packs | one v99 + one corrupt-`.idx` | **two** entries, one per layer — kills `ArrayDeclaration -> []` and a `break`-for-`continue` mutant |

2. **GREEN** — land `PackCandidateOutcome`, `PackGeneration`, the widened
   `loadCandidatePack`, the generation-aware `scan`/`allPacks`/`refresh`/`dispose`, and
   `health()`. Keep `all()`/`lookup()` bodies byte-identical apart from `.packs`.
3. **REFACTOR** — collapse the `unusable` push sites onto one small `unusableEntry`
   builder if it reads better; re-read the `health()` doc-comment against §D1's four
   properties (reuses the memo / never reaches `readSlice` / honours terminal disposal
   / probes sequentially). Confirm `grep -c '"PackRegistry"' reports/api.json` is still
   `0` — **no api.json regeneration in this part**.

### Gate

```
npx vitest run test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/object-resolver.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/pack-registry.ts test/unit/application/primitives/pack-registry.test.ts test/unit/application/primitives/object-resolver.test.ts
```

### Commit

`feat(pack-registry): expose per-pack health for integrity reporting`

## Part 2 — `enumerateObjects` accessibility knob

### Context

**Goal.** ADR-585 + §D4: one optional field on `EnumerateObjectsOptions` that restricts
the pack half of the universe to packs whose header gate passes. The default must be
byte-identical to today for every existing consumer — Pin M1's `cat-file
--batch-all-objects` column shows git *does* list a refused pack's ids, so
`enumerateObjects` must **not** filter by default (requirement 9, ADR-575).

**File to change:** `src/application/primitives/enumerate-objects.ts` (54 lines; its
whole current shape is below — nothing else in it moves).

```ts
export interface EnumerateObjectsOptions {
  /** Include objects from pack files (default: true). */
  readonly includePacks?: boolean;
}
export async function enumerateObjects(ctx, opts?): Promise<ReadonlyArray<ObjectId>>;
// → collectLooseObjectIds(ctx, ids)  [256 HEX_PREFIXES × readdir]
// → collectPackedObjectIds(ctx, ids) [getPackRegistry(ctx).all() → allObjectIds(pack.index)]
```

**The edit:**

- Add `readonly accessiblePacksOnly?: boolean;` with a doc-comment stating: default
  `false`; when `true` the pack half comes from `registry.health().accessible`, so a
  pack refused at the header gate contributes no ids; it is `fsck`'s universe knob and
  **not** a general filter — every other enumeration surface (git's `cat-file
  --batch-all-objects`, `count-objects`) lists a refused pack's ids and must keep doing
  so.
- `collectPackedObjectIds(ctx, ids, accessibleOnly)` selects
  `accessibleOnly ? (await registry.health()).accessible : await registry.all()` from
  the **same** `getPackRegistry(ctx)` instance (one registry per `Context`, §D11.9), so
  the scan memo is shared and `health()`'s second call in a run re-probes only failed
  packs.
- The knob must be inert when `includePacks === false` — `collectPackedObjectIds` is
  not called at all in that case, so **no `health()` call and no `.idx` read happens**.
  This is the structural half of Pin M8.

**Public surface.** `EnumerateObjectsOptions` is exported from
`src/application/primitives/index.ts:29` and has 10 occurrences in `reports/api.json`.
This part regenerates it.

**Test file:** `test/unit/application/primitives/enumerate-objects.test.ts` (existing).
Fixtures: `buildSeededContext` (`./fixtures.js`), `writeSyntheticPack` +
`restampPackHeader` (`./pack-fixture.js`), `writeObject`
(`src/application/primitives/write-object.js`) for loose objects. `sut` =
`enumerateObjects`.

### TDD steps

1. **RED** — add a `describe('Given a repo holding one healthy pack, one
   header-refused pack and one loose object', …)` block with four `it`s
   (expected failure: `TS2353: Object literal may only specify known properties —
   'accessiblePacksOnly'`):
   - `When enumerateObjects runs with default options` → **Then** the ids include the
     refused pack's ids (requirement 9 / Pin M1's `cat-file` column). This row fails
     loudly if anyone ever makes the filter the default.
   - `When enumerateObjects runs with accessiblePacksOnly: true` → **Then** the refused
     pack's ids are absent and the healthy pack's + loose ids are present.
   - `When enumerateObjects runs with includePacks: false and accessiblePacksOnly: true`
     → **Then** the result equals the loose ids alone — **own `it`**, because one test
     setting both flags proves neither gate.
   plus a **second** `describe('Given an oid present both loose and in the
   header-refused pack', …)` > `describe('When enumerateObjects runs with
   accessiblePacksOnly: true', …)` → **Then** that oid is still enumerated (Pin M3's
   per-pack, not per-object, rule) — a separate `Given` because its arrangement
   differs.
2. **GREEN** — add the field and thread the boolean into `collectPackedObjectIds`.
3. **REFACTOR** — `npm run docs:json`; `git add reports/api.json` and include it in this
   part's commit. Confirm no other `enumerateObjects` caller in `src/` exists
   (`fsck.ts:35` is the only one) so no default changed under anyone.

### Gate

```
npx vitest run test/unit/application/primitives/enumerate-objects.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/enumerate-objects.ts test/unit/application/primitives/enumerate-objects.test.ts
```

### Commit

`feat(enumerate-objects): add an accessible-packs-only enumeration knob`

## Part 3 — the pack-health pass, its exit bits and its findings

### Context

**Goal.** Requirements 1–12: three `FsckFinding` variants, two named exit bits, a third
pass beside the two that exist, and `fsck`'s universe narrowed in the modes where the
pass runs. This is the part where Pin O3/O4's **nine spurious `bad-object` findings
disappear** and exit bit 4 appears — in opposite directions at once, which is why every
row asserts `exitCode` **and** the findings array.

**Files to change**

1. `src/application/commands/internal/fsck/types.ts` (79 lines). Append three variants
   to the `FsckFinding` union (ADR-583/584/586):

   ```ts
   | { readonly type: 'pack-inaccessible';        readonly pack: string; readonly reason: string }
   | { readonly type: 'pack-index-unusable';      readonly pack: string; readonly reason: string }
   | { readonly type: 'pack-rev-index-unusable';  readonly pack: string; readonly reason: string }
   ```

   `pack` is the base name (`pack-<sha>`), the value `isSafePackName` already vetted —
   say so in the doc-comment (§D10 T-3: it crosses the library boundary as data no
   sanitiser touches, and no newline can be smuggled into a line-oriented sink).
   Also fix `FsckResult.exitCode`'s doc-comment (`:77`), which today reads
   *"Composite exit bitmask: 0=clean, 2=missing/broken-link"* and is already stale (it
   names neither bit 1 nor bit 8): enumerate 1 / 2 / 4 / 8 / 64 and say bits compose by
   OR.

2. `src/application/commands/internal/fsck/exit-codes.ts` (13 lines). Add, in the
   file's existing pinned-comment convention:

   ```ts
   // bit 4  = pack inaccessible / index not opened (git's ERROR_PACK)
   // bit 64 = reverse index unusable               (git's ERROR_PACK_REV_INDEX)
   export const EXIT_PACK = 4;
   export const EXIT_PACK_REV_INDEX = 64;
   ```

   The file header currently claims *"pinned against real git 2.54.0"* — widen it
   honestly: bits 1/2/8 against 2.54.0, bits 4/64 against 2.55.0. `EXIT_PACK_REV_INDEX`
   needs a comment saying tsgit has no reverse-index reader: the bit is a deterministic
   consequence of an unusable `.idx` (git emits it with **no `.rev` file on disk**), so
   the constant's name is a promise the code does not yet keep (§D11.3).

3. **New** `src/application/commands/internal/fsck/pack-health.ts` (ADR-589 — third
   sibling of `content-validation.ts`'s `runContentValidationPass` and
   `refs-verify.ts`'s `runRefsVerifyPass`, both returning `{ findings, exitBit }`):

   ```ts
   export function packPassEnabled(opts: FsckOptions): boolean {
     return opts.full !== false && opts.connectivityOnly !== true;
   }

   export async function runPackHealthPass(
     ctx: Context, opts: FsckOptions,
   ): Promise<{ readonly findings: ReadonlyArray<FsckFinding>; readonly exitBit: number }>;
   ```

   Body: `const { unusable } = await getPackRegistry(ctx).health();` then per entry —
   when `packPassEnabled(opts)`, push `pack-index-unusable` or `pack-inaccessible` by
   layer and OR in `EXIT_PACK`; **ungated**, when the layer is `'index'`, additionally
   push `pack-rev-index-unusable` and OR in `EXIT_PACK_REV_INDEX`. `reason` is
   `'reason' in data ? data.reason : data.code`.
   The pass takes `opts`, not a precomputed boolean, **because bit 64 is ungated**
   (Pin K) — write that reason in a comment or a reviewer reads the parameter as a
   layering slip. Bit 4 is set **once** however many packs are unusable (Pin J14).
   Note the pass runs in **every** mode, including `full: false`, which therefore newly
   reads and parses every `.idx` — the accepted cost of ADR-586 (§D7, §D11.4).

4. `src/application/commands/fsck.ts` (104 lines). Three edits:
   - `:35` becomes
     `await enumerateObjects(ctx, { includePacks: opts.full !== false, accessiblePacksOnly: packPassEnabled(opts) })`.
     **The negative is load-bearing**: in `connectivityOnly` the knob must be **off**,
     because git *includes* a refused pack's ids there (Pin M7) — that is what feeds
     Part 4's classifier.
   - call `runPackHealthPass(ctx, opts)` alongside the other passes and spread its
     findings into the `findings` array at `:72`;
   - `:101` becomes
     `contentResult.exitBit | connectivityBit | refsResult.exitBit | packResult.exitBit`.

**Test files**

- `test/unit/application/commands/fsck.test.ts` (2509 lines). `sut` = `fsck`. Existing
  helpers at the top of the file to reuse: `makeBlob` / `makeTree` / `makeCommit` /
  `makeTag`, `initBareCtx()` (memory ctx + seeded `HEAD`), `buildSeededContext`,
  `writeSyntheticPack` (`:11`), `writeObject`, `looseObjectPath`, `objectsDir`.
  Existing packed-object rows live at `:1633` and `:1696` — model the new fixtures on
  them. A refused pack is `writeSyntheticPack(ctx, name, [...])` followed by
  `restampPackHeader(ctx, packPath, { version: 99 })` (import it — `fsck.test.ts` does
  not import it yet); a corrupt `.idx` is `ctx.fs.write(idxPath, new Uint8Array(1072))`
  (clears the parser's minimum-size gate, then fails the v2 magic check — the
  `pack-degraded-idx` scenario's `CORRUPT_IDX_BYTES` idiom).
  A synthetic pack's objects exist **only** in the pack, which is exactly the "objects
  nowhere else" arrangement Pin M1 needs.
- `test/unit/application/commands/fsck.properties.test.ts` (326 lines, lens 2,
  invariants I1–I5, `fc` + `buildSeededContext`, `numRuns` 50–100). Add I6 and I7.

### TDD steps

1. **RED** — add the pack matrix to `fsck.test.ts`, each row its own `it`
   (expected failure: no `pack-*` finding is ever produced, and `exitCode` stays 0/1):

   | row | Then |
   |---|---|
   | healthy pack | no pack finding; `exitCode & 4` is 0 |
   | v99 pack, objects only there | **exactly one** `pack-inaccessible` whose `pack` is the base name; `exitCode & 4` set; **zero** findings carrying an id from that pack — asserted **positively** over the pack's id list, not as "no `bad-object`" |
   | header/index count disagreement | same shape; the finding's `reason` names both counts |
   | corrupt `.idx` | one `pack-index-unusable` **and** one `pack-rev-index-unusable`; `exitCode & 4` and `exitCode & 64` both set |
   | **orphan `.idx`** — **own `it`** | **no** finding at all, `exitCode === 0` (the only test that kills the orphan branch's `BlockStatement` mutant) |
   | two unusable packs | two findings; bit 4 set once (`exitCode & 4` === 4) |
   | v99 + healthy twin holding the same ids | the objects are still classified `dangling`/`unreachable` **and** the pack is reported (Pin M3) |
   | v99 pack holding every reachable object | pack finding **plus** `missing` + `broken-link`; bits 2 **and** 4 both set (requirement 8, Pin M5) |
   | `connectivityOnly: true` — **own `it`** | no `pack-inaccessible`; bit 4 absent |
   | `full: false` — **own `it`** | no `pack-inaccessible`; bit 4 absent (one test setting both options proves neither gate) |
   | `strict: true` | bit 4 unchanged (Pin K) |
   | `connectivityOnly: true` + corrupt `.idx` | `pack-rev-index-unusable` present, bit 64 set, bit 4 **absent** — the row that isolates ADR-586's ungated term |

2. **RED** — add I6 and I7 to `fsck.properties.test.ts` (`numRuns: 50`; each run builds
   a repo and crafts a pack, so this is the expensive tier):
   - **I6 — additivity (default mode).** For an arbitrary healthy repo, dropping in
     **one** unusable pack — fault shape drawn by `fc.constantFrom` over
     {v99, bad signature, short pack, count disagreement, garbage `.idx`,
     truncated `.idx`} — adds **exactly one gated** finding (`pack-inaccessible`
     **xor** `pack-index-unusable`), sets bit 4, and leaves the **non-pack** findings
     set-equal to the same repo's baseline run. The oracle is the baseline run of the
     same repo, never a re-implementation of the classifier.
     **Count the gated variants only.** An index-layer draw also emits its ungated
     `pack-rev-index-unusable` companion, so a naive "exactly one `pack-*` finding"
     shrinks to a counterexample that is correct behaviour.
     The io-fault shapes (`.pack` unreadable / vanished) are **deliberately absent**
     from the set: a pack-layer `FILE_NOT_FOUND` needs the `.pack` to exist at scan
     time and be gone by the probe, an interleaving a single `fsck` call cannot
     express — the unit matrix covers both io codes with their own rows.
   - **I7 — cardinality and bit idempotence (default mode).** For an arbitrary healthy
     repo and arbitrary `N ∈ [1, 4]`, `N` unusable packs add **exactly `N` gated**
     findings while bit 4 is set exactly once. No finite example table proves this for
     arbitrary `N`; the two-pack example row only proves it for `N = 2`.
3. **GREEN** — land the four source edits above in dependency order (types → exit-codes
   → pack-health → fsck).
4. **REFACTOR** — check `fsck.ts` still reads as one function; verify no existing
   `fsck.test.ts` row regressed (the whole file runs in the gate). Run
   `npm run docs:json` and commit `reports/api.json` (three new public variants).
   Mutation notes to honour while the code is fresh: the mode gate
   (`full !== false && connectivityOnly !== true`) is one `LogicalOperator` + two
   `ConditionalExpression`s living in **one** place (`packPassEnabled`); the exit-bit OR
   needs both a bit-4-alone row and a bit-4-composes-with-bit-2 row or `|` → `&`
   survives against a zero accumulator.

### Gate

```
npx vitest run test/unit/application/commands/fsck.test.ts test/unit/application/commands/fsck.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/fsck.ts src/application/commands/internal/fsck/pack-health.ts src/application/commands/internal/fsck/types.ts src/application/commands/internal/fsck/exit-codes.ts test/unit/application/commands/fsck.test.ts test/unit/application/commands/fsck.properties.test.ts
```

### Commit

`feat(fsck): report inaccessible packs and unusable pack indexes`

## Part 4 — classify unreadable objects in connectivity-only mode

### Context

**Goal.** ADR-588 + §D12: in `connectivityOnly` mode an object in the universe that
cannot be read is **classified, not dropped** — it appears as `unreachable` and, when
no readable object references it, also as `dangling`, with
`objectType: 'unknown'`. Requirements 17 (partly — the retention half is Part 5) and 18.

**The two traps, stated before the code.**
1. **The gate is `connectivityOnly` alone and must not consult `full`.** Part 3's pack
   gate *excludes* `connectivityOnly`; this one *requires* it. The two predicates are
   **disjoint** — no option set turns both on — so there is no shared helper to extract
   and any attempt to write one is a bug in both directions (Pin M7 vs M8, §D11.11).
2. **The widening keys on the object-cache entry being `null`, not on "the content pass
   complained".** A hash-path mismatch decodes fine (non-null entry, real type) yet the
   content pass flags it; keying on the wrong one silently retypes a readable blob as
   `'unknown'` (Pin P6/O14, §D11.12).

**Files to change**

1. `src/application/commands/internal/fsck/types.ts` — widen **two** existing variants
   only:
   ```ts
   | { readonly type: 'dangling';    readonly id: ObjectId; readonly objectType: FsckObjectType | 'unknown' }
   | { readonly type: 'unreachable'; readonly id: ObjectId; readonly objectType: FsckObjectType | 'unknown' }
   ```
   and add `export type UnreadableMode = 'skip' | 'classify';`.
   **`FsckObjectType` (`src/domain/fsck/types.ts:2`) does NOT change** — it is a domain
   type naming the kinds the validator operates on, and `validate-object.ts:11`,
   `content-validation.ts:15`, `reachability.ts:49`/`:58`/`:108` and the `tagged`
   finding all depend on that meaning. Field-level widening is the existing house
   idiom (`missing.objectType`, `broken-link.toType`, `bad-object.objectType` already
   read `FsckObjectType | 'unknown'`).
   **`UnreadableMode` must NOT be re-exported from `fsck.ts`** (`fsck.ts:23` re-exports
   only `FsckFinding`, `FsckOptions`, `FsckResult`) — it stays out of `api.json`.
2. `src/application/commands/internal/fsck/reachability.ts` (226 lines):
   - `collectTypeFindings` (`:204-217`) gains a trailing `unreadable: UnreadableMode`
     parameter and becomes
     ```ts
     for (const id of ids) {
       if (objectCache.get(id) == null && unreadable === 'skip') continue;
       findings.push({ type, id, objectType: resolveObjectType(id, objectCache) });
     }
     ```
     Route through `resolveObjectType` (`:220-226`) rather than re-deriving the type
     inline: it already returns `FsckObjectType | 'unknown'`, it is already the one
     place `fsck.ts:87` resolves a type it may not know, and it reads the cache with a
     **loose `!= null`** test — a `has(id)` check or a strict `!== null` would
     distinguish "absent key" from "stored null" and break the remaining equivalence
     argument in `object-cache.ts` (§D12.4). Part 5 adds its third argument.
   - **Delete the `// Stryker disable next-line BlockStatement` comment at `:163`**
     (above the `if (obj == null) { state.reached.add(id) }` arm in
     `buildReachableSet`). Its equivalence premise — *"corrupt objects are not emitted
     as findings by `collectTypeFindings`"* — is exactly what this part makes
     conditional. Deleted, **not** re-justified. The now-live mutant (dropping
     `reached.add(id)`) is killed by the reachable-unreadable `connectivityOnly` row
     below: without `reached.add`, a *reachable* unreadable object leaves `reached`,
     `classifyObjects` reports it `unreachable`/`'unknown'`, and git is silent there.
   - `buildInEdgeMap`, `buildReachableSet` and `classifyObjects` are otherwise
     **untouched** (requirement 18). Pin Q5/Q6 show git applies its ordinary
     dangling-vs-unreachable rule to objects it cannot type, and these three already
     compute exactly that: `buildInEdgeMap` skips null entries, so an unreadable object
     supplies no out-edges and can never demote another object.
3. `src/application/commands/fsck.ts`:
   ```ts
   const unreadable: UnreadableMode = opts.connectivityOnly === true ? 'classify' : 'skip';
   ```
   computed **once**, passed to both `collectTypeFindings` calls (`:93-94`). Part 5
   threads the same value into `buildObjectCache` — one predicate, one origin.

**The reachable path is safe by construction, not by a guard**: `buildReachableSet`
adds an unreadable *reached* object to `reached` and `classifyObjects` skips everything
reached, so such an object never reaches `collectTypeFindings`. That is what keeps
Pin P7/P8/O15 (git silent, tsgit silent) true with nothing written to preserve it.

**Test files.** `test/unit/application/commands/fsck.test.ts` and
`fsck.properties.test.ts`. Fixture notes — the first is a trap that will otherwise cost
a failing row:

- **Two different unreadable-loose fixtures are needed, and they are not
  interchangeable.**
  - *Unopenable* — wrap `ctx.fs.read` to reject `permissionDenied(path)` for that one
    loose path (the `pack-registry.test.ts:430` idiom). Usable **only in
    `connectivityOnly`**: in default mode `tryGetRawObjectBody`
    (`content-validation.ts:37`) calls `looseCompressedBytes` **outside** any `catch`,
    so `fsck` *throws* `PERMISSION_DENIED` today. That is a pre-existing divergence on
    a different axis (git records exit bit 1), explicitly out of scope and **not** to
    be closed, worked around, or asserted here.
  - *Empty* — a zero-byte file written straight to `looseObjectPath(gitDir, oid)`. Its
    read fails inside the cache (`DECOMPRESS_FAILED` on an empty stream) **and** it
    resolves in default mode with a `bad-object` + exit bit 1, so it is the fixture the
    default-vs-connectivity-only **mode pair** must use. That pair is what kills the
    mode gate's `ConditionalExpression` and both `StringLiteral` mutants.
- Garbage-zlib bytes are **Part 5's reject class** and must not appear in this part's
  rows.
- A refused pack is Part 3's `writeSyntheticPack` + `restampPackHeader({ version: 99 })`.
- The hash-path-mismatch fixture already exists in `fsck.test.ts` (search
  `hash-mismatch`) — reuse it.
- Existing `connectivityOnly` rows in the file (`:1060`, `:1766`) assert only the
  absence of `bad-object` findings on **reachable** objects and are unaffected; the
  whole file runs in the gate, so any surprise is caught.

### TDD steps

1. **RED** — the §D12 matrix in `fsck.test.ts`. Every row asserts the `objectType`
   **value**, never just the finding's presence — a presence-only assertion passes on
   the old code for the typed rows and on a mis-keyed widening for the untyped ones.

   | row | arrangement | Then |
   |---|---|---|
   | refused pack, `connectivityOnly` | v99 pack whose ids nothing else supplies | one `dangling`/`'unknown'` **and** one `unreachable`/`'unknown'` per id; `exitCode === 0` |
   | refused pack, **default** | same fixture | **zero** `dangling` and **zero** `unreachable` for those ids — the row that fails if the gate is inverted |
   | refused pack, **`full: false`** — **own `it`** | same fixture | zero findings for those ids (`full: false` and `connectivityOnly` disagree here) |
   | **unopenable** loose object, unreferenced, `connectivityOnly` | one loose object whose read rejects `PERMISSION_DENIED`, no packs present | `dangling`/`'unknown'` + `unreachable`/`'unknown'`; `exitCode === 0` |
   | **empty** loose object, unreferenced, `connectivityOnly` | zero-byte file at a loose path, no packs present | `dangling`/`'unknown'` + `unreachable`/`'unknown'`; `exitCode === 0` |
   | same **empty** fixture, **default** — **own `it`** | — | **no** `dangling`, **no** `unreachable` for that oid; a `bad-object` for it **is** present and `exitCode & 1` is set — the mode pair that catches an ungated widening |
   | **reachable** unreadable object, `connectivityOnly` | damaged blob referenced by a reachable tree | **no** `dangling`, **no** `unreachable`, no `missing`, `exitCode === 0`. **This row kills the deleted `reachability.ts:163` directive's mutant** |
   | decodable object failing its hash check, `connectivityOnly` | hash-path-mismatch fixture | `dangling`/**`'blob'`** — the real type, proving the widening keys on the null cache entry |
   | in-edge demotion, `connectivityOnly` | two unreadable ids, one of them referenced by a **readable** object | the referenced one is `unreachable` only; the other is `unreachable` **and** `dangling` — proves `buildInEdgeMap` still governs (requirement 18) |
   | healthy repo, all three modes | no damage | findings identical to today in every mode — the no-op guard for a widening that leaks |

2. **RED** — **I8, mode complementarity**, in `fsck.properties.test.ts` (`numRuns: 50`,
   two `fsck` runs per case over one fixture): for an arbitrary healthy repo plus one
   unusable pack, let `S` be the id set the pack's `.idx` names that the repo does not
   otherwise hold. The **default** run contains ≥ 1 pack finding and **zero** findings
   carrying an id in `S`; the **`connectivityOnly`** run contains **zero** pack findings
   and exactly one `dangling`/`'unknown'` *and* one `unreachable`/`'unknown'` per id in
   `S`. No option set produces both halves.
   **Two fixture constraints, both load-bearing.** (a) The fault shape must be drawn
   from the **pack-layer** set only ({v99, bad signature, short pack, count
   disagreement}) — an index-layer fault leaves the `.idx` unparseable, so `S` is empty
   and the `connectivityOnly` half is vacuous, *and* its ungated
   `pack-rev-index-unusable` finding falsifies "zero pack findings" for correct
   behaviour. (b) The pack's contents must be **distinct** from the repo's own objects,
   or `S` silently shrinks toward empty and the property proves nothing while staying
   green.
   **Precondition to write down in the property's comment:** the arbitrary damages a
   *pack* and leaves every loose object intact, so a generated repo's failing reads are
   `OBJECT_NOT_FOUND` — outside Part 5's probe entirely. Any later arbitrary that learns
   to damage a loose object, or to damage a readable pack's *entry bodies* rather than
   its header, must state which side of the header-recovery split it generates, or I8's
   literal `'unknown'` expectation starts shrinking to a counterexample that looks like
   a classification bug and is not.
3. **GREEN** — land the three source edits.
4. **REFACTOR** — re-read the two `collectTypeFindings` call sites: the mode is a named
   `'skip' | 'classify'` (a `BooleanLiteral` gate would need the same two killing rows,
   so the string union costs nothing in mutation terms and reads better). Run
   `npm run docs:json`, commit `reports/api.json` (two **existing** variants change —
   a reviewer diffing the report should expect edits, not only additions).

### Gate

```
npx vitest run test/unit/application/commands/fsck.test.ts test/unit/application/commands/fsck.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/fsck.ts src/application/commands/internal/fsck/types.ts src/application/commands/internal/fsck/reachability.ts test/unit/application/commands/fsck.test.ts test/unit/application/commands/fsck.properties.test.ts
```

### Commit

`feat(fsck): classify unreadable objects in connectivity-only mode`

## Part 5 — reject when no stored header can be recovered, and type from it when one can

### Context

**Goal.** ADR-590 + ADR-591 (§D13, §D13.8). One probe answers two questions, which is
why they land together: *can the `<type> <size>\0` header be recovered from this
object's stored form?* — if **no** and the object is unreached and no pack claims it,
`fsck` **rejects** (git's `die()`: exit 128, empty stdout, every finding withheld); if
**yes**, the recovered type is kept and replaces `'unknown'`. Requirements 17
(retention half), 19.

**The discriminator does not classify the error — it re-asks git's question.** An
allow-list over the thrown code is wrong on three pinned rows:
`INVALID_OBJECT_HEADER` is also what `splitObject` (`src/domain/objects/git-object.ts:24`)
raises for a **size mismatch** on a header that parsed perfectly (git prints
`dangling blob`, exit 0); `DECOMPRESS_FAILED` is also what a corrupt **pack entry**
produces and what a garbled loose file produces while a healthy packed copy exists
(both exit 0); `PERMISSION_DENIED` and an *empty* file both reach the same `catch` and
both must keep Part 4's `dangling unknown`.

**After this part, `'unknown'` is a reserved verdict**: it means *no stored header
could be obtained at all* — an unopenable file, an empty file, or an id only a refused
pack supplies — and nothing else. `resolveObjectType`'s fallback still reads
`obj != null ? obj.type : 'unknown'` and looks complete on its own; the retention map
is the second half of that sentence and lives one file away (§D11.16).

**Files to change**

1. `src/application/commands/internal/fsck/object-cache.ts` (38 lines today, ≈150
   after). Current body:
   ```ts
   export type CachedGitObject = GitObject | null;
   export async function buildObjectCache(ctx, universe): Promise<ReadonlyMap<ObjectId, CachedGitObject>> {
     const cache = new Map(); const shallow = await loadShallowSet(ctx);
     for (const id of universe) {
       try { const obj = await readObject(ctx, id, { verifyHash: false });
             cache.set(id, obj.type === 'commit' ? applyGraft(obj, shallow) : obj); }
       catch { cache.set(id, null); }
     }
     return cache;
   }
   ```
   New shape:
   - `buildObjectCache(ctx, universe, unreadable: UnreadableMode): Promise<ObjectCacheResult>`
     with
     ```ts
     export interface ObjectCacheResult {
       readonly cache: ReadonlyMap<ObjectId, CachedGitObject>;
       /** oid → the fault that made its stored type unrecoverable. Empty unless 'classify'. */
       readonly unrecoverable: ReadonlyMap<ObjectId, DecodeError>;
       /** oid → the type its stored header declares, when the body would not parse. Empty unless 'classify'. */
       readonly recovered: ReadonlyMap<ObjectId, FsckObjectType>;
     }
     ```
   - the `catch` arm keeps `cache.set(id, null)` and gains the branch of §D13.3:
     ```ts
     } catch (err) {
       cache.set(id, null);
       if (unreadable === 'classify' && isDecodeFault(err)) {
         const recovery = await recoverStoredType(ctx, id);
         if (recovery.kind === 'typed') recovered.set(id, recovery.objectType);
         if (recovery.kind === 'unrecoverable') unrecoverable.set(id, recovery.cause);
       }
     }
     ```
   - **Delete the `// Stryker disable next-line BlockStatement` at `:32`.** Its
     equivalence premise is that the `catch` block has exactly one statement; it now
     has a second, observable one. Deleted, not re-justified — the third
     carried-forward equivalence proof in this neighbourhood a data-shape change
     falsifies. The now-live mutant is killed by any rejecting row.
   - `isDecodeFault` — a **`Set` membership test over a named constant array**, not a
     `||` chain (one `ArrayDeclaration` mutant instead of nine `LogicalOperator`
     operands): `DECOMPRESS_FAILED`, `INVALID_OBJECT_HEADER`, `INVALID_TREE_ENTRY`,
     `INVALID_COMMIT`, `INVALID_TAG`, `INVALID_IDENTITY`, `INVALID_FILE_MODE`,
     `INVALID_OBJECT_ID`, `TREE_ENTRY_LIMIT_EXCEEDED` (all verified present in
     `src/domain/objects/error.ts` / `src/domain/error.ts`). It is an **allow-list, so
     it fails toward today**: a parse code missing from it yields `'unknown'`, never a
     wrong type and never an abort. **Not one member can come from `ctx.fs`**, so
     `PERMISSION_DENIED` (Pin P2) and `OBJECT_NOT_FOUND` (a refused pack's ids) never
     enter the probe — that is the structural reason the refused-pack row pays no
     syscalls and stays `'unknown'`.
   - the abort-class type guard:
     ```ts
     type DecodeError = TsgitError & {
       readonly data: { readonly code: 'DECOMPRESS_FAILED' | 'INVALID_OBJECT_HEADER'; readonly reason: string };
     };
     function isRecoveryCandidate(err: unknown): err is DecodeError
     ```
   - `recoverStoredType(ctx, id)`, the five steps, each with the pin that forbids
     removing it:
     1. `looseCompressedBytes(ctx, id)` (exported from
        `src/application/primitives/object-resolver.ts:219`) returns `undefined` ⇒ the
        object is **not loose**, so the failure was a pack read ⇒ arm 2 (`packedStoredType`).
        No I/O: it answers from the per-prefix fanout set the failing read already
        warmed (`internal/loose-oid-cache.ts`).
     2. `bytes.length === 0` ⇒ `{ kind: 'untyped' }` — git treats an empty file as one
        it could not read, not one whose type it failed to recover.
     3. `parseHeader(await ctx.compressor.inflate(bytes))` — **`parseHeader`
        (`src/domain/objects/header.ts:8`), NOT `splitObject`**. That one line is what
        keeps the size-mismatch row out of the abort class, because `splitObject` adds
        a size check git does not make here.
     4. it returns ⇒ `{ kind: 'typed', objectType: type }` (arm 1, **no extra I/O
        whatsoever** — the type is a field of the value step 3 already produced).
     5. it throws ⇒ narrow `catch`: `if (!isRecoveryCandidate(probeErr)) throw probeErr;`
        (a file that changed under the probe surfaces its own fault instead of being
        laundered into an abort), then §D13.2's last question —
        `const hit = await getPackRegistry(ctx).lookup(id)`; a **hit** means a pack
        still claims the oid ⇒ arm 3 (`typeFromEntry(ctx, hit)`, git serves it from the
        pack and exits 0); `undefined` ⇒ `{ kind: 'unrecoverable', cause: probeErr }`.
        It is `lookup`, **never `health()`** — `lookup` is the lazy, index-claim-gated
        read path, and routing this through `health()` would silently break the
        refused-pack row. It is placed **last** on purpose: the only step that can touch
        a pack, reached only by a damaged, loose, non-empty, header-unrecoverable object.
   - the pack arm, one function reached from two places (arms 2 and 3 are one code
     path): `typeFromEntry(ctx, registry, id, hit)` reads a bounded slice
     (`hit.pack.readSlice(hit.offset, ENTRY_HEADER_PROBE_BYTES)` with
     `ENTRY_HEADER_PROBE_BYTES = 64` — a comment must justify the bound: 1 type/size
     byte + ≤5 size-extension bytes + max(5 OFS-distance bytes, 32 digest bytes) ≤ 38
     for either hash width) and parses it with `parsePackEntryHeader(chunk, 0, ctx.hashConfig)`
     (`src/domain/storage/pack-entry.ts:159`). On a base entry (`PACK_ENTRY_TYPE`
     COMMIT/TREE/BLOB/TAG) return `packEntryTypeToObjectType(header.type)` (`:228`). On
     `OFS_DELTA` follow `hit.offset - header.baseDistance` **in the same pack** (guard
     `baseOffset >= 0`); on `REF_DELTA` `await registry.lookup(header.baseId)` and
     continue from that hit. Bound the walk with `MAX_DELTA_CHAIN_DEPTH`
     (`src/domain/storage/delta.js`). **The walk never inflates a body** — it resolves
     the type through entry headers only, exactly as git does, which is why a corrupt
     delta body still types. Any fault inside the walk (or an exhausted bound, or a
     `REF_DELTA` base no pack claims) yields `{ kind: 'untyped' }` plus one
     `ctx.logger?.warn?.('fsck: stored type unrecoverable', { objectId: id, reason })`
     — flat string values only, per the Logger port's top-level-string sanitiser.
   - `assertTypesRecoverable(ctx, unreachable, unrecoverable)`: iterate the
     `unreachable` **array** (git's `check_unreachable_object` domain — **never
     `dangling`**, which is its in-edge-free subset and would silently pass an
     unreachable-but-referenced object); on the first id present in the map, emit
     exactly one `ctx.logger?.warn?.('fsck: object type unrecoverable', { objectId: id, reason: cause.data.reason })`
     and **`throw cause`** — the store's own `TsgitError`, rethrown, not re-wrapped and
     not re-coded (zero public surface: no new `TsgitErrorData` arm, no `formatError`
     case). With several unrecoverable ids the guard rejects on the first in
     `unreachable` order, which is `universe` order; no test asserts across that order.
2. `src/application/commands/internal/fsck/reachability.ts`:
   - `resolveObjectType(id, objectCache, recovered)` gains one fallback line and no new
     `'unknown'` derivation:
     ```ts
     const obj = objectCache.get(id);
     if (obj != null) return obj.type;
     return recovered.get(id) ?? 'unknown';
     ```
   - `collectTypeFindings(ids, type, findings, objectCache, recovered, unreadable)`
     passes it through. One resolver, two call sites, one meaning.
3. `src/application/commands/fsck.ts`:
   - `const { cache, unrecoverable, recovered } = await buildObjectCache(ctx, universe, unreadable);`
     (the `unreadable` value Part 4 already computes; every existing consumer now reads
     `cache`);
   - `assertTypesRecoverable(ctx, unreachable, unrecoverable);` **immediately after
     `classifyObjects` (`:70`)** — the first point at which the `unreachable` array
     exists. In `'skip'` mode the map is never populated, so the guard is a total
     function over an empty map and **no mode test appears at the call site**: default
     and `full: false` stay byte-identical to today by construction, not by a second
     gate;
   - thread `recovered` into both `collectTypeFindings` calls and into `:87`'s
     `resolveObjectType`. That `missing` call site is unchanged **by construction**: a
     missing id is by definition outside the universe, so it has neither a cache entry
     nor a recovery entry.

**`recovered` is a sibling of the cache, never a substitute entry inside it.** Putting a
`{ type }` stub in `cache` is the shorter diff and is wrong: `buildInEdgeMap` and
`buildReachableSet` both branch on `obj == null`, so a stub would turn an undecodable
object into a readable one with no out-edges and change reachability on exactly the rows
that must stay silent — and `visitObject` would then read fields a stub does not have.
The map is consulted at emission and nowhere else (requirement 18).

**Retention is monotone**: it can only replace `'unknown'` with a real type. It adds no
finding, removes none, touches no exit bit, and cannot change an abort verdict.

**Import paths for `object-cache.ts`** (same directory as `content-validation.ts`, so
copy its depths): `looseCompressedBytes` from `'../../../primitives/object-resolver.js'`;
`getPackRegistry` from `'../../../primitives/read-object.js'` (the module it already
imports `readObject` from); `parseHeader` and `FsckObjectType` from
`'../../../../domain/objects/index.js'` / `'../../../../domain/fsck/index.js'`;
`TsgitError` from `'../../../../domain/error.js'`; `parsePackEntryHeader`,
`PACK_ENTRY_TYPE`, `packEntryTypeToObjectType` from
`'../../../../domain/storage/index.js'`.

**Test file:** `test/unit/application/commands/fsck.test.ts`. Fixture idioms already in
the file: `writeMalformedLooseObject(ctx, rawBytes)` (`:766`) and `buildLooseBytes(type, body)`
(`:778`) write hand-built loose bytes; `:1559-1601` writes non-inflatable bytes to a
`looseObjectPath`, and `:1600` deflates hand-built header bytes under an arbitrary
40-hex oid (`enumerateObjects` lists loose objects by directory entry name, so the oid
need not hash the content). A packed-only object comes from `writeSyntheticPack` with
its loose copy absent by construction; a corrupt packed **entry body** is produced by
flipping one byte of the entry's deflate stream in the written `.pack`; a corrupt
**delta** entry uses `writeSyntheticPack`'s `ofs-delta` / `ref-delta` specs
(`test/unit/application/primitives/pack-fixture.ts:39-58`) with a byte of the delta
entry's compressed body flipped.

Three fixture rules that keep the assertions clean:

- **Every "valid zlib, bad header or bad body" fixture goes through
  `writeMalformedLooseObject`**, which hashes the *raw* bytes and writes at that oid's
  path. A fixture written at an arbitrary oid would additionally produce a
  `hash-mismatch` finding + exit bit 1 in the default-mode rows and muddy exactly the
  assertion those rows make.
- **Non-inflatable garbage and the empty file are written directly**
  (`ctx.fs.write(looseObjectPath(gitDir, oid), bytes)`) under an arbitrary 40-hex oid —
  they never decode, so the content pass returns before its hash check and no
  `hash-mismatch` appears. `enumerateObjects` lists loose objects by directory entry
  name, so the oid need not hash the content.
- **Default-mode rows assert `exitCode & 1` plus zero `dangling`/`unreachable` for that
  oid** — not a specific `msgId`. The catalogue's verdict on a junk tree body is
  `content-validation.test.ts`'s business, not this part's.

Two arrangements worth spelling out because they are easy to get subtly wrong:

- **unreachable-but-referenced**: write the garbage bytes first at a chosen oid, then
  `writeObject(ctx, makeTree([{ mode: FILE_MODE.REGULAR, name: 'f', id: thatOid }]))`
  and **no ref**. The tree is readable and itself unreachable, so
  `buildReachableSet` never enqueues its entries, while `buildInEdgeMap` — which scans
  the whole universe — still records the blob's in-edge. The blob is therefore
  `unreachable` **but not** `dangling`, which is exactly the row that fails if the guard
  is fed `dangling`.
- **probe-fault propagation**: use a repo whose universe is that one garbage object
  (`initBareCtx()` + the garbage file) and wrap `ctx.compressor` so the **second**
  `inflate` call rejects. Call 1 is the object-cache read (which must still throw its
  real `DECOMPRESS_FAILED`); call 2 is the probe's. Any larger repo makes the call index
  depend on iteration order.

**Two rows of the matrix below already exist**, added by Part 4: the *empty file* row
and the *unopenable* row, both `connectivityOnly`, both asserting `'unknown'`. They are
listed here because they are ADR-591's boundary — the retention must **not** reach them
— so this part **re-verifies** them and must not duplicate them.

### TDD steps

1. **RED** — the §D13 matrix in `fsck.test.ts`. Every **rejecting** row asserts the
   error's `.data` through `try`/`catch` (the code *and* the reason distinguish the two
   abort classes). Every **tolerating** row asserts a **resolved** result *and* the
   `objectType` value — after ADR-591 that assertion does two jobs: it proves the run
   resolved, and it proves which store typed the object. Each row is its own `it`; they
   are the four conjuncts of requirement 19 and no two may share an arrangement.

   | row | arrangement | Then |
   |---|---|---|
   | undecodable, dangling, `connectivityOnly` | one loose object whose bytes are non-zlib garbage, no packs | **rejects**; `.data.code === 'DECOMPRESS_FAILED'` |
   | same fixture, **default** | — | **resolves**; a `bad-object` finding, `exitCode & 1` set, no `dangling`/`unreachable` for that oid |
   | same fixture, **`full: false`** — **own `it`** | — | **resolves**, same as default |
   | same fixture, **`connectivityOnly` + `full: false`** | — | **rejects** — fails if the gate ever consults `full` |
   | unrecoverable header, dangling, `connectivityOnly` | valid zlib whose inflated bytes carry no NUL in the first 32 | **rejects**; `.data.code === 'INVALID_OBJECT_HEADER'` and `.data.reason` asserted |
   | unknown type name, dangling, `connectivityOnly` — **own `it`** | valid zlib, header `widget 5\0` | **rejects**; `.data.reason` names the type |
   | size mismatch, dangling, `connectivityOnly` | valid zlib, header `blob 99\0` over 2 content bytes | **resolves**; `dangling`/**`'blob'`** — forbids keying the abort on `INVALID_OBJECT_HEADER` as a code |
   | unparseable body / valid header, dangling, `connectivityOnly` | header `tree 4\0` over 4 junk bytes | **resolves**; `dangling`/**`'tree'`**, `exitCode 0` — one row, two claims: the abort catch never sees it, and `isDecodeFault` admits `INVALID_TREE_ENTRY` so arm 1 types it |
   | same fixture, **default** — **own `it`** | — | **resolves**; `bad-object`, `exitCode & 1` set, **no** `dangling`/`unreachable` — proves the retention map is mode-gated (empty in `'skip'`) |
   | empty file, dangling, `connectivityOnly` | **already landed in Part 4** — re-verify | still **resolves**; `dangling`/`'unknown'` — the `length === 0` row and ADR-591's second boundary |
   | unopenable, dangling, `connectivityOnly` | **already landed in Part 4** — re-verify | still **resolves**; `dangling`/`'unknown'` — fails loudly if the probe re-reads, and the row that kills "force `isDecodeFault` true" |
   | **reachable** undecodable, `connectivityOnly` | garbage blob referenced by a reachable tree | **resolves**; no finding for that oid, `exitCode 0` — second killer of the deleted `reachability.ts:163` directive's mutant |
   | unreachable **but referenced**, `connectivityOnly` | garbage blob referenced by a *dangling readable* tree | **rejects** — the only row that fails if the guard is fed `dangling` instead of `unreachable` |
   | **packed** object with an undecodable body, dangling, `connectivityOnly` | corrupt **base** entry in an otherwise accessible pack; the oid is not loose | **resolves**; `dangling`/**`'blob'`**, `exitCode 0` — the step-1 row and arm 2's non-delta leg |
   | **packed `OFS_DELTA`** entry with a corrupt body, dangling, `connectivityOnly` | delta entry whose base is healthy | **resolves**; `dangling`/**`'blob'`** — the base-link walk |
   | **packed `REF_DELTA`** entry with a corrupt body, dangling, `connectivityOnly` — **own `it`** | second encoding, base named by oid | **resolves**; `dangling`/**`'blob'`** — the walker branches on which encoding it sees; the non-delta row alone leaves the walk's body mutant surviving |
   | loose garbled + healthy packed copy, dangling, `connectivityOnly` | same oid loose (garbled) and in a healthy pack | **resolves**; `dangling`/**`'blob'`**, `exitCode 0` — the **only** row that kills the §D13.2 lookup condition, and arm 3's only row. It asserts that nothing happens and is the most droppable-looking row in the matrix; it is the only thing between "simplify this" and an abort git does not perform |
   | two damaged objects, `connectivityOnly` | one healthy dangling blob + one undecodable dangling blob | **rejects**, and the healthy object's findings are unobservable — asserts the abort, not which oid |
   | refused pack, `connectivityOnly` | Part 4's v99 fixture | still **resolves** with `dangling`/`'unknown'` ×N — doubles as the proof that `OBJECT_NOT_FOUND` never enters the candidate set, and as ADR-591's first boundary (a refused pack yields no `lookup` hit, so no type) |
   | corrupt `.idx` **+** undecodable dangling object, `connectivityOnly` | both faults in one repo | **rejects** — the bit-64 term is not observable through a reject; this row exists to forbid a test asserting `exitCode === 64` here |
   | probe fault outside the allow-list propagates — **own `it`** | wrap `ctx.compressor.inflate` so only the **second** call (the probe's) rejects `UNSUPPORTED_OPERATION { operation: 'filesystem' }` | `fsck` rejects with **that exact `.data`** — the §D10 T-6 rule applied to the probe's own allow-list; kills "force `isRecoveryCandidate` true" |

2. **GREEN** — land `object-cache.ts` first (it compiles standalone), then
   `reachability.ts`'s two signatures, then `fsck.ts`'s four lines.
3. **REFACTOR** — keep every helper under 20 lines and the `catch` arms narrow. Verify
   by re-reading §D13.7's row table that **no row moved into or out of the rejecting
   set**: the rejecting set is exactly {non-zlib garbage, header > 32 bytes without a
   NUL, unknown type name, non-numeric size} × {unreached, loose, non-empty, unclaimed
   by any pack}. `buildObjectCache` stays exercised **through `fsck`** — no dedicated
   `object-cache.test.ts`: it has exactly one caller and its new return shape is
   meaningful only in combination with `classifyObjects`. **No `api.json`
   regeneration** — `UnreadableMode`, `ObjectCacheResult` and the guard are
   command-internal and the reject reuses two existing error codes; confirm with
   `npm run docs:json && git diff --stat -- reports/api.json` showing no change.

### Gate

```
npx vitest run test/unit/application/commands/fsck.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/fsck.ts src/application/commands/internal/fsck/object-cache.ts src/application/commands/internal/fsck/reachability.ts test/unit/application/commands/fsck.test.ts
```

### Commit

`feat(fsck): reject on unrecoverable object headers and type findings from the stored header`

## Part 6 — cross-tool interop: the pack axis, on lifted fixture helpers

### Context

**Goal.** Pin the pack-axis rows against real `git` 2.55.0 from identical on-disk bytes
(K-1 … K-21), and lift the crafting helpers out of the suite that already owns them so
the two interop suites cannot drift on the one recipe that must stay identical.
Test-infra only — **no `src/` delta**.

**Helper lifting (do this first).** These helpers live today inside
`test/integration/pack-version-interop.test.ts` (≈ `:41-219`) and move verbatim to a
new `test/integration/pack-fixture-helpers.ts` that both suites import:
`DIGEST_LENGTH`, `sha1`, `restampPackVersion(packBytes, version, origin = 0)`,
`restampIdxForPack(idxBytes, packTrailer)`, `corruptIdxSameLength(idxBytes)`,
`setHeaderObjectCount(packBytes, count)`, `trailerOf(bytes)`, `packStemPaths`,
`ensurePackDir`, `writePack`, `writePackOnly`, `writeIdxOnly`, `writeLooseObject`,
`readSolePackPair(dir)`, `countObjects(dir)`. Keep their doc-comments — including the
one stating the pack subsystem is SHA-1-only end to end (`IDX_SHA_LENGTH = 20` is
hard-coded in `src/domain/storage/pack-index.ts:10` and `pack-writer.ts:63`), so the
helpers hard-code SHA-1 rather than imply a genericity they lack. `pack-version-interop.test.ts`
keeps its own `catFileRaw` / `batchCheck` / `collectPackedIds` / `findPackSignature` /
`blobContent` / `freshRepo` and imports the lifted set. Its 682 lines must stay green —
run it in this part's gate. **Each suite imports exactly the helpers it uses** — biome
flags an unused import, and several lifted helpers (`writeLooseObject`, `writeIdxOnly`)
are consumed by only one of the two suites.

**New file:** `test/integration/fsck-pack-accessibility-interop.test.ts`, with the
`@proves` block the audit parses (`tooling/test-pyramid/parse-proves-header.ts`;
`unique` must be 12–200 chars):

```
 * @proves
 *   surface:        fsck.packAccessibility
 *   bucket:         cross-tool-interop
 *   unique:         fsck pack-accessibility findings and exit bits match canonical git
 *   interopSurface: fsck
```

Imports: `GIT_AVAILABLE`, `git`, `runGit`, `runGitEnv`, `tryRunGitWithExit` from
`./interop-helpers.js` (every git spawn goes through them — they scrub every `GIT_*`
from the env, point `HOME` at a non-existent path and set `GIT_CONFIG_NOSYSTEM=1`;
`git -C <dir>` alone does **not** override an inherited `GIT_DIR`), the lifted helpers,
`createNodeContext` from `src/adapters/node/node-adapter.js` and `fsck` from
`src/application/commands/fsck.js`. Wrap everything in
`describe.skipIf(!GIT_AVAILABLE)(…)`. `sut` = the tsgit `Context`
(`const sut = createNodeContext({ workDir: dir })`, the idiom
`pack-version-interop.test.ts` already uses; `createNodeContext` is on the
`sutBindsResult` allowlist).

**Five harness rules this suite must obey** (each has already cost a false result once):

1. One shared `beforeAll` repo family with an explicit **60 s timeout**
   (`beforeAll(async () => {…}, 60_000)`) — heavy git-spawning interop suites time out
   hooks under `validate`'s concurrency. Model it on
   `pack-version-interop.test.ts:267-298`: seed a donor repo, `git repack -adq`, read
   the sole pack pair, then mutate copies per row into fresh cheap repos.
2. **Build the tsgit `Context` *after* every `git` subprocess write.** The per-`Context`
   loose-object fanout cache is invalidated only by tsgit's own `writeObject`, so a
   `Context` created before a `git repack` sees a stale loose view.
3. **Delete each fixture's `.rev` file before mutating**, or the reverse-index axis
   contaminates the pack rows.
4. **`chmod u+w` before mutating any copied pack file** — a copied `.pack` inherits
   git's read-only mode and a helper that skips this silently measures a *healthy*
   repo.
5. Per-row repos, not one shared mutated repo.

**Assertion discipline** (§D11.6, §D11.7, ADR-249):
- git's cause lines repeat a non-deterministic number of times (git printed
  `non-monotonic index` seven times in one mode and ten in another). Every git-side
  assertion is **"the verdict line occurs exactly once per unusable pack"** — never a
  whole-stderr equality.
- git is **silent about the cause** on two rows (`.pack` `chmod 000`, `.idx` `chmod 000`),
  so only the verdict is comparable there.
- The verdict line is **reconstructed inside the test** from the finding's fields, e.g.
  `` `packfile ${packDir}/${finding.pack}.pack cannot be accessed` `` — the library
  composes no string.
- Two rows assert **differentially**: git splits root failures between stdout
  `missing blob` and stderr `invalid sha1 pointer` while tsgit models both as `missing`,
  a pre-existing shape difference this change neither causes nor fixes. Assert that the
  non-pack bits equal what the *same repo without the bad pack* produces and that bit 4
  is the only added term.

### TDD steps

1. **RED** — create `pack-fixture-helpers.ts` by moving the helpers, and rewrite
   `pack-version-interop.test.ts`'s import list. Expected failure before the move
   completes: `TS2307`/`TS2304` on the moved names. This step ends green on
   `pack-version-interop.test.ts` with **zero** behaviour change.
2. **RED** — write the pack-axis rows in the new suite; they fail against real git until
   Parts 1–5 are in the tree (they are — this part runs after them), so the true RED
   here is a row-by-row mismatch caught the first time the suite runs. Rows:

   | # | row | git assertion | tsgit assertion |
   |---|---|---|---|
   | K-1 | healthy pack | exit 0, no `packfile` line | no pack finding; bit 4 absent |
   | K-2 | pack v3 | exit 0 | no pack finding |
   | K-3 | pack **v99** | exit **4**; the reconstructed verdict occurs **once** | one `pack-inaccessible`; bit 4; **zero** object findings from that pack |
   | K-4 | header/index count disagreement | exit 4; cause `claims to have N objects while index indicates M objects` | one finding whose `reason` carries both counts |
   | K-5 | signature `PACX` | exit 4; cause `is not a GIT packfile` | one finding |
   | K-6 | pack truncated to 8 bytes | exit 4; cause `far too short to be a packfile` | one finding |
   | K-7 | `.pack` `chmod 000` | exit 4; **verdict only**, no cause | one finding; **node tier only** |
   | K-8 | `.idx` same-length garbage | exit **68** | `pack-index-unusable` **and** `pack-rev-index-unusable`; bits 4 \| 64 |
   | K-9 | `.idx` truncated to 8 bytes | exit 68 | same |
   | K-10 | `.idx` `chmod 000` | exit 68; verdict lines only | same; node tier only |
   | K-11 | **orphan `.idx`** | exit **0**, silent | **no finding**; `exitCode 0` |
   | K-12 | **idx-less `.pack`** | exit 0, silent | no finding |
   | K-13 | two unusable packs | exit 4; the verdict occurs **twice**, once per pack | two findings; bit 4 once |
   | K-14 | v99 + healthy twin | exit 4 **and** the objects still reported | objects classified; pack reported |
   | K-15 | v99 + a deleted reachable tree | exit 14 | **differential** (see above) |
   | K-16 | v99 **and** corrupt `.idx`, same pack | exit 68; **no** version line | exactly one finding, index layer — the precedence row |
   | K-17 | mode gating, exit axis | `--connectivity-only` / `--no-full` over the v99 and corrupt-idx repos: 0 / 0 / 64 / 64 | `connectivityOnly` and `full: false` reproduce the same four exits |
   | K-18 | `--strict` | exit 4 unchanged | `strict: true` unchanged |
   | K-19 | v99 pack holding every reachable object | exit 14 | **differential** as K-15; `missing` findings present |
   | K-20 | v99 pack, `--connectivity-only`, findings axis | the `dangling unknown <oid>` lines are **exactly the pack's N oids**, no duplicates, exit 0 | the `dangling` findings with `objectType === 'unknown'` are the **same oid set**, compared as sets |
   | K-21 | v99 pack, `--no-full` | exit 0, **no** `dangling` line at all | zero `dangling`/`unreachable` for the pack's oids — separates the two reduced modes |

   **Fixture precondition for K-20 (do not skip — it silently changes the expected
   count from 9 to 3 to 0).** The donor repo's file bodies must be **distinct** from the
   target repo's. Both are built by the same helper, so the default is *identical*
   content, which makes 6 of 9 oids coincide, and the commit oids coincide too whenever
   the two `git commit` calls land in the same second. Take the body prefix as a helper
   parameter, and assert the count against `git cat-file --batch-all-objects` on the
   donor rather than against a literal 9.
3. **GREEN** — iterate until every row matches on both sides. A mismatch is a **finding
   about the implementation**, not about the test: fix `src/` (in this part, as a
   follow-on commit is not available) or escalate `{ part, reason, ≤3 options }`.
4. **REFACTOR** — factor the per-row "fresh repo + drop a mutated pack in" into one
   local helper so each row reads as arrangement → git assertion → tsgit assertion.
   Confirm `npm run check:test-pyramid` is happy (integration share moves 9.7% → ~10.2%,
   toward its 15% target) and that `tooling/audit-write-surfaces.ts` needs no
   `@writes` edit (this suite writes nothing through tsgit).

### Gate

```
npx vitest run test/integration/fsck-pack-accessibility-interop.test.ts test/integration/pack-version-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/fsck-pack-accessibility-interop.test.ts test/integration/pack-fixture-helpers.ts test/integration/pack-version-interop.test.ts
```

### Commit

`test(fsck): pin pack-accessibility findings against real git`

## Part 7 — cross-tool interop: the loose-object axis, plus cross-adapter parity

### Context

**Goal.** Pin the unreadable-object rows against real git (K-22 … K-37) and prove the
three adapters agree on the verdicts that are only reached when a read **fails**.
Test-infra only — **no `src/` delta**.

**Interop rows** append to the file Part 6 created,
`test/integration/fsck-pack-accessibility-interop.test.ts`, in their own top-level
`describe`. **Arrangement differs from Part 6's**: these repos have **no packs at all**
(except the three rows that say otherwise), so every cell is attributable to the one
damaged object.

**The discipline that has already cost five false cells, one dead row and one
`PermissionError`:** git writes loose objects `0444`, and a copied `.pack` inherits that
mode. **`chmod u+w` before mutating any loose object and any copied pack file.** A
helper that skips this silently measures a *healthy* repo.

**Each loose-object row gets its own repo**, never a shared one with several damaged
objects: the abort rows withhold the whole report, so a second damaged object in the
same fixture can mask exactly the assertion the row exists to make, and the reject's
determinism is defined by universe order, which no fixture may depend on.

| # | row | git assertion | tsgit assertion |
|---|---|---|---|
| K-22 | unreadable loose object, unreferenced, `--connectivity-only` | exit 0, `dangling unknown <oid>` once | one `dangling`, `objectType === 'unknown'`; node tier only (`chmod`) |
| K-23 | same fixture, **default** | exit 1, **no** `dangling` and **no** `unreachable` line **even with `--dangling --unreachable`** | no `dangling`/`unreachable` for that oid — git's side is asserted *with the projection flags on*, which is what makes it a computation difference and not a print filter |
| K-24 | reachable unreadable object, `--connectivity-only` | exit 0, stdout empty | no finding for that oid; node tier only |
| K-25 | hash-path mismatch, `--connectivity-only` | exit 0, `dangling blob <oid>` | one `dangling`, `objectType === 'blob'` — the negative row for the widening |
| K-26 | undecodable loose object, dangling, `--connectivity-only` | exit **128**, **stdout empty** | `fsck({ connectivityOnly: true })` **rejects**, `.data.code === 'DECOMPRESS_FAILED'` |
| K-27 | same fixture, **default** | exit 1 | resolves; exit bit 1 and a `bad-object` — the mode boundary on the *same* bytes as K-26 |
| K-28 | **reachable** undecodable object, `--connectivity-only` | exit 0, stdout **and stderr** empty | resolves; no finding for that oid, `exitCode 0` |
| K-29 | unreachable-**but-referenced** undecodable object, `--connectivity-only` | exit 128, stdout empty | rejects — both tools scope the abort to the unreached set, not the dangling subset |
| K-30 | **empty** loose object, dangling, `--connectivity-only` | exit 0, `dangling unknown <oid>` | resolves; `dangling` with `objectType === 'unknown'` |
| K-31 | valid zlib / unrecoverable header (`widget 5\0`), `--connectivity-only` | exit 128 | rejects, `.data.code === 'INVALID_OBJECT_HEADER'` |
| K-32 | valid header / size disagreement (`blob 99\0`), `--connectivity-only` | exit 0, `dangling blob <oid>` | resolves; `dangling`/`'blob'` — pins the split as header-recovery, not error code |
| K-33 | healthy dangling object **+** undecodable dangling object, `--connectivity-only` | exit 128 and the healthy `dangling` line is **absent** from stdout | rejects — neither tool emits a partial report |
| K-34 | packed-only object with a corrupt entry body, `--connectivity-only` | exit 0, `dangling blob <oid>` | resolves, `exitCode 0` **and `objectType === 'blob'`** |
| K-35 | garbled loose copy **+** healthy packed copy, `--connectivity-only` | exit 0, `dangling blob <oid>` | resolves, `exitCode 0` **and `objectType === 'blob'`** |
| K-36 | packed **delta** entry with a corrupt body, `--connectivity-only` — run for `OFS_DELTA` **and** `REF_DELTA` | exit 0, `dangling blob <oid>` | resolves, `objectType === 'blob'`, `exitCode 0` — against real git-written deltas, which no synthetic single-entry fixture exercises |
| K-37 | valid header over an unparseable body, `--connectivity-only` | exit 0, `dangling tree <oid>` | resolves, `objectType === 'tree'` — git's `too-short tree object` stderr is **not** compared (verdict line only) |

**K-36's fixture recipe** (it failed twice before this recipe was settled): two ~20 KiB
blobs differing in three bytes, written with `git hash-object -w`, packed by
`git pack-objects --window=250 --depth=50 --no-reuse-delta [--delta-base-offset]` over
those two oids alone — so both land packed-only **and** dangling in a fresh target repo
— then one byte of the delta entry's deflate stream flipped, trailer left **as-is**, not
restamped (`--connectivity-only` does not verify it). `chmod u+w` the copied pack first.

**Parity scenario.** New `test/parity/scenarios/fsck-degraded-store.scenario.ts`,
registered in `test/parity/scenarios/index.ts` (import + append to `SCENARIOS`). Model
it on `pack-degraded-idx.scenario.ts` (whole file is the template: `Scenario<TResult>`
from `./types.ts`, `AUTHOR`/`FILES`/`MESSAGES` from `../fixtures.ts`,
`writeScenarioPackPair` from `./pack-pair.ts`, `expected` as a deterministic projection
with **no oids**). The fixture carries, in one repo: one corrupt `.idx` with a sibling
`.pack`, one v99 pack (`writeScenarioPackPair(repo, { name, content, version: 99 })`
stamps the version before the trailer is computed), one healthy pack, and **one
undecodable dangling loose object**. It runs `repo.fsck()` **and**
`repo.fsck({ connectivityOnly: true })` — a single-mode scenario would prove
cross-adapter agreement on exactly the half of the behaviour the widening does not
touch. Projected result fields: pack-finding type counts and exit code in default mode;
the `dangling`/`unreachable` `objectType` **values** (as a sorted census, not oids) in
connectivity-only mode; and the caught `.data.code` from the connectivity-only reject.

Why it earns its place: the discriminators key on `FILE_NOT_FOUND` /
`PERMISSION_DENIED` / `DECOMPRESS_FAILED`, which each adapter produces independently
(node via `mapErrno`, memory via an explicit throw, browser via `resolveFileHandle`),
and a *reporting* surface turns an adapter-specific code difference into a **missing
finding** rather than a thrown error — silent where the old behaviour was loud. The
reject leg has the largest exposure in the whole change: the verdict is reached through
`ctx.compressor.inflate` and every adapter has its own decoder (node's `zlib`, the
memory adapter's `DecompressionStream`, the browser tier's `inflateZlibMember`); a
decoder that returned empty bytes instead of throwing would silently move the object
from the reject class into `dangling unknown` on that adapter alone. ADR-591's retention
rides the same fixture with one added assertion rather than a fourth leg: the v99 pack's
ids must come back `'unknown'` on all three adapters, while the healthy pack contributes
the arm-2 `readSlice` — the one place the retention touches `pack.readSlice` and
therefore the browser tier's handle-less fallback.

**Where the parity legs actually run:** `npm run test:parity` (in `validate`) runs the
node and memory drivers (`test/parity/{node,memory}.test.ts`, project `parity`). The
**browser** leg is `test/browser/parity.spec.ts` under Playwright — `npm run test:e2e`,
**not** part of `validate`; CI is its authority. Do not chase a local browser run.
If the workers runtime-parity job diverges on the reject leg (workerd's
`DecompressionStream` is the known lenient-behaviour risk), the designed escape hatch is
the scenario's `unsupportedRuntimes: ['workers']` field **with the reason documented in
the scenario** — never a weakened expectation. Treat that as a blocker to surface, not a
silent edit.

### TDD steps

1. **RED** — append the loose-axis `describe` and rows K-22 … K-37 to
   `fsck-pack-accessibility-interop.test.ts`, one `it` per row, each with its own
   `mkdtemp` repo. Write the `chmod u+w` step into the shared per-row helper so no row
   can forget it. Expected failure mode on a mistake: a row reports a *healthy* repo
   (exit 0, no findings on both sides) — that is the signature of a skipped `chmod`,
   not a passing row.
2. **RED** — add `fsck-degraded-store.scenario.ts` and register it; run
   `npx vitest run --project parity`. Expected first failure: the `expected` literal
   does not match the computed projection — fill it from the node run, then confirm the
   memory driver agrees **without** touching the expectation.
3. **GREEN** — resolve every mismatch in favour of git (prime directive). A divergence
   here is a finding about Parts 4/5, and fixing it belongs in this part's commit or is
   escalated as `{ part, reason, ≤3 options }`.
4. **REFACTOR** — collapse the repeated fixture crafting into local helpers; verify
   `npm run check:parity-fixtures`, `npm run check:browser-surface` and
   `npm run check:test-pyramid` all pass, and that the new scenario's `expected` object
   carries **no oid** (they differ per run).

### Gate

```
npx vitest run test/integration/fsck-pack-accessibility-interop.test.ts && npx vitest run --project parity && npm run check:types && ./node_modules/.bin/biome check test/integration/fsck-pack-accessibility-interop.test.ts test/parity/scenarios/fsck-degraded-store.scenario.ts test/parity/scenarios/index.ts
```

### Commit

`test(fsck): pin unreadable-object verdicts against real git and every adapter`

## Phase gate

```
npm run validate
```

Then, before any push: re-run `cspell` fresh and confirm `reports/api.json` is
regenerated and committed — a green wireit-**cached** `validate` can still precede a red
prepush, because `check:spelling` and `check:doc-typedoc` cache-skip after later-phase
edits.
