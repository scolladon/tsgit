# Plan — `grep` honours the `diff` attribute for its binary verdict

> Source: design doc `docs/design/grep-diff-attribute-binary.md` · ADRs 1177, 1178, 1179, 1180, 1181, 1182, 1183
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
- A part should land in ~100 tool calls. More than ~5 RED→GREEN cycles, or more than 6
  files in its `### Context` block, is two parts. What counts is a path in backticks:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

Five parts, sequential on one working tree:

```
Part 1  feat(diff)      userdiffBinaryOverride: the diff attribute's verdict (ADR-1180)   domain, pure
Part 2  refactor(rev)   commit-tree kind (ADR-1179) + resolveRevisionWithPath (ADR-1178)  peel.ts, rev-parse.ts
Part 3  fix(grep)       work-tree and index targets honour the attribute;                grep.ts + new reader
                        forced binary scanned whole (ADRs 1177, 1181, 1182)
Part 4  fix(grep)       rev targets: a commit's tree and a blob rev with a path honour it grep.ts, resolve-rev.ts, diff.ts
                        (ADRs 1177, 1178, 1179)
Part 5  docs(grep)      grep.md attribute rule + ledger row for the empty-section residual  docs only
```

Order rationale: Parts 1 and 2 land the three building blocks with their own suites.
Nothing in `src/` calls them until Parts 3/4, so the phase gate's `check:dead-code`
(knip) is only meaningful after Part 4 — it is not in the part gate. Part 3 wires the
targets that load the index (work tree, `'index'`); Part 4 wires the rev targets, which
need Part 2's kind and path. Splitting 3/4 keeps each under 6 files and gives each its
own interop rows that are red before its GREEN. Part 5 is docs-only.

Why Parts 3 and 4 both declare grep.ts, grep.test.ts and grep-interop.test.ts: they wire
two disjoint target families with separate decisions — Part 3 the targets that load the
index (ADR-1177's check-in provider, ADR-1181's threading, ADR-1182's window), Part 4 the
rev targets (ADR-1178's path, ADR-1179's kind, `resolveReference`'s new return shape that
also edits diff.ts). Merged they would touch 8 files with 4 RED→GREEN cycles plus the size
gate, over both ceilings. Each has its own red unit and interop rows and its own atomic
commit; Part 4 re-reads the shared files at the state Part 3 left them, and extends Part
3's `Given a diff attribute` describe blocks rather than starting new fixtures.

No-op check: the commits after base `4a7baf86` are the design doc (`508f1ebb`) and ADRs
1177–1183 only. No requirement has landed, so every requirement is planned.

**Rules for every part (read before starting):**

- **One RED per function, run before its code.** Write the RED, run it, see it fail for
  the stated reason, then write the GREEN. Never batch REDs across functions.
- **Interop rows RED before GREEN.** An interop row that the part's GREEN turns green is
  written and run red first. A row green before and after is a GUARD and is labelled so.
- **`sut` is the system under test (the function), never the result.** Write
  `const sut = grep;` then `const result = await sut(…)`. The test-pyramid audit
  (`sutBindsResult`) fails the phase gate when the result is named `sut`.
- Titles: `describe('Given …')` > `describe('When …')` > `it('Then …')`; AAA comments.
- No provenance (ADR / backlog / phase numbers) in `src/` or `test/` text. No
  suppression directives of any kind.
- Interop tests that write via real git build a **fresh** `createNodeContext` after the
  last git write (config is cached per session). Git-spawning `beforeAll` hooks take the
  file's `SETUP_TIMEOUT` (60_000).
- Order-sensitive interop comparisons sort both sides (APFS vs ext4 walk order).

## Decision candidates

Choices the design and ADRs leave open. Each has a recommendation; none is decided here.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | The "no work tree" test in `providerFor` (design §Change 2 writes `ctx.layout.workDir === undefined`) | **a** `ctx.layout.bare \|\| ctx.layout.workDir === undefined` · **b** `ctx.layout.workDir === undefined` as written | **a** | A node context opened with `{ bare: true }` keeps `workDir` set (src/adapters/node/node-adapter.ts L114, L183; the interop suite's own `bareCtx` at test/integration/grep-interop.test.ts L276). Under b, `--cached` on that bare repo would read its index, and pin S (bare + `read-tree HEAD`, `--cached` ⇒ text) says git never does. a is git's `is_bare_repository()` (`Layout.bare` doc, src/ports/context.ts L54) and has precedent in src/application/commands/internal/read-mailmap.ts L23 (`ctx.layout.bare \|\| workDir === undefined`). |
| D2 | Where the `diff.default.binary` interop rows run (design: "a dedicated `it` that re-reads the config" in the shared fixture) | **a** a separate small git repo whose config holds `diff.default.binary=true` · **b** set the key in the shared fixture inside one `it`, unset it after | **a** | Under the default driver every unattributed file flips to binary, so b couples every other row to test order and needs a `finally` unset. a costs one `git init` and is isolated. |
| D3 | Where the blob-rev override is computed | **a** a private helper `blobOverride(ctx, named)` in `grep.ts` · **b** an exported helper in `grep-binary-override.ts` | **a** | It is three lines of target dispatch (`fromIndex ? readIndex : undefined`), the same kind of decision `grepRev` already makes; keeping it in `grep.ts` keeps Part 4 at 5 files and adds no export. |
| D4 | Whether `named` is set when a `<rev>:<path>` names a tree (`HEAD:sub`) | **a** set it (`{ path: 'sub', fromIndex: false }`); grep ignores it because the root kind is `'tree'` · **b** set it only when the resolved object is a blob | **a** | git's `oc.path` is set for any non-empty path. b needs an object-type read in `rev-parse.ts` for no consumer. The design only excludes the empty path (`HEAD:`). |

## Requirement map

| Req (design) | Delivered by |
|---|---|
| R1 the `diff` attribute decides before the sniff (`-diff`/`binary`/macro, bare `diff`, `diff=<name>`, default driver) | Part 1 (domain rows + property); Part 3 U1–U3, U6, U7, interop W1–W3, W5; Part 4 H6 |
| R2 targets that consult it: work tree, `'index'`, a commit rev (tags followed), a blob rev with a path (./ and ../ normalised) | Part 3 U1, U2 (work tree, `'index'`); Part 2 P1, R1 (kind + path); Part 4 V1, V2, V4, V6, interop H1, H3, H4 |
| R3 targets that do not: a tree object, a path-less blob | Part 2 P2 (GUARD); Part 4 V3, V5 (GUARDs), interop H2, H8 (GUARDs) |
| R4 sources: info, per-dir (wt then index), global; index only for targets that load it; bare reads neither; rev tree never | Part 3 U4, U5, U8, interop W6, W7; Part 4 V6, V6b, V7, interop H5, H7 |
| R5 forced verdict feeds the existing machinery (invert-aware count; forced text keeps NUL) | Part 3 U2, U3, U9, interop W2–W4 |
| R6 `textconv` never changes the verdict | Part 1 row (driver with only a textconv entry ⇒ `undefined`); Part 3 W1 fixture |
| R7 refusals and their order unchanged; no attribute read before rev + pathspec | Part 3 (reader is lazy, built in `grepCandidates`' scan, after the pathspec); Part 4 (override after `peelToTreeOrBlob`) + existing refusal suites stay green |
| ADR-1182 forced binary scanned whole | Part 3 U9, interop W4 |
| ADR-1183 no new option | nothing to build (`GrepOptions` unchanged) |
| Doc surfaces | Part 3 (JSDoc + `reports/api.json`); Part 5 (`grep.md`, `known-divergences.md`) |

## Part 1 — `userdiffBinaryOverride`: the `diff` attribute's binary verdict

### Context

**Files this part creates or edits (4):**

- `src/domain/diff/userdiff-binary.ts` (new)
- `test/unit/domain/diff/userdiff-binary.test.ts` (new)
- `test/unit/domain/diff/userdiff-binary.properties.test.ts` (new)
- `cspell.json` (two words)

**Public surface:** internal. `userdiffBinaryOverride`, `DiffDriverBinary`, `DiffDrivers`
are NOT added to src/domain/diff/index.ts (that barrel feeds the public `src/domain/index.ts`
entry, which would put them in reports/api.json). Consumers import the module directly,
as `binary-decision.ts` is imported today. knip will report the export unused until Part 3
consumes it; knip is not in the part gate.

**Read-only references:**

- src/domain/diff/binary-decision.ts — `export type BinaryOverride = 'binary' | 'text'`.
- src/domain/attributes/attribute-value.ts — `export type AttributeValue = true | false | 'unspecified' | { readonly set: string }`.
- src/application/primitives/config-read.ts L1394 — `config.diff?: Map<string, { textconv?; cachetextconv?; binary?: boolean }>`;
  `binary = auto` leaves `binary` absent; a `[diff "x"]` header creates an entry.
- src/application/primitives/internal/resolve-similarity-content-kind.ts — `resolveSimilarityOverride`
  (the narrower rule; this is the ADR-1180 size-red fallback, see Part 3).

**Target shape** (design §Change 1, verbatim except the two names):

```ts
import type { AttributeValue } from '../attributes/attribute-value.js';
import type { BinaryOverride } from './binary-decision.js';

/** git 2.56's builtin userdiff drivers: `diff=<name>` finds one even with no config. */
const BUILTIN_DRIVERS: ReadonlySet<string> = new Set([ /* 27 names, below */ ]);
const DEFAULT_DRIVER = 'default';

export interface DiffDriverBinary { readonly binary?: boolean }
export type DiffDrivers = ReadonlyMap<string, DiffDriverBinary> | undefined;

const tristate = (binary: boolean | undefined): BinaryOverride | undefined =>
  binary === undefined ? undefined : binary ? 'binary' : 'text';
const isDriver = (drivers: DiffDrivers, name: string): boolean =>
  drivers?.has(name) === true || BUILTIN_DRIVERS.has(name);

/** The `diff` attribute's verdict for a path; `undefined` leaves it to the NUL sniff. */
export const userdiffBinaryOverride = (value: AttributeValue, drivers: DiffDrivers): BinaryOverride | undefined => {
  if (value === false) return 'binary';
  if (value === true) return 'text';
  const named = typeof value === 'object' && isDriver(drivers, value.set) ? value.set : DEFAULT_DRIVER;
  return tristate(drivers?.get(named)?.binary);
};
```

Biome may refuse the nested ternary in `tristate`; if so, use an early return
(`if (binary === undefined) return undefined; return binary ? 'binary' : 'text';`).
`config.diff` (a `Map<string, {…binary?: boolean}>`) must be assignable to `DiffDrivers`
without a cast — check with `check:types` in Part 3.

**The 27 builtin names, pinned against local git 2.56.0 during planning** (throwaway repo,
`f diff=<name>` + `-c diff.default.binary=true`, `git grep -n NEEDLE HEAD`; a builtin name
prints the text line, any other prints `Binary file`):

```
ada bash <bib+tex> cpp csharp css dts elixir fortran fountain golang html java kotlin
markdown matlab <obj+c> pascal perl php python r ruby rust scheme swift tex
```

`<bib+tex>` is the single lower-case word `bib` followed by `tex`; `<obj+c>` is the
lower-case word `obj` followed by `c`. Both spellings were confirmed (git prints the text
line for them); `BibTeX`, `obj-c`, `objective-c` print `Binary file` (not builtin; names are
case-sensitive). Write them in the set in alphabetical position as listed.

**cspell:** `npx cspell` flags exactly these two words today (checked during planning).
Add each to `cspell.json` `"words"` at its alphabetical position, never re-sorting the
file: the bib word goes immediately **before** `"bidirectional"` (current L108, after
`"BIDX"` L107); the obj word goes between `"obase"` (L819) and `"objectformat"` (L820).

**Test conventions:** sibling example — test/unit/domain/diff/apply-hunks.properties.test.ts
(`import fc from 'fast-check'`, `fc.assert(fc.property(…), { numRuns })`). Property budget
(.claude/workflow/property-testing.md): 100 for invariant properties, 50 when filter-heavy.

### TDD steps

1. **RED D1** (`userdiff-binary.test.ts`, `const sut = userdiffBinaryOverride;`) — module
   does not exist yet, so the import fails. Write the whole example table as `it.each` rows
   under `describe('Given a diff attribute value and the configured drivers')` >
   `describe('When the binary verdict is resolved')` > `it('Then <label> gives <expected>')`:

   | value | drivers | expected |
   |---|---|---|
   | `false` | `default.binary=false` | `'binary'` |
   | `true` | `default.binary=true` | `'text'` |
   | `'unspecified'` | `undefined` | `undefined` |
   | `'unspecified'` | `default.binary=true` / `=false` | `'binary'` / `'text'` |
   | `{set:'drv'}` | `drv.binary=true` / `=false` / `drv:{}` | `'binary'` / `'text'` / `undefined` |
   | `{set:'drv'}` | `drv:{}` + `default.binary=true` | `undefined` (a configured driver never falls to default) |
   | `{set:'drv'}` | `drv:{}` (models a textconv-only section) | `undefined` |
   | `{set:'ghost'}` | `default.binary=true` | `'binary'` (unknown name ⇒ default) |
   | `{set:'cpp'}` | `default.binary=true` | `undefined` (builtin exists) |
   | `{set:'cpp'}` | `cpp.binary=true` | `'binary'` (config over builtin) |
   | `{set:'CPP'}` | `default.binary=true` | `'binary'` (case-sensitive) |

   Plus a second `it.each` over the 27 names (hard-coded list in the test — an independent
   oracle, not imported): `{set:<name>}` with `default.binary=true` ⇒ `undefined`. This kills
   each StringLiteral mutant in the set.
2. **GREEN** — the target shape above.
3. **GUARD D2** (`userdiff-binary.properties.test.ts`, invariant lens) — passes once GREEN is in:
   - a forced value (`fc.boolean()`) ignores any drivers map: result equals
     `value ? 'text' : 'binary'` for every generated map;
   - for any drivers map and any name that is neither builtin nor a key of the map
     (`fc.string()` filtered against the hard-coded 27 + the map's keys), the result for
     `{ set: name }` equals the result for `'unspecified'`.
   Drivers arbitrary: `fc.dictionary(fc.string(), fc.record({ binary: fc.option(fc.boolean(), { nil: undefined }) }, { requiredKeys: [] }))`
   mapped to a `Map`, sometimes `undefined` (`fc.option`). `numRuns: 100`, the filtered one `50`.
4. **REFACTOR** — doc comments say why (git's `userdiff_find_by_path` + the default driver),
   never what; every function ≤20 lines.

### Gate

```
npx vitest run test/unit/domain/diff/userdiff-binary.test.ts test/unit/domain/diff/userdiff-binary.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/diff/userdiff-binary.ts test/unit/domain/diff/userdiff-binary.test.ts test/unit/domain/diff/userdiff-binary.properties.test.ts cspell.json && npm run check:spelling
```

(wireit may cache: bypasses are `npx tsc --noEmit -p tsconfig.json` and `npx cspell --no-progress <files>`.)

### Commit

`feat(diff): resolve the diff attribute's binary verdict as git's userdiff does`

## Part 2 — the searchable kind tells a commit's tree apart, and a rev keeps the path it named

### Context

**Files this part edits (4):**

- `src/application/primitives/internal/peel.ts`
- `test/unit/application/primitives/internal/peel.test.ts`
- `src/application/commands/rev-parse.ts`
- `test/unit/application/commands/rev-parse.test.ts`

**Public surface:** internal. `peel.ts` is under `primitives/internal`. `rev-parse.ts`'s new
exports (`resolveRevisionWithPath`, `RevisionPath`, `NamedRevision`) are not re-exported:
src/application/commands/index.ts L304 re-exports only `type RevParseEntry, revParse`. No
api.json change. knip reports `resolveRevisionWithPath` unused until Part 4.

**peel.ts (current):** L43 `export type SearchableKind = 'tree' | 'blob';`, L45–48
`SearchableObject { kind; id }`, L55–66 `peelToTreeOrBlob(ctx, table, id)`: L60
`walkWith(ctx, table, id, tagHop)`; L62 returns `{ kind, id: deref.id }` for a tree or blob
reached by the tag walk; L65 returns `{ kind: 'tree', id: await rootTreeOf(ctx, deref.id) }`
for a commit (or an unparsed object, which `rootTreeOf` refuses). Only consumer:
src/application/commands/grep.ts L222/L224 (`root.kind === 'blob'`), which keeps compiling and
routes `'commit-tree'` to its tree branch unchanged — no grep.ts edit in this part.

**peel.ts (target):** `export type SearchableKind = 'commit-tree' | 'tree' | 'blob';` and L65
returns `kind: 'commit-tree'`. Update the JSDoc (L50–54) to say a commit's tree is told apart
because git checks attributes only under a commit.

**peel.test.ts:** `describe('peelToTreeOrBlob')` L249–522; helpers `blobOf` L252, `tagOf` L259
(`objectType: 'blob' | 'tag'` — widen to `'blob' | 'commit' | 'tag' | 'tree'`), `emptyTree`
L266, `createCommit` usage L311–318, `logging()` context. The commit row L305–328 asserts
`{ kind: 'tree', id: tree }` at L325; the tree-id row L330–345 asserts `'tree'` at L342.

**rev-parse.ts (current):**

- `resolveRevision(ctx, expression, source = 'command-line')` L241–250: new table,
  `readDifferenceSides(ctx, table, SIDES_BY_SOURCE[source](expression))`, then
  `readNamedObject(ctx, table, expression, expression)` (stdin: `readReporting`).
- `readReporting(ctx, table, expression, accepts?)` L192–204 → `evaluateTyped`.
- `readNamedObject(ctx, table, name, arg)` L257–269 → `readReporting` + misspelt re-read.
- `evaluateRevision` L386, `evaluateTyped(ctx, table, expression, options)` L390–400
  (operational + settings gates, `parseExpression`, `evaluate`).
- `evaluate(ctx, table, expr, raw, options)` L402–431: `index-stage` branch L409–411
  (`resolveIndexStage(ctx, { stage, path: resolveRelativePath(ctx, expr.path) })`);
  `tree-path` branch L412–415 (`mayReadWhole(raw) ? readWholeName(…) : undefined`, then
  `resolveTreePath(ctx, table, expr.rev, expr.path, options.mode)`).
- Other `evaluate` callers: `readWholeName` L446, `resolveTreePath` L760 (base rev).
- `resolveTreePath` L753–771: evaluates the base FIRST, then `resolveRelativePath(ctx, rawPath)`
  L764, peel to tree, `path === ''` ⇒ the tree.
- `resolveRelativePath(ctx, path): string` L780–787 (a ./ or ../ prefix taken against `ctx.cwd`;
  refusals `WORK_TREE_REQUIRED`, `PATHSPEC_OUTSIDE_REPO`).
- `resolveIndexStage` L734–743 reads the index (`readIndex`).

**rev-parse.ts (target, design §Change 4):**

```ts
/** The path a rev named, and whether naming it read the index (`:path`, `:N:path`). */
export interface RevisionPath { readonly path: FilePath; readonly fromIndex: boolean }
/** An object id plus git's object-context path, when the name carried one. */
export interface NamedRevision { readonly id: ObjectId; readonly named?: RevisionPath }
/** `resolveRevision` (command line) plus the path the name carried. */
export const resolveRevisionWithPath = async (ctx: Context, expression: string): Promise<NamedRevision> => {
  const table = createObjectTypeTable();
  await readDifferenceSides(ctx, table, differenceSides(expression));
  return readNamedObjectWithPath(ctx, table, expression, expression);
};
```

Thread `NamedRevision` through the chain by giving each step a `…WithPath` body and keeping
the existing name as a thin `.then(({ id }) => id)` wrapper, so every existing caller and
signature is untouched: `evaluateWithPath` (the current `evaluate` body), `evaluateTypedWithPath`,
`readReportingWithPath`, `readNamedObjectWithPath` (both private). `named` is set only in:

- `index-stage`: `path = resolveRelativePath(…)`, `{ id: await resolveIndexStage(…), named: { path, fromIndex: true } }`;
- `tree-path`, when the split is used (not a whole-name hit): `resolveTreePath` returns
  `NamedRevision` — `named: { path, fromIndex: false }` when `path !== ''`, absent for `''`
  (D4: set for a tree path too). Keep its order: base evaluated before `resolveRelativePath`.
- Every other branch (and a whole-name hit through `readWholeName`) carries no `named`.
- Build the optional field with a conditional spread (exactOptionalPropertyTypes). `path`
  becomes `FilePath` via `as FilePath`, the precedent at L785.
- REFACTOR may make `resolveRevision`'s command-line branch call `resolveRevisionWithPath`
  — only if the table and read sequence stay identical.

**rev-parse.test.ts helpers:** imports L1–23 (`evaluateRevision, resolveRevision`; add
`resolveRevisionWithPath`); `writeBlob` L38, `writeCommit` L45, `writeTag` L61
(`targetType: 'commit' | 'tag'`), `writeIndexFile(ctx, [{ path, id, stage }])` L79;
`seedRepo` from ./fixtures.js. Tree-path block `describe('Given a tree-ish with a path')`
L667 with `seedTree(ctx)` L668 (`a.txt`, `sub/b.txt`, ref `refs/heads/main`); cwd-in-sub
pattern L818–828 (`{ ...repo, cwd: `${repo.layout.workDir}/sub` } as Context`); index-stage
block L1219–1252. Put the new rows in a new top-level `describe('resolveRevisionWithPath')`
at the file end, reusing `seedTree` (hoist it to module scope if needed — it is local to
the L667 describe) and `writeIndexFile`.

### TDD steps

1. **RED P1** (peel.test.ts): rewrite the commit row L305–328 to `Then it answers the
   commit-tree kind and its root tree id`, asserting `{ kind: 'commit-tree', id: tree }`.
   Add `Given an annotated tag naming a commit` ⇒ `{ kind: 'commit-tree', id: tree }`
   (`tagOf(ctx, commit, 'commit')`). Both fail: the code answers `kind: 'tree'`.
2. **GUARD P2:** `Given an annotated tag naming a tree` ⇒ `{ kind: 'tree', id: tree }`
   (`tagOf(ctx, tree, 'tree')`). Passes today (the tag walk returns a tree as is) and keeps
   the tree object out of `'commit-tree'` after GREEN. The tree-id row L330 is a second GUARD.
3. **GREEN P:** widen `SearchableKind`, return `'commit-tree'` at L65, update the JSDoc.
4. **RED R1** (rev-parse.test.ts, `const sut = resolveRevisionWithPath;`): rows
   (`it.each`, seedTree + `writeIndexFile(ctx, [{ path: 'a.txt', id: blobA, stage: 0 }])`):

   | rev | cwd | expected |
   |---|---|---|
   | `main:a.txt` | root | `{ id: blobA, named: { path: 'a.txt', fromIndex: false } }` |
   | `main^{tree}:a.txt` | root | same |
   | `main:./b.txt` | `sub` | `{ id: blobB, named: { path: 'sub/b.txt', fromIndex: false } }` |
   | `:a.txt` / `:0:a.txt` | root | `{ id: blobA, named: { path: 'a.txt', fromIndex: true } }` |
   | `main:sub` | root | `{ id: sub, named: { path: 'sub', fromIndex: false } }` (D4) |
   | `main:` / `<blobA oid>` / `main` | root | `{ id }` with no `named` key (`toStrictEqual`) |

   Fails: `resolveRevisionWithPath` is not exported (import is `undefined`, so the call
   throws `TypeError: sut is not a function`).
5. **GREEN R:** the target shape and the `…WithPath` threading.
6. **GUARD R2:** the existing `resolveRevision` / `evaluateRevision` suites (whole file)
   stay green — they prove the wrappers changed no id or refusal.
7. **REFACTOR:** each function ≤20 lines; no duplicated branch between the wrappers.

### Gate

```
npx vitest run test/unit/application/primitives/internal/peel.test.ts test/unit/application/commands/rev-parse.test.ts test/unit/application/commands/grep.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/peel.ts src/application/commands/rev-parse.ts test/unit/application/primitives/internal/peel.test.ts test/unit/application/commands/rev-parse.test.ts && npm run check:spelling
```

(grep.test.ts is run as a GUARD: `peelToTreeOrBlob`'s only consumer must stay green.)

### Commit

`refactor(rev-parse): tell a commit's tree from a tree object and keep the path a rev names`

## Part 3 — work-tree and index targets honour the `diff` attribute; forced binary is scanned whole

### Context

**Files this part creates or edits (5):**

- `src/application/commands/internal/grep-binary-override.ts` (new)
- `src/application/commands/grep.ts`
- `test/unit/application/commands/grep.test.ts`
- `test/integration/grep-interop.test.ts`
- `reports/api.json` (regenerated with `npm run docs:json`, never hand-edited)

**Public surface:** `grep-binary-override.ts` is internal (commands/internal, no barrel).
No new public symbol. The JSDoc of the public `GrepBlobResult.binaryMatch` /
`binaryMatchCount` changes, which changes `reports/api.json` (current text at L105824 and
L106434: "Blob is binary AND some line of its first 64 KiB …"). `check:doc-typedoc` is a
**pre-push** gate, not in `validate`: run `npm run docs:json` after the JSDoc edit and
commit `reports/api.json` in this part (a large id-renumbering diff is normal).

**New module (design §Change 2, with D1 applied):**

```ts
import type { IndexEntry } from '../../../domain/git-index/index.js';
export type GrepBinaryOverrideOf = (path: FilePath) => Promise<BinaryOverride | undefined>;
/** The index a target loaded, when it loaded one: git's attribute fallback reads only a loaded index. */
export type LoadedIndex = { readonly entries: ReadonlyArray<IndexEntry> } | undefined;

const providerFor = (ctx: Context, index: LoadedIndex): Promise<AttributeProvider> =>
  ctx.layout.bare || ctx.layout.workDir === undefined || index === undefined
    ? buildAttributeProvider(ctx)
    : buildCheckinAttributeProvider(ctx, index);

export const grepBinaryOverrideReader = (ctx: Context, index: LoadedIndex): GrepBinaryOverrideOf => {
  const provider = lazily(() => providerFor(ctx, index));
  const drivers = lazily(async () => (await readConfig(ctx)).diff);
  return async (path) => {
    const { sources, macros } = await (await provider()).sourcesForPath(path);
    return userdiffBinaryOverride(resolveAttribute(sources, path, 'diff', macros), await drivers());
  };
};
```

Imports: `buildAttributeProvider`, `buildCheckinAttributeProvider`, `type AttributeProvider`
from ../../primitives/internal/read-gitattributes.js (L285, L339, L212);
`lazily` from ../../primitives/internal/lazily.js (memoises the first call);
`readConfig` from ../../primitives/config-read.js (L550, session-cached);
`resolveAttribute` from ../../../domain/attributes/index.js;
`userdiffBinaryOverride` from ../../../domain/diff/userdiff-binary.js (Part 1);
`type BinaryOverride` from ../../../domain/diff/binary-decision.js.
`buildAttributeProvider(ctx)` with no direction reads the work tree only (plus
`info/attributes` and `core.attributesFile`); in a context without `workDir` the work-tree
reader yields nothing (read-gitattributes.ts L43–50).

**grep.ts (current line map):** imports L1–21 (`isBinary, MAX_LINE_BYTES, splitLines` from
../../domain/diff/index.js L2; `readBlob, readIndex, walkTree` L13);
JSDoc `GrepBlobResult` L32–46; `Candidate` L76–79 (unchanged);
`enumerateWorkingTree(ctx, workDir)` L84–105 calls `readIndex` at L88;
`enumerateIndex(ctx)` L107–118 calls `readIndex` at L108;
`enumerateCandidates(ctx, target)` L137–148 calls `requireWorkTree(ctx, 'grep')` FIRST for the
work-tree target; `countReturnedLines(matcher, bytes)` L153–155 (window
`bytes.subarray(0, MAX_LINE_BYTES)`); `scanBlob(matcher, bytes)` L157–174 (branches on
`isBinary(bytes)`); `grepBlob` L176–179; `scanCandidate(matcher, candidate)` L181–187;
`grepCandidates(ctx, matcher, pathspecMatcher, candidates)` L197–209 (pathspec filter, then
`boundedMapFor(ctx, 'ioBound', inScope, …)`); `grepRev` L213–226; `grep` L228–252 (pathspec
L250 BEFORE enumeration L251).

**grep.ts (target):**

- `scanBlob(matcher, bytes, override?: BinaryOverride)` branches on
  `sideIsBinary(bytes, override)` (import from ../../domain/diff/binary-decision.js; drop
  `isBinary` from the import if unused). Binary branch:
  `countReturnedLines(matcher, binaryWindow(bytes, override))` with
  ```ts
  // A forced-binary file has text-shaped lines, so its whole buffer costs what the text path
  // already pays; the window stays a safety bound for NUL-sniffed blobs.
  const binaryWindow = (bytes: Uint8Array, override: BinaryOverride | undefined): Uint8Array =>
    override === 'binary' ? bytes : bytes.subarray(0, MAX_LINE_BYTES);
  ```
  `countReturnedLines` then takes the already-windowed bytes (move the subarray out of it;
  keep the existing why-comment, reworded to the NUL-sniffed case).
- `scanCandidate(matcher, candidate, overrideOf?: GrepBinaryOverrideOf)`: resolve
  `await overrideOf?.(candidate.path)` before `candidate.load()`.
- `grepCandidates(…, candidates, overrideOf?)` passes it through (the reader runs only on
  in-scope candidates — ADR-1181).
- Read the index once. Keep the refusal order: `requireWorkTree` still runs before any
  index read. Suggested shape:
  ```ts
  interface Enumerated { readonly candidates: ReadonlyArray<Candidate>; readonly index: GitIndex }
  async function enumerateCandidates(ctx, target): Promise<Enumerated> {
    const workDir = target === undefined ? requireWorkTree(ctx, 'grep') : undefined;
    const index = await readIndex(ctx);
    const candidates = workDir === undefined ? enumerateIndex(ctx, index) : await enumerateWorkingTree(ctx, workDir, index);
    return { candidates, index };
  }
  ```
  `enumerateWorkingTree(ctx, workDir, index)` / `enumerateIndex(ctx, index)` take the index
  instead of reading it. `grep()` then calls
  `grepCandidates(ctx, matcher, pathspecMatcher, candidates, grepBinaryOverrideReader(ctx, index))`.
  `GitIndex` type: ../../domain/git-index/index.js. Keep the existing comment on why only
  the work-tree target requires a work tree.
- `grepRev` and `grepBlob` are untouched in this part (Part 4).
- JSDoc `binaryMatch` (L33–39): "Blob is binary — by its `diff` attribute or, absent one, by
  the NUL sniff — AND some line the matcher returns (`invert`-aware): the whole blob when the
  attribute forced binary, its first 64 KiB when the sniff decided. `hits` stays empty …".
  `binaryMatchCount` (L41–45) likewise: "Lines of a binary blob the matcher returns (the
  whole blob under a forced-binary attribute, its first 64 KiB otherwise) — git's `-c` count".

**Size gate (this part adds the most bundled src):** after GREEN run
`rm -rf dist .wireit && npm run build && npm run check:size` (caps sit <100 B above
measurement; stale dist chunks give false reds — hence the `rm`). If red: ADR-1180's
fallback — replace `userdiffBinaryOverride(value, drivers)` in the reader with the narrower
rule `resolveSimilarityOverride(value, typeof value === 'object' ? drivers?.get(value.set)?.binary : undefined)`
(src/application/primitives/internal/resolve-similarity-content-kind.ts L19), drop U7 and
W5 (default-driver rows) from this part, and escalate `{ unit: Part 3, reason: size-limit
red by <n> B, options: [fallback b + ledger row for diff.default.binary, raise cap, trim
elsewhere] }` instead of choosing silently.

**Unit test file — test/unit/application/commands/grep.test.ts:** module-local helpers
`seedRepo()` L47 (`createMemoryContext` + `init`), `writeAndStage(ctx, path, content)` L52,
`commitAll(ctx)` L57, `enc`/`dec` L44–45; `asBareContext` imported from ./fixtures.js L36
(drops `workDir`, sets `bare: true`); `MAX_LINE_BYTES` imported L16; existing 64 KiB NUL row
L546–563. Binary bytes: `await ctx.fs.write(`${ctx.layout.workDir}/f2`, enc('x NEEDLE\0y\n'))`
then `await add(ctx, ['f2'])`. Delete a work-tree file: `ctx.fs.rm(path)` (as L248).
Config: append, never overwrite (init wrote `core.*`):
`const cfg = `${ctx.layout.gitDir}/config`; await ctx.fs.writeUtf8(cfg, `${await ctx.fs.readUtf8(cfg)}[diff "drv"]\n\tbinary = true\n`); __resetConfigCacheForTests();`
— import `__resetConfigCacheForTests` from ../../../../src/application/primitives/config-read.js
(config-read.ts L640). Info attributes: `ctx.fs.writeUtf8(`${ctx.layout.gitDir}/info/attributes`, 'f1 binary\n')`.
Add a new top-level `describe('Given a diff attribute')` at the end of the file (after L1711).
Fixture: `f1 = 'a NEEDLE\nb\nNEEDLE c\n'`, `f2 = 'x NEEDLE\0y\n'`, pattern `{ fixed: 'NEEDLE' }`.
Assert by finding the entry: `result.paths.find((p) => p.path === 'f1')`.

**Interop file — test/integration/grep-interop.test.ts:** helpers at the top: `SETUP_TIMEOUT`
L28, `LIT = 'NEEDLE'` L31, `datedEnv(epoch)` L33, `countOf(match)` L50, `text(line)` L94,
`lines(out)` L100; imports `git(dir, …args)` (throws on non-zero exit), `runGit(args, { env, input })`,
`tryRunGitWithExit(args)` (`{ stdout, exitCode }`, use when git may exit 1),
`runGitEnv`, `GIT_AVAILABLE` from ./interop-helpers.js; `createNodeContext({ workDir })`.
The existing `describe.skipIf(!GIT_AVAILABLE)('grep interop')` spans L117–856 — do NOT add
`.gitattributes` to its fixture (it would change existing `-v`/`-L` rows). Add a new
top-level `describe.skipIf(!GIT_AVAILABLE)('Given a diff attribute', …)` after L856 with its
own `beforeAll(…, SETUP_TIMEOUT)` / `afterAll` (`rm(dir, { recursive: true, force: true })`).

Main fixture (`mkdtemp(path.join(os.tmpdir(), 'tsgit-grep-attr-'))`, `git init -q -b main`,
user name/email config, commit with `datedEnv`):

```
.gitattributes   [attr]opaque -diff
                 bin.txt binary
                 neg.txt -diff
                 diffed.dat diff
                 macro.txt opaque
                 unset.dat !diff
                 strict.txt diff=strict
                 loose.dat diff=loose
sub/.gitattributes  nested.txt binary
text files (bin, neg, macro, strict, plain .txt, sub/nested.txt): 'a NEEDLE\nb\nNEEDLE c\n'
NUL files (diffed, unset, loose, plain .dat): Buffer.from('x NEEDLE\0y\n')
config: git config diff.strict.binary true ; git config diff.loose.binary false
```

Rebuild git's `-n` output from tsgit data, per path `p` with label prefix `pre` (`''` for the
work tree / `--cached`, `HEAD:` in Part 4):
`p.binaryMatch ? [`Binary file ${pre}${p.path} matches`] : p.hits.map((h) => `${pre}${p.path}:${h.lineNumber}:${text(h.line)}`)`.
Add it as a module-level helper next to `blobLines` (e.g. `pathLines(pre, result)`), and
compare `[...].sort()` against `lines(git(dir, 'grep', '-n', '-F', LIT, …)).sort()`.
`-c` rows: `${pre}${p.path}:${countOf(p)}` vs `git grep -c -F NEEDLE`; `-v -c` likewise with
`invert: true`.

### TDD steps

1. **RED U1–U3, U5–U7** (unit, `const sut = grep;`, one `describe` per Given, run before any
   GREEN — they all fail because no attribute is read today):
   - U1 `.gitattributes` `f1 binary`, f1 committed; `it.each` target `'index'` and work tree
     (`undefined`) ⇒ f1 entry `{ path: 'f1', hits: [], binaryMatch: true, binaryMatchCount: 2 }`.
     Today: text hits on lines 1 and 3.
   - U2 `f2 diff` (NUL) same two targets ⇒ f2 `hits` = one hit, line 1, `line` equals
     `enc('x NEEDLE\0y\n')`, spans `[{ start: 2, end: 8 }]`, `binaryMatch: false`,
     `binaryMatchCount: 0`. Today: `binaryMatch: true`.
   - U3 `f1 binary`, `invert: true`, `'index'` ⇒ `{ hits: [], binaryMatch: true, binaryMatchCount: 1 }`.
     Today: one text hit (`b`).
   - U5 `.gitattributes` staged with `f1 binary`, then removed from the work tree
     (`ctx.fs.rm`), targets `'index'` and work tree ⇒ f1 binary (the index fallback).
     Today: text.
   - U6 `f1 diff=drv` + config `[diff "drv"] binary = true` ⇒ `'index'` f1 binary. Today: text.
   - U7 no `.gitattributes`, config `[diff "default"] binary = true` ⇒ `'index'` f1 binary.
     Today: text.
2. **RED W1–W3, W5, W6** (interop, before GREEN):
   - W1 work tree and `--cached` `-n` lines equal git (sorted). Fails: bin/neg/macro/strict
     print text lines in tsgit; diffed/loose print `Binary file` in tsgit.
   - W2 `-c` on `--cached` equal git. W3 `-v -c` on `--cached` equal git.
   - W5 default-driver repo (D2): second small repo, `.gitattributes` `ghost.txt diff=ghost`
     and `cpp.txt diff=cpp`, files `ghost.txt`, `cpp.txt`, `plain.txt` (text with NEEDLE),
     `git config diff.default.binary true`; `--cached` `-n` lines equal git (git: ghost and
     plain `Binary file`, cpp text). Fails: tsgit prints text for ghost and plain.
   - W6 source row C: small repo, commit `.gitattributes` `f1 binary` + f1, then delete the
     work-tree `.gitattributes` (index copy stays) ⇒ `--cached` and work tree equal git
     (`Binary file f1 matches`). Fails: tsgit greps f1 as text.
3. **GREEN 1:** `grep-binary-override.ts`, `scanBlob`/`scanCandidate`/`grepCandidates`
   override threading, `enumerateCandidates` reading the index once and returning it,
   `grep()` passing the reader. Keep `binaryWindow` OUT of this step: `countReturnedLines`
   still windows every binary blob.
4. **GUARD U4:** `.gitattributes` staged with `f1 binary`, then the work-tree copy emptied
   (`ctx.fs.writeUtf8(…, '')`, not staged) ⇒ work tree and `'index'` f1 text. Passes before
   GREEN 1 (no attributes) and after it (the work-tree file wins over the index copy); it
   kills an index-first provider.
5. **GUARD U8** (pins D1's `bare` half): same as U5 (work-tree copy deleted, index says
   binary), then `const bareFlagged = { ...ctx, layout: { ...ctx.layout, bare: true } } as Context;`
   target `'index'` ⇒ f1 text. Also `asBareContext(ctx)` with `'index'` ⇒ text. Passes before
   and after GREEN 1 when D1 a is applied; with only `workDir === undefined` the first row
   goes red. If `assertOperationalRepository` refuses the hybrid layout (`bare: true` with a
   `workDir`), drop that row and rely on interop W7, which pins the same term with the node
   adapter's real bare layout.
6. **GUARD W7** (interop, bare S): `git clone -q --bare` of repo C (W6) to `<C>-bare.git`,
   then `git --git-dir=<bare> read-tree HEAD` (gives the bare repo an index holding
   `.gitattributes`); `createNodeContext({ workDir: bare, gitDir: bare, bare: true })`;
   `--cached` equals git (text: git never reads a bare repository's index). Green before and
   after GREEN 1; red only if D1's `bare` term is dropped. Leave this clone WITHOUT
   `info/attributes` — Part 4 reuses it as its "no info file" bare row.
7. **RED U9 + W4** (window rule): `big.txt` (unit: `'x\n'.repeat(MAX_LINE_BYTES / 2 + 16) + 'NEEDLE\n'`
   with `big.txt binary`) ⇒ `{ path: 'big.txt', hits: [], binaryMatch: true, binaryMatchCount: 1 }`;
   interop W4, in its own small repo (keeps the main fixture's rows independent of the window
   step): `.gitattributes` `big.txt binary`, `big.txt` = `'x\n'.repeat(40_000) + 'NEEDLE\n'`
   (≈80 KB, the only match past 64 KiB); `--cached` `-n` lines and `-c` equal git
   (`Binary file big.txt matches`, `big.txt:1`). Both fail after GREEN 1: the 64 KiB window drops the only match, so the path is
   not reported.
8. **GREEN 2:** `binaryWindow`.
9. **GUARD U10:** the existing NUL-blob row L546–563 (match past 64 KiB, no attribute ⇒ not
   reported) stays green: the window is kept when the sniff decided. Kills a whole-buffer
   window for every binary blob.
10. **REFACTOR:** every function ≤20 lines, nesting ≤2; JSDoc edits; `npm run docs:json` and
    stage `reports/api.json`; size gate (above).

### Gate

```
npx vitest run test/unit/application/commands/grep.test.ts test/integration/grep-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/grep.ts src/application/commands/internal/grep-binary-override.ts test/unit/application/commands/grep.test.ts test/integration/grep-interop.test.ts && npm run check:spelling && rm -rf dist .wireit && npm run build && npm run check:size
```

### Commit

`fix(grep): honour the diff attribute's binary verdict on the work tree and the index`

## Part 4 — rev targets: a commit's tree and a blob rev with a path honour the attribute

### Context

**Files this part edits (5):**

- `src/application/commands/internal/resolve-rev.ts`
- `src/application/commands/diff.ts`
- `src/application/commands/grep.ts`
- `test/unit/application/commands/grep.test.ts`
- `test/integration/grep-interop.test.ts`

**Public surface:** none new. `resolveReference` is internal (commands/internal). If
`git diff --stat reports/api.json` changes after `npm run docs:json`, commit it in this part.

**resolve-rev.ts (current) L21–29:**
`resolveReference(ctx, table, rev): Promise<ObjectId>` = `resolveRevision(ctx, rev)` then
`requireReference(ctx, table, rev, id)`. Callers: src/application/commands/diff.ts L73–74
(`fromId`, `toId`, then `peelToTree(ctx, table, fromId)` L75–76) and grep.ts L220.

**resolve-rev.ts (target, ADR-1178):** returns `Promise<NamedRevision>` (Part 2 type from
../rev-parse.js): `const resolved = await resolveRevisionWithPath(ctx, rev); await requireReference(ctx, table, rev, resolved.id); return resolved;`.
Update its JSDoc ("…and the path the rev named, when it named one"). `resolveCommit` and
`peelToTree` unchanged; `resolveRevision` import stays for `resolveCommit`.

**diff.ts:** L73–74 take `.id` (`const { id: fromId } = await resolveReference(…)`; `toId`
likewise under its ternary). No behaviour change; existing diff suites are the GUARD.

**grep.ts `grepRev` (current L213–226 → target):**

```ts
const { id, named } = await resolveReference(ctx, table, rev);
const pathspecMatcher = pathspecFor(ctx, paths);
const root = await peelToTreeOrBlob(ctx, table, id);
if (root.kind === 'blob') return grepBlob(ctx, matcher, root.id, await blobOverride(ctx, named));
// git checks attributes under a commit only; a tree object keeps the content sniff.
const overrideOf = root.kind === 'commit-tree' ? grepBinaryOverrideReader(ctx, undefined) : undefined;
return grepCandidates(ctx, matcher, pathspecMatcher, await enumerateTree(ctx, root.id), overrideOf);
```

`blobOverride(ctx, named?: RevisionPath): Promise<BinaryOverride | undefined>` (D3, private
in grep.ts): `undefined` when `named` is absent; otherwise
`grepBinaryOverrideReader(ctx, named.fromIndex ? await readIndex(ctx) : undefined)(named.path)`.
`grepBlob(ctx, matcher, id, override?)` passes it to `scanBlob`. A rev target never passes
the index unless the name read it (`:path`, `:N:path`) — rows C/E of the design.
Refusal order (rev → pathspec → peel) is unchanged: the override is computed after the peel.

**Unit file:** Part 3's `describe('Given a diff attribute')` at the end of grep.test.ts and
its helpers; blob-target helpers `writeTagObject(ctx, tagName, object, objectType)` L1330
(`objectType: 'blob' | 'tag' | 'tree'` — add `'commit'`), `tagCreate(ctx, { name, target })`
as at L1352, `resolveRevision(ctx, 'HEAD:f1')` for an oid (L1350), `F1_HITS` L1381,
`project(hits)` L1378, `blobHits(result)` L1386. Write the attribute rows in the new
describe (not in `Given a blob target`).

**Interop file:** Part 3's `Given a diff attribute` describe. Extend its `beforeAll` (after
the commit, before building the context): `git tag -a -m m ct HEAD` and
`git tag -a -m m tt HEAD^{tree}` with `datedEnv`. Also create a second bare clone of repo C
(`<C>-bare-info.git`) and write `f1 binary` to its `info/attributes` (`mkdir -p` the `info`
dir first). Blob rows rebuild
`result.blob?.binaryMatch ? `Binary file ${target} matches` : blobLines(target, result)` and
compare to `lines(git(dir, 'grep', '-n', '-F', LIT, target))` (existing pattern L570–581).
Tree rows use Part 3's `pathLines('HEAD:', result)` (prefix = the rev as typed, e.g. `ct:`).

### TDD steps

1. **RED V1, V2, V7** (unit, before GREEN 1):
   - V1 `f1 binary`; `it.each` targets `{ treeish: 'HEAD' }` and an annotated tag of HEAD
     (`writeTagObject(ctx, 'ct', headId, 'commit')` + `tagCreate`) ⇒ f1
     `{ hits: [], binaryMatch: true, binaryMatchCount: 2 }`. Today: text hits.
   - V2 `f2 diff`, `HEAD` ⇒ f2 text hit on line 1. Today: `binaryMatch: true`.
   - V7 `asBareContext(ctx)` after committing f1 with no `.gitattributes`, plus
     `${gitDir}/info/attributes` = `f1 binary`, target `HEAD` ⇒ f1 binary. Today: text.
2. **RED H1** (interop): targets `HEAD` and `ct` `-n` lines equal git (sorted); `-c` on
   `HEAD` equals git. Fails: bin/neg/macro/strict text in tsgit, diffed/loose binary.
   **RED H5:** the second bare clone (`<C>-bare-info.git`, `info/attributes` = `f1 binary`),
   target `HEAD` equals git (`Binary file HEAD:f1 matches`). Fails: text.
   **RED H6:** the default-driver repo (Part 3 W5), target `HEAD` equals git.
3. **GREEN 1:** `resolveReference` returns `NamedRevision`; `diff.ts` takes `.id`;
   `grepRev` passes `grepBinaryOverrideReader(ctx, undefined)` for `'commit-tree'`.
   Blob roots still get no override in this step.
4. **GUARD V3 / H2:** `f1 binary`, targets `HEAD^{tree}` and a tag of the tree ⇒ f1 text
   (`F1_HITS`); interop `HEAD^{tree}`, `tt`, `HEAD:sub` equal git (all text — git reads no
   attribute for a tree object, even with `sub/.gitattributes`). Green before and after.
5. **GUARD H7** (source rows, rev side): repo C (work-tree `.gitattributes` deleted, index
   copy `f1 binary`) targets `HEAD` and `HEAD:f1` equal git (text); repo A (attribute only in
   the HEAD tree: commit `f1 binary`, then write an empty `.gitattributes` and stage it) target
   `HEAD` equals git (text — the rev's tree is never read); Part 3's bare clone S (no
   `info/attributes`) target `HEAD` equals git (text). Green after GREEN 1
   because a rev target gets the work-tree-only provider.
6. **RED V4, V6** (unit, blob revs): `f1 binary`, targets `HEAD:f1`, `:f1`, `:0:f1`,
   `HEAD^{tree}:f1` ⇒ `result.blob` `{ hits: [], binaryMatch: true, binaryMatchCount: 2 }`;
   V6: work-tree `.gitattributes` deleted, index copy `f1 binary`, target `:f1` ⇒ binary.
   Today (after GREEN 1): text hits — the blob root gets no override.
   **RED H3/H4** (interop): `HEAD:bin.txt`, `:bin.txt`, `HEAD:sub/nested.txt` (`Binary file`
   in git), `HEAD:diffed.dat` (text in git), and repo C's `:f1` (`Binary file :f1 matches`)
   equal git. Fail for the same reason.
7. **GREEN 2:** `blobOverride` + `grepBlob(…, override)`.
8. **GUARD V5 / H8:** `f1 binary`, targets the f1 oid and an annotated tag of the blob ⇒
   `blob` text hits (`F1_HITS`); V6b: same fixture as V6, target `HEAD:f1` ⇒ text (the rev
   never loaded the index). Interop: `<bin.txt oid>` equals git (text). Green before and
   after GREEN 2; V6b kills `fromIndex` being ignored.
9. **REFACTOR:** `grepRev` ≤20 lines; `npm run docs:json` and check `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/commands/grep.test.ts test/unit/application/commands/diff.test.ts test/integration/grep-interop.test.ts test/integration/diff-object-types-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/resolve-rev.ts src/application/commands/diff.ts src/application/commands/grep.ts test/unit/application/commands/grep.test.ts test/integration/grep-interop.test.ts && npm run check:spelling
```

(diff.test.ts and diff-object-types-interop.test.ts are the GUARD for the `diff.ts` edit.)

### Commit

`fix(grep): honour the diff attribute on a commit's tree and on a blob rev that names a path`

## Part 5 — `grep.md` documents the attribute rule; the ledger records the empty-section residual

### Context

**Files this part edits (2), docs only — no `src/` delta:**

- `docs/use/commands/grep.md`
- `docs/known-divergences.md`

**grep.md (current):** Signature comments L39–40 (`binaryMatch` / `binaryMatchCount`: "first
64 KiB"); Behaviour "Binary blobs" bullet L87–92; Divergences L111–141, the 64 KiB bullet
L131–141.

Edits (design §Doc surfaces):

- L39–40 comments: binary by attribute or sniff; whole blob under a forced-binary attribute,
  first 64 KiB otherwise.
- "Binary blobs" bullet: the verdict order — `-diff` / `binary` (or a macro setting `-diff`)
  forces binary; bare `diff` forces text (NUL kept in `line`); `diff=<name>` uses
  `diff.<name>.binary` when that driver exists (configured, or one of git's builtin driver
  names); otherwise `diff.default.binary`; otherwise the NUL sniff. `textconv` never changes
  the verdict. Which targets read it: work tree, `'index'`, a rev that dereferences to a
  commit (tags followed), a blob rev that names a path (`HEAD:f`, `:f`, `:0:f`); which do not:
  a tree object (`HEAD^{tree}`, a tree oid or tag of one, `HEAD:sub`), a blob named by oid or
  tag. Sources: `info/attributes`, the work-tree `.gitattributes` (the index copy only for
  the work tree, `'index'` and a `:path` rev), `core.attributesFile`; never the rev's own
  tree; a bare repository reads only `info/attributes` and `core.attributesFile`.
- Divergences 64 KiB bullet: "a blob the NUL sniff marks binary" (a forced-binary blob is
  scanned whole). New bullets: `attr.tree` / `--attr-source` / `GIT_ATTR_SOURCE` not
  implemented (link to known-divergences.md row 31.9); a `[diff "<name>"]` section with no
  keys counts as a driver in tsgit (sniff) where git routes it to the default driver — only
  observable under `diff.default.binary` (link to the new ledger row).

**known-divergences.md:** add a row under `## Rare configuration and edge input` (L105),
after the 31.9 row (L111–113), in the file's row style:
`- **32.56** (grep) — an empty `[diff "<name>"]` section …` with the proof pinned in the design:
git 2.56.0, `g diff=emp`, `[diff "emp"]` header with no keys, `diff.default.binary=true` ⇒
`Binary file HEAD:g matches`; tsgit treats `emp` as a configured driver with `binary` unset
and greps `g` as text. Edge: needs both an empty section and `diff.default.binary`.

### TDD steps

1. **GUARD (docs):** `npx cspell --no-progress docs/use/commands/grep.md docs/known-divergences.md`
   clean and `npm run check:doc-coverage` green before and after (no new command, no new
   page). No code, no RED.
2. **Edit** the two files as above; keep the line width of each file.
3. **REFACTOR:** re-read both sections against the design pins (§Pinned matrix) — every
   claim must match a pinned row.

### Gate

```
npx cspell --no-progress docs/use/commands/grep.md docs/known-divergences.md && npm run check:doc-coverage && npm run check:spelling
```

### Commit

`docs(grep): document the diff attribute's binary verdict and the empty-section residual`
