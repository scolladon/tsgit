# Plan — `grep` of a blob target

> Source: design doc `docs/design/grep-blob-target.md` · ADRs 1171, 1172, 1173, 1174, 1175
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

Four parts, sequential on one working tree:

```
Part 1  fix(grep)      binary verdict line-wise + invert-aware (ADR-1174)    grep.ts
Part 2  refactor(peel) peelToTreeOrBlob over peel's shared walk (ADR-1173)  peel.ts
Part 3  fix(grep)      blob target: resolveTreeOrBlob + GrepResult.blob     grep.ts, resolve-rev.ts
        (ADRs 1171, 1172, 1175)
Part 4  docs(grep)     grep.md: blob target, label rule, binary verdict     docs only
```

Order rationale: the binary fix lands first, so Part 3 builds the blob branch on the
final `scanBlob(matcher, …)` shape — no throwaway `binaryProbeMatcher` threading
through a new code path. Part 2 lands `peelToTreeOrBlob` with its own unit suite. No
`src/` code calls it until Part 3; the phase gate's `check:dead-code` (knip) runs only
after Part 3. Part 4 is docs-only: Part 3 already touches 6 files, and `grep.md`
describes both behaviour changes.

Why Parts 1 and 3 both declare grep.ts, its two suites and api.json: they are separate
behaviours with separate decisions (ADR-1174's binary verdict on every target, and
ADR-1171/1172/1175's blob target). Each has its own red rows and its own atomic commit.
Merged they would touch 7 files, over the 6-file ceiling, with ~3 RED→GREEN cycles. The
second part re-reads the shared files at the state the first left them.

No-op check: the commits after base `f307051d` are the design doc and ADRs 1171–1175
only. No requirement has landed, so every requirement is planned.

## Decision candidates

Choices the design and ADRs leave open. Each has a recommendation; none is decided here.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | Where the binary verdict lives (design: "if extracted … lens 2 fits") | **a** a private helper in `grep.ts` (`returnsAnyLine(matcher, bytes)`), example tests only · **b** a pure `src/domain/grep/` function, exported through the domain barrel, plus a `*.properties.test.ts` sibling · **c** inline in `scanBlob`, no helper | **a** | The verdict is `splitLines(window).some(l => matcher.matchLine(l).returned)`. A property's only oracle is that same expression, so the property would restate the code (lens 2 fails: no independent model). b adds a public domain export and an api.json entry for 3 lines. c pushes `scanBlob` to 2 concerns. |
| D2 | Name and arity of the walk extracted from `peel` (design text: `walkTowardTree`) | **a** generic `walkToward(ctx, table, id, target)`, used by `peel` (any target) and by `peelToTreeOrBlob` (`'tree'`) · **b** `walkTowardTree(ctx, table, id)` as written, with `peel` keeping its own walk | **a** | `peel`'s first three lines take a generic `target`. Only a, the generic extraction, is shared with `peel`, which is what ADR-1173 requires ("sharing `peel`'s walk"). b duplicates the walk. |
| D3 | Where Part 1's binary interop fixtures live | **a** four `.dat` files added to the shared `beforeAll` repo's initial commit, rows scoped by pathspec `'*.dat'` · **b** a second throwaway repo in a nested `describe` with its own `beforeAll`/`afterAll` | **a** | One fixture and one tmp dir. The existing #M1 `-l`/`-c` parity row derives both sides from the same tree, so it stays equal with 4 more paths (all binary; three contain `NEEDLE` and are counted 1 by both). b doubles setup cost for no isolation gain. |

## Requirement map

| Req (design) | Delivered by |
|---|---|
| R1 every blob rev grammar greps the blob | Part 2 (peel unit rows P1–P4); Part 3 unit U1–U2, interop I1 |
| R2 blob result carries no path; tree label unchanged | Part 3 U1, U3 (GUARD), interop I1–I4 (label rebuilt from the rev) |
| R3 no mode filter on a blob target | Part 3 U6 (symlink), interop I8 (symlink), I9 (executable) |
| R4 pathspec validated, never applied (ADR-1172) | Part 3 U7, U8 (GUARD), interop I6, I7 |
| R5 same `scanBlob` (binary, `-w`, `-v`, spans); Decision 4 folded (ADR-1174) | Part 1 (B1–B6, interop J1–J2); Part 3 U5, U9, U10, interop I3, I5 |
| R6 bare repository | Part 3 U11, interop I10 |
| R7 tree/commit/tag-of-tree targets and refusals unchanged | Part 2 P7 (GUARD); Part 3 U3, U12 (GUARDs) + existing suites |
| ADR-1171 `GrepResult.blob?`, `GrepPathResult extends GrepBlobResult` | Part 3 |
| ADR-1173 `peelToTreeOrBlob` + `resolveTreeOrBlob` replaces `resolveTreeish` | Parts 2, 3 |
| ADR-1175 keep `{ treeish }`, widen JSDoc | Part 3 (JSDoc), Part 4 (doc) |
| Doc surfaces (design §Doc surfaces) | Part 4 (`grep.md`); Parts 1, 3 (JSDoc + `reports/api.json`) |

## Part 1 — binary verdict is line-wise with the invert-aware matcher

### Context

**Files this part edits (4):**

- `src/application/commands/grep.ts`
- `test/unit/application/commands/grep.test.ts`
- `test/integration/grep-interop.test.ts`
- `reports/api.json` (regenerated with `npm run docs:json`, never hand-edited)

Read-only references: src/domain/diff/line-diff.ts (`splitLines(bytes): ReadonlyArray<Uint8Array>`
L70 keeps each LF and emits no trailing empty line; `MAX_LINE_BYTES = 65_536` L65;
`isBinary` L94 = NUL in the first 8 KiB), src/domain/grep/matcher.ts (`GrepMatcher.matchLine(line): LineVerdict`
`{ returned, spans }`, already invert-aware; a line is matched without its trailing LF).

**Defect (reproduced on `f307051d` in a memory repo):** tree target `HEAD`, pathspec `*.dat`.

```
fixture: all-match.dat="bin\0NEEDLE\n"  mixed.dat="bin\0NEEDLE\nother\n"
         nomatch.dat="bin\0x\n"          anchored.dat="bin\0x\nNEEDLE y\n"
invert, {fixed:'NEEDLE'} ⇒ ours [all-match, anchored, mixed]   git: [anchored?, mixed, nomatch]
/^NEEDLE/               ⇒ ours []                              git: [anchored.dat]
```

(`git grep -v` pinned in the design for mixed/nomatch/all-match; the anchored-under-`-v`
expectation follows from the line model, and the interop row takes it from real git.)

**Current code — `grep.ts`:**

- `scanBlob(matcher, binaryProbeMatcher, path, bytes): GrepPathResult | undefined`
  L141–171. Binary branch L147–158 probes `bytes.subarray(0, MAX_LINE_BYTES)` as ONE line
  with `binaryProbeMatcher`.
- `grep()` L173–214 builds `binaryProbeMatcher` at L191–195 (comment L191–192 claims
  presence is independent of `-v`; the probe refutes this). The call site is L209–211.
- JSDoc `GrepPathResult.binaryMatch` L33–38: "Blob is binary AND contained a match."

**Target shape (GREEN):**

```ts
/** git's binary verdict: some line of the bounded window is returned by the (invert-aware) matcher. */
const returnsAnyLine = (matcher: GrepMatcher, bytes: Uint8Array): boolean =>
  splitLines(bytes.subarray(0, MAX_LINE_BYTES)).some((line) => matcher.matchLine(line).returned);

function scanBlob(matcher: GrepMatcher, path: FilePath, bytes: Uint8Array): GrepPathResult | undefined {
  if (isBinary(bytes)) {
    // why-comment: the 64 KiB window bounds a caller RegExp over an unbounded binary blob
    return returnsAnyLine(matcher, bytes) ? { path, hits: [], binaryMatch: true } : undefined;
  }
  … text branch unchanged …
}
```

Delete `binaryProbeMatcher` (L191–195 plus the param). The call becomes
`scanBlob(matcher, c.path, await c.load())`. Rewrite the `binaryMatch` JSDoc to: "Blob is
binary AND some line of its first 64 KiB is returned by the matcher (`invert`-aware).
`hits` stays empty …". Keep the comment's "why" (window bound); drop the refuted
presence claim.

**Unit test file:** test/unit/application/commands/grep.test.ts uses `seedRepo()`, `enc`,
`ctx.fs.write(`${ctx.layout.workDir}/x.dat`, bytes)` + `add(ctx, [path])` + `commitAll(ctx)`.
Existing binary blocks: L399 (#B1), L421, **L438–458 (the row that pins the wrong
verdict; rewrite it)**, L460–477 (64 KiB bound), L830–893 (binary × `wholeWord`). New
blocks go right after L458. The convention for new code is a GWT describe/it split, AAA
comments and `const sut = grep;`. The existing file mostly omits `sut`, so do not
retrofit old blocks.

**Interop file:** test/integration/grep-interop.test.ts, a shared `beforeAll` repo (L94–176).
Write the four `.dat` files next to `b.bin` (after L119, before the first `git add -A` at
L142) with `Buffer.from('bin\0NEEDLE\n')` etc. Add the rows as a new `describe` before
the file's closing `});` (L398). `git(dir, …args)` returns stdout. Strip `HEAD:` as
`assertTargetParity` does (L64–89). With these fixtures the existing #M1 row (L332–349)
stays green (D3).

**Public surface:** no new exported symbol. The only surface effect is the reworded
`GrepPathResult.binaryMatch` JSDoc, embedded in `reports/api.json` (currently at
L106276: `"Blob is binary AND contained a match. "`). `check:doc-typedoc` is a
**prepush** gate, not part of `validate`, so run `npm run docs:json` after the JSDoc
edit and commit `reports/api.json` in this part. A large typedoc id-renumbering diff is
normal.

**Property tests:** none (D1 recommendation a). Lens 1 fails: there is no
parse/serialize pair. Lens 2 fails: the only oracle restates `some(matchLine)`. Lenses 3
and 4 fail: no grammar compiler, no re-parse. `buildGrepMatcher` already has
test/unit/domain/grep/matcher.properties.test.ts.

### TDD steps

1. **RED B1 (rewrite L438–458):** `Given a binary blob whose only line contains the pattern` /
   `When grep runs with invert` / `Then the blob is not reported`. Blob is
   `[0x00, ...enc('FIND_ME'), 0x00]` (one line). Assert `result.paths` toEqual `[]`.
   Fails because the non-inverted probe reports presence, giving `paths` length 1 with
   `binaryMatch: true`.
2. **RED B2:** `Given a binary blob with no line containing the pattern (bin\0x\n)` / invert
   ⇒ `paths` toEqual `[{ path: 'nomatch.dat', hits: [], binaryMatch: true }]`. Fails because
   the probe finds no `NEEDLE`, so it returns `[]`.
3. **RED B3:** `Given a binary blob whose second line starts with the pattern (bin\0x\nNEEDLE y\n)` /
   pattern `/^NEEDLE/` without invert ⇒ reported `binaryMatch: true`. Fails because
   the whole window is probed as one line and `^` anchors at byte 0, so it returns `[]`.
4. **GUARD B4:** `bin\0NEEDLE\nother\n` with invert ⇒ reported. It passes today, because
   the pattern is present. After GREEN the `other` line carries it.
5. **GUARD B5:** `bin\0NEEDLE\nother\n` without invert ⇒ reported. It passes today
   (presence). After GREEN it kills a `.some` → `.every` mutant (line 2 does not match).
6. **GUARD B6:** existing L460–477 (match only beyond 64 KiB ⇒ not reported). It passes
   today, and after GREEN it kills removal of `subarray(0, MAX_LINE_BYTES)`. Existing
   L399, L421 and L830–893 stay green: those blobs are single-line, so the verdict is
   unchanged.
7. **RED J1 (interop):** `Given binary blobs under *.dat` / `When grepping HEAD with invert` /
   `Then tsgit's binaryMatch paths equal git grep -v -l -F NEEDLE HEAD -- '*.dat'`. Run tsgit
   with `{ patterns:[{fixed:LIT}], invert:true, target:{treeish:'HEAD'}, paths:['*.dat'] }`.
   Assert the name sets equal and every entry has `binaryMatch: true` and `hits: []`.
   Fails because tsgit returns all-match.dat and omits nomatch.dat.
8. **RED J2 (interop):** `git grep -l -E '^NEEDLE' HEAD -- '*.dat'` vs tsgit `/^NEEDLE/`. Both
   sides should give `{ anchored.dat }`. Fails because tsgit returns `[]`. `^NEEDLE` means
   the same in ERE and JS, so this pins line splitting, not grammar. Say so in a one-line
   comment, because the file header disclaims grammar pinning.
9. **GREEN:** the target shape above. Remove `binaryProbeMatcher` and rewrite the JSDoc.
10. **REFACTOR:** `grep()` loses 5 lines. Check that `scanBlob` and `grep` stay ≤20 lines of
    logic with no dead comment. Run `npm run docs:json` and stage `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/commands/grep.test.ts test/integration/grep-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/grep.ts test/unit/application/commands/grep.test.ts test/integration/grep-interop.test.ts && npm run check:spelling
```

### Commit

`fix(grep): decide a binary blob's match line by line with the invert-aware matcher`

## Part 2 — `peelToTreeOrBlob` over `peel`'s shared walk

### Context

**Files this part edits (2):**

- `src/application/primitives/internal/peel.ts`
- `test/unit/application/primitives/internal/peel.test.ts`

Read-only references: src/application/primitives/internal/peel-chain.ts (`walkPeelChain<T>(start: PeelOutcome<T>, read, nextHop, maxHops?) → PeelWalk<T>`
`{ end: 'reached'|'revisited'|'too-deep', id, result, crossed }`),
src/application/primitives/internal/object-type-table.ts L154 (`PeelHopObject = GitObject | { type: 'tree' | 'blob' }`),
test/unit/application/primitives/fixtures.ts (`writeForgedTagLoop(ctx)` L345, `writeRawObjectBytes(ctx, type, bytes)`).

**Current `peel`** (peel.ts L28–44):

```ts
export const peel = async (ctx, table: ObjectTypeTable | undefined, id: ObjectId, target: PeelTarget, name?: string): Promise<ObjectId> => {
  const read = (oid: ObjectId) => readHop(ctx, table, oid);
  const nextHop = (obj: PeelHopObject | undefined) => hopToward(obj, target);
  const walk = await walkPeelChain({ id, result: await read(id) }, read, nextHop);
  if (walk.end !== 'reached') throw objectNotFound(id);
  const reached = walk.result; …
```

`hopToward(obj, 'tree')` L74–79 already stops on a blob (it returns `undefined`). Only
the final type check refuses it.

**Target shape (GREEN; D2 recommendation a):**

```ts
export type SearchableKind = 'tree' | 'blob';
export interface SearchableObject { readonly kind: SearchableKind; readonly id: ObjectId }

/** `peel`'s walk toward `target`, refusing OBJECT_NOT_FOUND on the start id unless it ends `reached`. */
const walkToward = async (ctx, table, id, target: PeelTarget): Promise<PeelOutcome<PeelHopObject | undefined>> => {
  const read = (oid: ObjectId) => readHop(ctx, table, oid);
  const nextHop = (obj: PeelHopObject | undefined) => hopToward(obj, target);
  const walk = await walkPeelChain({ id, result: await read(id) }, read, nextHop);
  if (walk.end !== 'reached') throw objectNotFound(id);
  return walk;
};

/** git grep's object dispatch (`deref_tag`, a commit read as its tree): tags followed to any depth, a tree or blob kept. */
export const peelToTreeOrBlob = async (ctx: Context, table: ObjectTypeTable | undefined, id: ObjectId): Promise<SearchableObject> => {
  const walk = await walkToward(ctx, table, id, 'tree');
  const kind = walk.result?.type;
  if (kind === 'tree' || kind === 'blob') return { kind, id: walk.id };
  throw objectNotFound(walk.id);
};
```

`peel` becomes `const walk = await walkToward(ctx, table, id, target);` followed by its
existing L39–43 unchanged. Import `PeelOutcome` as a type from `./peel-chain.js`.
`peel`'s signature and behaviour do not change.

**Public surface:** `peelToTreeOrBlob`, `SearchableObject` and `SearchableKind` are
**internal**. They live under `primitives/internal/`, are not barrelled, and only
`resolve-rev.ts` (Part 3) consumes them. No surface gate trips, and api.json is
unaffected (`internal/` is not a typedoc entry point).

**Pinned behaviour (probed on `f307051d`):** `peel(ctx, undefined, <tag→missing 1111…>, 'tree')`
throws `{ code: 'OBJECT_NOT_FOUND', id: '1111…1111' }`. The reader raises it for the
missing object, not for the tag.

**Property tests:** N/A. Lens 1 fails: no parse/serialize pair. Lens 2 fails: dispatch
over a two-valued kind, swept by examples. Lenses 3 and 4 fail: no grammar, no re-parse.

**Test shape:** add a sibling top-level `describe('peelToTreeOrBlob', …)` after the
`peel` block, reusing `logging()` and `caught()` (L23–46), with `const sut = peelToTreeOrBlob`
and `table` = `undefined` (as the Part 3 resolver passes it). Build objects with
`writeObject(ctx, { type: 'blob'|'tag'|'tree'|'commit', id: '' as ObjectId, … })`. The
tag `data` shape is `{ object, objectType, tagName, message, extraHeaders: [] }` (see
L132–135).

### TDD steps

1. **RED P1–P6** (each fails because `peelToTreeOrBlob` is not exported: the import
   binding is `undefined`, so `sut(…)` throws `TypeError: sut is not a function`):
   - P1 `Given a blob id` ⇒ `toEqual({ kind: 'blob', id: blob })`.
   - P2 `Given an annotated tag naming an annotated tag naming a blob` ⇒ `{ kind: 'blob', id: blob }`.
   - P3 `Given a commit`: `writeObject` an empty-or-one-blob tree, then
     `createCommit(ctx, { tree, parents: [], author, committer, message })` from
     src/application/primitives/create-commit.ts (see the usage in
     test/unit/application/commands/blame.test.ts L17, L239) ⇒
     `{ kind: 'tree', id: <its root tree> }`.
   - P4 `Given a tree id` ⇒ `{ kind: 'tree', id: tree }`.
   - P5 `Given a tag whose object line is non-hex` (`writeRawObjectBytes(ctx,'tag', …)`
     as in L166–181) ⇒ `caught(...)` toEqual `{ code: 'OBJECT_NOT_FOUND', id: tag }`.
     This kills both `kind === …` → `true` mutants, because the reached result is
     `undefined`.
   - P6 `Given a forged tag naming itself` (`writeForgedTagLoop`) ⇒ `{ code: 'OBJECT_NOT_FOUND', id: loop }`
     (a non-`reached` end).
   - P6b `Given a tag naming a missing object` ⇒ `{ code: 'OBJECT_NOT_FOUND', id: '1'.repeat(40) }`.
2. **GUARD P7:** `peel(ctx, undefined, blob, 'tree')` ⇒ `{ code: 'OBJECT_NOT_FOUND', id: blob }`.
   It passes today. It proves the extraction leaves `peel` refusing a blob for `'tree'`.
   Every existing `peel` row (L49–224) is a GUARD too.
3. **GREEN:** extract `walkToward`, rewire `peel`, add `peelToTreeOrBlob` and its types.
4. **REFACTOR:** each function ≤20 lines. The JSDoc says why (git's `deref_tag` +
   commit→tree). Update the `peel` JSDoc sentence "Shared by the rev grammar … and the
   read-command resolver" only if it becomes inaccurate.

### Gate

```
npx vitest run test/unit/application/primitives/internal/peel.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/peel.ts test/unit/application/primitives/internal/peel.test.ts && npm run check:spelling
```

### Commit

`refactor(peel): add peelToTreeOrBlob over peel's shared walk`

## Part 3 — grep a blob when the `{ treeish }` target resolves to one

### Context

**Files this part edits (6):**

- `src/application/commands/internal/resolve-rev.ts`
- `src/application/commands/grep.ts`
- `src/application/commands/index.ts`
- `test/unit/application/commands/grep.test.ts`
- `test/integration/grep-interop.test.ts`
- `reports/api.json` (regenerated with `npm run docs:json`)

Read-only references: src/application/primitives/internal/peel.ts (`peelToTreeOrBlob`,
`SearchableObject` from Part 2), src/application/commands/tag.ts (`tagCreate(ctx, { name, target })`
creates a lightweight ref to any oid, including a tag object's), src/domain/objects/tree.ts
(`treeEntry(mode, name, id)` L43; also exported from src/domain/objects/index.ts),
src/domain/objects/file-mode.ts (`FILE_MODE.SYMLINK = '120000'`, `FILE_MODE.GITLINK = '160000'`),
test/unit/application/commands/fixtures.ts (`asBareContext(ctx)` L256),
test/integration/interop-helpers.ts (`runGit(args, { input?, env? })` L177,
`git(dir, …args)` L352, `tryRunGitWithExit(args, opts) → { stdout, stderr, exitCode }`
L430).

**resolve-rev.ts:** replace `resolveTreeish` (L20–22; its only caller is grep.ts L19/L124) with:

```ts
/** Resolve `rev` to what `grep` searches: its tree (commit → tree, tags followed) or a blob. */
export const resolveTreeOrBlob = async (ctx: Context, rev: string): Promise<SearchableObject> =>
  peelToTreeOrBlob(ctx, undefined, await resolveRevision(ctx, rev));
```

Header comment L1–8: "porcelain reads (`log`, `diff`)" becomes "(`log`, `diff`, `grep`)".
Also import `peelToTreeOrBlob` and `type SearchableObject`.

**grep.ts public types (ADR-1171, ADR-1175):**

```ts
export interface GrepBlobResult {
  readonly hits: ReadonlyArray<GrepLineHit>;
  /** (the Part 1 binaryMatch JSDoc moves here) */
  readonly binaryMatch: boolean;
}
export interface GrepPathResult extends GrepBlobResult { readonly path: FilePath }
export interface GrepResult {
  /** Tree-ish, index and working-tree targets: only paths with ≥1 hit or binaryMatch:true. Always empty for a blob target. */
  readonly paths: ReadonlyArray<GrepPathResult>;
  /** Blob target only: the blob's match; absent when it did not match (git exit 1). */
  readonly blob?: GrepBlobResult;
}
```

`GrepOptions.target` JSDoc (L53–56): "`{ treeish }` ⇒ a committed tree, or a blob when
the rev resolves to one". The key is unchanged.

**grep.ts control flow (GREEN sketch; every function ≤20 lines):**

```ts
const enumerateTree = async (ctx, treeId: ObjectId): Promise<ReadonlyArray<Candidate>> => { /* L125–138 moved verbatim, incl. its Stryker comment, which carries the hook-required 'equivalent' rationale */ };

async function enumerateCandidates(ctx, target: 'index' | undefined) { /* L112–121 only */ }

const grepBlob = async (ctx, matcher, id: ObjectId): Promise<GrepResult> => {
  const blob = scanBlob(matcher, (await readBlob(ctx, id)).content);
  return blob === undefined ? { paths: [] } : { paths: [], blob };   // exactOptionalPropertyTypes: omit, never `blob: undefined`
};

// in grep(), AFTER the pathspec is resolved (order unchanged ⇒ `../outside` still refuses first):
if (target !== undefined && target !== 'index') {
  const root = await resolveTreeOrBlob(ctx, target.treeish);
  if (root.kind === 'blob') return grepBlob(ctx, matcher, root.id);   // pathspec never applied
  return grepCandidates(ctx, matcher, pathspecMatcher, await enumerateTree(ctx, root.id));
}
return grepCandidates(ctx, matcher, pathspecMatcher, await enumerateCandidates(ctx, target));
```

- `scanBlob(matcher, bytes): GrepBlobResult | undefined` drops `path`. The candidate
  path wraps it: `const m = scanBlob(matcher, await c.load()); return m === undefined ? undefined : { path: c.path, ...m };`.
- `grepCandidates(ctx, matcher, pathspecMatcher, candidates): Promise<GrepResult>` holds
  today's L204–213 (pathspec filter, `boundedMapFor(ctx, 'ioBound', …)`, `undefined`
  filter).
- Extract `buildMatcher(opts)` (L186–189) if `grep()` would exceed 20 lines of logic.
  The opening why-comment (L174–179) stays.
- `isSearchableMode` is not consulted for a blob (requirement 3). `requireWorkTree` is
  not reached on the blob path (requirement 6).

**Public surface: `GrepBlobResult` is PUBLIC** (a field type of the public `GrepResult`).
Surface gates to pre-pay in this part:
1. Barrel: add `type GrepBlobResult,` to the grep export block of `src/application/commands/index.ts`
   (L150–156), alphabetically before `type GrepLineHit`. src/public-types.ts L7
   (`export type * from './application/commands/index.js'`) then carries it to every
   entry, so no edit is needed there.
2. `reports/api.json`: new interface + `GrepResult.blob` + reworded JSDoc. Run
   `npm run docs:json` and commit. This is the prepush `check:doc-typedoc` gate, not
   `validate`.
3. No facade change: `repo.grep` already binds `grep` in src/repository.ts. No new error
   code (no exhaustiveness switch). No doc-coverage or browser-surface change (not a new
   command). README command count unchanged.
4. `docs/use/commands/grep.md` signature block: Part 4 (docs-only).

`resolveTreeOrBlob` is **internal** (`commands/internal/`, not barrelled).

**Pinned probe results (`f307051d`, memory repo, `f1 = "a NEEDLE\nb\nNEEDLE c\n"`, blob
`296dd9f3…`):** every grammar shape (full oid, 7-char abbrev, `HEAD:f1`, `HEAD:./f1`,
`:f1`, `:0:f1`, `blob-tag`, `tag-of-tag`, `light`, `<oid>^{blob}`, `blob-tag^{}`) throws
`OBJECT_NOT_FOUND{id:296dd9f3…}` today. Already correct (GUARDs): `HEAD:sub` ⇒
`[["f2",[1],false]]`; `HEAD:nope` ⇒ `{code:'PATH_NOT_IN_TREE', rev:'HEAD', path:'nope'}`;
`'0'.repeat(40)` ⇒ `{code:'OBJECT_NOT_FOUND', id:'000…0'}`; `<tree>:gl` (gitlink to
`1111…`) ⇒ `{code:'OBJECT_NOT_FOUND', id:'111…1'}`; `HEAD:f1` + `paths:['../outside']`
⇒ `{code:'PATHSPEC_OUTSIDE_REPO', path:'../outside'}`. `<tree>:link` (a symlink blob
`NEEDLE-target`) throws today.

**Unit fixture** (new helper in grep.test.ts, placed above a new
`describe('Given a blob target')` block appended at the end of the file, after L1240):
`seedBlobTargets()` commits `f1`, `sub/f2 = "NEEDLE sub\n"`, `word = "xNEEDLEx\n"` and
`bin.dat = enc('bin\0NEEDLE\n')` (written via `ctx.fs.write`) through `writeAndStage`
and `commitAll`. Then `oid = await resolveRevision(ctx, 'HEAD:f1')`
(src/application/commands/rev-parse.ts). It writes annotated tags with `writeObject`
(`{ type:'tag', id:'' as ObjectId, data:{ object, objectType, tagName, tagger: AUTHOR, message:'m\n', extraHeaders:[] } }`)
and refs them with `tagCreate(ctx, { name, target: tagOid })`: `blob-tag` → blob,
`tag-of-tag` → blob-tag's object, `tree-tag` → the HEAD root tree, and `light`
(`tagCreate(ctx, { name:'light', target: oid })`). It returns `{ ctx, oid }`. Symlink and
gitlink rows build a tree with
`writeObject(ctx, { type:'tree', id:'' as ObjectId, entries:[treeEntry(FILE_MODE.SYMLINK,'link',<blob 'NEEDLE-target'>), treeEntry(FILE_MODE.GITLINK,'gl','1'.repeat(40))] } as Tree)`
and target `${tree}:link` / `${tree}:gl`. Project hits as
`hits.map(h => [h.lineNumber, dec(h.line), h.spans])` for readable equality. `MatchSpan`
is `{ start, end }`. For `f1` the expected hits are
`[[1,'a NEEDLE\n',[{start:2,end:8}]],[3,'NEEDLE c\n',[{start:0,end:6}]]]`. Assert absence
with `toStrictEqual({ paths: [] })`: `toEqual` treats `blob: undefined` as absent and
would let a mutant through.

**Interop fixture** (append to `beforeAll` before `ctx = createNodeContext(…)` L175, after
the staged_only/untracked writes; tags do not move HEAD, so existing rows are untouched):

```ts
blobOid = git(dir, 'rev-parse', 'HEAD:c.txt').trim();             // c.txt = 'has NEEDLE in c\n'
runGit(['-C', dir, 'tag', '-a', '-m', 'm', 'blob-tag', blobOid], { env: datedEnv(clock) });
runGit(['-C', dir, '-c', 'advice.nestedTag=false', 'tag', '-a', '-m', 'm', 'tag-of-tag', 'blob-tag'], { env: datedEnv(clock) });
git(dir, 'tag', 'light', blobOid);
const hashLoose = (s: string) => runGit(['-C', dir, 'hash-object', '-w', '--stdin'], { input: s }).trim();
looseOid = hashLoose('loose NEEDLE\n'); wordOid = hashLoose('xNEEDLEx\n'); emptyOid = hashLoose('');
const exeOid = hashLoose('run NEEDLE\n');
exeTree = runGit(['-C', dir, 'mktree'], { input: `100755 blob ${exeOid}\trun.sh\n` }).trim();
bare = `${dir}-bare.git`; runGit(['clone', '-q', '--bare', dir, bare]);   // rm in afterAll
```

`it.each` tables are evaluated before `beforeAll`, so rows carry **rev builders**
(`{ label, rev: () => string }`), as the design's test strategy says. Rebuild git's lines
from structured data (ADR-249; the library renders nothing):

```ts
const text = (line: Uint8Array): string => new TextDecoder().decode(line).replace(/\n$/, '');
const blobLines = (rev: string, r: GrepResult): string[] =>
  (r.blob?.hits ?? []).map((h) => `${rev}:${h.lineNumber}:${text(h.line)}`);
const lines = (out: string): string[] => out.split('\n').filter(Boolean);
```

`assertTargetParity`'s `HEAD:` strip stays tree-only.

**Property tests:** N/A. Lens 1: no parse/serialize. Lens 2: dispatch over a two-valued
kind is covered by an `it.each` sweep. Lenses 3 and 4: no grammar compiler, no re-parse.

**Mutation scope (validation phase):** grep.ts → grep.test.ts; resolve-rev.ts has no
eponymous suite, so walk to grep.test.ts; peel.ts → peel.test.ts.

### TDD steps

1. **RED U1:** `Given a blob target` / `When the target is the blob's full oid` / `Then paths is empty and blob carries lines 1 and 3`.
   `toStrictEqual` on `{ paths: [], blob: { hits: <projected>, binaryMatch: false } }`
   (project `blob.hits` before comparing). Fails: throws `OBJECT_NOT_FOUND{id:<oid>}`
   (`peel(…,'tree')` refuses the blob).
2. **RED U2 (`it.each`, rev builders):** `HEAD:f1`, `HEAD:./f1`, `:f1`, `:0:f1`,
   `oid.slice(0,7)`, `${oid}^{blob}`, `blob-tag`, `tag-of-tag`, `light`, `blob-tag^{}`
   ⇒ the same projected `blob`. Each fails with the same throw.
3. **RED U4:** `HEAD:f1` with pattern `ZZZ` ⇒ `toStrictEqual({ paths: [] })`. Fails: throws.
4. **RED U5:** `HEAD:bin.dat` ⇒ `blob` toEqual `{ hits: [], binaryMatch: true }`. Fails: throws.
5. **RED U6:** `${tree}:link` (symlink blob) ⇒ `blob.hits` projected `[[1,'NEEDLE-target',[{start:0,end:6}]]]`.
   Fails: throws. Kills a mode filter applied to the blob.
6. **RED U7:** `HEAD:f1` with `paths: ['nomatch']` ⇒ `blob` defined (lines 1, 3). Fails: throws.
7. **RED U9:** `HEAD:f1` with `invert: true` ⇒ projected `[[2,'b\n',[]]]`. Fails: throws.
8. **RED U10:** `HEAD:word` with `wholeWord: true` ⇒ `toStrictEqual({ paths: [] })`. Fails: throws.
   Without `wholeWord` ⇒ `blob` with line 1. Same RED reason.
9. **RED U11:** `asBareContext(ctx)` with target `HEAD:f1` ⇒ `blob` defined. Fails: throws
   `OBJECT_NOT_FOUND`, not `WORK_TREE_REQUIRED`.
10. **GUARD U3:** `HEAD:sub` ⇒ `paths` `[{ path:'f2', … }]` and `'blob' in result` is
    `false`. Passes today (tree target). After GREEN it kills the `root.kind === 'blob'`
    → `true` mutant (readBlob of a tree id throws). Also `tree-tag` ⇒ paths `f1`,
    `sub/f2`, `word`, `bin.dat` (GUARD, tag-of-tree).
11. **GUARD U8:** `HEAD:f1` with `paths: ['../outside']` ⇒ try/catch `.data` toEqual
    `{ code:'PATHSPEC_OUTSIDE_REPO', path:'../outside' }`. Passes today (the pathspec
    resolves before the rev). Pins that the blob branch keeps that order.
12. **GUARD U12 (`it.each`):** `HEAD:nope` ⇒ `{code:'PATH_NOT_IN_TREE', rev:'HEAD', path:'nope'}`;
    `'0'.repeat(40)` ⇒ `{code:'OBJECT_NOT_FOUND', id:'0'.repeat(40)}`; `${tree}:gl` ⇒
    `{code:'OBJECT_NOT_FOUND', id:'1'.repeat(40)}`. These pass today.
13. **RED interop I1 (`it.each`, rev builders):** `blobOid`, `blobOid.slice(0,7)`,
    `HEAD:c.txt`, `HEAD:./c.txt`, `HEAD:a.txt`, `:c.txt`, `:0:c.txt`, `blob-tag`,
    `tag-of-tag`, `light`, `${blobOid}^{blob}`, `blob-tag^{}`, `looseOid` ⇒
    `blobLines(rev, result)` toEqual `lines(git(dir,'grep','-n','-F',LIT,rev))`, and
    `result.paths` toEqual `[]`. Fails: tsgit throws.
14. **RED I2:** `HEAD:b.bin` ⇒ `` `Binary file ${rev} matches` `` (built only when
    `result.blob?.binaryMatch`) equals git's trimmed stdout.
15. **RED I3:** `blob-tag` with `-l` ⇒ `result.blob ? [rev] : []` vs `lines(git … -l …)`.
    With `-c` ⇒ `` `${rev}:${blob.binaryMatch ? 1 : blob.hits.length}` `` vs git.
16. **RED I4:** `HEAD:a.txt` with `-v` (invert) ⇒ 12 rebuilt lines equal git's `-n -v` output.
17. **RED I5:** no-match rows (`HEAD:b.txt`, `emptyOid`, `wordOid` with `-w`/`wholeWord`)
    ⇒ `tryRunGitWithExit(['-C',dir,'grep','-n','-F',…])` has `exitCode` 1 and `result`
    toStrictEqual `{ paths: [] }`. `wordOid` without `-w` matches line 1 on both sides.
18. **RED I6:** `HEAD:c.txt -- nomatch` ⇒ git still prints the line; tsgit with
    `paths:['nomatch']` rebuilds the same line.
19. **GUARD I7:** `HEAD:c.txt -- ../outside` ⇒ git `exitCode` 128; tsgit `.data.code`
    `PATHSPEC_OUTSIDE_REPO`. Passes today.
20. **RED I8:** `HEAD:tracked_symlink.txt` with `{ fixed: 'symlink_target' }` vs
    `git grep -n -F symlink_target HEAD:tracked_symlink.txt`. Its blob is the absolute
    target path, with no LF.
21. **RED I9:** `${exeTree}:run.sh` (100755) ⇒ rebuilt `…:1:run NEEDLE` equals git.
22. **RED I10:** the bare clone, `createNodeContext({ workDir: bare, gitDir: bare, bare: true })`,
    rows `HEAD:c.txt` and `blob-tag` ⇒ equal to `git -C <bare> grep -n -F NEEDLE <rev>`.
23. **GREEN:** `resolveTreeOrBlob` replaces `resolveTreeish`. Add the public types and
    JSDoc, the barrel entry, path-free `scanBlob`, `enumerateTree`, `grepBlob` and
    `grepCandidates` as sketched.
24. **REFACTOR:** each function ≤20 lines of logic, no nesting >2, no `resolveTreeish`
    left (`grep -rn resolveTreeish src` ⇒ nothing; test/integration/archive-interop.test.ts
    has an unrelated local field of that name). Run `npm run docs:json` and stage
    `reports/api.json`.

### Gate

```
npx vitest run test/unit/application/commands/grep.test.ts test/unit/application/primitives/internal/peel.test.ts test/integration/grep-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/grep.ts src/application/commands/internal/resolve-rev.ts src/application/commands/index.ts test/unit/application/commands/grep.test.ts test/integration/grep-interop.test.ts && npm run check:spelling
```

### Commit

`fix(grep): grep a blob when the treeish target resolves to one`

## Part 4 — document blob targets and the line-wise binary verdict

### Context

**Files this part edits (1):**

- `docs/use/commands/grep.md`

Docs-only, no `src/` delta. Source of truth: the code as Parts 1–3 left it
(src/application/commands/grep.ts) and design §Doc surfaces. Edits by line (current
file):

- L3–8 intro: the result is per matching path, **or, for a blob target, the blob's
  match**.
- L37–44 Signature: add `GrepBlobResult { hits; binaryMatch }`, `GrepPathResult extends
  GrepBlobResult { path }`, and `GrepResult.blob?: GrepBlobResult` with the comments from
  the JSDoc.
- L54 Options `target` row: "`{ treeish }` ⇒ a commit, tree, or blob (full rev grammar)".
  The key is still `treeish` (ADR-1175).
- L59–62 Targets bullet: add a blob-target bullet. A rev resolving to a blob (`oid`,
  `rev:path`, `:path`, `:0:path`, `<oid>^{blob}`, a tag, nested or lightweight, of a blob,
  `tag^{}`) greps that blob. It returns `paths: []` and `blob`, with `blob` absent on no
  match. The pathspec is validated (its refusals hold) but never applied. Any blob mode
  is grepped, symlink target string included. It works in a bare repository (extend the
  L63–66 work-tree bullet).
- L67–69 Searchable content: the mode filter applies to tree, index and working-tree
  targets, not to a blob target.
- L70–73 Binary blobs: a binary blob is reported when some line of its first 64 KiB is
  returned by the matcher. Under `invert`, that means a non-matching line, so a binary
  blob whose every line matches is not reported, and an anchored pattern sees each line.
- L79–84 Caller projections: the label is `rev` for a blob target and `${rev}:${path}`
  for a tree target. Add the blob forms of `-l`, `-c` and `Binary file … matches` (the
  design's projection block).
- L106–110 Divergences: keep the 64 KiB window and add the residual from ADR-1174. Under
  `invert`, a window boundary cutting through a matching line can return the cut fragment.
- L152–161 Examples: add a blob-target example (`target: { treeish: 'HEAD:package.json' }`
  reading `result.blob`).
- L175–176 Throws: `OBJECT_NOT_FOUND` covers a missing object, including a gitlink path
  (`HEAD:<submodule>`); `PATH_NOT_IN_TREE` covers a `rev:path` naming no entry;
  `REVPARSE_UNRESOLVED` covers an unresolvable rev. Drop the implication that a blob rev
  is unresolvable.
- L187 See also, ADRs: add 1171 (blob field), 1172 (pathspec), 1173 (peel), 1174 (binary
  verdict), 1175 (`treeish` key). Docs may cite ADRs; source and test never do.

`check:spelling` runs over `docs/**/*.md`. Fixture-free prose; reuse only the dictionary
spellings already in the design. `check:doc-links` (lychee) runs in `validate`, so only
use relative links that exist.

### TDD steps

1. **GUARD D1:** test/unit/application/commands/grep.test.ts and
   test/integration/grep-interop.test.ts stay green. Docs change no behaviour.
2. **GREEN (prose):** apply the edits above, then reread every code block against the
   exported types in src/application/commands/grep.ts. Field names and optionality must
   match exactly.
3. **REFACTOR:** remove any sentence the new behaviour falsifies (the "presence is
   independent of `-v`" idea, "`{ treeish }` reads a committed tree" without the blob
   case).

### Gate

```
npx vitest run test/unit/application/commands/grep.test.ts && npm run check:types && npm run check:spelling
```

### Commit

`docs(grep): document blob targets and the line-wise binary verdict`

## Phase gate and known traps

- Phase gate: `npm run validate`. It includes `check:dead-code` (knip; by then
  `peelToTreeOrBlob` has a caller), `check:size`, `test:coverage` (100%) and
  `test:integration`. A red local `check:size` can be stale dist chunks: rebuild clean
  before reading the row. Size headroom is <100 B on some entries. Part 1 deletes the
  probe matcher; Part 3 adds a small branch.
- `reports/api.json` is checked only at prepush (`check:doc-typedoc`). Parts 1 and 3
  regenerate it. A part that edits public JSDoc without regenerating it leaves a red
  push.
- `exactOptionalPropertyTypes` is on: never write `blob: undefined`. Omit the key.
- Implementers have no MCP tools. The line numbers above are as of `0c65e957`. Part 1
  shifts grep.ts lines for Part 3, so re-locate symbols by name (`scanBlob`,
  `enumerateCandidates`, `grep`).
- State-mutating probes go in a `mktemp -d` throwaway with scrubbed `GIT_*`, never the
  worktree.
