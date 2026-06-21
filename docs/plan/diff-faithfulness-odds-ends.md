# Plan — diff faithfulness odds & ends

Source: design doc `docs/design/diff-faithfulness-odds-ends.md` · ADRs `398, 399, 400, 401`

This plan is the implementation script AND the knowledge handoff. Slice agents start
with zero context: each slice block carries the exact paths, symbols, signatures,
helpers, fixtures, and pinned bytes the agent needs, so nothing is rediscovered.
`plan-lint.sh` enforces the `### Context` / `### TDD steps` / `### Gate` / `### Commit`
schema — the plan phase cannot close without it.

## Orientation (read once, applies to every slice)

The brief is **three independent parts**. Only **Part 3** carries production code; Parts
1 and 2 are **pin-only** (no `src/` change — the behaviour already exists).

- **Part 3 (Slice 1)** — `log` parent-count filter (`min/maxParents`) + the `LogOrder`
  public re-export, folded together so one `reports/api.json` regen covers the whole
  final log public surface. Production code + unit + interop. This is the ONLY slice
  with a real RED.
- **Part 2 (Slice 2)** — type-change (`T`) gitlink domain unit guards + a dedicated
  tree↔tree interop pinning all three leaf-kind pairs + the leaf↔directory negative.
  **Pin-only — no RED** (characterization: tests go GREEN on first run).
- **Part 1 (Slices 3)** — LFS pointer interop matrix. **Pin-only — no RED.**

Ordering rationale: Part 3 first (the only code change → land it and its surface gate
while context is freshest), then the two pin-only test slices in descending coupling to
existing code (Part 2 touches domain unit files; Part 1 is a standalone new interop file).

**Pin-only slices have no RED state.** For Slices 2 and 3 the "test first" step still
applies (write the test before declaring the slice done), but the test is **expected to
pass on first run** because it characterizes already-faithful behaviour. The implementer
must NOT chase a non-existent failing state — if a pin-only test fails, that is a real
faithfulness defect to escalate, not a TDD RED to satisfy.

**Standalone-slice justification (sizing rule).** Slices 2 and 3 are test-only with no
`src/` delta. They are legitimately standalone because there is **no implementation slice
to fold them into** — Parts 1 and 2 are pin-only by ADR-398/ADR-399, so the test IS the
deliverable. They are not "tests for code landed in a neighbour slice"; they pin
pre-existing behaviour on a different axis (Part 2) / a different blob shape (Part 1) than
Slice 1 touches. Folding them into Slice 1 would conflate three unrelated brief parts in
one commit.

**Interop isolation discipline (Slices 1, 2, 3 — every spawned `git`).** All interop tests
go through `test/integration/interop-helpers.ts`: `runGit` scrubs every `GIT_*` env var,
points `HOME` at a non-existent tmp path, sets `GIT_CONFIG_NOSYSTEM=1` and `XDG_CONFIG_HOME`
under that HOME — so no global/system/XDG git config (and no global git-lfs driver) engages.
Use `git(dir, ...)` / `runGit` / `runGitEnv` from that file; never spawn `git` directly. Pass
`--no-ext-diff` on every scripted `git diff`/`diff-tree`. Use one shared `beforeAll` repo and
a `60_000` ms setup timeout (the interop load→validate flake note). `describe.skipIf(!GIT_AVAILABLE)`.

**Faithfulness probes run in `mktemp -d` throwaways, never the worktree** — the gitlink and
LFS git incantations below were all pinned that way during planning; re-pin there if you
need to re-verify, never against the worktree `.git`.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it must
  earn it. No standalone test-only slices for FEATURE code: coverage/interop tests fold into
  the implementation slice whose code they exercise. The two standalone test-only slices here
  (2 and 3) are the sanctioned exception: pin-only by ADR, with no implementation slice to
  fold into.
- A slice that would be a pure test pass over already-landed code merges into its neighbour.
  Slices 2 and 3 do NOT trip this: they pin behaviour on axes Slice 1 never touches.

---

## Slice 1 — log parent-count filter (`min/maxParents`) + `LogOrder` public re-export

### Context

**Production change A — the filter (`src/application/commands/log.ts`).** Current state
(verified, byte-exact):

- `LogOptions` (lines 15-21): `{ rev?, order?: LogOrder, limit?, excluding?, before? }`.
- `LogOrder` (line 13): `export type LogOrder = 'date' | 'first-parent';` (already exported
  from `log.ts`, NOT from the barrel — see change B).
- `LogEntry` (lines 23-30) carries `parents: ReadonlyArray<ObjectId>` (line 26).
- `log` fn (lines 39-69). The walk loop (lines 53-67):
  ```ts
  for await (const value of walk) {
    if (before !== undefined && value.data.committer.timestamp >= before.getTime() / 1000) {
      continue;                              // <-- the `before` output filter
    }
    out.push({ id: value.id, tree: value.data.tree, parents: value.data.parents, ... });
    yielded += 1;
    if (opts.limit !== undefined && yielded >= opts.limit) break;   // <-- limit AFTER push
  }
  ```

Change A (ADR-400, D3.A + D3.B — numeric pair, post-walk output filter, filter-then-limit):

1. Add to `LogOptions`: `readonly minParents?: number;` and `readonly maxParents?: number;`.
   Both are `number` — they introduce NO new named type (so the only barrel addition is the
   pre-existing `LogOrder` gap, change B).
2. Apply the predicate at the SAME point as the `before` filter, BEFORE the `out.push`, so
   the `limit` counter (which counts pushes) honours **filter-then-limit**. The predicate:
   ```
   parents.length >= minParents  (when minParents !== undefined)  AND
   parents.length <= maxParents  (when maxParents !== undefined)
   ```
   `parents` = `value.data.parents`. Read the commit's **true** parent count (`value.data.parents.length`),
   so it composes with `order: 'first-parent'` unchanged (a merge still counts ≥2). Extend the
   existing `if (before...) continue;` guard, or add a sibling `continue` guard immediately
   after it — either keeps the limit break after both filters. Keep the function <20 lines of
   real logic; if the guard grows, extract a small pure `keptByParentCount(parents, opts)` /
   `withinParentBand(...)` helper (early-return, no boolean param, named — Object Calisthenics).
   Walk construction (lines 47-50) is UNCHANGED — this is an output filter, not a traversal
   pruner (ADR-400: all parents still followed, so `maxParents: 0` from a multi-root tip still
   reaches every root through merges).

**Production change B — the re-export (`src/application/commands/index.ts:143`).** Current
line: `export { type LogEntry, type LogOptions, log } from './log.js';`. Change to:
`export { type LogEntry, type LogOptions, type LogOrder, log } from './log.js';` (keep
members type-alphabetical, mirroring the sibling `ShortlogBy` ride on the `shortlog.js` line
at `index.ts:225-230`). `LogOptions`/`LogEntry` already reach `src/public-types.ts` via its
`export type * from './application/commands/index.js'` wildcard (`public-types.ts:7`); adding
`LogOrder` to this one barrel line makes all three reachable. **No edit to `public-types.ts`
itself** — the wildcard does the work (ADR-401, house-consistent with `ShortlogBy`).

**SURFACE GATE — public surface (per `.claude/workflow/surface-gates.md`).** Both changes are
public-surface: change A adds fields to the public `LogOptions`; change B newly exports
`LogOrder`. `reports/api.json` (3.9 MB, present) is a **prepush** gate (`check:doc-typedoc` =
`git diff --exit-code -- reports/api.json`), NOT a `validate` gate — local validate can be
green while the push hook rejects. **Pre-pay it IN this slice**: after BOTH change A and change
B land (so the report reflects the FINAL public surface), run `npm run docs:json` (regenerates
`reports/api.json` via typedoc) and commit the regenerated file in this same commit. The huge
typedoc-id diff is expected/normal. This is NOT a new Tier-1 command — `log` already exists on
the barrel, facade, doc-coverage, and browser surface — so the other Tier-1 gates
(barrel-new-command, facade `Object.keys`, `docs/use/commands/`, `audit-browser-surface`,
README count) do NOT apply; only `api.json` does.

**Unit test file — `test/unit/application/commands/log.test.ts`** (EXISTS, ~486 lines). Helpers
to REUSE (do not re-invent):
- `writeCommitAt(ctx, parents, timestamp, message)` (lines 41-62) — writes a loose commit with
  given parents + timestamp; returns its oid. This is how you control `parents.length`.
- `seedDiamond()` (lines 79-87) — `A`(root,1000) ← `B`(2000) ← / `C`(3000) merge `D`(parents `[B,C]`,4000).
  Gives one root (`A`, 0 parents), two single-parent (`B`,`C`), one merge (`D`, 2 parents). Default
  date order yields `['D','C','B','A']`; first-parent yields `['D','B','A']` (verified lines 130,144).
- `seedTimestampChain()` (lines 65-72) — 3-commit linear chain (all 0-or-1 parent), for
  `before`/`excluding` composition.
- `seedRepo`, `createMemoryContext`, `init`/`add`/`commit` are all imported already.
- Assertion idiom: `expect(sut.map((e) => e.message)).toEqual([...])`; `sut` is the `await log(...)`
  result array (the test file uses `sut` for the result — match the file's existing convention
  here even though the global rule prefers `sut` = the function; consistency with the 20+ existing
  cases in this file wins).

For a 3-parent (octopus) case, build it explicitly with `writeCommitAt(ctx, [b, c, e], 5000, 'O')`
on top of a diamond — `writeCommitAt` accepts any parent array.

**Interop test file — `test/integration/log-interop.test.ts`** (EXISTS, ~169 lines,
`describe.skipIf(!GIT_AVAILABLE)`). Current `buildScenario()` (lines 57-81) builds a SINGLE-root
diamond (`base` ← `b`(main, tag `v1`) and `base` ← `c`(side), merge). Helpers to REUSE:
`oidLines(out)` (lines 53-54), `logIds(dir, opts?)` (lines 83-93) — opens the repo, maps
`entry.id`, disposes. `dateEnv(epoch)` (lines 40-45), `IDENTITY` (lines 33-38).
EXTEND the fixture: add a SECOND root via an orphan branch so `--max-parents=0` returns >1 root
and is non-trivial (pinned in mktemp during planning: this yields exactly 2 roots). Orphan-root
incantation:
`git(dir,'checkout','-q','--orphan','root2')`, then clear the inherited index/worktree
(`git(dir,'rm','-q','-rf','.')` — the orphan checkout keeps the previous branch's files staged),
write a fresh file, `git(dir,'add','.')`, commit with a `dateEnv`, then `checkout main` and
`runGit(['-C', dir, 'merge', '-q', '--no-ff', '--allow-unrelated-histories', '-m', 'merge', 'root2'], { env: dateEnv(...) })`
— `--allow-unrelated-histories` is REQUIRED because the two roots share no ancestor (omitting it
makes git refuse the merge). Both roots are then reachable through the merge. Keep all dates strictly
increasing and causally ordered (the regime where `walkCommitsByDate` is byte-for-byte `--date-order`,
per the file's own header note).
git oracle: use **bare `git rev-list <flags>`** (one oid per line, newest first), NOT
`git rev-list --format=%H` — the `--format` variant prefixes each oid with a `commit <oid>` line
(pinned during planning), which would break `toEqual`. This matches how the existing `excluding`
case at line 156 uses `git rev-list HEAD~2..HEAD`. Map tsgit's `log({...})` `.id` sequence and
`toEqual` the git oid list. Pinned git facts (mktemp, git 2.54.0) to assert:
- `--max-parents=0` → all roots; `--min-parents=2` → merges only; `--max-parents=1` → all non-merges;
  `--min-parents=1` → all non-roots.
- **filter-then-limit**: `git rev-list --max-parents=1 -n 1 HEAD` ≡ `log({ maxParents: 1, limit: 1 })`
  → the newest NON-merge (filter applied before `-n`), NOT the merge, NOT empty.
- `--first-parent --min-parents=2` ≡ `log({ order: 'first-parent', minParents: 2 })` → the merge still
  counts as ≥2 parents even though the walk follows only the first parent.

### TDD steps

RED (production change A is real — these FAIL before the predicate exists; a fresh
`LogOptions` without `min/maxParents` will not even type-check the new option, so write the
`LogOptions` field additions first, then the failing assertions):

1. Unit `test/unit/application/commands/log.test.ts`, add under new describe blocks
   (`Given a diamond with a root, single-parent commits, and a merge`):
   - `When log runs with maxParents 0` / `Then only the root(s) are yielded` — `seedDiamond()`,
     `log(ctx, { maxParents: 0 })` → `['A']`. Expected failure before code: option ignored,
     returns all four.
   - `When log runs with minParents 2` / `Then only the merge is yielded` → `['D']`.
   - `When log runs with maxParents 1` / `Then all non-merges are yielded` → `['C','B','A']`.
   - `When log runs with minParents 1` / `Then all non-roots are yielded` → `['D','C','B']`.
   Mutation-resistant ISOLATED guards (the `>=`/`<=` relational operators and off-by-one
   boundaries are Conditional/Equality hot spots — assert exact membership, never a count):
   - `When log runs with minParents alone (maxParents undefined)` — isolates the `minParents`
     guard from the `maxParents` guard.
   - `When log runs with maxParents alone (minParents undefined)` — isolates the other guard.
   - `Given a commit with exactly minParents parents` / `Then it IS kept` — boundary
     `length === minParents` (e.g. `minParents: 2` keeps `D` which has exactly 2; build a
     1-parent commit too and assert it is dropped, killing `>=`→`>`).
   - `Given a commit with exactly maxParents parents` / `Then it IS kept` — boundary
     `length === maxParents` (killing `<=`→`<`).
   - `Given minParents 2 and maxParents 1 (min > max)` / `Then the result is empty` (ADR-400
     edge: no commit satisfies both).
   - `Given an octopus merge (3 parents)` / `When minParents 3` / `Then only the octopus is
     yielded` — build with `writeCommitAt(ctx, [b,c,e], 5000, 'O')`; asserts the numeric band
     does what a `roots` boolean could not (D3.A rationale).
   - `When neither minParents nor maxParents is set` / `Then the output is byte-identical to
     today` — regression guard; `seedDiamond()` → `['D','C','B','A']` (the default-undefined arm,
     killing a mutant that filters when the field is undefined).
   - `Given maxParents 1 and limit 1` / `Then the newest non-merge is yielded, not the merge
     and not empty` — **filter-then-limit** at the unit level (`seedDiamond()` → `['C']`, since
     `C` is newest by date among non-merges; the merge `D` is filtered before the limit counts).
   - Composition: `Given before and maxParents both set` and `Given excluding and minParents
     both set` — both upstream filters AND the parent-count predicate all apply before the
     limit break (use `seedTimestampChain()` / `seedDiamond()`).

2. Interop `test/integration/log-interop.test.ts`, extend `buildScenario()` to add the orphan
   second root + merge, then add cases (each: build scenario, compute git oracle via
   `git rev-list <flags>`, `logIds(dir, {...})`, `toEqual`):
   - `--max-parents=0` ≡ `{ maxParents: 0 }` (now non-trivial: >1 root).
   - `--min-parents=2` ≡ `{ minParents: 2 }`.
   - `--max-parents=1` ≡ `{ maxParents: 1 }`; `--min-parents=1` ≡ `{ minParents: 1 }`.
   - filter-then-limit: `git rev-list --max-parents=1 -n 1 HEAD` ≡ `{ maxParents: 1, limit: 1 }`.
   - `git rev-list --first-parent --min-parents=2 HEAD` ≡ `{ order: 'first-parent', minParents: 2 }`.

GREEN (minimal):

3. Add `minParents?`/`maxParents?` to `LogOptions`; insert the parent-count predicate as a
   `continue` guard at the `before`-filter point in `log` (before `out.push`), reading
   `value.data.parents.length`; leave the walk and the limit break otherwise untouched.

4. Add `type LogOrder` to the `log.js` barrel line in `src/application/commands/index.ts:143`.

REFACTOR:

5. If the guard exceeds a clean early-return, extract `withinParentBand(parents, opts)` (pure,
   named, no boolean param). Run `mcp__serena__get_diagnostics_for_file` on `log.ts` and
   `index.ts`. Then **pre-pay the prepush surface gate**: `npm run docs:json`, and stage the
   regenerated `reports/api.json` into this commit (verify with
   `git diff --no-ext-diff --stat -- reports/api.json` showing it changed).

### Gate

`npx vitest run test/unit/application/commands/log.test.ts test/integration/log-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/log.ts src/application/commands/index.ts test/unit/application/commands/log.test.ts test/integration/log-interop.test.ts`

(Surface gate `reports/api.json` is verified by staging the `docs:json` output in this commit;
it is enforced at prepush by `check:doc-typedoc`, outside the slice gate.)

### Commit

`feat(log): min/maxParents commit filter and LogOrder re-export`

---

## Slice 2 — type-change (`T`) gitlink domain guards + tree↔tree interop (pin-only)

### Context

**PIN-ONLY — no RED.** ADR-399: tsgit already emits `type-change` faithfully on every diff
surface. These tests characterize existing behaviour and go GREEN on first run. A failing
pin here = a real faithfulness defect to ESCALATE, not a TDD RED to satisfy.

**What is ALREADY covered (do NOT duplicate — verified):**
- `test/unit/domain/diff/tree-diff.test.ts`: file→symlink (`100644→120000`, lines 136-159) and
  file→gitlink (`100644→160000`, lines 161-184) — both assert `type: 'type-change'`.
- `test/unit/domain/diff/index-diff.test.ts`: file→symlink (`REGULAR→SYMLINK`, lines 175-198 and
  again 224-247) — asserts `type: 'type-change'`. **NO `GITLINK` anywhere in index-diff.test.ts.**

**The gap this slice closes (the ADR-399 mutation-resistant guard):**
- tree-diff: **symlink↔gitlink** (`120000⇄160000`) — missing.
- index-diff: **file↔gitlink** (`REGULAR⇄GITLINK`) and **symlink↔gitlink** — both missing.

**Domain symbols under test (NO source change):**
- `src/domain/diff/tree-diff.ts:24` `classifySamePath` — emits `type-change` when
  `!isSameKind(oldMode, newMode)`, else `modify`.
- `src/domain/diff/index-diff.ts:39` `classifyIndexVsTree` — same logic (note: index side is
  `new`, tree side is `old`; `oldMode = treeEntry.mode`, `newMode = indexEntry.mode`).
- `src/domain/diff/mode-kind.ts` `kindOf`/`isSameKind` — `file`(REGULAR|EXECUTABLE) | `symlink` |
  `directory` | `gitlink`. `FILE_MODE` (`src/domain/objects/file-mode.ts`): REGULAR `100644`,
  EXECUTABLE `100755`, SYMLINK `120000`, GITLINK `160000`, DIRECTORY `40000`.

**Unit test helpers to REUSE:**
- tree-diff.test.ts: `tree(entries)` (lines 12-18), `entry(name, mode, id)` (lines 20-22),
  `ID_A`/`ID_B`/`ID_C` (lines 8-10), `FILE_MODE` imported (line 5). Copy the existing
  file→gitlink describe block (lines 161-184) and adapt modes for symlink→gitlink and the
  reverse direction.
- index-diff.test.ts: `index(entries)` (helper), `flatTree(pairs)` (helper, `[path,id,mode][]`),
  `entry(path, id, mode, stage)`, `ID_A`/`ID_B`, `FILE_MODE` imported. Copy the file→symlink
  describe (lines 175-198) and adapt modes. Remember the index side is the NEW side: e.g.
  `index([entry('foo', ID_B, FILE_MODE.GITLINK, 0)])` vs `flatTree([['foo', ID_A, FILE_MODE.REGULAR]])`
  yields `oldMode: REGULAR, newMode: GITLINK`.

**Interop test file — NEW `test/integration/diff-type-change-interop.test.ts`** (ADR-399 D2.A:
dedicated file, one `*-interop.test.ts` per surface — the house pattern). Study
`test/integration/whatchanged-interop.test.ts` for the structure: `@proves` doc-comment header
(surface/bucket/unique/interopSurface), `SETUP_TIMEOUT = 60_000`, `ZERO_OID = '0'.repeat(40)`,
`IDENTITY`/`dateEnv`/`nonEmptyLines`, the `rawLine(c: DiffChange)` reconstructor (lines 55-70 —
note the `type-change` arm at line 64 already emits `:${oldMode} ${newMode} ${oldId} ${newId} T\t${path}`),
`gitRawLines(dir, oid)` via `git diff-tree -r --no-commit-id --abbrev=40` (line 74), and the
`beforeAll` build-via-git + `openRepository({ cwd: dir })` pattern.

Reconstruction helpers to REUSE/copy:
- `rawLine` and `gitRawLines` from `whatchanged-interop.test.ts` (the `T` arm already exists).
- `nameStatusFrom(treeDiff)` and `numstatRowsFrom(treeDiff)` from
  `test/integration/diff-whitespace-interop.test.ts:90-125` (the `T` arm returns `T\t${c.path}`
  at line 100; numstat omit rule at lines 117-125). Copy these into the new file (or a tiny
  shared helper if both files want them — but copying matches the house "single-purpose interop
  file" pattern; prefer copy).
- `reconstructPatch(ctx, treeDiff, opts?)` from `test/integration/diff-reconstruct.ts` — renders
  the unified patch via the same domain `renderPatch` the library uses; compare to
  `git diff --no-ext-diff --no-color HEAD~1 HEAD`.
- `interop-helpers.ts`: `GIT_AVAILABLE, git, runGit, runGitEnv`.

How to obtain tsgit's structured `TreeDiff` in interop: build the fixture with git, then
`repo = await openRepository({ cwd: dir })` and the diff command — match how
`diff-recursive-interop.test.ts:99` calls `await diff(ctx, { from, to, recursive: true })`
(import `diff` from `src/application/commands/diff.js`); for name-status/numstat reconstruction
use `withStat: true` (gives a `StatTreeDiff` with `added`/`deleted`/`binary` per change, the
shape `numstatRowsFrom` expects). For the raw-line / patch arm a plain `TreeDiff` (or the same
StatTreeDiff — `rawLine`/`nameStatusFrom` accept either) is fine.

**Exact git incantations for the fixtures (pinned in mktemp during planning, git 2.54.0).** All
under the isolated env via `runGit`/`dateEnv`. Build leaf-kind fixtures across two commits each:

- **file↔symlink** (`100644⇄120000`): write a regular file at path `x`, commit; then replace `x`
  with a symlink (`rm x; ln -s target x` on disk, then `git add x`), commit. Reverse direction:
  symlink first, then regular file. (This is the common, non-gitlink case; build it with real FS
  ops + `git add`, no `update-index` needed.)
- **file↔gitlink** (`100644⇄160000`) and **symlink↔gitlink** (`120000⇄160000`): a gitlink entry
  with NO real submodule is created via cacheinfo. Pinned recipe:
  ```
  // commit 1: a regular file (or symlink) at path x
  runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', '100644,<blobOid>,x'])  // or write+add
  commit
  // commit 2: flip the SAME path x to a gitlink
  runGit(['-C', dir, 'rm', '-q', '--cached', 'x'])
  runGit(['-C', dir, 'update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,x'])
  commit
  ```
  Pinned output of `git diff-tree -r --no-commit-id --abbrev=40 HEAD~1 HEAD` for the file→gitlink
  flip: `:100644 160000 <old40> 1111...1111 T\tx` and `git diff --no-ext-diff --name-status` →
  `T\tx`. The gitlink oid is an arbitrary 40-hex (the submodule need not exist). For symlink→gitlink,
  the symlink blob's content is the link target string (commit a symlink via `ln -s`/`git add`, then
  flip to cacheinfo `160000`).
- **Negative — leaf↔directory** (`x` blob → `x/` subtree): commit a blob at path `x`; in commit 2,
  delete `x` and add `x/inner` (a file inside a new dir `x`). Pinned (§2.3): this yields
  `D x` + `A x/inner` (recursive), NEVER `T` — git's tree-entry ordering sorts the directory as
  `x/`, so blob-`x` and tree-`x` are distinct keys. Assert tsgit's `TreeDiff.changes` contains a
  `delete` (oldPath `x`) and an `add` (newPath `x/inner`), and NO `type-change`.

### TDD steps

NO RED (pin-only). Write each test, run it, expect GREEN on first run. If any pins RED, STOP and
escalate as a faithfulness defect.

1. Unit `test/unit/domain/diff/tree-diff.test.ts` — add describe blocks:
   - `Given same path with symlink → gitlink` / `When diffTrees called` / `Then returns
     [TypeChangeChange]` — `oldMode: SYMLINK, newMode: GITLINK`, asserting `type: 'type-change'`
     (kills a `!isSameKind` → `isSameKind` mutant that would emit `modify` for this pair).
   - `Given same path with gitlink → symlink` (reverse direction) / `Then [TypeChangeChange]`.

2. Unit `test/unit/domain/diff/index-diff.test.ts` — add describe blocks (index = new side):
   - `Given same path file → gitlink (different kind)` / `When diffIndexAgainstTree called` /
     `Then TypeChangeChange` — tree `REGULAR`, index `GITLINK`.
   - `Given same path symlink → gitlink (different kind)` / `Then TypeChangeChange` — tree
     `SYMLINK`, index `GITLINK`.
   (Both isolate the `classifyIndexVsTree` gitlink arm — the cheap mutation-resistant guard
   ADR-399 names. Assert the full change object: `type`, `path`, `oldId`, `newId`, `oldMode`,
   `newMode`, matching the file's existing `toEqual([{...}])` idiom.)

3. Interop NEW `test/integration/diff-type-change-interop.test.ts` — `describe.skipIf(!GIT_AVAILABLE)`,
   shared `beforeAll` repo (build ALL fixtures at distinct paths/commits in one repo to share the
   60s setup), `openRepository`. For each of the three leaf-kind pairs, BOTH directions:
   - assert tsgit's structured change is `type-change` with the correct `oldMode`/`newMode`/oids;
   - reconstruct git's `--raw` `T` line (`rawLine`) and assert it equals `gitRawLines(dir, oid)`;
   - assert `nameStatusFrom(treeDiff)` equals `git diff --no-ext-diff --name-status HEAD~1 HEAD`;
   - assert `reconstructPatch(ctx, treeDiff)` equals `git diff --no-ext-diff --no-color HEAD~1 HEAD`.
   Then the **negative pin**: leaf↔directory yields `delete`+`add` (no `type-change`), matching
   `git diff --no-ext-diff --name-status` (`D x` / `A x/inner`) and `--raw`.

### Gate

`npx vitest run test/unit/domain/diff/tree-diff.test.ts test/unit/domain/diff/index-diff.test.ts test/integration/diff-type-change-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/unit/domain/diff/tree-diff.test.ts test/unit/domain/diff/index-diff.test.ts test/integration/diff-type-change-interop.test.ts`

### Commit

`test(diff): pin type-change for all leaf-kind pairs and the directory negative`

---

## Slice 3 — LFS pointer diff interop (pin-only)

### Context

**PIN-ONLY — no RED.** ADR-398: tsgit has NO filter/clean-smudge/textconv port, so it diffs a
git-lfs pointer blob exactly as its on-disk text bytes — which is precisely what filter-less git
does. There is ZERO LFS code in `src/`. This slice pins "tsgit ≡ filter-less git over pointer
text" and goes GREEN on first run. A failing pin = a real faithfulness defect to ESCALATE.

**Interop test file — NEW `test/integration/lfs-pointer-interop.test.ts`.** Mirror the isolation
and structure of `test/integration/diff-recursive-interop.test.ts` / the whatchanged interop:
`@proves` header (surface: `diff`, bucket: `cross-tool-interop`, unique: LFS pointer text diff
matches filter-less git), `describe.skipIf(!GIT_AVAILABLE)`, ONE shared `beforeAll` repo,
`SETUP_TIMEOUT = 60_000`, build-via-git + `openRepository({ cwd: dir })`.

**Isolation is load-bearing for THIS slice specifically.** The whole point (ADR-398, §1.3/§1.7)
is that NO git-lfs driver engages. The shared `interop-helpers.ts` already provides exactly that:
`runGit` scrubs `GIT_*`, sets `HOME` to a non-existent tmp path, `GIT_CONFIG_NOSYSTEM=1`,
`XDG_CONFIG_HOME` under that HOME — so a developer's global `filter.lfs.*` / `diff.lfs.*` config
and any installed git-lfs are invisible to the spawned git. Use ONLY `runGit`/`git`/`runGitEnv`
from that file; do NOT add any `git lfs` invocation. Signing off (the helpers never set signing).

**Hand-author the pointer blob** (never recalled from memory — it is a literal 3-line UTF-8 text
blob committed as ordinary content):
```
version https://git-lfs.github.com/spec/v1
oid sha256:<64-hex>
size <bytes>
```
Write it to a path (e.g. `data.bin`) via `writeFile` + `git add` + commit. Use a fixed, arbitrary
64-hex oid and an arbitrary size for v1; for the "modify" case bump BOTH the oid (different 64-hex)
and the size to a second pointer.

**Reconstruction helpers to REUSE:**
- `reconstructPatch(ctx, treeDiff, opts?)` from `test/integration/diff-reconstruct.ts` (compare to
  `git diff --no-ext-diff --no-color HEAD~1 HEAD`).
- `nameStatusFrom` / `numstatRowsFrom` from `diff-whitespace-interop.test.ts:90-125` (copy into the
  new file; the pointer cases use the `add` arm `A\t${newPath}` and `modify` arm `M\t${path}`, and
  numstat counts the 3 pointer lines).
- `diff` from `src/application/commands/diff.js`, called as `await diff(ctx, { from, to, withStat: true })`
  (commit-to-commit, matching the consumer's pattern; no empty-tree/recursive needed — single top-level
  file). The diamond/recursive flags are irrelevant here.
- `interop-helpers.ts`: `GIT_AVAILABLE, git, runGit, runGitEnv`, `IDENTITY`/`dateEnv` idiom from the
  log/whatchanged interop.

**The matrix to pin (ADR-398 D1.A — full matrix, all under the no-filter baseline):**
1. **pointer add** — commit an unrelated file (commit 1), then commit the v1 pointer blob at
   `data.bin` (commit 2), with NO `.gitattributes diff=lfs` line. Assert: tsgit's
   `diff(from='HEAD~1', to='HEAD')` change for `data.bin` is `add`; `nameStatusFrom` → `A\tdata.bin`;
   `numstatRowsFrom` → `3\t0\tdata.bin` (3 added pointer lines); `reconstructPatch` equals live
   `git diff --no-ext-diff --no-color HEAD~1 HEAD`.
2. **pointer modify** — bump oid+size to a v2 pointer (commit 3 over commit 2). Change is `modify`;
   name-status `M\tdata.bin`; numstat counts + `reconstructPatch` equal live git.
3. **pointer → real file** — replace the pointer blob with real bytes (e.g. `real binary-ish content\n`),
   still no filter (commit 4). Change is `modify` whose new side is the real content; counts + patch
   equal live git.
4. **`.gitattributes diff=lfs` declared but inert (non-interference)** — commit a `.gitattributes`
   line `*.bin filter=lfs diff=lfs -text` alongside a pointer at a `.bin` path, with NO git-lfs driver
   installed in the isolated HOME. Pinned (§1.4): git falls back to the built-in text diff (the named
   driver is absent), so it STILL shows the pointer text; tsgit matches. Assert name-status/numstat/patch
   parity exactly as the add case — this is the realistic CI/consumer boundary and the explicit
   "filter declared but inert" faithfulness pin.

All four reconstruct git's `--name-status`/`--numstat`/patch from tsgit's structured `TreeDiff`/`StatTreeDiff`
and compare to live git in the isolated env — the library emits no rendered line; faithfulness is
reconstructed from the fields (ADR-249).

### TDD steps

NO RED (pin-only). Write each pin, run it, expect GREEN on first run. If any pins RED, STOP and
escalate as a faithfulness defect (not a TDD RED).

1. Create `test/integration/lfs-pointer-interop.test.ts` with the `@proves` header,
   `describe.skipIf(!GIT_AVAILABLE)`, shared `beforeAll` building one repo whose commits stack the
   four matrix steps at distinct paths/commits (so one 60s setup covers all), and `openRepository`.
2. Copy `nameStatusFrom`/`numstatRowsFrom` and a v1/v2 pointer-blob constant builder into the file.
3. Add the four cases (add / modify / pointer→real / declared-but-inert), each asserting
   name-status + numstat + `reconstructPatch` parity against live `git diff --no-ext-diff` in the
   isolated env.
4. No `src/` change. Run `mcp__serena__get_diagnostics_for_file` on the new test file; ground truth
   is the gate.

### Gate

`npx vitest run test/integration/lfs-pointer-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/lfs-pointer-interop.test.ts`

### Commit

`test(diff): pin git-lfs pointer diff against filter-less git baseline`
