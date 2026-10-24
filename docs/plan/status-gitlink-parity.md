# Plan — status and the comparison consumers treat a gitlink as git does

> Source: design doc `docs/design/status-gitlink-parity.md` · ADRs 1063, 1064, 1065, 1066, 1067, 1068, 1069, 1070, 1071, 1072 (Parts 15–17 inserted after the user ratified the long-HEAD fold)
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
| ADR-1071 `GITMODULES_NOT_STAGED` | 7 (member), 14 (throw site) |
| ADR-1072 broken HEAD (design LH1–LH8, SF11) | 15 (`PATH_TOO_LONG`), 16 (unreadable set, log/rev-parse twins), 17 (status unknown-HEAD state, LH + SF11 + r6–r9 rows) |
| R7 rebase with a staged gitlink (design CO14, CO14b, CO14c; regression fold) | 18 |
| R7/R9 gitlink written over a file occupant (design CO39, CO40) | 19 |
| R7 stash beyond a symbolic link (design CO38) | 20 |

## Decision candidates

Load-bearing choices the design and ADRs leave open. The plan is written against the
recommendation; the orchestrator confirms or redirects before Part 5.

| # | Choice | Alternatives | Recommendation | Why |
|---|---|---|---|---|
| D1 | How the dirty check runs the child's status without an import cycle (`status.ts` imports the new module; `check:architecture` / depcruise `no-circular` forbids the module importing `status.ts` back at runtime) | A. The module takes a `childStatus: (child: Context) => Promise<StatusResult>` parameter; `status.ts` and `rm.ts` pass `status` (type-only import of `StatusResult` is allowed). B. Extract the status core into a third module both import. C. Keep the child call inline in `status.ts`; the module only maps a `StatusResult` to flags | A | Smallest diff, keeps the dirty check in the module ADR-1063 names, and `rm` (ADR-1066) reuses it unchanged. B moves 400 lines. C splits the dirty check across two files and makes `rm` duplicate it |
| D2 | How the module reaches the child repository | A. Add `context: () => Promise<Context>` to the `repository` variant of `GitlinkCheckout`, built exactly as `head()` builds its child (`deriveGitlinkContext` + `refStorageOf`). B. Re-locate `<path>/.git` inside the module. C. Expose `gitDir`/`commonDir`/`fs` on the variant | A | One derivation, same bounds as lesson 008; B forks the locator #326 pinned; C leaks the locator's internals to every caller |
| D3 | `rm` of a submodule while the working `.gitmodules` has unstaged changes | A. Reuse an existing code (e.g. `RM_LOCAL_MODIFICATIONS { paths: ['.gitmodules'] }`). B. New error code naming the condition. C. Pin in Part 14 and stop with a blocker if git refuses | **Settled: B (ADR-1071).** Pinned on git 2.55 (design rows CO31–CO37): `rm sub`, `rm --cached sub` and `rm -f sub` all exit 128 `fatal: please stage your changes to .gitmodules or stash them to proceed` when the working `.gitmodules` differs from the index by content; a staged edit, a same-bytes rewrite and a deleted working file proceed. Code-only member `GITMODULES_NOT_STAGED` lands in Part 7, its throw site in Part 14 | A misnames the condition (exit 1, `-f` overrides it); git's refusal is exit 128 and `-f` does not override it |
| D4 | stash's "index differs from HEAD only at gitlinks" test (git runs `diff-index --cached --ignore-submodules`) | A. Flatten HEAD and compare non-gitlink index entries when `iTree !== bTree`. B. Reuse `diffIndexAgainstTreeKeyed(index, headTree)` and drop changes where both sides are gitlinks or one side is absent and the other a gitlink. C. Synthesize a second tree with gitlinks replaced by HEAD's | B | Reuses status's own diff; keeps git's rule that a gitlink↔file type change still counts |
| D5 | Where the `SUBMODULE_PATH_IS_SYMLINK` error member lands | A. Its own part (Part 7) with its domain test; its throw site lands in Part 9. B. Merged with its throw site (8 files, over the 6-file ceiling). C. Throw site first, `reports/api.json` deferred to a closing docs part | A | Keeps every part ≤ 6 files and `reports/api.json` in the part that changes the surface. Part 7's gate runs `npx knip` to confirm an export used only by tests is not reported; if it is, stop and hand back (fallback: B) |
| D9 | Where `node-file-system.ts` gets `pathTooLong` from (Part 15) | A. Direct import from domain/error.js. B. Add it to the domain barrel (7th file). C. Inline the `TsgitError` | **Settled: A** | Adapters already import domain/error.js directly; keeps the part at 6 files |
| D10 | What `log` / `rev-parse` refuse with over a broken HEAD (Part 16) | A. The code the candidate ladder yields (a dangling symref → the unborn-HEAD code). B. Special-case HEAD in the ladder so `PATH_TOO_LONG` propagates. C. Keep the code out of the unreadable set | **Settled: A** | A refusal where git refuses; ADR-1072's consequence amended accordingly |
| D11 | How `status` drops the HEAD tree for an unreadable HEAD (Part 17) | A. Gate `readHeadTreeEscaped` on `resolveRevisionName(ctx, 'HEAD')` (git's `is_initial`). B. Thread a flag through four signatures. C. Catch around the tree read (would swallow a corrupt-tree fault) | **Settled: A** | No plumbing; equivalent for unborn and readable HEADs |

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

## Part 7 — Add the SUBMODULE_PATH_IS_SYMLINK and GITMODULES_NOT_STAGED error codes

### Context

ADR-1069 and ADR-1071; decision candidate D5. **Public**: two new members of the exported `TsgitErrorData` union. Surface gates paid here: the union, the message switch, the exhaustiveness switch, the documented error table, `reports/api.json`. The throw sites land in Part 9 (symlink) and Part 14 (`.gitmodules`).

Files:
- `src/domain/submodule/error.ts` — `SubmoduleError` (L4-12) gains `| { readonly code: 'SUBMODULE_PATH_IS_SYMLINK'; readonly path: FilePath }` (import `FilePath` type from ../objects/object-id.js) and the code-only member `| { readonly code: 'GITMODULES_NOT_STAGED' }` (precedent for a field-less member: `NOTHING_TO_COMMIT` in src/domain/commands/error.ts L48). New constructors `submodulePathIsSymlink(path: FilePath): TsgitError` (doc comment naming git's refusal `expected submodule path '<path>' not to be a symbolic link`, exit 128, from the dirty check) and `gitmodulesNotStaged(): TsgitError` (doc comment: git's `is_staging_gitmodules_ok` — `rm` of a submodule dies `please stage your changes to .gitmodules or stash them to proceed`, exit 128, when the working `.gitmodules` differs from the index by content, under `--cached` and `-f` too).
- `src/domain/error.ts` — message switch: after `case 'SUBMODULE_PATH_EXISTS':` (near L749) add `case 'SUBMODULE_PATH_IS_SYMLINK': return \`expected submodule path '${data.path}' not to be a symbolic link\`;` and `case 'GITMODULES_NOT_STAGED': return 'please stage your changes to .gitmodules or stash them to proceed';`.
- `test/unit/domain/exhaustiveness.ts` — add `case 'SUBMODULE_PATH_IS_SYMLINK':` and `case 'GITMODULES_NOT_STAGED':` after `case 'SUBMODULE_PATH_EXISTS':` (L250).
- `test/unit/domain/submodule/error.test.ts` — constructor rows for both (follow the file's `describe('<constructor>')` > Given/When/Then style, `const sut = …`).
- `docs/use/errors.md` — "Repository state" table, two rows after `SUBMODULE_OBJECT_FORMAT_MISMATCH` (L275): `| \`SUBMODULE_PATH_IS_SYMLINK\` | \`path\` | \`status\` met a tracked gitlink whose path is a symbolic link while running git's dirty check. Mirrors git's \`expected submodule path '<path>' not to be a symbolic link\` (exit 128). Not raised when the submodule's ignore mode is \`dirty\` or \`all\`; the row then reads \`type-changed\`. |` and `| \`GITMODULES_NOT_STAGED\` | — | \`rm\` of a submodule found the working \`.gitmodules\` differing from the index by content, so the section removal it must stage would clobber an unstaged edit. Mirrors git's \`please stage your changes to .gitmodules or stash them to proceed\` (exit 128); raised under \`cached\` and \`force\` too. An absent working \`.gitmodules\` or a same-bytes rewrite proceeds. |`
- `reports/api.json` — `npm run docs:json`.

### TDD steps

One RED per function, run before its code.

1. RED — `submodulePathIsSymlink('sub')` has `.data` `{ code: 'SUBMODULE_PATH_IS_SYMLINK', path: 'sub' }`. Fails: the constructor does not exist (type error / import error).
2. GREEN — union member, constructor, message case, exhaustiveness case (the compiler requires both switch cases once the member exists).
3. GUARD — `.message` equals `SUBMODULE_PATH_IS_SYMLINK: expected submodule path 'sub' not to be a symbolic link` (passes: GREEN 2 added the message case the exhaustive switch forced).
4. RED — `gitmodulesNotStaged()` has `.data` `{ code: 'GITMODULES_NOT_STAGED' }` and no other key. Fails: the constructor does not exist.
5. GREEN — the second member, constructor, message case, exhaustiveness case.
6. GUARD — `.message` equals `GITMODULES_NOT_STAGED: please stage your changes to .gitmodules or stash them to proceed`.
7. Docs — the two errors.md rows; `npm run docs:json`; stage `reports/api.json`.
8. Run `npx knip`: it must not report either constructor as an unused export (each is imported by its test). If it does, stop and hand back per D5 — do not add a throw site here.

### Gate

```
npx vitest run test/unit/domain && npm run check:types && ./node_modules/.bin/biome check src/domain/submodule/error.ts src/domain/error.ts test/unit/domain/exhaustiveness.ts test/unit/domain/submodule/error.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/domain/submodule/error.ts src/domain/error.ts test/unit/domain/submodule/error.test.ts docs/use/errors.md
npx knip && npm run check:doc-links
```

### Commit

`fix(status): add the SUBMODULE_PATH_IS_SYMLINK and GITMODULES_NOT_STAGED error codes`

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

R8 (removal); ADR-1066, ADR-1071 (decision candidate D3, settled — design rows CO31–CO37). git: before anything happens to a gitlink entry — under `--cached` and `-f` too — a stage-0 `.gitmodules` entry whose working file exists and differs by content refuses `please stage your changes to .gitmodules or stash them to proceed` (exit 128); then a clean submodule's directory is removed recursively; a .git directory inside it is first migrated into `.git/modules/<name>` (module `config` gets `core.worktree`, the worktree gets a gitfile, then the directory goes); the `.gitmodules` section whose `path` matches is removed and `.gitmodules` is staged (when no section matches, the file is left alone and not staged; when the working `.gitmodules` is absent, nothing is edited or staged for it); `.git/modules/<name>` is kept; `--cached` touches the index only; `-f` removes a modified submodule the same way. The `@writes` tag of rm.ts (L10-13: surface `rm`, kind `equivalent-under-readback`, format `git-index-tree-state`) stays; `check:write-surfaces` must stay green.

`.gitmodules` staging check (ADR-1071): when any entry being removed is a gitlink, look up the stage-0 `.gitmodules` entry; if present, `compareWorkingTreeDelta(ctx, entry, provider, indexMtime)` — `modified` → `throw gitmodulesNotStaged()` (src/domain/submodule/error.ts, Part 7); `absent`, `unchanged` and `mode-changed` proceed (git compares content: a stat-only drift and a mode change are not `DATA_CHANGED`); a `type-changed` `.gitmodules` (a symlink) is pinned git-first and follows the pin. The check runs before the valve's own refusal order is consulted for the removal step, i.e. after `enforceSafetyValve` and before any removal or index edit, and it runs for `cached: true` as well.

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
- Pinned (git 2.55, orchestrator, design CO31–CO37): working `.gitmodules` with an unstaged comment appended — `rm sub`, `rm --cached sub` and `rm -f sub` all exit 128 `fatal: please stage your changes to .gitmodules or stash them to proceed`, nothing removed or unstaged (` M .gitmodules` stays) → `GITMODULES_NOT_STAGED {}`. Same edit staged (`git add .gitmodules`) → proceeds as CO21 (`M  .gitmodules`, `D  sub`, file empty). `.gitmodules` rewritten with identical bytes (stat drift only) → proceeds as CO21. Working `.gitmodules` deleted and not staged → proceeds: ` D .gitmodules` stays unstaged, `D  sub`, no section edit and nothing staged for `.gitmodules`. A second submodule `sub2` committed → `.gitmodules` keeps exactly `[submodule "sub2"]\n\tpath = sub2\n\turl = ../up\n`, `M  .gitmodules`, `D  sub`.
- To pin (git first): no `.gitmodules` section for `sub` (expected: a warning, removal proceeds, `.gitmodules` unchanged and not staged); `.git/modules/<name>` already present while sub/.git is a directory (record what git does); a symlink at `.gitmodules` (record whether git refuses).

### TDD steps

One RED per function, run before its code.

1. RED — working-tree unit: `removeDirectory(ctx, 'sub')` removes a populated directory. Fails: the function does not exist.
2. GREEN — `removeDirectory`. GUARD — a regular file at the path refuses `CHECKOUT_OVERWRITE_DIRTY { localChanges: ['sub'], untracked: [] }`; GUARD — a path rejected by the path guard refuses as `removeFile` does.
3. RED — rm unit: clean gitfile submodule, `rm(ctx, ['sub'])` resolves, `sub` is gone, the index has no `sub`, `.git/modules/sub` still exists. Fails: `removeFile` rejects the directory with `CHECKOUT_OVERWRITE_DIRTY`.
4. GREEN — gitlink entries removed through `removeDirectory`. GUARD — `force: true` on a moved submodule removes it the same way.
5. RED — after step 3's call, the working `.gitmodules` no longer holds `[submodule "sub"]` and the index `.gitmodules` entry id is the blob of the new text. Fails: GREEN 4 leaves `.gitmodules` untouched.
6. GREEN — section removal + staging. GUARD — `cached: true` leaves `.gitmodules` and `sub` untouched. GUARD — a second section `sub2` survives byte-for-byte (`removeConfigSectionInText` removes one section).
7. RED — working `.gitmodules` with an unstaged edit, `rm(ctx, ['sub'])` rejects `GITMODULES_NOT_STAGED` and leaves `sub`, the index and `.gitmodules` untouched. Fails: GREEN 6 edits and stages the file.
8. GREEN — the staging check (Context) before any removal. GUARD — the same with `cached: true` rejects the same way; GUARD — the same with `force: true` rejects the same way; GUARD — `.gitmodules` rewritten with identical bytes proceeds; GUARD — working `.gitmodules` deleted proceeds and stages nothing for it (the index `.gitmodules` entry is unchanged).
9. RED — embedded `.git` directory submodule, `rm(ctx, ['sub'])` resolves and `.git/modules/sub` holds the former `sub/.git` (its `HEAD`) with `core.worktree` set. Fails: GREEN 4 deletes the repository with the directory.
10. GREEN — migration before removal.
11. Interop — rows above (the pinned `.gitmodules` rows included); "to pin" rows git-first.
12. Docs — rm.md paragraph (include the staging refusal).
13. REFACTOR — functions under 20 lines.

### Gate

```
npx vitest run test/unit/application/commands/rm test/unit/application/commands/internal/working-tree test/unit/application/commands/submodule && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/working-tree.ts src/application/commands/rm.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/commands/rm.test.ts test/integration/gitlink-consumers-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/commands/internal/working-tree.ts src/application/commands/rm.ts test/unit/application/commands/internal/working-tree.test.ts test/unit/application/commands/rm.test.ts test/integration/gitlink-consumers-interop.test.ts docs/use/commands/rm.md
npm run check:write-surfaces && npm run check:doc-links
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/gitlink-consumers-interop.test.ts test/integration/rm-interop.test.ts test/integration/submodule-init-sync-deinit-interop.test.ts
```

### Commit

`fix(rm): remove a clean submodule and its .gitmodules section, migrating an embedded .git`
## Part 15 — Name a path too long for the file system

### Context

ADR-1072 (first layer: the adapter names the errno). **Public**: a new member of the exported `TsgitErrorData` union (`AdapterError`). Surface gates paid here: the union, the message switch, the exhaustiveness switch, the documented error table, and reports/api.json (regenerate; stage it only if it changes — error-code literals were not emitted by name when Part 7 added two members, so it is expected byte-identical). The constructor `pathTooLong` is **internal**: only the node adapter and the tests import it; it is not re-exported from the package entry (src/index.ts re-exports `TsgitError` alone from src/domain/error.ts).

No behaviour other than the error code changes in this part. After it, tsgit `status` over a HEAD whose target's loose path is too long rejects `PATH_TOO_LONG` instead of `UNSUPPORTED_OPERATION { operation: 'filesystem', reason: 'ENAMETOOLONG' }`; Parts 16 and 17 turn that into git's shape.

Files:
- `src/domain/error.ts` — `AdapterError` (L17-31 at df242b83): add `| { readonly code: 'PATH_TOO_LONG'; readonly path: string }` after the `FILE_NOT_FOUND` member. Constructor after `fileNotFound` (L138-139): `export const pathTooLong = (path: string): TsgitError => new TsgitError({ code: 'PATH_TOO_LONG', path });` with a one-line doc comment saying why it exists: the file system refused a path component or the whole path as too long (`ENAMETOOLONG`); git's files backend treats a loose ref whose `lstat` fails that way as not resolving. Message switch: after `case 'FILE_NOT_FOUND': return \`file not found: ${basename(data.path)}\`;` (L316-317) add `case 'PATH_TOO_LONG': return \`file name too long: ${basename(data.path)}\`;` (the C library's message for `ENAMETOOLONG`, lower-cased like its siblings; `basename` keeps directories out of the message like every path-bearing adapter code).
- `test/unit/domain/exhaustiveness.ts` — add `case 'PATH_TOO_LONG':` after `case 'FILE_NOT_FOUND':` (L38). The `never` assignment at L291 makes the compiler demand it.
- `test/unit/domain/error.test.ts` — `describe('domain error — AdapterError')` > `describe('factory functions')` (L76-77): a `describe("Given pathTooLong('/repo/.git/refs/heads/overlong')")` block after the `fileNotFound` block (L78-88), same shape (`When checking data` > `Then code is PATH_TOO_LONG and path preserved`, `expect(result.data).toEqual({ code: 'PATH_TOO_LONG', path: … })`). `describe('path sanitization in error.message (security)')` (L247): a `Given PATH_TOO_LONG with absolute path` block after the `PERMISSION_DENIED` one (L303-315), same shape: message contains `file name too long: overlong` and not the directory part. Import `pathTooLong` beside `fileNotFound` (L53).
- `docs/use/errors.md` — "Adapters & I/O" table (L36-49). The table is alphabetical, so the row goes after `OPERATION_ABORTED` and before `PERMISSION_DENIED`: `| \`PATH_TOO_LONG\` | \`path\` | The file system refused a path component, or the whole path, as longer than it allows (\`ENAMETOOLONG\`; node adapter only — memory and browser never raise it). git treats a ref whose loose path is too long as not resolving: reading resolutions answer absent, and \`status\` reports such a HEAD as unknown. |` (the last clause becomes true at the end of Part 17; the three parts land in one PR).
- `src/adapters/node/node-file-system.ts` — `mapErrno(err: NodeJS.ErrnoException, path: string): TsgitError` (L308-334, `/** @internal */`): add `case 'ENAMETOOLONG': return pathTooLong(path);` after the `EISDIR` arm and before `default:`. One why-comment line: git's files backend treats any `lstat` errno but `ENOENT` as a ref that does not resolve, so the reader needs this errno told apart from an unsupported operation. Import: `import { pathTooLong } from '../../domain/error.js';` as a separate import line (decision candidate D9; precedent src/adapters/inflate.ts L11). Two `// Stryker disable next-line` comments sit above `case 'EPERM':` and `case 'ELOOP':` and bind to the line directly below each one: do not put anything between a comment and its case, and do not add a suppression to the new case.
- `test/unit/adapters/node/node-file-system.test.ts` — `describe('mapErrno')` > `describe('Given an errno code on the underlying error')` > `describe('When mapping')` > the `it.each([...])('Then $label', …)` table (L1162-1256). Add a row after the `EISDIR` row: `{ code: 'ENAMETOOLONG', path: '/repo/.git/refs/heads/overlong', expectedCode: 'PATH_TOO_LONG', extra: (data) => { if (data.code === 'PATH_TOO_LONG') expect(data.path).toBe('/repo/.git/refs/heads/overlong'); }, label: 'ENAMETOOLONG returns PATH_TOO_LONG carrying the path' }`.

Read-only references: src/domain/index.ts (the domain barrel; it lists the adapter constructors, and this part leaves it alone, see D9); test/unit/adapters/node/node-file-system-injected.test.ts `ERRNO_TABLE` (L93-101; leave it alone, since `mapErrno` is unit-tested through the table above).

Known consumers that branched on `UNSUPPORTED_OPERATION`, where an `ENAMETOOLONG` now carries `PATH_TOO_LONG`. No row pins any of them, so do not edit them: `isWindowsSymlinkRefusal` (node-file-system.ts L245-256, Windows only), `classifyFault` (src/application/primitives/internal/pack-artefact-source.ts L44-56), the write fallback in src/application/commands/internal/working-tree.ts L60-72, `isStoreFault` (src/application/commands/internal/fsck/object-cache.ts L161). If an existing suite goes red because of one of them, stop and hand back `{ unit, reason, ≤3 options }`.

**Decision candidate D9** (the orchestrator confirms): where `node-file-system.ts` gets `pathTooLong` from. A. A direct import from ../../domain/error.js, with the domain barrel untouched (keeps the part at 6 files; adapters already import from domain/error.js directly). B. Add it to the domain barrel (src/domain/index.ts) beside its siblings and import it in the existing block (consistent with the file's other constructors, but a 7th file). C. Inline `new TsgitError({ code: 'PATH_TOO_LONG', path })` in `mapErrno` (no constructor, but every other errno arm uses one). **Recommendation: A.**

### TDD steps

One RED per function, run before its code.

1. RED: error.test.ts, `pathTooLong('/repo/.git/refs/heads/overlong').data` equals `{ code: 'PATH_TOO_LONG', path: '/repo/.git/refs/heads/overlong' }`. Fails because `pathTooLong` does not exist (`pathTooLong is not a function` / type error).
2. GREEN: the union member, the constructor, the message case and the exhaustiveness case (the compiler forces both switch cases once the member exists).
3. GUARD: the sanitization row. The message contains `file name too long: overlong` and does not contain `/repo/.git/refs/heads` (passes because GREEN 2 used `basename`). Also check that `.message` equals `PATH_TOO_LONG: file name too long: overlong` exactly, in the same `it`.
4. RED: node-file-system.test.ts, the `ENAMETOOLONG` row of the `mapErrno` table. Fails because today `mapErrno` answers `UNSUPPORTED_OPERATION` (operation `filesystem`, reason `ENAMETOOLONG`).
5. GREEN: the `ENAMETOOLONG` arm in `mapErrno`.
6. GUARD: the `EOTHER` and `undefined` rows of the same table still answer `UNSUPPORTED_OPERATION` (pass because the new arm matches only `ENAMETOOLONG`).
7. Docs: the errors.md row. Run `npm run docs:json`; if reports/api.json changed, stage it with the part (it is then the part's 7th path; record that in the hand-back).
8. Run `npx knip`. It must not report `pathTooLong` (the adapter imports it). If it does, stop and hand back.

### Gate

```
npx vitest run test/unit/domain test/unit/adapters/node && npm run check:types && ./node_modules/.bin/biome check src/domain/error.ts src/adapters/node/node-file-system.ts test/unit/domain/exhaustiveness.ts test/unit/domain/error.test.ts test/unit/adapters/node/node-file-system.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/domain/error.ts src/adapters/node/node-file-system.ts test/unit/domain/error.test.ts test/unit/adapters/node/node-file-system.test.ts docs/use/errors.md
npx depcruise src/ --config .dependency-cruiser.cjs && npx knip && npm run check:doc-links
npx vitest run test/unit/domain/error test/unit/adapters/node/node-file-system.test --coverage --coverage.include=src/domain/error.ts --coverage.include=src/adapters/node/node-file-system.ts --coverage.reporter=text
```

Read the "Coverage summary" block of the last command. The new constructor, message case and `mapErrno` arm must be covered; the per-file table lists only files below 100%.

### Commit

`fix(adapters): name a path too long for the file system`

## Part 16 — Read a ref whose loose path is too long as unresolvable

### Context

ADR-1072 (second layer). git's `files_read_raw_ref` gives up on any `lstat` errno other than `ENOENT` without reading `packed-refs`, and `refs_resolve_ref_unsafe` returns NULL. In tsgit, that NULL is the `UNREADABLE_REF_CODES` set: every reading resolution (`resolveTerminalName`, `resolveRefForReading`, `refResolvesForReading`, `readRefCandidate`, and the callers that consult the set directly) answers absent for those codes, while `resolveRef` / `resolveRefOrMissing` still throw them. Adding `PATH_TOO_LONG` to the set is the whole source change. No new symbol.

Effect on the commands (pinned by this part's interop rows). `rev-parse HEAD` and `log` over a HEAD whose target is too long go through `readRefCandidate` (src/application/commands/internal/commit-ish.ts `peeledCandidate`, src/application/commands/internal/revision-name.ts `resolveCandidate`). After this part the chain fault is unreadable, so `unreadableCandidate('HEAD')` re-reads HEAD alone (symbolic) and answers `{ kind: 'dangling-symref' }`. No warning is emitted, because `warnSkipped` in src/application/commands/internal/refname-ambiguity.ts L67-71 skips `HEAD` as git's `expand_ref` does. The ladder then misses, so tsgit refuses as it does for an unborn HEAD. The unit row in test/unit/application/commands/log.test.ts L283-305 pins `OBJECT_NOT_FOUND` for log over an unborn HEAD. Before this part, the same calls reject `PATH_TOO_LONG` (Part 15). Both are refusals where git refuses. See decision candidate D10 on the ADR's "refuse with PATH_TOO_LONG" wording.

Files:
- `src/application/primitives/resolve-ref.ts` — `export const UNREADABLE_REF_CODES: ReadonlySet<string>` (L26-31): add `'PATH_TOO_LONG'`. Rewrite its doc comment (L22-25), which says git returns NULL "for all four", so that it also names a loose path the file system refuses as too long (git's `lstat` failing with an errno other than `ENOENT`). The `// Stryker disable next-line StringLiteral` comments at L48, L69 and L128 bind to the line below each one; leave them where they are.
- `test/unit/application/primitives/resolve-ref.test.ts` — add a fault helper beside `permissionDeniedOn` (L746-763):
  `const pathTooLongOn = (base: Context, target: string): Context => ({ ...base, fs: { ...base.fs, lstatIfReachable: async (path) => { if (path === target) throw pathTooLong(path); return lstatIfReachable(base.fs, path); } } });`
  Import `pathTooLong` from src/domain/error.ts (next to `permissionDenied`, L13) and `lstatIfReachable` from src/application/primitives/internal/fs-probes.ts. The memory file system provides `lstatIfReachable`, and `resolveDirect` (src/application/primitives/ref-store.ts L938-952) asks `isLooseMiss` → `lstatIfReachable(ctx.fs, path)` first, so the fault surfaces there exactly as the node adapter's `lstat` raises it. Fixture: `buildSeededContext({ refs: [{ name: 'refs/heads/main', id: MAIN_ID }] })` from test/unit/application/primitives/fixtures.ts. The target is `/repo/.git/refs/heads/overlong`. For the HEAD rows, also `await base.fs.writeUtf8('/repo/.git/HEAD', 'ref: refs/heads/overlong\n')`. Rows go in the existing top-level describes: `describe('resolveRefForReading')` L765, `describe('resolveRef')` L28, `describe('resolveTerminalName')` L585, `describe('readRefCandidate')` L789. Each gets a `Given a ref whose loose path the file system refuses as too long` block. Error rows use try/catch (or `.catch((err: TsgitError) => err.data)` as the file's L778 does) and assert `{ code: 'PATH_TOO_LONG', path: target }`.
- `test/integration/broken-head-interop.test.ts` — NEW suite. Part 17 extends it. Header: `@proves` with `surface: log, revParse`, `bucket: cross-tool-interop`, `unique: a HEAD whose branch cannot be read refuses log and rev-parse as git does`, `interopSurface: log, revParse`. Wrap it in `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`. Fixture (once, in `mkdtemp`): `git init -q -b main`, `k` = `k\n`, `git add k`, commit `c` (pinned dates, `-c user.name=t -c user.email=t@t -c commit.gpgsign=false`), then `u` = `u\n` and `git add u`. Copy the suite-local `pinnedEnv()` / `gitIn()` pattern from test/integration/status-gitlink-interop.test.ts L59-80 (they are not exported). Copy the fixture twice with `cp(…, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })`. In EACH twin, write the HEAD with `writeFile(path.join(twin, '.git', 'HEAD'), \`ref: refs/heads/${'1'.repeat(LONG_NAME_LENGTH)}\n\`)`, with `const LONG_NAME_LENGTH = 5000`. git refuses to create that ref itself, so write the file directly. Build `createNodeContext({ workDir: tsgitTwin })` after the write. Run git through `tryRunGitWithExit(['-C', gitTwin, …], { env: pinnedEnv() })` from test/integration/interop-helpers.ts. Row timeout 60 s.

Pinned bytes (git 2.55, orchestrator ×3 for LH1; LH4/LH5 ×1, re-run git first):
- LH4: `git rev-parse HEAD` → exit 128, first stderr line `fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.`. tsgit: `revParse(ctx, 'HEAD')` (src/application/commands/rev-parse.ts L104) rejects. Assert the `.data` code you observe and every field of it.
- LH5: `git log -1` → exit 128, stderr `fatal: your current branch appears to be broken`. tsgit: `log(ctx)` (src/application/commands/log.ts, which resolves `opts.rev ?? 'HEAD'` through `resolveCommit`) rejects. Assert the `.data` code you observe and every field of it (expected by trace: the unborn-HEAD code, `OBJECT_NOT_FOUND`; see D10).
- Run git FIRST for each row, then tsgit. A git line that surprises is run three times. The library emits no message (ADR-249): the tsgit assertion is the refusal's structured data, never git's text.

**Decision candidate D10** (the orchestrator confirms): ADR-1072's consequence says `log` and `rev-parse` over a broken HEAD "refuse with PATH_TOO_LONG". By trace, adding the code to the reading set makes them refuse with the unborn-HEAD code instead (the candidate ladder classifies HEAD as a dangling symref). A. Accept the observed code. It is a refusal where git refuses, and it matches how git's own ladder reads the HEAD (a NULL resolution). The orchestrator amends the ADR's consequence line. B. Special-case `HEAD` in the ladder so the chain fault propagates. That edits commit-ish.ts / revision-name.ts, outside this part, and it also changes the unborn behaviour's code path. C. Leave `PATH_TOO_LONG` out of the set and catch it in `status` only. This contradicts the ADR's decision, and `status`'s `resolveRevisionName(ctx, 'HEAD')` would still reject. **Recommendation: A.**

### TDD steps

One RED per function, run before its code.

1. RED: `resolveRefForReading(pathTooLongOn(base, target), 'refs/heads/overlong')` resolves to `undefined`. Fails because today the fault is not in the set, so the call rejects `{ code: 'PATH_TOO_LONG', path: '/repo/.git/refs/heads/overlong' }`.
2. GREEN: add `'PATH_TOO_LONG'` to `UNREADABLE_REF_CODES` and rewrite its doc comment.
3. GUARD: `resolveRef(ctx, 'refs/heads/overlong')` rejects with `.data` equal to `{ code: 'PATH_TOO_LONG', path: target }` (passes because `resolveRef` never consults the set: the write and commit side still refuses).
4. GUARD: with HEAD → `refs/heads/overlong`, `resolveTerminalName(ctx, 'HEAD')` resolves to `undefined` (passes because its catch uses the set GREEN 2 widened).
5. GUARD: with HEAD → `refs/heads/overlong`, `readRefCandidate(ctx, 'HEAD')` resolves to `{ kind: 'dangling-symref' }` (passes because `unreadableCandidate` re-reads HEAD alone, which is symbolic and readable). This is the row the command-level behaviour below rests on.
6. Interop: create test/integration/broken-head-interop.test.ts with the fixture and the LH4 and LH5 rows, git first. If tsgit resolves instead of refusing, stop and hand back with the red row: the fold would lie in the rev-parse ladder, outside this part.
7. REFACTOR: none expected. Keep the doc comment terse and free of phase, ADR or row ids.

### Gate

```
npx vitest run test/unit/application/primitives/resolve-ref test/unit/application/primitives/ref-store test/unit/application/commands/rev-parse test/unit/application/commands/log test/unit/application/commands/branch test/unit/application/commands/tag test/unit/application/commands/reflog test/unit/application/commands/rev-list test/unit/application/commands/status && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/resolve-ref.ts test/unit/application/primitives/resolve-ref.test.ts test/integration/broken-head-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/primitives/resolve-ref.ts test/unit/application/primitives/resolve-ref.test.ts test/integration/broken-head-interop.test.ts
npx depcruise src/ --config .dependency-cruiser.cjs
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/broken-head-interop.test.ts test/integration/rev-parse-dwim-interop.test.ts test/integration/head-symlink-interop.test.ts
```

### Commit

`fix(refs): read a ref whose loose path is too long as unresolvable, as git does`

## Part 17 — Report a HEAD whose target cannot be read as unknown in status

### Context

ADR-1072 (third layer); design rows LH1–LH3, LH6–LH8 (LH7 = SF11). git's `wt_status_prepare` sets `s->branch` from resolving `HEAD`. That is NULL whenever the chain cannot be read (an `lstat` errno other than `ENOENT`, a target name that fails `check_refname_format`, a cycle, unparseable content), and git prints `# branch.head (unknown)`. `s->is_initial` comes from `repo_get_oid("HEAD")` failing, giving `# branch.oid (initial)`: every index entry is a staged add. An unborn branch (`ENOENT`) keeps its name. tsgit's structured form of `(unknown)` is `branch: undefined` with `detached: false`. Detached stays `branch: undefined, detached: true`. On a branch, `branch` is set. No new public field: the documented meaning of an existing pair is the surface change.

Current code (src/application/commands/status.ts at df242b83; Parts 8–9 may shift it, so relocate by symbol):
- `statusInScope(ctx: Context, opts: StatusOptions): Promise<StatusResult>` (L219-242) reads `const head = await readHeadRaw(ctx);` (L224; `readHeadRaw` / `branchRefFromHead` come from ./internal/repo-state.js, defined in src/application/primitives/internal/repo-state.ts L445-453; `readHeadRaw` throws `REF_NOT_FOUND` on a missing HEAD and propagates every parse fault, e.g. `INVALID_REF` for `ref: refs/heads/a..b`), and ends with `return { branch: branchRefFromHead(head), detached: head.kind === 'direct', ...report };` (L237).
- `reportStatus(ctx, { index, tracked, scanned, workDir })` (L363-390) runs `await resolveRevisionName(ctx, HEAD_NAME);` (L379; src/application/commands/internal/revision-name.ts L46: git's `get_oid("HEAD")`, returns `ObjectId | undefined`; after Part 16 a broken HEAD reads as a dangling candidate there and answers `undefined`), then `const headTree = await readHeadTreeEscaped(ctx);` (L380). `readHeadTreeEscaped` → `readHeadTreeWith` (src/application/primitives/read-head-tree.ts L117-139) calls `resolveRef(ctx, 'HEAD')`, folds only `REF_NOT_FOUND` into `undefined`, and so rejects `PATH_TOO_LONG` / `INVALID_REF` / `REF_CYCLE_DETECTED`. That rejection is where the design's "today" column comes from.

Change (decision candidate D11):
- `reportStatus`: `const headId = await resolveRevisionName(ctx, HEAD_NAME); const headTree = headId === undefined ? undefined : await readHeadTreeEscaped(ctx);`. This is git's `is_initial`: no oid for HEAD means no HEAD tree. For an unborn HEAD it is equivalent (the tree read answered `undefined` anyway), and a readable HEAD keeps today's read.
- `statusInScope`: replace the `readHeadRaw` line and the `branch`/`detached` expression with one call to a new private `headViewOf(ctx): Promise<Pick<StatusResult, 'branch' | 'detached'>>`, placed where `readHeadRaw` was called (before `readIndex`), and spread it into the result: `return { ...head, ...report };`.
  ```ts
  /** git's `branch.head`: the branch HEAD names, detached, or unknown when HEAD's chain cannot be read. */
  const headViewOf = async (ctx: Context): Promise<HeadView> => {
    try {
      const head = await readHeadRaw(ctx);
      await resolveRefOrMissing(ctx, HEAD_NAME);
      return { branch: branchRefFromHead(head), detached: head.kind === 'direct' };
    } catch (err) {
      if (isUnreadableRef(err)) return UNKNOWN_HEAD;
      throw err;
    }
  };
  ```
  with `type HeadView = Pick<StatusResult, 'branch' | 'detached'>` and `const UNKNOWN_HEAD: HeadView = { branch: undefined, detached: false };`. `resolveRefOrMissing` (src/application/primitives/resolve-ref.ts L105) answers `undefined` for an unborn target, so an unborn HEAD keeps its name. The call is unconditional on purpose: a detached HEAD resolves to its own id without a fault, so a `head.kind === 'symbolic'` guard would only add an equivalent mutant. A missing HEAD still rejects `REF_NOT_FOUND`, and a non-ref fault (e.g. `PERMISSION_DENIED`) still rejects. It costs one extra chain resolution per `status` call (loose-ref reads, no object read).
- `src/application/primitives/resolve-ref.ts`: rename the private `const isUnreadable = (err: unknown): boolean => …` (L129) to `export const isUnreadableRef` (**internal**: imported by status.ts only, not barrelled, not public), give it a one-line doc comment, and update its two call sites (L143 in `unreadableCandidate`, L164 in `readRefCandidate`). Its `// Stryker disable next-line StringLiteral` comment (L128) must stay directly above the declaration line. Exporting the existing predicate means status.ts adds no `?? ''` fallback and no new equivalent mutant.

Files:
- `src/application/commands/status.ts` — `headViewOf`, `UNKNOWN_HEAD`, `HeadView`, the `statusInScope` and `reportStatus` edits. Imports: `isUnreadableRef`, `resolveRefOrMissing` from ../primitives/resolve-ref.js. Keep every function under 20 lines.
- `src/application/primitives/resolve-ref.ts` — the `isUnreadableRef` export.
- `test/unit/application/commands/status.test.ts` — new rows in the top-level describe that holds `Given a detached HEAD pointing at a commit oid` (L189-207), after that block. Fixture: `seedClean()` (L43-50; commits `a.txt`). Fault ctx in the file's own pattern (L345-362: `{ ...ctx, fs: { ...ctx.fs, <method>: async (path) => … } }`): `lstatIfReachable: async (path: string) => { if (path === target) throw pathTooLong(path); return lstatIfReachable(ctx.fs, path); }` with `target = \`${ctx.layout.gitDir}/refs/heads/overlong\``, after `await ctx.fs.writeUtf8(\`${ctx.layout.gitDir}/HEAD\`, 'ref: refs/heads/overlong\n')`. Import `pathTooLong` from src/domain/error.ts and `lstatIfReachable` from src/application/primitives/internal/fs-probes.ts. A helper `changeFor(result, path)` already exists in the file.
- `docs/use/commands/status.md` — Signature (L16-17): trailing comments on the two fields: `branch` = `// the branch HEAD names; undefined when detached or unknown`, `detached` = `// true only when HEAD holds an object id`. Behaviour: replace the `**Detached HEAD:**` bullet (L85) with a `**HEAD states.**` bullet listing the three states. On a branch: `branch` set, `detached: false` (an unborn branch keeps its name). Detached: `branch` undefined, `detached: true`. Unknown: `branch` undefined, `detached: false`, git's `# branch.head (unknown)`. Unknown happens when HEAD's chain cannot be read: a target whose loose path the file system refuses as too long, a target name git refuses, or a symbolic cycle. The report then has no HEAD tree, so every staged entry is `added` with no `head` side, as in git's `# branch.oid (initial)`. Leave the Unborn HEAD bullet (L76) as it is.
- `test/integration/broken-head-interop.test.ts` — extend Part 16's suite: header `surface: status, log, revParse`, `interopSurface: status, log, revParse`, and `unique:` reworded to cover status. The rows are listed under "Pinned bytes".
- `test/integration/status-gitlink-interop.test.ts` — one entry in `ROWS` (L330-…) for SF11: `['a module HEAD naming a branch too long for the file system', async (repo) => writeFile(path.join(moduleDir(repo), 'HEAD'), \`ref: refs/heads/${'1'.repeat(LONG_NAME_LENGTH)}\n\`)]`, with `const LONG_NAME_LENGTH = 5000` beside the suite's constants (L44-53). `moduleDir` is at L88. The `describe.each(ROWS)` comparator (L459-482) checks the change fields and the untracked list against git.

Pinned bytes (git 2.55). For the new suite, compare `git status --porcelain=v2 --branch` in the git twin with tsgit's `status(ctx)` in the tsgit twin. Rebuild git's ordinary lines from `ChangedPath` with a suite-local copy of the `fieldsOf` / `gitFieldsOf` pair (status-gitlink-interop.test.ts L397-415; not exported). The header lines are asserted structurally:
- LH1 (orchestrator ×3): HEAD → `ref: refs/heads/<5000 × '1'>`. git exit 0, `# branch.oid (initial)`, `# branch.head (unknown)`, `1 A. N... 000000 100644 100644 <40 zeros> <blob> k` and the same for `u`. tsgit: `branch` undefined, `detached` false, changes equal git's lines (every `staged: 'added'`, no `head`), `untracked` empty, `clean` false.
- LH2 (orchestrator): HEAD → `ref: refs/heads/<300 × 'a'>` (over `NAME_MAX`). Same as LH1.
- LH3, GUARD (orchestrator, and run on tsgit by the Part 6 implementer: `branch: 'refs/heads/none'`): HEAD → `ref: refs/heads/none`. git `# branch.oid (initial)`, `# branch.head none`, the same `A.` lines. tsgit: `branch === 'refs/heads/none'`, `detached` false, the same changes.
- LH6 (planner, ×3): LH1's HEAD, `git symbolic-ref HEAD` → exit 128, stderr exactly `fatal: No such ref: HEAD\n`. tsgit has no symbolic-ref command (none in src/application/commands/index.ts or the Repository facade), so the row asserts git's exit and stderr and tsgit's structured equivalent: `status(ctx).branch === undefined` with `detached === false` (HEAD names no branch).
- LH8 (planner, ×3 each): HEAD → `ref: refs/heads/a..b`, and HEAD → `refs/heads/c1`, `refs/heads/c1` = `ref: refs/heads/c2\n`, `refs/heads/c2` = `ref: refs/heads/c1\n` (written with `writeFile`, after the copy, in each twin). git exit 0 for both, `# branch.oid (initial)`, `# branch.head (unknown)`, the same `A.` lines as LH1. tsgit: as LH1. If tsgit's repository discovery (src/repository/find-layout.ts `hasValidHead`) refuses the `a..b` HEAD before `status` runs, stop and hand back: the fold lies outside this part.
- LH7 = SF11 (design row): superproject `status` with the module's HEAD → `ref: refs/heads/<5000 × '1'>` → git `1 .M S.M. 160000 160000 160000 <A> <A> sub`, exit 0. The child status now succeeds with every child index entry a staged add (tracked changes → `M`). The gitlink HEAD comparison folds the child's unreadable HEAD into "unchanged" (`checkedOutHead` in src/application/primitives/compare-working-tree-entry.ts catches the `TsgitError`), so `commitChanged` stays false.

**Decision candidate D11** (the orchestrator confirms): how `status` drops the HEAD tree for an unreadable HEAD. A. Gate `readHeadTreeEscaped` on `resolveRevisionName(ctx, 'HEAD')`'s result, which `reportStatus` already computes. That is git's own `is_initial`, needs no plumbing, and is equivalent for unborn and readable HEADs. B. Thread a flag or a tree-loader from `statusInScope` through `scanAndReport` → `LockedScan` → `reportUnderLock` → `reportStatus`: four signatures for one bit. C. Catch the unreadable codes around `readHeadTreeEscaped`. That would also swallow an `INVALID_OBJECT_ID` raised while flattening a corrupt tree and report it as initial. **Recommendation: A.**

### TDD steps

One RED per function, run before its code.

1. RED: status.test.ts `Given a HEAD whose branch's loose path is too long for the file system` > `When status` > `Then every index entry is a staged add with no head side`: `changeFor(result, 'a.txt')` has `staged: 'added'` and `head` undefined, and `clean` is false. Fails because `status` rejects `{ code: 'PATH_TOO_LONG', path: target }` from `readHeadTreeEscaped` (`reportStatus` reads the HEAD tree through `resolveRef`).
2. GREEN: `reportStatus` gates the tree read on `resolveRevisionName`'s result.
3. GUARD: the unborn row `Given an unborn HEAD with staged files` (L504-526, run today) still passes, because GREEN 2 is equivalent for an unborn HEAD.
4. RED: same Given, `Then branch is undefined and detached is false`. Fails because `branch` is `'refs/heads/overlong'` (`branchRefFromHead` names the unreadable target).
5. GREEN: `isUnreadableRef` export in resolve-ref.ts, `headViewOf` + `UNKNOWN_HEAD` in status.ts, `statusInScope` spreads the view.
6. GUARD: `Given a HEAD naming a branch git refuses (a..b)`. `branch` undefined, `detached` false, `a.txt` a staged add. Passes because GREEN 5's catch wraps `readHeadRaw`, which rejects `INVALID_REF`, and GREEN 2 skips the tree because `resolveRevisionName` answers `undefined`.
7. GUARD: `Given a HEAD whose branch is a symbolic cycle` (HEAD → `refs/heads/c1` → `c2` → `c1`, written with `ctx.fs.writeUtf8`). Same expectations. Passes because `resolveRefOrMissing` rejects `REF_CYCLE_DETECTED`, which is in the set.
8. GUARD: `Given a HEAD whose branch's loose path cannot be read for a reason git does not fold` (the fault ctx throwing `permissionDenied(path)` instead): `status` rejects with `.data` equal to `{ code: 'PERMISSION_DENIED', path: target }`. Passes because `headViewOf` rethrows. This row covers the rethrow branch.
9. GUARD: `Given an unborn HEAD`: `init` only, `status(ctx)` gives `branch === 'refs/heads/main'` and `detached === false` (passes because `resolveRefOrMissing` answers `undefined` without throwing). The existing detached row (L189-207, run today) still passes.
10. Interop: extend test/integration/broken-head-interop.test.ts with LH1, LH2, LH3, LH6 and LH8, git first, and add the SF11 entry to `ROWS` in test/integration/status-gitlink-interop.test.ts. In the same suite add the four ignore-configuration rows Part 9 left out, from the design's SC table: r6 (`.gitmodules` `ignore = bogus`, moved → git exit 0, stderr `warning: Invalid parameter 'bogus' for config option 'submodule.sub.ignore'`, the `SC..` row shown; tsgit shows the row, no refusal), r7 (valueless `[submodule "sub"] ignore` in `.git/config`, and valueless `[diff] ignoreSubmodules` → git exit 128 `error: missing value for '<key>'` then `fatal: bad config variable …`; tsgit `CONFIG_MISSING_VALUE` with key, source, line — assert every field), r8 (`ignore = all`, gitlink staged via `update-index --cacheinfo 160000,<C>,sub` → `1 M. S... 160000 160000 160000 <A> <C> sub`, the staged column stays), r9 (`ignore = all`, `sub` replaced by a file, and `sub` removed → no line for either). If a pin disagrees with what is written here, git wins and the hand-back says so.
11. Docs: the status.md Signature comments and the HEAD-states bullet.
12. REFACTOR: functions under 20 lines; no phase, ADR or row ids in code or test titles.

### Gate

```
npx vitest run test/unit/application/commands/status test/unit/application/primitives/resolve-ref test/unit/application/primitives/read-head-tree test/unit/application/commands/rev-parse test/unit/application/commands/log && npm run check:types && ./node_modules/.bin/biome check src/application/commands/status.ts src/application/primitives/resolve-ref.ts test/unit/application/commands/status.test.ts test/integration/broken-head-interop.test.ts test/integration/status-gitlink-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/commands/status.ts src/application/primitives/resolve-ref.ts test/unit/application/commands/status.test.ts test/integration/broken-head-interop.test.ts test/integration/status-gitlink-interop.test.ts docs/use/commands/status.md
npx depcruise src/ --config .dependency-cruiser.cjs && npx knip && npm run check:doc-links
npx vitest run test/unit/application/commands/status test/unit/application/primitives/resolve-ref --coverage --coverage.include=src/application/commands/status.ts --coverage.include=src/application/primitives/resolve-ref.ts --coverage.reporter=text
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/broken-head-interop.test.ts test/integration/status-gitlink-interop.test.ts test/integration/status-interop.test.ts test/integration/status-embedded-repository-interop.test.ts test/integration/head-symlink-interop.test.ts test/integration/rev-parse-dwim-interop.test.ts
```

### Commit

`fix(status): report a HEAD whose target cannot be read as unknown, as git does`

## Part 18 — Carry a staged gitlink through rebase's onto checkout and refuse the first pick, as git does

### Context

R7 (rebase); design rows CO14 (corrected), CO14b, CO14c; fold of a regression Part 11 introduced. git's rebase pre-flight (`require_clean_work_tree(…, ignore_submodules = 1)`) lets a staged gitlink change through; what follows is two git steps, pinned by the Part 11 implementer (×3) and refined here:

1. `checkout_onto` → `reset_head` runs a two-way `unpack_trees` from HEAD's tree to `onto`'s tree over the index. For a path where the index entry differs from both trees: when HEAD's and `onto`'s entries are the same (two-way merge cases 14/15) the index entry is KEPT; when they differ, `reject_merge` → stderr `error: Entry 'sub' would be overwritten by merge. Cannot merge.` then `fatal: Could not detach HEAD`, exit 128, and nothing has been written (no `ORIG_HEAD` update, no state dir, HEAD still on the branch) — to pin git-first (CO14c).
2. `do_pick_commit` runs `index_differs_from(HEAD)` with default flags (gitlinks COUNT) before every pick: a kept staged gitlink makes the first pick fail `error_dirty_index`: stderr `error: your local changes would be overwritten by rebase.` + `hint: commit your changes or stash them to proceed.`, exit 1. The rebase is then IN PROGRESS: pin git-first what is on disk — the rebase-merge state directory contents (`head-name`, `onto`, `orig-head`, `git-rebase-todo`, `done`, …), HEAD detached at `onto`, `ORIG_HEAD`, `git ls-files --stage sub` (= the staged id), the worktree untouched, `git status --porcelain=v2 --branch` — and what `git rebase --abort` restores (CO14b). When the todo is empty (nothing to replay, design CO14 on F2) no pick runs and the rebase finishes with exit 0, the staged gitlink kept in the index.

tsgit today (after Part 11): `rebaseRun` (src/application/commands/rebase.ts L597-617) → `assertCleanWorkTree` passes (gitlinks ignored) → `replayUnlessUpToDate` L622 → `startReplay` L666-688: `writeOrigHead`, then `detachHead(ctx, headCommit, onto, ontoName, reflogAction)` (L~1700: a ref update of HEAD plus `hardResetWorktreeToCommit(ctx, onto)`, which rewrites the index to `onto`'s tree — the staged gitlink id is silently replaced), then `replayFrom(ctx, rc, onto, seed)` L513-543 whose loop calls `replayLine` → `replayOne` L294-316 per todo line with no dirty-index check. Result: tsgit rebases where git refuses, and the staged gitlink change is dropped from the index (the submodule's HEAD on disk is untouched). Before Part 11 the strict pre-flight refused by accident.

Files:
- `src/application/commands/internal/clean-work-tree.ts` — a new query beside `stagedChangePaths` (L148-154): `stagedGitlinkChanges(ctx, headTree): Promise<ReadonlyArray<FilePath>>` = the paths `stagedDirty(…, COUNTING_GITLINKS)` reports that `stagedDirty(…, IGNORING_GITLINKS)` does not — i.e. exactly the staged changes git's rebase pre-flight ignored (both sides gitlinks, or a gitlink added or removed). Keep CQS: a query, no throw. (Alternative if the two-call shape costs a second index read: expose the policy-difference from one `stagedDirty` pass; either way under 20 lines.)
- `test/unit/application/commands/internal/clean-work-tree.test.ts` — rows for the new query.
- `src/application/commands/rebase.ts` — (a) in `startReplay`, BEFORE `writeOrigHead`/`detachHead`: `const carried = await stagedGitlinkChanges(ctx, headTree)`; for each carried path compare HEAD's tree entry with `onto`'s tree entry (`readTree`/`flatten` helpers the file already uses for `treeOf`; read how `mergeUnderLock` or `canFastForward` read tree entries by path): any path whose entries differ → `throw checkoutOverwriteDirty({ localChanges: [paths…], untracked: [] })` (the code `checkout` gives git's `would be overwritten by merge`; find its constructor in src/domain/commands/error.ts) before any write. (b) `detachHead`: after `hardResetWorktreeToCommit(ctx, onto)`, re-stage the carried gitlink entries — write the index with those entries' pre-reset `IndexEntry` values restored (read the index before the reset, keep the carried entries, write them back after; use the index-lock writer the file already uses for `commitPick`/`stopOnConflict`), so the index equals git's "kept" state. (c) in `replayFrom`, before the first `replayLine` of a run (and, to mirror `do_pick_commit`, before every line): `if ((await stagedChangePaths(ctx, treeOf(cur))).length > 0)` → persist the rebase state exactly as `stopOnConflict` does for a stop (so `rebaseAbort` can restore ORIG_HEAD and the branch), then `throw workingTreeDirty({ localChanges, untracked: [] })` (the code cherry-pick's `assertCleanIndex` uses). Read `stopOnConflict` (L~560) and `writeRebaseState`/`endRebaseState` to reuse the persistence; the pinned the rebase-merge state directory contents decide which files must exist. `rebaseContinue` (L712) commits the resolution first (`commitResolution` L741), so after a conflict stop the index equals HEAD before the next pick and the check passes — GUARD row.
- `test/unit/application/commands/rebase.test.ts` — rows in a new `describe('Given a staged gitlink the pre-flight ignores')` block after `describe('Given refusal conditions')` (L507).
- `test/integration/gitlink-consumers-interop.test.ts` — rows CO14 (F2, nothing to replay), CO14b (F3, onto agrees on `sub`), CO14c (F3 with `other` as onto: `sub` differs between HEAD and onto), the `--abort` restore row, and a GUARD that the Part 11 `rebase --continue` row still passes.

Pinned bytes (git 2.55; the Part 11 implementer ×3 on fresh repos): F3, `sub` moved to `<C>` and `git add sub`, `rebase side` → exit 1, stderr contains `your local changes would be overwritten by rebase`. F2 (nothing to replay), same staging, `rebase side` → exit 0, index keeps `<C>` (design CO14). Everything else above is to pin git-first in this part (×3 when it surprises); write the observed bytes into the rows and the hand-back. If git's post-failure state cannot be reproduced inside `rebase.ts` + `clean-work-tree.ts`, stop and hand back `{ unit, reason, ≤3 options }` with the pinned state — never widen silently.

### TDD steps

One RED per function, run before its code.

1. RED — clean-work-tree unit: index gitlink `<C>` vs HEAD gitlink `<A>` → `stagedGitlinkChanges` returns `['sub']`; a staged regular file is not listed. Fails: the function does not exist.
2. GREEN — the query. GUARD — a gitlink↔file type change is NOT listed (git's pre-flight counts it, so it is refused earlier).
3. Pin git-first CO14c (onto disagrees on `sub`). RED — rebase unit: HEAD `sub` = `<A>`, index `sub` = `<C>` (staged), onto's tree `sub` = `<B>`, one commit to replay → `rebaseRun` rejects `CHECKOUT_OVERWRITE_DIRTY { localChanges: ['sub'], untracked: [] }` and nothing changed (HEAD, ORIG_HEAD, index, no rebase-merge state directory). Fails: today the hard reset to onto proceeds.
4. GREEN — the pre-detach comparison in `startReplay`.
5. Pin git-first CO14b (onto agrees on `sub`) and the post-failure state. RED — rebase unit: same but onto's `sub` = `<A>` → rejects `WORKING_TREE_DIRTY { localChanges: ['sub'], untracked: [] }`, and afterwards HEAD is detached at onto, ORIG_HEAD is the branch tip, the index holds `sub` = `<C>`, the rebase-merge state directory exists as git's does. Fails: today the hard reset drops `<C>` and the rebase completes.
6. GREEN — `detachHead` carries the gitlink entries; `replayFrom` refuses before the first pick with the state persisted. GUARD — `rebaseAbort` afterwards restores the branch, HEAD, and the index with `sub` = `<C>` (pin git's `--abort` result first).
7. GUARD — nothing to replay (F2 shape): `rebaseRun` succeeds and the index keeps `sub` = `<C>` (passes: no pick runs; the carry keeps the entry through the onto checkout). GUARD — the Part 11 conflict-stop + `rebaseContinue` flow still passes (the resolution is committed before the next pick).
8. Interop — CO14, CO14b, CO14c, the abort row.
9. REFACTOR — functions under 20 lines; no mutable shared state.

### Gate

```
npx vitest run test/unit/application/commands/rebase test/unit/application/commands/internal/clean-work-tree test/unit/application/commands/pull test/unit/application/commands/cherry-pick && npm run check:types && ./node_modules/.bin/biome check src/application/commands/rebase.ts src/application/commands/internal/clean-work-tree.ts test/unit/application/commands/rebase.test.ts test/unit/application/commands/internal/clean-work-tree.test.ts test/integration/gitlink-consumers-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/commands/rebase.ts src/application/commands/internal/clean-work-tree.ts test/unit/application/commands/rebase.test.ts test/unit/application/commands/internal/clean-work-tree.test.ts test/integration/gitlink-consumers-interop.test.ts
npm run check:write-surfaces
npx vitest run test/unit/application/commands/rebase test/unit/application/commands/internal/clean-work-tree --coverage --coverage.include=src/application/commands/rebase.ts --coverage.include=src/application/commands/internal/clean-work-tree.ts --coverage.reporter=text
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/gitlink-consumers-interop.test.ts test/integration/rebase-interop.test.ts test/integration/rebase-autostash-interop.test.ts test/integration/pull-rebase-interop.test.ts
```

### Commit

`fix(rebase): carry a staged gitlink through the onto checkout and refuse the first pick as git does`

## Part 19 — Replace a file with a gitlink's directory when a tree write lands a gitlink over it

### Context

R7/R9 (checkout write path); design rows CO39, CO40 (pinned by the orchestrator after Part 12). git's `checkout_entry` (entry.c) runs with `state->force = 1` from `check_updates`, after the dirty check has already passed: when the path holds something that is not a directory, git `unlink`s it ("We unlink the old file, to get the new one with the right permissions"), then creates the gitlink's empty directory; a directory already there is left alone ("If it is a gitlink, leave it alone!"). tsgit's gitlink add arm in `src/application/primitives/apply-changeset.ts` creates the directory without looking at a file occupant, so `writeWorkingTreeEntry` throws `FILE_EXISTS` at `mkdir sub` — seen by the Part 12 implementer through `stash push` with a staged gitlink→file type change (git: stash saved, then `sub` restored as an empty directory, exit 0), and reachable the same way through `checkout` to a tree whose `sub` is a gitlink while the current path holds a committed regular file (a type-change entry the dirty check passes).

Files:
- `src/application/primitives/apply-changeset.ts` — the gitlink `add`/`update` write arm (find where a `FILE_MODE.GITLINK` entry is materialised — the 16 existing gitlink rows in its unit suite name it; the plan's Part 10 context listed `applyDeleteEntry` L364-375 and the add arm beside it): before creating the directory, `lstat` the path; a regular file or symlink occupant is removed (`ctx.fs.rm`, never recursive), a directory is kept as today. Reuse the occupant probe the file already has for its other arms if one exists.
- `test/unit/application/primitives/apply-changeset.test.ts` — rows: a gitlink add over a regular file → the file is gone and an empty directory stands (RED); over a symlink → the link is removed, not its target (RED or GUARD per the code shape); over an existing directory with contents → untouched (GUARD, existing behaviour); over nothing → directory created (GUARD, existing row).
- `test/integration/gitlink-consumers-interop.test.ts` — CO40 (F1, `sub` replaced by a regular file, `git add sub`, `stash push` → exit 0 `Saved working directory and index state WIP on main: …`; afterwards `sub` is an empty directory, the index holds the gitlink `A`, `stash@{0}^2:sub` and `stash@{0}:sub` are the file blob `100644`), and a checkout row pinned git-first: branch `file-sub` where `sub` is a committed regular file, `checkout main` (gitlink) → expected exit 0 with `sub` an empty directory; and the reverse (`checkout file-sub` from a populated gitlink) → pin what git does with the populated directory (expected: left in place with a warning, or refused — follow the pin).

Pinned bytes (git 2.55, orchestrator): CO39 — `sub` replaced by a regular file, NOT staged, `stash push` → exit 0 `No local changes to save` (stash's `diff-files --ignore-submodules` zeroes every change on a gitlink index entry, type change included); status shows `1 .T S... 160000 160000 100644 <A> <A> sub`. CO40 — the same staged (`git add sub` succeeds, index `100644 <blob> 0 sub`), `stash push` → exit 0, saved; afterwards status clean, `sub` an empty directory (a directory), `stash@{0}^2:sub` = `stash@{0}:sub` = `100644 blob <blob> sub`.

### TDD steps

One RED per function, run before its code.

1. GUARD (run first, before any code) — the existing gitlink-add rows (directory created; occupants of an existing directory kept) pass today.
2. RED — apply-changeset unit: a gitlink `add` for `sub` where `sub` is a regular file → applies, `sub` is an empty directory. Fails: `FILE_EXISTS` from the directory creation.
3. GREEN — remove a non-directory occupant before creating the directory.
4. GUARD — a symlink occupant is removed and its target untouched (if the code path distinguishes symlinks, this is a RED instead — report which).
5. Interop — CO39 (GUARD: tsgit's stash already answers "no local changes" through Part 12's `classifyEntry`), CO40, and the two checkout rows git-first.
6. REFACTOR — functions under 20 lines.

### Gate

```
npx vitest run test/unit/application/primitives/apply-changeset test/unit/application/commands/checkout test/unit/application/commands/stash && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/apply-changeset.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/gitlink-consumers-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/primitives/apply-changeset.ts test/unit/application/primitives/apply-changeset.test.ts test/integration/gitlink-consumers-interop.test.ts
npm run check:write-surfaces
npx vitest run test/unit/application/primitives/apply-changeset --coverage --coverage.include=src/application/primitives/apply-changeset.ts --coverage.reporter=text
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/gitlink-consumers-interop.test.ts test/integration/stash-interop.test.ts test/integration/checkout-file-directory-swap-interop.test.ts test/integration/checkout-replace-symlink-with-file-interop.test.ts
```

### Commit

`fix(checkout): replace a file occupant with the gitlink's directory, as git's checkout_entry does`

## Part 20 — Refuse to stash a tracked path beyond a symbolic link, as git does

### Context

R7 (stash); design row CO38 (pinned by the orchestrator after Part 12, ×3). git's `stash push` builds the worktree tree through `add_to_index`, which refuses a path whose leading directory is a symlink: stderr `error: 'd/f' is beyond a symbolic link`, `fatal: Unable to process path d/f`, `Cannot save the current worktree state`, exit 1, nothing created (no stash, HEAD and the index untouched); the same with `-u`. After Part 4 tsgit's comparison reads `d/f` as deleted (git's `status` agrees: ` D d/f` + `? d`), so tsgit's stash records a deletion and saves a stash where git refuses. `add` already refuses this condition with `PATHSPEC_BEYOND_SYMLINK { path }` (src/domain/commands/error.ts L47, constructor at L602; message `pathspec is beyond a symbolic link: <basename>`), so no new code is needed.

Files:
- `src/application/commands/stash.ts` — in the query that classifies entries (`classifyEntry` / `classify` / `findLocalChanges`, Part 12 shapes), a stage-0 entry whose leading directory is a symlink (`createLeadingPathScanner(ctx).hasSymlinkedLeadingPath(entry.path)` from src/application/primitives/internal/symlinked-leading-path.ts — one scanner per stash run, as `scanTrackedEntries` does) refuses with `pathspecBeyondSymlink(entry.path)` BEFORE any object or ref is written. The refusal is raised only when the stash would otherwise be saved (git refuses while building the worktree tree, i.e. after "no local changes" has been ruled out) — pin that ordering: a repository whose only change is the symlinked-parent deletion refuses (CO38), while `No local changes to save` wins when nothing else changed and … (there is no such case: the deletion IS a change; so the refusal fires whenever a tracked entry sits beyond a symlink and a stash would be created — including when other files changed). Read `stash.ts`'s write sequence (`createStashCommits` or its equivalent) to place the check before the first write.
- `test/unit/application/commands/stash.test.ts` — rows: tracked `d/f` with `d` a symlink to a copy → `stashPush` rejects `PATHSPEC_BEYOND_SYMLINK { path: 'd/f' }` and writes nothing (no stash ref, index unchanged) (RED); the same plus an edited file elsewhere → the same refusal (GUARD); a symlink that is a tracked leaf (not a leading directory) stashes normally (GUARD).
- `test/integration/gitlink-consumers-interop.test.ts` — CO38 (`stash push` and `stash push -u`): git exit 1 with the three stderr lines, no `stash list` entry, status ` D d/f` + `? d` unchanged; tsgit rejects `PATHSPEC_BEYOND_SYMLINK { path: 'd/f' }`, no stash ref, status unchanged.

### TDD steps

One RED per function, run before its code.

1. RED — stash unit: tracked `d/f`, `d` replaced by a symlink to a copy → `stashPush` rejects `PATHSPEC_BEYOND_SYMLINK { path: 'd/f' }`. Fails: today a stash is saved.
2. GREEN — the leading-path refusal before any write. GUARD — nothing was written (no `refs/stash`, index bytes unchanged). GUARD — an edited unrelated file does not change the outcome. GUARD — a tracked symlink leaf still stashes.
3. Interop — CO38 twins (`push`, `push -u`).
4. REFACTOR — functions under 20 lines.

### Gate

```
npx vitest run test/unit/application/commands/stash && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/gitlink-consumers-interop.test.ts && npm run check:spelling
npx tsc --noEmit -p tsconfig.json && npx cspell --no-progress src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/gitlink-consumers-interop.test.ts
npm run check:write-surfaces
npx vitest run test/unit/application/commands/stash --coverage --coverage.include=src/application/commands/stash.ts --coverage.reporter=text
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/gitlink-consumers-interop.test.ts test/integration/stash-interop.test.ts test/integration/stash-apply-index-interop.test.ts
```

### Commit

`fix(stash): refuse a tracked path beyond a symbolic link, as git does`
