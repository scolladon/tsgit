# Plan — `fsck` (repository integrity check)

> Source: design doc `docs/design/fsck.md` · ADRs `411, 412, 413, 414`
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  mutation/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Orientation (read once — applies to every part)

**Where things are (point-in-time paths, verify before editing):**

- Tier-1 commands live in `src/application/commands/*.ts`; barrel `src/application/commands/index.ts`.
  Closest structured-data precedents: `shortlog.ts`, `whatchanged.ts`, `grep.ts` — signature is
  `(ctx: Context, opts: <Options> = {}): Promise<<Result>>`, one readonly options object, structured
  result, **no rendered strings / no `bytes`** (ADR-249).
- Tier-2 primitives live in `src/application/primitives/*.ts`; barrel
  `src/application/primitives/index.ts`. Public via `src/index.ts`'s `export *` of both barrels and
  the type closure in `src/public-types.ts` (`export type *` of both barrels — so new exported types
  flow automatically once barreled; **no `public-types.ts` edit needed**).
- Domain (pure, zero outward deps) lives in `src/domain/`. `domain/fsck/` does **not exist yet** —
  net-new module (ADR-412).
- The `Repository` facade is `src/repository.ts` (interface members + guarded bindings). Its
  surface-snapshot test is `test/unit/repository/repository.test.ts` (sorted `Object.keys` lists).
- Interop tests: `test/integration/fsck-interop.test.ts` via `test/integration/interop-helpers.ts`'s
  scrubbed `runGit` / `git(dir, ...args)` / `makePeerPair(slug)` / `GIT_AVAILABLE`. Faithfulness
  goldens are computed with signing OFF; gate the peer with `-c merge.conflictStyle=merge` only when
  comparing marker bytes (not relevant to fsck). Heavy git-spawning suites: one shared `beforeAll`
  tmp repo + 60s timeout (memory note: interop load→validate flake).
- Parity scenarios: `test/parity/scenarios/*.scenario.ts` + registration in
  `test/parity/scenarios/index.ts`; `Scenario<TResult>` shape in `test/parity/scenarios/types.ts`.

**Branded types reused (do not re-declare):** `ObjectId`, `RefName` from
`src/domain/objects/object-id.ts` (re-exported via `src/domain/objects/index.js`); `FilePath`,
`FileMode` from domain.

**Discriminated-union precedent (ADR-411 D3):** `src/domain/diff/diff-change.ts` —
`DiffChange = AddChange | DeleteChange | …`, one `interface` per variant, each with a `readonly type:
'<literal>'` discriminant and `readonly` branded fields. Mirror this exactly for `FsckFinding`.

**Hard invariants (every part):** TDD London-school, Given/When/Then describe tree
(`describe('Given …')` > `describe('When …')` > `it('Then …')`), AAA body with section comments,
`sut` = the function/object under test (never the result; result goes in `result`). 100% line/branch/
function coverage + 0 surviving mutants on touched `src/`. No provenance refs (phase/ADR/backlog
numbers) in source or test. No suppression directives. No swallowed errors. Error assertions specific
(assert `.data.code` + payload, not `toThrow(Class)`). Run `npm run check:types` before every commit;
never commit on a red gate.

**Domain object shapes the validator/closure consume (exact):**

- `GitObject = Blob | Tree | Commit | Tag` (`src/domain/objects/git-object.ts`), each
  `{ readonly type: 'blob'|'tree'|'commit'|'tag'; readonly id: ObjectId; … }`.
- `Tree { type:'tree'; id; entries: ReadonlyArray<TreeEntry> }`,
  `TreeEntry { mode: FileMode; name: string; id: ObjectId }` (`tree.ts`).
- `Commit { type:'commit'; id; data: CommitData }`,
  `CommitData { tree: ObjectId; parents: ReadonlyArray<ObjectId>; author; committer; message;
  gpgSignature?; extraHeaders } ` (`commit.ts`).
- `Tag { type:'tag'; id; data: TagData }`,
  `TagData { object: ObjectId; objectType: ObjectType; tagName: string; tagger?; message;
  gpgSignature?; extraHeaders }` (`tag.ts`).
- `ReflogEntry { oldId: ObjectId; newId: ObjectId; identity; message }`
  (`src/domain/reflog/reflog-entry.ts`).

---

## Part 1 — `enumerateObjects` Tier-2 primitive + pack-index all-oid iterator

### Context

**Goal:** ship the whole-object-database enumeration as a **public Tier-2 primitive** (ADR-413 D6) —
the loose scan ∪ every oid in every pack index. fsck (Part 3) is its first consumer; `gc`/`prune`/
`repack`/`bundle` are future consumers. Public-surface decision: **PUBLIC** (barrel + `src/index.ts`
`export *`). It does **NOT** go on the `repository.ts` `primitives` facade — that facade is a curated
subset (e.g. `enumerateRefs`/`enumeratePushObjects` are barreled-public but absent from the facade);
match that precedent, so `repository.test.ts`'s primitives snapshot does **not** change.

**Files to create:**

- `src/application/primitives/enumerate-objects.ts` — the primitive.
- `test/unit/application/primitives/enumerate-objects.test.ts` — example unit tests (mirror the dir of
  an existing primitive test, e.g. find where `enumerate-refs.test.ts` lives and colocate).
- `test/unit/application/primitives/enumerate-objects.properties.test.ts` — round-trip property
  (lens 1/4). Per-family arbitraries go in a shared `arbitraries.ts` in that directory (create if
  absent; reuse if present).

**Files to edit:**

- `src/domain/storage/pack-index.ts` — add the all-oid iterator. Current symbols:
  `parsePackIndex`, `entryOffsets(index): ReadonlyArray<number>`, `findByPrefix`,
  `lookupPackIndex`. Constants: `IDX_SHA_TABLE_OFFSET = 1032`, `IDX_SHA_LENGTH = 20`,
  `PackIndex { objectCount; _bytes; _view; … }`. Imports `bytesToHex` from
  `../objects/encoding.js`. **Add** `export function allObjectIds(index: PackIndex):
  ReadonlyArray<ObjectId>` — mirror `findByPrefix`'s emit loop body exactly: for `i` in
  `[0, index.objectCount)` push
  `bytesToHex(index._bytes.subarray(IDX_SHA_TABLE_OFFSET + i * IDX_SHA_LENGTH,
  IDX_SHA_TABLE_OFFSET + (i + 1) * IDX_SHA_LENGTH)) as ObjectId`. The SHA table is already sorted
  ascending and every entry is wanted — no fanout walk. (Note `IDX_SHA_LENGTH = 20` is the existing
  SHA-1 hardcode shared by `findByPrefix`/`compareShaAtIndex`; follow it, do not generalise here.)
- `src/application/primitives/index.ts` — barrel export. **Alphabetical insertion: between
  `export { enumeratePushObjects } from './enumerate-push-objects.js';` (line ~28) and
  `export { enumerateRefs } from './enumerate-refs.js';` (line ~29).** Export the value AND its
  options/return types: `export { enumerateObjects } from './enumerate-objects.js';` and
  `export type { EnumerateObjectsOptions, EnumerateObjectsResult } from './enumerate-objects.js';`
  (final type names per your signature decision below — keep them minimal).

**Substrate to reuse (exact signatures):**

- Loose layout: `computeLooseObjectPath(id): "<2hex>/<38hex>"` (`src/domain/storage/loose-path.ts`).
  Loose scan = `ctx.fs.readdir(`${objectsDir}/<2hex>`)` over each of the 256 fanout dirs, filtering
  38-hex names, recombining `<2hex><38hex>`. Path-layout helpers live in
  `src/application/primitives/path-layout.ts` (`objectsDir(gitDir, prefix?)`, `looseObjectPath`);
  read it for the exact `objectsDir` arity before use. `commonGitDir(ctx)` is how `pack-registry.ts`
  reaches the shared object store — reuse it.
- Pack iteration: `getPackRegistry(ctx): PackRegistry` (`read-object.ts`); `PackRegistry.all():
  Promise<ReadonlyArray<RegisteredPack>>`; `RegisteredPack.index: PackIndex`. Call `allObjectIds`
  per registered pack.
- `Context` type from `src/ports/context.js`; `ctx.fs` is the `FileSystem` port (has `exists`,
  `readdir(dir): {name; isFile}[]`, `read`, `stat`).

**Signature decision (recommend — see Decision-candidate D-c2):** keep it minimal and total:
`enumerateObjects(ctx: Context, opts?: { readonly includePacks?: boolean /* default true */ }):
Promise<ReadonlyArray<ObjectId>>`. `includePacks:false` ⇒ loose-only (serves fsck's `full:false`
toggle without leaking a `full` name into the primitive). De-duplicate across loose∪packed (an oid
can be both loose and packed) so each oid appears **exactly once** — the property test pins this.
Return ascending-sorted or insertion-order; pick one and pin it (recommend: sorted, so the
property's "exactly once" check is trivial and the result is deterministic across adapters).

**Pinned behaviour:** storage-agnostic — an oid present loose AND packed is enumerated once.
Universe `A` is what fsck's set-difference closure subtracts `Reach` from; correctness here is
load-bearing for every Part-3 dangling/unreachable verdict.

### TDD steps

1. RED — `enumerate-objects.test.ts`: `describe('Given a repo with N loose objects')` >
   `describe('When enumerateObjects runs')` > `it('Then it returns each loose oid exactly once')`.
   Fails: module does not exist. (memory adapter; write objects via `writeObject` primitive or seed
   loose files directly.)
2. GREEN — create `enumerate-objects.ts` with the loose scan only; barrel-export it.
3. RED — test: packed objects (build a pack via `buildPack` primitive or a fixture) are enumerated.
   Fails: `allObjectIds` missing on `pack-index.ts`.
4. GREEN — add `allObjectIds` to `pack-index.ts`; wire pack iteration into `enumerateObjects`.
5. RED — test: an oid present BOTH loose and packed appears exactly once (dedup). Fails until dedup.
6. GREEN — dedup (Set) + chosen ordering.
7. RED — test: `includePacks:false` returns loose-only (omits packed-only oids). Isolated guard test
   (separate from the default-true test) to kill the boolean-default mutant.
8. GREEN — honour `includePacks`.
9. RED — `enumerate-objects.properties.test.ts`: `describe('Given an arbitrary set of written oids
   (loose ∪ packed)')` > `it('Then enumerateObjects yields every written oid exactly once')` —
   generate a set, write them, assert the multiset of results equals the input set with no
   duplicates. `numRuns: 200` (cheap round-trip, lens 1). Arbitraries in `arbitraries.ts`.
10. GREEN/REFACTOR — extract a small loose-scan helper if `enumerateObjects` exceeds 20 lines; keep
    pure-functional. Run `mcp__serena__get_diagnostics_for_file` after each source edit.
11. **Surface gate pre-pay (in this part):** after green, regenerate `reports/api.json` via
    `npm run docs:json` and stage it (new public `enumerateObjects` + its types). `check:doc-typedoc`
    is a **prepush** gate, not a validate gate — pre-pay it here so Part 3's push isn't rejected by a
    stale api.json. (No `docs/use/primitives/` page is gated for primitives by `check:doc-coverage`
    — that gate covers `docs/use/commands/` only; confirm by reading
    `.claude/workflow/surface-gates.md` if unsure, and add a primitive doc page only if the
    repo's doc-coverage actually demands it.)

### Gate

`npx vitest run test/unit/application/primitives/enumerate-objects.test.ts test/unit/application/primitives/enumerate-objects.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/enumerate-objects.ts src/application/primitives/index.ts src/domain/storage/pack-index.ts`

Also run `npm run docs:json` and confirm `reports/api.json` is updated (prepush gate pre-pay).

### Commit

`feat(primitives): enumerateObjects whole-object-database scan`

---

## Part 2 — `domain/fsck/` msg-id catalogue validator

### Context

**Goal:** net-new `domain/fsck/` validator module (ADR-412 D2) — git's full named fsck msg-id
catalogue for the four object kinds, the WARN/ERROR/INFO severity table, and the `--strict`
WARN→ERROR upgrade map. This is the bulk of the implementation weight. It is a pure domain module
(zero outward deps) with its own exhaustive unit + property tests folded in.

**Files to create:**

- `src/domain/fsck/validate-object.ts` — the validator entry point.
- `src/domain/fsck/msg-ids.ts` — the `msgId → defaultSeverity` table + the strict-upgrade set (the
  module's core tables, pinned below).
- `src/domain/fsck/index.ts` — domain barrel for the module (export the validator + the public
  `FsckSeverity` type if you site it here; see type-siting note below).
- `test/unit/domain/fsck/validate-object.test.ts` — per-msgId example cases.
- `test/unit/domain/fsck/validate-object.properties.test.ts` — only if a lens fits (see note);
  otherwise omit (no virtue points).

**Type siting decision (recommend):** `FsckObjectType = 'commit'|'blob'|'tree'|'tag'` and
`FsckSeverity = 'error'|'warning'|'info'` are referenced by both the validator (domain) and the
finding union (Part 3). Site them in `src/domain/fsck/types.ts` and re-export from the domain barrel;
Part 3's command re-exports them through the command's public types. (Alternatively site `FsckSeverity`
with the finding union in Part 3 and import into domain — but domain must not import from
`application/`, so **site them in `domain/fsck/`** and let Part 3 import them. Recommended.)

**Validator contract:**

```
validateObject(input): ReadonlyArray<{ readonly msgId: string; readonly severity: FsckSeverity }>
```

returning the **ordered** list of `(msgId, severity)` checks the object fails, severity already
adjusted for strict. The command (Part 3) maps each entry to a `bad-object` finding carrying
`msgId` + `severity`. Input must let the validator inspect what each check needs (see the
raw-vs-parsed boundary below).

**CRITICAL raw-vs-parsed boundary (load-bearing — Decision-candidate D-c1):** the design prose says
"the validator takes a parsed object + its kind", but tsgit's existing parsers **reject or normalise
away** several catalogue conditions before a parsed object exists:

- `tree.ts` `normalizeFileMode(modeStr)` (line ~62) discards zero-padding → `zeroPaddedFilemode`
  (WARN) is invisible on the parsed `Tree`.
- `tree.ts` throws `invalidTreeEntry` on `name === '' | '.' | '..' | name.includes('/')` (line ~50)
  and on duplicate names (line ~64) → `emptyName`/`hasDot`/`hasDotdot`/`fullPathname`/`hasDotgit`/
  `duplicateEntries` never yield a parsed `Tree`.
- `tree.ts` does not check sort order, so `treeNotSorted` is detectable only from raw bytes.
- `author-identity.ts` slices the email between `<>` and throws `invalidIdentity` on malformed
  spacing → `missingSpaceBeforeEmail`/`missingNameBeforeEmail`/`badEmail` never yield a parsed
  identity.

**Resolution (ADOPTED — D-c1, forced by ADR-412 full-catalogue faithfulness):** the validator
inspects the **raw object bytes** (plus the declared object kind) for the byte-level ids (tree entry
modes/names/sort order, identity line spacing, NUL-in-header, header structure), and may use the
parsed shape only where the parser preserves the needed fields losslessly. Concretely,
`validateObject` takes the **raw decompressed object body** (`Uint8Array`) + kind + `strict` flag,
and parses the bytes itself with fsck's tolerant rules (it must NOT throw — it classifies). This
keeps `domain/fsck/` self-contained and faithful. The parsed-object path is rejected: it would shrink
the catalogue to only the ids the parsers preserve and degrade interop `msgId` byte-faithfulness.

**Pinned msg-id → default-severity table (from `git` 2.54.0 `fsck-msgids.adoc`, cross-checked
behaviourally — reproduce verbatim; design lines ~270-330):**

Object-validation catalogue (commit / tree / tag / blob):

| msgId | object kind | default severity | strict |
|---|---|---|---|
| `badDate` | commit, tag | error | — |
| `badDateOverflow` | commit, tag | error | — |
| `badEmail` | commit, tag | error | — |
| `badFilemode` | tree | info | — |
| `badGpgsig` | tag | error | — |
| `badName` | commit, tag | error | — |
| `badObjectSha1` | any | error | — |
| `badParentSha1` | commit | error | — |
| `badTagName` | tag | info | — |
| `badTimezone` | commit, tag | error | — |
| `badTree` | tree | error | — |
| `badTreeSha1` | tree | error | — |
| `badType` | any | error | — |
| `duplicateEntries` | tree | error | — |
| `emptyName` | tree | warning | → error |
| `extraHeaderEntry` | tag | ignore | — |
| `fullPathname` | tree | warning | → error |
| `gitattributesBlob` | tree (`.gitattributes`) | error | — |
| `gitattributesLarge` | blob | error | — |
| `gitattributesLineLength` | blob | error | — |
| `gitattributesMissing` | blob | error | — |
| `gitattributesSymlink` | tree | info | — |
| `gitignoreSymlink` | tree | info | — |
| `gitmodulesBlob` | tree (`.gitmodules`) | error | — |
| `gitmodulesLarge` | blob | error | — |
| `gitmodulesMissing` | blob | error | — |
| `gitmodulesName` | blob | error | — |
| `gitmodulesParse` | blob | info | — |
| `gitmodulesPath` | blob | error | — |
| `gitmodulesSymlink` | tree | error | — |
| `gitmodulesUrl` | blob | error | — |
| `hasDot` | tree | warning | → error |
| `hasDotdot` | tree | warning | → error |
| `hasDotgit` | tree | warning | → error |
| `largePathname` | tree | warning | → error |
| `mailmapSymlink` | tree | info | — |
| `missingAuthor` | commit | error | — |
| `missingCommitter` | commit | error | — |
| `missingEmail` | commit, tag | error | — |
| `missingNameBeforeEmail` | commit, tag | error | — |
| `missingObject` | tag | error | — |
| `missingSpaceBeforeDate` | commit, tag | error | — |
| `missingSpaceBeforeEmail` | commit, tag | error | — |
| `missingTag` | tag | error | — |
| `missingTagEntry` | tag | error | — |
| `missingTaggerEntry` | tag | info | — |
| `missingTree` | commit | error | — |
| `missingType` | tag | error | — |
| `missingTypeEntry` | tag | error | — |
| `multipleAuthors` | commit | error | — |
| `nulInCommit` | commit | warning | → error |
| `nulInHeader` | any | fatal | — |
| `nullSha1` | tree | warning | → error |
| `treeNotSorted` | tree | error | — |
| `unknownType` | any | error | — |
| `unterminatedHeader` | any | fatal | — |
| `zeroPaddedDate` | commit, tag | error | — |
| `zeroPaddedFilemode` | tree | warning | → error |

**strict-upgrade set = EXACTLY the WARN-default rows:** `emptyName`, `fullPathname`, `hasDot`,
`hasDotdot`, `hasDotgit`, `largePathname`, `nulInCommit`, `nullSha1`, `zeroPaddedFilemode`. INFO /
IGNORE / FATAL / ERROR ids are **not** upgraded by `strict`. Pinned: `treeNotSorted` and
`missingSpaceBeforeEmail` stay ERROR in both default and strict; `zeroPaddedFilemode` flips
warning→error under strict.

**Scope guard (RESOLVED — D-c3 ADOPTED = full catalogue detection, per ratified ADR-412):**
Implement the full table's **severity classification** (every id resolvable to a severity, every id
upgradable-or-not) AND **detection** for the FULL catalogue — every object-structure id (commit /
tree / tag / blob byte-level faults) and the special-blob content checks (`gitmodules*`,
`gitattributes*`, `gitignoreSymlink`, `mailmapSymlink`), the latter using tsgit's existing
`.gitmodules` parser (`domain/`-level INI/submodule parsing) and `.gitattributes` parser
(`domain/attributes/`). Every detected id carries a pinned interop or unit fixture. No silent stubs.
The per-item escape hatch survives ONLY for a single id whose detection needs machinery tsgit
genuinely lacks: raise it as a blocker `{ unit: <msgId>, reason: detection needs <X>, options:
[implement now / split that one id to a follow-up / equivalent ] }` rather than guessing or stubbing —
escalation is per-id and concrete, never a blanket narrowing of the full-catalogue scope.

### TDD steps

1. RED — `validate-object.test.ts`: `describe('Given a tree with a zero-padded filemode')` >
   `describe('When validateObject runs (default)')` > `it('Then it emits zeroPaddedFilemode at
   warning severity')`. Assert the returned entry's `msgId === 'zeroPaddedFilemode'` and
   `severity === 'warning'`. Fails: module absent.
2. GREEN — create `msg-ids.ts` table + strict set; create `validate-object.ts` dispatching on kind,
   detecting `zeroPaddedFilemode` from raw tree-entry mode bytes; barrel via `domain/fsck/index.ts`.
3. RED — strict arm (isolated): `describe('When validateObject runs (strict)')` >
   `it('Then zeroPaddedFilemode is upgraded to error')`. Separate test from the default arm to kill
   the upgrade-guard mutant.
4. GREEN — apply strict upgrade only to the WARN-set.
5. RED — already-ERROR id unchanged by strict: `treeNotSorted` is `error` in BOTH default and strict
   (two isolated tests). Fails until detection + non-upgrade.
6. GREEN — detect `treeNotSorted` (raw entry order vs git's canonical sort, where dirs sort as
   `name + '/'`); classify error; ensure strict does not touch it.
7. RED — `missingSpaceBeforeEmail` ERROR in both arms (commit + tag identity lines).
8. GREEN — detect from raw identity bytes (no preceding space before `<`).
9. RED — one representative INFO id (e.g. `badTagName` or `missingTaggerEntry`) emits at `info` and is
   NOT upgraded by strict. One representative per remaining object kind from the table.
10. GREEN — implement detections; classify.
11. REFACTOR — extract per-kind check lists (`commitChecks`, `treeChecks`, `tagChecks`, `blobChecks`)
    as ordered arrays of small pure predicates so `validateObject` stays <20 lines and the ordered
    output is deterministic. No magic strings — msgIds are named constants in `msg-ids.ts`.
12. (Conditional) `validate-object.properties.test.ts` — only if a lens fits. Candidate lens 2
    (compositional aggregator): "a clean object of each kind returns empty"; "appending exactly one
    fault makes the verdict include exactly that msgId". If the only available oracle re-implements
    the production checks (tautology), SKIP per CLAUDE.md and note why in the part's commit body is
    forbidden — instead just omit it.
13. Run `get_diagnostics_for_file` after each source edit.

### Gate

`npx vitest run test/unit/domain/fsck && npm run check:types && ./node_modules/.bin/biome check src/domain/fsck`

### Commit

`feat(domain): fsck object-content msg-id catalogue validator`

---

## Part 3 — `fsck` Tier-1 command + full public surface wiring

### Context

**Goal:** assemble the Tier-1 `fsck` command from Parts 1–2 + existing read primitives, the inline
reachability closure (ADR-413 D5), the refs-verify pass (ADR-412 D1), and the composite exit-code
bitmask — then wire the **complete public command surface** (barrel, facade, facade snapshot, docs,
README count, api.json). Public-surface decision: `fsck` and `FsckOptions`/`FsckResult`/`FsckFinding`/
`FsckObjectType`/`FsckSeverity` are **PUBLIC**.

**Files to create:**

- `src/application/commands/fsck.ts` — the command + `FsckOptions`/`FsckResult`/`FsckFinding`/
  `FsckObjectType`/`FsckSeverity` type declarations (re-export `FsckObjectType`/`FsckSeverity` from
  `domain/fsck` if sited there per Part 2; declare the finding union + options/result here).
- `test/unit/application/commands/fsck.test.ts` — unit suite (memory adapter).
- `test/unit/application/commands/fsck.properties.test.ts` — closure-invariant property (lens 2).
- `test/integration/fsck-interop.test.ts` — real-git byte-faithfulness suite.

**Files to edit (the surface gates — PRE-PAY ALL IN THIS PART; ADR-411 / surface-gates.md):**

1. **Barrel** — `src/application/commands/index.ts`. Insert **between** the `fetchMissing` export
   block (ends ~line 104 `} from './fetch-missing.js';`) and the `grep` export block (~line 105
   `export {` … `grep`). Export:
   `export { type FsckFinding, type FsckObjectType, type FsckOptions, type FsckResult,
   type FsckSeverity, fsck } from './fsck.js';`
2. **Facade interface** — `src/repository.ts`: add `readonly fsck: BindCtx<typeof commands.fsck>;`
   between `readonly fetchMissing` (~line 199) and `readonly grep` (~line 200).
3. **Facade binding** — `src/repository.ts`: add the guarded binding between the `fetchMissing` binding
   (ends ~line 503 `}) as Repository['fetchMissing'],`) and the `grep` binding (~line 504), mirroring:
   `fsck: ((fsckOpts) => { guard(); return commands.fsck(ctx, fsckOpts); }) as Repository['fsck'],`
4. **Facade snapshot** — `test/unit/repository/repository.test.ts`: add `'fsck'` to the sorted
   `Object.keys(sut)` array (between `'fetchMissing'` line ~215 and `'grep'` line ~216). The
   `sut.primitives` snapshot does **NOT** change (enumerateObjects is barrel-public, not facade —
   Part 1).
5. **Docs page** — create `docs/use/commands/fsck.md` following the page shape in
   `docs/use/commands/README.md` (Signature / Options / Behaviour / Examples / Throws / See also).
6. **Docs index** — `docs/use/commands/README.md`: bump the header count `38 entries` → `39 entries`
   (line ~3) and add the `fsck` row alphabetically **between** the `fetchMissing` row (line ~19) and
   the `grep` row (line ~20): `| [`fsck`](fsck.md) | Verify connectivity and validity of every object
   in the store; returns structured findings + a composite exit code (no rendered line). |`
7. **README Tier-1 count** — root `README.md`: bump `39 Tier-1 commands` → `40 Tier-1 commands`
   (line ~46).
8. **api.json** — regenerate `reports/api.json` via `npm run docs:json` and commit it (new public
   `fsck` + types; typedoc embeds the README so the count change also makes it stale). Prepush gate.

**Pipeline (`fsck(ctx, opts)` — design lines ~365-400):**

1. `assertRepository(ctx)` (`src/application/primitives/internal/repo-state.ts`,
   `assertRepository = async (ctx) => { … throw notARepository(workDir) if !exists(`${gitDir}/HEAD`)
   … }`). **NOT** `assertOperationalRepository` (ADR-414): a broken `[core]` config and an
   unborn/dangling HEAD symref are tolerated (clean, exit 0). Only refusal path = non-repository →
   throws `notARepository`.
2. **Enumerate universe `A`** via `enumerateObjects(ctx, { includePacks: opts.full !== false })`
   (Part 1). `full` default true.
3. **Validate each object** (skipped when `connectivityOnly === true`):
   `readObject(ctx, id, { verifyHash: true })` wrapped in try/catch — map the thrown `TsgitError` by
   `.data.code` (factories in `src/domain/objects/error.ts`):
   - `OBJECT_HASH_MISMATCH { expected, actual }` → `{ type:'hash-mismatch', id, actual }` (exit bit 1).
   - parse/header codes (`INVALID_OBJECT_HEADER`, `INVALID_COMMIT`, `INVALID_TREE_ENTRY`,
     `INVALID_TAG`, `INVALID_IDENTITY`, `INVALID_FILE_MODE`) and inflate/IO → `bad-object` (corrupt;
     exit class 3). `OBJECT_NOT_FOUND` here is a corrupt-store signal for an enumerated oid (loose
     truncation, matrix #8a) → `missing` / `bad-object` per matrix.
   - On a **successful** parse, run the Part-2 `validateObject` over the raw bytes + kind + strict,
     emitting one `bad-object` per failed check carrying `msgId` + post-strict `severity`.
   The parsed shape of readable objects feeds graph edges in step 5 (cache it; don't re-read).
4. **Collect roots `R`:** refs via `enumerateRefs(ctx)` → `resolveRef(ctx, name, { peel: false })`
   (keep tag oids as roots; `resolve-ref.ts`, `peel` default false); HEAD; reflog old+new oids via
   `listReflogs(ctx)` + `readReflog(ctx, ref)` (`reflog-store.ts`; `ReflogEntry { oldId; newId }`) —
   unless `reflogRoots === false`; index oids when `indexRoot !== false` (read via `readIndex`
   primitive). When `checkReferences !== false` (default on, the `git refs verify` pass): a root
   resolving to an absent/zero oid → `bad-ref` (`invalid sha1 pointer`, exit bit 2); malformed loose
   ref content → `bad-ref` (`badRefContent`, exit bit 8) — read raw ref bytes via
   `getRefStore(ctx).readLooseRaw(name)` / `resolveDirect(name): {kind:'direct'|'symbolic'|'missing'}`
   (`ref-store.ts`). Composite #9b = `2 | 8 = 10`.
5. **Reachability closure (inline, ADR-413 D5):** BFS from `R`: commit → tree + parents; tree →
   sub-trees + blobs via `walkTree(ctx, treeId, { recursive: true })` (gitlinks/mode 160000 NOT
   descended — `walkTree`'s default; submodule descent is out of scope); tag → tagged object. An
   edge to an absent oid → `missing` (+ `broken-link` carrying referrer+referent, matrix #7b); an
   edge to a mistyped object → `bad-object`. Every primitive call wrapped → thrown `TsgitError`
   becomes a finding, **never** propagates (fsck must not crash on a broken repo). Yields
   `Reach: Set<ObjectId>`.
6. **Classify (maximal taxonomy, ALWAYS computed — ADR-411 D4):** `unreachable = A − Reach`;
   `dangling` = unreachable objects with **no in-edge from another present object** (the subgraph
   tips — matrix #6 tip-only); `root` (root commits) and `tagged` (tag targets) projections. ALL
   variants are emitted in `findings`; the caller filters for git-CLI parity. There is **no**
   `--unreachable`/`--dangling`/`--root`/`--tags` option.
7. **Compose `exitCode`:** OR the severity bits each finding class contributes: `0` clean /
   dangling / unreachable / content-INFO-WARN; `1` generic fsck error (strict upgrade, content-ERROR,
   hash-path mismatch); `2` missing / broken-link / ref→absent-sha; `3` corrupt/undecodable loose
   object; `8` refs-verify content failure (`badRefContent`). Composite ORs (#9b → 10). Pinned vs git
   2.54.0: #9a exit 2, #9b exit 10, isolated `zeroPaddedFilemode` default exit 0 / strict exit 1.

**`FsckFinding` union (declare verbatim — design lines ~451-463; ADR-411 D3, `diff-change.ts`
precedent):**

```
type FsckObjectType = 'commit' | 'blob' | 'tree' | 'tag';   // import from domain/fsck if sited there
type FsckSeverity = 'error' | 'warning' | 'info';

type FsckFinding =
  | { readonly type: 'dangling'; readonly objectType: FsckObjectType; readonly id: ObjectId }
  | { readonly type: 'unreachable'; readonly objectType: FsckObjectType; readonly id: ObjectId }
  | { readonly type: 'missing'; readonly objectType: FsckObjectType; readonly id: ObjectId; readonly referencedBy?: ObjectId }
  | { readonly type: 'broken-link'; readonly from: ObjectId; readonly fromType: FsckObjectType; readonly to: ObjectId; readonly toType: FsckObjectType }
  | { readonly type: 'bad-object'; readonly id: ObjectId; readonly objectType: FsckObjectType; readonly msgId: string; readonly severity: FsckSeverity }
  | { readonly type: 'hash-mismatch'; readonly id: ObjectId; readonly actual: ObjectId }
  | { readonly type: 'bad-ref'; readonly ref: RefName; readonly msgId: string; readonly severity: FsckSeverity; readonly target?: ObjectId }
  | { readonly type: 'root'; readonly id: ObjectId }
  | { readonly type: 'tagged'; readonly id: ObjectId; readonly objectType: FsckObjectType; readonly tagName: string; readonly tag: ObjectId };

interface FsckOptions {
  readonly connectivityOnly?: boolean;   // skip object-content validation, links only
  readonly reflogRoots?: boolean;        // default true; false ⇒ reflog oids are not roots
  readonly indexRoot?: boolean;          // default true; index oids are roots
  readonly full?: boolean;               // default true; include packs (alternates out of scope)
  readonly strict?: boolean;             // WARN-class msg-ids → ERROR (+exit bit)
  readonly checkReferences?: boolean;    // default true; run the refs-verify pass
}
interface FsckResult {
  readonly findings: ReadonlyArray<FsckFinding>;
  readonly exitCode: number;             // composite bitmask 0/1/2/3/8/10 ORs (bit 8 = refs-verify)
}
```

`repo.fsck(opts?: FsckOptions): Promise<FsckResult>`.

**Interop matrix to reconstruct (design lines ~169-218; reconstruct git's exact stdout+stderr from
the structured fields, assert byte-equality + exact exit code):** healthy (#1, nothing, exit 0);
dangling commit/blob/tree/tag (#2c/#3/#4/#5, tip-only); orphan subgraph tip-only dangling + every-
object unreachable (#6/#6b); missing blob in tree (#7a, exit 2); missing parent → `broken link
from  commit <child>` / 14-spaces`to  commit <parent>` + `dangling tree` + `missing commit` (#7b,
exit 2; byte-exact: `broken link from` + 2 spaces, then line 2 = 14 spaces + `to` + 2 spaces, object
descriptor aligned at column 18); corrupt loose object (#8a, exit 3); hash-path mismatch →
`hash-mismatch` + `dangling` (#8b, exit 1); ref→absent-sha (#9a, `invalid sha1 pointer`, exit 2);
ref→malformed content (#9b, `badRefContent` + zero-oid pointer, exit 10); unborn-HEAD symref clean
(#9c, exit 0); packed-only dangling (#10, storage-agnostic); `--strict`/default catalogue
(`zeroPaddedFilemode` warn/exit-0 #12a, error/exit-1 #12b; `treeNotSorted` + `missingSpaceBeforeEmail`
error both #12c). Hand-write each corrupt loose object PAST git's write-side fsck so the read-side
severity is what's observed. Use one shared `beforeAll` tmp repo per scenario family + 60s timeout;
scrub `GIT_*` (use `runGit`/`git(dir,…)` helpers — they isolate env).

### TDD steps

1. RED — `fsck.test.ts`: `describe('Given a healthy repo with reachable commits')` >
   `describe('When fsck runs')` > `it('Then it returns no findings and exit code 0')`. `sut = fsck`.
   Fails: command absent.
2. GREEN — minimal `fsck.ts`: `assertRepository` + enumerate + empty closure stub → `{ findings: [],
   exitCode: 0 }`. Barrel + facade + facade-snapshot edits NOW (so the surface compiles green early).
3. RED — non-repository refuses: `it('Then it throws notARepository')` (assert `.data.code ===
   'NOT_A_REPOSITORY'` — verify the exact code in `src/domain/.../error.ts`). GREEN: already wired by
   `assertRepository`; add the isolated assertion.
4. RED — dangling commit/blob/tree/tag (one isolated test each, tip-only). GREEN: roots + closure +
   set-difference; `dangling` = no-in-edge subset.
5. RED — always-computed `unreachable` taxonomy enumerates the WHOLE orphan subgraph (no option;
   caller filters). GREEN.
6. RED — missing blob in tree (#7a, exit 2); missing parent → `broken-link` + `missing` (#7b).
   GREEN: edge-absence → `missing` (+ `broken-link`).
7. RED — corrupt loose object → `bad-object` (exit 3); hash-path mismatch → `hash-mismatch` /
   `dangling` (exit 1). Isolated guard tests mapping each `.data.code`. GREEN: the try/catch
   classifier.
8. RED — catalogue integration: a parseable object with `zeroPaddedFilemode` → one `bad-object`
   carrying `msgId:'zeroPaddedFilemode'`, `severity:'warning'`; under `strict:true` → `'error'` +
   exit bit 1 (isolated arms). GREEN: wire Part-2 `validateObject` into step 3.
9. RED — refs-verify: ref→absent-sha → `bad-ref` (`invalid sha1 pointer`, exit bit 2); malformed ref
   content → `bad-ref` (`badRefContent`, exit bit 8); composite #9b = exit 10. `checkReferences:false`
   skips the pass (isolated guard test). GREEN.
10. RED — option guards, EACH isolated (kill boolean-default mutants): `reflogRoots:false` flips a
    reflog-kept commit to dangling; `indexRoot:false` drops a staged-only blob from roots;
    `connectivityOnly:true` suppresses content faults (no `bad-object`); `full:false` excludes packed
    objects from `A`. GREEN.
11. RED — `root` + `tagged` projections present in `findings` (#11a/#11b). GREEN.
12. RED — `fsck.properties.test.ts` (lens 2 closure invariants, `numRuns: 100`):
    `describe('Given an arbitrary object graph')` — `dangling ⊆ unreachable`; `unreachable ∩ Reach =
    ∅`; adding a root that reaches an object flips it out of `unreachable`; a present object directly
    used by another present object is never `dangling`. Arbitraries in the commands-test
    `arbitraries.ts` (create/reuse). GREEN/REFACTOR — keep `fsck` small; extract closure into an
    internal helper (`buildReachableSet`, `classifyObjects`) in `fsck.ts` (inline per ADR-413 D6 —
    NOT a primitive, NOT barreled).
13. RED — `fsck-interop.test.ts`: each matrix scenario reconstructs git's exact stdout+stderr bytes
    from the structured fields and asserts byte-equality + exit code against `git fsck <flags>`. Guard
    the whole suite on `GIT_AVAILABLE`. GREEN/REFACTOR — extract per-scenario line reconstructors.
14. **Docs + count + api.json:** write `docs/use/commands/fsck.md`; bump docs index count + add row;
    bump README Tier-1 count; `npm run docs:json` → commit `reports/api.json`.
15. Run `get_diagnostics_for_file` after each source edit; `npm run check:doc-coverage` to confirm
    the docs page satisfies the gate.

### Gate

`npx vitest run test/unit/application/commands/fsck.test.ts test/unit/application/commands/fsck.properties.test.ts test/unit/repository/repository.test.ts test/integration/fsck-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/fsck.ts src/application/commands/index.ts src/repository.ts`

Then pre-pay surface gates: `npm run check:doc-coverage` (docs page + index row) and `npm run docs:json` (regenerate + stage `reports/api.json`).

### Commit

`feat(fsck): repository integrity check command`

---

## Part 4 — fsck parity scenario (node / memory / browser)

### Context

**Goal:** cross-adapter parity scenario asserting identical structured `findings`/`exitCode` on node,
memory, and browser (`audit-browser-surface` gate — invoking `repo.fsck(…)` in a parity scenario
`run()` closes the browser-surface requirement for the new Tier-1 command). This is a
**test-infra-only** part (no `src/` delta) — legitimately standalone.

**Files to create/edit:**

- Create `test/parity/scenarios/fsck.scenario.ts` — mirror `test/parity/scenarios/shortlog.scenario.ts`
  exactly (a `Scenario<TResult>` with `name`, `inputs`, `expected`, `run`). `Scenario<TResult>` shape:
  `{ name: string; inputs: ScenarioInputs; expected: TResult; run: (repo, inputs) => Promise<TResult> }`
  (`test/parity/scenarios/types.ts`). `ScenarioInputs { files; author; message }`; fixtures in
  `test/parity/fixtures.ts` (`AUTHOR`, `FILES`, `MESSAGES`).
- Edit `test/parity/scenarios/index.ts` — `import { fsckScenario } from './fsck.scenario.ts';`
  (alphabetical among the imports, ~lines 19-30) and append `fsckScenario` to the `SCENARIOS`
  array (~line 32+).

**Scenario design (design lines ~561-563):** a small repo with **one dangling object + one missing
object**, asserting the same structured `findings`/`exitCode` across adapters. `run()` seeds the repo
(`repo.init()` + `repo.add` + `repo.commit`), then hand-produces one dangling object (e.g. a
`hash-object`-equivalent unreferenced blob via the `writeObject` primitive) and one missing object
(delete a loose object the tree references), then calls `repo.fsck()` and returns a normalised
projection (e.g. counts/types of `dangling` and `missing` findings + `exitCode`) so the cross-adapter
equality is byte-stable. Keep the projection minimal and deterministic — the parity harness compares
`expected` against `run()` on every adapter; non-deterministic oids must be mapped to stable tokens
(reuse how `shortlog.scenario.ts` projects to `name/count/first`).

**Browser note (memory):** browser `workDir` is `'/'` (slash-terminated); the parity harness handles
the adapter wiring — write the scenario adapter-agnostically (only `repo.*` calls + structural
assertions), no path-shape assumptions.

### TDD steps

1. RED — add `fsck.scenario.ts` with `expected` set to the intended structured projection; register
   in `index.ts`. Run the parity suite (`npx vitest run test/parity`) — the new scenario fails
   `run() !== expected` until `expected` is pinned to the real structured output and the `run()` body
   seeds correctly. (Parity scenarios are the test; there is no separate `src/` code — RED/GREEN is
   the scenario `run()` converging on `expected` across all three adapters.)
2. GREEN — finalise the `run()` seeding + projection so node, memory, and browser all yield
   `expected`. Verify the scenario is picked up (it appears in the parity run output).
3. REFACTOR — extract any seeding helper; keep the scenario focused and the projection minimal.

### Gate

`npx vitest run test/parity && npm run check:types && ./node_modules/.bin/biome check test/parity/scenarios/fsck.scenario.ts test/parity/scenarios/index.ts`

### Phase-boundary gate (after the last part)

`npm run validate` (full quality gate — coverage 100% on touched domain/adapters, mutation budget,
cspell, doc-coverage) and confirm `reports/api.json` is committed (prepush `check:doc-typedoc`).
`audit-browser-surface` is satisfied by this part's `repo.fsck(…)` invocation in `run()`.

### Commit

`test(parity): fsck cross-adapter scenario`
