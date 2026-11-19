<!-- cspell:ignore backticked unsmudged filemode lstat chmod ctime mtime ignorecase worktree worktrees sparsecheckout sparsecheckoutcone unmerged donor's -->
# Plan — core-filemode-false

> Source: design doc `docs/design/core-filemode-false.md` · ADRs 1229, 1230, 1231, 1232, 1233 (1233 supersedes part of 1186)
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
  files in its `### Context` block, is two parts. What counts is a backticked path:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Shared knowledge (read once, applies to every part)

Ratified decisions: D-A option B (one shared `[core]` key filter for the sparse keys and
`core.fileMode`), D-B fold (switch/merge refuse a trusted exec-bit-only change, breaking),
D-C fold (eager gate refuses a bad `core.fileMode` in local and active `config.worktree`,
breaking), D-D option A (snapshot `WorkdirEntryRow.mode` / `WorkdirStat.mode` stay raw:
nothing in src/application/primitives/snapshot or src/adapters/snapshot-resolvers is
touched), D-E option A (optional `ComparisonScope.executableBit`, resolved by
`compareAndRefresh` when absent).

git's rule being replicated (`ce_mode_from_stat`, fileMode arm): trusted, or a symlink
work file, gives the stat-derived mode (`deriveWorkingMode`); untrusted gives the donor's
mode when the donor is `100644`/`100755`, else `100644`. Donor = stage-0 entry (an
intent-to-add entry included), else unmerged stage 2, else 1, else 3, else none.

Public-surface decision (every new symbol is INTERNAL; no surface gate is tripped):

| Symbol | Where | Decision | Why |
|---|---|---|---|
| `ExecutableBitTrust` (type), `indexModeFromStat`, `isRegularFileMode` | src/domain/objects/file-mode.ts | internal | NOT added to src/domain/objects/index.ts: that barrel is `export type *`-re-exported by src/public-types.ts, so a barrel entry would become public and change reports/api.json. Import by deep path (`../../domain/objects/file-mode.js`), as every current `deriveWorkingMode` consumer already does |
| `unmergedModeDonor` | new src/domain/git-index/unmerged-mode-donor.ts | internal | NOT added to src/domain/git-index/index.ts (same `export type *` reason) |
| `readExecutableBitTrust`, `coreKeyEntries`, `CoreKeyEntry`, `lastValidBoolean` | src/application/primitives/read-executable-bit-trust.ts, read-sparse-config.ts | internal | NOT added to src/application/primitives/index.ts (its types are `export type *`-re-exported publicly) |
| `ComparisonScope.executableBit`, `CachedStat.executableBit`, `OccupantVerdict` `stat` | existing internal interfaces | internal | none of these interfaces is barrel-exported |

`compareWorkingTreeEntry(ctx, entry, provider?, indexMtime?)` and every Repository method
keep their signatures (R11). No error code is added (D-B reuses `CHECKOUT_OVERWRITE_DIRTY` /
`WORKING_TREE_DIRTY`; D-C reuses `CONFIG_BAD_BOOLEAN_VALUE`). So no exhaustiveness switch,
no barrel test, no api.json regeneration, no doc-coverage page.

knip (`check:dead-code`, phase gate only) flags an export no other file imports: export a
symbol only in the part that adds its first cross-file consumer (called out per part).

Pitfalls binding every part:

- No ignore directives (`v8 ignore`, `istanbul ignore`, `@ts-ignore`, `biome-ignore`). New
  `Stryker disable` comments are not added in this run; the one existing comment in
  src/application/commands/add.ts `restagesAsIs` is REWRITTEN in Part 6 (see there).
- No phase, ADR, backlog or design references in src or test code or comments.
- Tests: `describe('Given …')` > `describe('When …')` > `it('Then …')` (the 2-level
  `describe('Given …, When …')` > `it('Then …')` only for a single expectation); AAA body
  with `// Arrange` / `// Act` / `// Assert`; system under test bound to `sut`.
- Refusal assertions: try/catch (or the file's existing `refusalOf` / `catchTsgitError`
  helper) asserting `.data.code` plus every data field (`key`, `value`, `source`,
  `localChanges`, `paths` …), never `toThrow(Class)` alone.
- 100% line/branch/function/statement coverage of every touched src file.
- The memory file system does not model modes: every `lstat` / `tryLstat` /
  `lstatIfReachable` reports `0o100644` (`MEMORY_FILE_MODE` in
  src/adapters/memory/memory-file-system.ts) and `chmod` is a no-op. A unit test needing an
  executable work file spies the exact probe the code under test calls and returns
  `{ ...stat, mode: 0o100755 }`; copy `makeExecutable` from
  test/unit/application/primitives/internal/sparse-left-dirty.test.ts (it spies
  `tryLstat`; `compareAndRefresh` calls `ctx.fs.lstat`; smudge and occupant code call
  `ctx.fs.lstatIfReachable`). Restore spies (`afterEach(() => vi.restoreAllMocks())`).
- Config written after a first read must invalidate the session caches:
  `invalidateConfigCache` / `__resetConfigCacheForTests` (src/application/primitives/config-read.ts)
  and `__resetSectionsCacheForTests` (src/application/primitives/config-scoped-read.ts).
  Local config path: `${commonGitDir(ctx)}/config` (or `${ctx.layout.gitDir}/config` in a
  main worktree); worktree file: `${ctx.layout.gitDir}/config.worktree`; the extension:
  `[extensions]\n\tworktreeConfig = true\n` in local config.
- Spying a module function works in this repo through a namespace import
  (`import * as trust from '…/read-executable-bit-trust.js'; vi.spyOn(trust, 'readExecutableBitTrust')`),
  as test/unit/application/primitives/internal/smudge-racily-clean.test.ts does with
  `gitattributes.buildCheckinAttributeProvider`. The "read once per scan" tests use it
  with one pattern: arrange the same operation over 1 and over 3 edited tracked files,
  count `readExecutableBitTrust` calls per run, and assert the two counts are EQUAL
  ("Then core.fileMode reads do not grow with the entry count"). Never assert an absolute
  count: other steps (index write-back smudge, stale-noop check) legitimately read it too.
  Without the pre-resolved scope field `compareAndRefresh` reads it once per entry, so the
  counts differ — that is the failure each such RED names.
- rtk rewrites `npx vitest …` in this environment; call `./node_modules/.bin/vitest` directly.
- Interop file (created in Part 2, extended by Parts 5–9):
  `test/integration/posix-only/core-filemode-false-interop.test.ts`. `npm run validate`
  SKIPS the posix-only project; every part that adds rows runs
  `./node_modules/.bin/vitest run --project posix-integration test/integration/posix-only/core-filemode-false-interop.test.ts`
  in its gate. Build it on these existing files (read-only references):
  test/integration/posix-only/checkout-umask-interop.test.ts (posix-only layout, `@proves`
  header, `../../../src/…` and `../interop-helpers.js` import depth, `describe.skipIf(!GIT_AVAILABLE)`),
  test/integration/sequencer-sparse-cone-writes-interop.test.ts (the ignorecase twin:
  `describe.each(['false', 'true'] as const)('Given core.ignorecase=%s in both twins', …)`,
  `runGit(['-C', dir, 'config', 'core.ignorecase', ignoreCase])` in the seed, and the
  `openRepository` + `trackedContexts` lifecycle). test/integration/interop-helpers.ts
  already scrubs every `GIT_*` variable, isolates `HOME`, sets `GIT_CONFIG_NOSYSTEM=1` and
  turns signing off for every spawned `git`; use its `GIT_AVAILABLE`, `makePeerPair`,
  `initBothRepos`, `git`, `runGit`, `lsStage`, `tryRunGitWithExit`. Each row seeds BOTH
  twins with the same git script (never copy a repo: the copy's stat data differs from its
  index), sets `core.ignorecase` from the Given slot and `core.fileMode` from the row, runs
  real git in `pair.peer` and tsgit (`openRepository({ workDir: pair.ours })` from
  `../../../src/index.node.js`) in `pair.ours`, then compares `lsStage` of both, the owner
  exec bit (`(await stat(p)).mode & 0o100`) of both, and the outcome. A status row
  reconstructs git's porcelain v2 columns from tsgit's structured fields (`unstaged`,
  `worktree.mode`, `unmerged[].worktree.mode`) and compares with
  `git status --porcelain=v2` in the peer; the library emits no display string.
  `@proves` header: `surface: repo.add, repo.status, repo.rm, repo.stash.push, repo.stash.pop, repo.cherryPick.run, repo.checkout, repo.merge.run`;
  `bucket: platform-only`; `unique: core.fileMode decides whether the exec bit is staged, reported, refused or overwritten, as canonical git does`;
  `interopSurface: add, status, stash, checkout, merge, sequencer, config`. Part 2 runs
  `npm run check:test-pyramid` and `npm run check:write-surfaces` once to prove the header.
- Files declared by two parts, on purpose: src/domain/objects/file-mode.ts (Part 1 adds the
  type its reader needs, Part 2 the rule; merging would push Part 2 past the file ceiling),
  src/application/primitives/read-sparse-config.ts (Part 1 adds the shared filter, Part 9
  deletes the temporary wrappers once the gate moves to it), and
  src/application/primitives/internal/occupant-clash.ts (Part 4 narrows `TrackedLookup` for
  the cached-stat policy, Part 8 adds the probe stat for the breaking refusal: separate
  behaviours, separate commits).
- Out of plan (documentation phase): narrowing ledger entry 32.62 in
  docs/known-divergences.md to "every key but core.fileMode", ADR index rows.

## Decision candidates

| # | Choice | Alternatives | Recommendation |
|---|---|---|---|
| P-1 | How `matchesCachedStat`'s new `CachedStat.executableBit` reaches the symlinked-leading-directory path in src/application/primitives/internal/occupant-clash.ts `classifyThroughLink` | A: `TrackedLookup` keeps returning `{ entry, indexMtime }` (typed `Omit<CachedStat, 'executableBit'>`) and `classifyThroughLink` adds `executableBit: await readExecutableBitTrust(ctx)` (one session-cached read on a rare path) · B: thread the policy through `ClashScope` from apply-changeset.ts `trackedLookupOf` and find-would-overwrite.ts `clashScopeOf` | A — ADR-1230 already accepts a cached read for standalone callers; B adds two files to Part 4 for a path only a symlinked directory reaches |
| P-2 | Stash donor for a HEAD-only tracked path and for untracked files (`stash push -u`) | A: no donor (`100644` under `ignored`), `indexMode` only for `tracked.kind === 'indexed'`, as the design writes · B: use the HEAD entry's mode as donor for HEAD-only paths | A — matches git's temp-index build from the index tree; B invents a donor git does not consult. Part 7 pins T2/T3 only (indexed paths) |
| P-3 | Name of the worktree-file gate once it covers `filemode` | A: rename `assertWorktreeSparseBooleansValid` → `assertWorktreeCoreBooleansValid` (two files reference it) · B: keep the name | A — the old name would lie; the rename is confined to repo-state.ts and its suite |
| P-4 | Memory-adapter unit tests that Part 8 turns red (an entry or changeset recorded `100755` while the memory file system reports `0o100644`, so a switch now sees a trusted exec-bit change) | A: make the test's stat carry the exec bits (spy, as `makeExecutable`) when the exec bit is incidental to what the test proves · B: write `core.fileMode = false` in those tests | A — B changes the configuration the test proves; A keeps the default (trusted) config git ships |

## Part 1 — Layered core.fileMode reader and the sparse mover judge

### Context
Requirements R1, R8. ADR-1229 (D-A option B).

Files this part edits or creates:
- `src/domain/objects/file-mode.ts` — add, below `deriveWorkingMode`:
  `export type ExecutableBitTrust = 'trusted' | 'ignored';` with a one-line doc
  ("whether the work file's executable bit is trusted, git's core.fileMode"). Type only in
  this part (Part 2 adds the function). Do NOT touch src/domain/objects/index.ts.
- `src/application/primitives/read-sparse-config.ts` — generalise the private filter:
  today `sparseKeyEntries(sections)` filters subsectionless `[core]` entries (case-folded
  section, lower-cased key) to `SPARSE_KEYS`; `lastValidBoolean(entries, wanted)` is
  private. Make it `export const coreKeyEntries = (sections: ReadonlyArray<IniSection>, keys: ReadonlySet<string>): ReadonlyArray<CoreKeyEntry>`,
  rename `SparseKeyEntry` → `export interface CoreKeyEntry { readonly key: string; readonly value: string | null }`,
  export `lastValidBoolean`. Keep, for the one remaining importer
  (src/application/primitives/internal/repo-state.ts imports `type SparseKeyEntry, sparseKeyEntries`;
  do not edit it here), `export type SparseKeyEntry = CoreKeyEntry;` and
  `export const sparseKeyEntries = (sections) => coreKeyEntries(sections, SPARSE_KEYS);`.
  Part 9 deletes both. `readWorktreeKeys` calls `coreKeyEntries(…, SPARSE_KEYS)`.
  `isWorktreeConfigExtensionOn(ctx)` is already exported; reuse it.
- `src/application/primitives/read-executable-bit-trust.ts` (NEW) — header doc in the
  style of read-sparse-config.ts ("the per-worktree config.worktree, when
  extensions.worktreeConfig is on, overrides the shared local file"):
  ```ts
  const FILE_MODE_KEY = 'filemode';
  const FILE_MODE_KEYS: ReadonlySet<string> = new Set([FILE_MODE_KEY]);
  const readWorktreeFileMode = async (ctx: Context): Promise<boolean | undefined> => {
    if (!(await isWorktreeConfigExtensionOn(ctx))) return undefined;
    return lastValidBoolean(coreKeyEntries(await readActiveWorktreeSections(ctx), FILE_MODE_KEYS), FILE_MODE_KEY);
  };
  export const readExecutableBitTrust = async (ctx: Context): Promise<ExecutableBitTrust> => {
    const worktree = await readWorktreeFileMode(ctx);
    const local = (await readConfig(ctx)).core?.fileMode;
    return (worktree ?? local ?? true) ? 'trusted' : 'ignored';
  };
  ```
  (`readConfig` from ./config-read.js parses `core.fileMode` already, invalid → dropped;
  `readActiveWorktreeSections` from ./config-scoped-read.js.) Name the default
  `TRUSTED_BY_DEFAULT = true` rather than a bare literal if biome or review asks.
- `src/application/primitives/internal/sparse-left-dirty.ts` — `judgeMovers` builds
  `Judgement.trustsExecutableBit` as `lazily(async () => (await readConfig(ctx)).core?.fileMode !== false)`
  (local only, so a `config.worktree` value is ignored today). Replace the field with
  `readonly executableBit: () => Promise<ExecutableBitTrust>` =
  `lazily(() => readExecutableBitTrust(ctx))`; `modeDiffers` keeps its `core.symlinks` arm
  and ends `return !executableBitOnly || (await executableBit()) === 'trusted';`.
  `hasSymlinks` still reads `readConfig` (out of scope).
- `test/unit/application/primitives/read-executable-bit-trust.test.ts` (NEW) — copy the
  scaffolding of test/unit/application/primitives/read-sparse-config.test.ts verbatim:
  `seedLocal`, `seedWorktree`, `linked(base)`, `EXT_ON`, the `Row` table +
  `describe.each`, `beforeEach` resetting both caches.
- `test/unit/application/primitives/internal/sparse-left-dirty.test.ts` — extend the
  `notUpToDate mode and type` block (it already has `modeRows`, `makeExecutable`,
  `writeWork`, `entryOf`, `writeBlob`, and a "with core.filemode off" When).

Read-only GUARDs to run: test/unit/application/primitives/read-sparse-config.test.ts,
test/unit/application/primitives/internal/repo-state-worktree-sparse.test.ts, and the
existing interop row `executable-mover-removed-when-filemode-off` in
test/integration/sequencer-sparse-cone-writes-interop.test.ts.

### TDD steps
1. RED — read-executable-bit-trust.test.ts, `describe.each(ROWS)('Given $id …')` >
   `When readExecutableBitTrust` > `Then it resolves $expected`, rows: C1 nothing set →
   `'trusted'`; local `filemode = false` → `'ignored'`; C2 ext on + local `true` +
   worktree `false` → `'ignored'`; C2b ext on + local `false` + worktree `true` →
   `'trusted'`; C2c worktree `false` with the extension off (and with
   `worktreeConfig = false`) → `'trusted'`; C7 forms: `filemode =` (empty) → `'ignored'`,
   valueless `filemode` → `'trusted'`, `No` → `'ignored'`, `0` → `'ignored'`, worktree
   `false` then `true` → `'trusted'` (last wins); worktree `bogus` then nothing valid with
   local `false` → `'ignored'` (invalid entry ignored, local applies); worktree key under
   `[core "x"]` → ignored. Fails: the module does not exist (import error).
2. RED — same file, `Given only the linked worktree file sets filemode = false` >
   `When readExecutableBitTrust runs for each worktree` > `Then only the linked context ignores the bit`
   (C2d; copy the read-sparse-config linked-worktree test). Fails: module missing.
3. GREEN — `ExecutableBitTrust` in file-mode.ts, `coreKeyEntries`/`CoreKeyEntry`/
   `lastValidBoolean` exports + the two temporary wrappers in read-sparse-config.ts, the
   new reader module.
4. RED — sparse-left-dirty.test.ts, inside the `describe.each(modeRows)` block add
   `When the candidates are judged with core.filemode false only in config.worktree` >
   `Then nothing is reported`: local `${EXT_ON}[core]\n\tfilemode = true\n`, worktree
   `[core]\n\tfilemode = false\n`. Fails: the judge reads local config only and reports
   `['a']`.
5. RED — same block, `When the candidates are judged with core.filemode true in config.worktree over a false local`
   > `Then the path is reported`. Fails: local `false` wins today, result `[]`.
6. GREEN — switch `Judgement` to `executableBit` / `readExecutableBitTrust`.
7. GUARD — read-sparse-config.test.ts and repo-state-worktree-sparse.test.ts stay green
   (the wrappers keep the sparse behaviour); the existing `with core.filemode off` rows stay
   green (local `false`, no worktree file).
8. REFACTOR — drop `readConfig` from sparse-left-dirty.ts imports only if `hasSymlinks`
   no longer needs it (it does: keep).

### Gate
```bash
./node_modules/.bin/vitest run test/unit/application/primitives/read-executable-bit-trust.test.ts test/unit/application/primitives/read-sparse-config.test.ts test/unit/application/primitives/internal/sparse-left-dirty.test.ts test/unit/application/primitives/internal/repo-state-worktree-sparse.test.ts \
  && ./node_modules/.bin/vitest run test/integration/sequencer-sparse-cone-writes-interop.test.ts -t filemode \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/objects/file-mode.ts src/application/primitives/read-sparse-config.ts src/application/primitives/read-executable-bit-trust.ts src/application/primitives/internal/sparse-left-dirty.ts test/unit/application/primitives/read-executable-bit-trust.test.ts test/unit/application/primitives/internal/sparse-left-dirty.test.ts \
  && npm run check:spelling
```

### Commit
`fix(sparse-checkout): read core.fileMode from config.worktree when judging movers as git does`

## Part 2 — git's mode rule at the working-tree comparison seam

### Context
Requirements R2, R4 (status, rm, stash change detection, cherry-pick overwrite check all
inherit). ADR-1230 (D-E option A). Behaviour flips: S1, S3, S4, R1, T1, M2, C2, C2d.

Files this part edits or creates:
- `src/domain/objects/file-mode.ts` — add (not exported: `isRegularFileMode` stays module
  private until Part 8 needs it; knip):
  ```ts
  const isRegularFileMode = (mode: FileMode): boolean =>
    mode === FILE_MODE.REGULAR || mode === FILE_MODE.EXECUTABLE;
  /** git's ce_mode_from_stat, core.fileMode arm: an untrusted exec bit defers to the donor entry. */
  export const indexModeFromStat = (
    stat: { readonly isSymbolicLink: boolean; readonly mode: number },
    donor: FileMode | undefined,
    trust: ExecutableBitTrust,
  ): FileMode => {
    if (trust === 'trusted' || stat.isSymbolicLink) return deriveWorkingMode(stat);
    return donor !== undefined && isRegularFileMode(donor) ? donor : FILE_MODE.REGULAR;
  };
  ```
  `deriveWorkingMode` stays unchanged (the trusted arm; still exported and used).
- `src/application/primitives/compare-working-tree-entry.ts` — current shapes:
  `export interface ComparisonScope { provider?; indexMtime?; filterDriversConfigured?; scanner? }`;
  `export const compareFile = async (ctx, entry, absPath, stat, scope: ComparisonScope)`
  starts `const worktreeMode = deriveWorkingMode(stat);` then
  `statOnlyVerdict(entry, stat, worktreeMode, scope.indexMtime) ?? compareContent(…)`;
  `compareGitlink(ctx, entry, stat, scope)` returns
  `{ status: 'type-changed', worktreeMode: deriveWorkingMode(stat) }` for a non-directory;
  `compareAndRefresh(ctx, entry, scope = {})` lstat-s and dispatches;
  `racyContentMatcher(ctx)` calls `compareFile(ctx, entry, absPath, stat, scopeOf(await provider()))`.
  Change:
  - `ComparisonScope` gains `readonly executableBit?: ExecutableBitTrust;` with a doc
    line ("core.fileMode, resolved once per scan; a comparison outside a scan reads it").
  - module-private `type ResolvedScope = ComparisonScope & { readonly executableBit: ExecutableBitTrust };`
    `compareFile` and `compareGitlink` take `ResolvedScope`.
  - `compareFile`: `const worktreeMode = indexModeFromStat(stat, entry.mode, scope.executableBit);`
  - `compareGitlink` type-changed arm: `indexModeFromStat(stat, FILE_MODE.GITLINK, scope.executableBit)`
    (a gitlink donor gives `100644` under `ignored`, git's `.T 160000 160000 100644`).
  - `compareAndRefresh`: after the `stat === undefined` early return build
    `const resolved = { ...scope, executableBit: scope.executableBit ?? (await readExecutableBitTrust(ctx)) };`
    and pass `resolved` to both arms. Do NOT resolve before the absent/lossy early returns
    (keeps the read off those paths). `withStatData(entry, stat)` keeps `entry.mode`
    (src/application/primitives/internal/index-entry-from-stat.ts) — git's refresh writes
    the donor mode, so nothing to change there.
  - `racyContentMatcher`: add `const executableBit = lazily(() => readExecutableBitTrust(ctx));`
    beside `provider`, and pass `{ ...scopeOf(await provider()), executableBit: await executableBit() }`.
  - Remove the now-unused `deriveWorkingMode` import.
  `statOnlyVerdict` / `compareContent` are unchanged: their `worktreeMode === entry.mode`
  test becomes git's test by construction.
- `test/unit/domain/objects/file-mode.test.ts` — add a `describe('indexModeFromStat')`
  block, exhaustive table (no `*.properties.test.ts`: a 20-row finite mapping, the design's
  Test strategy records why). Stat fixtures: `{ isSymbolicLink: false, mode: 0o100755 }`,
  `{ isSymbolicLink: false, mode: 0o100644 }`, `{ isSymbolicLink: true, mode: 0o120777 }`.
- `test/unit/application/primitives/compare-working-tree-entry.test.ts` — reuse `seedFile`,
  `seedSymlink`, `gitlinkOf`, `work`; config written with
  `ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, …)` then `invalidateConfigCache(ctx)`
  (already imported there). Exec work file: spy `ctx.fs.lstat` to add `mode: 0o100755`.
  The public entry points to drive are `compareWorkingTreeEntry`, `compareWorkingTreeDelta`
  and the exported `compareAndRefresh` (pass `{ executableBit }` for the scope rows).
- `test/integration/posix-only/core-filemode-false-interop.test.ts` (NEW) — see Shared
  knowledge for the scaffolding.

### TDD steps
1. RED — file-mode.test.ts `describe('indexModeFromStat')` >
   `describe.each(TABLE)('Given a $stat work file and donor $donor', …)` > `When the bit is $trust`
   > `Then the index mode is $expected`, all of {regular `+x`, regular `-x`, symlink} ×
   {undefined, `100644`, `100755`, `120000`, `160000`} × {`trusted`, `ignored`} (30 rows;
   trusted → exec-bit mode, symlink → `120000`, ignored regular → donor when regular else
   `100644`). Fails: `indexModeFromStat` is not exported (TypeError: not a function).
2. GREEN — `isRegularFileMode` + `indexModeFromStat`.
3. RED — compare suite, `Given a regular entry whose working file gained the exec bit and core.filemode = false`
   > `When comparing the entry to the working tree` > `Then returns 'unchanged'`; and the
   twin `Given an executable entry whose working file lost the exec bit and core.filemode = false`
   (reuse the existing `{ ...entry, mode: '100755' }` shape at the
   "executable-mode entry whose working file is a same-content regular file" test).
   Fails: returns `'mode-changed'` (the seam derives the mode from lstat only).
4. RED — `Given a symlink entry replaced by an executable regular file and core.filemode = false`
   > `When compareWorkingTreeDelta` > `Then type-changed with worktreeMode 100644`. Fails:
   `worktreeMode` is `'100755'`.
5. RED — `Given a gitlink entry whose path holds an executable regular file and core.filemode = false`
   > `Then type-changed with worktreeMode 100644`. Fails: `'100755'`.
6. RED — `Given the default config and a scope that ignores the bit` >
   `When compareAndRefresh on an exec-bit-only change` > `Then returns 'unchanged'`
   (the scope value is used, not re-read). Fails: the field is ignored and the seam
   derives the mode from lstat → `'mode-changed'`.
7. RED (interop, before the GREEN) — interop file, under `Given core.ignorecase=%s in both twins` with
   `core.fileMode=false` in local config unless stated: S1 (`100644` entry, `chmod +x`:
   git porcelain v2 clean, tsgit `clean: true`), S2 control (`core.fileMode=true`: both
   `.M … 100644 100644 100755`; GUARD), S3 (`100755` entry, `chmod -x`: clean), S4
   (symlink entry replaced by an exec file: git `.T 120000 120000 100644`, tsgit
   `unstaged 'type-changed'`, `worktree.mode '100644'`), R1 (`rm f` after `chmod +x`: both
   remove `f`; tsgit no `RM_LOCAL_MODIFICATIONS`), T1 (`stash push` after `chmod +x`: git
   "No local changes to save" exit 0, tsgit `{ kind: 'no-local-changes' }`, `f` keeps
   `+x` in both, no `refs/stash`), M2 (`cherry-pick` of a commit changing `f`, `f` `+x`:
   both pick, `f` `-x`, same `lsStage`), C2 (`extensions.worktreeConfig=true`, local
   `true`, `git config --worktree core.fileMode false`: clean in both), C2d (linked
   worktree from `git worktree add`, its own `config.worktree` `false`, main local `true`:
   linked clean, main dirty in both). S1, S3, S4, R1, T1, M2, C2, C2d fail here with
   tsgit's `mode-changed` / `RM_LOCAL_MODIFICATIONS` / a saved stash /
   `WORKING_TREE_DIRTY`; S2 is a GUARD (passes today and after).
8. GREEN — the compare-working-tree-entry.ts changes above.
9. GUARD — every existing `mode-changed` test in the compare suite (default config →
   `'trusted'`, same verdict as before).
10. REFACTOR — none expected; keep every new function under 20 lines.

### Gate
```bash
./node_modules/.bin/vitest run test/unit/domain/objects/file-mode.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts \
  && ./node_modules/.bin/vitest run --project posix-integration test/integration/posix-only/core-filemode-false-interop.test.ts \
  && ./node_modules/.bin/vitest run --project unit \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/objects/file-mode.ts src/application/primitives/compare-working-tree-entry.ts test/unit/domain/objects/file-mode.test.ts test/unit/application/primitives/compare-working-tree-entry.test.ts test/integration/posix-only/core-filemode-false-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid && npm run check:write-surfaces
```
The full unit run catches any fs-call-count assertion that now sees the trust read.

### Commit
`fix(status): ignore an untrusted exec bit when comparing the working tree as git does`

## Part 3 — Racy smudge follows core.fileMode; valve scans resolve it once

### Context
Requirement R5 (racy smudge half) and ADR-1230's consequence "scan loops set the policy
once per operation" for two valve scans.

Files this part edits:
- `src/application/primitives/internal/smudge-racily-clean.ts` — current
  `statStillMatches(ctx, workDir, entry)` returns
  `stat !== undefined && deriveWorkingMode(stat) === entry.mode && matchesContentStat(entry, stat)`;
  `racilyClean(ctx, workDir, entries, previous, indexMtime, verified)` filters racy
  entries then `filterConcurrently(carriedOver(previous, racy), (entry) => statStillMatches(ctx, workDir, entry))`;
  `smudgeRacilyClean` builds `scopeOf(provider, undefined, createLeadingPathScanner(ctx))`
  for `compareAndRefresh`. Change: `racilyClean` resolves
  `const executableBit = await readExecutableBitTrust(ctx);` AFTER the
  `racy.length === 0` early return and passes it to `statStillMatches`, whose mode test
  becomes `indexModeFromStat(stat, entry.mode, executableBit) === entry.mode`.
  `smudgeRacilyClean` needs the same value for its `compareAndRefresh` scope: have
  `racilyClean` return `{ clean, executableBit }` (or resolve it in `smudgeRacilyClean`
  after `clean.length === 0` returns and pass it down — pick the shape with fewer lines)
  and spread `executableBit` into the scope. Drop the `deriveWorkingMode` import.
- `src/application/primitives/find-would-overwrite.ts` — `findWouldOverwrite` builds
  `const scope = scopeOf(provider, currentIndex.indexMtime, scanner);` once per scan.
  Make it `{ ...scopeOf(…), executableBit: await readExecutableBitTrust(ctx) }`.
- `src/application/commands/internal/clean-work-tree.ts` — `unstagedDirty(ctx, stage0, indexMtime)`
  builds `scopeOf(provider, indexMtime, createLeadingPathScanner(ctx))` once; same change.
- `test/unit/application/primitives/internal/smudge-racily-clean.test.ts` — the block
  `Given a racy carried-over entry whose working file is of another mode` (builds
  `executable = { ...asRead, mode: FILE_MODE.EXECUTABLE }`, commits it with
  `acquireIndexLock(ctx)`/`lock.commit`, rewrites `TRACKED` with `SAME_SIZE_REWRITE`,
  expects `[executable]` kept) is the template; helpers `trackedRepo`, `entriesAsRead`,
  `write`, `readPreviousIndex`.
- `test/unit/application/primitives/find-would-overwrite.test.ts` and
  `test/unit/application/commands/internal/clean-work-tree.test.ts` — one "read once" test
  each (spy via the namespace import, see Shared knowledge).

### TDD steps
1. RED — smudge suite, `Given a racy carried-over executable entry whose same-size rewrite lost the exec bit and core.filemode = false`
   > `When the index is written` > `Then the entry is smudged` (expect
   `[{ ...executable, fileSize: 0 }]`; write `[core]\n\tfilemode = false\n` before the
   call). Fails: the stat test sees `100644 !== 100755`, keeps `[executable]` unsmudged.
2. GREEN — the smudge-racily-clean.ts change.
3. GUARD — the existing "another mode" test (default config, trusted): still kept as is.
4. RED — find-would-overwrite suite, `Given one and then three tracked paths with local edits`
   > `When findWouldOverwrite runs over each` > `Then core.fileMode reads do not grow with the entry count`
   (read-count pattern). Fails: `compareAndRefresh` resolves it per entry (counts differ by 2).
5. RED — clean-work-tree suite, same pattern on the exported function that reaches
   `unstagedDirty` (find it in the suite's imports). Fails: one read per entry.
6. GREEN — pre-resolve in both scans.
7. GUARD — the rest of both suites (verdicts unchanged under the default config).

### Gate
```bash
./node_modules/.bin/vitest run test/unit/application/primitives/internal/smudge-racily-clean.test.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/primitives/find-would-overwrite.properties.test.ts test/unit/application/commands/internal/clean-work-tree.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/smudge-racily-clean.ts src/application/primitives/find-would-overwrite.ts src/application/commands/internal/clean-work-tree.ts test/unit/application/primitives/internal/smudge-racily-clean.test.ts test/unit/application/primitives/find-would-overwrite.test.ts test/unit/application/commands/internal/clean-work-tree.test.ts \
  && npm run check:spelling
```

### Commit
`fix(index): apply core.fileMode to the racy smudge and read it once per overwrite scan`

## Part 4 — The cached-stat up-to-date check follows core.fileMode

### Context
Requirement R5 (forced/path checkout rewrite, ignorecase obstruction, symlinked-path
occupant, sparse judge). ADR-1230 ("matchesCachedStat carries the same policy in its
CachedStat argument"). Decision P-1 recommended option A.

Files this part edits:
- `src/application/primitives/internal/is-entry-stat-clean.ts` — current
  `export interface CachedStat { readonly entry: IndexEntry; readonly indexMtime: IndexMtime | undefined; }`
  and `matchesCachedStat({ entry, indexMtime }, absPath, stat, contentMatches)` whose first
  line is `if (deriveWorkingMode(stat) !== entry.mode || !matchesContentStat(entry, stat)) return false;`.
  Change: `CachedStat` gains `readonly executableBit: ExecutableBitTrust;` (required, so
  the compiler lists every caller); the test becomes
  `indexModeFromStat(stat, entry.mode, executableBit) !== entry.mode`. Drop the
  `deriveWorkingMode` import. Also add
  `export type TrackedStat = Omit<CachedStat, 'executableBit'>;` for P-1.
- `src/application/primitives/internal/stale-entries.ts` — `isUpToDate(ctx, cached, indexMtime, absPath, contentMatches)`
  calls `matchesCachedStat({ entry: cached, indexMtime }, …)`; `upgradeStaleNoops(ctx, entries, index, workdir, rule)`
  builds `racyContentMatcher(ctx)` once. Add
  `const executableBit = lazily(() => readExecutableBitTrust(ctx));` beside it and pass
  `executableBit: await executableBit()` into the `CachedStat` (lazily keeps the read off a
  changeset with no noop to verify).
- `src/application/primitives/materialize-tree.ts` — `obstructionMayGo(ctx, workdir, index, entry, contentMatches)`
  calls `matchesCachedStat({ entry, indexMtime: index.indexMtime }, …)`; its only caller
  `clearedObstructions` already holds `lazily` readers (`ignoreCase`). Add a lazily
  `executableBit` there and thread it to `obstructionMayGo`.
- `src/application/primitives/internal/occupant-clash.ts` — `export type TrackedLookup = (path: FilePath) => Promise<CachedStat | undefined>;`
  becomes `Promise<TrackedStat | undefined>` (its producers, apply-changeset.ts
  `trackedLookupOf` and find-would-overwrite.ts `clashScopeOf`, already return
  `{ entry, indexMtime }` and need no edit); `classifyThroughLink` calls
  `matchesCachedStat({ ...tracked, executableBit: await readExecutableBitTrust(ctx) }, absPath, reached, racyContentMatcher(ctx))`.
- `src/application/primitives/internal/sparse-left-dirty.ts` — `verdictOf` calls
  `matchesCachedStat({ entry, indexMtime }, absPath, stat, deferRacyToContent)`; pass
  `executableBit: await judgement.executableBit()` (the field Part 1 added).
- `test/unit/application/primitives/internal/is-entry-stat-clean.test.ts` — the
  `describe('matchesCachedStat')` block (fixtures `BASE_STAT: FileStat`, an entry fixture,
  the block `Given a stat whose derived mode differs from the entry mode`). Every existing
  `matchesCachedStat({ entry, indexMtime }, …)` call in this file must gain
  `executableBit: 'trusted'` (check:types fails otherwise). Also grep
  `grep -rn "matchesCachedStat\|CachedStat\b" test src` and fix any other literal
  (test/integration/occupant-displacement-fixtures.ts matched the word; confirm whether it
  builds a `CachedStat`).

### TDD steps
1. RED — `Given a stat that differs from the entry only by the exec bit, When the bit is ignored`
   > `Then the cached stat matches` (non-racy, `executableBit: 'ignored'`, stat
   `{ ...BASE_STAT, mode: 0o100755 }`, entry `100644`). Fails: returns `false` (the mode
   test derives `100755` from lstat).
2. GUARD — `Given … only by the exec bit, When the bit is trusted` > `Then it does not match`
   (`false` today and after).
3. GUARD — `Given a symlink stat for a regular entry, When the bit is ignored` > `Then it does not match`
   (a type change always counts; `false` today and after).
4. GREEN — the five src edits above (they land together: the required field breaks the
   build at every caller).
5. GUARD — stale-entries.test.ts, materialize-tree.test.ts, occupant-clash.test.ts,
   sparse-left-dirty.test.ts, apply-changeset.test.ts unchanged and green (default config).
6. REFACTOR — none expected.

### Gate
```bash
./node_modules/.bin/vitest run test/unit/application/primitives/internal/is-entry-stat-clean.test.ts test/unit/application/primitives/internal/is-entry-stat-clean.properties.test.ts test/unit/application/primitives/internal/stale-entries.test.ts test/unit/application/primitives/materialize-tree.test.ts test/unit/application/primitives/internal/occupant-clash.test.ts test/unit/application/primitives/internal/sparse-left-dirty.test.ts test/unit/application/primitives/apply-changeset.test.ts \
  && ./node_modules/.bin/vitest run --project unit \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/is-entry-stat-clean.ts src/application/primitives/internal/stale-entries.ts src/application/primitives/materialize-tree.ts src/application/primitives/internal/occupant-clash.ts src/application/primitives/internal/sparse-left-dirty.ts test/unit/application/primitives/internal/is-entry-stat-clean.test.ts \
  && npm run check:spelling
```

### Commit
`fix(checkout): ignore an untrusted exec bit in the cached-stat up-to-date check as git does`

## Part 5 — Unmerged work-tree mode from git's donor; status reads the policy once

### Context
Requirement R7 (S5) and the status scan half of ADR-1230's "once per operation".

Files this part edits or creates:
- `src/domain/git-index/unmerged-mode-donor.ts` (NEW, internal — not in
  src/domain/git-index/index.ts):
  ```ts
  interface StagedModes {
    readonly stage1?: { readonly mode: FileMode };
    readonly stage2?: { readonly mode: FileMode };
    readonly stage3?: { readonly mode: FileMode };
  }
  /** git's index_name_pos_also_unmerged preference: ours (stage 2), else base (1), else theirs (3). */
  export const unmergedModeDonor = (stages: StagedModes): FileMode | undefined =>
    (stages.stage2 ?? stages.stage1 ?? stages.stage3)?.mode;
  ```
  The shape matches `UnmergedEntryGroup` in src/domain/diff/index-diff.ts (stage1/2/3 of
  `IndexEntry`), so status passes its group directly. Import `FileMode` by deep path from
  `../objects/file-mode.js`.
- `src/application/commands/status.ts` — `buildUnmergedEntries(ctx, groups, workDir)`
  calls `readWorktreeMode(ctx, workDir, path)` per group; `readWorktreeMode` returns
  `stat === undefined ? undefined : deriveWorkingMode(stat)` (a lossy path reads absent).
  Change: `buildUnmergedEntries` takes the resolved `executableBit` (resolve once with
  `readExecutableBitTrust(ctx)` where `buildUnmergedEntries` is called, only when there is
  at least one group); `readWorktreeMode(ctx, workDir, path, donor, executableBit)` returns
  `indexModeFromStat(stat, donor, executableBit)` with `donor = unmergedModeDonor(group)`.
  Pass a small object rather than a 5-positional list if biome/length rules push back.
  Rewrite the `buildUnmergedEntries` doc ("lstat-derived only") to say the mode is git's
  `mW`: the stat under the donor rule. Drop the `deriveWorkingMode` import.
- `src/application/primitives/internal/scan-tracked-entries.ts` — `scanWorkingTree(ctx, stage0, onScanned, provider, indexMtime)`
  computes `filterDriversConfigured` and `scanner` once; add
  `const executableBit = await readExecutableBitTrust(ctx);` there and thread it through
  `scanEntry` into the `compareAndRefresh` scope literal.
- `test/unit/domain/git-index/unmerged-mode-donor.test.ts` (NEW).
- `test/unit/application/commands/status.test.ts` — existing unmerged tests assert
  `c?.worktree?.mode` (around the `toBe('100644')` assertions); reuse their seeding of
  stage 1/2/3 entries. Exec work file: spy the probe `readWorktreeMode` uses
  (`ctx.fs.lstat`).
- `test/integration/posix-only/core-filemode-false-interop.test.ts` — add S5.

### TDD steps
1. RED — donor suite, `describe.each` over {2 alone, 1+2, 1+3, 3 alone, 1+2+3, none} >
   `When unmergedModeDonor` > `Then $expected` (stage modes chosen distinct so the pick is
   visible; none → `undefined`). Fails: module missing.
2. GREEN — the domain file.
3. RED — status suite, `Given an unmerged path with ours 100755 and theirs 100644, a non-executable work file and core.filemode = false`
   > `When status` > `Then worktree.mode is 100755` (AA/UD shape); plus
   `Given base 100755 and theirs 100644 only (DU), …` > `Then 100755`. Fails: `'100644'`
   from lstat.
4. GUARD — same shapes under the default config: `worktree.mode` follows the stat
   (`'100644'`), as before.
5. RED — status suite, `Given one and then three edited tracked files` > `When status runs over each`
   > `Then core.fileMode reads do not grow with the entry count` (read-count pattern; pass
   `{ refresh: false }` so no index write-back runs). Fails: the scan resolves it per entry
   via `compareAndRefresh`.
6. RED (interop, before the GREEN) — S5 under both ignorecase values: a real `git merge` conflict per
   shape (UD 644/755 → `mW 100755`; AA 755/644 → `100755`; DU 755/644 → `100755`), work
   file `chmod` to the opposite bit; compare git's porcelain v2 `u` line `mW` field with
   tsgit `unmerged[].worktree.mode`. Fails: `mW` comes from lstat.
7. GREEN — status.ts and scan-tracked-entries.ts changes.
8. REFACTOR — none expected.

### Gate
```bash
./node_modules/.bin/vitest run test/unit/domain/git-index/unmerged-mode-donor.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/status-refresh.test.ts test/unit/application/commands/status-gitlink.test.ts \
  && ./node_modules/.bin/vitest run --project posix-integration test/integration/posix-only/core-filemode-false-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/git-index/unmerged-mode-donor.ts src/application/commands/status.ts src/application/primitives/internal/scan-tracked-entries.ts test/unit/domain/git-index/unmerged-mode-donor.test.ts test/unit/application/commands/status.test.ts test/integration/posix-only/core-filemode-false-interop.test.ts \
  && npm run check:spelling
```

### Commit
`fix(status): report an unmerged path's work-tree mode from git's donor stage`

## Part 6 — add stages git's donor mode

### Context
Requirement R3 (A1–A11, A13).

File this part edits — `src/application/commands/add.ts` (2167 lines; navigate by symbol):
- `interface ConversionScope { provider; settings }` and
  `buildConversionScope(ctx)` (built once per add in `addInScope`, or passed to
  `addAll(ctx, ignoreOverride?, givenScope?)`): add
  `readonly executableBit: ExecutableBitTrust` and resolve it in `buildConversionScope`
  with `readExecutableBitTrust(ctx)`.
- `interface StagingScope extends ConversionScope { readonly indexRules: ReadonlyMap<FilePath, IndexEntry> }`
  with `NO_INDEX_RULES`: add `readonly modeDonors: ReadonlyMap<FilePath, FileMode>`
  (the unmerged donor per path) and `NO_MODE_DONORS`. `readExistingEntries(ctx)` (returns
  `ExistingIndexState` with `unmergedStages: Map<IndexPathKey, IndexEntry[]>`,
  `indexRules`, …) computes `modeDonors` from `unmergedStages`: per path, build
  `{ stage1, stage2, stage3 }` from its stage entries and take `unmergedModeDonor(…)`
  (src/domain/git-index/unmerged-mode-donor.ts, Part 5). Key by `entry.path`, as
  `indexRules` is. Spread it wherever `indexRules` is spread today: `addLiteralOnly`
  (`scope: { ...scope, indexRules }`), the walk staging (`{ ...scope, indexRules }`),
  `addAll` (`{ ...scope, indexRules: state.indexRules }`), and `addRenormalized`
  (`indexRules: NO_INDEX_RULES` → add `modeDonors: NO_MODE_DONORS`; renormalize only
  re-cleans stage-0 entries, see `isRecleaned`).
- A private `donorOf(scope, previous: IndexEntry | undefined): FileMode | undefined`:
  `undefined` when no previous; `previous.mode` when `previous.flags.stage === 0`
  (intent-to-add included); else `scope.modeDonors.get(previous.path)`. Note:
  `previous` for an unmerged path is its LAST stage entry (see the `out.set` rule in
  `readExistingEntries` and the `indexRuleBlob` doc), which is why the donor map exists.
- `stagePromisorChecked(ctx, path, fresh, scope, previous, indexMtime)`:
  `const mode: FileMode = deriveWorkingMode(fresh);` →
  `indexModeFromStat(fresh, donorOf(scope, previous), scope.executableBit)`.
- `renormalizeOne({ ctx, scope, ensurePromisorConfigValid }, previous)`: same, donor
  `previous.mode` (always stage 0 there; `donorOf` gives that).
- `restagesAsIs(previous, fresh, indexMtime)` → add the trust parameter (from the scope at
  its one caller, `stagePromisorChecked`) and test
  `indexModeFromStat(fresh, previous.mode, executableBit) === previous.mode`. REWRITE the
  existing comment line above `previous.mode !== FILE_MODE.GITLINK` — it currently says
  "equivalent — deriveWorkingMode never returns FILE_MODE.GITLINK, so the next conjunct
  (mode match) is unconditionally false whenever previous.mode is GITLINK; …". Replace the
  reasoning, keeping the same `Stryker disable next-line ConditionalExpression: equivalent — …`
  prefix: "indexModeFromStat never returns FILE_MODE.GITLINK (a gitlink donor yields
  100644 or the stat-derived mode), so the next conjunct …". Do not add any other
  suppression comment.
- Remove the `deriveWorkingMode` import once no site uses it.

Test files this part edits:
- `test/unit/application/commands/add.test.ts` — tracked/untracked rows; seed with the
  file's own helpers; config `[core]\n\tfilemode = false\n` plus cache invalidation; exec
  work file via a spy on `ctx.fs.lstat` (add's `freshStatOfSameKind` and literal stats call
  `ctx.fs.lstat`; check `lstatOrMissing` too) returning `mode: 0o100755`; assert the
  staged entry mode via `readIndex(ctx)`.
- `test/unit/application/commands/add-unmerged.test.ts` — unmerged rows; reuse
  `seedIndex`, `IndexRow`, `stagesOf` from test/unit/application/commands/add-index-fixtures.ts
  and `seedRepo` from test/unit/application/commands/fixtures.ts.
- `test/integration/posix-only/core-filemode-false-interop.test.ts` — add rows A1, A2, A3,
  A5, A6, A7, A9, A10, A13.

### TDD steps
1. RED — add.test.ts `describe.each` rows under `Given core.filemode = false`:
   A1 tracked `100644`, work file `+x` → staged `100644`; A2 tracked `100755`, `-x` →
   `100755`; A3 = A2 + content change → `100755` with the new blob; A5 new untracked exec
   file → `100644`; A13 symlink entry replaced by an exec regular file → `100644`. Each
   `When add` > `Then the staged mode is $expected`. Fails: staged mode follows lstat
   (`100755`, `100644`, `100644`, `100755`, `100755`).
2. GUARD — same rows under the default config: the stat-derived mode (unchanged).
3. RED — add-unmerged.test.ts rows under `Given core.filemode = false`: A7 stage2 `100755`
   + stage3 `100644`, work `-x` → `100755`; A8 stage1 `100644` + stage2 `100755`, `-x` →
   `100755`; A9 stage1 `100755` + stage3 `100644`, `-x` → `100755`; A10 stage1 `100644` +
   stage3 `100755`, `+x` → `100644`; A11 stage2 `100644` + stage3 `100755`, `+x` →
   `100644`. Fails: staged from lstat.
4. RED — add.test.ts `Given a stat-clean tracked 100644 file whose stat differs only by the exec bit, and core.filemode = false`
   > `When add` > `Then the entry is re-staged as is without reading the file` (spy
   `ctx.fs.readSlice`: not called; the spied stat keeps every other field, so
   `isEntryStatClean` holds). Fails: `restagesAsIs` compares `deriveWorkingMode`
   (`100755 !== 100644`), so the file is read and re-hashed.
5. RED (interop, before the GREEN) — A rows under both ignorecase values: compare `lsStage(peer)` with
   `lsStage(ours)` after `git add <path>` vs `repo.add([path])` (oids equal: same bytes).
   A6: `100755` entry removed and recreated `-x` with new content, then status
   (`.M 100755 100755 100755` vs tsgit `worktree.mode '100755'`) and add (`100755`).
   Every A row fails: tsgit stages the lstat mode.
6. GREEN — the add.ts changes.
7. REFACTOR — keep `stagePromisorChecked` and `restagesAsIs` under 20 lines.

### Gate
```bash
./node_modules/.bin/vitest run test/unit/application/commands/add.test.ts test/unit/application/commands/add-unmerged.test.ts test/unit/application/commands/add-gitlink.test.ts test/unit/application/commands/add-skip-worktree.test.ts \
  && ./node_modules/.bin/vitest run --project posix-integration test/integration/posix-only/core-filemode-false-interop.test.ts \
  && ./node_modules/.bin/vitest run --project unit \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-unmerged.test.ts test/integration/posix-only/core-filemode-false-interop.test.ts \
  && npm run check:spelling
```

### Commit
`fix(add): stage the donor entry's mode when core.fileMode is false as git does`

## Part 7 — stash records git's donor mode; rm reads the policy once

### Context
Requirement R6 (T2, T3) and the rm/stash halves of ADR-1230's "once per operation".
Decision P-2 recommended option A.

Files this part edits:
- `src/application/commands/stash.ts` —
  - its own `interface ConversionScope { provider; settings }` + `buildConversionScope(ctx)`:
    add `readonly executableBit: ExecutableBitTrust`, resolved there.
  - `interface HashedFile { readonly mode: ReturnType<typeof deriveWorkingMode>; … }` →
    `readonly mode: FileMode`.
  - `interface HashRequest { path; stat; scope: ConversionScope; indexBlob?: ObjectId }`:
    add `readonly indexMode?: FileMode` ("the stage-0 entry's mode, git's donor; absent for
    HEAD-only and untracked files").
  - `hashFileAt(ctx, workDir, request)`: `const mode = deriveWorkingMode(request.stat);` →
    `indexModeFromStat(request.stat, request.indexMode, request.scope.executableBit)`.
  - `projectEntry`: next to `...(tracked.kind === 'indexed' && { indexBlob: entry.id })`
    add `indexMode: entry.mode` under the same condition.
  - `hashUntracked` passes no donor (unchanged call).
  - `interface SnapshotScope { head; provider; indexMtime; scanner }` (used by
    `classifyEntry`, which calls `compareAndRefresh(ctx, entry, scopeOf(scope.provider, scope.indexMtime, scope.scanner))`):
    add `executableBit` where the SnapshotScope is built (find the literal) and spread it
    into that comparison scope.
  - Drop the `deriveWorkingMode` import.
- `src/application/commands/rm.ts` — `interface ValveDeps { scanner; provider; indexMtime; childStatus }`
  and `localModificationOf(ctx, deps, entry)` building
  `{ provider, scanner, ...(indexMtime !== undefined && { indexMtime }) }`: add
  `executableBit` to `ValveDeps` (resolve where the deps object is built, once per rm) and
  to that scope literal.
- `test/unit/application/commands/stash.test.ts` — find the existing W-tree content tests
  (they read the stash commit's third-parent tree); add mode rows.
- `test/unit/application/commands/rm.test.ts` — one "read once" test.
- `test/integration/posix-only/core-filemode-false-interop.test.ts` — rows T2, T3.

### TDD steps
1. RED — stash suite, `Given an executable entry whose work file lost the exec bit and changed content, and core.filemode = false`
   > `When stash push` > `Then the work-tree tree records 100755` (T3). Fails: `hashFileAt`
   records `100644` from lstat.
2. RED — `Given a regular entry whose work file gained the exec bit and changed content, and core.filemode = false`
   > `Then the work-tree tree records 100644` (T2: donor `100644`; spy the stat to
   `0o100755`, else the memory stat makes it trivially `100644`). Fails: records `100755`.
3. RED — stash suite, `Given one and then three edited tracked files` > `When stash push runs over each`
   > `Then core.fileMode reads do not grow with the entry count` (read-count pattern).
   Fails: per-entry resolution in `classifyEntry`.
4. RED — rm suite, `Given one and then three tracked files` > `When rm runs over each` >
   `Then core.fileMode reads do not grow with the entry count`. Fails: per-entry resolution.
5. RED (interop, before the GREEN) — T2 (content + `+x` on a `100644` entry: stash W-tree `100644`,
   `f` `-x` after push in both, `stash apply` → `.M`, `-x`) and T3 (content change on a
   `100755` entry with `f` `-x`: W-tree `100755`; after `stash pop` `f` is `+x` in both).
   Compare `git ls-tree -r 'stash@{0}'` mode and
   blob columns in both twins (commit oids differ by timestamp; trees must not). T3 fails
   (tsgit records `100644`); T2 is a GUARD (the design matrix pins it as a match on main;
   if it fails here, it is a RED and the unit RED of step 2 explains it).
6. GREEN — stash.ts and rm.ts changes.
7. REFACTOR — none expected.

### Gate
```bash
./node_modules/.bin/vitest run test/unit/application/commands/stash.test.ts test/unit/application/commands/stash-unmerged-index.test.ts test/unit/application/commands/stash-clean-order.test.ts test/unit/application/commands/rm.test.ts \
  && ./node_modules/.bin/vitest run --project posix-integration test/integration/posix-only/core-filemode-false-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/stash.ts src/application/commands/rm.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/rm.test.ts test/integration/posix-only/core-filemode-false-interop.test.ts \
  && npm run check:spelling
```

### Commit
`fix(stash): record the donor entry's mode in the stash work tree as git does`

## Part 8 — Switch and merge refuse to overwrite a trusted exec-bit change (breaking)

### Context
Requirement R9, D-B ratified, ADR-1232. Breaking on the default configuration.
Decision P-4 recommended option A.

Files this part edits:
- `src/application/primitives/internal/occupant-clash.ts` — `OccupantVerdict`'s
  `{ readonly kind: 'compare-content' }` member gains `readonly stat: FileStat` ("the lstat
  the probe took"); the module constant `COMPARE_CONTENT` is replaced by a constructor,
  and `classifyChangedPath` (the only producer: `if (!stat.isDirectory) return COMPARE_CONTENT;`)
  returns `{ kind: 'compare-content', stat }` from the `lstatIfReachable` it already took.
  No second stat.
- `src/application/primitives/apply-changeset.ts` —
  - `interface DirtyProbe { provider; settings }` + `buildDirtyProbe(ctx)` (lazily built,
    shared by `checkDirty` and `createWorkingTreeDirtyCheck`): add
    `readonly executableBit: ExecutableBitTrust` resolved with `readExecutableBitTrust(ctx)`.
  - a private `modeChanged(probe: DirtyProbe, previousMode: FileMode | undefined, stat: FileStat): boolean`
    = `previousMode !== undefined && isRegularFileMode(previousMode) && indexModeFromStat(stat, previousMode, probe.executableBit) !== previousMode`.
    EXPORT `isRegularFileMode` from src/domain/objects/file-mode.ts in this part (its first
    cross-file consumer).
  - `evaluateChangedPath(ctx, probe, entry, kind, scope, unmergedPaths)`: after
    `if (verdict.kind !== 'compare-content') return verdictClash(verdict);` add
    `const dirtyProbe = await probe(); if (modeChanged(dirtyProbe, entry.previousMode, verdict.stat)) return { class: 'local-changes', path: entry.path };`
    then the existing `blobMatches(ctx, dirtyProbe, …)`. The gitlink early return and the
    `previousId === undefined` branch stay before it.
  - `merge` reaches this through `materializeTree` and maps `CHECKOUT_OVERWRITE_DIRTY` to
    `WORKING_TREE_DIRTY` already (src/application/commands/merge.ts); octopus /
    `workTreeTakes` go through `findWouldOverwrite` (covered by Part 2). No merge.ts edit.
- `test/unit/application/primitives/apply-changeset.test.ts` — the block
  `Given an unforced update of a locally modified file` and
  `Given a regular-file update over a locally modified file` are the templates; refusal
  data `{ code: 'CHECKOUT_OVERWRITE_DIRTY', localChanges: […], untracked: [] }`
  (src/domain/commands/error.ts `checkoutOverwriteDirty`).
- `test/unit/application/primitives/internal/occupant-clash.test.ts` — the two
  `expect(result).toEqual({ kind: 'compare-content' })` assertions become
  `toEqual({ kind: 'compare-content', stat: expect.objectContaining({ isFile: true }) })`
  (or assert the spied stat object identity).
- `test/integration/posix-only/core-filemode-false-interop.test.ts` — rows K1, K3, K4,
  M1 (fileMode `false`), K1t, K3t, K4t, M1t (fileMode `true`), P1, P3.

Expected fallout (P-4): memory-adapter tests whose changeset `previousMode` or checked-out
entry is `100755` while the memory stat reports `0o100644` now refuse under the default
config. Suites likely touched (run them; fix each by giving the stat the exec bits when the
bit is incidental): test/unit/application/primitives/apply-changeset.test.ts,
materialize-tree.test.ts, apply-merge-to-worktree.test.ts,
test/unit/application/commands/merge.test.ts, merge-strategy.test.ts, pull.test.ts,
checkout-skip-worktree.test.ts, internal/octopus-merge.test.ts. Each fixed file is edited
in this part; if the fallout exceeds two extra files, stop and escalate
`{ unit: 'Part 8', reason: 'memory-fs exec-bit fallout', options: [spy stats per test, a shared fixture helper in test/unit/application/primitives/fixtures.ts, split the fallout into a follow-up part] }`.

### TDD steps
1. RED — apply-changeset suite, `Given an unforced update of a file whose exec bit was set locally (regular previousMode, stat 0o100755), with the default config`
   > `When the changeset is applied` > `Then it refuses with CHECKOUT_OVERWRITE_DIRTY naming the path`
   (try/catch, assert `code`, `localChanges`, `untracked`). Fails: content matches, the
   apply proceeds and resets the bit.
2. RED — same shape for a `delete` entry (the K3t/K4t kind: file → directory, directory →
   file). Fails: the delete proceeds.
3. GUARD — `Given the same exec-bit-only change with core.filemode = false` > `Then it applies`
   (K1/K3/K4: passes today, content-only, and after).
4. GUARD — `Given an update whose target only flips the mode (100644 → 100755) over an untouched -x file`
   > `Then it applies` (K2: stat mode equals `previousMode`).
5. RED (interop, before the GREEN) — rows under both ignorecase values: K1t/K3t/K4t (`core.fileMode=true`,
   exec-only change on a file the target rewrites or removes: git refuses "would be
   overwritten by checkout", non-zero exit; tsgit `CHECKOUT_OVERWRITE_DIRTY` with
   `localChanges` naming the path; both work trees unchanged, bit kept), M1t (`merge`:
   git refuses "would be overwritten by merge"; tsgit `WORKING_TREE_DIRTY` — assert its
   data fields per src/domain/commands/error.ts), K1/K3/K4/M1 under `false` (both switch or
   merge; `f` `-x`; an untouched `+x` file keeps `+x`), P1 (`checkout -- f` on a `-x`
   entry after `chmod +x` at least 1 s after the index write — sleep ~1.1 s in Arrange;
   git's ctime test is whole-second: both rewrite `-x`) and P3 (`checkout -- f` with a
   content change on a `100755` entry with `f` `-x`: both rewrite `+x`). K1t, K3t, K4t,
   M1t fail (tsgit switches/merges and resets the bit); K1, K3, K4, M1, P1, P3 are GUARDs.
6. GREEN — occupant-clash.ts verdict `stat`; apply-changeset.ts `DirtyProbe.executableBit`,
   `modeChanged`, the new check; export `isRegularFileMode`.
7. GUARD — occupant-clash.test.ts after the two assertion updates.
8. REFACTOR — keep `evaluateChangedPath` under 20 lines (extract the mode check if needed).

### Gate
```bash
./node_modules/.bin/vitest run test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/internal/occupant-clash.test.ts \
  && ./node_modules/.bin/vitest run --project posix-integration test/integration/posix-only/core-filemode-false-interop.test.ts \
  && ./node_modules/.bin/vitest run --project unit \
  && ./node_modules/.bin/vitest run --project integration test/integration/checkout-file-directory-swap-interop.test.ts test/integration/merge-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/objects/file-mode.ts src/application/primitives/apply-changeset.ts src/application/primitives/internal/occupant-clash.ts test/unit/application/primitives/apply-changeset.test.ts test/unit/application/primitives/internal/occupant-clash.test.ts test/integration/posix-only/core-filemode-false-interop.test.ts \
  && npm run check:spelling
```
(src/domain/objects/file-mode.ts is edited here only to export `isRegularFileMode`; it is
listed in the biome run, not counted as a Context file of new work.)

### Commit
`fix(checkout)!: refuse to overwrite a trusted exec-bit-only change as git does`

## Part 9 — The eager gate refuses a bad core.fileMode (breaking)

### Context
Requirement R10, D-C ratified, ADR-1233 (supersedes ADR-1186's "only the sparse keys" for
`filemode`; carries forward: the worktree-file gate runs only with the extension on, and
`core.ignorecase` in `config.worktree` is still not checked). Decision P-3 recommended
option A.

Files this part edits:
- `src/application/primitives/internal/repo-state.ts` —
  - `const CORE_BOOLEAN_KEYS: ReadonlyArray<string> = ['ignorecase', 'sparsecheckout', 'sparsecheckoutcone'];`
    (used by `assertEagerConfigValid` through
    `findFirstInvalidBoolean(ctx, 'core', undefined, CORE_BOOLEAN_KEYS)`): add `'filemode'`.
  - `assertWorktreeSparseBooleansValid(ctx)` (called from `assertOperationalRepository`,
    `assertOperationalRepositorySettingsFirst` and one more caller in the file) filters
    `sparseKeyEntries(await readActiveWorktreeSections(ctx))`, refuses the first
    `isRefusedBoolean` entry with
    `configBadBooleanValue(`core.${refused.key}`, resolveWorktreeScopePath(ctx, { active: true }), refused.value)`.
    Rename it `assertWorktreeCoreBooleansValid` (all call sites in this file), filter with
    `coreKeyEntries(…, WORKTREE_GATED_KEYS)` where
    `const WORKTREE_GATED_KEYS: ReadonlySet<string> = new Set(['sparsecheckout', 'sparsecheckoutcone', 'filemode'])`,
    retype `isRefusedBoolean` over `CoreKeyEntry`, and rewrite its doc: git's
    `git_default_core_config` dies on a bad `core.filemode` and `repo_config_get_bool` on a
    bad sparse key wherever the layered config holds them; `core.ignorecase` in the
    worktree file is not checked here. The error key is lower-case (`core.filemode`), as
    git prints it.
- `src/application/primitives/read-sparse-config.ts` — delete the temporary
  `SparseKeyEntry` alias and `sparseKeyEntries` wrapper added in Part 1 (no importer is
  left; knip).
- `test/unit/application/primitives/internal/repo-state.test.ts` — helpers `seededCtx`,
  `catchTsgitError`; template: the `Given a bad core.autocrlf or core.safecrlf` block.
- `test/unit/application/primitives/internal/repo-state-worktree-sparse.test.ts` — rename
  the import and the top `describe`; helpers `seedRepo`, `seedWorktreeConfig`,
  `refusalOf`, `badBoolean(ctx, key, value)`. The resolving row
  `'a bad ignoreCase, which is not a sparse key'` stays (carried forward); reword its label
  to "which the worktree gate does not check".
- `test/integration/posix-only/core-filemode-false-interop.test.ts` — rows C5, C6.

### TDD steps
1. RED — repo-state.test.ts `Given core.filemode = bogus in local config` >
   `When assertEagerConfigValid` > `Then it refuses with CONFIG_BAD_BOOLEAN_VALUE naming core.filemode`
   (assert `code`, `key: 'core.filemode'`, `value: 'bogus'`, `source` = the local config
   path). Fails: resolves (key not gated).
2. GUARD — `Given core.filemode` valueless / `= false` / `= 0` > `Then it resolves`.
3. RED — worktree suite `Given the extension on and a bad fileMode in config.worktree` >
   `When the check runs` > `Then it refuses naming core.filemode, the value and the worktree file`
   (`badBoolean(ctx, 'core.filemode', 'bogus')`), and the same through
   `assertOperationalRepository`. Fails: resolves (sparse keys only).
4. GUARD — `Given the extension off and a bad fileMode in config.worktree` > `Then it resolves`.
5. RED (interop, before the GREEN) — C5 (local `core.fileMode = bogus`: `git status` and `git log`
   exit 128 with `fatal: bad boolean config value 'bogus' for 'core.filemode'`; tsgit
   `repo.status()` and `repo.log(…)` throw `CONFIG_BAD_BOOLEAN_VALUE` with
   `key: 'core.filemode'`, `value: 'bogus'`) and C6 (the same value in `config.worktree`
   with the extension on, written with `git config --worktree`). Use
   `tryRunGitWithExit` for git's exit code and stderr. Fails: tsgit succeeds.
6. GREEN — repo-state.ts changes, rename, wrapper removal.
7. REFACTOR — none expected.

### Gate
```bash
./node_modules/.bin/vitest run test/unit/application/primitives/internal/repo-state.test.ts test/unit/application/primitives/internal/repo-state-worktree-sparse.test.ts test/unit/application/primitives/read-sparse-config.test.ts test/unit/application/primitives/read-executable-bit-trust.test.ts \
  && ./node_modules/.bin/vitest run --project posix-integration test/integration/posix-only/core-filemode-false-interop.test.ts \
  && ./node_modules/.bin/vitest run --project unit \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/primitives/internal/repo-state.ts src/application/primitives/read-sparse-config.ts test/unit/application/primitives/internal/repo-state.test.ts test/unit/application/primitives/internal/repo-state-worktree-sparse.test.ts test/integration/posix-only/core-filemode-false-interop.test.ts \
  && npm run check:spelling
```
Phase gate after this part: `npm run validate` (it runs knip, which proves every export
added across Parts 1–9 has a consumer).

### Commit
`fix(config)!: refuse a bad core.fileMode in local config and config.worktree as git does`
