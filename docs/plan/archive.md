# Plan — archive (export tree)

> Source: design doc `docs/design/archive.md` · ADRs 415, 416, 417, 418, 419
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Sequencing constraints (read first)

Four parts, all in worktree `/Users/scolladon/workspace/perso/node/tsgit-archive` (branch
`feat/archive`). Sequential — one shared working tree, each builds on the prior commit.

- **Part 1 (`deflateRaw` port)** and **Part 2 (`archive` command)** are mutually
  independent; either can land first. Recommended order: 1 then 2.
- **Part 3 (tar)** depends on **Part 2** — `tarArchive` consumes the domain
  `ArchiveResult`/`ArchiveEntry` types and its interop calls `repo.archive(...)`.
- **Part 4 (zip)** depends on **Part 2** (the same types) **and Part 1** (its node
  interop wires `ctx.compressor.deflateRaw`).
- **`reports/api.json` regeneration is consolidated into Part 4.** Parts 1–3 each add
  public exports that change `api.json`, but `check:doc-typedoc` (`git diff --exit-code
  -- reports/api.json`) is a **prepush** gate, NOT a `validate` gate and NOT in the
  per-part gate — so a stale `api.json` between parts is invisible. Part 4 regenerates
  once (covering all of Parts 1–4) so the eventual push is clean. Do **not** regenerate
  `api.json` in Parts 1–3 (avoids four redundant typedoc-id churns).

**Architectural invariant binding every part (verified against
`.dependency-cruiser.cjs`, `tsPreCompilationDeps: true` so even `import type` counts):**
`src/domain/**` must not import `src/application/**`. Therefore the data-surface types
the serializers consume (`ArchiveEntry`, `ArchiveResult`) live in **`src/domain/archive/
types.ts`**, not in the command. The command (application) imports them *from* domain —
the same direction `diff` imports `TreeDiff` from `domain/diff`.

---

## Part 1 — Compressor.deflateRaw port capability (node + browser + memory)

### Context

Adds one **additive** method to the `Compressor` port and implements it in all three
adapters. Raw DEFLATE (RFC 1951 — no zlib header/adler trailer) is what zip method-8
needs (Part 4); ADR-417 established it is native in every adapter (zero new deps, no
shim). `deflate` is untouched.

**Files to touch (exact):**

- `src/ports/compressor.ts` — interface `Compressor` (lines 8–37). Add, beside
  `deflate` (line 14):
  ```ts
  /**
   * Raw DEFLATE (compress) using the bare RFC 1951 bitstream — no zlib (RFC 1950)
   * 2-byte header and no adler32 trailer. `level` semantics match `deflate`.
   * Used by the zip archive serializer (method 8). Additive — `deflate` unchanged.
   */
  readonly deflateRaw: (data: Uint8Array, level?: number) => Promise<Uint8Array>;
  ```
- `src/adapters/node/node-compressor.ts` — `NodeCompressor` (class at line 21). Import
  `deflateRawSync` from `node:zlib` (extend the existing line-1 import
  `{ createInflate, deflateSync, inflateSync }`). Add a `deflateRaw` arrow mirroring
  `deflate` (lines 28–37) **byte-for-byte in shape**, including the documented
  level-branch equivalent-mutant note:
  ```ts
  deflateRaw = async (data: Uint8Array, level?: number): Promise<Uint8Array> => {
    try {
      return new Uint8Array(
        level === undefined ? deflateRawSync(data) : deflateRawSync(data, { level }),
      );
    } catch (err) {
      throw compressFailed(describeError(err));
    }
  };
  ```
- `src/adapters/browser/browser-compressor.ts` — `BrowserCompressor` (class line 12). Add
  a `deflateRaw` method mirroring `deflate` (lines 13–25) but constructing
  `new CompressionStream('deflate-raw')`. (Browser adapter is **outside** the coverage
  include set — see `vitest.config.ts` `coverage.include`, which lists only
  `domain`/`ports`/`adapters/node`/`adapters/memory`/`operators`. No unit-coverage debt;
  the browser path is exercised by `test/browser/`.)
- `src/adapters/memory/memory-compressor.ts` — `MemoryCompressor` (class line 11). Add a
  `deflateRaw` arrow mirroring `deflate` (lines 18–27): `return await runTransform(data,
  new CompressionStream('deflate-raw'));` inside try/catch → `compressFailed`. Reuses the
  module's existing `runTransform` helper (line 66).

**Test substrate:**

- `test/unit/ports/compressor.contract.ts` — `compressorContractTests(createSut)` (the
  shared contract run by BOTH `test/unit/adapters/node/node-compressor.test.ts:7` and
  `test/unit/adapters/memory/memory-compressor.test.ts:8`). There is **no raw-inflate
  port method**, so verify `deflateRaw` round-trips by inflating in-test with a Web
  `DecompressionStream('deflate-raw')` (available in the Node 18+/undici test runtime).
  Add contract cases:
  1. `deflateRaw(data)` then raw-inflate (via in-test `DecompressionStream('deflate-raw')`)
     equals `data` (use the same "hello world" + 64KB ramp inputs as the existing
     `deflate` cases lines 7–29).
  2. Empty input round-trips.
  3. `deflateRaw(data)` is **not** byte-equal to `deflate(data)` for non-empty input
     (proves no zlib wrapper — kills a mutant that aliases `deflateRaw` to `deflate`).
- `test/unit/adapters/node/node-compressor.test.ts` — node-specific block (after line 7).
  100% coverage + mutation on `node-compressor.ts` requires:
  1. `deflateRaw` **with** a level and **without** a level both covered (two tests) — the
     `level === undefined ? … : …` ternary has two arms; mirror the intent of the
     existing `deflate` equivalent-mutant note.
  2. `deflateRaw(42 as unknown as Uint8Array)` throws `COMPRESS_FAILED` (assert
     `.data.code`) — covers the catch arm (mirror lines ~14–30 of the existing
     `deflate` COMPRESS_FAILED test).
- `test/unit/adapters/memory/memory-compressor.test.ts` — memory-specific block. Cover
  `deflateRaw`'s catch arm (`COMPRESS_FAILED`) and a level-ignored round-trip if needed
  for 100% (mirror the existing `deflate` level tests around lines 180–208).

**Test-double note:** every in-tree `Compressor` stub spreads a real adapter
(`{ ...ctx.compressor, deflate: … }` in `write-object.test.ts:239+`,
`build-pack.test.ts:233`; `{ ...realCompressor, createInflateStream: … }` in
`stream-blob.test.ts:620+`), and `compose-adapters.test.ts` uses `{} as Compressor`
casts. None is a fresh full-literal implementation, so **no test double needs a manual
`deflateRaw`** — the spread inherits it. (Confirmed by grep: no test object-literal
satisfies `Compressor` structurally.)

**Public-surface decision:** `Compressor` is already PUBLIC (re-exported by
`src/public-types.ts:49` via `export type * from './ports/index.js'`). Adding
`deflateRaw` widens the public port type → `reports/api.json` changes. This is **deferred
to Part 4's consolidated regen** (see Sequencing constraints). No barrel/facade/doc-page
gate applies (a port method is not a Repository command).

### TDD steps

1. **RED** — add the contract round-trip + "not equal to `deflate`" cases to
   `compressor.contract.ts`, plus the node/memory adapter-specific tests. Run the node +
   memory compressor test files. Expected failure: `Property 'deflateRaw' does not exist
   on type 'Compressor'` (type error) / `sut.deflateRaw is not a function` at runtime.
2. **GREEN** — add `deflateRaw` to the `Compressor` interface and the three adapter
   implementations as specified. Re-run: round-trips pass, raw bytes differ from
   `deflate`, level branches + catch arms covered.
3. **REFACTOR** — confirm `deflateRaw` mirrors `deflate` exactly (no copy drift); keep
   the equivalent-mutant comment style consistent with the existing `deflate` arm; no
   duplication beyond the unavoidable per-adapter method.

### Gate

```
npx vitest run test/unit/adapters/node/node-compressor.test.ts test/unit/adapters/memory/memory-compressor.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/compressor.ts src/adapters/node/node-compressor.ts src/adapters/browser/browser-compressor.ts src/adapters/memory/memory-compressor.ts test/unit/ports/compressor.contract.ts test/unit/adapters/node/node-compressor.test.ts test/unit/adapters/memory/memory-compressor.test.ts
```

### Commit

```
feat(ports): add deflateRaw (raw DEFLATE) capability to Compressor
```

---

## Part 2 — archive command, domain data surface, Tier-1 surface gates

### Context

Ships the Tier-1 `archive` command: resolve a required tree-ish to its tree (+ commit
metadata), and surface a **lazy** `AsyncIterable<ArchiveEntry>` that hydrates blob bytes
per entry. Returns **data only** — never tar/zip bytes (ADR-249/415). No serializer in
this part (Parts 3/4). Carries the **full Tier-1 surface-gate set**.

**Data-surface types — DOMAIN (architecture-mandated):**

- Create `src/domain/archive/types.ts`:
  ```ts
  import type { FileMode, FilePath, ObjectId } from '../objects/index.js';

  export interface ArchiveEntry {
    readonly path: FilePath;        // path within the tree, NO prefix (prefix is rendering)
    readonly mode: FileMode;        // RAW git mode (100644/100755/120000/40000/160000)
    readonly oid: ObjectId;         // blob / tree(dir) / commit(gitlink) oid
    readonly content?: Uint8Array;  // blob bytes incl. symlink target; ABSENT for dir & gitlink
  }

  export interface ArchiveResult {
    readonly tree: ObjectId;          // resolved tree exported
    readonly commit?: ObjectId;       // peeled commit oid (pax/zip comment); absent for a bare tree
    readonly commitTime?: number;     // committer epoch seconds (default mtime); absent for a bare tree
    readonly entries: AsyncIterable<ArchiveEntry>;
  }
  ```
  Branded `FileMode`/`FilePath`/`ObjectId` reused from `src/domain/objects/` (see
  `file-mode.ts:FILE_MODE`, `object-id.ts`). These types are the swap-point both
  serializers consume; defining them in domain keeps `domain/archive/*.ts` from importing
  application (forbidden edge).
- Create `src/domain/archive/index.ts` barrel:
  ```ts
  export type { ArchiveEntry, ArchiveResult } from './types.js';
  ```
  (Parts 3/4 append the `tarArchive`/`zipArchive` value+type exports here.)
- Add to `src/domain/index.ts` (after the existing barrel lines, alphabetical near the
  top — it sits before `diff`): `export * from './archive/index.js';`. **`src/domain/
  index.ts` is a typedoc entry point** (`typedoc.json` entryPoints) — this is the path by
  which `ArchiveEntry`/`ArchiveResult` enter `reports/api.json`.

**Command — APPLICATION:**

- Create `src/application/commands/archive.ts`:
  - `export interface ArchiveOptions { readonly treeish: string; }` (required tree-ish;
    git refuses with no arg — design data surface lines 343–345).
  - `export type { ArchiveEntry, ArchiveResult } from '../../domain/archive/index.js';`
    (re-export so the types are nameable beside the command — mirrors how
    `commands/index.ts:5–14` re-exports `TreeDiff` from `domain/diff`). Because both the
    domain barrel and this command barrel re-export the SAME declaration, `public-types.ts`
    dedupes benignly — **no TS2308** (identical to the documented `TreeDiff`/`AuthorIdentity`
    precedent in `public-types.ts:30–31`).
  - `export async function archive(ctx: Context, opts: ArchiveOptions): Promise<ArchiveResult>`.
  - **Pipeline (design §Architecture lines 316–336; ADR-419 refusal matrix):**
    1. `await assertRepository(ctx)` — import from
       `src/application/commands/internal/repo-state.js` (re-exports the primitive at
       `primitives/internal/repo-state.ts:32`, `assertRepository(ctx): Promise<FilePath>`,
       throws `notARepository` → code `NOT_A_REPOSITORY`). **R1**, called first so an
       outside-repo invocation refuses with `NOT_A_REPOSITORY` before any resolution.
    2. Resolve: `const oid = await revParse(ctx, opts.treeish)` (import `revParse` from
       `./rev-parse.js`). `revParse` throws `revparseUnresolved` → code
       `REVPARSE_UNRESOLVED` for an unborn HEAD (**R2**) or unresolvable rev (**R3**).
       (Note: `revParse` itself begins with `assertOperationalRepository`; that is internal
       to resolution — archive's *own* explicit gate is `assertRepository`, per ADR-419.)
    3. `const obj = await readObject(ctx, oid)` (import from
       `../primitives/read-object.js`). Classify on `obj.type`:
       - `commit` → `{ tree: obj.data.tree, commit: oid, commitTime: obj.data.committer.timestamp }`.
         (`Commit.data` is `CommitData` — `src/domain/objects/commit.ts`;
         `AuthorIdentity.timestamp` is epoch seconds — `author-identity.ts:6`.)
       - `tag` → peel to commit: `const commitOid = await peel(ctx, oid, 'commit')` (import
         `peel` from `../primitives/internal/peel.js`), read that commit, take its
         `data.tree` + `data.committer.timestamp`, and set `commit = commitOid`.
       - `tree` → `{ tree: oid }` (no `commit`/`commitTime`).
       - `blob` → **R4**: throw `unexpectedObjectType('tree', 'blob', oid)` (import from
         `../../domain/objects/error.js`) → code `UNEXPECTED_OBJECT_TYPE` with
         `{ expected:'tree', actual:'blob', id }`. Isolate this guard in its own test.
    4. `entries`: a lazy async generator over
       `walkTree(ctx, tree, { maxEntries: <unbounded>, maxDepth: <unbounded> })` (import
       `walkTree` from `../primitives/walk-tree.js`). **Entry-cap note (design lines
       333–336):** `walkTree` defaults `maxEntries` to `MAX_FLAT_TREE_ENTRIES` (1_000_000)
       and `maxDepth` to 1024 (`walk-tree.ts:41`/`:40`); `git archive` imposes no such
       bound, so pass git-faithful effectively-unbounded values (e.g.
       `Number.MAX_SAFE_INTEGER`) rather than inherit the diff-oriented defaults — a >1M
       entry tree must not throw `TREE_ENTRY_LIMIT_EXCEEDED`. `walkTree` already yields
       **every** entry pre-order — directory (mode `40000`) and gitlink (`160000`)
       included, dir emitted before its contents — byte-identical to `git archive`'s order
       (design lines 51–58, 167–171). For each `WalkTreeEntry { path, id, mode }`:
       - directory (`isDirectory(mode)`) or gitlink (`mode === FILE_MODE.GITLINK`): yield
         `{ path, mode, oid: id }` — **no `content`**.
       - else (regular/exec/symlink): `const content = (await readBlob(ctx, id)).content`
         (import `readBlob` from `../primitives/read-blob.js`) and yield
         `{ path, mode, oid: id, content }`. Symlink target bytes ride `content`.
       Laziness: the blob read happens **inside** the generator as each entry is yielded
       (ADR-415; ADRs 383–394) — no whole-tree buffering.
  - Keep the command thin; if classify/entry-stream helpers grow past Object-Calisthenics
    limits, extract into `src/application/commands/internal/archive/` (entry walk stays
    internal — ADR-418, no public primitive in v1).

**Tier-1 surface gates (ALL required — `check:doc-coverage`, `check:browser-surface`,
`test:parity`, `repository.test` are `validate` deps; the phase-boundary `npm run
validate` will fail if any is missing):**

1. **Barrel** `src/application/commands/index.ts` — insert, alphabetically between the
   `add` export block (ends line 16) and the `blame` block (line 17):
   ```ts
   export { type ArchiveEntry, type ArchiveOptions, type ArchiveResult, archive } from './archive.js';
   ```
2. **Facade** `src/repository.ts`:
   - In the `Repository` interface (after `readonly add:` line 170, before `blame` line
     171): `readonly archive: BindCtx<typeof commands.archive>;`
   - In the frozen `repo` object (after the `add:` binding block ending line 459, before
     `blame:` line 460):
     ```ts
     archive: ((archiveOpts) => {
       guard();
       return commands.archive(ctx, archiveOpts);
     }) as Repository['archive'],
     ```
3. **Facade test** `test/unit/repository/repository.test.ts` — add `'archive'` to the
   sorted top-level-keys array (lines 200–245, currently 44 entries; insert between
   `'add'` and `'blame'`). The list is `.sort()`ed on both sides, so insertion point is
   cosmetic, but place it alphabetically. (No primitives-list change — entry walk stays
   internal.)
4. **Doc page** `docs/use/commands/archive.md` — new page following the funnel shape
   (`docs/use/commands/README.md` "Page shape" §, modelled on `fsck.md`). Required
   sections, in order: `## Signature` (lift `repo.archive(opts: ArchiveOptions):
   Promise<ArchiveResult>` + the `ArchiveResult`/`ArchiveEntry`/`ArchiveOptions` shapes
   from `domain/archive/types.ts`); `## Options` (`treeish` — `string` — `(required)` —
   tree-ish in rev grammar); `## Behaviour` (raw modes; dir+gitlink emitted with no
   `content`; pre-order; empty tree → empty stream + no commit metadata; lazy blob
   hydration; serializers are separate pure functions `tarArchive`/`zipArchive` for
   framing — point to them); `## Examples` (2–4: archive HEAD draining entries; bare tree
   with explicit mtime via the serializer; framing to tar/zip via the serializers);
   `## Throws` (cite the canonical codes from `../errors.md`: `NOT_A_REPOSITORY` (R1),
   `REVPARSE_UNRESOLVED` (R2/R3), `UNEXPECTED_OBJECT_TYPE` (R4)); `## See also`
   (Primitives: `walkTree`, `readBlob`, `revParse`; Related commands: `catFile`,
   `readFileAt`, `show`).
5. **Doc index row** `docs/use/commands/README.md` — add a row alphabetically between
   `add` and `blame`:
   ```
   | [`archive`](archive.md) | Export a tree-ish as a structured tree→entry stream (paths, raw modes, oids, blob bytes); pair with the pure `tarArchive`/`zipArchive` serializers to frame `git archive`-faithful tarballs/zips. Structured data only (no rendered bytes). |
   ```
   Then bump the count in line 3 (`Every method … N entries, alphabetical.`) by one to
   match the new row total.
6. **Browser-surface scenario** `test/parity/scenarios/archive.scenario.ts` — new
   scenario modelled on `fsck.scenario.ts`. `audit-browser-surface.ts` greps for
   `repo.archive(` in `test/parity/scenarios/*.ts`, so the `run()` MUST literally call
   `repo.archive(...)`. Project to oids-free counts (the scenario runs on node, memory,
   and OPFS/browser; keep oids out of the assertion spine): seed a commit (init → add →
   commit via the `Scenario` `inputs`), then
   `const result = await repo.archive({ treeish: 'HEAD' })`, drain `result.entries`
   counting them, and return e.g. `{ entryCount, hasCommit: result.commit !== undefined,
   hasCommitTime: result.commitTime !== undefined }`. Register it: import + append
   `archiveScenario` to the `SCENARIOS` array in `test/parity/scenarios/index.ts`.
7. **Count** `README.md` line 46 — bump `40 Tier-1 commands` → `41 Tier-1 commands`.
8. **api.json** — `archive` + `ArchiveOptions`/`ArchiveResult`/`ArchiveEntry` are new
   public exports → `reports/api.json` will change. **Deferred to Part 4's consolidated
   regen** (per Sequencing constraints). Do not regenerate here.

**Unit + interop tests (fold in):**

- `test/unit/application/commands/archive.test.ts` — build a `Context` via an in-memory
  or seeded fixture (follow the pattern in `test/unit/application/commands/*.test.ts`,
  e.g. `buildSeededContext`/`createMemoryContext` used by neighbouring command tests),
  write synthetic trees with `writeObject`/`writeTree`, and assert (GWT/AAA/`sut`,
  mutation-resistant):
  - **Entry stream over a mixed tree** (regular, exec, symlink, nested dir, gitlink):
    paths + **raw modes** + oids + `content` presence (regular/exec/symlink carry
    `content`; dir + gitlink omit it) + **pre-order** (dir entry before its contents).
  - **Symlink** `content` equals the target bytes; **mode** is raw `120000`.
  - **commit-ish** result carries `commit` (= resolved commit oid) and `commitTime`
    (= committer `timestamp`); **bare tree** result has both `undefined`.
  - **Empty tree** → empty entry stream + no commit metadata.
  - **Annotated tag** → peels to its commit; `commit`/`commitTime` come from the peeled
    commit; entries from the commit's tree.
  - **Refusals, each asserted on `.data.code` (never `toThrow(Class)` alone), guards
    isolated:** R1 `NOT_A_REPOSITORY` (no repo), R2 `REVPARSE_UNRESOLVED` (unborn HEAD),
    R3 `REVPARSE_UNRESOLVED` (garbage rev), R4 `UNEXPECTED_OBJECT_TYPE` with
    `{ expected:'tree', actual:'blob' }` (tree-ish resolves to a blob — its own test).
  - **Laziness probe** (kills an eager-materialisation mutant): wrap the ctx's blob read
    or count `readBlob`/`readObject` invocations and assert blob bytes are read only as
    entries are iterated, not at `await archive(...)` time.
  - **Unbounded cap:** assert `archive` passes a `maxEntries`/`maxDepth` far above
    `MAX_FLAT_TREE_ENTRIES` (1_000_000) / 1024 — e.g. spy on `walkTree` options, or build
    a tree deeper than 1024 and assert no `TREE_ENTRY_LIMIT_EXCEEDED`/`TREE_DEPTH_EXCEEDED`.
- `test/integration/archive-interop.test.ts` — **new** file, real-git twin (model on
  `test/integration/tree-interop.test.ts` + `interop-helpers.ts`). Use
  `describe.skipIf(!GIT_AVAILABLE)`, `makePeerPair`, scrubbed `runGit`/`git`, and
  `createNodeContext` (`src/adapters/node/node-adapter.js`) to build a tsgit `ctx` rooted
  at the same tmp repo, fixed committer date (epoch `1112904793`, `+0200`). This file's
  Part-2 block proves the **entry-stream faithfulness** WITHOUT a serializer (serializer
  byte-exactness is Parts 3/4): build a tree containing a regular file, exec file,
  symlink, nested dir, gitlink (`.gitmodules` + a real submodule gitlink), then compare
  `archive(ctx, { treeish })` against git's own enumeration — drive
  `git archive --format=tar <treeish>` through a tar lister/extractor (or
  `git ls-tree -r -t <treeish>`) and assert the path set, **raw modes**, order, and
  per-entry content/`content`-presence match; assert `result.commit` equals
  `git rev-parse <treeish>^{commit}` and `result.commitTime` equals the committer epoch.
  Cover the bare-tree and annotated-tag arms. (Heavy git-spawning interop: use one shared
  `beforeAll` repo where possible and a generous timeout — see the "Interop load →
  validate flake" project note.)

**Spelling (phase boundary):** `check:spelling` (cspell) runs over docs at `validate`.
New terms in `archive.md` (e.g. `treeish`, `gitlink`, `tarball`) may need adding to the
project cspell dictionary — add them, never suppress.

### TDD steps

1. **RED** — write `archive.test.ts` (entry stream, metadata, refusals, laziness) and the
   Part-2 entry-faithfulness block of `archive-interop.test.ts` against the
   not-yet-existing `archive`. Add `'archive'` to `repository.test.ts` keys. Run them.
   Expected failures: `archive` is not exported / `repo.archive is not a function`; the
   keys assertion fails (`'archive'` missing from `Object.keys(sut).sort()`).
2. **GREEN** — create `domain/archive/types.ts` + `domain/archive/index.ts`, wire
   `domain/index.ts`; implement `commands/archive.ts` (pipeline + lazy entries); add the
   barrel export, the facade interface entry + binding. Re-run: command + interop +
   keys pass.
3. **GREEN (gates)** — add `archive.md`, the README index row + count, `README.md`
   count, and `archive.scenario.ts` + its `SCENARIOS` registration; run the memory parity
   pass to confirm the scenario drives `repo.archive` cleanly.
4. **REFACTOR** — extract classify/entry-stream helpers into `internal/archive/` if the
   command exceeds the size budget; ensure each refusal guard is independently triggered
   in tests; confirm no `content` is attached to dir/gitlink entries (mutation-resistant
   assertion). Confirm `domain/archive/*` imports nothing from `application/*`.

### Gate

```
npx vitest run test/unit/application/commands/archive.test.ts test/integration/archive-interop.test.ts test/unit/repository/repository.test.ts test/parity/memory.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/archive/types.ts src/domain/archive/index.ts src/domain/index.ts src/application/commands/archive.ts src/application/commands/index.ts src/repository.ts test/unit/application/commands/archive.test.ts test/integration/archive-interop.test.ts test/unit/repository/repository.test.ts test/parity/scenarios/archive.scenario.ts test/parity/scenarios/index.ts
```

(Markdown/`README.md` surface gates are not biome-linted — biome `files.includes` is
`src/**`, `test/**`, root `*.ts`/`*.json` only — they are validated by
`check:doc-coverage`/`check:doc-links`/`check:spelling` at the phase boundary.)

### Commit

```
feat: archive — structured tree→entry export command
```

---

## Part 3 — tar serializer (`domain/archive/tar.ts`)

### Context

A **pure, zero-dependency** framer that consumes an `ArchiveResult` stream plus
caller-supplied rendering inputs and yields `AsyncIterable<Uint8Array>` byte-equal to
`git archive --format=tar` (ADR-416/418). No IO, no port. Depends on Part 2's
`ArchiveEntry`/`ArchiveResult` (`src/domain/archive/types.ts`).

**Files:**

- Create `src/domain/archive/tar.ts`:
  ```ts
  import type { ArchiveResult } from './types.js';

  export interface TarOptions {
    readonly prefix?: string;   // default ''  — prepended to every path; synthesises a top <prefix> dir entry
    readonly mtime?: number;    // default result.commitTime — octal mtime stamped in every header
    readonly umask?: number;    // default 0o0002 — masks regular/exec/dir/gitlink modes (NOT symlinks)
    readonly uname?: string;    // default 'root'
    readonly gname?: string;    // default 'root'
  }

  export async function* tarArchive(
    result: ArchiveResult,
    opts?: TarOptions,
  ): AsyncIterable<Uint8Array> { /* … */ }
  ```
- Append to `src/domain/archive/index.ts`:
  ```ts
  export { tarArchive } from './tar.js';
  export type { TarOptions } from './tar.js';
  ```
  (Surfaces in `api.json` via the `domain/index.ts` typedoc entry point — already wired in
  Part 2.)

**Pinned ustar framing (design "Faithfulness matrix" T/M/P, lines 156–211; all probed vs
git 2.54.0 — reproduce byte-for-byte):**

- **512-byte ustar header per entry**, fields at offsets: `name`(0,100), `mode`(100,8
  octal), `uid`(108,8), `gid`(116,8), `size`(124,12 octal), `mtime`(136,12 octal),
  `chksum`(148,8), `typeflag`(156,1), `linkname`(157,100), `magic`(257,6 = `ustar\0`),
  `version`(263,2 = `00`), `uname`(265,32 = `root`), `gname`(297,32 = `root`),
  `devmajor`(329,8), `devminor`(337,8), `prefix`(345,155). `uid`/`gid` = `0`.
- **Mode mapping (table M) — each arm an isolated test (mutation-resistant):** git derives
  the unix mode then masks with `tar_umask` (default `0o0002`) **except symlinks**:
  - regular `100644` → `0o644 | 0o022? ` → git: `mode | ((mode & 0100) ? 0777 : 0666)`
    then `& ~umask` → **`0000664`**, typeflag `0`.
  - exec `100755` → **`0000775`**, typeflag `0`.
  - directory `40000` → `mode | 0777` `& ~umask` → **`0000775`**, typeflag `5`.
  - gitlink `160000` → **`0000775`**, typeflag `5` (emitted as an empty dir; submodule
    NOT recursed).
  - symlink `120000` → `mode | 0777` **un-masked** → **`0000777`**, typeflag `2`;
    `content` (target bytes) written to `linkname`, `size` `0`.
- **size/data:** regular/exec → `content.length`, then the content bytes padded to the
  next 512 multiple; dir/gitlink/symlink → size `0`, no data block.
- **chksum:** unsigned byte-sum of the 512-byte header with the `chksum` field
  pre-filled with 8 spaces; written as 6-digit octal + NUL + space (design verified
  `5137 == 5137`).
- **Path field split:** ≤100 bytes → `name`; 100–255 bytes → split at a `/` into `prefix`
  (≤155) + `name` (≤100); >255 bytes is OUT OF SCOPE v1 (design "Out of scope" lines
  527–529) — a single pax `x` `path=` header is deferred; the framer should handle ≤255
  faithfully (git's ustar behaviour) and may throw a clear error above 255 if it cannot
  split (document it; do not silently truncate).
- **Pax global header — present iff `result.commit` is defined** (commit-ish; annotated
  tag → its peeled commit). First 512 block: `name` `pax_global_header`, typeflag `g`,
  mode `0666`, `size` `52`, `mtime` = `mtime`, `magic` `ustar\0`, `uname`/`gname` `root`;
  next 512 block holds the pax record `52 comment=<commit-oid>\n` (the record length `52`
  is self-inclusive: `"52 comment="`=11 + 40-hex oid + `"\n"`=1 = 52) padded with NUL to
  512.
- **EOF padding:** after all entries, append two 512 zero blocks, then pad with zero
  blocks to a multiple of **10240** (BLOCKING factor 20). Design pins: empty tree →
  10240 zero bytes; a 5-entry commit archive → 5120 content + zeros to 10240.
- **`prefix` option:** when non-empty, synthesise a leading `<prefix>` directory entry
  (typeflag `5`, dir mode) and prepend `<prefix>` to every entry's path — exactly as
  `git archive --prefix=pre/` does (design lines 264–265, 381–383).

Binary-assembly precedent for `Uint8Array` offset writing:
`src/domain/objects/tree.ts:serializeTreeContent` and
`src/application/primitives/build-pack.ts:buildPack`.

**Tests (fold in):**

- `test/unit/domain/archive/tar.test.ts` — synthetic `ArchiveResult` fixtures (construct
  `ArchiveEntry` objects + an inline async iterable; no IO). Per-kind header-byte
  assertions: each table-M mode arm in its own test (regular/exec/dir/gitlink/symlink —
  the `& ~umask` masked arms AND the symlink-unmasked arm each isolated); typeflags;
  unsigned-sum chksum; `uname`/`gname` `root`; pax global header **present-iff-commit**
  (a bare-tree fixture → NO pax block; a commit fixture → pax block with the
  `52 comment=<oid>\n` record); `--prefix` synthesised top dir entry + prefixed names;
  10240 EOF padding (empty stream → 10240 zeros).
- `test/unit/domain/archive/tar.properties.test.ts` — **lens 1 round-trip** (CLAUDE.md
  property-test policy; `numRuns` 200). Property: a minimal in-test tar reader (an
  **independent** oracle — NOT a copy of the writer) parses
  `tarArchive(result)` back to the original entry set (paths, modes-after-mapping,
  sizes, link targets), modulo the synthesised pax/dir framing and EOF padding. Put
  shared generators in `test/unit/domain/archive/arbitraries.ts` (new — an
  `arbitraryArchiveEntryStream`/`arbitraryArchiveResult` built on `fast-check`).
- `test/integration/archive-interop.test.ts` — **append** a tar `describe` block. Build
  the same matrix repo as Part 2; run `archive(ctx, { treeish })`, **reconstruct git's
  tar bytes** via `tarArchive(result, { umask: 0o0002, uname:'root', gname:'root',
  mtime: result.commitTime })`, and assert **byte-equality** against
  `git archive --format=tar <treeish>` for: default flags, `--prefix=pre/`, a bare-tree
  arg with a fixed `mtime`, and an annotated tag. Cover pax-present-iff-commit, the umask
  mode mapping, gitlink-as-empty-dir, symlink linkname, and 10240 padding.

**Public-surface decision:** `tarArchive` + `TarOptions` are PUBLIC (the swap-point,
ADR-418), exported via `domain/archive/index.ts` → `domain/index.ts` (typedoc entry
point). `reports/api.json` will change — **deferred to Part 4's consolidated regen**.
Architecture: `tar.ts` imports only `./types.js` (domain) — no upward edge.

### TDD steps

1. **RED** — write `tar.test.ts` (per-kind header bytes), `tar.properties.test.ts`
   (round-trip), and the tar block of `archive-interop.test.ts` against the
   not-yet-existing `tarArchive`. Run. Expected failure: `tarArchive` is not exported /
   undefined; byte assertions cannot run.
2. **GREEN** — implement `tarArchive` (ustar header builder, table-M mode mapping,
   chksum, pax-iff-commit, prefix synthesis, 10240 padding); append the barrel exports.
   Re-run unit + properties + interop until byte-exact vs real git.
3. **REFACTOR** — extract the 512-block header builder and the octal/chksum field
   writers into small pure helpers (each <20 lines, early returns, named constants for
   field offsets/lengths — no magic numbers); confirm the mode-mapping switch is
   exhaustive over the five `FileMode` values; keep the writer and the test-oracle reader
   independent (no shared code that would make the property a tautology).

### Gate

```
npx vitest run test/unit/domain/archive/tar.test.ts test/unit/domain/archive/tar.properties.test.ts test/integration/archive-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/archive/tar.ts src/domain/archive/index.ts test/unit/domain/archive/tar.test.ts test/unit/domain/archive/tar.properties.test.ts test/unit/domain/archive/arbitraries.ts test/integration/archive-interop.test.ts
```

### Commit

```
feat(archive): tar serializer (git archive --format=tar byte-faithful)
```

---

## Part 4 — zip serializer (`domain/archive/zip.ts`) + consolidated api.json

### Context

A framer that is **pure over an injected `deflateRaw` callback** (and the in-tree
`crc32`), byte-equal to `git archive --format=zip` on the node adapter (ADR-417/418).
Depends on Part 2's data types and Part 1's `deflateRaw` (the interop wires
`ctx.compressor.deflateRaw`; unit tests use a stub). This part also performs the
**single consolidated `reports/api.json` regeneration** for the whole feature.

**Files:**

- Create `src/domain/archive/zip.ts`:
  ```ts
  import { crc32 } from '../storage/crc32.js';   // src/domain/storage/crc32.ts:crc32(data): number
  import type { ArchiveResult } from './types.js';

  export interface ZipDeps {
    readonly deflateRaw: (data: Uint8Array, level?: number) => Promise<Uint8Array>;
  }
  export interface ZipOptions {
    readonly prefix?: string;          // default ''  — prepended to names; synthesises a top <prefix> dir entry
    readonly mtime?: number;           // default result.commitTime — feeds DOS time + UT extra
    readonly tzOffsetMinutes?: number; // default 0 (UTC) — TZ for the DOS date/time breakdown
    readonly level?: number;           // forwarded to deflateRaw
  }

  export async function* zipArchive(
    result: ArchiveResult,
    deps: ZipDeps,
    opts?: ZipOptions,
  ): AsyncIterable<Uint8Array> { /* … */ }
  ```
- Append to `src/domain/archive/index.ts`:
  ```ts
  export { zipArchive } from './zip.js';
  export type { ZipDeps, ZipOptions } from './zip.js';
  ```
- **Consumer surface (design "→ src/index.ts"):** add value + type re-exports of both
  serializers to `src/index.ts` (after the existing `export *` lines):
  ```ts
  export { tarArchive, type TarOptions, zipArchive, type ZipDeps, type ZipOptions } from './domain/archive/index.js';
  export type { ArchiveEntry, ArchiveResult } from './domain/archive/index.js';
  ```
  (The api.json gate is already satisfied via the `domain/index.ts` entry point; this line
  makes the serializers importable from the package's `module`/`main` entry, matching the
  brief's "swap your own container".)

**Pinned zip framing (design "Faithfulness matrix" Z, lines 213–285; probed vs git
2.54.0 — reproduce byte-for-byte on node):**

- **Local file header** per entry: sig `PK\x03\x04`; version-needed `10`; general-purpose
  flags `0x0000` (bit-3 clear → **no data descriptor**; CRC + sizes written up front);
  compression method (`0` store / `8` deflate); DOS mod-time + mod-date (from `mtime`
  broken down in `tzOffsetMinutes`); CRC-32 of the **uncompressed** content; compressed
  size; uncompressed size; name length; extra length `9`; name; extra `UT` =
  `55 54 05 00 01 <mtime LE32>` (id `0x5455`, size `5`, flag `0x01` mod-time-only, 4-byte
  little-endian unix `mtime`).
- **Central directory** per entry: sig `PK\x01\x02`; **version-made-by** `0x0317`
  (host-OS 3 = unix) **iff** the entry carries a unix mode in external attrs (exec OR
  symlink), else `0x0000` (MS-DOS); version-needed `10`; flags `0x0000`; method; same DOS
  time/date; CRC; csize; usize; namelen; extralen `9`; commentlen `0`; disk `0`;
  **internal attrs** (`0x0001` text / `0x0000` binary-or-dir/gitlink); **external attrs**
  (table Z): regular text/binary `0x00000000`; exec `0x81ed0000` (= `0o100755 << 16`);
  symlink `0xa1ff0000` (= `0o120777 << 16`, raw git mode, **no umask**); directory
  `0x00000010` (DOS directory attribute); gitlink `0x00000010` (same as directory);
  local-header offset; name; extra `UT` (byte-identical 9 bytes).
- **Method selection (each arm isolated):** call `deflateRaw(content, level)`; use method
  `8` **iff** the compressed result is **smaller** than the content, else method `0`
  (store the content verbatim, `csize == usize`). dir/gitlink: method `0`, size 0, csize
  0, crc 0, **trailing-slash name** (`nested/`, `mysub/`); gitlink emitted as a plain dir
  entry (submodule NOT recursed).
- **internal-attr text bit:** set (`0x0001`) iff the blob is **text**, cleared (`0x0000`)
  for a **binary** blob (and always cleared for dir/gitlink). git's definition is
  `buffer_is_binary` = "the blob contains a NUL byte". `src/domain/diff/line-diff.ts`
  exports `isBinary` (NUL-in-first-8000-bytes **OR** line-length caps) — but git's zip
  text bit uses **NUL presence only** (no line caps), so prefer a plain NUL-presence scan
  (the private `hasNulInWindow` at `line-diff.ts:49` is window-capped and not exported; a
  tiny local NUL scan in `zip.ts` keeps domain purity and avoids widening the diff
  module's public surface). The interop matrix (a binary NUL blob → internal attr
  `0x0000`; text blobs → `0x0001`) is the byte-exact gate — pick the helper that
  reproduces git.
- **EOCD:** sig `PK\x05\x06`; disk `0`; cd-start-disk `0`; entries-on-disk; total
  entries; cd-size; cd-offset; comment length; **comment = `result.commit` (40-hex oid)
  when defined, empty for a bare tree.** Because the central directory trails all entries,
  accumulate a small per-entry record (name, local-header offset, crc, csize, usize,
  method, attrs) while streaming local headers, then emit the central directory + EOCD at
  the end (design lines 406–408).
- **`prefix`:** synthesise a leading `<prefix>` directory entry (method 0, dir attrs) and
  prepend `<prefix>` to every name — exactly as tar.
- **DOS-time note (load-bearing):** git derives DOS time/date from `mtime` via
  `localtime` (machine-TZ-dependent: UTC `0xa1a6/0x3287`, `+0200` `0xb1a6/0x3287`,
  `+0530` next-day `0x0d66/0x3288`). The library must NOT read the process clock/TZ
  (ADR-249): compute the DOS fields from `mtime` + `tzOffsetMinutes` (default `0` = UTC).
  The `UT` extra carries the raw epoch `mtime` (TZ-independent). The interop runs
  `git archive --format=zip` under `TZ=UTC` with `tzOffsetMinutes: 0` so both break down
  in UTC → byte-identical.
- **Byte-identity contract (ADR-417, empirically confirmed):** `node:zlib` `deflateRawSync`
  at **default level** reproduces git's method-8 stream byte-for-byte (`big.txt`
  20000×`A` → 37 bytes `edc1…f060`). So the zip interop asserts byte-equality
  **including method-8** entries on the **node adapter**. Cross-adapter (memory) method-8
  bytes are NOT pinned — see the parity test below.

**Tests (fold in):**

- `test/unit/domain/archive/zip.test.ts` — stub `deflateRaw` (a deterministic fake, e.g.
  identity or a fixed-shrink stub so method selection is controllable). Assert local +
  central header bytes (matrix Z): version-needed `10`, flags `0x0000`, `UT` extra
  (`5554 05 00 01 <mtime LE32>` shape), CRC-32 field (vs `crc32(content)`); method
  selection (method `8` when the stub returns **fewer** bytes, method `0` store
  otherwise — **each arm its own test**); version-made-by + external-attr per kind
  (regular `0x0000`/`0`, exec `0x0317`/`0o100755<<16`, symlink `0x0317`/`0o120777<<16`,
  dir/gitlink `0x0000`/`0x10`); internal-attr text bit set for a text blob, cleared for a
  NUL blob; trailing-slash dir + gitlink names; `--prefix` synthesised dir entry; EOCD
  comment = commit oid (present-iff-commit); `tzOffsetMinutes` DOS-time breakdown (UTC vs
  `+0200` produce the pinned values).
- `test/unit/domain/archive/zip.properties.test.ts` — **lens 1 round-trip** (`numRuns`
  200). Property: a minimal in-test zip reader (independent of the writer) parses
  `zipArchive(result, { deflateRaw })` back to the entry set, **raw-inflating** method-8
  entries (test-side `inflateRaw`, NOT a port method) and reading method-0 entries
  verbatim — modulo synthesised dir/EOCD framing and the store-vs-deflate choice. Reuse /
  extend `test/unit/domain/archive/arbitraries.ts` (from Part 3).
- `test/integration/archive-interop.test.ts` — **append** two `describe` blocks:
  1. **zip interop (node adapter, under `TZ=UTC`):** reconstruct git's zip bytes via
     `zipArchive(result, { deflateRaw: nodeCtx.compressor.deflateRaw }, { tzOffsetMinutes: 0 })`
     and assert **byte-equality** against `git archive --format=zip <treeish>` over the
     matrix (regular text, exec, symlink, nested dir, gitlink, a 20000-byte compressible
     blob `big.txt` exercising method-8, a binary NUL blob, `.gitmodules`), plus
     `--prefix=pre/` and a bare-tree run. Run git with `TZ=UTC` in the spawned env (extend
     `runGitEnv()`).
  2. **cross-adapter zip parity (structural / round-trip):** run `zipArchive` twice over
     the same `ArchiveResult` — once with `NodeCompressor.deflateRaw`, once with
     `MemoryCompressor.deflateRaw` — and assert method-0 entries + ALL framing (local
     headers, central directory, CRC32, sizes, extra fields, EOCD) are **byte-identical**
     across adapters, while method-8 bytes are compared by `inflateRaw`-readback to the
     original blob (the byte-identity contract: cross-adapter DEFLATE bytes are NOT
     pinned). Parity proves cross-adapter consistency, not faithfulness (the interop slice
     owns byte-faithfulness).

**Consolidated api.json regeneration (this part only):** after the source lands, run
`npm run docs:json` to regenerate `reports/api.json` — it now reflects ALL feature
exports: `Compressor.deflateRaw` (Part 1), `ArchiveEntry`/`ArchiveResult`/`ArchiveOptions`
+ `archive` (Part 2), `tarArchive`/`TarOptions` (Part 3), `zipArchive`/`ZipOptions`/
`ZipDeps` (Part 4). Commit the regenerated `reports/api.json` in this part so the prepush
gate `check:doc-typedoc` (`git diff --exit-code -- reports/api.json`) stays green. The
typedoc-id diff is large — that is normal (memory note "api.json prepush gate"). If a
later cached `validate` precedes a red prepush, re-run `npm run docs:json` fresh before
pushing (memory note "Cached validate vs prepush").

**check:size note:** the two serializers add bundle weight; `check:size` (a `validate`
dep) has budgets. The framers are small pure functions and should fit. If `check:size`
fails, `rm -rf dist .wireit` + rebuild before trusting it (memory note "check:size
stale-chunk inflation").

### TDD steps

1. **RED** — write `zip.test.ts` (header bytes, method selection, attrs, internal-attr
   text bit, EOCD comment, DOS time), `zip.properties.test.ts` (round-trip), and the two
   interop blocks against the not-yet-existing `zipArchive`. Run. Expected failure:
   `zipArchive` is not exported / undefined.
2. **GREEN** — implement `zipArchive` (local-header builder, method selection via injected
   `deflateRaw`, `crc32` CRC fields, NUL-sniff internal-attr, DOS-time from
   `tzOffsetMinutes`, central directory + EOCD with the commit-oid comment, prefix
   synthesis); append the barrel + `src/index.ts` re-exports. Re-run unit + properties +
   interop (node byte-exact incl. method-8) + cross-adapter parity.
3. **GREEN (api.json)** — `npm run docs:json`; stage `reports/api.json`.
4. **REFACTOR** — extract little-endian field writers, the DOS-time encoder, and the
   central-directory record accumulator into small pure helpers (named offset/length
   constants, no magic numbers); confirm the method-selection branch and the
   external-attr-per-kind switch are each independently tested; keep the writer and the
   property-test reader independent (no tautology).

### Gate

```
npx vitest run test/unit/domain/archive/zip.test.ts test/unit/domain/archive/zip.properties.test.ts test/integration/archive-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/archive/zip.ts src/domain/archive/index.ts src/index.ts test/unit/domain/archive/zip.test.ts test/unit/domain/archive/zip.properties.test.ts test/unit/domain/archive/arbitraries.ts test/integration/archive-interop.test.ts
```

(`reports/api.json` is generated, not biome-linted — biome `files.includes` excludes
`reports/` — but it IS committed in this part for the prepush `check:doc-typedoc` gate.)

### Commit

```
feat(archive): zip serializer + raw-DEFLATE injection (git archive --format=zip byte-faithful)
```
