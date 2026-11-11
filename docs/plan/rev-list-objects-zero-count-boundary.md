# Plan — `rev-list --objects -n 0` boundary objects

> Source: design doc `docs/design/rev-list-objects-zero-count-boundary.md` · ADRs none
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

One part: a one-operand guard change, its unit and interop rows, and the three doc
comments it falsifies. The interop fault rows fail and pass on the same operand as the
range rows, so they do not earn a separate commit.

## Decision candidates

None. The design pins the guard (`marks.commitTips`, not `request.not`), the walk under
non-`objects` (fault rows), and every doc wording; no load-bearing choice is left open.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|

## Requirement map

| Req | Delivered by |
|---|---|
| R1 (commit `not` tip ⇒ `maxCount: 0` walks and marks edges, lists no commit) | Part 1: unit row U1, interop rows I1–I6 |
| R2 (no commit `not` tip ⇒ nothing walked, missing ancestor never read) | Part 1: unit GUARDs U2, U3; interop GUARDs I7, I8, F3, F4 |
| R3 (missing in-range commit ⇒ `REVISION_WALK_FAILED`, with and without `objects`) | Part 1: unit row U4; interop rows F1, F2 |
| R4 (every currently-OK row stays OK) | Part 1: GUARDs + existing suites in the gate |

## Part 1 — walk the range under `maxCount: 0` when a commit is excluded

### Context

**Files this part edits (6):**

- `src/application/primitives/internal/closure-engine.ts`
- `src/application/commands/rev-list.ts`
- `docs/use/commands/rev-list.md`
- `reports/api.json` (regenerated, never hand-edited)
- `test/unit/application/primitives/internal/closure-engine.test.ts`
- `test/integration/rev-list-objects-interop.test.ts`

Read-only references (do not edit): src/application/primitives/internal/limit-list.ts
(`limitOrFailSetup` L534-546 rethrows any walk failure as `revisionWalkFailed()` with no
`commit`, so the setup refusal's data is exactly `{ code: 'REVISION_WALK_FAILED' }`),
src/application/primitives/internal/closure-not-marks.ts (`markNotTip` fills
`marks.commitTips` after tag peeling), test/integration/interop-helpers.ts
(`tryRunGitWithExit(args, { input?, env? }) => { stdout, stderr, exitCode }`).

**Public surface: no new exported symbol.** No type, function, error code or barrel entry
is added; no surface gate trips (barrels, facade, exhaustiveness, doc-coverage, browser
surface). The only surface effect is the reworded `RevListOptions.maxCount` JSDoc, which
typedoc embeds in `reports/api.json` (current text at api.json L128008:
`", those commits and\neverything they reach). Bounds the commit walk only. "`). Per
.claude/workflow/surface-gates.md "api.json is a prepush gate", `check:doc-typedoc` is
not part of `validate`, so a stale api.json passes the phase gate and fails at push.
**Run `npm run docs:json` in this part, after the JSDoc edit, and commit
`reports/api.json` with it.** Expect a diff confined to the `maxCount` comment text
nodes; a large id-renumbering diff is normal typedoc behaviour, not a fault.
`ClosureRequest` (closure-engine.ts) is internal: typedoc does not see it
(`grep -c "walks no commits at all" reports/api.json` ⇒ `0`).

**The code change — `listCommitSeeds`** (closure-engine.ts L562-575):

```ts
/** Dispatch the commit-seed side of the closure: no seeds, `maxCount: 0`, `noWalk`, or the full walk. */
async function listCommitSeeds(
  ctx: Context,
  resolved: ResolvedWants,
  marks: NotMarks,
  request: ClosureRequest,
): Promise<ReadonlyArray<WalkedCommit>> {
  const { commitSeeds } = resolved;
  if (commitSeeds.length === 0 || request.maxCount === 0) return [];   // L570 — the target
  // git ignores `--no-walk` once a range (a `not` tip) is present, ...
  if (request.noWalk === true && request.not.length === 0)
    return seedsWithoutWalking(commitSeeds, request);
  return walkCommitSeeds(ctx, resolved, marks, request);
}
```

Target (design § Change):

```ts
if (commitSeeds.length === 0 || (request.maxCount === 0 && marks.commitTips.length === 0))
  return [];
```

Line width is 100 (biome.json L66); let `biome check --write` wrap it. Why each piece
holds, so nothing else changes:

- `walkCommitSeeds` (L534-547) already runs `collectLimitedWalk` when
  `marks.commitTips.length > 0`, marks edge trees under `objects` (`markExcludedTrees`),
  then `walked.slice(0, request.maxCount)` → `slice(0, 0)` = `[]`. `collectLimitedWalk`
  (L468-491) passes no `takeAtMost`, so the limited walk runs to completion.
- With a commit `not` tip, `request.not.length > 0`, so `noWalk` falls through to
  `walkCommitSeeds` (git drops `--no-walk` for a range) — no `noWalk` change needed.
- With no commit `not` tip the early return still fires, so `collectStreamedWalk`
  (L427-446) never receives `takeAtMost: 0` (`drain` in limit-list.ts never stops on 0 and
  would walk the whole ancestry). Do NOT drop the operand instead: the design's probe
  shows that variant fails 3/5 fault rows. limit-list.ts is not touched.
- Use `marks.commitTips`, never `request.not.length`: a tree/blob/tag-of-tree `not` tip
  does not limit git's walk.

Doc comments in the same file that the change falsifies (reword in-part):

- `ClosureRequest.maxCount` JSDoc (L82-88) says "`0` walks no commits at all." Replace
  that sentence with: "`0` lists no commit; with a commit in `not` the range is still
  walked (and, under `objects`, its edge trees marked), as git's `limit_list` runs before
  the count applies."
- `listCommitSeeds` JSDoc (L562): "no seeds, `maxCount: 0` with no commit excluded,
  `noWalk`, or the full walk."

**`RevListOptions.maxCount` JSDoc** (`src/application/commands/rev-list.ts` L58-62), now:

```ts
  /**
   * At most this many commits emitted (under `objects`, those commits and
   * everything they reach). Bounds the commit walk only. `0` yields an
   * empty result.
   */
  readonly maxCount?: number;
```

Replace "`0` yields an empty result." with the design's text: "`0` lists no commit. Under
`objects`, the pending tree, blob and tag wants are still listed, minus whatever the
excluded commits' edge trees reach. With a commit in `not`, the range is still walked."

**`docs/use/commands/rev-list.md` L56**, now ends: "`maxCount: 0` yields an empty result
rather than an unbounded one." Replace that sentence with: "`maxCount: 0` lists no commit
(never an unbounded walk). Under `objects`, the pending tree, blob and tag wants are still
listed, minus whatever the excluded commits' edge trees reach; with a commit in `not`, the
range is still walked, so a commit missing inside it still refuses."

**Unit file** `test/unit/application/primitives/internal/closure-engine.test.ts`
(3444 lines). Imports already present: `computeClosure`, `createObjectTypeTable` (L22,
no-arg factory), `writeTree` (L30, `(ctx, entries) => Promise<ObjectId>`), `TsgitError`
(L32), `FileMode` and `ObjectId` types, `treeEntry` (L41, `treeEntry(mode, name, id)`),
`buildSeededContext` (L56, `() => Promise<Context>`). File-local helpers:
`writeBlob(ctx, content: string): Promise<ObjectId>` (L86);
`writeDatedCommit(ctx, tree, parents: ReadonlyArray<ObjectId>, timestamp: number): Promise<ObjectId>` (L117).

Insert the new rows inside `describe('computeClosure — the commit walk the request selects')`
(L3206-3348), after its last block `Given a commit whose parent the repository lacks and
an unrelated commit excluded` (ends L3347), before the closing `});` at L3348. That
describe owns a reusable local fixture:

```ts
  /** A commit whose only parent the repository lacks. */
  const buildGraftedTip = async () => {        // L3219
    const ctx = await buildSeededContext();
    const tree = await writeTree(ctx, []);
    const absentParent = 'b'.repeat(40) as ObjectId;
    const tip = await writeDatedCommit(ctx, tree, [absentParent], 1000);
    const unrelated = await writeDatedCommit(ctx, tree, [], 50);
    return { ctx, tip, unrelated };
  };
```

`tree` is not returned; for U3 recompute it with `await writeTree(ctx, [])` (same id).
`objectTypes` is mandatory on U2–U4: without it the walk sets `ignoreMissing: true` and an
absent parent is skipped silently (existing rows at L3284 and L3328 pin that). Request
shape: `{ tier: 'walk', wants, not, objects, maxCount: 0, objectTypes: createObjectTypeTable() }`;
assert `result.objects.map((object) => object.id)`.

**Interop file** `test/integration/rev-list-objects-interop.test.ts` (1786 lines).

- `gitIds(dir, ...args)` (L77): `git rev-list <args>` stdout as bare ids in git's order.
- `buildNonCommitTipFixture()` (L127-146): `base` ← `main`; `main`'s tree keeps
  `base.txt`'s blob and adds `tip.txt`. Refs: `refs/heads/main`, `refs/heads/base`,
  `refs/tags/tip-tree`, `refs/tags/tip-blob`, `refs/tags/base-tree`,
  `refs/tags/base-blob`, annotated `tag-tree` (→ tip tree), `tag-tag` (→ `tag-tree`),
  `tag-base` (→ `base` commit). No subdirectory.
- Block `describe('Given tag, tree and blob tips on either side of a range')` L599-632:
  `beforeAll` builds `dir` (L602-604), `afterAll` removes it, one
  `describe.each([...])('When revList lists $wants ^$not with objects', …)` L608-631 whose
  `it` does `gitIds(dir, '--objects', ...wants, '--not', ...not)` vs
  `revList(createNodeContext({ workDir: dir }), { wants, not, objects: true })`, compared
  with ordered `toEqual` on `result.entries.map((entry) => entry.id)`. Add the new
  `describe.each` right after it (after L631, before the block's closing `});` at L632).
- Suite `describe.skipIf(!GIT_AVAILABLE)('rev-list interop — object types assigned in one run')`
  (L899-…) holds the fault helpers, all suite-local:
  - `capturing(dir): { ctx: Context; logged: string[] }` (L924) — node context whose
    `logger.error` pushes into `logged`.
  - `buildMistypedTagFixture(): Promise<{ dir; blob }>` (L906) — the throwaway repo the
    fault rows use (pushes `dir` for cleanup).
  - `writeLiteralCommit(dir, tree: string, parents: ReadonlyArray<string>): string` (L991)
    and `emptyTreeOf(dir): string` (L996).
  - `walkStderrOf(logged, error): string` (L1037) — rebuilds git's stderr; an error with
    no `data.commit` renders `fatal: revision walk setup failed\n`.
  - `settled(run: () => Promise<unknown>): Promise<unknown>` (L1040) — the thrown error, or
    `undefined`.
  - `ABSENT_PARENT` (L1079): the string "cd" followed by 38 zeros, an oid no object has.
  - Block `describe('Given a commit whose parent object is missing and an excluded root')`
    L1105-1124 (unbounded `rev-list child ^root`, asserts `peer.exitCode === 128` and
    `walkStderrOf(logged, result) === peer.stderr`). Add the new fault blocks right after
    it (after L1124, before `Given a commit whose parent object is missing`, the
    pack-objects at L1126).

**Probe evidence (lesson 005).** A throwaway probe (deleted, never staged) ran each new
interop row on git 2.56.0 and on tsgit at HEAD (c1873028, code identical to b9c4b523) with
the fixture above (baseTree, baseBlob, tipTree, tipBlob, tagTree name the refs' ids):

```
ROW main base-tree ^base           | git=[]                         ours=[baseTree,baseBlob]               DIFF
ROW main base-blob ^base           | git=[]                         ours=[baseBlob]                        DIFF
ROW main tip-tree ^base            | git=[tipTree,tipBlob]          ours=[tipTree,baseBlob,tipBlob]        DIFF
ROW main tag-tree ^base            | git=[tagTree,tipTree,tipBlob]  ours=[tagTree,tipTree,baseBlob,tipBlob] DIFF
ROW main base-tree ^tag-base       | git=[]                         ours=[baseTree,baseBlob]               DIFF
ROW main base-tree ^base --no-walk | git=[]                         ours=[baseTree,baseBlob]               DIFF
ROW main base-tree ^               | git=[baseTree,baseBlob]        ours=[baseTree,baseBlob]               EQ
ROW main base-tree ^tip-tree       | git=[baseTree]                 ours=[baseTree]                        EQ
FAULT objects=false not=true  | git exit=128 stderr="error: Could not read cd00…00\nfatal: revision walk setup failed\n" | ours ok [] logged=[]
FAULT objects=true  not=true  | git exit=128 (same stderr)                                                       | ours ok [] logged=[]
FAULT objects=false not=false | git exit=0 stdout="" stderr=""                                                   | ours ok [] logged=[]
FAULT objects=true  not=false | git exit=0 stdout="" stderr=""                                                   | ours ok [] logged=[]
```

All rows ran with `--objects -n 0` on git and `objects: true, maxCount: 0` on tsgit. The
`main tip-tree ^base` row is the one that separates "marked the edge" from "returned
early". The design's own verification table (46/46 matrix, 5/5 fault rows with the
proposed guard) covers GREEN.

### TDD steps

1. **RED U1** — closure-engine.test.ts, new block
   `describe('Given a want commit and the root tree of its excluded parent as a pending want')`
   > `describe('When computeClosure lists objects with maxCount: 0')` >
   `it('Then the parent tree is marked through the walked edge and nothing is listed')`.
   Arrange: `parentTree = writeTree(ctx, [treeEntry('100644' as FileMode, 'a.txt', await writeBlob(ctx, 'parent'))])`,
   `parent = writeDatedCommit(ctx, parentTree, [], 100)`, `tipTree` likewise with blob
   `'tip'`, `tip = writeDatedCommit(ctx, tipTree, [parent], 200)`. Act:
   `sut(ctx, { tier: 'walk', wants: [tip, parentTree], not: [parent], objects: true, maxCount: 0 })`.
   Assert ids `toEqual([])`. Fails at HEAD: the early return on `maxCount === 0` skips
   `markExcludedTrees`, so it returns `[parentTree, <'parent' blob>]` (matrix row
   `-n 0 W Tn ^N`, ours `[Tn,Bn,…]`).
2. **RED U4** — new block
   `describe('Given a commit whose parent the repository lacks, an unrelated commit excluded and a type table')`
   > `describe('When computeClosure walks it with maxCount: 0')` >
   `it('Then the walk setup fails as it does without a count')`. Arrange
   `buildGraftedTip()`. Act inside try/catch:
   `sut(ctx, { tier: 'walk', wants: [tip], not: [unrelated], objects: false, maxCount: 0, objectTypes: createObjectTypeTable() })`.
   Assert `(caught as TsgitError).data` `toEqual({ code: 'REVISION_WALK_FAILED' })` (also
   assert `caught` is a `TsgitError` via `toBeInstanceOf` before reading `.data`). Fails at
   HEAD: the early return resolves `[]`, nothing is thrown (`caught` stays `undefined`).
3. **GUARD U2** — same new describe area,
   `describe('Given a commit whose parent the repository lacks, nothing excluded and a type table')`
   > `describe('When computeClosure walks it with maxCount: 0')` >
   `it('Then nothing is walked and nothing is listed')`. Request `not: []`,
   `objects: true`, `objectTypes`, `maxCount: 0`; assert ids `toEqual([])` (an unexpected
   throw fails the test). Passes at HEAD and after GREEN because the early return fires
   with no commit `not` tip. Kills the mutant `marks.commitTips.length === 0` → `false`
   (that would reach `collectStreamedWalk` with `takeAtMost: 0`, walk to the absent
   parent and refuse).
4. **GUARD U3** — `describe('Given a commit whose parent the repository lacks, only a tree excluded and a type table')`
   > `describe('When computeClosure walks it with maxCount: 0')` >
   `it('Then nothing is walked and nothing is listed')`. As U2 with
   `not: [await writeTree(ctx, [])]`. Passes at HEAD (early return). Kills a guard
   written over `request.not.length` instead of `marks.commitTips`.
5. **RED I1–I6** — interop, new `describe.each` after L631 inside
   `Given tag, tree and blob tips on either side of a range`, titled
   `'When revList lists $wants ^$not with objects, maxCount 0 and noWalk $noWalk'` >
   `it('Then it shows the pending objects git rev-list --objects -n 0 shows')`. Body:
   `const flags = noWalk ? ['--no-walk'] : [];`
   `expected = gitIds(dir, '--objects', '-n', '0', ...flags, ...wants, '--not', ...not)`;
   `sut(ctx, { wants, not, objects: true, maxCount: 0, noWalk })`; ordered `toEqual` on
   entry ids. RED rows (HEAD vs git from the probe above):
   - I1 `{ wants: ['main', 'base-tree'], not: ['base'], noWalk: false }` — ours lists `[baseTree, baseBlob]`, git `[]`.
   - I2 `{ wants: ['main', 'base-blob'], not: ['base'], noWalk: false }` — ours `[baseBlob]`, git `[]`.
   - I3 `{ wants: ['main', 'tip-tree'], not: ['base'], noWalk: false }` — ours keeps `baseBlob`, git drops it.
   - I4 `{ wants: ['main', 'tag-tree'], not: ['base'], noWalk: false }` — ours keeps `baseBlob`, git drops it.
   - I5 `{ wants: ['main', 'base-tree'], not: ['tag-base'], noWalk: false }` — ours `[baseTree, baseBlob]`, git `[]`.
   - I6 `{ wants: ['main', 'base-tree'], not: ['base'], noWalk: true }` — ours `[baseTree, baseBlob]`, git `[]`.
6. **GUARD I7, I8** — same `describe.each`, extra rows:
   - I7 `{ wants: ['main', 'base-tree'], not: [], noWalk: false }` — probe: git and ours
     both `[baseTree, baseBlob]` (no `not` side: early return, nothing marked).
   - I8 `{ wants: ['main', 'base-tree'], not: ['tip-tree'], noWalk: false }` — probe: git
     and ours both `[baseTree]` (tree-only `not` marks `baseBlob` directly; no walk).
7. **RED F1, F2** — after L1124, new
   `describe.each([['rev-list -n 0', [], false], ['rev-list -n 0 --objects', ['--objects'], true]] as const)('Given a commit whose parent object is missing and an excluded root, walked with maxCount 0', (command, flags, objects) => …)`
   > a template-literal describe "When ${command} walks the range on both tools" >
   `it('Then both cannot read the parent and fail the walk setup')`. Arrange as L1109-1113
   (`buildMistypedTagFixture`, `child = writeLiteralCommit(dir, emptyTreeOf(dir), [ABSENT_PARENT])`,
   `root = writeLiteralCommit(dir, emptyTreeOf(dir), [])`,
   `peer = tryRunGitWithExit(['-C', dir, 'rev-list', '-n', '0', ...flags, child, '^' + root])` (a template literal in code),
   `capturing(dir)`). Act:
   `settled(() => sut(ctx, { wants: [child], not: [root], objects, maxCount: 0 }))`.
   Assert `peer.exitCode` `toBe(128)` and `walkStderrOf(logged, result)` `toBe(peer.stderr)`.
   Fails at HEAD: tsgit resolves `[]` with nothing logged, so `walkStderrOf` renders only
   `fatal: revision walk setup failed\n` while git prints
   `error: Could not read cd00…00\nfatal: revision walk setup failed\n` (probe above).
8. **GUARD F3, F4** — next to it,
   `describe.each([['rev-list -n 0', [], false], ['rev-list -n 0 --objects', ['--objects'], true]] as const)('Given a commit whose parent object is missing and nothing excluded, walked with maxCount 0', …)`
   > a template-literal describe "When ${command} runs on both tools" >
   `it('Then neither walks: git prints nothing and tsgit lists nothing, logging nothing')`.
   Act `sut(ctx, { wants: [child], objects, maxCount: 0 })` directly (a throw fails the
   test). Assert `{ exitCode: peer.exitCode, stdout: peer.stdout, stderr: peer.stderr }`
   `toEqual({ exitCode: 0, stdout: '', stderr: '' })` and `{ entries: result.entries, logged }`
   `toEqual({ entries: [], logged: [] })`. Probe: git exit 0, empty; ours `[]`,
   `logged=[]` — passes at HEAD and after GREEN (early return kept).
9. **GREEN** — closure-engine.ts L570: replace `request.maxCount === 0` with
   `(request.maxCount === 0 && marks.commitTips.length === 0)`. Re-run the two touched
   test files: U1, U4, I1–I6, F1, F2 turn green; U2, U3, I7, I8, F3, F4 stay green.
10. **REFACTOR / docs** — reword the `ClosureRequest.maxCount` and `listCommitSeeds`
    JSDoc (closure-engine.ts), `RevListOptions.maxCount` JSDoc (rev-list.ts),
    docs/use/commands/rev-list.md L56, exactly as in Context. Then `npm run docs:json` and
    stage `reports/api.json`. No code restructuring is needed; `biome check --write` on
    closure-engine.ts wraps the guard line.

Existing suites that must stay green unchanged: the `maxCount: 0` row in
test/unit/application/commands/rev-list.test.ts L405-420 (no `not` side → empty), the
`Given a commit whose parent the repository lacks …` rows at closure-engine.test.ts L3284
and L3328, and interop L1105-1124. No parser, matcher or serializer is touched, so no
property sibling.

### Gate

```bash
npx vitest run test/unit/application/primitives/internal/closure-engine.test.ts test/unit/application/commands/rev-list.test.ts test/integration/rev-list-objects-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/closure-engine.ts src/application/commands/rev-list.ts test/unit/application/primitives/internal/closure-engine.test.ts test/integration/rev-list-objects-interop.test.ts && npm run check:spelling
```

Then confirm api.json is current: `npm run docs:json && git diff --no-ext-diff --stat -- reports/api.json`
must show the change staged in this commit and nothing left unstaged afterwards.

Phase gate (after the part): `npm run validate`.

### Commit

`fix(rev-list): walk the range under maxCount 0 when a commit is excluded`
