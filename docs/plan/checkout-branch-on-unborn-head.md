# Plan — checkout-branch-on-unborn-head

> Source: design doc `docs/design/checkout-branch-on-unborn-head.md` · ADRs 1197, 1198, 1199, 1200, 1201, 1202, 1203
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

## Plan-wide notes (every part reads this)

**Rulings this plan is written against.** D1 (ADR-1197): `CheckoutSwitchOptions.rev` becomes
optional, an omitted `rev` means `HEAD`, the "neither rev nor paths" refusal goes, the `rev` +
`paths` refusal keeps its code and reason. D2 (ADR-1198): an unborn HEAD with `rev` omitted and no
`createBranch` refuses `NO_INITIAL_COMMIT` (existing factory `noInitialCommit()` in
src/domain/commands/error.ts, data `{ code: 'NO_INITIAL_COMMIT' }`) before any index read or ref
write. D3 (ADR-1199): every commit is `fix(<scope>): …`, never `fix!` or `feat`. D4 (ADR-1200): a
checkout that leaves HEAD unborn returns `id: zeroOid(ctx.hashConfig)`. D5 (ADR-1201), D6
(ADR-1202), D7 (ADR-1203): the two-way carry in materialize-tree.ts yields to a written target path
it collides with as file/directory; the forward direction (staged file `p`, target writes `p/…`)
follows `core.ignoreCase` + the cached-stat match; the reverse direction (staged `p/…`, target
writes file `p`) judges the staged entries as deletions whatever the setting.

**Order and why seven parts.** The materialize-tree fix is a shared primitive used by the checkout
switch and merge's fast-forward/squash; it lands first and independently (Parts 1–2: forward
direction with the merge pins, then the reverse direction with the checkout pins). Then checkout:
Part 3 lets a switch run from an unborn HEAD (R2, R3), Part 4 makes `rev` optional and adds the
no-start-point branch creation (R1, R4). Parts 5 and 6 are cross-tool interop harness suites with
no `src/` delta (axes 1/2/4, then axes 3 and 6-unborn). Part 7 is docs. Parts are sequential on one
working tree; each starts from the previous commit. materialize-tree.ts and its unit test recur in
Parts 1–2, checkout.ts and checkout.test.ts in Parts 3–4, on purpose: merging them would exceed
the 6-file / 5-cycle ceiling.

**Public-surface decision: nothing new is public.** Every new symbol is module-private (not
exported): in materialize-tree.ts `Displaced`, `CarrySplit`, `keysOf`, `obstructionMayGo`,
`clearedObstructions`, `displacedByTarget`, `carriedOptsOf`; in checkout.ts `TargetedSwitch`,
`switchToCommit`, `switchUnbornToNewBranch`. No error code is added (D2 reuses
`NO_INITIAL_COMMIT`, already in the union, exhaustiveness switches and errors docs). The one public
change is a widening: `CheckoutSwitchOptions.rev` goes from required to optional. That changes
`reports/api.json` (a **prepush** gate, `check:doc-typedoc`, not a validate gate) — regenerated in
Part 7 with `npm run docs:json` and committed. No barrel, facade (`Repository.checkout` binds
`commands.checkout` by type), `docs/use/commands/README.md`, browser-surface scenario or README
command count changes. If an implementer finds an export is needed after all, that is a blocker:
report `{ unit, reason, options }`, do not add it silently.

**Implementers have NO MCP tools** (no serena, no graft). Use `Read` with the line anchors
given, `command grep -n` (never bare `grep`: the rtk hook truncates at ~25 hits), and `Edit`.
Anchors are point-in-time for commit 339d4cbd; earlier parts shift them — re-anchor by symbol
name with `command grep -n "<symbol>" <file>`.

**Test conventions (every part).** `describe('Given …')` > `describe('When …')` >
`it('Then …')`; the 2-level `describe('Given …, When …')` > `it('Then …')` only when one
expectation lives under the When. AAA section comments (`// Arrange`, `// Act`, `// Assert`).
`sut` is the FUNCTION under test (`const sut = checkout;` then `await sut(ctx, …)`); never bind a
result to `sut` (the test-pyramid gate `sutBindsResult` fails on it). Assert errors on their full
data (`expect(data).toEqual(<factory>(…).data)` or a literal object) via try/catch or the file's
`refusalOf`/`refusal` helper; never `toThrow(Class)` alone. One guard test per condition. 100%
coverage (lines, branches, functions, statements). No suppression directive of any kind. No
provenance refs (ADR, backlog, design-row, part numbers) in source, test titles or comments; row
ids such as `A4` may appear only as an `id` data field in an `it.each` table. Set
`core.ignorecase` explicitly in every fixture that exercises the file/directory carry — unit
tests through `updateConfigEntries(ctx, [{ section: 'core', key: 'ignorecase', value }])`
(src/application/primitives/update-config.ts) or the raw config write named in the part; interop
tests through `git -C <twin> config core.ignorecase <false|true>` in BOTH twins — never rely on the
platform's `git init` default (macOS writes `true`, Linux nothing).

**TDD discipline.** Write each RED and run it before writing the code that satisfies it.
Record the failing reason you saw and check it matches the reason this plan predicts. A GUARD
must pass when written; a red GUARD is a RED the plan mis-classified: stop, note it in the
hand-off, and make it green with this part's GREEN only — never widen scope.

**Matrix rows, not summaries.** Each part names the design rows (U*, S*, F*, G*, H*, A*, V*, M*)
it turns green (RED) or re-pins (GUARD). An interop twin is self-pinning: git runs the same verb
in its twin, so never hard-code a result git can produce live; rebuild git's message from tsgit's
structured fields (ADR-249), never ask tsgit for display text.

**Gate command notes.** Run tests with `./node_modules/.bin/vitest run <files>` (the rtk hook
rewrites some `npx vitest` calls into a full-suite run). `rm -rf .wireit` before trusting
`npm run check:types` / `npm run check:spelling` (wireit caches a stale green); the oracle is
`npx tsc --noEmit -p tsconfig.json`. Write long output to a scratchpad file and read back only
the failing lines. State-mutating probes run in a `mktemp -d` throwaway, never in the worktree.
Never commit on a red gate; never `--no-verify`. Commit subjects are lowercase conventional
commits ≤ 100 chars (commitlint). Commit with `git commit -m "<subject>"` (one line, no body).

**Interop harness facts (Parts 1, 2, 5, 6).** Helpers in test/integration/interop-helpers.ts:
`GIT_AVAILABLE`, `runGit(args, { env? })` (scrubbed env: every inherited `GIT_*` dropped,
isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, a global config holding only an identity — so no
signing), `runGitEnv()`, `git(dir, ...args)`, `tryRunGit(args)` (`{ ok, … }`),
`tryRunGitWithExit(args)` (`{ stdout, stderr, exitCode }`), `makePeerPair(slug)`
(`{ peer, ours, dispose }`), `initBothRepos(peer, ours, branch = 'main')` (git init + user
identity), `lsStage(dir)` (`ls-files --stage`), `disableAutoMaintenance(dir)`. tsgit runs through
`openRepository({ cwd })` from src/index.node.ts (discovers a linked worktree's `.git` file; always
`await repo.dispose()` in a `finally`) or `createNodeContext({ workDir })` from
src/adapters/node/node-adapter.ts plus the command function. Open the repository AFTER the row
writes its config, so the session config cache never serves a stale `core.ignorecase`. git's
checkout refusals exit 1; `fatal:` refusals exit 128. Message reconstructions from tsgit fields:

| tsgit data | git stderr line(s) to `toContain` |
|---|---|
| `CHECKOUT_OVERWRITE_DIRTY.localChanges` | `Your local changes to the following files would be overwritten by checkout:` then `\t<path>` per path |
| `CHECKOUT_OVERWRITE_DIRTY.untracked` (file occupant) | `The following untracked working tree files would be overwritten by checkout:` then `\t<path>` |
| `CHECKOUT_OVERWRITE_DIRTY.untracked` (directory holding untracked files, row V2) | `Updating the following directories would lose untracked files in them:` then `\t<path>` (same mapping test/integration/rebase-interop.test.ts uses near its `gitClass: /would lose untracked files/` row) |
| `WORKING_TREE_DIRTY.untracked` | `The following untracked working tree files would be overwritten by merge:` then `\t<path>` |
| `CHECKOUT_START_POINT_NOT_COMMIT { revision, branch }` | `fatal: '<revision>' is not a commit and a branch '<branch>' cannot be created from it` |
| `PATHSPEC_NO_MATCH { pattern }` | `error: pathspec '<pattern>' did not match any file(s) known to git` |
| `NO_INITIAL_COMMIT` | `fatal: You are on a branch yet to be born` |
| `INVALID_OPTION { option: 'createBranch' }` | `fatal: '--detach' cannot be used with '-b/-B/--orphan'` |
| `BRANCH_EXISTS { name }` | `fatal: a branch named '<name without refs/heads/>' already exists` |
| `INVALID_REF` | `fatal: '<name>' is not a valid branch name` (read the factory in src/domain/refs/error.ts for the field holding the name) |
| `REF_LOCKED { name: 'HEAD' }` | `cannot lock ref 'HEAD'` (git exits 255 there) |

## Part 1 — the carry drops a staged file the target needs as a directory

### Context

Rows turned green (RED): **A4, A5** (unit), **M2** (unit + interop), **M4** (interop).
GUARD: **A3, A6, A11** (unit), **M1** (unit + interop), **M3** (interop). Requirement R7(a) and
R7(c). The reverse direction (R7(b), V rows) is Part 2 — do not add `beneath` here.

Files this part edits:
- `src/application/primitives/materialize-tree.ts`
- `test/unit/application/primitives/materialize-tree.test.ts`
- `test/unit/application/commands/merge.test.ts`
- `test/integration/merge-interop.test.ts`

Current code (materialize-tree.ts, anchors at 339d4cbd):
- imports lines 28–75. `leadingDirectoriesOf(path: string): string[]` lines 175–181 (reused).
- `interface CarriedOpts { opts; allTarget; carried }` lines 403–408.
- `sparseMovers(sparse, index): Set<IndexPathKey>` lines 414–422 (untouched).
- `agreementWithHead(ctx, opts & { headTree }, allTarget, stageZero): Promise<HeadAgreement>`
  lines 430–452 (untouched). `agreed(key)` is true where HEAD and target agree, both-absent
  included, and for every key below a shared directory.
- `carryHeadAgreement(ctx, opts, allTarget): Promise<CarriedOpts>` lines 455–485 — today
  `isKept = agreed(key) && !movers.has(key)`; every kept stage-0 entry leaves
  `opts.currentIndex` and is re-appended by `assembleIndexEntries`; nothing compares it to the
  paths the switch writes. Already over 20 lines: split off the `CarriedOpts` assembly.
- `stagedOutsideTarget(stageZero, allTarget, agreed, movers)` lines 488–499 (untouched).
- Consumers: checkout.ts `materializeSwitch` (via `switchMaterializeOpts` → `headTreeOption`);
  merge.ts `attemptNonConflictTree` lines ~1201–1230 (passes `headTree`, maps
  `CHECKOUT_OVERWRITE_DIRTY` to `{ kind: 'refused', localChanges, untracked }`, then
  `refusalAsError` raises `WORKING_TREE_DIRTY`). No change in either consumer.

Helpers to import into materialize-tree.ts (all internal, all existing):
- `joinPath(workDir, path)` from ./internal/join-working-tree-path.js.
- `lstatIfReachable(fs, path): Promise<FileStat | undefined>` from ./internal/fs-probes.js
  (undefined when absent or beneath a file).
- `matchesCachedStat({ entry, indexMtime }, absPath, stat, contentMatches): Promise<boolean>`
  from ./internal/is-entry-stat-clean.js (`CachedStat.indexMtime: IndexMtime | undefined`;
  a mode or stat mismatch is `false`, a directory at the path is a mode mismatch; a racy or
  `indexMtime`-less entry is decided by content).
- `racyContentMatcher(ctx): RacyContentCheck` from ./compare-working-tree-entry.js (build ONE
  per call of `clearedObstructions`; occupant-clash.ts imports the same, so no new cycle).
- `lazily(build)` from ./internal/lazily.js.
- `readConfig(ctx)` from ./config-read.js; `(await readConfig(ctx)).core?.ignoreCase === true`
  is the house form (alternate-chain.ts:249, gc-pipeline.ts:1423).
- `requireWorkTree(ctx, 'materializeTree')` is already imported.

GREEN shape (module-private; names fixed by this plan — the design spells the first field with a
word cspell rejects in identifiers, so it is `deletions` here):

```ts
/** Kept entries a written target path displaces. */
interface Displaced {
  /** Leave the carry and meet the one-way diff as deletions: dirty-checked, then removed. */
  readonly deletions: ReadonlySet<IndexPathKey>;
  /** Leave the carry and the diff: an added path meets the file as a leading obstruction. */
  readonly dropped: ReadonlySet<IndexPathKey>;
}

const keysOf = (entries: ReadonlyArray<IndexEntry>): Set<IndexPathKey> =>
  new Set(entries.map(indexPathKey));

/** git's icase_exists: a stat-clean tracked file in an added path's way may be replaced. */
const obstructionMayGo = async (ctx, index: GitIndex, entry: IndexEntry, contentMatches): Promise<boolean> => {
  const absPath = joinPath(requireWorkTree(ctx, 'materializeTree'), escapedPathOf(entry));
  const stat = await lstatIfReachable(ctx.fs, absPath);
  if (stat === undefined) return false;
  return matchesCachedStat({ entry, indexMtime: index.indexMtime }, absPath, stat, contentMatches);
};

/** The colliders git may remove: none unless core.ignoreCase; the config is read only when one exists. */
const clearedObstructions = async (ctx, index, over: ReadonlyArray<IndexEntry>): Promise<IndexEntry[]> => {
  const ignoreCase = lazily(async () => (await readConfig(ctx)).core?.ignoreCase === true);
  const contentMatches = racyContentMatcher(ctx);
  const going: IndexEntry[] = [];
  for (const entry of over) {
    if ((await ignoreCase()) && (await obstructionMayGo(ctx, index, entry, contentMatches))) going.push(entry);
  }
  return going;
};

const displacedByTarget = async (ctx, index, kept, written: ReadonlyArray<TargetEntry>): Promise<Displaced> => {
  const dirs = new Set<string>(written.flatMap((t) => leadingDirectoriesOf(t.path)));
  const over = kept.filter((e) => dirs.has(escapedPathOf(e)));
  const going = await clearedObstructions(ctx, index, over);
  return { deletions: keysOf(going), dropped: keysOf(over.filter((e) => !going.includes(e))) };
};
```

In `carryHeadAgreement`, after `movers`:

```ts
const agreedKept = (key: IndexPathKey): boolean => agreed(key) && !movers.has(key);
const displaced = await displacedByTarget(
  ctx,
  opts.currentIndex,
  stageZero.filter((e) => agreedKept(indexPathKey(e))),
  allTarget.filter((e) => !agreedKept(indexPathKey(e))), // the written paths: an agreed path displaces nothing
);
const isKept = (key: IndexPathKey): boolean =>
  agreedKept(key) && !displaced.deletions.has(key) && !displaced.dropped.has(key);
return carriedOptsOf(opts, allTarget, {
  stageZero, isKept, dropped: displaced.dropped,
  outsideTarget: stagedOutsideTarget(stageZero, allTarget, agreed, movers),
});
```

and the extracted assembly (`CarrySplit` = `{ stageZero; isKept; dropped; outsideTarget }`):
`carried = new Set(stageZero.filter((e) => isKept(indexPathKey(e))))`;
`opts.currentIndex.entries` filtered by `!carried.has(e) && !dropped.has(indexPathKey(e))`;
`allTarget` = `[...allTarget.filter((e) => !isKept(indexPathKey(e))), ...outsideTarget]`;
`carried: [...carried]`. A collider never has a target twin (the target cannot hold both `p`
and `p/…`), so the `allTarget` filter is unchanged in effect. No `over.length === 0` guard (it
would be an equivalent mutant; the lazy read already costs nothing for an empty `over`). No
change to two-way-carry.ts, occupant-clash.ts or apply-changeset.ts: the verdicts come from
the existing pre-flight once the collider is routed (deletions → a delete in the one-way diff,
`scope.removed` clears the leading obstruction; dropped → `classifyLeadingObstruction` names
a file standing at `p` `untracked`, nothing when no file stands there).

Unit fixture (materialize-tree.test.ts, inside `describe('materializeTree carrying staged
changes (headTree)')` lines 1460–1903; its helpers `flatTree` 1463, `writeWork` 1472,
`readWork` 1476, `indexOf` 1505, `refusalOf` 1510 are scoped to that describe; append new
describes just before its closing `});` at ~1902). File-level helpers: `writeBlob`,
`makeIndexEntry` (zero stats, so never stat-clean), `EMPTY_INDEX`, `indexEntryFromStat` import
(line 2), `treeEntry`, `FILE_MODE`, `writeTree`, `buildSeededContext` (./fixtures.js). Build:
- head = `flatTree(ctx, { f: blobs.f })`; target = `writeTree(ctx, [treeEntry(REGULAR, 'f', blobs.f),
  treeEntry(DIRECTORY, 'd', await writeTree(ctx, [treeEntry(REGULAR, 'x', blobs.x)]))])`;
  work file `f` = blob content.
- staged `d`: `writeWork(ctx, 'd', 's')`, blob `s`, entry
  `indexEntryFromStat(await ctx.fs.lstat(<workDir>/d), FILE_MODE.REGULAR, blobs.s, 'd' as FilePath)`
  — stat-clean, so only the `core.ignorecase` gate decides. Index = `indexOf([makeIndexEntry('f', blobs.f), dEntry])`
  (no `indexMtime` → the match is decided by content, as racy).
- config: `ctx.fs.writeUtf8(<gitDir>/config, '[core]\n\tignorecase = true\n')`
  (the pattern of the filter rows near line 1090); "unset" writes no config; "false" writes
  `ignorecase = false`.

Unit rows in merge.test.ts: inside `describe('merge — the index before the strategy runs')`
(line ~6435), beside `Given a change staged on a path the fast-forward leaves alone` (~6436),
same seed style: `createMemoryContext()`, `init`, write `f`, `add`, `commit`, `branchCreate`
`tgt`, `checkout { rev: 'tgt' }`, write `dir/x`, `add`, `commit`, `checkout { rev: 'main' }`,
write file `dir` = `s`, `add(ctx, ['dir'])`. `mergeRun` (imported from merge.js), `readIndex`,
`resolveRef` are already imported; add `updateConfigEntries` from
src/application/primitives/update-config.ts. `author` is the file's identity constant.

Interop rows in merge-interop.test.ts: inside `describe.skipIf(!GIT_AVAILABLE)('merge interop —
non-conflict materialisation')`, beside `Given a change staged on a path the fast-forward leaves
alone` (~line 162). Its helpers: `writeBoth`, `commitBoth`, `branchBoth`, `checkoutBoth`,
`snapshot` (`{ head, stage }`), `readMaybe`, `pathExists`; `pair.peer` is git, `pair.ours` is
tsgit via `repo` (`openRepository` in `beforeEach`, `repo.init()` — tsgit's init writes no
`core.ignorecase`, git's on macOS writes `true`, so set it in both). Add `mkdir` to the
`node:fs/promises` import. `AUTHOR`, `COMMIT_ENV` exist.

### TDD steps

1. **GUARD (unit, A3): `Given a staged file d neither head nor target has, and a target writing d/x`
   > `When ignorecase is <unset|false>` (`it.each`) > `Then it refuses d as an untracked occupant`.**
   Data `{ code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: [], untracked: ['d'] }`; disk `d`
   still `s`. Passes today (the carried `d` meets `d/x` as a leading obstruction). Kills the
   mutant that drops the `ignoreCase` check (the entry is stat-clean).
2. **RED (unit, A4): same Given > `When ignorecase is true and d is unchanged since staging` >
   `Then d leaves the index and d/x is written`.** `newIndexEntries.map((e) => e.path)` equals
   `['d/x', 'f']`; `(await ctx.fs.lstat(<workDir>/d)).isDirectory` true; `readWork(ctx, 'd/x')`
   is `x`. Expected failure: refuses `untracked: ['d']`.
3. **GUARD (unit, A6): same Given > `When ignorecase is true and d was modified after staging` >
   `Then it refuses d as untracked, not as a local change`.** After building the stat-clean entry,
   `writeWork(ctx, 'd', 'modified')` (different size). Data as step 1. Passes today. Kills the
   mutant that routes every forward collider to the diff (it would say `localChanges: ['d']`)
   and the stat-match mutant.
4. **RED (unit, A5): same Given > `When d is absent from disk` (`it.each` over unset / true) >
   `Then d/x is written and the index holds no d`.** `ctx.fs.rm(<workDir>/d)` after staging.
   Paths `['d/x', 'f']`; also assert `result.written` and `result.deleted` exactly (record the
   values the GREEN gives; they distinguish "dropped" from "deletions" for the missing-file
   `false`). Expected failure: the index holds `['d', 'd/x', 'f']`.
5. **GUARD (unit, A11): `Given head and target agree on d/x and the index stages file d in its
   place` (`it.each` unset / true) > `Then d is kept and no refusal`.** head = f + d/x, target =
   f + d/x + `g`; index = f + stat-clean file `d` (no `d/x`); disk `f`, file `d`. Paths
   `['d', 'f', 'g']`, `d` still a file with `s`. Passes today. Kills the mutant that computes
   collisions against the whole target.
6. **RED (unit, M2) + GUARD (unit, M1) in merge.test.ts: `Given a file dir staged on main where
   the fast-forward target holds dir/x`** > `When ignorecase is true and merge fast-forwards` >
   `Then the merge fast-forwards, dir leaves the index and dir/x is written`
   (`result.kind === 'fast-forward'`, index paths `['dir/x', 'f']`, `dir` a directory) — expected
   failure `WORKING_TREE_DIRTY { localChanges: [], untracked: ['dir'] }`; and `When ignorecase is
   unset` > `Then it refuses dir as untracked and HEAD stays` (data
   `{ code: 'WORKING_TREE_DIRTY', localChanges: [], untracked: ['dir'] }`, `resolveRef(HEAD)`
   unchanged) — GUARD.
7. **RED (interop, M2/M4 under `true`) + GUARD (M1/M3 under `false`): `Given a file dir staged
   on main where tgt holds dir/x`** (`describe.each` over `['false', 'true']`, set with
   `runGit(['-C', dir, 'config', 'core.ignorecase', v])` in `pair.peer` and `pair.ours`) >
   `When both tools fast-forward` (git `tryRunGitWithExit(['-C', pair.peer, 'merge',
   '--ff-only', '-q', 'tgt'])`, tsgit `repo.merge.run({ rev: 'tgt', author: AUTHOR })`) and
   `When both tools squash` (git `merge --squash -q tgt` with `{ env: COMMIT_ENV }`, tsgit
   `repo.merge.run({ rev: 'tgt', squash: true, author: AUTHOR })`). Add `tryRunGitWithExit` to
   the helper import. Assert: git exit 0 ⇔ tsgit resolved; on success `snapshot` equal,
   `status --porcelain --untracked-files=all` equal, `dir` a directory in both; on refusal git
   stderr contains the merge-untracked header and `\tdir`, tsgit data `{ code:
   'WORKING_TREE_DIRTY', localChanges: [], untracked: ['dir'] }`, `lsStage` and the file at `dir`
   equal. Expected failure (`true` arms): tsgit refuses `untracked: ['dir']` where git exits 0.
8. **GREEN.** Implement the GREEN shape in materialize-tree.ts. Run steps 1–7: all green.
9. **REFACTOR.** Every new function ≤ 20 lines, nesting ≤ 2; doc comments say why. Confirm with
   `command grep -n "readConfig\|lazily" src/application/primitives/materialize-tree.ts` that
   the config read sits only inside `clearedObstructions`.

### Gate

```bash
./node_modules/.bin/vitest run test/unit/application/primitives/materialize-tree.test.ts test/unit/application/primitives/materialize-tree-pruning.test.ts test/unit/application/primitives/internal/two-way-carry.test.ts test/unit/application/commands/merge.test.ts test/integration/merge-interop.test.ts test/integration/checkout-file-directory-swap-interop.test.ts \
  && rm -rf .wireit && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/materialize-tree.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/commands/merge.test.ts test/integration/merge-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(checkout): let a switch or fast-forward replace a staged file the target makes a directory`

## Part 2 — the carry judges a staged directory the target makes a file as deletions

### Context

Rows turned green (RED): **V1, V3** (unit + interop). GUARD: **V2** (unit + interop), and the
born checkout pins **A3/A4, A5, A6, A7, A8, A9, A10, A11** (interop; fixed or already matching
after Part 1). Requirement R7(b) and the checkout consumer pin of R7 (DOCTRINE D-2).

Files this part edits:
- `src/application/primitives/materialize-tree.ts`
- `test/unit/application/primitives/materialize-tree.test.ts`
- `test/integration/checkout-file-directory-swap-interop.test.ts`

Code change: in `displacedByTarget` (added by Part 1) add the reverse partition:

```ts
const files = new Set<string>(written.map((t) => t.path));
const beneath = kept.filter((e) => leadingDirectoriesOf(escapedPathOf(e)).some((d) => files.has(d)));
// …
return { deletions: keysOf([...beneath, ...going]), dropped: keysOf(over.filter((e) => !going.includes(e))) };
```

Update `Displaced` / `displacedByTarget` doc comments to cover both directions. Nothing else
moves: a `p/…` in `deletions` stays in the diff's index as a delete (its own dirty check gives
`localChanges: ['p/…']` when modified), and the added file `p` meets `holdsSurvivor` for an
untracked file under `p` (`untracked: ['p']`).

Unit fixture (same describe as Part 1): head = `f`; target = `f` + FILE `d` (blob `D`); index =
`f` + stat-clean `d/x` (blob `s`, work file `d/x` = `s`, built with `indexEntryFromStat` from
`lstat`); no `core.ignorecase` (it plays no part; add one row under `true` only if a mutant
needs it).

Interop fixture (checkout-file-directory-swap-interop.test.ts; existing suite at lines 51+
uses `makePeerPair`, `initBothRepos`, its own `buildHistory`, `git`, `lsStage`, `tryRunGit`,
`openRepository`). Add a NEW top-level `describe.skipIf(!GIT_AVAILABLE)('checkout interop — a
staged path the target needs for a file or a directory', { timeout: 60_000 }, …)` with its own
`beforeEach` building, in both twins with git: `main` = `f`; `tgt` = main + `dir/x`; `tgt3` =
tgt + `g`; `hf` = main + FILE `dir` (`D\n`); back on `main`. Each row: `describe.each(['false',
'true'])`, `git(<twin>, 'config', 'core.ignorecase', v)` in both twins, the row's staging done by
git in BOTH twins, then git `tryRunGitWithExit(['-C', peer, 'checkout', …])` (add
`tryRunGitWithExit` to the import) and tsgit `repo.checkout(…)` with `repo = await
openRepository({ cwd: pair.ours })` opened after the config write and disposed in `finally`.
Compare `lsStage`, `git status --porcelain --untracked-files=all`, `git symbolic-ref -q HEAD`
and the disk shape at `dir` (file content via `readFileSync`, or `readdirSync` listing when a
directory, or absent). Never compare commit oids (twins' commits differ in time).

Row setups (both twins, by git):

| id | Start | Staging | tsgit call | Expected (both settings unless noted) |
|---|---|---|---|---|
| A3/A4 | main | `dir` = `s\n`, `add dir` | `{ rev: 'tgt' }` | F: refuse `untracked: ['dir']`; T: switch, index `dir/x`, `f` |
| A5 | main | as A3, then `rm dir` | `{ rev: 'tgt' }` | switch, index `dir/x`, `f` |
| A6 | main | as A3, then `dir` = `modified\n` | `{ rev: 'tgt' }` | refuse `untracked: ['dir']` |
| A7 | hf | none | `{ rev: 'tgt' }` | switch |
| A8 | hf | `dir` = `S\n`, `add dir` | `{ rev: 'tgt' }` | refuse `localChanges: ['dir']` |
| A9 | main | `dir` = `s\n`, NOT added | `{ rev: 'tgt' }` | refuse `untracked: ['dir']` |
| A10 | main | as A3 | `{ rev: 'tgt', force: true }` / `checkout -f tgt` | switch |
| A11 | tgt | `rm -r -q --cached dir`, `rm -rf dir`, `dir` = `s\n`, `add dir` | `{ rev: 'tgt3' }` | switch; index `dir`, `f`, `g` |
| V1 | main | `mkdir dir`, `dir/x` = `s\n`, `add dir/x` | `{ rev: 'hf' }` | switch; index `dir`, `f`; disk `dir` = `D\n` |
| V2 | main | V1 + untracked `dir/u` | `{ rev: 'hf' }` | refuse `untracked: ['dir']` (git: would lose untracked files) |
| V3 | main | V1, then `dir/x` = `modified\n` | `{ rev: 'hf' }` | refuse `localChanges: ['dir/x']` |

Let each row's expectation come from the git twin (self-pinning): assert git exit 0 ⇔ tsgit
resolved, and on refusal rebuild git's message from tsgit's data per the plan-wide table.

### TDD steps

1. **RED (unit, V1): `Given a staged d/x neither head nor target has, and a target writing file
   d` > `When the branch switch materialises` > `Then d/x leaves the index and d is written`.**
   Paths `['d', 'f']`; `readWork(ctx, 'd')` is `D`. Expected failure: refuses
   `untracked: ['d']`.
2. **RED (unit, V3): same Given > `When d/x was modified after staging` > `Then it refuses
   d/x as a local change`.** Data `{ code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: ['d/x'],
   untracked: [] }`. Expected failure: data says `localChanges: [], untracked: ['d']`.
3. **GUARD (unit, V2): same Given > `When an untracked d/u sits beside d/x` > `Then it refuses d
   as untracked`.** Data `{ …, localChanges: [], untracked: ['d'] }`. Passes today.
4. **RED (interop, V1/V3) + GUARD (interop, every A row and V2).** Write the table above as
   `it.each` rows under the two settings. Expected failures: V1 — tsgit refuses `untracked:
   ['dir']` where git switches; V3 — tsgit says `untracked: ['dir']` where git names `dir/x` a
   local change. A rows already pass after Part 1 — a red A row is a Part 1 defect: stop and
   report.
5. **GREEN.** Add `files` / `beneath` to `displacedByTarget`. Steps 1–4 green; Part 1's rows
   stay green (V1 vs A4 kill the `beneath` ↔ `over` swap; V1 kills the `files` set, A4 the
   `dirs` set).
6. **REFACTOR.** Doc comments on `Displaced`, `displacedByTarget`, and the
   `MaterializeTreeOpts.headTree` comment (lines ~106–111: add that a kept path the switch needs
   for a file or a directory does not stay). No other edits.

### Gate

```bash
./node_modules/.bin/vitest run test/unit/application/primitives/materialize-tree.test.ts test/unit/application/primitives/materialize-tree-pruning.test.ts test/unit/application/commands/merge.test.ts test/integration/checkout-file-directory-swap-interop.test.ts test/integration/merge-interop.test.ts \
  && rm -rf .wireit && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/materialize-tree.ts test/unit/application/primitives/materialize-tree.test.ts test/integration/checkout-file-directory-swap-interop.test.ts \
  && npm run check:spelling
```

### Commit

`fix(checkout): replace a staged directory the target makes a file as git does`

## Part 3 — a switch runs from an unborn HEAD with the empty tree as the old side

### Context

Rows turned green (RED): **S1, S2, S3, S7, F1, F2, F3, F4, F5, F9 (as GUARD after the first
GREEN, see steps), F10, F11, F12, G1 (= A1 under `false`, A2 under `true`)**. Requirements R2,
R3. `rev` stays REQUIRED in this part (Part 4 makes it optional).

Files this part edits:
- `src/application/commands/checkout.ts`
- `test/unit/application/commands/checkout.test.ts`
- `test/unit/application/commands/checkout-create-branch.test.ts`
- `test/unit/application/commands/checkout-switch-target.test.ts`

Current code (checkout.ts at 339d4cbd):
- imports 1–76: `resolveRef`, `resolveRefOrMissing` (resolve-ref.ts:108,
  `(ctx, name: RefName | 'HEAD', options?) => Promise<ObjectId | undefined>`: `undefined` only for
  a chain that ends missing; cycles, broken refs, invalid names still throw), `zeroOid` already
  imported. Add `emptyTreeOid` imported from ../../domain/objects/object-id.js (stash.ts
  line 49 imports it the same way). After the edit `resolveRef` is no longer used in the file:
  remove it from the import (`noUnusedLocals`).
- `const HEAD_NAME = 'HEAD';` line 173 (literal type `'HEAD'`, accepted by `resolveRefOrMissing`).
- `headCheckoutLabel(head, oldOid)` 199–202: already returns the unborn branch's short name for a
  symbolic HEAD (reflog `checkout: moving from o to main`).
- `headTreeOption(ctx, opts, currentIndex, oldOid: ObjectId)` 243–253:
  ```ts
  if (opts.force === true) return {};
  const unborn = currentIndex.entries.length === 0 && !(await ctx.fs.exists(indexPath(ctx.layout.gitDir)));
  return unborn ? {} : { headTree: (await readTree(ctx, oldOid)).id };
  ```
- `interface SwitchRequest { opts; targetTree; branchName; oid; oldOid; matcher }` 258–265.
- `switchMaterializeOpts` 285–301 calls `headTreeOption(ctx, opts, currentIndex, request.oldOid)`
  at line 297.
- `switchBranch` 413–426: `readHeadRaw` → `assertEverySourceLoadable` (detached only) →
  `const oldOid = await resolveRef(ctx, 'HEAD' as RefName);` (throws `REF_NOT_FOUND` on an
  unborn HEAD — the defect) → `resolveCommitSwitch` → `readTree` → `loadSparseMatcher` →
  `materializeSwitch` → `finishSwitch(ctx, { opts, priorHead, oldOid, changedPaths, ...resolved })`.
- `unresolvedSwitch(opts)` 159–162 already yields `pathspecNoMatch(rev)` /
  `checkoutStartPointNotCommit(rev, name)` once nothing throws before it.
- `finishSwitch` 369–385 passes `oldOid` to the reflog and `post-checkout [oldOid, oid, '1']`.

Target shape after this part:

```ts
const switchBranch = async (ctx: Context, opts: CheckoutSwitchOptions): Promise<CheckoutResult> => {
  const priorHead = await readHeadRaw(ctx);
  if (priorHead.kind !== 'symbolic') await assertEverySourceLoadable(ctx);
  // git's merge_working_tree reads an unborn HEAD as no commit: the null oid, the empty tree.
  const headOid = await resolveRefOrMissing(ctx, HEAD_NAME);
  const oldOid = headOid ?? zeroOid(ctx.hashConfig);
  const resolved = await resolveCommitSwitch(ctx, opts);
  const target = await readTree(ctx, resolved.oid);
  const matcher = await loadSparseMatcher(ctx);
  const request = { opts, targetTree: target.id, headOid, matcher, ...resolved };
  const { written, deleted } = await materializeSwitch(ctx, request);
  return finishSwitch(ctx, { opts, priorHead, oldOid, changedPaths: written + deleted, ...resolved });
};

/** … A forced switch resets; an index never written is an initial checkout; an unborn HEAD is the empty tree. */
const headTreeOption = async (ctx, opts, currentIndex, headOid: ObjectId | undefined) => {
  if (opts.force === true) return {};
  const indexNeverWritten =
    currentIndex.entries.length === 0 && !(await ctx.fs.exists(indexPath(ctx.layout.gitDir)));
  if (indexNeverWritten) return {};
  if (headOid === undefined) return { headTree: emptyTreeOid(ctx.hashConfig) };
  return { headTree: (await readTree(ctx, headOid)).id };
};
```

`SwitchRequest.oldOid` is replaced by `readonly headOid: ObjectId | undefined;` (its only
reader was `switchMaterializeOpts` line 297, which now passes `request.headOid`); `finishSwitch`
keeps receiving `oldOid` directly. Keep the two existing comments in `switchBranch` (content-addressed
target read outside the lock; matcher meaning). The "index never written" check stays AHEAD of
the unborn branch (F10–F12 take the existing initial-checkout path).

Unit seeds (memory adapter; `createMemoryContext`, `init`, `add`, `commit`, `branchCreate`,
`checkout`, `rm` from src/application/commands/rm.ts, `readReflog` from reflog-store.ts,
`MemoryHookRunner`, `readIndex`, `updateConfigEntries`):
- **orphan**: on `main` with commits, then `ctx.fs.writeUtf8(<gitDir>/HEAD, 'ref: refs/heads/o\n')`
  — the index and work tree keep main's content (git's `checkout --orphan o`).
- **F5**: `main` = `f` (`a`); `branchCreate` `side`, `checkout { rev: 'side' }`, `f` = `b`,
  `add`, `commit`, `checkout { rev: 'main' }`, then the orphan HEAD rewrite (index `f` = `a`).
- **no index file** ("fetched"): seed `main` = `dir/x` + `f`, then `ctx.fs.rm(<gitDir>/index)`,
  `ctx.fs.rmRecursive(<workDir>/dir)`, `ctx.fs.rm(<workDir>/f)`, and HEAD → `refs/heads/fresh`.
- **empty index file**: the no-index seed, then write `f`, `add(ctx, ['f'])`,
  `rm(ctx, ['f'], { cached: true })` (index file exists with 0 entries; `f` untracked).
- G1: `main` = `f`; `tgt` = `f` + `dir/x`; on `main`: `rm(ctx, ['f'])` (index and disk),
  write `dir` = `s`, `add(ctx, ['dir'])`, then the orphan HEAD rewrite (index = `{ dir }`); set
  `core.ignorecase` to `false` / `true` with `updateConfigEntries`.

Where rows go:
- checkout.test.ts: F1 extends `describe.each([...sha1, sha256])('Given an unborn branch with a
  staged file ($algorithm)')` (lines ~1670–1696, inside `describe('checkout — post-checkout hook')`
  whose `postCheckoutSince(runner, since)` helper sits at ~1606). Its seed is a fresh `init` with a
  staged `f`; for the switch row commit first, then rewrite HEAD to `o`. New top-level
  `describe('checkout — a switch from an unborn HEAD')` at the end of the file for F2, F5, F9, F10,
  F11, F12, G1. File helper `refusalOf` (line 40) returns `err.data`.
- checkout-create-branch.test.ts: S1–S3 and F3 (its `seed()` builds `other` + `main`; add an
  orphan variant). Use try/catch + `.data` as the file does.
- checkout-switch-target.test.ts: S7 (`refusal(run)` helper line ~38; `pathspecNoMatch` imported).

### TDD steps

1. **RED (S7): `Given an unborn HEAD` > `When checkout switches to HEAD or main` (`it.each`
   `['HEAD', 'main']`, unborn `main` from a fresh `init` + staged `f`) > `Then it refuses as an
   unmatched pathspec and HEAD stays`.** Data `pathspecNoMatch(rev).data`; HEAD file still
   `ref: refs/heads/main\n`. Expected failure: `REF_NOT_FOUND { name: 'refs/heads/main' }`.
2. **RED (S1–S3): `Given an unborn HEAD` > `When checkout creates x from <rev>`
   (`it.each` `['HEAD', '@', 'main']`) > `Then it refuses: no branch can come from that start
   point`.** Data `{ code: 'CHECKOUT_START_POINT_NOT_COMMIT', revision: rev, branch: 'x' }`; no
   `refs/heads/x`. Expected failure: `REF_NOT_FOUND`.
3. **RED (F1, sha1 + sha256): in the unborn describe.each > `When checkout switches to a
   commit-backed main from orphan o` > `Then HEAD attaches to main, the reflog old id and the
   hook's first argument are the null oid`.** Result `toEqual({ branch: 'refs/heads/main', id:
   <c.id>, detached: false, changedPaths: 0 })`; `postCheckoutSince` args `[[nullOid, c.id,
   '1']]`; `(await readReflog(ctx, 'HEAD')).at(-1)` has `oldId: nullOid`, `newId: c.id`,
   `message: 'checkout: moving from o to main'`. Expected failure: `REF_NOT_FOUND
   { name: 'refs/heads/o' }`.
4. **RED (F2, F3, F10, F11, F12, G1 under `true`).** F2 `{ rev: 'main', detach: true }` from
   orphan → `{ branch: undefined, id: main, detached: true, changedPaths: 0 }`, reflog
   `moving from o to main`. F3 (create-branch file) `{ rev: 'main', createBranch: { name: 'x' } }`
   from orphan → `refs/heads/x` = main, branch reflog last message `branch: Created from main`,
   HEAD reflog `checkout: moving from o to x`, HEAD file `ref: refs/heads/x\n`. F10 (no index
   file) `{ rev: 'main' }` → `changedPaths: 2`, `dir/x` and `f` on disk. F11 (no index file,
   untracked `f` identical to main's) → `{ code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: [],
   untracked: ['f'] }`, also under `detach: true`. F12 (no index file, untracked `f` differing,
   `force: true`) → succeeds, `f` = main's content. G1 `true` (stat-clean staged `dir`) →
   `{ rev: 'tgt' }` succeeds, index paths `['dir/x', 'f']`, `dir` a directory. Expected failure
   for every row: `REF_NOT_FOUND { name: 'refs/heads/<unborn>' }`.
5. **GREEN-1 (minimal).** `switchBranch` as in Context; `SwitchRequest.headOid`; in
   `headTreeOption` return `{}` when `headOid === undefined` (temporarily — step 7 replaces it).
   Steps 1–4 green.
6. **RED (F5): `Given orphan o whose staged f is main's f` > `When checkout switches to side,
   where f differs` > `Then it refuses f as a local change and nothing moves`.** Data
   `{ code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: ['f'], untracked: [] }`; HEAD file still
   `ref: refs/heads/o\n`; `f` on disk still main's content. Expected failure: resolves with
   `branch: 'refs/heads/side'` and `f` silently replaced (the one-way `{}` side). This row is the
   mutation killer for the empty-tree branch. **RED (G1 under `false`):** `{ rev: 'tgt' }` → data
   `{ code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: [], untracked: ['dir'] }`. Expected failure:
   resolves (the one-way diff deletes the clean `dir`).
7. **GREEN-2.** `if (headOid === undefined) return { headTree: emptyTreeOid(ctx.hashConfig) };`
   and rename the local `unborn` → `indexNeverWritten`. Steps 1–6 green.
8. **GUARD (F9): `Given an empty index file and an untracked f identical to main's` > `When
   checkout switches to main` > `Then it refuses f as untracked`.** Data `{ …, localChanges: [],
   untracked: ['f'] }`. Passes after GREEN-2 (the empty tree "old" side; the untracked occupant
   refuses identical content).
9. **REFACTOR.** `switchBranch` ≤ 20 lines (inline `written + deleted` as shown); update the
   `headTreeOption` doc comment (three cases, why). `command grep -n "resolveRef\b"
   src/application/commands/checkout.ts` shows no stale import.

### Gate

```bash
./node_modules/.bin/vitest run test/unit/application/commands/checkout.test.ts test/unit/application/commands/checkout-create-branch.test.ts test/unit/application/commands/checkout-switch-target.test.ts test/unit/application/commands/checkout-head-stay.test.ts test/unit/application/commands/checkout-forced-switch.test.ts test/unit/application/commands/checkout-prior.test.ts test/unit/application/commands/checkout-branch-state.test.ts test/unit/application/commands/checkout-index-refresh.test.ts test/unit/application/commands/checkout-skip-worktree.test.ts test/unit/application/commands/checkout-branch-name-errors.test.ts test/unit/application/commands/checkout-path-restore-unmerged.test.ts \
  && rm -rf .wireit && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/checkout.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/checkout-create-branch.test.ts test/unit/application/commands/checkout-switch-target.test.ts \
  && npm run check:spelling
```

### Commit

`fix(checkout): switch from an unborn head with the empty tree as the old side`

## Part 4 — rev is optional; -b with no start point on an unborn HEAD only moves HEAD

### Context

Rows turned green (RED): **H1, H2, H3, H4, H5, U1, U3, U4, U5, U6, U7, U8, U12, U13, U14, U15**
(unit; U10/U11 asserted inside U1). GUARD: **`rev` + `paths` refusal**, **`rev: undefined` +
`paths` restores**. Requirements R1, R4, R6.

Files this part edits:
- `src/application/commands/checkout.ts`
- `test/unit/application/commands/checkout.test.ts`
- `test/unit/application/commands/checkout-create-branch.test.ts`
- `test/unit/application/commands/checkout-head-stay.test.ts`

Current code (checkout.ts, anchors at 339d4cbd; Part 3 shifted `switchBranch` and
`headTreeOption` by a few lines):
- `export interface CheckoutSwitchOptions { readonly rev: string; detach?; force?; createBranch? }`
  lines 85–90.
- `isSwitch` / `isPaths` lines 114–117. `assertSingleCheckoutMode` lines 660–670 (refuses
  `rev`+`paths` with `invalidOption('paths', 'cannot be combined with rev')`, and neither with
  `invalidOption('rev', 'either rev or paths must be provided')`). `checkoutInScope` 647–658
  dispatches `isPaths(opts) ? pathRestore : switchBranch` (the false branch narrows `opts` to
  `CheckoutSwitchOptions`).
- Readers of `opts.rev` (need it as `string`): `unresolvedSwitch` 159–162, `resolveSwitch`
  176–184 (`previousCheckoutArg(opts.rev)`), `staysOnHead` 335–339 (`HEAD_SPELLINGS.has(opts.rev)`).
  Their callers: `resolveCommitSwitch` 401–411, `finishSwitch` 369–385 via `SwitchFinish.opts`
  341–350.
- `assertBranchCreatable(ctx, opts)` 205–210: `createBranch` undefined → return; `detach` →
  `invalidOption('createBranch', 'cannot be combined with detach')`; `validateRefName(…)` →
  `INVALID_REF`; `refResolvesForReading` → `branchExists(name)`. Reused unchanged (the
  order is git's: U5 → U6 → U8). It returns `void`; validate the name again in
  `switchUnbornToNewBranch` (cheap, pure) — see decision candidate DC-3.
- `getRefStore(ctx).applyRefUpdates([{ kind: 'setSymbolic', name, target }])` with NO `reflog`
  field writes HEAD and no reflog line (files and reftable); `moveHead` (230–237) shows the
  `'HEAD' as RefName` spelling. A held `HEAD.lock` refuses `REF_LOCKED { name: 'HEAD' }`
  (refLocked in src/domain/refs/error.ts).
- Imports to add: `noInitialCommit` from '../../domain/commands/error.js'.

Target shape:

```ts
export interface CheckoutSwitchOptions {
  /** The commit to switch to; omitted means HEAD, as git's bare `checkout [-b <name>]`. */
  readonly rev?: string;
  …
}

/** A switch whose target is spelled: an omitted `rev` already reads as HEAD. */
type TargetedSwitch = CheckoutSwitchOptions & { readonly rev: string };

const switchBranch = async (ctx, opts: CheckoutSwitchOptions): Promise<CheckoutResult> => {
  const priorHead = await readHeadRaw(ctx);
  if (priorHead.kind !== 'symbolic') await assertEverySourceLoadable(ctx);
  const headOid = await resolveRefOrMissing(ctx, HEAD_NAME);
  if (opts.rev === undefined && headOid === undefined) return switchUnbornToNewBranch(ctx, opts);
  return switchToCommit(ctx, { ...opts, rev: opts.rev ?? HEAD_NAME }, priorHead, headOid);
};

/** git's switch_unborn_to_new_branch: an unborn HEAD only changes the branch it names. */
const switchUnbornToNewBranch = async (ctx, opts: CheckoutSwitchOptions): Promise<CheckoutResult> => {
  const request = opts.createBranch;
  if (request === undefined) throw noInitialCommit();
  await assertBranchCreatable(ctx, opts);
  const target = validateRefName(`${HEADS_PREFIX}${request.name}`);
  await getRefStore(ctx).applyRefUpdates([{ kind: 'setSymbolic', name: HEAD_NAME as RefName, target }]);
  return { branch: target, id: zeroOid(ctx.hashConfig), detached: false, changedPaths: 0 };
};
```

`switchToCommit(ctx, opts: TargetedSwitch, priorHead: HeadState, headOid: ObjectId | undefined)`
is Part 3's `switchBranch` body from `oldOid` on. Retype `unresolvedSwitch`, `resolveSwitch`,
`resolveCommitSwitch`, `staysOnHead` and `SwitchFinish.opts` to `TargetedSwitch`;
`SwitchRequest.opts`, `headTreeOption`, `switchIndex`, `assertBranchCreatable`,
`createRequestedBranch` keep `CheckoutSwitchOptions` (they never read `rev`). Delete `isSwitch`
(dead after the edit; `noUnusedLocals`) — dispatch stays on `isPaths`, which is "a switch is
anything that is not a path restore" (ADR-1197; see DC-4). `assertSingleCheckoutMode` becomes:

```ts
/** Refuses `rev` with `paths`. */
const assertSingleCheckoutMode = (opts: CheckoutOptions): void => {
  if (isPaths(opts) && 'rev' in opts && opts.rev !== undefined) {
    throw invalidOption('paths', 'cannot be combined with rev');
  }
};
```

Unit seeds:
- **unborn fresh** (U rows, H4/H5): `const runner = new MemoryHookRunner(); const ctx =
  createMemoryContext({ hooks: runner }); await init(ctx);` write `f`, `add(ctx, ['f'])`. Capture
  `const indexBefore = await ctx.fs.read(`${ctx.layout.gitDir}/index`)`.
- **orphan** (U8): checkout-create-branch.test.ts `seed()` (main ahead of other), then HEAD →
  `ref: refs/heads/o\n`.
- born rows reuse each file's seed (`seedWithBranches` in checkout.test.ts line ~50, `seed` in
  checkout-create-branch.test.ts line ~26, `seedMain` in checkout-head-stay.test.ts line ~21 with
  `reflogMessages(ctx)` and `HEAD` constants).

Existing rows to flip in checkout.test.ts (they assert the refusal that goes away):
- `describe('Given opts with rev key set to undefined')` (~578): becomes `Then it stays on HEAD`
  — result `{ branch: 'refs/heads/main', id: commitId, detached: false, changedPaths: 0 }`.
- `describe('Given opts with paths key set to undefined')` (~607): same success (a switch to
  HEAD). Keep the title's intent (paths undefined is not path mode).
- `describe('Given neither rev nor paths')` (~1252): same success; no new HEAD reflog entry.
- Keep `describe('Given both rev and paths')` (~1219) unchanged (GUARD).

### TDD steps

1. **RED (H3 + flips): the three flipped rows above, plus `checkout-head-stay.test.ts`
   `Given HEAD on main, When checkout with no rev` > `Then HEAD stays on main and no reflog
   entry is added`** (`reflogMessages` before/after equal). Expected failure:
   `INVALID_OPTION { option: 'rev', reason: 'either rev or paths must be provided' }`.
2. **RED (H2): checkout-head-stay `Given HEAD on main, When checkout with detach and no rev` >
   `Then HEAD detaches at main and the reflog logs the move from main to HEAD`.** Expected
   failure: `INVALID_OPTION`. **RED (H1): checkout-create-branch `Given a born HEAD, When checkout
   creates x with no start point` > `Then x is created at HEAD from the start point HEAD`** —
   `refs/heads/x` = HEAD's oid, branch reflog last message `branch: Created from HEAD`, HEAD
   reflog `checkout: moving from main to x`. Expected failure: `INVALID_OPTION`. (H1 kills the
   `HEAD_NAME` string-literal mutant in `opts.rev ?? HEAD_NAME`.)
3. **GUARD: `Given rev undefined and paths ['a.txt']` > `Then it restores the path`** (no
   refusal; the `opts.rev !== undefined` operand of the combined guard). Passes today.
4. **GREEN-1.** Option shape, `TargetedSwitch`, `switchToCommit` + `rev ?? HEAD_NAME`, the new
   `assertSingleCheckoutMode`, delete `isSwitch` — but NOT yet the unborn branch: write
   `switchBranch` as `return switchToCommit(ctx, { ...opts, rev: opts.rev ?? HEAD_NAME }, priorHead, headOid);`.
   Steps 1–3 green.
5. **RED (U rows + H4/H5), checkout-create-branch.test.ts `describe('Given an unborn HEAD')`:**
   - U1: `{ createBranch: { name: 'x' } }` → result `toEqual({ branch: 'refs/heads/x', id:
     '0'.repeat(40), detached: false, changedPaths: 0 })`; HEAD file `ref: refs/heads/x\n`;
     `ctx.fs.exists(<gitDir>/refs/heads/x)` false; index bytes equal `indexBefore`;
     `ctx.fs.exists(<gitDir>/logs/HEAD)` false (U10); no `post-checkout` in `runner.calls` (U11);
     work `f` unchanged.
   - U3: `track: 'direct'` → config text has no `[branch "x"]`. U4: `force: true` → same as U1.
   - U5 `{ detach: true, createBranch }` → `{ code: 'INVALID_OPTION', option: 'createBranch',
     reason: 'cannot be combined with detach' }`; U6 name `x..y` → `INVALID_REF` (assert full
     data from the factory); U8 orphan `o`, name `main` → `{ code: 'BRANCH_EXISTS', name:
     'refs/heads/main' }`; each: HEAD file unchanged.
   - U7 name `main` while HEAD is `ref: refs/heads/main` (unborn) → succeeds, HEAD file bytes
     unchanged.
   - U12 `<gitDir>/index.lock` present → succeeds (lock file untouched). U13 `<gitDir>/index` =
     `garbage` → succeeds, index still `garbage`. U15 `<gitDir>/MERGE_MSG` = `m\n` → kept.
   - U14 `<gitDir>/HEAD.lock` present → `{ code: 'REF_LOCKED', name: 'HEAD' }`, HEAD unchanged.
     If the memory ref store does not refuse a held `HEAD.lock`, drop this unit row, note it in
     the hand-off, and leave U14 to the interop suite (Part 5) — do not touch the ref store.
   - H4 `{}` and H5 `{ detach: true }` on the unborn fresh seed (with and without an index:
     also once before `add`) → `noInitialCommit().data`; HEAD file and index bytes unchanged.
   Expected failures after GREEN-1: U rows throw `CHECKOUT_START_POINT_NOT_COMMIT { revision:
   'HEAD', branch: 'x' }`; H4/H5 throw `PATHSPEC_NO_MATCH { pattern: 'HEAD' }`.
6. **GREEN-2.** `switchUnbornToNewBranch` and the `opts.rev === undefined && headOid ===
   undefined` branch. Steps 1–5 green. Mutation: H3 (born, omitted), Part 3's F1 (unborn, given)
   and U1 (unborn, omitted) isolate each operand of the `&&`.
7. **REFACTOR.** Every touched function ≤ 20 lines; `CheckoutSwitchOptions` doc comment; no
   `opts.rev!` or casts. `command grep -n "isSwitch\|either rev or paths"
   src/application/commands/checkout.ts` returns nothing.

### Gate

```bash
./node_modules/.bin/vitest run test/unit/application/commands/checkout.test.ts test/unit/application/commands/checkout-create-branch.test.ts test/unit/application/commands/checkout-head-stay.test.ts test/unit/application/commands/checkout-switch-target.test.ts test/unit/application/commands/checkout-forced-switch.test.ts test/unit/application/commands/checkout-prior.test.ts test/unit/application/commands/checkout-branch-state.test.ts test/unit/application/commands/checkout-index-refresh.test.ts test/unit/application/commands/checkout-skip-worktree.test.ts test/unit/application/commands/checkout-branch-name-errors.test.ts test/unit/application/commands/checkout-path-restore-unmerged.test.ts test/unit/repository/repository.test.ts \
  && rm -rf .wireit && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/checkout.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/checkout-create-branch.test.ts test/unit/application/commands/checkout-head-stay.test.ts \
  && npm run check:spelling
```

### Commit

`fix(checkout): create a branch on an unborn head with no start point as git does`

## Part 5 — interop: branch creation and refusals on an unborn HEAD (axes 1, 2, 4)

### Context

Interop harness suite, no `src/` delta. Rows pinned against git: **U1, U3, U4, U5, U6, U7, U8,
U10 (files and reftable), U11, U12, U13, U14, U15, U16, U17, U18, S1, S2, S3, S6, S7, H1, H2,
H3, H4, H5**. All pass on the code of Parts 3–4 (GUARD rows); a red row is a defect of those
parts: stop, report `{ unit, reason, options }`.

Files this part creates:
- `test/integration/checkout-unborn-new-branch-interop.test.ts` (NEW)

Model: test/integration/checkout-unborn-path-restore-interop.test.ts (header, hook capture
`HOOK_BODY` writing `"$*"` to `$(git rev-parse --git-dir)/hook-args`, `hookArgsOf`) and
test/integration/branch-delete-worktree-interop.test.ts (realpath'd mkdtemp roots, linked
worktrees, `openRepository({ cwd })` + `dispose`). Header:

```ts
/**
 * Cross-tool interop — checkout on an unborn HEAD: `-b <name>` with no start point only
 * moves HEAD, a start point that resolves to nothing refuses as git does, and an omitted
 * rev reads as HEAD on a born branch.
 *
 * @proves
 *   surface:        checkout
 *   bucket:         cross-tool-interop
 *   unique:         checkout -b on an unborn HEAD and an omitted rev behave as git does
 *   interopSurface: checkout
 */
```

Wrap in `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')` (hooks are `sh`).
`beforeAll`: `root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'tsgit-unborn-nb-')))`;
build an `origin` once with git: `init -q -b main`, `dir/x` = `x\n`, `f` = `f\n`, commit.
`afterAll`: `rm(root, { recursive: true, force: true })`. Each row builds `<label>-git` and
`<label>-tsgit` identically with git (so oids match), git acts in the first, tsgit in the second.

Twin kinds:
- **fresh**: `git init -q -b main <t>`, `f` = `a\n`, `git add f` (unborn `main`, index written).
- **orphan**: `git clone -q <origin> <t>`, `git -C <t> checkout -q --orphan o`.
- **born**: `git clone -q <origin> <t>` (on `main`).
- **linked orphan** (U16, S6): born twin + `git -C <t> worktree add -q --detach <t>-wt` +
  `git -C <t>-wt checkout -q --orphan o2`; tsgit acts with `openRepository({ cwd: <t>-wt })`.
- **bare linked orphan** (U17): `git clone -q --bare <origin> <t>.git` + `worktree add -q
  --detach <t>-wt` + `checkout -q --orphan o3` in the worktree.
- **unborn main + linked orphan** (U18): fresh twin (unborn `main`), `git -C <t> worktree add -q
  --orphan -b o2 <t>-wt`; act in the worktree with name `main`.
- **reftable fresh** (U10 second arm): `git init -q -b main --ref-format=reftable <t>` + staged `f`.

State compared after each call (helper `stateOf(dir)`): `git symbolic-ref -q HEAD` (or
`rev-parse HEAD` when detached; via `tryRunGitWithExit`), `for-each-ref --format=%(refname)
%(objectname) refs/heads`, `ls-files -s`, `status --porcelain --untracked-files=all`, whether
`$(git rev-parse --git-path logs/HEAD)` exists and its last line's first two columns and message
(text after the tab), and `hook-args` presence/content. For linked worktrees compare both the
worktree's and the main repository's HEAD. git command per row → tsgit call:

| id | Twin | git | tsgit |
|---|---|---|---|
| U1 | fresh | `checkout -b x` | `{ createBranch: { name: 'x' } }` |
| U3 | fresh | `checkout -b x --track` | `{ createBranch: { name: 'x', track: 'direct' } }`; also `config --get-regexp ^branch\.` empty in both |
| U4 | fresh | `checkout -f -b x` | `{ force: true, createBranch: { name: 'x' } }` |
| U5 | fresh | `checkout -b x --detach` | `{ detach: true, createBranch: { name: 'x' } }` |
| U6 | fresh | `checkout -b x..y` | `{ createBranch: { name: 'x..y' } }` |
| U7 | fresh | `checkout -b main` | `{ createBranch: { name: 'main' } }` |
| U8 | orphan | `checkout -b main` | `{ createBranch: { name: 'main' } }` |
| U10 | fresh + `config core.logAllRefUpdates always`; reftable fresh | `checkout -b x` | U1's call; reftable: compare `git reflog show HEAD` exit status in both |
| U11 | fresh + post-checkout hook | `checkout -b x` | U1's call; `hook-args` absent in both |
| U12 | fresh + `.git/index.lock` | `checkout -b x` | U1's call |
| U13 | fresh, `.git/index` = `garbage` | `checkout -b x` | U1's call |
| U14 | fresh + `.git/HEAD.lock` | `checkout -b x` (exit 255) | U1's call → `REF_LOCKED { name: 'HEAD' }` |
| U15 | fresh + `.git/MERGE_MSG` | `checkout -b x` | U1's call; `MERGE_MSG` kept in both |
| U16 | linked orphan | `-C <wt> checkout -b x` | U1's call in the worktree |
| U17 | bare linked orphan | same | same |
| U18 | unborn main + linked orphan | `-C <wt> checkout -b main` | `{ createBranch: { name: 'main' } }` |
| S1–S3 | fresh | `checkout -b x <HEAD|@|main>` | `{ rev, createBranch: { name: 'x' } }` |
| S6 | linked orphan | `checkout -b x HEAD` | same |
| S7 | fresh | `checkout HEAD`, `checkout main` | `{ rev }` |
| H1 | born | `checkout -b x` | `{ createBranch: { name: 'x' } }`; also compare `logs/refs/heads/x` last message |
| H2 | born | `checkout --detach` | `{ detach: true }` |
| H3 | born | `checkout` | `{}`; HEAD reflog line count unchanged in both |
| H4 | fresh (and fresh before `add`) | `checkout` | `{}` |
| H5 | fresh | `checkout --detach` | `{ detach: true }` |

Refusal rows: assert git's exit code, tsgit's full `err.data` (factory `.data` where one
exists: `checkoutStartPointNotCommit`, `pathspecNoMatch`, `noInitialCommit` from
src/domain/commands/error.ts), git's stderr rebuilt from those fields (plan-wide table), and
`stateOf` equal across twins.

### TDD steps

1. **GUARD (axis 1): U1, U3, U4, U7, U10 (files), U11, U12, U13, U15** as one `it.each` over
   the fresh twin with a per-row `prepare(dir)`; then **U5, U6, U8, U14** refusal rows. Pass on
   Parts 3–4.
2. **GUARD (worktrees): U16, U17, U18, S6.** Main repository HEAD untouched where the design
   says so.
3. **GUARD (U10 reftable).** `--ref-format=reftable` twins: `git reflog show HEAD` fails
   identically (same exit status) in both; `symbolic-ref HEAD` equal.
4. **GUARD (axis 2): S1, S2, S3, S7 (`HEAD`, `main`).**
5. **GUARD (axis 4): H1, H2, H3, H4 (with and without an index file), H5.**
6. **REFACTOR.** Table-driven rows, helpers ≤ 20 lines, no duplicated twin builders.

### Gate

```bash
./node_modules/.bin/vitest run test/integration/checkout-unborn-new-branch-interop.test.ts \
  && rm -rf .wireit && npm run check:types \
  && ./node_modules/.bin/biome check test/integration/checkout-unborn-new-branch-interop.test.ts \
  && npm run check:spelling
```

### Commit

`test(checkout): pin branch creation on an unborn head against git`

## Part 6 — interop: switching from an unborn HEAD (axis 3, axis 6 unborn)

### Context

Interop harness suite, no `src/` delta. Rows pinned against git: **F1, F2, F3, F4, F5, F6, F7,
F8, F9, F10, F11 (differing, identical, `--detach`), F12, F13 (reftable), F14 (no-cone sparse
`/g`), F15, and A1, A2, A2d, V4** — the axis-6 rows under `core.ignorecase` `false` AND `true`,
set in BOTH twins. All are GUARD rows on Parts 1–4; a red row is a defect there: stop and report.

Files this part creates:
- `test/integration/checkout-unborn-switch-interop.test.ts` (NEW)

Same skeleton as Part 5's file (read it first; do not import from it — copy only the small
`stateOf` / hook helpers, keep them ≤ 20 lines). Header:

```ts
/**
 * Cross-tool interop — a switch from an unborn HEAD runs as git's does: the empty tree is the
 * two-way old side once an index exists, the reflog and post-checkout carry the null oid, and a
 * staged path the target needs for a file or a directory follows core.ignorecase.
 *
 * @proves
 *   surface:        checkout
 *   bucket:         cross-tool-interop
 *   unique:         a switch from an unborn HEAD carries, refuses and logs as git does
 *   interopSurface: checkout
 */
```

Origin (built once in `beforeAll`, git, realpath'd root): `main` = `dir/x` (`x\n`) + `f`
(`f\n`); `side` = main with `f` = `side\n`; `hf` = `f` + FILE `dir` (`D\n`). Twin kinds (each
twin then creates local `side` and `hf` with `git -C <t> branch -q side origin/side` and
`branch -q hf origin/hf` where cloned):
- **orphan**: `clone -q <origin> <t>` + `checkout -q --orphan o` (index and work tree keep
  `dir/x`, `f`).
- **fetched**: `git init -q -b main <t>` + `git -C <t> fetch -q <origin> main:other side:side
  hf:hf` (unborn `main`, no index file).
- **fetched reftable** (F13): same with `init --ref-format=reftable`; compare reflogs with `git
  log -g --format=%H%x09%gs HEAD` (no `logs/HEAD` file under reftable).
- **sparse orphan** (F14): clone, `sparse-checkout set --no-cone /g` BEFORE `checkout --orphan
  o`; compare `git ls-files -t` and the disk.
- **linked orphan** (F15): Part 5's linked orphan kind.

| id | Twin + prepare | git | tsgit |
|---|---|---|---|
| F1 + F4 | orphan + post-checkout hook | `checkout main` | `{ rev: 'main' }`; reflog old column all zeros; `hook-args` equal (`<null> <main> 1`) |
| F2 | orphan | `checkout --detach main` | `{ rev: 'main', detach: true }` |
| F3 | orphan | `checkout -b x main` | `{ rev: 'main', createBranch: { name: 'x' } }`; `logs/refs/heads/x` last message equal |
| F5 | orphan | `checkout side` | `{ rev: 'side' }` → `localChanges: ['f']` |
| F6 | orphan, `f` = `m\n` unstaged | `checkout main` | `{ rev: 'main' }`; ` M f` kept |
| F7 | orphan, `git rm -q -f f` | `checkout main` | `{ rev: 'main' }`; `f` restored |
| F8 | orphan, untracked `g` | `checkout main` | `{ rev: 'main' }`; `?? g` kept |
| F9 | fetched, `f` = `f\n`, `add f`, `rm -q --cached f` | `checkout other` | `{ rev: 'other' }` → `untracked: ['f']` |
| F10 | fetched | `checkout other` | `{ rev: 'other' }`; result `changedPaths: 2` |
| F11 | fetched, untracked `f` differing / identical; also `--detach` | `checkout [--detach] other` | `{ rev: 'other'[, detach: true] }` → `untracked: ['f']` |
| F12 | fetched, untracked `f` differing | `checkout -f other` | `{ rev: 'other', force: true }` |
| F13 | fetched reftable, staged `g` | `checkout other` | `{ rev: 'other' }`; `A g` kept |
| F14 | sparse orphan | `checkout main` | `{ rev: 'main' }` |
| F15 | linked orphan | `-C <wt> checkout --detach main` | `{ rev: 'main', detach: true }` in the worktree; main repository HEAD untouched |
| A1/A2 | orphan, `git rm -r -q -f .`, `dir` = `s\n`, `add dir`, `config core.ignorecase <v>` | `checkout main` | `{ rev: 'main' }`: `false` refuses `untracked: ['dir']`, `true` switches (index `dir/x`, `f`) |
| A2d | A1 setup, then `dir` = `modified\n` | `checkout main` | refuses `untracked: ['dir']` under both |
| V4 | orphan, `git rm -r -q -f .`, `mkdir dir`, `dir/x` = `s\n`, `add dir/x`, ignorecase `<v>` | `checkout hf` | `{ rev: 'hf' }`: switches under both; index `dir`, `f`; disk `dir` = `D\n` |

Compare as in Part 5 (`stateOf` plus the disk shape at `dir` for A/V rows); refusals per the
plan-wide table (git exit 1). Never let a row ride the platform `git init` default for
`core.ignorecase`: every A/V row writes it in both twins before acting.

### TDD steps

1. **GUARD (axis 3, orphan): F1+F4, F2, F3, F5, F6, F7, F8.**
2. **GUARD (axis 3, fetched): F9, F10, F11 (three arms), F12, F13 (reftable).**
3. **GUARD (F14 sparse, F15 linked worktree).**
4. **GUARD (axis 6 unborn): A1/A2, A2d, V4 under `false` and `true`.**
5. **REFACTOR.** Table-driven, helpers ≤ 20 lines.

### Gate

```bash
./node_modules/.bin/vitest run test/integration/checkout-unborn-switch-interop.test.ts \
  && rm -rf .wireit && npm run check:types \
  && ./node_modules/.bin/biome check test/integration/checkout-unborn-switch-interop.test.ts \
  && npm run check:spelling
```

### Commit

`test(checkout): pin switches from an unborn head against git`

## Part 7 — docs: checkout on an unborn HEAD, the file/directory carry, api.json, backlog

### Context

Docs-only part (no `src/` delta) plus the regenerated API report. Requirement R6 and design §6.

Files this part edits:
- `docs/use/commands/checkout.md`
- `docs/use/commands/merge.md`
- `docs/use/primitives/internals.md`
- `reports/api.json`
- `docs/BACKLOG.md`

Edits:
- checkout.md `## Signature` (line ~13): `readonly rev?: string;  // omitted: HEAD`. `## Modes`
  table (lines ~31–38): Switch row trigger `{ rev }` notes that an omitted `rev` means HEAD; add
  a row **Create on an unborn branch** | `{ createBranch }` (no `rev`) | points HEAD at
  `refs/heads/<name>` and touches nothing else: no ref, index, work tree, reflog or
  `post-checkout`; `id` is the null object id. `## Behaviour`: add a bullet "A switch from an
  unborn branch" (the empty tree is the old side once an index exists: staged additions carried,
  a staged path the target changes refuses `localChanges`, an untracked occupant refuses even
  when identical; the reflog's old id and `post-checkout`'s first argument are the null id), and
  a bullet for the file/directory carry (a staged path HEAD and the target both lack is dropped
  where the target needs its place for a file or a directory; a staged directory's files are
  judged like deletions; a staged file blocks as an untracked occupant unless `core.ignoreCase`
  is set and the file is unchanged since it was staged). `## Throws` (lines ~89–101): REPLACE the
  `REF_NOT_FOUND` line with `NO_INITIAL_COMMIT` — an unborn HEAD with no `rev` and no
  `createBranch` (keep its sentence on the unborn path restore); DELETE the `BRANCH_NOT_FOUND`
  line (`command grep -c "branchNotFound\|BRANCH_NOT_FOUND" src/application/commands/checkout.ts`
  ⇒ 0); `CHECKOUT_START_POINT_NOT_COMMIT` gains "including any start point on an unborn HEAD".
- merge.md line ~96 (the paragraph ending "…while a staged change on a path the result moves
  refuses with `WORKING_TREE_DIRTY`."): append that a staged path HEAD and the result both lack
  does not survive when the result needs its place for a file or a directory — it is dropped, or
  refuses `WORKING_TREE_DIRTY` as checkout does (same `core.ignoreCase` rule).
- internals.md line ~245 (`headTree selects the two-way rule …`): one sentence — under
  `headTree`, a kept staged path that collides file/directory with a path the switch writes does
  not stay kept.
- reports/api.json: `npm run docs:json` (typedoc), then `git diff --stat reports/api.json`
  shows the `rev` flag change; commit it whole (the typedoc-id churn is normal).
- BACKLOG.md: line ~677 `- [ ] **32.41**` → `- [x]`, append
  ` · ADRs 1197–1203 · design/checkout-branch-on-unborn-head.md` (house style: see the ticked
  32.40 line ~676; flip + suffix ONLY). `## Release order` row 3 (line ~46): `32.41` →
  `~~32.41~~`. Nothing else moves.

Plain short sentences, no superlatives, no provenance refs in docs/use.

### TDD steps

1. **GUARD (docs).** After the edits, `command grep -n "REF_NOT_FOUND\|BRANCH_NOT_FOUND\|readonly rev: string"
   docs/use/commands/checkout.md` returns nothing; before them it returns three lines.
2. **GREEN.** Apply the edits above; regenerate api.json.
3. **REFACTOR.** Re-read each edited paragraph against Parts 1–4's shipped behaviour.

### Gate

```bash
npm run check:spelling && npm run check:doc-coverage \
  && rm -rf .wireit && npm run docs:json && git add reports/api.json && npm run check:doc-typedoc
```

### Commit

`docs(checkout): document checkout on an unborn head and the staged file-directory carry`

## Decision candidates

Choices the design and ADRs left open. The plan is written against each recommendation; a
different ruling changes only the named part.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | Commit type for the harness and docs parts (5, 6, 7) | **A** `fix(checkout): …` (as the invocation and ADR-1199's "every commit is fix" read literally) · **B** `test(checkout): …` / `docs(checkout): …` (the 32.40 plan's docs part used `docs(pathspec)`) | **B** (settled by the session: ADR-1199 governs release marking; ADR-1196 carried the same wording and 32.40 shipped `test:`/`docs:` commits) | The invocation binds it; release marking is unaffected either way (squash merge, PR title is the record). B is the house precedent if the user reads ADR-1199 as code commits only |
| DC-2 | One interop file for axes 1–4/6-unborn (design) or two | **A** two files: `checkout-unborn-new-branch-interop.test.ts` (axes 1, 2, 4) + `checkout-unborn-switch-interop.test.ts` (axes 3, 6) · **B** one file `checkout-unborn-switch-interop.test.ts` | **A** | ~50 rows in one file is two parts' work in one agent lifecycle; the split follows the design's own axes and keeps each part under ~100 tool calls |
| DC-3 | Avoid validating the branch name twice on the unborn path | **A** keep `assertBranchCreatable` returning `void`; `switchUnbornToNewBranch` calls `validateRefName` again (pure, cheap) · **B** make `assertBranchCreatable` return the validated `RefName \| undefined` and thread it | **A** | No signature churn on a function the born path uses; the second call cannot fail after the first passed, so no new branch or mutant |
| DC-4 | `isSwitch` after `rev` becomes optional (ADR-1197: "isSwitch becomes 'not a path restore'") | **A** delete it; `checkoutInScope` keeps dispatching on `isPaths`, which is exactly "not a path restore" · **B** keep `isSwitch = (o) => !isPaths(o)` and dispatch on it | **A** | B leaves dead code or depends on narrowing a union by an all-optional (weak) type, whose false branch need not narrow to `CheckoutPathsOptions`; A is the ADR's semantics with no new symbol |
