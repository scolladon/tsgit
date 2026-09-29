# Plan — exact rename pass consumes each deleted source once

> Source: design doc `docs/design/rename-exact-one-shot-delete.md` · ADRs 893, 894, 895, 896, 897, 898
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
  files in its `### Context` block, is two parts. What counts is a path in code format:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Landing order (decided) and why

The design's §6 numbering is **not** the landing order. The landing order is:

| Part | Lands | Design §6 source |
|---|---|---|
| 1 | blame single-follow + blame unit/interop pins | design Part 2 + the B1 row of design Part 4 |
| 2 | faithful exact pass, `maxSameIdDeletes` removed, `reports/api.json` regenerated (breaking) | design Part 1 |
| 3 | property sibling + exact-pass interop suite (test-only, no `src/` delta) | design Parts 3 and 4 |

Ordering hazard: with today's blame, the exact-pass fix (Part 2) makes `blame` of every
fan-out copy except the first stop following the rename (design row B1). Blame
single-follow therefore lands **before** the exact pass. Part 1 is safe on today's
buggy exact pass: with the blamed path as the only destination, the fan-out bug has no
second add to act on, so every intermediate commit stays green and git-faithful.

Part 1 also has a genuine RED of its own (row **B2**, probed for this plan, not in the
design matrix): an inexact rename competition that tsgit's blame gets wrong today.

```
c1: a.txt = l1..l10
c2: rm a.txt; b.txt = l1..l8,XX,YY ; c.txt = l1..l9,ZZ
git diff -M       → A b.txt ; R087 a.txt→c.txt
git blame b.txt   → lines 1-8 ^c1 a.txt ; lines 9-10 c2 b.txt     (single_follow: b.txt is the only destination)
git blame c.txt   → lines 1-9 ^c1 a.txt ; line 10 c2 c.txt
tsgit blame b.txt → all 10 lines c2 b.txt   ✗ (a.txt consumed by c.txt in the full-tree detection)
tsgit blame c.txt → matches git            ✓ (rename-with-edit IS followed today)
```

Probe facts verified for this plan (throwaway copy of the tree, faithful exact pass
prototyped, full `unit` + `integration` projects run):

- The only existing tests that change under the Part 2 exact pass are in
  `test/unit/domain/diff/rename-detect.test.ts` (the `:79`, `:179`, `:198`, `:280` blocks
  fail; `:253` and the others stay green). No test in `diff-trees`, `diff`,
  `detect-similarity-renames`, `blame`, `rename-similarity-interop` or any other suite
  moves. (bundle / dispose / public-runtime-exports failures in the throwaway were
  environmental — no `.git`, no `dist/` — and are unrelated.)
- `cspell` accepts the fixture vocabulary (`Qux`, `Zzz`, `Zed`, `Baz`, `F001`) and the
  new helper names; no `cspell.json` edit is needed.
- git 2.55.0 confirms row B2 above.

## Decision candidates

Load-bearing choices the design/ADRs do not pre-decide. The plan is written with the
recommendation applied; the orchestrator confirms or redirects before implementation.

1. **Part order.** (a) blame single-follow first, then the exact pass *(recommended,
   applied)* — every commit green and git-faithful, and Part 1 has a real RED (B2);
   (b) blame and exact pass in one part — one lifecycle over 6+ cycles and 7 files,
   over the ceiling; (c) exact pass first — leaves an intermediate commit where blame
   diverges from git (B1), forbidden.
2. **Where the exact-pass interop suite and the property sibling land.** (a) standalone
   test-only Part 3 after the exact pass *(recommended, applied)* — Part 2 already carries
   five RED→GREEN cycles plus the api.json regeneration; the interop suite builds ~20
   git repos and the property sibling adds a generator, which would push Part 2 past
   ~100 tool calls. Part 3 has no `src/` delta (template exception for harness/property
   suites) and every row it pins passes only after Part 2; (b) fold both into Part 2 —
   true RED for the property one-shot invariant and the interop rows, but a part at ~9
   cycles; (c) fold the property sibling into Part 2 and keep the interop suite alone in
   Part 3 — Part 2 at 6 cycles, still over the ceiling.
3. **Breaking commit type for Part 2.** (a) `fix(diff)!:` *(recommended, applied)* — the
   change is a bug fix whose breaking side-effect is the option removal; (b) `feat(diff)!:`.
   release-please lists both under BREAKING CHANGES; the choice only moves the entry
   between the Bug Fixes and Features sections.

Not a decision (settled here, flagged for review): `pickExactSource` is written as
"return the first basename match, else the first eligible candidate" rather than a
`bestScore` accumulator with a `score === 2` break (Part 2 Context). The two select the
same source on every input; the accumulator's `score === 2` break is a provably
equivalent mutant (strict `>` and a max score of 2 mean continuing the scan can never
replace the best), while the early-return shape makes every branch mutation-killable.

## Part 1 — blame follows renames with the blamed path as the only destination

### Context

Files this part edits:

- `src/application/commands/blame.ts`
- `test/unit/application/commands/blame.test.ts`
- `test/integration/blame-interop.test.ts`
- `docs/use/commands/blame.md`

Production change (ADR-895):

- Symbol: `renamedSource` (arrow function const, around line 519), current signature
  `(ctx: Context, parentTree: ObjectId, childTree: ObjectId, path: FilePath) =>
  Promise<{ sourcePath; pathSegments; chain: TreeChainDescent } | undefined>` — unchanged.
- Today it calls `diffTrees(ctx, parentTree, childTree, { recursive: true, detectRenames:
  true })` (full-tree detection, every add competes for every delete) and then scans for a
  `rename` whose `newPath === path`.
- New shape: `diffTrees(ctx, parentTree, childTree, { recursive: true })` (raw diff, no
  detection) → keep every `delete` plus the one `add` whose `newPath === path` → pass
  `{ changes: kept }` to `detectSimilarityRenames(ctx, singleFollowDiff)` → the existing
  scan loop for `rename` with `newPath === path` stays as is (including its existing
  pre-existing Stryker comment block, which is not ours to touch).
- `detectSimilarityRenames` lives in src/application/primitives/detect-similarity-renames.ts
  (read-only), signature `(ctx: Context, diff: TreeDiff, options?: RenameDetectOptions,
  preimage?: ReadonlyMap<FilePath, FlatTreeEntry>) => Promise<TreeDiff>`. Call it with no
  options and no preimage: blame never passed `renameOptions`, so threshold, limit,
  copies `'off'` and break `false` defaults are unchanged. Import it the way blame already
  imports `diffTrees` (`'../primitives/detect-similarity-renames.js'`) — commands →
  primitives is the allowed direction.
- Extract the filter into a module-private helper in `blame.ts`, e.g.
  `singleFollowDiff(diff: TreeDiff, path: FilePath): TreeDiff` (NOT exported —
  internal; no surface gate). Keep it a single `filter` with the predicate
  `change.type === 'delete' || (change.type === 'add' && change.newPath === path)`. The
  `type === 'add'` → `true` mutant does not compile (`newPath` is absent from
  `delete`/`modify`/`type-change`), so the TS checker kills it. `TreeDiff` type:
  src/domain/diff/diff-change.ts (read-only).
- Rewrite the doc comment above `renamedSource` (lines ~512-518). It claims "a
  rename-with-edit in the same commit is not" followed — false today and after this
  change (probe: `c.txt` in row B2 follows an R087). New comment says why: git blame's
  `single_follow` registers the blamed path as the only rename destination, so sibling
  adds never compete for the source. Keep the "one descent" rationale. No ADR/phase refs.

Public surface: none. No new export, no option, no type change. reports/api.json is
untouched.

Unit tests — `test/unit/application/commands/blame.test.ts`:

- Fixtures in-file: `seed()` (memory context + `init`), `commitFile(ctx, name, path,
  content)`, `ident(name, ts)`, module `clock`, `committedLines(result)`. Imports already
  present: `add`, `commit`, `mv`, `blame`. Add `import { rm } from
  '../../../../src/application/commands/rm.js'` (`rm(ctx, paths, opts?)`).
- Rename describes to sit next to: `'Given a file renamed wholesale by a later commit'`
  (~331), `'Given a rename of a file inside a subdirectory'` (~795), `'Given a commit that
  renames two files at once'` (~869, the multi-file commit pattern to copy: write files
  with `ctx.fs.writeUtf8`, `add`, then one `commit` with `ident`).
- The file does not use a `sut` binding today. New describe blocks bind
  `const sut = blame;` in Arrange and call `sut(ctx, path)` in Act (never
  `const sut = await blame(...)` — the test-pyramid `sutBindsResult` heuristic bans it).
  Existing blocks stay as they are (diff-minded).

Interop — `test/integration/blame-interop.test.ts`:

- Fixtures are built once in `beforeAll` (SETUP_TIMEOUT 60_000) with `makeRepo(slug)`,
  `commitContent(dir, file, content)` (flat file names — it does not `mkdir`),
  `datedEnv(clock)`, `git`, `runGit`; each fixture is a `let x: { dir; ctx }` declared in
  the describe, added to the `afterAll` cleanup array, and consumed by rows in
  `BLAME_PORCELAIN_MATRIX` (`{ label, fixture: () => x, file }`). The matrix `it.each`
  already renders porcelain from `BlameResult` and byte-compares with
  `git blame --porcelain HEAD -- <file>` — add rows only, no new comparison code.
- Multi-file second commit: `git(dir, 'rm', '-q', <src>)`, `writeFile` the adds,
  `git(dir, 'add', '-A')`, `runGit(['-C', dir, 'commit', '-q', '-m', '<msg>'], { env:
  datedEnv(clock) })` after `clock += 60`.

Docs — `docs/use/commands/blame.md` "Renames" bullet (~line 82): add that the blamed path
is the only rename destination considered (git's single-follow), so every copy of a file
made alongside its delete follows back to the original, and unrelated adds in the commit
never compete for the source. Behaviour text only, no internals.

### TDD steps

1. RED — unit, new describe `'Given a deleted file whose content two added files each
   partially keep'` > `'When blaming the less similar add'` > `it('Then its kept lines
   follow to the deleted source, not the commit that added it')`. c1: `a.txt` =
   `l1\n…l10\n`; c2: `rm a.txt`, add `b.txt` = `l1..l8,XX,YY`, `c.txt` = `l1..l9,ZZ`, one
   commit. Assert `committedLines(result).map(l => l.commit)` = eight `c1` then two `c2`,
   and `sourcePath` = eight `'a.txt'` then two `'b.txt'`. Fails today: every line is
   blamed to c2 with `sourcePath 'b.txt'` (the full-tree detection hands `a.txt` to
   `c.txt`).
2. Same describe, second `When` > `'When blaming the more similar add'` > `it('Then the
   rename-with-edit is followed')`: `c.txt` → nine `c1`/`'a.txt'` then one `c2`/`'c.txt'`.
   Green on arrival — pins that an inexact rename is followed (the precondition for
   rewording the doc comment).
3. Guard (green on arrival; turns into the B1 regression guard for Part 2): new describe
   `'Given a file deleted and its identical content added at three paths in one commit'`
   > `'When blaming each added copy'` > `it('Then every copy follows to the deleted
   source')`. c1: `a/Foo.meta` = `x\n`; c2: rm it, add `b/A.meta`, `b/B.meta`, `b/C.meta`
   = `x\n`. Assert each blame's single line has commit c1 and `sourcePath 'a/Foo.meta'`.
4. GREEN — implement `singleFollowDiff` + the `renamedSource` call change + the doc
   comment. Steps 1–3 and every existing blame test green.
5. Interop RED→GREEN — in `blame-interop.test.ts` add two fixtures in `beforeAll`:
   `fanOut` (c1 `Foo.txt` = `l1\nl2\n`; c2 `git rm Foo.txt`, add `A.txt`, `B.txt`,
   `C.txt` with the same bytes — design rows #6/B1, flat names) and `inexactCompetition`
   (the B2 repo above, flat names). Add matrix rows `'a fan-out copy (first in path
   order)'` → `A.txt`, `'a fan-out copy (second)'` → `B.txt`, `'a fan-out copy (third)'`
   → `C.txt`, `'the less similar of two competing adds'` → `b.txt`, `'the more similar of
   two competing adds'` → `c.txt`. Register both fixtures in `afterAll`. The `b.txt` row
   is RED if run against the pre-step-4 code; all five are green after step 4.
6. REFACTOR — `renamedSource` under 20 lines, no nesting > 2; `docs/use/commands/blame.md`
   bullet updated.

### Gate

```bash
npx vitest run --project unit test/unit/application/commands/blame.test.ts \
  && npx vitest run --project integration test/integration/blame-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/blame.ts test/unit/application/commands/blame.test.ts test/integration/blame-interop.test.ts \
  && npm run check:spelling \
  && npm run check:test-pyramid
```

### Commit

`fix(blame): follow renames with the blamed path as the only destination`

## Part 2 — exact rename pass consumes each deleted source once; `maxSameIdDeletes` removed

### Context

Files this part edits:

- `src/domain/diff/rename-detect.ts`
- `test/unit/domain/diff/rename-detect.test.ts`
- `reports/api.json` (regenerated by `npm run docs:json`, never hand-edited)

Precondition: Part 1 has landed (blame single-follow). Without it this part regresses
blame row B1 — the B1 unit guard from Part 1 (`'Given a file deleted and its identical
content added at three paths in one commit'`) and the three fan-out interop rows are the
tripwire; they are in this part's gate.

Current code — `src/domain/diff/rename-detect.ts` (112 lines):

- `RenameDetectOptions` (line 7): field `readonly maxSameIdDeletes?: number;` (line 9) —
  **remove** (ADR-894). Other fields untouched. The type stays exported from
  src/domain/diff/index.ts (line 65) and via src/public-types.ts — those files do not
  change.
- `DEFAULT_MAX_SAME_ID_DELETES = 100` (line 25) — **remove**; replace with the
  module-private
  `const EXACT_CANDIDATE_CAP = 100;` with a why-comment (git's `find_identical_files`
  examines at most this many candidates per destination). `DEFAULT_LIMIT = 1000` stays.
- `partition(changes)` (line 27) — unchanged.
- `buildDeletesByOldId(deletes, maxSameIdDeletes: number): Map<ObjectId,
  ReadonlyArray<DeleteChange>>` (line 43) — drop the second parameter and the prune loop
  (lines 56-61); return `Map<ObjectId, DeleteChange[]>` (local mutable working groups,
  path order = input order).
- `tryFoldAdd(add, deletesByOldId: Map<ObjectId, ReadonlyArray<DeleteChange>>) => {
  rename; consumedDelete } | undefined` (line 64) — today refuses unless the group has
  exactly one delete (`matches.length !== 1`) and never removes the consumed delete (the
  #300 bug). New: take the group (`Map<ObjectId, DeleteChange[]>`), ask
  `pickExactSource`, and on a hit remove that delete from its group (`splice` on the local
  array) and return the same `{ rename, consumedDelete }` shape (rename object literal
  unchanged: `similarity: { score: MAX_SCORE, maxScore: MAX_SCORE }`).
- `detectRenames(diff: TreeDiff, options: RenameDetectOptions = {}): TreeDiff` (line 87)
  — signature unchanged. Drop the `maxSameIdDeletes` resolution (line 89). The
  `adds.length * deletes.length > limit` guard, the `consumedDeletes` Set, the
  `unfoldedDeletes` filter and `sortByPath(merged, primaryPath)` all stay.
- Sole production caller: `detectSimilarityRenames`
  (src/application/primitives/detect-similarity-renames.ts, line ~831, read-only) calls
  `detectRenames(workingDiff, { ...options, limit: Number.MAX_SAFE_INTEGER })` — no change
  needed; nothing in `src/` sets `maxSameIdDeletes`.

New module-private helpers (NOT exported — internal, no surface gate), each < 20 lines,
early returns, no boolean params:

```ts
// both regular (644/755 pair freely) or identical modes (symlink, gitlink, tree)
function isExactModeCompatible(oldMode: FileMode, newMode: FileMode): boolean
// last path segment equality; 'Foo' ≡ 'b/Foo', 'xFoo' ≢ 'Foo' (git's basename_same)
function hasSameBasename(oldPath: FilePath, newPath: FilePath): boolean
// index into group of the chosen source, or a NOT_FOUND sentinel constant
function pickExactSource(add: AddChange, group: ReadonlyArray<DeleteChange>): number
```

- `isExactModeCompatible`: `kindOf(oldMode) === 'file' && kindOf(newMode) === 'file'` →
  true; else `oldMode === newMode`. Reuse `kindOf` from `./mode-kind.js`
  (src/domain/diff/mode-kind.ts, read-only; returns `'file' | 'symlink' | 'directory' |
  'gitlink'`). `FileMode` import from `'../objects/index.js'`.
- `hasSameBasename`: compare `path.slice(path.lastIndexOf('/') + 1)` of both sides.
  Paths are `FilePath` and never end in `/`.
- `pickExactSource` — transcription of git's `find_identical_files` for `-M`, written
  as the equivalent early-return form (see "Not a decision" above):

  ```
  fallback = NOT_FOUND; examined = 0
  for i over group while examined < EXACT_CANDIDATE_CAP:
    candidate = group[i]
    if !isExactModeCompatible(candidate.oldMode, add.newMode): continue   // not counted
    if hasSameBasename(candidate.oldPath, add.newPath): return i          // score 2 wins at once
    if fallback === NOT_FOUND: fallback = i                               // first score-1 wins ties
    examined += 1
  return fallback
  ```

  Semantics pinned by git (design §2): destination-major in add input order (path
  order); one-shot (consumed deletes are removed, so never offered again); basename
  preference among unused sources; strict first-wins among equals; mode-incompatible
  candidates do not count toward the cap; the 100th eligible candidate is examined, the
  101st is not; the pass is never gated by the rename limit inside `diffTrees`.

Public surface change (breaking, ADR-894): `RenameDetectOptions.maxSameIdDeletes` leaves
the public type. Surface gates to pre-pay in this part:

- `reports/api.json` — regenerate with `npm run docs:json` (drops
  `RenameDetectOptions.maxSameIdDeletes`, today at ~110680 / ~190319, plus typedoc id
  churn — normal), then `git add reports/api.json` so `npm run check:doc-typedoc`
  (`docs:json` + `git diff --exit-code -- reports/api.json`) is clean. It is a prepush
  gate, not a validate gate — run it here.
- No barrel, facade, exhaustiveness switch, error code, README count or registry changes:
  the type stays exported, only one optional field goes.
- docs/use/commands/diff.md and docs/use/primitives/diff-trees.md do not mention the
  option (verified); the design docs docs/design/diff-and-merge.md and
  docs/design/similarity-rename-detection.md already carry the superseded note; the
  historical plans are left as they are. No doc edit in this part.

Unit tests — `test/unit/domain/diff/rename-detect.test.ts` (347 lines):

- Fixtures in-file: `ID_A`/`ID_B`/`ID_C` (40-hex), `addChange(path, id, mode =
  REGULAR)`, `deleteChange(path, id, mode = REGULAR)`, `diff(changes)` (does NOT sort — list
  the adds in path order among themselves and the deletes likewise, as a raw diff would;
  the output is sorted by `detectRenames` itself),
  `extractPaths`. `FILE_MODE` has `REGULAR`, `EXECUTABLE`, `SYMLINK`, `GITLINK`,
  `DIRECTORY`.
- Titles: `describe('Given …')` > `describe('When detectRenames called')` >
  `it('Then …')` (the file's existing pattern). New and rewritten blocks bind a
  module-level `const sut = detectRenames;` and call `sut(input)` in Act; untouched
  blocks stay as they are. AAA comments.
- Existing blocks to change (probe-confirmed; nothing else in the repo moves):

  | Block (line) | Action |
  |---|---|
  | `'Given diff with Add+Delete matching id but multiple deletion candidates'` (:79) | rewrite (row #3): deletes `a.txt`,`b.txt` (ID_A), add `c.txt` → rename `a.txt→c.txt`, `b.txt` stays `delete`; assert the full sorted `changes` array |
  | `'Given exactly maxSameIdDeletes deletes …'` (:179) | remove (pinned refusal via the option; superseded by :79) |
  | `'Given maxSameIdDeletes + 1 deletes …'` (:198) | rewrite as the cap boundary pair (rows #16a/#16b, step 4) |
  | `'Given exactly 1 delete with matching add and maxSameIdDeletes=1'` (:253) | remove (duplicates the 1:1 fold at :47; the prune is gone) |
  | `'Given maxSameIdDeletes=0 …'` (:280) | remove ("0 = no exact pairing" no longer exists) |

  The two inline example "properties" (:303 idempotence, :324 path subset) stay.
- Cap rows need 100+ deletes: build them with a small local helper
  (`Array.from({ length: n }, (_, i) => deleteChange(\`a/F${String(i + 1).padStart(3, '0')}.meta\`, ID_A))`);
  `a/F001..a/F101` sort before `a/Zzz.meta` in byte order. 1 add × 101 deletes = 101
  stays under the default `limit` of 1000.

### TDD steps

1. RED one-shot (#300): `'Given one delete and two adds sharing its id'` — `a/Foo.meta`
   → `b/Bar.meta`, `b/Baz.meta` → expect `rename a/Foo.meta→b/Bar.meta` + `add
   b/Baz.meta` (row #1). Fails today: two renames of `a/Foo.meta`. Add in the same cycle:
   basename-matching add second (#2: adds `b/Bar.meta`, `b/Foo.meta` → Bar renamed, Foo
   stays add — path order beats basename); three adds (#6: `b/A.meta` renamed,
   `b/B.meta`/`b/C.meta` stay adds); empty-content id (#14 shape at domain level is the
   same as #1 — skip unless a distinct branch appears). GREEN: `pickExactSource` +
   removal in `tryFoldAdd`.
2. RED multi-delete groups: rewritten :79 (#3, first in path order); basename = second
   delete (#4: `a/Foo.meta`,`a/Qux.meta` → `b/Qux.meta` → `a/Qux.meta→b/Qux.meta`,
   `a/Foo.meta` stays `delete`); basename = third (#18: `a/Foo`,`a/Qux`,`a/Zed` →
   `b/Zed.meta` → `a/Zed.meta` wins); N×M (#7: deletes `a/Foo.meta`,`a/Qux.meta`, adds
   `b/Qux.meta`,`b/Zed.meta` → `Qux→Qux`, `Foo→Zed`); #5 (`Foo→Bar`, `Qux→Baz`);
   basename is a whole segment, not a suffix (deletes `a/Bar.meta`,`a/xFoo.meta` → add
   `b/Foo.meta` → `a/Bar.meta` wins); top-level vs nested basename (deletes
   `a/Bar.meta`,`b/Foo.meta` → add `Foo.meta` → `b/Foo.meta` wins). All fail today (the
   `length !== 1` refusal). GREEN: `hasSameBasename` + the early return.
3. RED mode rule, each guard isolated: symlink delete → regular add, same id → no
   rename (kills `&&`→`||` and the `oldMode === newMode` → `true` mutant); regular delete
   → symlink add → no rename (kills the `kindOf(newMode) === 'file'` → `true` mutant);
   symlink → symlink pairs (#12 shape: deletes `a/link` SYMLINK, adds `b/file` REGULAR,
   `b/link2` SYMLINK → `add b/file` + `rename a/link→b/link2`); `100644 → 100755` pairs
   (#13: `a/Foo.sh` → `b/Bar.sh` EXECUTABLE, `b/Baz.sh` REGULAR → Bar renamed, Baz add);
   gitlink → gitlink same oid pairs, gitlink → regular does not. The "no rename"
   rows fail today: the current pass has no mode rule and folds any one-delete group. GREEN:
   `isExactModeCompatible` wired into `pickExactSource`.
4. RED cap boundary (rewritten :198): 99 deletes `a/F001..F099` + `a/Zzz.meta` → add
   `b/Zzz.meta` folds `a/Zzz.meta` (#16a, basename is the 100th eligible); 100 deletes
   `a/F001..F100` + `a/Zzz.meta` → folds `a/F001.meta` (#16b, 101st never examined);
   mode-incompatible candidates are not counted: one SYMLINK delete `a/Aaa.meta` + 99
   regular `a/F001..F099` + `a/Zzz.meta` → `b/Zzz.meta` still folds `a/Zzz.meta`; 101
   deletes, no basename → `a/F001.meta` (#15). #16a fails today (similarity-free domain
   pass refuses the group). GREEN: the `examined < EXACT_CANDIDATE_CAP` bound.
5. RED option removal: remove the :179, :253, :280 blocks and the `maxSameIdDeletes`
   arguments; delete the field from `RenameDetectOptions`, `DEFAULT_MAX_SAME_ID_DELETES`,
   the `buildDeletesByOldId` parameter and prune loop (`check:types` is the RED: any
   remaining `maxSameIdDeletes` use is a TS2353 error). GREEN: `npm run docs:json`,
   `git add reports/api.json`.
6. REFACTOR: every function < 20 lines, nesting ≤ 2, named `NOT_FOUND` sentinel, no
   magic numbers, why-only comments, no ADR/issue refs in source or tests. Confirm the
   Part 1 B1 guards (blame unit + fan-out interop rows) are still green.

### Gate

```bash
npx vitest run --project unit test/unit/domain/diff/rename-detect.test.ts test/unit/application/commands/blame.test.ts test/unit/application/primitives/diff-trees.test.ts test/unit/application/primitives/detect-similarity-renames.test.ts test/unit/application/commands/diff.test.ts \
  && npx vitest run --project integration test/integration/blame-interop.test.ts test/integration/rename-similarity-interop.test.ts test/integration/diff-type-change-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/diff/rename-detect.ts test/unit/domain/diff/rename-detect.test.ts \
  && npm run check:spelling \
  && npm run check:test-pyramid \
  && npm run check:doc-typedoc
```

(`check:doc-typedoc` regenerates `reports/api.json` and fails on any unstaged diff —
stage the regenerated file before running the gate.)

### Commit

`fix(diff)!: consume each deleted source once in exact renames and remove maxSameIdDeletes`

## Part 3 — pin the exact pass: property sibling + interop suite against git

### Context

Test-only part, no `src/` delta (template exception: property and harness suites).
Every row and property it adds passes only after Part 2; see decision candidate 2 for why
it is not folded into Part 2.

Files this part creates or edits:

- `test/unit/domain/diff/arbitraries.ts` (edit — add one generator)
- `test/unit/domain/diff/rename-detect.properties.test.ts` (create)
- `test/integration/rename-exact-interop.test.ts` (create)

Property sibling (ADR-897; guidance .claude/workflow/property-testing.md, read-only):

- `arbitraries.ts` already exports `arbNonDirMode()` (REGULAR, EXECUTABLE, SYMLINK,
  GITLINK) — reuse it, do not re-add it. It imports `fc` from `'fast-check'`, types from
  `'../../../../src/domain/objects/index.js'`.
- Add `export function arbExactRenameDiff(): fc.Arbitrary<TreeDiff>` (test-internal
  export; knip is satisfied by the property test importing it). Small pools force
  collisions: ids from 3 constants (`'a'.repeat(40)` …); paths from a 9-path pool
  `{'', 'a/', 'b/'} × {'Foo.meta', 'Bar.meta', 'xFoo.meta'}` so basename and
  non-basename matches both occur; modes from `arbNonDirMode()`. Build a
  `fc.uniqueArray` of `{ kind: 'add' | 'delete' | 'modify', path, id, mode }` keyed by
  `path` (a raw diff never repeats a path), map to `AddChange`/`DeleteChange`/
  `ModifyChange` (modify: `path`, `oldId`, `newId`, `oldMode`, `newMode`), then sort by
  path (byte order) so adds are in path order like a real raw diff. `TreeDiff`/change
  types from `'../../../../src/domain/diff/diff-change.js'`.
- `rename-detect.properties.test.ts`: `const sut = detectRenames;` titles `describe('Given
  an arbitrary diff with colliding ids and paths')` > `describe('When detectRenames
  called')` > `it('Then …')`, `fc.assert(fc.property(...), { numRuns: 100 })`, AAA
  comments (`// Arrange + Assert` pattern as in raw-tree-diff.properties.test.ts,
  read-only). Invariants — none re-implements the selection loop:
  1. One-shot: every delete path is the `oldPath` of at most one `rename` (fails on the
     pre-Part-2 code — the #300 regression).
  2. Conservation: each input add path appears exactly once as `add.newPath` or
     `rename.newPath`; each input delete path appears exactly once as `delete.oldPath` or
     `rename.oldPath`.
  3. Soundness: every `rename` has `oldId === newId`, `similarity.score === MAX_SCORE`,
     and exact-mode-compatible modes (both `kindOf === 'file'`, or equal modes) — the spec
     predicate, not the loop.
  4. Pass-through: every non-add/delete input change appears unchanged in the output.
  5. Idempotence: `sut(sut(d))` deep-equals `sut(d)`.
  6. Maximality: no leftover `add` and leftover `delete` share an id with
     exact-mode-compatible modes (holds because the pools keep every group far under the
     100-candidate cap; kills "never fold" mutants). Additive to ADR-897's list.
- Keep the example file's two inline "properties" (additive, ADR-136).

Interop suite (ADR-896) — model: test/integration/diff-type-change-interop.test.ts
(read-only): `@proves` header, `describe.skipIf(!GIT_AVAILABLE)`, fixtures in
`beforeAll` with a `SETUP_TIMEOUT` (use `120_000`, ~20 repos), `rm(dir, { recursive:
true, force: true })` in `afterAll`, `createNodeContext({ workDir })` from
`'../../src/adapters/node/index.js'`, `diff` from
`'../../src/application/commands/diff.js'`. Helpers from `./interop-helpers.js`
(read-only): `GIT_AVAILABLE`, `git(dir, ...args)` (sync, scrubbed env), `runGit(args, {
env })`, `runGitEnv()`.

- Header:

  ```
  @proves
    surface:        diff.renames
    bucket:         cross-tool-interop
    unique:         exact rename pairing (one-shot source, basename preference, mode rule, 100-candidate cap, limit-free) matches git diff --name-status
    interopSurface: diff
  ```

- Local helpers: `nameStatusFrom(treeDiff)` (copy the shape from the model file:
  `A\t<new>`, `D\t<old>`, `M\t<path>`, `R100\t<old>\t<new>`, `C100…`, `T\t<path>`), a
  per-row repo builder `buildRow(slug, before, after)` where each file spec is `{ path,
  content, kind?: 'exec' | 'symlink' }`: `mkdtemp` under `os.tmpdir()`, `git init -q -b
  main`, identity config, write `before` (mkdir parents, `chmod 0o755` for exec,
  `symlink(content, path)` for symlink), `git add -A`, commit with a dated env; then
  `git rm -rq .`, write `after`, `git add -A`, commit. Compare
  `nameStatusFrom(await diff(ctx, { from: 'HEAD~1', to: 'HEAD', detectRenames: true,
  recursive: true, renameOptions }))` string-equal to
  `git(dir, 'diff', '--no-ext-diff', '--name-status', '-M', ...extraFlags, 'HEAD~1',
  'HEAD').trim()`. The `.meta` blobs hold `x\n` unless noted. Row table
  (`ReadonlyArray<{ label; before; after; gitFlags; renameOptions?; recursive? }>`) +
  one `it.each`.
- Rows (design §3; git outcome in parentheses for the reader, the assertion is always
  live git): #1 (`R Foo→Bar ; A Baz`), #2, #3, #4 (`D Foo ; R Qux→Qux`), #5, #6, #7,
  #8 = #3 with `-l1` / `renameOptions: { limit: 1 }`, #12 (symlinks `a/link`→`target`,
  `b/link2`→`target`, regular `b/file` = `target`), #13 (`b/Bar.sh` exec), #14 (empty
  blobs), #15 (101 deletes `a/F001..F101` → `b/Bar.meta`), #16 (101 + `a/Zzz.meta` →
  `b/Zzz.meta`), #16a (99 + `a/Zzz.meta`), #16b (100 + `a/Zzz.meta`), #17 = #15 with
  `-l1`, #18, D1r (`x/f`,`x/g` → `y/f`,`y/g`,`z/f`,`z/g`, recursive).
- D1 (non-recursive) is the one row not compared against `git diff`: git side is
  `git(dir, 'diff-tree', '--no-ext-diff', '-M', '--name-status', 'HEAD~1', 'HEAD')`, tsgit
  side omits `recursive` (tree entries `x`→`y` pair exactly because their modes match).
  Carry it as a separate `it` or a `gitCommand` column.
- Rows #9, #10 (`-C`) and #11 (symlink → regular) are known divergences (follow-ups,
  ADR-893 consequences, ADR-898): do NOT add them.
- No `vi.*` in integration (test-pyramid `overMockedIntegration`).

### TDD steps

1. RED→GREEN property generator: add `arbExactRenameDiff`, then invariant 1 (one-shot)
   and 2 (conservation). Sanity-check the property bites: temporarily revert the
   `splice` in `rename-detect.ts` locally, see invariant 1 fail with a shrunk
   counterexample, restore (never commit the revert).
2. Invariants 3–6. Same bite check for maximality (force `pickExactSource` to return
   `NOT_FOUND`, see 6 fail, restore).
3. Interop scaffolding + rows #1–#7 (one-shot, multi-delete, basename). Green against
   live git.
4. Rows #8, #12–#18, #16a/#16b, D1, D1r (limit, mode, cap, directory). If any row
   diverges, it is a Part 2 bug: stop and escalate `{ unit, reason, options }` — do not
   weaken the row.
5. REFACTOR: helpers < 20 lines, row table readable, `SETUP_TIMEOUT` justified by a
   why-comment.

### Gate

```bash
npx vitest run --project unit test/unit/domain/diff/rename-detect.properties.test.ts test/unit/domain/diff/rename-detect.test.ts \
  && npx vitest run --project integration test/integration/rename-exact-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check test/unit/domain/diff/arbitraries.ts test/unit/domain/diff/rename-detect.properties.test.ts test/integration/rename-exact-interop.test.ts \
  && npm run check:spelling \
  && npm run check:test-pyramid
```

Phase gate after Part 3: `npm run validate`.

### Commit

`test(diff): pin the exact rename pass against git and prove its pairing invariants`
