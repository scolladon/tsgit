# Plan — gitlink-rmdir-keeps-occupant

> Source: design doc `docs/design/gitlink-rmdir-keeps-occupant.md` · ADRs 1205, 1206, 1207, 1208, 1209, 1210
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

**Rulings this plan is written against.** D-A (ADR-1205): `wrapFsValidator` forwards the port's
optional `rmdir` behind the write `guard`. D-B (ADR-1206): `removeIfEmptyDirectory` moves from
prune-emptied-directories.ts to empty-directories.ts (exported) and `removeGitlinkDirectory` uses
it. D-C (ADR-1207): a kept non-directory occupant is reported with
`ctx.logger?.warn?.("unable to rmdir '<path>': Not a directory")`; the directory case keeps
`Directory not empty`; an absent path is silent. D-D (ADR-1208): the `add` member of
`OccupantShape` gains a required `mode: FileMode`; an added gitlink over a directory is `CLEAR`.
D-E (ADR-1209): `listUntracked` prunes stage-0 gitlink paths through the walker's `ignore`. D-F
(ADR-1210): ONLY Part 2's commit (the `rmdir` forward) is `fix(<scope>)!:`; every other commit is
`fix(<scope>):` or `docs:`.

**Carrier for `findWouldOverwrite`'s result-side mode (delegated to the planner, decided here).**
A fifth positional parameter `resultModes: ReadonlyMap<FilePath, FileMode> = NO_RESULT_MODES`
(after the existing `removed = NOTHING_REMOVED`), built by callers with a new internal export
`resultModesOf(outcomes)` in find-would-overwrite.ts. A path absent from the map (a conflict's
recorded path) is judged with `FILE_MODE.REGULAR` — it is written as a file, never as a gitlink
(gitlink conflicts are refused upfront by `rejectUnsupported` / `rejectUnsupportedConflicts`).
Why not replace `paths: ReadonlySet` with a map: ~35 unit call sites and the property suite
(find-would-overwrite.properties.test.ts) would churn for no behaviour; the sibling map leaves them
valid and matches ADR-1208's wording ("receives the result-side mode per added path").

**Order and why six parts.** Part 1 makes `removeGitlinkDirectory` kind-safe (D-B) and warns (D-C).
That alone fixes every gitlink-removal row in production, because the wrapper still hides `rmdir`
and the new guard `lstat`s first. So the axis 1–3 interop suite lands there RED→GREEN, under a
plain `fix`. Part 2 then forwards `rmdir` (D-A). That is the only commit that changes a refusal
(L1, symlinked reflog directory), so it is the lone `!` commit. Its RED rows are the wrapper rows,
the facade `rmdir`-reached row and L1. Parts 3–4 fold D3: Part 3 is the shared judge and its two
direct consumers (applyChangeset, findWouldOverwrite), Part 4 wires the merge-family callers and
carries the axis-4 interop suite. Part 5 folds D2 (stash `-u`). It must come after Parts 3–4,
because its S4 follow-up `stash apply` adds a gitlink over a populated directory. Part 6 is docs.
Parts run in sequence on one working tree, and each starts from the previous commit.
apply-changeset.ts and apply-changeset.test.ts recur in Parts 1 and 3, and find-would-overwrite.ts
in Parts 3 and 4. That is deliberate: merging them would exceed the 6-file ceiling.

**Public-surface decision: nothing new is public.** Every new or newly exported symbol is
internal (consumed only under `src/`). None is re-exported from `src/index*.ts`,
`src/application/commands/index.ts` or `src/application/primitives/index.ts`, and none reaches a
`Repository` method:
- `removeIfEmptyDirectory` (internal/empty-directories.ts, newly exported; module-private
  `isRealDirectory` moves with it)
- `guardedRmdir` (wrap-fs-validator.ts, module-private)
- `warnUnremovedGitlink` (apply-changeset.ts, module-private)
- `OccupantShape`'s new `mode` field (internal/occupant-clash.ts, an internal type)
- `resultModesOf` and `NO_RESULT_MODES` (find-would-overwrite.ts; the former exported, the
  latter module-private)
- the `gitlinks` set in stash.ts `listUntracked` (local)

So no error code, barrel, facade, `Object.keys(sut)` snapshot, `docs/use/commands/README.md`,
browser-surface scenario, README count or `reports/api.json` change. `FileSystem.rmdir?` already
exists on the port. If an implementer finds an export must become public, that is a blocker:
report `{ unit, reason, options }`.

**Implementers have NO MCP tools** (no serena, no graft). Use `Read` with the anchors given,
`command grep -n "<symbol>" <file>` (never bare `grep`: the rtk hook rewrites and truncates it),
and `Edit`. Anchors are point-in-time for commit 561b236a. Earlier parts shift them, so re-anchor
by symbol name.

**Craft Bash hook traps.** These are denied: perl one-liners; `node -e` bodies holding `[` together
with `$(`, or template literals; `git show` / `git diff` without `--no-ext-diff`. Put any loop or
multi-command probe in a script file and run it as `bash /abs/script.sh literal args`.
State-mutating probes (git config, repo writes) run in a `mktemp -d` throwaway, never in the
worktree.

**Test conventions (every part).**
- Titles: `describe('Given …')` > `describe('When …')` > `it('Then …')`. The 2-level
  `describe('Given …, When …')` > `it('Then …')` is allowed only when one expectation lives under
  the When.
- Bodies: AAA comments (`// Arrange`, `// Act`, `// Assert`).
- `sut` is the FUNCTION under test (`const sut = applyChangeset;`). Never bind a result to `sut`:
  the test-pyramid gate's `sutBindsResult` check fails on it.
- Errors: assert the full `data` through try/catch or the file's `outcomeOf` / `expectOutside`
  helper, never `toThrow(Class)` alone. One guard test per condition.
- Coverage: 100% lines, branches, functions and statements.
- No suppression directive of any kind.
- No provenance refs (ADR, backlog, design-row or part ids) in source, test titles or comments. Row
  ids such as `O1` may appear only as an `id` data field in an `it.each` table.
- Any DI row around a destructive call pins the TARGET (`toHaveBeenCalledWith(path)`), not only
  the count.
- Interop twins set `core.ignorecase` explicitly in BOTH twins, under both `false` and `true`
  (`describe.each(['false', 'true'] as const)`). Open the tsgit repository AFTER the row writes its
  config. Always `await repo.dispose()` in a `finally`.

**TDD discipline.** Write each RED and run it before writing the code that satisfies it. Record
the failing reason you saw and check it against the reason this plan predicts. A GUARD must pass
when written. A red GUARD is a RED the plan misclassified: stop, note it in the hand-off, and make
it green with this part's GREEN only. Never widen scope.

**Gate command notes.**
- Run tests with `./node_modules/.bin/vitest run <files>`. Vitest projects pick unit vs
  integration by path. Never use bare `npx vitest`: the rtk hook can rewrite it into a full run.
- `rm -rf .wireit` before trusting `npm run check:types` / `npm run check:spelling`, because
  wireit caches a stale green. The oracles are
  `node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit -p tsconfig.typecheck.json`
  and `npx cspell --no-progress <files>`.
- Write long output to a scratchpad file and read back only the failing lines.
- Never commit on a red gate, and never use `--no-verify`.
- Commit with `git commit -m "<subject>"`: one line, no body, ≤ 100 chars (commitlint).

**Interop harness facts (Parts 1, 2, 4, 5).**

Helpers in test/integration/interop-helpers.ts:
- `GIT_AVAILABLE`
- `runGit(args, { env? })`: scrubbed env (inherited `GIT_*` dropped, isolated `HOME`,
  `GIT_CONFIG_NOSYSTEM=1`, identity-only global config, no signing)
- `git(dir, ...args)`
- `tryRunGitWithExit(args)`, returning `{ stdout, stderr, exitCode }`
- `makePeerPair(slug)`, returning `{ peer, ours, dispose }`
- `lsStage(dir)` (`ls-files --stage`)

test/integration/occupant-displacement-fixtures.ts provides:
- `COMMIT_ENV`: pinned author/committer env. Pass it to every git commit in BOTH twins so their
  SHAs agree.
- `outcomeOfGitStderr(stderr)`: parses `untracked` / `local changes` buckets from git's refusal.
- `refusedUntracked(...)`, `OK`.

tsgit runs through `openRepository({ cwd, logger: { warn: (m) => warnings.push(m) } })` from
src/index.node.ts. ONLY that facade goes through `wrapFsValidator`. `createNodeContext` is the raw
adapter and proves nothing here.

Copy the `@proves` header shape from test/integration/stash-push-reset-interop.test.ts:
- `surface` is a comma list such as `repo.reset, repo.checkout`.
- `bucket` is `cross-tool-interop`.
- `unique` is 12–200 chars and unique repo-wide.
- `interopSurface` must be a name some `@writes` tag declares; `checkout`, `merge` and `stash` are
  in use.

Symlink rows are skipped on Windows:
`describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`.

Compare git's warnings to tsgit's as
`stderr.split('\n').filter((l) => l.includes('unable to rmdir'))` vs
`warnings.filter((w) => w.includes('unable to rmdir')).map((w) => `warning: ${w}`)`.

Occupant observer (inline in each suite):

```ts
const occupantAt = (p: string): string => {
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (st === undefined) return 'absent';
  if (st.isSymbolicLink()) return `symlink->${readlinkSync(p)}`;
  if (st.isFile()) return `file:${readFileSync(p, 'utf8')}`;
  return st.isDirectory() ? `dir:${readdirSync(p).sort().join(',')}` : 'other';
};
```

Per twin, compare: `occupantAt(<dir>/new)`, `lsStage(dir)` and `git status --porcelain=v1 -uall`.
The exit is git `exitCode` vs tsgit returned / threw.

Message reconstruction from tsgit fields (ADR-249: never ask tsgit for text):

| tsgit data | git stderr (`toContain`) and exit |
|---|---|
| `STASH_APPLY_WOULD_OVERWRITE { paths, localChanges: [], untracked }` | exit 128; `The following untracked working tree files would be overwritten by merge:` then `\t<path>` per path (`outcomeOfGitStderr(stderr).untracked` equals `untracked`) |
| `CHECKOUT_OVERWRITE_DIRTY.untracked` | exit 1; `The following untracked working tree files would be overwritten by checkout:` then `\t<path>` |
| `DIRECTORY_NOT_EMPTY { path: <gitDir>/logs/refs/heads/<b> }` | exit 128; `cannot update the ref 'refs/heads/<b>': there are still logs under '.git/logs/refs/heads/<b>'` |

## Part 1 — a removed gitlink's path loses only an empty directory, never a file or symlink

### Context

**Requirements:** R1, R3, R4 (production path via the guard, while the wrapper still hides
`rmdir`), and D-C's warning.
- RED rows: O1, O2, O5 (file/symlink), O6, O8, O11, T1–T5, S1, S2 (interop); the rmdir-less unit
  rows; the warn rows.
- GUARD rows: O3, O4, O5 (dir/empty), O7 (state after push), O10 (except its push -u dir cell), S5,
  S6.
- Not here: the two `(stash-push-u, dir)` cells, O9 and its in-head twin (Part 5, which re-pins
  them: git keeps "new/x" in both placements); S3 (Part 4); S4 (Part 5).

Files this part edits:
- `src/application/primitives/internal/empty-directories.ts`
- `src/application/primitives/internal/prune-emptied-directories.ts`
- `src/application/primitives/apply-changeset.ts`
- `test/unit/application/primitives/internal/empty-directories.test.ts`
- `test/unit/application/primitives/apply-changeset.test.ts`
- `test/integration/gitlink-removal-occupant-interop.test.ts` (new)

**Current code (anchors at 561b236a).**

internal/empty-directories.ts:
- Lines 1–5: module doc ("in the refs and logs trees"). Widen it to say the work tree's
  gitlink/prune removals use it too.
- `UNREMOVABLE_DIRECTORY_CODES` (lines 12–16) holds `DIRECTORY_NOT_EMPTY`, `FILE_NOT_FOUND` and
  `NOT_A_DIRECTORY`.
- `removeEmptyDirectory(ctx: Context, dir: string): Promise<boolean>` (lines 22–31) runs
  `(ctx.fs.rmdir ?? ctx.fs.rm).call(ctx.fs, dir)`.
- `removeEmptyDirectoryTree` (lines 40–46) is untouched.
- Imports: `errorDataCode` and `Context`. Add `import { lstatIfReachable } from './fs-probes.js';`
  (fs-probes.ts imports only domain/ports, so there is no cycle).

internal/prune-emptied-directories.ts lines 37–46, to MOVE verbatim to empty-directories.ts and
export:

```ts
const isRealDirectory = async (ctx: Context, absolute: string): Promise<boolean> => {
  const stat = await lstatIfReachable(ctx.fs, absolute);
  return stat?.isDirectory === true;
};
/** `rmdir` refuses a link or a file itself; the `rm` fallback would remove them, so it is guarded by a probe. */
const removeIfEmptyDirectory = async (ctx: Context, absolute: string): Promise<boolean> =>
  ctx.fs.rmdir === undefined
    ? (await isRealDirectory(ctx, absolute)) && (await removeEmptyDirectory(ctx, absolute))
    : removeEmptyDirectory(ctx, absolute);
```

After the move:
- prune-emptied-directories.ts imports `removeIfEmptyDirectory` from ./empty-directories.js.
- Its `removeEmptyDirectory` and `lstatIfReachable` imports go, since nothing else there uses them
  (verify with `command grep -n`).
- `pruneDirectoriesFrom` (line 87) keeps calling `removeIfEmptyDirectory(ctx, joinPath(workdir,
  dir))`.

apply-changeset.ts:
- Imports: line 38 `removeEmptyDirectory` (still used by `removeIgnoredBelow`, line 755); add
  `removeIfEmptyDirectory`. Line 40 `lstatIfReachable`. `FileStat` is not imported yet: add
  `import type { FileStat } from '../../ports/file-system.js';`.
- `applyDeleteEntry` (lines 412–426) routes `entry.previousMode === FILE_MODE.GITLINK` to
  `removeGitlinkDirectory(ctx, abs, entry.path)`, after `isLossy` and the leading-symlink skip.
- `removeGitlinkDirectory(ctx: Context, abs: string, path: FilePath): Promise<FilePath |
  undefined>` (lines 429–439), today:

```ts
  if (await removeEmptyDirectory(ctx, abs)) return path;
  if ((await lstatIfReachable(ctx.fs, abs))?.isDirectory === true) {
    ctx.logger?.warn?.(`unable to rmdir '${path}': Directory not empty`);
  }
  return undefined;
```

Target (design §2–§3):

```ts
// git's remove_or_warn: rmdir on a gitlink; whatever refuses to go stays, with git's warning.
const removeGitlinkDirectory = async (ctx, abs, path) => {
  if (await removeIfEmptyDirectory(ctx, abs)) return path;
  warnUnremovedGitlink(ctx, path, await lstatIfReachable(ctx.fs, abs));
  return undefined;
};
// git's warn_if_unremovable: ENOENT is silent; ENOTEMPTY and ENOTDIR are named.
const warnUnremovedGitlink = (ctx: Context, path: FilePath, stat: FileStat | undefined): void => {
  if (stat === undefined) return;
  const reason = stat.isDirectory ? 'Directory not empty' : 'Not a directory';
  ctx.logger?.warn?.(`unable to rmdir '${path}': ${reason}`);
};
```

Returning `undefined` means the delete is not counted in `deleted` and no parent directory is
scheduled for pruning. The index still loses the entry, because `assembleIndexEntries` builds from
the target.

**Unit fixtures.**

test/unit/application/primitives/apply-changeset.test.ts:
- `buildSeededContext()` (from ./fixtures.js) builds a memory context whose fs HAS `rmdir`.
- Helpers: `WORKDIR = '/repo'`, `makeChangeset([...])`, `makeDelete(path, previousId, previousMode
  = FILE_MODE.REGULAR)`, `enc` / `dec`.
- The block to extend is `describe('applyChangeset over a gitlink directory', …)` (line 3928;
  `OLD_ID = 'a'.repeat(40)`). Its rows "unmerged gitlink delete over a populated directory" (line
  4344, warns `Directory not empty`) and "gitlink delete over a directory that is already gone"
  (line 4368, no warn) stay as they are. Add the new rows beside them.
- Logger injection pattern: `const warn = vi.fn(); const ctx = { ...base, logger: { warn } };`.
- rmdir-less pattern (from internal/empty-directories.test.ts line 94):
  `const { rmdir: _omitted, ...rest } = base.fs; const ctx = { ...base, fs: rest };`. Memory fs
  members are own arrow fields, so the spread keeps them.

test/unit/application/primitives/internal/empty-directories.test.ts:
- Uses `createMemoryContext()` and paths under `ctx.layout.gitDir`.
- `describe('internal/empty-directories without the optional rmdir', …)` (line 93) has the
  `withoutRmdir` helper. Add a `describe('removeIfEmptyDirectory', …)` block.

**Interop suite — `test/integration/gitlink-removal-occupant-interop.test.ts` (new).**

`@proves`:
- `surface: repo.reset, repo.checkout, repo.stash.push, repo.stash.apply, repo.merge.run,
  repo.cherryPick.run, repo.revert.run`
- `bucket: cross-tool-interop`
- `unique: a gitlink leaving the index only calls rmdir on its path and keeps a file or symlink standing
  there as canonical git does`
- `interopSurface: checkout`

Wrap everything in `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')` >
`describe.each(['false', 'true'] as const)('Given core.ignorecase=%s in both twins', …)`. One
`makePeerPair(slug)` per row: `peer` is git's twin, `ours` is tsgit's. `dispose()` in
`afterEach`.

*Axis 1 twin recipe* (`build(dir, ignorecase, placement, occupant)`, run on both twins with git):
1. `init -q -b main`.
2. `config core.ignorecase <v>`, `config user.name p`, `config user.email p@p`,
   `config commit.gpgsign false`.
3. Write `a.txt`=`a\n`; `add a.txt`; `commit -qm base` (env `COMMIT_ENV`); `branch base`.
4. `oid=rev-parse HEAD`; `update-index --add --cacheinfo 160000,<oid>,new`.
5. If `placement === 'in-head'`: `commit -qm gitlink` (env `COMMIT_ENV`).
6. Occupant at `new`:
   - `file`: `precious\n`
   - `symlink`: `symlinkSync('a.txt', new)`
   - `dir`: "new/x"=`x\n`
   - `emptydir`: `mkdir new`
7. Edit `a.txt`=`edited\n`.

Target is `base` for in-head, `HEAD` for index-only.

Ops (git ↔ tsgit):

| op | git | tsgit |
|---|---|---|
| reset-hard | `reset --hard <t>` | `repo.reset({ mode: 'hard', rev: t })` |
| checkout-f | `checkout -f --detach <t>` | `repo.checkout({ rev: t, force: true, detach: true })` |
| stash-push | `stash push` | `repo.stash.push({})` |
| stash-push-u | `stash push -u` | `repo.stash.push({ includeUntracked: true })` |

Rows: every op × placement × occupant EXCEPT the two `(stash-push-u, dir)` cells (one per
placement), which Part 5 adds.
Expected outcomes are git's, self-pinned live:

| Rows | Outcome |
|---|---|
| file / symlink, removal rows (O1, O2, O5, O6, O8) | exit 0; occupant kept byte-identical; index `a.txt` only; status `?? new` and nothing else (the op restores `a.txt`); warning `unable to rmdir 'new': Not a directory` |
| dir rows | warning `… Directory not empty`; `?? new/x` |
| emptydir rows | removed, no warning |
| in-head stash rows (O10, minus the push -u dir cell) | the reset target keeps `new`, so the occupant is replaced by the gitlink's empty directory; no warning |

For stash rows, also compare `tryRunGitWithExit(['-C', d, 'rev-parse', '-q', '--verify',
'stash^3']).exitCode` across twins.

*Stash-apply follow-up* (axis 3; run after a successful push of a stash row, git `stash apply` vs
`repo.stash.apply()`):
- S1/S2 (index-only + file/symlink, after push or push -u): git exit 128 + untracked message for
  `new`; tsgit throws `{ code: 'STASH_APPLY_WOULD_OVERWRITE', paths: ['new'], localChanges: [],
  untracked: ['new'] }`; occupant, index and status unchanged in both.
- S5 (index-only + emptydir): 0 both, `160000 … new` staged.
- S6 (in-head, all four occupants): 0 both, same state. git's `error: expected submodule path 'new'
  not to be a symbolic link` line with exit 0 is display only; do not compare it.
- Do NOT add the apply follow-up for index-only + dir after plain push. That is S3, which tsgit
  still refuses until Part 4.

*O11 linked worktree*:
1. In each twin root, `mkdir main`, then git `init -q -b main main`, the same config, and a
   commit of `a.txt` (env `COMMIT_ENV`).
2. `git -C main worktree add -q -b side ../wt`.
3. In `wt`: `update-index --add --cacheinfo 160000,$(rev-parse HEAD),new`; occupant file
   `precious\n` or symlink → `a.txt`.
4. git `-C wt reset --hard HEAD` ↔ `openRepository({ cwd: <ours>/wt })` then
   `reset({ mode: 'hard', rev: 'HEAD' })`.
5. Compare `occupantAt(wt/new)`, `lsStage(wt)`, status, warnings. Expected: kept, `?? new`.

*Axis 2 twin recipe* (`buildRemoval(dir, ignorecase, diverged, occupant)`):
1. init/config as axis 1.
2. `a.txt` commit `base`; `branch base`.
3. `update-index --add --cacheinfo 160000,<HEAD>,new`; `commit -qm gitlink`; `branch G`.
4. `checkout -q -b rmg`; `rm -q --cached new`; `commit -qm drop`; `checkout -q main`.
5. If diverged: `b.txt`=`b\n`, add, `commit -qm b`.
6. `rmSync(new, { recursive: true, force: true })`, then occupant file `precious\n` or symlink →
   `a.txt`.

All commits use `COMMIT_ENV`.

Ops:

| Row | git | tsgit |
|---|---|---|
| T1 | `checkout base` | `repo.checkout({ rev: 'base' })` |
| T2 | `merge --ff-only rmg` | `repo.merge.run({ rev: 'rmg', fastForward: 'only' })` |
| T3 (diverged) | `merge --no-edit rmg` | `repo.merge.run({ rev: 'rmg' })` |
| T4 (diverged) | `cherry-pick rmg` | `repo.cherryPick.run({ commits: ['rmg'] })` |
| T5 (diverged) | `revert --no-edit G` | `repo.revert.run({ commits: ['G'] })` |

Expected (git 2.56): exit 0; occupant kept; index `a.txt` (+ `b.txt` when diverged); status
`?? new`; warning `Not a directory`.

**Existing suites whose expectations may shift** (run them; each compares to git, so a change
should be toward git):
- test/integration/stash-push-reset-interop.test.ts (gitlink seeds at lines 764, 858, 985–1003)
- test/integration/checkout-occupant-displacement-interop.test.ts (shape `GLf`: a gitlink whose
  path holds a file)
- test/integration/gitlink-consumers-interop.test.ts
- test/integration/merge-gitlink-modify-delete-interop.test.ts
- test/unit/application/primitives/internal/prune-emptied-directories.test.ts (its `Given a port
  without rmdir` rows now exercise the moved helper)
- test/unit/application/commands/rm.test.ts
- test/unit/application/primitives/apply-merge-to-worktree.test.ts

### TDD steps

1. **RED (interop)** — write the whole interop suite above and run it. Expect O1, O2, O5
   (file/symlink), O6, O8, O11, T1–T5 to fail with occupant `absent` vs git's `file:precious\n` /
   `symlink->a.txt`, status `''` vs `?? new`, and tsgit warnings `[]`. S1/S2 should fail because
   tsgit's apply returns (stages `100644 new` / `120000 new`) while git exits 128. GUARD rows (O3,
   O4, O5 dir/empty, O7, O10, S5, S6) pass. Keep the file; its state columns go green at step 5, its warning column at step 7.
2. **RED (unit, empty-directories.test.ts)** — `describe('removeIfEmptyDirectory')` with
   `const sut = removeIfEmptyDirectory` imported from internal/empty-directories.js. It currently
   fails with `sut is not a function` (the symbol is not exported there). Rows:
   - (a) port without rmdir + regular file ⇒ `false`, file kept;
   - (b) port without rmdir + symlink to an empty directory ⇒ `false`, link kept (lstat
     `isSymbolicLink`), target directory kept;
   - (c) port without rmdir + empty directory ⇒ `true`, gone;
   - (d) port without rmdir + absent path ⇒ `false`;
   - (e) port WITH rmdir + regular file ⇒ `false`, `vi.spyOn(ctx.fs, 'rmdir')` called once with
     that exact path (kills a mutant forcing the probe branch, which would never call `rmdir`).
3. **GREEN** — move `isRealDirectory` + `removeIfEmptyDirectory` into empty-directories.ts
   (export the latter, keep the doc comment), import it in prune-emptied-directories.ts, and drop
   the now-unused imports there. Run prune-emptied-directories.test.ts (GUARD: unchanged
   behaviour).
4. **RED (unit, apply-changeset.test.ts)** — `Given a port without rmdir and a gitlink delete over
   a regular file`: `makeDelete('d/sub', OLD_ID, FILE_MODE.GITLINK)`
   over a regular file "d/sub" holding `mine`, `force: false`. Assert:
   - bytes kept (reading "/repo/d/sub" through `base.fs` gives `mine`);
   - `result.deleted` is `0`;
   - its parent is not pruned ("/repo/d" still exists).

   Fails today: `rm` deletes the file, so the read throws `FILE_NOT_FOUND`. GUARD sibling: the same
   over a symlink (`base.fs.symlink('a', '/repo/sub')`) with rmdir present (memory `rmdir`
   refuses, link kept).
5. **GREEN** — `removeGitlinkDirectory` calls `removeIfEmptyDirectory` (the interop's occupant,
   index and status columns go green).
6. **RED (unit, warn)** — `it.each` over `regular file` / `symlink` under `describe('Given a
   gitlink delete over a <kind> standing at its path')`: `warn` called exactly once with
   `"unable to rmdir 'sub': Not a directory"`. This fails today because `warn` is not called (only
   a directory warns). Add a third row with the port WITHOUT rmdir and a regular file: same single
   warn.
7. **GREEN** — `warnUnremovedGitlink` as in Context. The existing `Directory not empty` row (line
   4344) and the `already gone` row (line 4368, no warn) are GUARDs that kill the `reason` swap and
   the `stat === undefined` return. The interop warning column now goes green.
8. **REFACTOR** — keep each function ≤ 20 lines, and update the empty-directories.ts module doc.
   Run every suite listed under "Existing suites whose expectations may shift".

### Gate

`rm -rf .wireit && ./node_modules/.bin/vitest run test/unit/application/primitives/internal/empty-directories.test.ts test/unit/application/primitives/internal/prune-emptied-directories.test.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/gitlink-removal-occupant-interop.test.ts test/integration/stash-push-reset-interop.test.ts test/integration/checkout-occupant-displacement-interop.test.ts test/integration/gitlink-consumers-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/empty-directories.ts src/application/primitives/internal/prune-emptied-directories.ts src/application/primitives/apply-changeset.ts test/unit/application/primitives/internal/empty-directories.test.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/gitlink-removal-occupant-interop.test.ts && npm run check:spelling`

### Commit

`fix(checkout): keep a file or symlink standing at a removed gitlink's path as git does`

## Part 2 — the confined file system forwards the adapter's rmdir

### Context

**Requirements:** R2, R5.
- RED rows: the wrapper `rmdir` rows; the facade rows (`rmdir` reached on the main context and
  present on `worktreeFs`); L1 (interop).
- GUARD: L1 on the memory adapter (unit); every Part 1 interop row (now through `rmdir` instead of
  the lstat guard).

This is the ONLY breaking commit (ADR-1210): a returning `branch.create` (any reflog-creating
ref write) over a symlinked reflog directory now throws `DIRECTORY_NOT_EMPTY`.

Files this part edits:
- `src/repository/wrap-fs-validator.ts`
- `test/unit/repository/wrap-fs-validator.test.ts`
- `test/unit/repository/repository.test.ts`
- `test/unit/application/primitives/record-ref-update.test.ts`
- `test/integration/ref-transaction-interop.test.ts`

**Current code (anchors at 561b236a).** In wrap-fs-validator.ts:
- `guardedUtimeNow(fs, guard): Pick<FileSystem, 'utimeNow'>` (lines 86–102) is the template to
  copy.
- In `wrapFsValidator(fs, roots, allowExternalPaths = [], { guardReads = true } = {})` (line 137),
  the returned object has `rm` (lines 230–233, `guard(p)`), then `...guardedAtomicRename(fs,
  guard)` (line 239) and `...guardedUtimeNow(fs, guard)` (line 240).
- `guard` is the write guard (line 155); `readGuard` (line 169) is a no-op under
  `guardReads: false`. `rmdir` MUST use `guard`.

Add, after `guardedUtimeNow`:

```ts
/**
 * `rmdir` is optional on the port: an adapter without it stays without it behind the wrapper, so
 * `removeEmptyDirectory` keeps its `rm` fallback there; where it exists it is guarded as a write.
 */
const guardedRmdir = (fs: FileSystem, guard: (path: string) => void): Pick<FileSystem, 'rmdir'> => {
  const { rmdir } = fs;
  if (rmdir === undefined) return {};
  return {
    rmdir: (p) => {
      guard(p);
      return rmdir.call(fs, p);
    },
  };
};
```

Spread `...guardedRmdir(fs, guard),` right after `...guardedUtimeNow(fs, guard),`. `.call(fs, …)`
keeps `BrowserFileSystem.rmdir` (a prototype method) bound. src/repository.ts calls
`wrapFsValidator(` twice: line 644 for the main context and line 667 for `worktreeFs`. Both get
`rmdir` from this one change; repository.ts is NOT edited.

**Unit fixtures.**

test/unit/repository/wrap-fs-validator.test.ts:
- `stubFs()` (line 7) has no `rmdir`; `expectOutside(fn)` is at line 30.
- Mirror `describe('wrapFsValidator — the optional utimeNow capability')` (lines 810–869), whose
  `fsWithUtimeNow` uses a `this`-reading method. Write `fsWithRmdir` with
  `rmdir(this: { readonly removed: string[] }, path: string) { this.removed.push(path); return
  Promise.resolve(); }`.
- wrap-fs-validator.properties.test.ts only probes `exists`, so no change.

test/unit/repository/repository.test.ts:
- `makeFallback()` (line 25) builds `fs: new MemoryFileSystem({ rootDir: '/repo' })`. For a spy,
  build the fs first:
  `const fs = new MemoryFileSystem({ rootDir: '/repo' }); const rmdir = vi.spyOn(fs, 'rmdir');
  const sut = await openRepository({ cwd: '/repo' }, { ...makeFallback(), fs });`.
  The spy must exist BEFORE `openRepository`, because the wrapper destructures `fs.rmdir` at wrap
  time.
- `worktreeScopedFs(repo, path)` (line 55) gives the `worktreeFs` product.
- Seed pattern (line 878):
  `await sut.init(); await sut.ctx.fs.writeUtf8('/repo/a.txt', 'a'); await sut.add(['a.txt']);
  await sut.commit({ message: 'seed', author: { name: 'Ada', email: 'ada@example.com', timestamp:
  1_700_000_000, timezoneOffset: '+0000' } });`
- Stage an index-only gitlink the way test/unit/application/commands/stash.test.ts lines 169–194
  do: `readIndex(sut.ctx)`, then append
  `indexEntryFromStat(await sut.ctx.fs.lstat('/repo/a.txt'), FILE_MODE.GITLINK as
  IndexEntry['mode'], <commit id> as ObjectId, 'new' as FilePath)`, then write "/repo/.git/index"
  with `serializeIndexFixtureAsync({ version: 2, entries, extensions: [], trailerSha: new
  Uint8Array(0) }, sut.ctx)`.
- Imports: `indexEntryFromStat` from src/application/primitives/internal/index-entry-from-stat.js,
  `serializeIndexFixtureAsync` from test/unit/application/primitives/fixtures.js. `readIndex` and
  `FILE_MODE` are already imported (lines 14, 16).

test/unit/application/primitives/record-ref-update.test.ts:
- Uses `createMemoryContext()`, `recordRefUpdate(ctx, ref, oldId, newId, message)` and the
  constants `BRANCH`, `ZERO_OID`, `OID_A` at the top of the file.
- Add the row inside `describe('recordRefUpdate')`.

test/integration/ref-transaction-interop.test.ts:
- `filesCasePair(slug)` (line 322) returns `{ peer, ours, ctx }` copied from the shared files base
  (non-bare, so reflogs on). Its `ctx` is `createNodeContext` (RAW: it already has `rmdir`), so the
  L1 row must NOT use `ctx`; it opens `openRepository({ cwd: ours })`.
- Add L1 beside `describe('Given a file standing inside the log directory a new branch would
  need')` (line 4736), which has the exact git message pattern (lines 4758–4764).
- Branch `x` already exists in the base, so use branch name `linked-log`.

**Existing suites whose expectations may shift:**
- every Part 1 suite (now through `rmdir`)
- test/integration/reflog-interop.test.ts, reflog-writers.test.ts
- branch-*-interop.test.ts
- worktree-interop.test.ts
- rm-interop.test.ts
- test/unit/repository/repository.test.ts as a whole

The consumer table also names `ref-store.ts` `pruneEmptyParents` over a symlinked parent ref
directory (not pinned, outside this plan). If a suite turns red there, report it as an `IMPACT`
line; do not fix it.

### TDD steps

Write and run every RED (steps 1–3) before the one GREEN (step 4).

1. **RED (wrapper unit)** — `describe('wrapFsValidator — the optional rmdir capability')`:
   - `Given an fs with rmdir and an in-root path`: `await sut.rmdir?.('/repo/a')`, then
     `fs.removed` equals `['/repo/a']`. Fails: `[]`, because the wrapper has no `rmdir` and the
     optional call is a no-op.
   - `Given an fs with rmdir and a path outside every root` with `{ guardReads: false }`:
     `expectOutside(async () => sut.rmdir?.('/etc/a'))` and `fs.removed` equals `[]`. Fails with
     `expect.unreachable` (nothing throws). The `guardReads: false` variant kills a
     `readGuard`-for-`guard` mutant.
   - GUARD: `Given an fs without rmdir` ⇒ `'rmdir' in sut` is `false` (true today).
2. **RED (facade, repository.test.ts)**
   - `Given an index-only gitlink over a regular file opened through the facade, When reset hard
     runs`: the `rmdir` spy is `toHaveBeenCalledWith('/repo/new')`; "/repo/new" still reads
     `precious`; `readIndex(sut.ctx)` has no `new` entry. Fails: the spy is never called, because
     the Part 1 guard `lstat`s and keeps the file without reaching `rmdir`.
   - `Given a facade over a memory fs, When its worktreeFs is built`:
     `'rmdir' in worktreeScopedFs(sut, '/repo/wt')` is `true`. Fails with `false`.
3. **RED (L1 interop)** — `describe.each(['false', 'true'] as const)` `Given core.ignorecase=%s
   and the log path of a new branch is a symlink to an empty directory`, `When both tools create
   the branch`:
   - Setup in both twins: `git config core.ignorecase <v>`,
     `git config core.logAllRefUpdates true`, `mkdir .git/empty-target`,
     `mkdir -p .git/logs/refs/heads`, then
     `symlinkSync('../../../empty-target', '.git/logs/refs/heads/linked-log')`.
   - Act: git `branch linked-log` vs `openRepository({ cwd: ours })` then
     `repo.branch.create({ name: 'linked-log' })` (catch, dispose).
   - Assert:
     - git exit 128, and stderr contains `cannot update the ref 'refs/heads/linked-log': there are
       still logs under '${path.join('.git', 'logs', 'refs', 'heads', 'linked-log')}'`.
     - tsgit `data` equals `{ code: 'DIRECTORY_NOT_EMPTY', path:
       `${repo.ctx.layout.gitDir}/logs/refs/heads/linked-log` }`.
     - In both twins: `lstat(...).isSymbolicLink()` is true; `readlink` is
       "../../../empty-target"; `tryRunGitWithExit(['-C', d, 'rev-parse', '-q', '--verify',
       'refs/heads/linked-log']).exitCode` is `1`.
   - Fails today: tsgit returns (no throw), replaces the symlink with a log file and writes the
     ref.
   - Skip on win32.
4. **GREEN** — `guardedRmdir` plus the spread. Steps 1–3 go green.
5. **GUARD (memory unit, record-ref-update.test.ts)** — `Given the log path of a new branch is a
   symlink to an empty directory, When recordRefUpdate creates the log`:
   - Setup: `ctx.fs.mkdir(`${gitDir}/empty-target`)`, `mkdir` of `${gitDir}/logs/refs/heads`,
     `ctx.fs.symlink('../../../empty-target', `${gitDir}/logs/refs/heads/x`)`.
   - Call `recordRefUpdate(ctx, 'refs/heads/x', ZERO_OID, OID_A, 'branch: Created from main')`.
   - Expect: data `{ code: 'DIRECTORY_NOT_EMPTY', path: `${gitDir}/logs/refs/heads/x` }`; the link
     is still a symlink.
   - This passes before and after step 4: the memory `rmdir` refuses a symlink with
     `NOT_A_DIRECTORY`. If it is red, the memory adapter diverges from Node: stop and report a
     blocker.
6. **REFACTOR** — none expected. Re-run the Part 1 interop suite and the shifting suites above.

### Gate

`rm -rf .wireit && ./node_modules/.bin/vitest run test/unit/repository/wrap-fs-validator.test.ts test/unit/repository/wrap-fs-validator.properties.test.ts test/unit/repository/repository.test.ts test/unit/application/primitives/record-ref-update.test.ts test/integration/ref-transaction-interop.test.ts test/integration/gitlink-removal-occupant-interop.test.ts test/integration/reflog-interop.test.ts test/integration/worktree-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/repository/wrap-fs-validator.ts test/unit/repository/wrap-fs-validator.test.ts test/unit/repository/repository.test.ts test/unit/application/primitives/record-ref-update.test.ts test/integration/ref-transaction-interop.test.ts && npm run check:spelling`

### Commit

`fix(repository)!: forward the adapter's rmdir through the confined file system as git does`

## Part 3 — the occupant judge lets an added gitlink take a directory at its path

### Context

**Requirement:** R6 (shared judge + its two direct consumers).
- RED rows: unit rows for `classifyOccupant`, `applyChangeset` (non-forced and protected add) and
  `findWouldOverwrite` with a result mode.
- GUARD rows: a gitlink over a file or symlink still refuses; a regular add over the same directory
  still refuses; a file in a gitlink's leading path still refuses.

Interop pins A1, A2 and A3 (ort) route through `applyChangeset` and go green here. They are written
in Part 4 as GUARDs (the 6-file ceiling).

Files this part edits:
- `src/application/primitives/internal/occupant-clash.ts`
- `src/application/primitives/apply-changeset.ts`
- `src/application/primitives/find-would-overwrite.ts`
- `test/unit/application/primitives/internal/occupant-clash.test.ts`
- `test/unit/application/primitives/apply-changeset.test.ts`
- `test/unit/application/primitives/find-would-overwrite.test.ts`

**Current code (anchors at 561b236a).**

internal/occupant-clash.ts:
- Imports at lines 6–21 (`FilePath` type from ../../../domain/objects/object-id.js).
- `OccupantShape` (lines 50–52):

```ts
export type OccupantShape =
  | { readonly kind: 'add'; readonly path: FilePath }
  | { readonly kind: 'update' | 'delete'; readonly path: FilePath };
```

- `classifyAddedPath(ctx, path, scope)` (lines 116–126) runs `lstatIfReachable`; undefined ⇒
  `CLEAR`; directory ⇒ `holdsSurvivor ? untracked(path) : CLEAR`; else ignored ? `CLEAR` :
  `untracked`.
- `classifyOccupant` (lines 184–199), `case 'add'`, runs `classifyLeadingObstruction(shape.path,
  scope) ?? classifyAddedPath(ctx, shape.path, scope)`. The leading check stays first and
  unchanged.

Target:

```ts
export type OccupantShape =
  | { readonly kind: 'add'; readonly path: FilePath; readonly mode: FileMode }
  | { readonly kind: 'update' | 'delete'; readonly path: FilePath };
// classifyAddedPath(ctx, shape: Extract<OccupantShape, { readonly kind: 'add' }>, scope):
// git's verify_clean_subdirectory returns early for a gitlink: the directory is the submodule's.
if (stat.isDirectory) {
  if (shape.mode === FILE_MODE.GITLINK) return CLEAR;
  return (await holdsSurvivor(ctx, absPath, scope)) ? untracked(shape.path) : CLEAR;
}
```

Import `FILE_MODE` (value) and `FileMode` (type) from ../../../domain/objects/file-mode.js /
../../../domain/objects/index.js, as find-would-overwrite.ts does at its lines 22–23. A symlink
to a directory at the path is not `isDirectory` under `lstat`, so it still refuses, as git's
`verify_absent` does.

apply-changeset.ts (the compiler finds both sites once `mode` is required):
- `evaluateDirtyPath` (lines 278–292), line 291:
  `classifyOccupant(ctx, { kind: 'add', path: entry.path }, scope)` becomes
  `{ kind: 'add', path: entry.path, mode: entry.mode }`.
- `evaluateProtectedPath` (lines 308–316), line 311: same change.

`ChangesetEntry` add entries carry `mode`. The gitlink write itself already leaves a directory:
`clearOccupants` skips `entry.mode === FILE_MODE.GITLINK` (line 813), and the existing row at
apply-changeset.test.ts line 902 (forced gitlink add over "sub/keep.txt") proves the writer keeps
the content.

find-would-overwrite.ts:
- `NOTHING_REMOVED` at line 108.
- `untrackedSquat(ctx, path, byPath, clashScope)` (lines 140–152): line 148 is
  `classifyOccupant(ctx, { kind: 'add', path }, clashScope)`.
- `findWouldOverwrite(ctx, paths, currentIndex, removed = NOTHING_REMOVED)` (lines 188–216).

Target:

```ts
const NO_RESULT_MODES: ReadonlyMap<FilePath, FileMode> = new Map();
// A path no clean outcome names is a conflict's recorded path: it is written as a file.
const CONFLICT_WRITE_MODE = FILE_MODE.REGULAR;
export const findWouldOverwrite = async (ctx, paths, currentIndex,
  removed: ReadonlySet<FilePath> = NOTHING_REMOVED,
  resultModes: ReadonlyMap<FilePath, FileMode> = NO_RESULT_MODES) => { … }
// untrackedSquat gains `mode: FileMode` and passes { kind: 'add', path, mode }.
// The loop passes resultModes.get(path) ?? CONFLICT_WRITE_MODE.
```

Update the jsdoc of `findWouldOverwrite` (lines 178–187) with one sentence: "`resultModes` gives
the mode each added path takes; an added gitlink never counts a directory at its path as untracked
data." `FILE_MODE` and `FileMode` are already imported there. No caller passes `resultModes` yet:
Part 4 wires them and adds `resultModesOf`. Do NOT export anything new in this part (knip).

**Unit fixtures.**

occupant-clash.test.ts:
- `classify(ctx, target, scope)` (line 46) builds `{ kind: 'add', path }`. Give it a 4th param
  `mode: FileMode = FILE_MODE.REGULAR` (FILE_MODE is already imported at line 14; import `FileMode`
  from src/domain/objects/index.js).
- `scopeOf(ctx, options)` is at line 29.
- Use `createMemoryContext()` and write under `ctx.layout.workDir`.

apply-changeset.test.ts:
- `makeAdd(path, id, mode = FILE_MODE.REGULAR)` (line 75), `outcomeOf(promise)` (line 166).
- Options are `{ changeset, force, workdir: WORKDIR, untrackedOccupants: 'protect' }`. The
  protected form is seen at about line 4380 ("forced with untrackedOccupants protect").
- Refusal data: `{ code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: [], untracked: [...] }`.
- Add rows inside `describe('applyChangeset over a gitlink directory')` (line 3928).

find-would-overwrite.test.ts:
- Helpers: `createMemoryContext()`, `work(ctx, path, content)`, `set(...)`, `indexOf([])`.
- The row `Given a directory holding only ignored files at an added path` (line 562) is the shape
  to copy.

**Existing suites whose expectations may shift:**
- test/unit/application/primitives/find-would-overwrite.properties.test.ts
- test/unit/application/primitives/apply-merge-to-worktree.test.ts
- test/unit/application/commands/checkout.test.ts, merge.test.ts, stash.test.ts (any gitlink add
  over a populated directory that pinned the refusal now passes; fix such an expectation only if it
  contradicts git, and name it in the hand-off)
- test/integration/checkout-occupant-displacement-interop.test.ts (X4 row: a file at `d` with
  gitlink "d/s" due must still refuse `d`)
- test/integration/gitlink-consumers-interop.test.ts
- test/integration/add-gitlink-interop.test.ts

### TDD steps

1. **RED (occupant-clash.test.ts)** — `Given a directory holding an untracked file at the path,
   When a gitlink is added there` ⇒ `toEqual({ kind: 'clear' })`. Fails: the verdict is
   `{ kind: 'clash', clash: { class: 'untracked', path: 'sub' } }`.

   GUARDs, each its own `describe`:
   - a gitlink added over a regular file ⇒ untracked clash `sub`;
   - a gitlink added over a symlink to a directory ⇒ untracked clash;
   - a REGULAR add over the same populated directory ⇒ untracked clash (kills a `mode` test forced
     to `true`);
   - a gitlink "d/s" added under a regular file `d` ⇒ untracked clash `d` (leading obstruction
     first);
   - a gitlink added over an empty directory ⇒ clear.
2. **RED (apply-changeset.test.ts)** — `Given a directory holding an untracked file at a path a
   gitlink is added to, When applyChangeset runs without force` ⇒ no throw; "sub/keep.txt" still
   `k`; `result.writtenEntries` holds one entry with `path: 'sub'` and `mode: FILE_MODE.GITLINK`.

   Second row, `… When applyChangeset runs forced with untrackedOccupants protect` ⇒ same. Both
   fail today with `CHECKOUT_OVERWRITE_DIRTY { localChanges: [], untracked: ['sub'] }`.

   GUARD: `Given a regular file at a path a gitlink is added to, When applyChangeset runs without
   force` ⇒ data `{ code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: [], untracked: ['sub'] }`.
3. **GREEN** — `mode` on the `add` shape; `classifyAddedPath` takes the shape; both apply-changeset
   call sites pass `mode: entry.mode`. `untrackedSquat` passes `CONFLICT_WRITE_MODE` for now, so
   the type check is green. Steps 1–2 go green.
4. **RED (find-would-overwrite.test.ts)** — `Given an untracked directory new holding x at a path
   the merge adds as a gitlink, When findWouldOverwrite runs with that result mode`:
   `findWouldOverwrite(ctx, set('new'), indexOf([]), set(), new Map([['new' as FilePath,
   FILE_MODE.GITLINK]]))` ⇒ `{ localChanges: [], untracked: [] }`. Fails with
   `untracked: ['new']`, because the 5th argument does not exist yet and is ignored at run time.

   GUARDs:
   - the same directory with no `resultModes` ⇒ `untracked: ['new']` (the fallback is a file);
   - the same with `new Map([['new', FILE_MODE.REGULAR]])` ⇒ `untracked: ['new']`.
5. **GREEN** — the `resultModes` parameter; `untrackedSquat` uses
   `resultModes.get(path) ?? CONFLICT_WRITE_MODE`.
6. **REFACTOR** — `classifyAddedPath` ≤ 20 lines, nesting ≤ 2. Run the shifting suites above.

### Gate

`rm -rf .wireit && ./node_modules/.bin/vitest run test/unit/application/primitives/internal/occupant-clash.test.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/primitives/find-would-overwrite.properties.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/checkout-occupant-displacement-interop.test.ts test/integration/gitlink-consumers-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/occupant-clash.ts src/application/primitives/apply-changeset.ts src/application/primitives/find-would-overwrite.ts test/unit/application/primitives/internal/occupant-clash.test.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/find-would-overwrite.test.ts && npm run check:spelling`

### Commit

`fix(checkout): let an added gitlink take the directory standing at its path as git does`

## Part 4 — merge, cherry-pick, revert and stash apply pass the result mode to the judge

### Context

**Requirement:** R6 for the three-way consumers.
- RED rows: A3c (conflicted merge, `persistConflictState` → `findOverwriteRefusal`), A3r (`merge
  -s resolve`, `tryTrivialMerge` → `workTreeTakes`), A4 (cherry-pick), A5/S3 (stash apply), plus
  the unit rows.
- GUARD rows: A1 (checkout), A2 (merge ff-only), A3 (clean ort merge, which goes through
  `attemptNonConflictTree` → `materializeTree`, fixed in Part 3), and a file at `new` that still
  refuses.

Pinned live on git 2.56.0 (2026-11-18, both `core.ignorecase` values):

| Row | git result | tsgit at 561b236a |
|---|---|---|
| A3c | exit 1; index has `c.txt` stages 1/2/3 and `160000 new`; "new/x" kept | `WORKING_TREE_DIRTY { localChanges: [], untracked: ['new'] }` |
| A3r | exit 0; index `a.txt b.txt c.txt 160000 new`; HEAD subject `Merge branch 'G'`; "new/x" kept | `MERGE_STRATEGY_FAILED { strategy: 'resolve' }` |

Files this part edits:
- `src/application/primitives/find-would-overwrite.ts`
- `src/application/primitives/apply-merge-to-worktree.ts`
- `src/application/commands/merge.ts`
- `test/unit/application/primitives/find-would-overwrite.test.ts`
- `test/unit/application/primitives/apply-merge-to-worktree.test.ts`
- `test/integration/gitlink-added-over-directory-interop.test.ts` (new)

**Current code (anchors at 561b236a; Part 3 shifted find-would-overwrite.ts by about 10 lines).**

find-would-overwrite.ts: `changedPaths(outcomes, conflicts, ours)` is at lines 82–96. Add beside
it:

```ts
/** The mode each clean outcome leaves at its path; a deleted or conflicted path has none. */
export const resultModesOf = (
  outcomes: ReadonlyArray<MergeOutcome>,
): ReadonlyMap<FilePath, FileMode> => {
  const modes = new Map<FilePath, FileMode>();
  for (const outcome of outcomes) if ('mode' in outcome) modes.set(outcome.path, outcome.mode);
  return modes;
};
```

`MergeOutcome` is defined in src/domain/merge/merge-types.ts lines 42–62:
- `unchanged` / `resolved-known` / `resolved-merged` carry `path` + `mode`;
- `resolved-deleted` carries only `path`;
- `conflict` carries only `conflict`.

`MergeOutcome` is already imported at line 20.

apply-merge-to-worktree.ts, lines 526–531:

```ts
  const changed = changedPaths(merged.outcomes, merged.conflicts, ours.entries);
  const overwrite = await findWouldOverwrite(
    ctx,
    changed,
    input.currentIndex,
    new Set(merged.outcomes.filter(isDeleted).map((outcome) => outcome.path)),
  );
```

Add `resultModesOf(merged.outcomes)` as the 5th argument, and import it beside `changedPaths`
(line 45). This path serves cherry-pick, revert, stash apply and rebase picks.

merge.ts:
- `workTreeTakes(ctx, ours, merged)` (lines 1515–1525) computes
  `outcomes = outcomesBetween(ours, merged, new Set())`, then
  `findWouldOverwrite(ctx, changed, await readIndex(ctx), removed)`.
- `findOverwriteRefusal(ctx, changed, outcomes)` (lines 1959–1970) calls
  `findWouldOverwrite(ctx, changed, currentIndex, removed)`.

Add `resultModesOf(outcomes)` as the 5th argument at both, and import it from
../primitives/find-would-overwrite.js (line 86 imports `findWouldOverwrite` from there). Do NOT
make the parameter required: ~35 unit call sites rely on the default.

**Unit fixtures.**

apply-merge-to-worktree.test.ts:
- Helpers: `buildSeededContext()`, `writeBlob(ctx, text)`, `treeWith(ctx, entries)` (line 49),
  `treeEntry(FILE_MODE.X, 'p' as FilePath, id)`, `index([...])` (line 72), `readWork(ctx, p)`.
- The row `Given an untracked working file at a path the merge adds` (line 1199) is the shape to
  copy.
- The gitlink oid can be any 40-hex (`'c'.repeat(40) as ObjectId`), since gitlinks are not read.

find-would-overwrite.test.ts: add `describe('resultModesOf')`, importing it from
src/application/primitives/find-would-overwrite.js.

**Interop suite — `test/integration/gitlink-added-over-directory-interop.test.ts` (new).**

`@proves`:
- `surface: repo.checkout, repo.merge.run, repo.cherryPick.run, repo.stash.apply`
- `bucket: cross-tool-interop`
- `unique: an added gitlink takes a directory standing at its path instead of refusing it as
  untracked, as canonical git does`
- `interopSurface: merge`

Use the same skip / `describe.each` ignorecase / `makePeerPair` frame as Part 1. Copy the
`occupantAt` helper.

*Axis 4 twin recipe* (`buildAdded(dir, ignorecase, { diverged, conflicting })`, git on both twins,
commits with `COMMIT_ENV`):
1. init/config as Part 1.
2. `a.txt`=`a\n`, `c.txt`=`c\n`; `add .`; `commit -qm base`.
3. `checkout -q -b G`; `update-index --add --cacheinfo 160000,$(rev-parse HEAD),new`.
4. If conflicting: `c.txt`=`theirs\n`, `add c.txt`.
5. `commit -qm gitlink`; `checkout -q main`; `rmSync(new, { recursive: true, force: true })`.
6. If conflicting: `c.txt`=`ours\n`, `add c.txt`.
7. If diverged or conflicting: `b.txt`=`b\n`, `add b.txt`, `commit -qm b`.
8. `mkdir new`; "new/x"=`x\n`.

Rows:

| Row | Fixture | git | tsgit | Expected |
|---|---|---|---|---|
| A1 | plain | `checkout G` | `repo.checkout({ rev: 'G' })` | exit 0, `160000 new` staged, "new/x" kept |
| A2 | plain | `merge --ff-only G` | `repo.merge.run({ rev: 'G', fastForward: 'only' })` | same |
| A3 | diverged | `merge --no-edit G` | `repo.merge.run({ rev: 'G' })` | same; HEAD subject equal |
| A3c | conflicting | `merge --no-edit G` | `repo.merge.run({ rev: 'G' })` | git exit 1; tsgit returns a conflict result (no throw); `lsStage` equal, stages 1/2/3 of `c.txt` and `160000 new`; "new/x" kept |
| A3r | diverged | `merge -s resolve --no-edit G` | `repo.merge.run({ rev: 'G', strategy: 'resolve' })` | exit 0, index equal, `git log -1 --format=%s` equal (`Merge branch 'G'`) |
| A4 | diverged | `cherry-pick G` | `repo.cherryPick.run({ commits: ['G'] })` | exit 0, index equal |
| A-file | plain, but occupant = file `new`=`precious\n` instead of the dir | `checkout G` | `repo.checkout({ rev: 'G' })` | git exit 1 + untracked-by-checkout message for `new`; tsgit `CHECKOUT_OVERWRITE_DIRTY { localChanges: [], untracked: ['new'] }`; nothing changes |

For A3c, read tsgit's result kind from the returned value and compare git's exit 1 against a
conflict kind. Check the field name with `command grep -n "kind: 'conflict'"
src/application/commands/merge.ts`.

*S3 / A5 (stash apply)*:
1. Use the Part 1 axis-1 recipe with placement index-only and occupant `dir`.
2. Run git `stash push` in BOTH twins (set-up, so only the apply is compared).
3. git `stash apply` vs `repo.stash.apply()`.
4. Expected: exit 0 both; `lsStage` equal (`a.txt` modified content and `160000 new`); status
   equal; "new/x" kept.

**Existing suites whose expectations may shift:**
- test/integration/merge-interop.test.ts, merge-conflict-interop.test.ts,
  merge-octopus-interop.test.ts, merge-gitlink-modify-delete-interop.test.ts
- test/integration/cherry-pick-interop.test.ts, revert-interop.test.ts
- test/integration/stash-apply-index-judge-interop.test.ts, stash-apply-type-change-interop.test.ts,
  stash-interop.test.ts
- test/integration/rebase-interop.test.ts
- test/unit/application/commands/merge.test.ts

### TDD steps

1. **RED (interop)** — write the whole suite.
   - Expected failures: A3c (`WORKING_TREE_DIRTY { untracked: ['new'] }` vs git exit 1 with
     `160000 new` staged), A3r (`MERGE_STRATEGY_FAILED`), A4 (`WORKING_TREE_DIRTY { untracked:
     ['new'] }`), S3 (`STASH_APPLY_WOULD_OVERWRITE { untracked: ['new'] }`).
   - Expected GUARDs: A1, A2, A3, A-file. If one of A1/A2/A3 is red, Part 3 missed a site: stop and
     report it.
2. **RED (unit, find-would-overwrite.test.ts)** — `Given clean outcomes of every kind, When
   resultModesOf runs`. Outcomes: `unchanged` (`a`, regular), `resolved-known` (`g`, GITLINK),
   `resolved-merged` (`m`, regular, bytes `Uint8Array.of()`), `resolved-deleted` (`d`), and one
   `conflict`. Expect `toEqual(new Map([['a', REGULAR], ['g', GITLINK], ['m', REGULAR]]))`. Fails:
   `resultModesOf is not a function`.
3. **GREEN** — `resultModesOf`.
4. **RED (unit, apply-merge-to-worktree.test.ts)** — `Given an untracked directory new holding x
   at a path theirs adds as a gitlink, When the merge is applied`: base `[]`, ours `[]`, theirs
   `[treeEntry(FILE_MODE.GITLINK, 'new', 'c'.repeat(40))]`, `${workDir}/new/x`=`x\n`. Expect
   `result.kind` to be the clean kind (check with `command grep -n "kind: '" src/application/
   primitives/apply-merge-to-worktree.ts`) and `readWork(ctx, 'new/x')` to be `x\n`. Fails:
   `would-overwrite` with `untracked: ['new']`.

   GUARD sibling: theirs adds the gitlink over a regular file `new` ⇒ `would-overwrite`,
   `untracked: ['new']`, bytes kept.
5. **GREEN** — wire apply-merge-to-worktree.ts. A4 and S3 go green.
6. **GREEN** — wire both merge.ts sites. A3c and A3r go green. Both sites have a RED interop row:
   A3c is the only consumer of `findOverwriteRefusal`, A3r of `workTreeTakes`. If A3r stays red
   after this step for a reason outside `workTreeTakes`, report `{ unit: 'merge resolve', reason,
   options }`. Do not chase it into the resolve strategy.
7. **REFACTOR** — none expected. Run the shifting suites above.

### Gate

`rm -rf .wireit && ./node_modules/.bin/vitest run test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/unit/application/commands/merge.test.ts test/integration/gitlink-added-over-directory-interop.test.ts test/integration/merge-interop.test.ts test/integration/merge-conflict-interop.test.ts test/integration/cherry-pick-interop.test.ts test/integration/revert-interop.test.ts test/integration/stash-apply-index-judge-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/find-would-overwrite.ts src/application/primitives/apply-merge-to-worktree.ts src/application/commands/merge.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/primitives/apply-merge-to-worktree.test.ts test/integration/gitlink-added-over-directory-interop.test.ts && npm run check:spelling`

### Commit

`fix(merge): let merge, cherry-pick and stash apply add a gitlink over a directory as git does`

## Part 5 — stash push -u stops its untracked walk at a gitlink

### Context

**Requirement:** R7, as corrected by a planning re-pin.

Re-pinned on git 2.56.0 (2026-11-18, both `core.ignorecase` values, both placements). The design's
O9 row said "no untracked commit"; that column was never actually captured (its probe did not read
`stash^3`), and it is wrong. git 2.56 `stash push -u` ALWAYS writes the untracked parent, even
with nothing untracked: its tree is the empty tree `4b825dc642cb6eb9a060e54bf8d69288fbee4904`. tsgit
already does the same (`writer.untracked(...)` runs whenever `includeUntracked === true`,
stash.ts about line 863).

The real divergence is narrower: whatever stands inside a stage-0 gitlink's directory never enters
that tree and is never cleaned. This holds for BOTH placements, which the design's O10 "match"
missed because its observer printed only `dir`.

| Fixture (`a.txt` edited, `stash push -u`) | git 2.56 | tsgit at 561b236a |
|---|---|---|
| index-only gitlink, "new/x" | U tree empty; "new/x" kept; status `?? new/x`; warning `Directory not empty` | U holds "new/x"; "new/x" removed |
| in-head gitlink, "new/x" | U tree empty; "new/x" kept; status empty | "new/x" removed |
| either placement, "new/x" + untracked `u.txt` | U tree lists only `u.txt`; `u.txt` removed; "new/x" kept | U also holds "new/x"; "new/x" removed |

- RED rows:
  - O9 (index-only, dir; interop + unit);
  - O10-u-dir (in-head, dir, push -u; interop + unit), moved here from Part 1;
  - the `u.txt` sibling (interop + unit).
- GUARD: S4 (apply after the O9 push). It matched before through tsgit's untracked-tree restore
  and must stay green through the Part 3–4 judge.

Files this part edits:
- `src/application/commands/stash.ts`
- `test/unit/application/commands/stash.test.ts`
- `test/integration/gitlink-removal-occupant-interop.test.ts`

**Current code (anchors at 561b236a).** In stash.ts, `listUntracked(ctx: Context, index:
GitIndex): Promise<UntrackedListing>` (lines 637–650):

```ts
  const tracked = new Set(index.entries.map(indexPathKey));
  const ignore = await buildRepoIgnorePredicate(ctx);
  …
  for await (const { path, stat } of walkWorkingTreeReporting(ctx, { ignore }, reportEmpty)) {
    if (tracked.has(keyOfPath(path))) continue;
```

Imports already present:
- `isGitlink` (line 24, from ../../domain/diff/index.js)
- `indexPathKey`, `keyOfPath` (lines 34–36, from the index-path-key module)
- `walkWorkingTreeReporting` (line 129)
- `buildRepoIgnorePredicate` (line 130, from ./internal/build-ignore-evaluator.js)

`WalkIgnorePredicate = (path: FilePath, isDirectory: boolean) => boolean | Promise<boolean>`
(src/application/primitives/types.ts line 262) is asked about every directory BEFORE descent, and
`true` prunes the subtree (no `lstat`, no `reportEmpty`). The walker's `path` is the same
repo-relative escaped form the existing `tracked.has(keyOfPath(path))` check relies on, so key the
gitlink set with `indexPathKey`. Precedent for "stage-0 gitlinks":
src/application/commands/internal/clean-work-tree.ts `gitlinkPaths` (lines 82–91).

Target:

```ts
const isStageZeroGitlink = (entry: IndexEntry): boolean =>
  entry.flags.stage === 0 && isGitlink(entry.mode);
// in listUntracked:
const gitlinks = new Set(index.entries.filter(isStageZeroGitlink).map(indexPathKey));
const repoIgnore = await buildRepoIgnorePredicate(ctx);
// A gitlink's directory is the submodule's checkout: its content is never the superproject's untracked data.
const ignore: WalkIgnorePredicate = (path, isDirectory) =>
  (isDirectory && gitlinks.has(keyOfPath(path))) || repoIgnore(path, isDirectory);
```

Check the `IndexEntry` and `WalkIgnorePredicate` imports with `command grep -n` and add them if
missing. Keep `listUntracked` ≤ 20 lines; extract `gitlinkPrunedIgnore(index, repoIgnore)` if
needed. The U commit itself is untouched: it is already written whenever `includeUntracked` is
set, and with nothing collected its tree is `emptyTreeOid(ctx.hashConfig)` (imported at line 49).

**Unit fixtures** (stash.test.ts):
- Helpers:
  - `setupRepo()` (line 88): `a.txt`=`committed\n`, committed
  - `write(ctx, path, content)` (line 61)
  - `stashPush`
  - `commitOf(ctx, id)`
  - `treeContent(ctx, tree, path)`: `'<absent>'` when missing
  - `lstatOrUndefined(ctx, p)`
- Other fixtures and helpers:
  - `replaceIndexEntries(ctx, entries)` (lines 169–180)
  - `indexEntryFromStat` (imported at line 26)
  - `GITLINK_A = 'a'.repeat(40)`
  - `commit(ctx, { message, author })` (used by `setupRepoWithSubmodule`, line 205)
- To stage an index-only gitlink `new` over a directory, write "new/x", then:
  `replaceIndexEntries(ctx, [...(await readIndex(ctx)).entries, indexEntryFromStat(await
  ctx.fs.lstat(`${ctx.layout.workDir}/new`), FILE_MODE.GITLINK as IndexEntry['mode'], GITLINK_A,
  'new' as FilePath)])`.
- For the in-head placement, follow it with `commit(ctx, { message: 'gitlink', author })`.
- The row to mirror is `Given untracked files with includeUntracked` (line 1455; `w.parents` has
  length 3, `w.parents[2]` is the U commit).

**Interop rows** (add to the Part 1 suite, inside the ignorecase `describe.each`; these are the
`(stash-push-u, dir)` cells Part 1 left out):
- O9 and O10-u-dir: axis-1 recipe, occupant `dir`, each placement. git `stash push -u` vs
  `repo.stash.push({ includeUntracked: true })`.
  - Compare across twins: exit; `git rev-parse stash^3^{tree}` (both
    `4b825dc642cb6eb9a060e54bf8d69288fbee4904`); `occupantAt(new)` (both `dir:x`); status
    (index-only `?? new/x`, in-head empty); `lsStage`; the warnings.
- Sibling: the same plus an untracked `u.txt`=`u\n`, both placements.
  - `git ls-tree -r --name-only stash^3` is `u.txt` in both twins.
  - `u.txt` is removed and "new/x" kept in both.
- S4: after the index-only O9 push, git `stash apply` vs `repo.stash.apply()`.
  - Exit 0 in both; `lsStage` equal (`160000 new` staged); status equal; "new/x" kept.

**Existing suites whose expectations may shift:**
- test/integration/stash-interop.test.ts, stash-push-reset-interop.test.ts
- test/unit/application/commands/stash.test.ts (gitlink rows around lines 157–260: a committed
  gitlink `sub` with a `.git` file inside is a nested-repo leaf today; after pruning it is never
  visited, which must not change any result)
- test/integration/status-gitlink-interop.test.ts (status does not use `listUntracked`; GUARD)

### TDD steps

1. **RED (interop)** — add O9, O10-u-dir, the `u.txt` sibling (both placements) and S4.
   - O9 and O10-u-dir fail: tsgit's `stash^3^{tree}` is not the empty tree (it holds "new/x"), and
     `occupantAt(new)` is `dir:` (emptied) vs `dir:x`.
   - The sibling fails: tsgit's U tree also lists "new/x".
   - S4 is a GUARD.
2. **RED (unit)** — `it.each` over `index-only` / `in-head`: `Given a <placement> gitlink new
   whose directory holds x and an edited a.txt, When push runs with includeUntracked`.
   - Assert: result `saved`; `w.parents` has length 3; `(await commitOf(ctx, w.parents[2])).tree`
     equals `emptyTreeOid(ctx.hashConfig)`; "new/x" still reads `x\n`.
   - Fails: the U tree holds "new/x", and "new/x" is removed.

   Sibling, `… and an untracked u.txt`: `treeContent(ctx, uTree, 'u.txt')` is `u\n`;
   `treeContent(ctx, uTree, 'new/x')` is `<absent>`; "new/x" kept; `u.txt` removed. Fails: the U
   tree holds "new/x".
3. **GREEN** — the gitlink-pruning `ignore` in `listUntracked`.
4. **REFACTOR** — function length. Run the shifting suites above.

### Gate

`rm -rf .wireit && ./node_modules/.bin/vitest run test/unit/application/commands/stash.test.ts test/integration/gitlink-removal-occupant-interop.test.ts test/integration/stash-interop.test.ts test/integration/stash-push-reset-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/gitlink-removal-occupant-interop.test.ts && npm run check:spelling`

### Commit

`fix(stash): stop push --include-untracked at a gitlink's directory as git does`

## Part 6 — document the gitlink occupant rules

### Context

Docs-only (no `src/` delta). Design §7.

Files this part edits:
- `docs/use/commands/reset.md`
- `docs/use/commands/checkout.md`
- `docs/use/commands/merge.md`
- `docs/use/commands/stash.md`
- `docs/BACKLOG.md`

Content:

reset.md, `## Behaviour` (line 30), after the `hard` displaces bullet (line 41):
- **A gitlink's path is only removed when it is an empty directory.** When the target drops a
  gitlink, a populated directory, a regular file or a symlink at its path stays (git's
  `unable to rmdir '<path>'` warning is logged through `logger.warn`, naming `Directory not empty`
  or `Not a directory`); the index drops the entry either way.

checkout.md, `## Behaviour` (line 41):
- the same bullet;
- a second one: **An added gitlink never counts a directory at its path as an untracked
  occupant.** The directory is the submodule's and is left as it is; a regular file or symlink
  there still refuses `untracked`.

merge.md, under `## Working tree and index` (line 94): the added-gitlink bullet, worded for
merge / cherry-pick / revert / stash apply.

stash.md, `## Behaviour` (line 73): **`includeUntracked` never collects what stands inside a
staged gitlink's directory.** It is the submodule's checkout: it is neither stored in the untracked
commit nor removed.

BACKLOG.md:
- Tick line 694: `- [ ] **32.44**` becomes `- [x] **32.44**`. Rewrite its statement to the
  corrected one:
  - the locus is the repository wrapper's dropped `rmdir`, not `materialize-tree.ts`;
  - every op that removes a gitlink lost the occupant (reset, checkout forced and two-way, stash
    push, merge ff/three-way, cherry-pick, revert, linked worktree);
  - the stash-apply follow-up exits 128 on git 2.56;
  - the two folded neighbours: an added gitlink over a directory, and `stash push -u` under a
    gitlink.
- Append `· ADRs 1205–1210 · design/gitlink-rmdir-keeps-occupant.md`, the format of line 677.
- In the `## Release order` table row 3 (line 46), strike `32.44` → `~~32.44~~`.

Prose rules:
- no ADR/part numbers in the use-docs;
- docs/BACKLOG.md may carry them (as line 677 does);
- run cspell on every file;
- check every relative link still resolves (`npm run check:doc-links` after `rm -rf .wireit`).

### TDD steps

1. **GUARD** — `npm run check:doc-links` and `npm run check:doc-coverage` are green before the
   edit (baseline).
2. **GREEN** — write the bullets and the backlog tick.
3. **GUARD** — re-run both checks plus cspell; they stay green.

### Gate

`rm -rf .wireit && npm run check:doc-links && npm run check:doc-coverage && npx cspell --no-progress docs/use/commands/reset.md docs/use/commands/checkout.md docs/use/commands/merge.md docs/use/commands/stash.md docs/BACKLOG.md`

### Commit

`docs: describe how a gitlink's path keeps or yields its occupant`

## Decision candidates

Choices this plan makes that no ADR pre-decides. The plan is written against each recommendation;
override before implementation starts.

| # | Choice | Alternatives | Recommendation | Why |
|---|---|---|---|---|
| P-1 | Part order: the D-B guard before the D-A forward | **A** guard first (Part 1 `fix`, Part 2 `fix!` = forward + L1). **B** forward first (the `!` commit fixes O/T rows; the guard part then only has rmdir-less unit REDs) | **A** | With A, the breaking commit contains exactly the one behaviour that breaks (L1), so the changelog entry for the major is precise. Every O/T/S row gets a real RED→GREEN in a `fix` commit, and the end state is identical |
| P-2 | `findWouldOverwrite` result-mode carrier | **A** a 5th defaulted `resultModes` map + `resultModesOf`. **B** replace `paths: ReadonlySet` with a `ReadonlyMap<FilePath, FileMode>`. **C** a sibling `addedGitlinks` set | **A** | B rewrites ~35 unit call sites and the property suite for no behaviour. C would make the `add` shape's `mode` a synthesized lie for regular paths. A carries the real mode where one exists and is honest about the conflict fallback |
| P-3 | Where the axis-4 interop lives | **A** a second new suite (`gitlink-added-over-directory-interop.test.ts`) in Part 4. **B** one suite as the design sketches | **A** | The axis-4 fixture is unrelated to the removal fixture, and splitting keeps each part within the 6-file ceiling |

## Hand-verify covering set (validation phase)

Stryker runs on narrowed eponymous corpora. A survivor that only an importer's test would kill is
hand-verified against this full set before writing any kill test.

**Unit suites of each edited file:**
- test/unit/repository/wrap-fs-validator.test.ts and wrap-fs-validator.properties.test.ts
- test/unit/application/primitives/internal/empty-directories.test.ts
- test/unit/application/primitives/internal/prune-emptied-directories.test.ts
- test/unit/application/primitives/apply-changeset.test.ts
- test/unit/application/primitives/internal/occupant-clash.test.ts
- test/unit/application/primitives/find-would-overwrite.test.ts and
  find-would-overwrite.properties.test.ts
- test/unit/application/primitives/apply-merge-to-worktree.test.ts
- test/unit/application/commands/merge.test.ts
- test/unit/application/commands/stash.test.ts
- test/unit/application/primitives/record-ref-update.test.ts
- test/unit/repository/repository.test.ts
- importers of the moved helper: test/unit/application/commands/rm.test.ts

**Interop suites named by the consumer table:**
- test/integration/gitlink-removal-occupant-interop.test.ts and
  gitlink-added-over-directory-interop.test.ts
- test/integration/checkout-*.test.ts
- test/integration/reset-interop.test.ts, rebase-reset-interop.test.ts
- test/integration/stash-*.test.ts
- test/integration/merge-interop.test.ts, merge-conflict-interop.test.ts,
  merge-octopus-interop.test.ts, merge-gitlink-modify-delete-interop.test.ts,
  merge-abort-interop.test.ts
- test/integration/cherry-pick-interop.test.ts
- test/integration/revert-interop.test.ts
- test/integration/ref-transaction-interop.test.ts, reflog-interop.test.ts, reflog-writers.test.ts
- test/integration/worktree-interop.test.ts
- test/integration/gitlink-consumers-interop.test.ts
- test/integration/rm-interop.test.ts

The wrapper sits under every interop suite, so validation also runs a full
`npm run test:integration`, not a sampled pass.

**Mutation targets:**
- src/repository/wrap-fs-validator.ts (`guardedRmdir`)
- src/application/primitives/internal/empty-directories.ts (`removeIfEmptyDirectory`,
  `isRealDirectory`)
- src/application/primitives/internal/prune-emptied-directories.ts (import only)
- src/application/primitives/apply-changeset.ts (`removeGitlinkDirectory`,
  `warnUnremovedGitlink`, the two add call sites)
- src/application/primitives/internal/occupant-clash.ts (`classifyAddedPath`)
- src/application/primitives/find-would-overwrite.ts (`untrackedSquat` mode, `resultModesOf`)
- src/application/commands/stash.ts (`listUntracked` ignore)

apply-merge-to-worktree.ts and merge.ts carry only an argument each; no mutant there changes an
operator.
