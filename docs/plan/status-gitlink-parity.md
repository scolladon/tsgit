# Plan — status and the comparison consumers treat a gitlink as git does

> Source: design doc `docs/design/status-gitlink-parity.md` · ADRs 1063, 1064, 1065, 1066, 1067, 1068, 1069, 1070
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
  files in its `### Context` block, is two parts. What counts is a back-ticked path:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Rules every part follows

- Parts are serial and share one working tree on `fix/status-gitlink-parity`; each builds on
  the previous commit. Implementer agents have Read/Grep/Glob/Bash/Write/Edit only — the
  Context block is the whole map. Line numbers are at base `95704e7d`; re-locate by symbol
  name if an earlier part shifted them.
- **One RED per function, run before its code.** Write the RED test, run it, see it fail for
  the stated reason, then write the GREEN. Never batch REDs across functions; never write
  GREEN first. A GUARD row is written and run where the step list places it and must pass
  there; if a RED passes on first run, stop and report it (the plan was wrong), do not
  relabel silently.
- Tests: `describe('Given …')` > `describe('When …')` > `it('Then …')` (2-level shortcut
  allowed for one expectation), AAA with `// Arrange` / `// Act` / `// Assert`, SUT in a
  variable named `sut`. Error rows use try/catch and assert `err.data` (code + every field),
  never `toThrow(Class)` alone. One row per guard condition. No `v8 ignore`,
  `istanbul ignore`, `stryker-disable`, `biome-ignore`, `@ts-ignore`. No phase, ADR, backlog
  or design-row ids (ST1, CO21, …) in source or test code — describe the shape instead.
- Coverage is 100% line/branch/function/statement on `src/`: every new branch gets its unit
  row in the same part.
- Interop twins: git **2.55** (`PATH="$HOME/.local/git-2.55.0/bin:$PATH"`), scrubbed env via
  `runGitEnv()`, signing off, commits with `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` pinned to
  `@1700000000 +0000` (copy the suite-local `pinnedEnv()` / `commitIn()` pattern from
  test/integration/status-embedded-repository-interop.test.ts L33-55 — they are not exported).
  Build each fixture once in a `mkdtemp` dir, then copy it twice with
  `cp(src, dst, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })`
  (node:fs/promises) into a git twin and a tsgit twin; create FIFOs and sparse files AFTER the
  copy, in each twin (`makeFifo`, `makeSparseFile`, `OVERSIZED_GITFILE_BYTES`,
  `NON_BLOCKING_TIMEOUT_MS` from test/integration/interop-helpers.ts). Build the tsgit
  `Context` (`createNodeContext({ workDir })`) AFTER every git write. Rows with a FIFO or an
  oversized file carry an explicit timeout. Submodules are made with
  `git -c protocol.file.allow=always submodule add <up> sub`. Suites start with the
  `@proves` header (`surface`, `bucket: cross-tool-interop`, `unique`, `interopSurface`) like
  status-embedded-repository-interop.test.ts L1-9, and are wrapped in
  `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`.
- Structured output only (ADR-249): the library emits no display string; the interop test
  rebuilds git's porcelain v2 line from the `ChangedPath` fields and compares it with git's.
- "To pin" rows: run the git twin FIRST, record git's exit code / stderr / resulting state,
  then write the tsgit assertion to match git. If git disagrees with the expectation written
  here, git wins and the hand-back says so. If tsgit then diverges and the fix lies in a file
  this part already edits, fold it here; otherwise stop and hand back
  `{ unit, reason, ≤3 options }` with the red row — never widen the part silently.
- Never rewrite an existing test row to match new code. The four old comparison rows listed
  in Part 2 are re-pinned to git's behaviour exactly as written there; every other existing
  row stays as is.
- No part raises a `check:size` / `check:tarball` cap. If `npm run check:size` trips, record
  the measured delta in the hand-back and continue.
- Gate caveat: wireit caches `check:types` / `check:spelling` ("Ran 0 scripts and skipped 1"
  is not a pass). Every part also runs the bare `npx tsc --noEmit -p tsconfig.json` and
  `npx cspell --no-progress <touched files>`.
- Commit: `git commit -m "<message>"`, one line, no body, only the part's files
  (`git add <each file>`; never `git add -A`). Never commit on a red gate; never `--no-verify`.

## Requirement map

| Req | Part(s) |
|---|---|
| R1 HEAD comparison, worktree mode 160000 | 1 (reader move), 2 |
| R2 file/symlink at the path is `type-changed` | 2 |
| R3 symlinked leading directory reads `absent` | 4 |
| R4 a gitlink is never refreshed | 2 |
| R5 status dirty check (refusals, child flags, child index write, child error) | 5, 6, 7, 9 |
| R6 ignore mode resolution and modes | 8, 9 |
| R7 consumers ignore gitlinks | 10, 11, 12 |
| R8 rm of a gitlink | 13, 14 |
| R9 no other behaviour change; every interop suite stays green | every part's gate |
| ADR-1064 `ChangedPath.submodule` | 3 (field + commit flag), 6 (tracked/untracked flags) |

## Decision candidates

Load-bearing choices the design and ADRs leave open. The plan is written against the
recommendation; the orchestrator confirms or redirects before Part 5.

| # | Choice | Alternatives | Recommendation | Why |
|---|---|---|---|---|
| D1 | How the dirty check runs the child's status without an import cycle (`status.ts` imports the new module; `check:architecture` / depcruise `no-circular` forbids the module importing `status.ts` back at runtime) | A. The module takes a `childStatus: (child: Context) => Promise<StatusResult>` parameter; `status.ts` and `rm.ts` pass `status` (type-only import of `StatusResult` is allowed). B. Extract the status core into a third module both import. C. Keep the child call inline in `status.ts`; the module only maps a `StatusResult` to flags | A | Smallest diff, keeps the dirty check in the module ADR-1063 names, and `rm` (ADR-1066) reuses it unchanged. B moves 400 lines. C splits the dirty check across two files and makes `rm` duplicate it |
| D2 | How the module reaches the child repository | A. Add `context: () => Promise<Context>` to the `repository` variant of `GitlinkCheckout`, built exactly as `head()` builds its child (`deriveGitlinkContext` + `refStorageOf`). B. Re-locate `<path>/.git` inside the module. C. Expose `gitDir`/`commonDir`/`fs` on the variant | A | One derivation, same bounds as lesson 008; B forks the locator #326 pinned; C leaks the locator's internals to every caller |
| D3 | `rm` of a submodule while the working `.gitmodules` has unstaged changes (git is expected to refuse; not pinned by the design) | A. Reuse an existing code (e.g. `RM_LOCAL_MODIFICATIONS { paths: ['.gitmodules'] }`). B. New error code naming the condition (needs an ADR, public surface). C. Pin in Part 14 and stop with a blocker if git refuses | C, then B | A misnames the condition; a new public code is a user decision, as ADR-1069 was |
| D4 | stash's "index differs from HEAD only at gitlinks" test (git runs `diff-index --cached --ignore-submodules`) | A. Flatten HEAD and compare non-gitlink index entries when `iTree !== bTree`. B. Reuse `diffIndexAgainstTreeKeyed(index, headTree)` and drop changes where both sides are gitlinks or one side is absent and the other a gitlink. C. Synthesize a second tree with gitlinks replaced by HEAD's | B | Reuses status's own diff; keeps git's rule that a gitlink↔file type change still counts |
| D5 | Where the `SUBMODULE_PATH_IS_SYMLINK` error member lands | A. Its own part (Part 7) with its domain test; its throw site lands in Part 9. B. Merged with its throw site (8 files, over the 6-file ceiling). C. Throw site first, `reports/api.json` deferred to a closing docs part | A | Keeps every part ≤ 6 files and `reports/api.json` in the part that changes the surface. Part 7's gate runs `npx knip` to confirm an export used only by tests is not reported; if it is, stop and hand back (fallback: B) |

## Part 1 — Move the gitlink reader to the primitives tier

### Context

ADR-1065: a primitive will need the reader, and the dependency rule `commands → primitives → domain` (enforced by `check:architecture`, rule `primitives-cannot-import-commands` in .dependency-cruiser.cjs) forbids a primitive importing from commands. Move it unchanged. Internal module: no barrel, no public surface.

Files:
- `src/application/commands/internal/gitlink-head.ts` — moved away (314 lines). Use `git mv` to the new path so history follows.
- `src/application/primitives/internal/gitlink-head.ts` — the moved module. Rewrite its imports L10-17: `../../primitives/internal/<x>.js` becomes `./<x>.js` (gitlink-ref-storage, head-file, join-working-tree-path, repo-state, submodule-context, worktree-context); ../../primitives/object-store.js becomes ../object-store.js; ../../primitives/resolve-ref.js becomes ../resolve-ref.js. Domain and ports imports (`../../../domain/…`, `../../../ports/…`) keep the same depth and do not change. Body unchanged, including `requireWorkTree(ctx, 'add')` at L81 (unreachable from the primitive, ADR-1065 keeps it).
- `test/unit/application/commands/internal/gitlink-head.test.ts` — moved away (864 lines), `git mv`.
- `test/unit/application/primitives/internal/gitlink-head.test.ts` — the moved suite; only its import path of the module changes (L3-6: `…/src/application/commands/internal/gitlink-head.js` becomes `…/src/application/primitives/internal/gitlink-head.js`, same depth). Every row unchanged.
- `src/application/commands/add.ts` — L99 `import { gitlinkHeadOf } from './internal/gitlink-head.js'` becomes `'../primitives/internal/gitlink-head.js'`.
- `src/application/commands/internal/embedded-repository.ts` — L6 `import { type GitlinkCheckout, probeGitlinkCheckout } from './gitlink-head.js'` becomes `'../../primitives/internal/gitlink-head.js'`.

Exports of the module (unchanged): `type GitlinkCheckout = { kind: 'none' } | { kind: 'oversized'; shown: FilePath } | { kind: 'broken'; shown: FilePath } | { kind: 'repository'; head: () => Promise<ObjectId | undefined> }`; `gitlinkHeadOf(ctx: Context, path: FilePath): Promise<ObjectId | undefined>`; `probeGitlinkCheckout(ctx: Context, path: FilePath): Promise<GitlinkCheckout>`.

After the move, `grep -rn "commands/internal/gitlink-head" src test` must be empty. ADRs, lessons and the design doc are historical records: do not edit them.

### TDD steps

One RED per function, run before its code. This part is a behaviour-preserving move: it has no RED.

1. GUARD — the moved suite test/unit/application/primitives/internal/gitlink-head.test.ts passes unchanged at its new path (it passed at base under the old path; only the import specifier moved).
2. GUARD — test/unit/application/commands/add-gitlink.test.ts, add-embedded-repository.test.ts and status-embedded-repository.test.ts pass (they were green at base and exercise both importers).
3. GUARD — `npx depcruise src/ --config .dependency-cruiser.cjs` reports no violation (the module imports only primitives, domain and ports).
4. REFACTOR — none beyond the import rewrites.

### Gate

```
npx vitest run test/unit/application/primitives/internal/gitlink-head test/unit/application/commands/add-gitlink test/unit/application/commands/add-embedded-repository test/unit/application/commands/status-embedded-repository && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/gitlink-head.ts src/application/commands/add.ts src/application/commands/internal/embedded-repository.ts test/unit/application/primitives/internal/gitlink-head.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/primitives/internal/gitlink-head.ts test/unit/application/primitives/internal/gitlink-head.test.ts
npx depcruise src/ --config .dependency-cruiser.cjs
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/add-gitlink-interop.test.ts test/integration/add-embedded-repository-interop.test.ts test/integration/status-embedded-repository-interop.test.ts
```

### Commit

`fix(primitives): move the gitlink reader to the primitives tier`

## Part 2 — Compare a gitlink with its submodule's HEAD and never refresh it

### Context

R1, R2, R4; ADR-1063 (first layer only: the HEAD comparison never refuses). After this part a dirty-but-unmoved submodule reads clean in `status` until Part 6 adds the dirty check — expected, no existing row pins it.

Files:
- `src/application/primitives/compare-working-tree-entry.ts` — the only source file.
- `test/unit/application/primitives/compare-working-tree-entry.test.ts` — re-pin four rows, add the new rows.
- `test/integration/status-gitlink-interop.test.ts` — NEW suite (F1 fixture builder + the field comparator), extended by Parts 3, 4, 5, 6, 8, 9.

Current code (compare-working-tree-entry.ts):
- `compareAndRefresh(ctx: Context, entry: IndexEntry, scope: ComparisonScope = {}): Promise<RefreshedComparison>` L256-270: `isLossy` → `absent`; `lstat` (catch → `absent`); `deriveWorkingMode(stat)`; `statOnlyVerdict(entry, stat, worktreeMode, scope.indexMtime)` L119-148 (its L125 `if (entry.mode === FILE_MODE.GITLINK) return undefined;`); else `compareContent` L203-238 (an unreadable directory gives `{ status: 'modified', worktreeMode }` at L222); then `shouldRefresh(entry, stat)` L245-250.
- `deriveWorkingMode` (src/domain/objects/file-mode.ts L110-116) maps a directory to `100755`. `FILE_MODE.GITLINK === '160000'`.
- `ComparisonScope { provider?, indexMtime?, filterDriversConfigured? }` L182-187.

Change:
- New internal arm reached from `compareAndRefresh` after the `absent` returns and before `statOnlyVerdict`, for `entry.mode === FILE_MODE.GITLINK`:
  - assume-valid short-circuit first: `entry.flags.assumeValid && scope.indexMtime !== undefined` → `{ status: 'unchanged', worktreeMode: FILE_MODE.GITLINK }` without any probe (git's `CE_VALID`);
  - not a directory (`!stat.isDirectory`, i.e. file or symlink) → `{ status: 'type-changed', worktreeMode: deriveWorkingMode(stat) }`;
  - directory → `checkedOutHead(ctx, entry.path)`; `undefined` or equal to `entry.id` → `unchanged`, else `modified`; `worktreeMode: FILE_MODE.GITLINK`.
- `checkedOutHead`: `probeGitlinkCheckout` (from ./internal/gitlink-head.js after Part 1); `none` / `broken` / `oversized` → `undefined`; `repository` → `await checkout.head()`, catching a `TsgitError` (e.g. the repository-format refusal `refStorageOf` raises inside `head()`) → `undefined`; anything that is not a `TsgitError` is rethrown unchanged.
- `statOnlyVerdict` loses the L125 guard (gitlinks never reach it).
- `shouldRefresh` gains `entry.mode !== FILE_MODE.GITLINK`; rewrite its comment (L240-244) to the reason: git's `refresh_cache_ent` returns a matching gitlink without marking it up to date or filling its stat data.
- Rewrite the header comment L1-21 (L6-7 "gitlink/submodule entries are excluded — git reports them as M", L14-16 consumer list) and the `statOnlyVerdict` doc L109-118 so they state git's HEAD comparison and the never-refresh rule. No ADR, backlog or row ids in comments.

Unit fixtures (memory adapter): rows build a gitlink entry from a seeded file entry, as the existing rows do (`const { ctx, entry } = await seedFile('a.txt', 'hello\n'); const gitlinkEntry: IndexEntry = { ...entry, path: 'sub' as typeof entry.path, mode: '160000' };`, `work(ctx, name)` L41). For a checked-out submodule lay out the module as test/unit/application/commands/add-gitlink.test.ts does (`layOutModule` L63-81, `layOutCheckout` 'absorbed' L137-142): sub/.git holds `gitdir: ../.git/modules/sub\n`, the module dir holds `HEAD` (`ref: refs/heads/main\n`), objects/, refs/, and refs/heads/main holding the commit id. Use `entry.id` as the branch value for "HEAD equals the entry" and `'b'.repeat(40)` for "moved". The refresh rows use `stagedThenRewritten` (L1236). The format-refusal row writes `[core]\n\trepositoryformatversion = 2\n` into the module's `config` (a version above 1 refuses in `refStorageOf`).

Old rows re-pinned (design "Old unit rows — verdicts"):
- L282-297 "Then returns 'modified', not 'type-changed'…" → title and expectation become: an empty directory gitlink is `unchanged` with `worktreeMode: '160000'` (use `compareWorkingTreeDelta` to see the mode).
- L371-401 size-shortcut row → `status: 'unchanged'` and `reads` stays `[]` (the gitlink arm precedes `statOnlyVerdict`; no read of the directory).
- L574-590 assume-valid row → `unchanged`, and a spied `lstat`/`readSlice` never names sub/.git.
- L1361-1369 "Then a gitlink is modified and never refreshed" → "Then a gitlink whose HEAD matches is unchanged and never refreshed": `delta.status === 'unchanged'`, `refreshed` undefined.

Interop suite (new): F1 = upstream `up` (`git init -b main`, file `u` = `u\n`, commit) and superproject (`k` = `k\n`, commit, `git -c protocol.file.allow=always submodule add <up> sub`, commit), all with pinned dates and `-c user.name=t -c user.email=t@t -c commit.gpgsign=false`. "Moved" = a commit `z` made inside `sub`. Comparator for this part: run `git status --porcelain=v2 -uall` in the git twin, take the `1 …` line whose path is `sub`, split it into `XY sub mH mI mW hH hI path`, and compare every field except `sub` with tsgit's `ChangedPath` for `sub` (X/Y from `staged`/`unstaged`: modified and mode-changed → M, type-changed → T, deleted → D, added → A, none → `.`; `mH`/`mI` from `head.mode`/`index.mode`; `mW` from `worktree?.mode ?? '000000'`; `hH`/`hI` from the ids). No git line ⇔ no tsgit row; untracked lists compared too.

Pinned bytes this part reproduces (git 2.55, default `status`):
- populated unmoved; `submodule deinit -f sub`; emptied + .git/modules removed; empty with .git/modules/sub moved away; sub/.git removed with sub/u kept (module dir kept, and again with the module HEAD moved); detached at the recorded commit: exit 0, no line.
- moved; moved to a commit fetched from an unrelated repository; embedded .git directory (module dir moved into sub/.git) and moved: `1 .M SC.. 160000 160000 160000 <A> <A> sub`.
- replaced by a file `f`: `1 .T S... 160000 160000 100644 <A> <A> sub`; by an executable file: mW `100755`.
- removed: `1 .D S... 160000 160000 000000 <A> <A> sub`.
- moved + `update-index --skip-worktree sub` (with and without sub/u edited): no line. Moved + `update-index --assume-unchanged sub` (with and without sub/u edited): no line. Untracked sub/n ignored by the submodule's info/exclude: no line.
- index bytes: sub/x created then removed and `touch sub` after two settling `status` runs more than 1 s apart → .git/index bytes unchanged by tsgit `status` (compare bytes before/after in the tsgit twin and in the git twin); moved then `status` → index unchanged; `k` staged + moved + commit → tree entry `sub` = `<A>` and `git ls-files --debug sub` in the tsgit twin shows `mtime: 0:0` and `size: 0`.
- tsgit-only: module `HEAD` replaced by a FIFO → `status(ctx)` settles (resolves or rejects) within `NON_BLOCKING_TIMEOUT_MS`; assert only that it settles (git itself hangs, no twin). If it hangs, the probe's HEAD read is the cause and the fold lands here.

### TDD steps

One RED per function, run before its code.

1. RED — `compareWorkingTreeDelta` on a gitlink whose checkout HEAD is `'b'.repeat(40)` (moved) returns `{ status: 'modified', worktreeMode: '160000' }`. Fails: today `compareContent` cannot read the directory and answers `worktreeMode: '100755'`.
2. GREEN — add the gitlink arm (directory branch with `checkedOutHead`, `none`/`broken`/`oversized` → `undefined`) and drop the L125 guard.
3. GUARD — re-pinned L282-297: empty directory → `unchanged` / `160000` (passes: GREEN 2 maps `none` to a match). Add siblings, each a GUARD for the same reason: HEAD equal to `entry.id` → `unchanged`; `sub/.git` an empty directory (`broken`) → `unchanged`; `sub/.git` a gitfile over `1 << 20` bytes (`oversized`) → `unchanged`. GUARD — re-pinned L371-401 (arm precedes `statOnlyVerdict`, so no read).
4. RED — a regular file at the gitlink path → `{ status: 'type-changed', worktreeMode: '100644' }`. Fails: GREEN 2 probes a file path and answers `unchanged` / `160000`.
5. GREEN — `!stat.isDirectory` → `type-changed` with `deriveWorkingMode(stat)`. GUARD rows: executable file → `100755`; symlink at the path → `120000` (same branch).
6. RED — module `config` declaring `repositoryformatversion = 2`, HEAD moved → `unchanged`. Fails: `head()` lets the `REPOSITORY_FORMAT_VERSION_UNSUPPORTED` refusal escape `compareAndRefresh`.
7. GREEN — `checkedOutHead` catches `TsgitError` around `head()`; rethrows anything else. GUARD — a fake `fs` whose module `config` read rejects with a plain `Error('boom')` makes `compareAndRefresh` reject with that same error (passes: GREEN 7 narrows to `TsgitError`).
8. RED — re-pinned L574-590: assume-valid gitlink, HEAD moved, `indexMtime` supplied → `unchanged`, and the spied fs never touches `sub/.git`. Fails: GREEN 2 probes and answers `modified`.
9. GREEN — assume-valid short-circuit at the top of the arm. GUARD — the same entry without `indexMtime` still probes and answers `modified` (isolates the `indexMtime` conjunct).
10. RED — re-pinned L1361-1369: HEAD matches → `delta.status === 'unchanged'` and `refreshed` undefined. Fails: `shouldRefresh` refreshes it (zero stat vs directory stat).
11. GREEN — `shouldRefresh` gains the gitlink guard.
12. Interop — create test/integration/status-gitlink-interop.test.ts with F1, the comparator above and the rows listed under "Pinned bytes" (each `it` with a 60 s timeout; the settle-twice row waits 1.1 s between runs; the FIFO row uses `NON_BLOCKING_TIMEOUT_MS`). All rows must pass.
13. REFACTOR — rewrite the comments named in Context; keep each function under 20 lines.

### Gate

```
npx vitest run test/unit/application/primitives/compare-working-tree-entry test/unit/application/primitives/internal/scan-tracked-entries test/unit/application/primitives/internal/smudge-racily-clean test/unit/application/commands/status test/unit/application/commands/add-gitlink test/unit/application/commands/stash test/unit/application/commands/rm && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/compare-working-tree-entry.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/integration/status-gitlink-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/primitives/compare-working-tree-entry.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/integration/status-gitlink-interop.test.ts
npx depcruise src/ --config .dependency-cruiser.cjs
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/status-gitlink-interop.test.ts test/integration/status-interop.test.ts test/integration/status-refresh-interop.test.ts test/integration/status-racy-clean-interop.test.ts test/integration/commit-cache-tree-interop.test.ts test/integration/submodule-init-sync-deinit-interop.test.ts test/integration/add-gitlink-interop.test.ts
```

### Commit

`fix(status): compare a gitlink with its submodule's HEAD and never refresh it`

## Part 3 — Report git's submodule field on gitlink rows

### Context

ADR-1064: `ChangedPath.submodule?: { commitChanged, trackedChanges, untrackedChanges }`. **Public** field on an exported type. Decision taken here: the field type is an inline object type on `ChangedPath` (no new named export, so no barrel entry in src/application/commands/index.ts L364-374); Part 5's internal module refers to it as `NonNullable<ChangedPath['submodule']>` through a type-only import. Surface gates paid in this part: `docs/use/commands/status.md` and `reports/api.json` (`npm run docs:json`, commit the regenerated file — `validate` does not catch its staleness, the prepush hook does).

Files:
- `src/application/commands/status.ts` — `ChangedPath` L84-91 gains `readonly submodule?: { readonly commitChanged: boolean; readonly trackedChanges: boolean; readonly untrackedChanges: boolean };` with a doc comment (git's porcelain v2 `S<c><m><u>`; present on a row whose HEAD or index side is a gitlink, absent otherwise). `buildChangedPath(path, staged, delta, headTree, indexEntry)` L379-396 sets it. In this part `commitChanged` = the row's index side is a gitlink and `delta?.status === 'modified'` (subject to the staged-row pin below); `trackedChanges` and `untrackedChanges` are `false` (Part 6 sets them).
- `test/unit/application/commands/status-gitlink.test.ts` — NEW unit suite for status-level gitlink rows (extended by Parts 5, 6, 8, 9). Fixtures: `seedRepo` (test/unit/application/commands/fixtures.ts L65) and `seedIndex(ctx, rows)` (test/unit/application/commands/add-index-fixtures.ts L51; `IndexRow { path, text, stage?, mode?, skipWorktree? }`, the entry id is the blob id of `text`, stat zeroed). Lay out the module like test/unit/application/commands/add-gitlink.test.ts L58-200 (`superproject`, `layOutModule`, `layOutCheckout`); to make the module HEAD equal the recorded id, write the blob id of the row's `text` into the module's refs/heads/main.
- `test/integration/status-gitlink-interop.test.ts` — the comparator now rebuilds the whole v2 line, `sub` field included: `S` + (`commitChanged` ? `C` : `.`) + (`trackedChanges` ? `M` : `.`) + (`untrackedChanges` ? `U` : `.`) when `submodule` is present, `N...` otherwise. Every Part 2 row now compares the full line (expectations stay git's output).
- `docs/use/commands/status.md` — add the field to the `ChangedPath` interface in the Signature block (L36-43), and replace the L67 sentence "A gitlink/submodule entry stays `modified` (git reports a submodule as `M`, not `T`)." with git's rule: a gitlink compares the submodule's checked-out HEAD (unresolvable counts as unchanged), its worktree mode is `160000` over a directory, a file or symlink at its path is `type-changed`, and `submodule` carries the three flags (`commitChanged` = HEAD moved, `trackedChanges` = the submodule's own status shows tracked changes, `untrackedChanges` = it holds untracked files); show how to rebuild `S<c><m><u>`.
- `reports/api.json` — regenerated.

Pinned bytes:
- moved: `1 .M SC.. 160000 160000 160000 <A> <A> sub`; file at path: `1 .T S... … 100644 …`; removed: `1 .D S... … 000000 …`; a non-gitlink modified file row: `1 .M N... 100644 100644 100644 …`.
- To pin: staged gitlink (moved, then `git add sub`) — git's line (`M.` with either `S...` or `SC..`); staged deletion (`git rm --cached sub`) — git's line (expected `D. S... 160000 000000 000000 <A> 0000… sub`).

### TDD steps

One RED per function, run before its code.

1. RED — status-gitlink unit: a moved gitlink row equals `{ path: 'sub', unstaged: 'modified', head/index: 160000 sides, worktree: { mode: '160000' }, submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false } }`. Fails: `buildChangedPath` sets no `submodule`.
2. GREEN — set the field when the index side is a gitlink.
3. GUARD — a file at the path row carries `submodule` with all three `false` (passes: GREEN 2 keys on the index side, and `type-changed` is not `modified`). GUARD — a modified regular file row has no `submodule` key (`expect('submodule' in row).toBe(false)`).
4. Pin (git first) the staged-deletion row. RED — tsgit's staged-deletion row carries `submodule` (all `false`). Fails: GREEN 2 keys on the index side, which is absent.
5. GREEN — present when the HEAD side or the index side is a gitlink.
6. Pin (git first) the staged gitlink row. If git prints `SC..`, write it as a RED (commitChanged also follows a staged commit change; fails: GREEN 2 derives it from the worktree delta only) then GREEN; if git prints `S...`, it is a GUARD (passes: the worktree delta is `unchanged`).
7. Interop — switch the comparator to the full line; add the staged-gitlink and staged-deletion rows.
8. Docs — status.md as described; run `npm run docs:json` and stage `reports/api.json`.
9. REFACTOR — keep `buildChangedPath` under 20 lines (extract a `submoduleOf(...)` helper).

### Gate

```
npx vitest run test/unit/application/commands/status && npm run check:types && ./node_modules/.bin/biome check src/application/commands/status.ts test/unit/application/commands/status-gitlink.test.ts test/integration/status-gitlink-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/commands/status.ts test/unit/application/commands/status-gitlink.test.ts test/integration/status-gitlink-interop.test.ts docs/use/commands/status.md
npm run check:doc-coverage && npm run check:doc-links
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/status-gitlink-interop.test.ts test/integration/status-interop.test.ts test/integration/submodule-init-sync-deinit-interop.test.ts
```

### Commit

`fix(status): report git's submodule field on gitlink rows`

## Part 4 — Read a tracked path below a symlinked directory as deleted

### Context

R3; ADR-1067. git's `check_removed` → `has_symlink_leading_path`: a tracked path whose leading directory is a symlink is deleted, for every mode. Today the comparison follows the link.

Files:
- `src/application/primitives/compare-working-tree-entry.ts` — `ComparisonScope` (L182-187) gains `readonly scanner?: LeadingPathScanner`. In `compareAndRefresh`, after `isLossy` and after its own `requireWorkTree(ctx, 'compareWorkingTreeEntry')` (so a bare repository still refuses under that name), before the `lstat`, `await (scope.scanner ?? createLeadingPathScanner(ctx)).hasSymlinkedLeadingPath(entry.path)` → `{ delta: { status: 'absent' } }`. A rejection of that check reads `absent`, the same verdict L263's `lstat(...).catch(() => undefined)` gives today, so no new throw reaches `status` (a denied leading directory read `absent` before and must still).
- `test/unit/application/primitives/compare-working-tree-entry.test.ts` — new rows.
- `src/application/primitives/internal/scan-tracked-entries.ts` — `scanWorkingTree(ctx, stage0, onScanned, provider, indexMtime)` L61-83 creates one `createLeadingPathScanner(ctx)` per scan and `scanEntry` (L34-48) passes it in the scope object it builds for `compareAndRefresh`.
- `test/unit/application/primitives/internal/scan-tracked-entries.test.ts` — the shared-scanner row.
- `test/integration/status-gitlink-interop.test.ts` — two rows.

Read-only: src/application/primitives/internal/symlinked-leading-path.ts — `createLeadingPathScanner(ctx: Context): LeadingPathScanner` L56; `hasSymlinkedLeadingPath(path: FilePath): Promise<boolean>` scans directories only (never the leaf; root-level paths cost no `lstat`), memoizes one verdict per prefix, rethrows a non-`FILE_NOT_FOUND` `lstat` failure.

Pinned bytes (git 2.55, `status --porcelain=v2 -uall`):
- gitlink d/sub committed, then `d` moved out and replaced by a symlink to it: `1 .D S... 160000 160000 000000 <A> <A> d/sub` and `? d`.
- regular d/f committed, then `d` replaced by a symlink to a copy: `1 .D N... 100644 100644 000000 <id> <id> d/f` and `? d`.

Performance: the check adds at most one `lstat` per distinct leading directory per scan. After the commit, run `npm run bench:ab` against the previous commit (check the machine is quiet first: `uptime`, no foreign stryker process) and put the numbers in the hand-back.

### TDD steps

One RED per function, run before its code.

1. GUARD (at base, before any code) — a regular file `d/f` whose leading directory `d` cannot be `lstat`ed (fake fs rejecting `lstat` of `<work>/d` with `PERMISSION_DENIED`) reads `absent` (passes today: L263 maps any `lstat` failure to `absent`); it must stay green after GREEN 3.
2. RED — `compareAndRefresh` on regular `d/f` where `d` is a symlink to a directory holding an identical `f` → `{ status: 'absent' }`. Fails: today it follows the link and answers `unchanged`.
3. GREEN — the leading-path check before the `lstat`, with a per-call scanner when the scope carries none.
4. GUARD — gitlink `d/sub` under a symlinked `d` → `absent` (passes: GREEN 3 runs before the gitlink arm for every mode). GUARD — a root-level path performs no extra `lstat` (spy; the scanner never scans the leaf).
5. RED — scan-tracked-entries: two entries `d/a` and `d/b` scanned by `scanTrackedEntries` cause exactly one `lstat` of `<work>/d` (spy on `ctx.fs.lstat`). Fails: GREEN 3 builds a scanner per call, so `d` is `lstat`ed twice.
6. GREEN — `ComparisonScope.scanner`; `scanWorkingTree` builds one scanner and `scanEntry` passes it.
7. Interop — the two rows above (git twin vs tsgit twin, full v2 lines and the untracked list).
8. REFACTOR — none expected.

### Gate

```
npx vitest run test/unit/application/primitives/compare-working-tree-entry test/unit/application/primitives/internal/scan-tracked-entries test/unit/application/commands/status test/unit/application/commands/stash test/unit/application/commands/rm test/unit/application/primitives/apply-changeset && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/compare-working-tree-entry.ts src/application/primitives/internal/scan-tracked-entries.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/primitives/internal/scan-tracked-entries.test.ts test/integration/status-gitlink-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/primitives/compare-working-tree-entry.ts src/application/primitives/internal/scan-tracked-entries.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/unit/application/primitives/internal/scan-tracked-entries.test.ts test/integration/status-gitlink-interop.test.ts
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/status-gitlink-interop.test.ts test/integration/status-interop.test.ts test/integration/status-refresh-interop.test.ts test/integration/checkout-leading-symlink-interop.test.ts test/integration/merge-delete-beyond-symlink-interop.test.ts test/integration/rm-interop.test.ts test/integration/stash-interop.test.ts
```

### Commit

`fix(status): read a tracked path below a symlinked directory as deleted`

## Part 5 — Refuse a gitlink whose .git leads to no repository, as git's dirty check does

### Context

R5 (first half); ADR-1063. New internal module (no barrel). git's `status` runs a dirty check after the HEAD comparison over every stage-0 gitlink that is not skip-worktree, not assume-valid and not absent; it reads `<path>/.git` with the dying gitfile reader. This part delivers the dying reader and the "nothing checked out → no flags" arm; Part 6 adds the child status, Part 9 the symlink refusal and the ignore modes (until then every gitlink resolves to ignore `none`).

Files:
- `src/application/commands/internal/submodule-state.ts` — NEW. Exports `type SubmoduleState = NonNullable<ChangedPath['submodule']>` (type-only import from ../status.js) and `submoduleState(ctx: Context, entry: IndexEntry, delta: WorkingTreeDelta): Promise<SubmoduleState>`: `commitChanged = delta.status === 'modified'`; a non-directory delta (`type-changed`) skips the probe (no flags); otherwise `probeGitlinkCheckout(ctx, entry.path)` (src/application/primitives/internal/gitlink-head.ts): `oversized` → `throw gitfileTooLarge(checkout.shown)`, `broken` → `throw notARepository(checkout.shown)` (both from src/domain/repository/error.ts L27-34), `none` / `repository` → no flags in this part.
- `test/unit/application/commands/internal/submodule-state.test.ts` — NEW unit suite for the module (memory adapter; reuse the layouts described in Part 2/3 Context: absorbed gitfile, embedded .git, sub/.git an empty directory, a gitfile body `garbage`, a sparse gitfile).
- `src/application/commands/status.ts` — after `scanTrackedTree` (L209) and before `reportUnderLock`, run `submoduleState` for every stage-0 entry with `entry.mode === FILE_MODE.GITLINK`, `!entry.flags.skipWorktree`, `!entry.flags.assumeValid`, and a working delta present and not `absent`, through `boundedMapFor(ctx, 'ioBound', …)` (src/application/primitives/internal/concurrency.js, already imported). Build a new `Map` of states keyed by escaped path (immutable; do not mutate `trackedScan.workingMap`) and hand it to `reportStatus` → `buildChanges` → `buildChangedPath`, which takes `submodule` from it (falling back to Part 3's derivation for rows the check skipped). Refusals propagate before any index write. Keep `statusInScope` under 20 lines (extract a `submoduleStatesOf(ctx, tracked, trackedScan)` helper).
- `test/unit/application/commands/status-gitlink.test.ts` — status-level rows.
- `test/integration/status-gitlink-interop.test.ts` — refusal rows.

Pinned bytes (git 2.55, default `status`; tsgit `.data`):
- sub/.git a sparse file of exactly `1 << 20` bytes: exit 128 `fatal: invalid gitfile format: sub/.git` → `NOT_A_REPOSITORY { path: 'sub/.git' }`.
- sub/.git sparse, `(1 << 20) + 1` bytes (use `makeSparseFile(dotGit, OVERSIZED_GITFILE_BYTES)`), with and without the module HEAD moved: exit 128 `fatal: too large to be a .git file: 'sub/.git'` → `GITFILE_TOO_LARGE { path: 'sub/.git' }`.
- sub/.git an empty directory: exit 128 `fatal: 'sub/.git' not recognized as a git repository` → `NOT_A_REPOSITORY { path: 'sub/.git' }`.
- gitfile `gitdir: ../.git/modules/nowhere`: exit 128 `fatal: not a git repository: sub/../.git/modules/nowhere` → `NOT_A_REPOSITORY { path: 'sub/../.git/modules/nowhere' }`.
- gitfile `garbage`: exit 128 `fatal: invalid gitfile format: sub/.git` → `NOT_A_REPOSITORY { path: 'sub/.git' }`.
- module HEAD `garbage`, or module objects/ removed: exit 128 `fatal: not a git repository: sub/../.git/modules/sub` → `NOT_A_REPOSITORY { path: 'sub/../.git/modules/sub' }`.
- sub/.git a FIFO (two runs): exit 0, no line → no refusal, no row.
- tsgit-only: module HEAD a FIFO → settles within `NON_BLOCKING_TIMEOUT_MS`; its outcome is the classification `probeGitlinkCheckout` gives that shape (run once, pin the observed `.data` or "no row" literally, and say which in the hand-back).
The `path` values are the `shown` strings the reader already gives `add` (add-gitlink-interop rows); the interop test asserts git's exit code is 128 and its stderr contains the quoted message, and asserts tsgit's `.data` with try/catch.

### TDD steps

One RED per function, run before its code.

1. RED — submodule-state unit: `submoduleState` on a gitlink whose `sub/.git` is an oversized gitfile rejects with `GITFILE_TOO_LARGE { path: 'sub/.git' }`. Fails: the module does not exist (import error).
2. GREEN — create the module with the `oversized` arm, `none`/`repository` → no flags.
3. RED — `sub/.git` an empty directory rejects with `NOT_A_REPOSITORY { path: 'sub/.git' }`. Fails: GREEN 2 returns no flags for `broken`.
4. GREEN — the `broken` arm. GUARD rows (same arm): gitfile `garbage`; gitfile to a missing module dir (`path: 'sub/../.git/modules/nowhere'`). GUARD — a file at the path (`type-changed` delta) resolves with all flags `false` and never probes (passes: GREEN 2 skips non-directory deltas). GUARD — empty directory (`none`) → all `false`; moved HEAD → `commitChanged: true`.
5. RED — status-gitlink unit: `status(ctx)` over an oversized `sub/.git` rejects with `GITFILE_TOO_LARGE { path: 'sub/.git' }`. Fails: `status` never calls `submoduleState` (after Part 2 it answers clean).
6. GREEN — wire the dirty check into `status` with the skip-worktree and absent exclusions.
7. RED — assume-valid gitlink over an oversized `sub/.git` → `status` resolves with no `sub` row. Fails: GREEN 6 does not exclude assume-valid, so the check refuses.
8. GREEN — exclude `assumeValid`. GUARD — skip-worktree gitlink over an oversized `sub/.git` → no refusal (passes: the scan never yields a skip-worktree delta). GUARD — removed `sub` (absent) → `D` row, no refusal.
9. Interop — the refusal rows and the FIFO rows above; the Part 2 rows stay green.
10. REFACTOR — `statusInScope` and `submoduleState` under 20 lines.

### Gate

```
npx vitest run test/unit/application/commands/internal/submodule-state test/unit/application/commands/status test/unit/application/commands/submodule-write && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/submodule-state.ts src/application/commands/status.ts test/unit/application/commands/internal/submodule-state.test.ts test/unit/application/commands/status-gitlink.test.ts test/integration/status-gitlink-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/commands/internal/submodule-state.ts src/application/commands/status.ts test/unit/application/commands/internal/submodule-state.test.ts test/unit/application/commands/status-gitlink.test.ts test/integration/status-gitlink-interop.test.ts
npx depcruise src/ --config .dependency-cruiser.cjs
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/status-gitlink-interop.test.ts test/integration/status-interop.test.ts test/integration/status-embedded-repository-interop.test.ts test/integration/submodule-init-sync-deinit-interop.test.ts
```

### Commit

`fix(status): refuse a gitlink whose .git leads to no repository, as git's dirty check does`

## Part 6 — Flag tracked and untracked changes inside a checked-out submodule

### Context

R5 (second half); ADR-1063, ADR-1064, ADR-1070; decision candidates D1 (inject the child status) and D2 (child `Context` from the reader).

Files:
- `src/application/primitives/internal/gitlink-head.ts` — the `repository` variant of `GitlinkCheckout` gains `readonly context: () => Promise<Context>`, built in `probeGitlinkCheckout` (L77-103) exactly as `head()` builds its child: `deriveGitlinkContext(ctx, gitDir, path, { fs, commonDir, refStorage: await refStorageOf(fs, commonDir) })`, without `seedHeadFile` (the child status reads HEAD itself). A repository-format refusal from `refStorageOf` propagates from `context()` (git's child status dies on it). Its existing unit suite stays unchanged; the new member is covered through submodule-state rows.
- `src/application/commands/internal/submodule-state.ts` — `submoduleState` gains a fourth parameter `deps: { readonly childStatus: (child: Context) => Promise<StatusResult> }` (type-only import of `StatusResult`); Part 9 adds `ignore` to the same object, so the final signature is `submoduleState(ctx, entry, delta, { ignore, childStatus })`. For `repository`: `const result = await childStatus(await checkout.context())`; `trackedChanges` = `result.unmerged.length > 0` or some `result.changes` row is not "only untracked" (a row is only untracked when its `submodule` equals `{ commitChanged: false, trackedChanges: false, untrackedChanges: true }`, whatever its staged/unstaged columns — git checks only the `S..U` field); `untrackedChanges` = `result.untracked.length > 0` or some row has `submodule?.untrackedChanges`. The child's error propagates unchanged (no catch).
- `test/unit/application/commands/internal/submodule-state.test.ts` — rows with a fake `childStatus` returning chosen `StatusResult`s, plus one row with the real `status`.
- `src/application/commands/status.ts` — passes `{ childStatus: (child) => status(child, { refresh: <this run's refreshEnabled verdict> }) }` (compute `refreshEnabled(ctx, opts)` before the dirty check — today it runs after the scan at L210, before the lock), so a `refresh: false` / `GIT_OPTIONAL_LOCKS=0` parent never writes the child's index; a set flag turns the row's unstaged column to `modified` (keep `worktree.mode` `160000`, keep `type-changed` as is); a clean state adds no row. The child runs its own dirty check recursively through the same path (no depth cap).
- `test/unit/application/commands/status-gitlink.test.ts` — status-level rows.
- `test/integration/status-gitlink-interop.test.ts` — rows below.

Pinned bytes (git 2.55, default `status --porcelain=v2 -uall`):
- sub/u edited, HEAD unmoved: `1 .M S.M. 160000 160000 160000 <A> <A> sub`.
- untracked sub/n: `1 .M S..U …`; both: `1 .M S.MU …`; moved + edited: `1 .M SCM. …`.
- `sub` on an orphan branch (unborn HEAD, index kept): `1 .M S.M. …`.
- nested submodule sub/in moved, `sub` unmoved: `1 .M S.M. 160000 160000 160000 <A'> <A'> sub` (the oids are the superproject's own).
- module HEAD `ref: refs/heads/<5000 digits>`: `1 .M S.M. …`.
- sub/u touched with the same bytes more than 1 s later: superproject clean, the submodule's `index` bytes change (git rewrote it; compare before/after in each twin); with `git --no-optional-locks status` (tsgit `status(ctx, { refresh: false })`) — to pin: expected unchanged.
- the submodule's index truncated to `junk\n`: git exit 128, stderr `fatal: <abs>/.git/modules/sub/index: index file smaller than expected` then `fatal: 'git status --porcelain=2' failed in submodule sub` → tsgit rejects with the child's own index error unchanged (pin its `.data` from the run).
- To pin: a repository-format refusal inside a checked-out submodule (module `config` with `repositoryformatversion = 2`, and an unknown `extensions.*` at version 1, the add GL39–GL44 shapes) — expected: git dies; tsgit rejects with the format error from `context()`.

### TDD steps

One RED per function, run before its code.

1. RED — submodule-state unit: a `repository` checkout whose fake `childStatus` returns one modified file row → `trackedChanges: true`. Fails: the `repository` arm returns no flags and never calls `childStatus`.
2. GREEN — `context()` on the reader's `repository` variant; call `childStatus`; tracked rule (any change or unmerged).
3. RED — child result with one untracked path → `untrackedChanges: true`. Fails: GREEN 2 sets only the tracked flag.
4. GREEN — untracked rule. GUARD — child with one unmerged entry → `trackedChanges: true` (passes: GREEN 2 counts unmerged).
5. RED — child result whose only row is a nested gitlink with `submodule: { commitChanged: false, trackedChanges: false, untrackedChanges: true }` and `staged: 'modified'` → `{ trackedChanges: false, untrackedChanges: true }`. Fails: GREEN 2 counts every row as tracked.
6. GREEN — the "only untracked" exception. GUARD — a nested gitlink row with `commitChanged: true` counts as tracked.
7. RED — status-gitlink unit: unmoved gitlink whose checkout has an edited tracked file → row with `unstaged: 'modified'`, `worktree: { mode: '160000' }`, `submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false }`. Fails: `status` passes no `childStatus` and drops clean-HEAD rows.
8. GREEN — status passes the child status and merges flags into the row.
9. RED — `status(ctx, { refresh: false })` over a submodule whose file was rewritten with the same bytes leaves the submodule's `index` bytes unchanged. Fails: GREEN 8's child status refreshes and writes the child index.
10. GREEN — forward the parent's refresh verdict. GUARD — default `status` rewrites the child index (passes since GREEN 8). GUARD — child index `junk\n` → rejects with the child's index error `.data` (passes: no catch).
11. Interop — rows above, then the two "to pin" rows (git first).
12. REFACTOR — functions under 20 lines; no mutable shared state across the bounded map.

### Gate

```
npx vitest run test/unit/application/commands/internal/submodule-state test/unit/application/primitives/internal/gitlink-head test/unit/application/commands/status test/unit/application/commands/submodule-write test/unit/application/commands/add-gitlink && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/gitlink-head.ts src/application/commands/internal/submodule-state.ts src/application/commands/status.ts test/unit/application/commands/internal/submodule-state.test.ts test/unit/application/commands/status-gitlink.test.ts test/integration/status-gitlink-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/primitives/internal/gitlink-head.ts src/application/commands/internal/submodule-state.ts src/application/commands/status.ts test/unit/application/commands/internal/submodule-state.test.ts test/unit/application/commands/status-gitlink.test.ts test/integration/status-gitlink-interop.test.ts
npx depcruise src/ --config .dependency-cruiser.cjs
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/status-gitlink-interop.test.ts test/integration/status-interop.test.ts test/integration/submodule-init-sync-deinit-interop.test.ts test/integration/add-gitlink-interop.test.ts
```

### Commit

`fix(status): flag tracked and untracked changes inside a checked-out submodule`

## Part 7 — Add the SUBMODULE_PATH_IS_SYMLINK error code

### Context

ADR-1069; decision candidate D5. **Public**: a new member of the exported `TsgitErrorData` union. Surface gates paid here: the union, the message switch, the exhaustiveness switch, the documented error table, `reports/api.json`. The throw site lands in Part 9.

Files:
- `src/domain/submodule/error.ts` — `SubmoduleError` (L4-12) gains `| { readonly code: 'SUBMODULE_PATH_IS_SYMLINK'; readonly path: FilePath }` (import `FilePath` type from ../objects/object-id.js); new constructor `submodulePathIsSymlink(path: FilePath): TsgitError` with a doc comment naming git's refusal (`expected submodule path '<path>' not to be a symbolic link`, exit 128, from the dirty check).
- `src/domain/error.ts` — message switch: after `case 'SUBMODULE_PATH_EXISTS':` (near L749) add `case 'SUBMODULE_PATH_IS_SYMLINK': return \`expected submodule path '${data.path}' not to be a symbolic link\`;`.
- `test/unit/domain/exhaustiveness.ts` — add `case 'SUBMODULE_PATH_IS_SYMLINK':` after `case 'SUBMODULE_PATH_EXISTS':` (L250).
- `test/unit/domain/submodule/error.test.ts` — constructor rows (follow the file's `describe('<constructor>')` > Given/When/Then style, `const sut = …`).
- `docs/use/errors.md` — "Repository state" table, row after `SUBMODULE_OBJECT_FORMAT_MISMATCH` (L275): `| \`SUBMODULE_PATH_IS_SYMLINK\` | \`path\` | \`status\` met a tracked gitlink whose path is a symbolic link while running git's dirty check. Mirrors git's \`expected submodule path '<path>' not to be a symbolic link\` (exit 128). Not raised when the submodule's ignore mode is \`dirty\` or \`all\`; the row then reads \`type-changed\`. |`
- `reports/api.json` — `npm run docs:json`.

### TDD steps

One RED per function, run before its code.

1. RED — `submodulePathIsSymlink('sub')` has `.data` `{ code: 'SUBMODULE_PATH_IS_SYMLINK', path: 'sub' }`. Fails: the constructor does not exist (type error / import error).
2. GREEN — union member, constructor, message case, exhaustiveness case (the compiler requires both switch cases once the member exists).
3. GUARD — `.message` equals `SUBMODULE_PATH_IS_SYMLINK: expected submodule path 'sub' not to be a symbolic link` (passes: GREEN 2 added the message case the exhaustive switch forced).
4. Docs — the errors.md row; `npm run docs:json`; stage `reports/api.json`.
5. Run `npx knip`: it must not report `submodulePathIsSymlink` as an unused export (it is imported by its test). If it does, stop and hand back per D5 — do not add a throw site here.

### Gate

```
npx vitest run test/unit/domain && npm run check:types && ./node_modules/.bin/biome check src/domain/submodule/error.ts src/domain/error.ts test/unit/domain/exhaustiveness.ts test/unit/domain/submodule/error.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/domain/submodule/error.ts src/domain/error.ts test/unit/domain/submodule/error.test.ts docs/use/errors.md
npx knip && npm run check:doc-links
```

### Commit

`fix(status): add the SUBMODULE_PATH_IS_SYMLINK error code`

## Part 8 — Resolve a submodule's ignore mode from config, .gitmodules and diff.ignoreSubmodules

### Context

R6 (precedence and `all`); ADR-1063, ADR-1068. Every precedence row the design pinned uses `all` against `none`, so this part delivers the resolver plus the `all` mode; Part 9 adds `dirty`, `untracked`, the index-blob source and the interop rows for every ignore row (the resolver is only observable through `status`).

Files:
- `src/application/primitives/parse-gitmodules.ts` — `GitmodulesRow` (L12-18) and `SubmoduleKeys` (L20-25) gain `readonly ignore?: string`; `mergeKey` (L27-39) maps key `ignore`; `reduceSection` (L41-60) spreads it like the other keys. Internal type (not barrelled).
- `test/unit/application/primitives/parse-gitmodules.test.ts` — example rows for `ignore`.
- `test/unit/application/primitives/parse-gitmodules.properties.test.ts` — `arbRow` (L23-33) gains `ignore: fc.constantFrom('none', 'untracked', 'dirty', 'all')` (optional key) and `serialize` (L35-46) writes `\tignore = <v>`; the round-trip property then covers the key. The four-value enum itself fails the round-trip lens (closed set, no serializer): example rows only.
- `src/application/commands/internal/submodule-state.ts` — `type SubmoduleIgnore = 'none' | 'untracked' | 'dirty' | 'all'` and `resolveSubmoduleIgnore(ctx, path: FilePath, rows: ReadonlyArray<GitmodulesRow>): Promise<SubmoduleIgnore>`: the name is the `.gitmodules` row whose `path` equals the entry path; precedence `findLastSubsectionEntry(ctx, 'submodule', name, 'ignore')` → the row's `ignore` → `findLastEntry(ctx, 'diff', 'ignoreSubmodules')` → `'none'` (both helpers in src/application/primitives/config-read.ts L878-904, returning `LocatedConfigEntry { key, source, line, value: string | null }`). A config value outside the four throws `configInvalidEnumValue(entry.key, entry.source, entry.value, entry.line)` (src/domain/commands/error.ts L1229; pattern: src/application/commands/internal/pull-rebase-config.ts L42-55). The `.gitmodules` rows come from the working-tree file (read like `readWorktreeGitmodules` in src/application/commands/submodule.ts L112-123, capped at `MAX_GITMODULES_BYTES` from src/application/primitives/types.ts L356). Read the rows and config only when the index holds at least one stage-0 gitlink.
- `src/application/commands/status.ts` — resolve once per gitlink before its dirty check; `all` removes the path from the working map, from the staged kinds (pending the staged pin below) and from the dirty check; the refusal happens before any child status runs.
- `test/unit/application/commands/status-gitlink.test.ts` — status-level resolver rows.

Pinned bytes (git 2.55; interop rows land in Part 9):
- `diff.ignoreSubmodules = all`, moved: no line. `.gitmodules` `ignore = all` (committed), moved: no line.
- `.gitmodules` `all`, .git/config `submodule.sub.ignore = none`, moved: `SC..` line shown. `diff.ignoreSubmodules = all` + .git/config `none`: shown. `diff.ignoreSubmodules = all` + `.gitmodules` `none`: shown.
- `.gitmodules` section renamed to `nm` with `path = sub`, `ignore = all`, moved: no line (the name comes from `path`).
- .git/config `submodule.sub.ignore = bogus` (or `diff.ignoreSubmodules = bogus`), moved: exit 128 `fatal: bad --ignore-submodules argument: bogus` → `CONFIG_INVALID_ENUM_VALUE { key: 'submodule.sub.ignore' (or the `diff` key, lower-cased the way `findLastEntry` qualifies it), source: <abs .git/config>, value: 'bogus', line: <N> }`.
- To pin: `.gitmodules` `ignore = bogus` (expected: git warns and treats it as unset — then tsgit treats it as unset, no refusal); valueless `submodule.sub.ignore` in .git/config (expected: git refuses — map to the valueless-key handling the repo already uses; if no error fits, hand back); staged gitlink (`git add sub` after a move) and a `T` / `D` gitlink under `all` (expected: hidden).

### TDD steps

One RED per function, run before its code.

1. RED — `parseGitmodules('[submodule "s"]\n\tpath = sub\n\tignore = all\n')` returns `[{ name: 's', path: 'sub', ignore: 'all' }]`. Fails: `mergeKey` drops `ignore`.
2. GREEN — parse the key; extend the property sibling's `arbRow`/`serialize` (GUARD: the round-trip property passes with the key).
3. RED — status-gitlink unit: `diff.ignoreSubmodules = all`, moved gitlink → no `sub` row and `clean: true`. Fails: status reads no ignore key.
4. GREEN — `resolveSubmoduleIgnore` reading `diff.ignoreSubmodules`; `all` hides the row.
5. RED — `.gitmodules` `ignore = all` hides a moved gitlink. Fails: GREEN 4 reads only `diff.*`.
6. GREEN — `.gitmodules` lookup by `path`. GUARD — `.gitmodules` `none` beats `diff.ignoreSubmodules = all` (passes: GREEN 6 consults the row first). GUARD — section named `nm` with `path = sub` hides (passes: lookup is by path).
7. RED — `.git/config` `submodule.s.ignore = none` beats `.gitmodules` `all`. Fails: GREEN 6 never reads `.git/config`.
8. GREEN — config first. GUARD — `.git/config` `none` beats `diff.ignoreSubmodules = all`.
9. RED — `.git/config` `submodule.s.ignore = bogus` → `CONFIG_INVALID_ENUM_VALUE` with key, source, value, line. Fails: GREEN 8 treats an unknown value as `none`.
10. GREEN — validate config values. GUARD — `diff.ignoreSubmodules = bogus` refuses the same way (passes: same validation).
11. Pins (git first): `.gitmodules` `bogus`, valueless config key, staged / `T` / `D` under `all`. Each is a GUARD when git agrees with GREEN 4–10, else a RED folded here (the fold stays in submodule-state.ts or status.ts; anything else is a hand-back).
12. REFACTOR — resolver under 20 lines (one helper per source).

### Gate

```
npx vitest run test/unit/application/primitives/parse-gitmodules test/unit/application/commands/status test/unit/application/commands/internal/submodule-state test/unit/application/commands/submodule && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/parse-gitmodules.ts src/application/commands/internal/submodule-state.ts src/application/commands/status.ts test/unit/application/primitives/parse-gitmodules.test.ts test/unit/application/primitives/parse-gitmodules.properties.test.ts test/unit/application/commands/status-gitlink.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/primitives/parse-gitmodules.ts src/application/commands/internal/submodule-state.ts src/application/commands/status.ts test/unit/application/primitives/parse-gitmodules.test.ts test/unit/application/primitives/parse-gitmodules.properties.test.ts test/unit/application/commands/status-gitlink.test.ts
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/status-gitlink-interop.test.ts test/integration/status-interop.test.ts test/integration/submodule-init-sync-deinit-interop.test.ts
```

### Commit

`fix(status): resolve a submodule's ignore mode from config, .gitmodules and diff.ignoreSubmodules`

## Part 9 — Honour the dirty and untracked ignore modes and refuse a symlinked submodule path

### Context

R5 (symlink refusal), R6 (modes, index-blob source); ADR-1063, ADR-1069. Also the interop rows for every ignore row Part 8 implemented.

Files:
- `src/application/commands/internal/submodule-state.ts` — `submoduleState`'s `deps` object gains `readonly ignore: SubmoduleIgnore` (status passes the resolved mode, never `all`, which status already dropped): `dirty` → only `commitChanged` (no probe, no child status, so no child index write); `untracked` → `untrackedChanges` forced `false`; a symlink at the path with mode `none`/`untracked` → `throw submodulePathIsSymlink(entry.path)` (Part 7) before reading `<path>/.git` (detect it from the `type-changed` delta whose `worktreeMode` is `120000`, or an `lstat` — no second probe). `.gitmodules` source: the working-tree file, else the stage-0 `.gitmodules` index blob (`readBlob(ctx, id, { maxBytes: MAX_GITMODULES_BYTES })`, as src/application/primitives/walk-submodules.ts L108-120 reads it from a tree).
- `test/unit/application/commands/status-gitlink.test.ts` — status-level rows.
- `test/integration/status-gitlink-interop.test.ts` — ignore rows.
- `docs/use/commands/status.md` — Behaviour bullet: submodule ignore modes and their sources, the symlink refusal (`SUBMODULE_PATH_IS_SYMLINK`), the dying reader refusals (`GITFILE_TOO_LARGE`, `NOT_A_REPOSITORY`), the child error propagating unchanged, `CONFIG_INVALID_ENUM_VALUE` for an invalid value.
- `src/application/commands/status.ts` — only if passing the mode needs it.

Pinned bytes (git 2.55, default `status --porcelain=v2 -uall`):
- `.gitmodules` `ignore = dirty` (committed), sub/u edited: no line. `diff.ignoreSubmodules = dirty`, sub/u edited: no line. `.gitmodules` `dirty`, untracked sub/n: no line.
- .git/config `submodule.sub.ignore = untracked`, untracked sub/n: no line. `.gitmodules` `untracked`, untracked sub/n: `sub` absent (only `.gitmodules` `.M`).
- index `.gitmodules` `all`, working `.gitmodules` `none`, moved: `SC..` shown. Working `.gitmodules` deleted, index and HEAD `all`, moved: `sub` absent.
- `status.submoduleSummary = true`, moved: `SC..` (no data change).
- ignore `all` / `dirty` / `untracked` over an oversized sub/.git: exit 0 no line / exit 0 no line / exit 128 `too large to be a .git file`.
- `sub` a symlink (to a directory, and to `k`): exit 128 `error: expected submodule path 'sub' not to be a symbolic link` → `SUBMODULE_PATH_IS_SYMLINK { path: 'sub' }`. With `ignore = dirty`: `1 .T S... 160000 160000 120000 <A> <A> sub`.
- SX: with `ignore = dirty`, sub/u touched with the same bytes > 1 s later → the submodule's `index` bytes unchanged.
- Plus the Part 8 rows (all/precedence/name/bogus) as interop rows.

### TDD steps

One RED per function, run before its code.

1. RED — status-gitlink unit: `.gitmodules` `ignore = dirty`, unmoved gitlink with an edited tracked file → no `sub` row. Fails: the dirty check runs and sets `trackedChanges`.
2. GREEN — `dirty` keeps only `commitChanged`. GUARD — `dirty` + moved → `submodule: { commitChanged: true, … false }` row. GUARD — `dirty` over an oversized `sub/.git` → no refusal.
3. RED — `.gitmodules` `ignore = untracked`, untracked file in the checkout → no `sub` row. Fails: `untrackedChanges` is still set.
4. GREEN — `untracked` drops the flag. GUARD — `untracked` over an oversized `sub/.git` still refuses `GITFILE_TOO_LARGE`.
5. RED — `sub` a symlink to a directory, mode `none` → rejects `SUBMODULE_PATH_IS_SYMLINK { path: 'sub' }`. Fails: today the `type-changed` delta skips the dirty check and the row reads `T`.
6. GREEN — the symlink refusal ahead of the probe. GUARD — symlink to the file `k` refuses the same way. GUARD — symlink with mode `dirty` → `T` row with `worktree: { mode: '120000' }` (the refusal is skipped). GUARD — a regular file at the path (mode `none`) → `T` row, no refusal.
7. RED — working `.gitmodules` deleted, the index `.gitmodules` blob says `ignore = all`, moved → no `sub` row. Fails: Part 8 reads the working-tree file only.
8. GREEN — index-blob fallback. GUARD — working file `none` beats index blob `all` (passes: file first).
9. Interop — every row listed above, git twin vs tsgit twin.
10. Docs — status.md Behaviour bullet.
11. REFACTOR — functions under 20 lines.

### Gate

```
npx vitest run test/unit/application/commands/status test/unit/application/commands/internal/submodule-state && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/submodule-state.ts src/application/commands/status.ts test/unit/application/commands/status-gitlink.test.ts test/integration/status-gitlink-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/commands/internal/submodule-state.ts src/application/commands/status.ts test/unit/application/commands/status-gitlink.test.ts test/integration/status-gitlink-interop.test.ts docs/use/commands/status.md
npx knip && npm run check:doc-links
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/status-gitlink-interop.test.ts test/integration/status-interop.test.ts test/integration/submodule-init-sync-deinit-interop.test.ts
```

### Commit

`fix(status): honour the dirty and untracked ignore modes and refuse a symlinked submodule path`

## Part 10 — Never treat a gitlink as dirty when checkout or merge rewrites the tree

### Context

R7 (checkout/merge fast-forward); git's `verify_uptodate_1` returns early for a gitlink, and `unlink_entry` removes a gitlink with `rmdir`, warning when the directory is not empty.

Files:
- `src/application/primitives/apply-changeset.ts` — `evaluateDirtyPath(ctx, probe, workdir, entry, scope)` L287-305: an `update`/`delete` entry with `entry.previousMode === FILE_MODE.GITLINK` returns `undefined` before `isDirtyUnder` (L169-178, which reads the directory through `readWorkingBytes` L103-122 and rethrows the read failure). `applyDeleteEntry(ctx, workdir, entry, scanner)` L364-375: a delete whose `previousMode` is `GITLINK` calls `removeEmptyDirectory(ctx, abs)` (src/application/primitives/internal/empty-directories.ts L22: `rmdir ?? rm`, `false` when non-empty or gone) instead of `rmIfExists`, and returns the path only when it was removed (a populated directory stays and is not handed to `pruneEmptiedDirectories`). `ChangesetEntry.previousMode: FileMode | undefined` (src/application/primitives/compute-changeset.ts L21).
- `test/unit/application/primitives/apply-changeset.test.ts` — new rows (16 existing gitlink rows stay unchanged).
- `test/integration/gitlink-consumers-interop.test.ts` — NEW suite for every consumer row (Parts 10–14). Its `@proves` header takes a comma-separated `interopSurface:` list (tooling/audit-write-surfaces/parse-interop-surface.ts); list only surface names some `@writes` tag in src declares (`grep -rn "surface:" src`) — today that includes `stash` and `rm` — and add a name in the part that first adds its rows. `npm run check:write-surfaces` must report no new warning. Fixture F2 = F1 (Part 2) plus branch `other` where `sub` is at the upstream's second commit (`<B>`) and branch `side` adding a file `o`, both cut from `main`; F3 = F2 plus a commit `m` on `main`. Each row asserts exit/refusal data, the index entry for `sub` (`git ls-files --stage sub` on both twins), the submodule HEAD (`git -C sub rev-parse HEAD`) and the files under `sub`.

Pinned bytes (git 2.55):
- F2 unmoved / moved / sub/u edited, `checkout other`: exit 0, index `sub` = `<B>`, sub HEAD unchanged (`<A>` or `<C>`), edit kept; afterwards status ` M sub`.
- moved, `checkout side`: exit 0 (already green — GUARD row).
- F2 unmoved, `checkout --detach HEAD~1` (no `sub` there): exit 0, stderr `warning: unable to rmdir 'sub': Directory not empty`, sub/ left in place, listed untracked. After `submodule deinit -f sub` (empty `sub`), same command: `sub` removed.
- on a branch without `sub` and no `sub` directory, `checkout main`: empty `sub` created (GUARD row).
- moved / edited, `merge --no-edit other` (fast-forward): exit 0, index `<B>`, sub untouched. Moved, `merge side`: exit 0 (GUARD row).

### TDD steps

One RED per function, run before its code.

1. RED — apply-changeset unit: an `update` entry for `sub` with `previousMode: '160000'` over a populated directory applies without error and leaves the directory's files. Fails: `isDirtyUnder` reads the directory and `readWorkingBytes` rethrows the read failure.
2. GREEN — the `previousMode` gitlink early return in `evaluateDirtyPath`.
3. RED — a `delete` entry for a gitlink over a populated directory applies without error and leaves the directory in place. Fails: `rmIfExists` calls `ctx.fs.rm` on a non-empty directory and it rejects.
4. GREEN — gitlink delete through `removeEmptyDirectory`. GUARD — gitlink delete over an empty directory removes it (passes: `removeEmptyDirectory` removes an empty directory). GUARD — a regular-file `update` over a locally modified file is still refused as a local change (isolation of the gitlink condition).
5. Interop — create the consumers suite with F2 and the rows above (CO5/CO6 shapes pinned git-first: the delete arm was never reached before this part).
6. REFACTOR — functions under 20 lines.

### Gate

```
npx vitest run test/unit/application/primitives/apply-changeset test/unit/application/commands/checkout test/unit/application/commands/merge && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/gitlink-consumers-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/primitives/apply-changeset.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/gitlink-consumers-interop.test.ts
npm run check:write-surfaces
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/gitlink-consumers-interop.test.ts test/integration/checkout-file-directory-swap-interop.test.ts test/integration/checkout-leading-symlink-interop.test.ts test/integration/checkout-skip-worktree-interop.test.ts test/integration/merge-interop.test.ts test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts
```

### Commit

`fix(checkout): never treat a gitlink as dirty when switching trees`

## Part 11 — Skip gitlinks in the clean-tree and would-overwrite checks

### Context

R7 (cherry-pick, merge ort, rebase/pull pre-flight). git: `require_clean_work_tree` / `index_differs_from` run with submodules ignored (`diff_change` skips a change whose both sides are gitlinks; git's add-or-remove callback skips an added or removed gitlink; a gitlink↔file type change still counts); `verify_uptodate_1` returns 0 for a stage-0 gitlink.

Files:
- `src/application/primitives/find-would-overwrite.ts` — `findWouldOverwrite(ctx, paths, currentIndex)` L112-139: a stage-0 entry with `entry.mode === FILE_MODE.GITLINK` never enters `localChanges` (skip before the comparison).
- `test/unit/application/primitives/find-would-overwrite.test.ts` — rows. (Its property sibling find-would-overwrite.properties.test.ts generates `FILE_MODE.REGULAR` entries only and stays as is.)
- `src/application/commands/internal/clean-work-tree.ts` — `unstagedDirty(ctx, stage0, indexMtime)` L56-70 skips `entry.mode === FILE_MODE.GITLINK`; `stagedDirty(ctx, stage0, headTree)` L35-55: first loop skips an index gitlink whose HEAD side is absent or a gitlink; second loop skips a HEAD-only path whose HEAD mode is a gitlink. A gitlink↔file kind change stays dirty. Callers: `assertCleanWorkTree` L72, `assertCleanIndex`, `unstagedChangePaths` L109-113, `stagedChangePaths`.
- `test/unit/application/commands/internal/clean-work-tree.test.ts` — rows (style: `describe('assertCleanWorkTree')` L114).
- `test/integration/gitlink-consumers-interop.test.ts` — rows.

Pinned bytes (git 2.55):
- F3 unmoved / moved / edited, `merge --no-edit other` (ort): exit 0, merge commit, index `<B>`, sub untouched.
- F3 unmoved / moved, `cherry-pick other`: exit 0, index `<B>`, sub untouched. Moved, `cherry-pick side`: exit 0 (GUARD row).
- moved / edited, `rebase side`: exit 0, afterwards ` M sub` / clean. Moved + `git add sub` (staged gitlink), `rebase side`: exit 0.
- To pin: a conflicted rebase resolved, then `sub` moved, then `rebase --continue`: expected exit 0, ` M sub` afterwards (tsgit's `unstagedChangePaths` arm).

### TDD steps

One RED per function, run before its code.

1. RED — `findWouldOverwrite` with a stage-0 gitlink `sub` (checkout HEAD moved) in `paths` returns `localChanges: []`. Fails: the comparison answers `modified` and the path is listed.
2. GREEN — skip stage-0 gitlinks. GUARD — a gitlink whose path holds a regular file (`type-changed`) is skipped too (git's early return covers every gitlink).
3. GUARD (written before GREEN 7, passes at its step) — `assertCleanWorkTree` with index `sub` = regular file and HEAD `sub` = gitlink refuses `WORKING_TREE_DIRTY { localChanges: ['sub'], untracked: [] }`.
4. RED — `assertCleanWorkTree` with a moved gitlink and an index equal to HEAD resolves. Fails: `unstagedDirty` lists `sub`.
5. GREEN — `unstagedDirty` skips gitlinks.
6. RED — index gitlink `<C>`, HEAD gitlink `<A>` (staged gitlink) → resolves. Fails: `stagedDirty` lists `sub`.
7. GREEN — first-loop skip when both sides are gitlinks or the HEAD side is absent; the step-3 GUARD must stay green.
8. RED — HEAD holds gitlink `sub`, the index has no `sub` → resolves. Fails: the second loop lists `sub`.
9. GREEN — second-loop skip.
10. Interop — rows above; the rebase `--continue` row is pinned git-first.
11. REFACTOR — `stagedDirty` under 20 lines (extract an `ignoredGitlinkChange(head, entry)` predicate).

### Gate

```
npx vitest run test/unit/application/primitives/find-would-overwrite test/unit/application/commands/internal/clean-work-tree test/unit/application/commands/cherry-pick test/unit/application/commands/rebase test/unit/application/commands/merge && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/find-would-overwrite.ts src/application/commands/internal/clean-work-tree.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/commands/internal/clean-work-tree.test.ts test/integration/gitlink-consumers-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/primitives/find-would-overwrite.ts src/application/commands/internal/clean-work-tree.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/commands/internal/clean-work-tree.test.ts test/integration/gitlink-consumers-interop.test.ts
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/gitlink-consumers-interop.test.ts test/integration/cherry-pick-interop.test.ts test/integration/rebase-interop.test.ts test/integration/merge-interop.test.ts test/integration/merge-tracked-dirty-conflict-refusal-interop.test.ts
```

### Commit

`fix(rebase): skip gitlinks in the clean-tree and would-overwrite checks`

## Part 12 — Leave gitlinks out of the stash, as git does

### Context

R7 (stash); decision candidate D4. git's stash runs `diff-index --cached --ignore-submodules` and `diff-files --ignore-submodules`: a moved, dirty or staged submodule is never "a local change", and its index id rides into the W tree.

Files:
- `src/application/commands/stash.ts` — `classifyEntry(ctx, entry, provider, indexMtime)` L242-253: a stage-0 gitlink returns `{ entry, state: 'unchanged' }` without comparing (so `hashFileAt` L210-220 is never asked to hash the directory). `hasLocalChanges(found: LocalChanges, base: BaseState): boolean` L376-379 compares `found.iTree !== base.bTree`; when the trees differ, decide "differs only at gitlinks" with D4-B: `diffIndexAgainstTreeKeyed(index, headTree)` (src/domain/diff/index-diff.ts; `status.ts` L337 shows the call with `readHeadTreeEscaped(ctx)`), ignoring a change whose both sides are gitlinks or which adds/removes a gitlink; a gitlink↔file type change still counts. `hasLocalChanges` becomes async or the gitlink-only verdict is computed in `findLocalChanges` (L368-374) and carried in `LocalChanges` — keep CQS: compute in the query, read in the predicate.
- `test/unit/application/commands/stash.test.ts` — rows.
- `test/integration/gitlink-consumers-interop.test.ts` — rows.

Pinned bytes (git 2.55):
- F2 unmoved, `stash push`: exit 0, `No local changes to save` → tsgit's "no local changes" outcome (read the existing stash.test.ts rows for how `stashPush` reports it).
- moved / sub/u edited / untracked sub/n, `stash push`: no local changes, sub untouched.
- moved + `git add sub`, `stash push`: no local changes, index keeps `<C>`.
- moved + `k` edited, `stash push`: stash made; `stash@{0}:sub` = `stash@{0}^2:sub` = `<A>`; sub HEAD `<C>` kept; ` M sub` afterwards.
- To pin: staged gitlink (`git add sub` after a move) plus an edit to `k` — which `sub` id lands in the I tree (`stash@{0}^2:sub`) and in W, and what the index holds for `sub` after the push.
- To pin: a tracked file d/f under a directory `d` replaced by a symlink (the Part 4 change seen through `stash push`).

### TDD steps

One RED per function, run before its code.

1. RED — stash unit: moved gitlink plus an edited `k`, `stashPush` succeeds and the W tree's `sub` entry is the index id. Fails: `classifyEntry` reports `modified` and `hashFileAt` rejects reading the directory.
2. GREEN — gitlinks classify as `unchanged`. GUARD — unmoved gitlink with an edited file inside the checkout and nothing else → "no local changes" (passes since Part 2: the comparison reads `unchanged`).
3. GUARD (written before GREEN 5, passes at its step) — index `sub` = regular file, HEAD `sub` = gitlink → a stash is made.
4. RED — staged gitlink only (index `<C>`, HEAD `<A>`) → "no local changes". Fails: `iTree !== bTree`.
5. GREEN — the gitlink-only tree difference counts as no change; the step-3 GUARD stays green.
6. Interop — rows above; the two "to pin" rows git-first.
7. REFACTOR — functions under 20 lines.

### Gate

```
npx vitest run test/unit/application/commands/stash && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/gitlink-consumers-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/gitlink-consumers-interop.test.ts
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/gitlink-consumers-interop.test.ts test/integration/stash-interop.test.ts test/integration/stash-apply-index-interop.test.ts test/integration/merge-autostash-interop.test.ts test/integration/rebase-autostash-interop.test.ts
```

### Commit

`fix(stash): leave gitlinks out of the stash, as git does`

## Part 13 — Refuse rm of a submodule with local modifications as git does

### Context

R8 (valve); ADR-1066. git's `check_local_mod` treats a gitlink as locally modified when the HEAD comparison says modified or type-changed, or when `bad_to_remove_submodule` (the dirty check with untracked files counted, ignore config not consulted) finds anything; the dying gitfile reader runs there. After this part a clean submodule passes the valve and then still fails at `removeFile` (`CHECKOUT_OVERWRITE_DIRTY`) — Part 14 replaces the removal.

Files:
- `src/application/commands/rm.ts` — `classifyEntries(ctx, entries, head, cached, indexMtime)` L201-222: for `entry.mode === FILE_MODE.GITLINK`, take the delta with `compareWorkingTreeDelta(ctx, entry, provider, indexMtime)` (`absent` → continue, as today); `local` = `isWorkingTreeModified(delta.status)` or any flag of `submoduleState(ctx, entry, delta, { ignore: 'none', childStatus: status })` (the mode forced to `none`; `status` from ./status.js — rm.ts importing status.ts is not a cycle). Other entries unchanged. Valve precedence (`enforceSafetyValve` L224-242) unchanged.
- `test/unit/application/commands/rm.test.ts` — rows (helpers in the file: `seedAndStage` L95, `expectError(fn, code)` L103; gitlink layouts as in Part 3 Context).
- `test/integration/gitlink-consumers-interop.test.ts` — rows.

Pinned bytes (git 2.55):
- moved, `rm sub`: exit 1, `error: the following file has local modifications:` / `    sub` / `(use --cached to keep the file, or -f to force removal)` → `RM_LOCAL_MODIFICATIONS { paths: ['sub'] }`. Same for sub/u edited, untracked sub/n, and `sub` replaced by a file.
- sub/.git oversized, `rm sub`: exit 128 `fatal: too large to be a .git file: 'sub/.git'` → `GITFILE_TOO_LARGE { path: 'sub/.git' }`.
- moved, `rm --cached sub`: exit 0, `D  sub`, `?? sub/`, `.gitmodules` untouched (GUARD row: already green).
- To pin: a broken gitfile (`garbage`) under `rm sub` (git is expected to die in the child status spawn); `.gitmodules` `ignore = all` + untracked sub/n under `rm sub` (expected: still refused — the valve ignores config); a tracked file d/f under a symlinked `d` under `rm d/f` (the Part 4 change seen through rm; expected per git: no refusal, and the working file behind the link is not removed — pin what git leaves on disk).

### TDD steps

One RED per function, run before its code.

1. RED — rm unit: unmoved gitlink whose checkout has an edited tracked file, `rm(ctx, ['sub'])` rejects `RM_LOCAL_MODIFICATIONS { paths: ['sub'] }`. Fails: the valve sees `unchanged` and the removal step rejects with `CHECKOUT_OVERWRITE_DIRTY { localChanges: ['sub'], untracked: [] }` instead.
2. GREEN — gitlink branch in `classifyEntries` calling `submoduleState` with mode `none`.
3. GUARD — untracked file in the checkout with `.gitmodules` `ignore = all` → `RM_LOCAL_MODIFICATIONS` (passes: GREEN 2 forces `none`). GUARD — moved → `RM_LOCAL_MODIFICATIONS` (comparison `modified`). GUARD — oversized `sub/.git` → `GITFILE_TOO_LARGE { path: 'sub/.git' }` (dying reader inside `submoduleState`). GUARD — `cached: true` with an edited checkout → no refusal for the local-only category (unchanged valve semantics).
4. Interop — rows above; the "to pin" rows git-first.
5. REFACTOR — `classifyEntries` under 20 lines (extract `isLocallyModified(ctx, entry, …)`).

### Gate

```
npx vitest run test/unit/application/commands/rm test/unit/application/commands/internal/submodule-state && npm run check:types && ./node_modules/.bin/biome check src/application/commands/rm.ts test/unit/application/commands/rm.test.ts test/integration/gitlink-consumers-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/commands/rm.ts test/unit/application/commands/rm.test.ts test/integration/gitlink-consumers-interop.test.ts
npx depcruise src/ --config .dependency-cruiser.cjs
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/gitlink-consumers-interop.test.ts test/integration/rm-interop.test.ts
```

### Commit

`fix(rm): refuse a submodule with local modifications as git does`

## Part 14 — Remove a clean submodule, its .gitmodules section, and migrate an embedded .git

### Context

R8 (removal); ADR-1066; decision candidate D3. git: a clean submodule's directory is removed recursively; a .git directory inside it is first migrated into `.git/modules/<name>` (module `config` gets `core.worktree`, the worktree gets a gitfile, then the directory goes); the `.gitmodules` section whose `path` matches is removed and `.gitmodules` is staged; `.git/modules/<name>` is kept; `--cached` touches the index only; `-f` removes a modified submodule the same way. The `@writes` tag of rm.ts (L10-13: surface `rm`, kind `equivalent-under-readback`, format `git-index-tree-state`) stays; `check:write-surfaces` must stay green.

Files:
- `src/application/commands/internal/working-tree.ts` — new `removeDirectory(ctx: Context, rawPath: string): Promise<void>` beside `removeFile` (L87-99): same `validateWorkingTreePathOn(rawPath, ctx)` + `repoPath`, refuses anything that is not a directory with `checkoutOverwriteDirty({ localChanges: [path], untracked: [] })` like `removeFile`, then `ctx.fs.rmRecursive(full)`.
- `test/unit/application/commands/internal/working-tree.test.ts` — rows for `removeDirectory`.
- `src/application/commands/rm.ts` — in the removal loop (L120-135) a gitlink entry goes through: (1) migration when `<path>/.git` is a directory: `ctx.fs.rename(<work>/<path>/.git, <gitDir>/modules/<name>)`, then set `core.worktree` to `submoduleCoreWorktree(name, path)` in the module's config (`updateConfigOperations` on `deriveGitlinkContext(ctx, <gitDir>/modules/<name>, path)`, as src/application/commands/submodule.ts L677-690 does after a clone) and write `<path>/.git` = `submoduleGitfile(name, path) + '\n'` (src/domain/submodule/gitlink-path.ts L18, L27); (2) `removeDirectory(ctx, path)` (missing directory tolerated as `FILE_NOT_FOUND`, like files today). `<name>` = the `.gitmodules` row whose `path` equals the entry path (`parseGitmodules`), else the path. `.gitmodules` edit: when a row matched, `removeConfigSectionInText(text, \`submodule.${name}\`)` (src/application/primitives/update-config-sections.ts L130), write the file, hash it as a blob (`writeObject`) and add a fresh stage-0 `.gitmodules` entry (`indexEntryFromStat(lstat, FILE_MODE.REGULAR, blobId, '.gitmodules')`, pattern `stageSubmodule` in submodule.ts L607-645) into the entries `lock.commit` writes (L137). `--cached` does none of this. Keep `rm` under 20 lines per function (extract `removeWorkingTree`, `migrateGitDir`, `dropGitmodulesSection`).
- `test/unit/application/commands/rm.test.ts` — rows.
- `test/integration/gitlink-consumers-interop.test.ts` — rows (compare index via `git ls-files --stage`, the `.gitmodules` blob id, `git status --porcelain` on both twins, and the module dir's `config` bytes for the migration).
- `docs/use/commands/rm.md` — a "Submodules" paragraph: valve rule, directory removal, `.gitmodules` section removal and staging, migration, `--cached`, `-f`.

Pinned bytes (git 2.55):
- F2 unmoved, `rm sub`: exit 0; `sub` gone; `.gitmodules` empty and staged (`M  .gitmodules`, `D  sub`); staged blob id = git's (`e69de29…` when empty); .git/modules/sub kept. After `submodule deinit -f sub` (empty dir): same.
- .git directory inside `sub` (embedded), `rm sub`: exit 0, stderr `Migrating git directory of 'sub' from '<abs>/sub/.git' to '<abs>/.git/modules/sub'` (display only — tsgit emits none), then as above; .git/modules/sub/config holds `core.worktree` = git's value (pin the bytes), module HEAD/objects intact.
- moved, `rm -f sub`: exit 0, `sub` removed, `M  .gitmodules`, `D  sub`, .git/modules/sub kept.
- To pin (git first): working `.gitmodules` with unstaged edits, `rm sub` (expected: git refuses `Please stage your changes to .gitmodules or stash them to proceed` — if so, stop and hand back per D3 with the pinned output); no `.gitmodules` section for `sub` (expected: a warning, removal proceeds, `.gitmodules` unchanged and not staged); `.git/modules/<name>` already present while sub/.git is a directory (record what git does).

### TDD steps

One RED per function, run before its code.

1. RED — working-tree unit: `removeDirectory(ctx, 'sub')` removes a populated directory. Fails: the function does not exist.
2. GREEN — `removeDirectory`. GUARD — a regular file at the path refuses `CHECKOUT_OVERWRITE_DIRTY { localChanges: ['sub'], untracked: [] }`; GUARD — a path rejected by the path guard refuses as `removeFile` does.
3. RED — rm unit: clean gitfile submodule, `rm(ctx, ['sub'])` resolves, `sub` is gone, the index has no `sub`, `.git/modules/sub` still exists. Fails: `removeFile` rejects the directory with `CHECKOUT_OVERWRITE_DIRTY`.
4. GREEN — gitlink entries removed through `removeDirectory`. GUARD — `force: true` on a moved submodule removes it the same way.
5. RED — after step 3's call, the working `.gitmodules` no longer holds `[submodule "sub"]` and the index `.gitmodules` entry id is the blob of the new text. Fails: GREEN 4 leaves `.gitmodules` untouched.
6. GREEN — section removal + staging. GUARD — `cached: true` leaves `.gitmodules` and `sub` untouched.
7. RED — embedded `.git` directory submodule, `rm(ctx, ['sub'])` resolves and `.git/modules/sub` holds the former `sub/.git` (its `HEAD`) with `core.worktree` set. Fails: GREEN 4 deletes the repository with the directory.
8. GREEN — migration before removal.
9. Interop — rows above; "to pin" rows git-first.
10. Docs — rm.md paragraph.
11. REFACTOR — functions under 20 lines.

### Gate

```
npx vitest run test/unit/application/commands/rm test/unit/application/commands/internal/working-tree test/unit/application/commands/submodule && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/working-tree.ts src/application/commands/rm.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/commands/rm.test.ts test/integration/gitlink-consumers-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/commands/internal/working-tree.ts src/application/commands/rm.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/commands/rm.test.ts test/integration/gitlink-consumers-interop.test.ts docs/use/commands/rm.md
npm run check:write-surfaces && npm run check:doc-links
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/gitlink-consumers-interop.test.ts test/integration/rm-interop.test.ts test/integration/submodule-init-sync-deinit-interop.test.ts
```

### Commit

`fix(rm): remove a clean submodule and its .gitmodules section, migrating an embedded .git`
