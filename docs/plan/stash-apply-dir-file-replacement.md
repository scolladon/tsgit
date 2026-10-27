# Plan — stash-apply-dir-file-replacement

> Source: design doc `docs/design/stash-apply-dir-file-replacement.md` · ADRs 1096, 1097, 1098, 1099, 1100 (binding: 212, 226, 249, 1092, 1095)
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

## Conventions every part follows

Read this section before your part. The part blocks do not repeat it.

- Work only in the worktree root (the directory holding this plan); every command is repo-relative. Never
  touch the main checkout, never change branch, index, stash or other agents' files.
- git 2.55: every vitest run that touches an interop file is prefixed with
  `PATH="$HOME/.local/git-2.55.0/bin:$PATH"` (the machine default is 2.56). The interop helpers scrub every
  GIT_* variable (SAFE_ENV in test/integration/interop-helpers.ts) and fixtures commit through COMMIT_ENV
  (fixed Ada identity, date 1700000000 +0000), so commit, tree and blob ids built with commitOn or
  buildHistory are equal across twins. No suite asserts `git --version` (no house precedent).
- Line numbers below were re-derived on this worktree at HEAD 2889796b (src identical to main 23ff6c1e). They
  drift as earlier parts land: locate by symbol name, use the line as a hint.
- TDD: one RED per function or per interop row, each RUN and SEEN failing for the stated reason before the code
  that satisfies it; GREEN is the minimal code; REFACTOR never changes behaviour. A test that already passes
  at its step is a GUARD and cites why it passes. Never break code to watch a test fail. Every interop row a
  part owns is listed in its TDD steps; write each before its GREEN.
- Lesson 017: every expectation that is a refusal, an exit 1 or a kept occupant is git's, pinned in the
  design's Appendix A; this plan names the A.x id per row, tests and titles never carry it. Interop rows compare tsgit to the git peer; where git renders text from data tsgit
  returns as fields, rebuild git's bytes from tsgit's fields in the test (ADR-249) and compare.
- Lesson 018: every apply interop row drifts the clean bystander `keep` (touchedAt('keep')) after the push and
  the settle, records the index inode, and asserts after the command: staleEntries equal between twins (git
  refreshed `keep`, so it is absent from both) and "index inode changed" equal between twins.
- Test conventions (CLAUDE.md, enforced by `npm run check:test-pyramid`): describe('Given …') >
  describe('When …') > it('Then …') (the 2-level shortcut 'Given …, When …' > it('Then …') only for a single
  expectation); AAA section comments (`// Arrange`, `// Act`, `// Assert`); `sut` is the UNIT UNDER TEST — the
  function or command (`const sut = stashApply;`), never its output; the output goes in `result` (or `data`
  for a caught error's data). The pyramid audit's sutBindsResult rule fails a test that writes
  `const sut = await stashApply(...)`. Error assertions read `err.data` through try/catch (or a
  `refusalOf`/`dataOf` helper) and assert the code AND its fields, never a bare `toThrow(Class)`. One test
  per guard branch.
- Unit tests run on the memory adapter (createMemoryContext from src/adapters/memory/memory-adapter.ts). Move
  the memory mtime clock with `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`, restored in an
  `afterEach(() => vi.useRealTimers())` (pattern: test/unit/application/commands/internal/refresh-index.test.ts:22-64,
  touchF rewrites the same bytes 10 s later).
- No provenance refs (phase, ADR, backlog, design row ids, F/R/A numbers) in source, tests or titles. No
  suppression directives of any kind (`stryker-disable`, `v8 ignore`, `biome-ignore`, `@ts-ignore`); an
  existing `// Stryker disable` comment may only move verbatim with its line (Part 3). No swallowed errors.
  Functions under 20 lines, nesting ≤ 2, named constants, no boolean parameters.
- `tsconfig.json` sets `exactOptionalPropertyTypes`: build optional fields with a conditional spread
  (`...(x === undefined ? {} : { x })`), never assign `undefined` to an optional property.
- Long outputs go to a file under `${TMPDIR:-/tmp}` and are read back with tail/grep.
- wireit caches gate results: a gate step printing `Ran 0 scripts and skipped 1` is stale; re-run it as
  `npx tsc --noEmit -p tsconfig.json` (types) and `npx cspell --no-progress <touched files>` (spelling).
- Size caps: no part raises a cap. If a gate you choose to run goes red ONLY on check:size/check:tarball, record
  the measured overshoot in the final report and commit; the session raises the caps once after review. Expected
  gzip delta per part is in each Commit block's note; net about +400–600 B.
- reports/api.json is regenerated (`npm run docs:json`) and committed by the parts that change a public type
  (Parts 5 and 7); the huge typedoc-id renumbering diff is normal.
- User docs (docs/use/commands/stash.md, Throws and Behaviour sections) are NOT edited by any part: the
  documentation phase owns them (new code, the two refusal classes, the untracked restore order, the
  empty-tree U commit, the dropped pending-operation refusal).
- Commit only after the gate is green: `git add <the part's files>` then `git commit -m "<message>"` with the exact
  message of the part's Commit block. Never `--no-verify`.
- Apply family (lesson 015: Parts 2, 4, 6, 7, 8 change a step every `stash apply`, `pop` and autostash
  re-apply runs). Run it as written and report the file count:
  `PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run $(grep -lE "stash\.(apply|pop)|stashApply|stashPop|autostash" test/integration/*.test.ts) > "${TMPDIR:-/tmp}/stash-apply-family.log" 2>&1 || { tail -n 80 "${TMPDIR:-/tmp}/stash-apply-family.log"; false; }; tail -n 8 "${TMPDIR:-/tmp}/stash-apply-family.log"`
  (17 files at plan time; 18 once Part 4 creates the type-change suite).
- Push family (Part 3): the same form over
  `$(grep -lE "stash\.push|stashPush|'stash', 'push'|stash push" test/integration/*.test.ts)` (17 files at
  plan time), log `${TMPDIR:-/tmp}/stash-push-family.log`.

- Shared files across parts are intentional (plan-lint locality warnings): the parts are sequential on one
  tree and every fix lives in src/application/commands/stash.ts and its unit suite; splitting by behaviour
  (refresh, push, W = base, restore, refusal data, gate) keeps each part within 5 RED→GREEN cycles and 6 files.
  Parts 5 and 7 both touch the error module, its test and reports/api.json because Part 5 adds a new code ahead
  of its caller (Part 6's file budget) and Part 7 extends an existing code with its restructure.

### Public-surface decisions (decided here, per new symbol)

| Symbol | Where | Decision | Part |
|---|---|---|---|
| error code STASH_UNTRACKED_NOT_RESTORED and its data `{ existing, blockedAt? }` | src/domain/commands/error.ts union | PUBLIC (error union is reachable by every caller) | 5 |
| `UntrackedNotRestored` interface | src/domain/commands/error.ts | exported for src use, NOT barrelled (precedent: WouldOverwriteClasses); public only structurally through the error data and the conflict result | 5 |
| `stashUntrackedNotRestored` constructor | src/domain/commands/error.ts | internal (constructors are not barrelled) | 5 |
| STASH_APPLY_WOULD_OVERWRITE gains `localChanges`, `untracked`, `untrackedNotRestored?` | same union | PUBLIC, additive | 7 |
| `StashApplyResult` / `StashPopResult` conflict variant gains `untrackedNotRestored?` | src/application/commands/stash.ts (already barrelled in src/application/commands/index.ts:349-355) | PUBLIC, additive | 7 |
| stash-local helpers (`StashMerge`, `unchangedMerge`, `RestoreVerdict`, `settleIndex`, `reportApply`, …) | src/application/commands/stash.ts | internal, not exported | 4, 6, 7 |

Surface gates for the public ones (pre-paid in-part): the union member in src/domain/commands/error.ts, the
message case in src/domain/error.ts (exhaustive switch), the shared exhaustiveness switch
test/unit/domain/exhaustiveness.ts, the constructor and message rows in
test/unit/domain/commands/error.test.ts, and reports/api.json (prepush `check:doc-typedoc`; `npm run validate`
does not regenerate it). No barrel-surface snapshot lists error codes (verified: only the four files above
name STASH_APPLY_WOULD_OVERWRITE in src and test/unit/domain). No new command, option or facade method.

## Part 1 — interop guard: a staged directory-to-file stash applies as git does

### Context

- Test-only part, no `src/` delta: it pins the backlog's literal shape (tracked d/x replaced by a file d,
  `git add -A`, `stash push`, `stash apply` on a clean tree), which #331 fixed in the shared pre-flight and
  nothing pins for stash (design F1, A.6 O1–O3). It lands first and stays green through every later part.
- Edit `test/integration/stash-apply-index-interop.test.ts`:
  - `ROWS` (lines 47-65) holds two rows, each `{ title, stage(dir) }`; `seed` (41-47) commits m, k and a FILE
    d, so the new row first turns d into a tracked directory, then replaces it:
    stage: rm d → put d/x 'x\n' → git add -A → git commit -q -m dir → rm -r d → put d 'file\n' → git add -A.
    Use `rm(path.join(dir, 'd'), { recursive: true })` for the second removal. Title:
    'a directory replaced by a file'.
  - The describe loop (73-112) already runs git stash push/apply in the peer and stashPush/stashApply on the
    twin and asserts three things: `lsStage` equal, zero-stat paths equal, `git write-tree` succeeds. The
    row reaches the directory-to-file arm of unstageChangesUnlessNew
    (src/application/commands/internal/unstage-changes-unless-new.ts:41-47, the files.has(dir) branch) from
    the public command.
- git's outcome (A.1 DFa × apply): exit 0, index holds d only (`A  d`, `D  d/x` against HEAD), stderr carries
  `error: 'd/x' appears as both a file and as a directory` (not asserted, rendering). tsgit on main: same
  ls-files -s, no zero-stat path in either index, write-tree succeeds (design lesson-005 evidence).

### TDD steps

1. GUARD — new ROWS entry 'a directory replaced by a file' (three `it`s via the loop). Passes on the current
   code: #331 classifies the dir→file swap correctly in the shared pre-flight (A.6 O3 applies at fb6bc5b0) and
   A.1 DFa × apply is SAME. Run it; if it fails, stop and report a blocker (the regression the backlog
   describes is live again).
2. No GREEN, no REFACTOR.

### Gate

`PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/integration/stash-apply-index-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/stash-apply-index-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`

### Commit

`test(stash): pin a staged directory-to-file stash apply against git`
(size delta 0 B)

## Part 2 — `stash apply` / `pop` open with git's index refresh

### Context

- Requirement R5 (design P2, RC4, F7; ADR-1092 reused as-is). git's `stash apply` runs
  `refresh_and_write_cache` after resolving the stash: stat-drifted, content-clean entries are refreshed and
  the index rewritten unconditionally, then an unmerged index is refused — the refreshed index stays on disk.
  With no stash, git exits 1 before the refresh and keeps the index inode and the stale stat (A.1 DL rows).
- Edit `src/application/commands/stash.ts`:
  - `stashApply` (lines 966-973) today: gateStash → assertNoPendingOperation (971) → resolveStashEntry →
    applyStashCommit. New order:
    workDir = gateStash(ctx, 'stash apply') → stash = resolveStashEntry(ctx, input.index ?? 0) →
    refreshAndWriteIndex(ctx) → assertNoPendingOperation(ctx) (moved here, after the refresh; Part 8 removes
    it) → applyStashCommit(ctx, workDir, stash, input).
  - refreshAndWriteIndex is already imported (line 120, used by stashPush at 580); it lives in
    src/application/commands/internal/refresh-index.ts:35-46 (own lock, filter pool, `lock.commit(…, 'update')`,
    then rejectUnmergedIndex → MERGE_HAS_CONFLICTS).
  - Keep applyUnderLock's own rejectUnmergedIndex (1045): applyAutostash (979-994) enters applyStashCommit
    without stashApply. Do NOT add the refresh to applyAutostash (out of perimeter, unproven hunch in the design).
  - stashPop (1105-1116) delegates to stashApply: covered with no change.
- Edit `test/unit/application/commands/stash-unmerged-index.test.ts`: conflictedRepoWithStash (42-58) deletes
  MERGE_HEAD at 57 to get past the pending gate; add a sibling builder that keeps it. refusalOf (63-70) reads
  `err.data`.
- Edit `test/unit/application/commands/stash.test.ts`: describe('stash apply') starts at 896; helpers write,
  read, commitFile, setupRepo, headId at 52-100. Add the refresh rows under it (fake-timer pattern from
  the conventions).
- Edit `test/integration/stash-interop.test.ts` for the U1 row: header 1-15 (`@proves surface: stash`); the
  suite builds peers with runGit/git; reuse buildHistory/commitOn/KEEP/regular (already imported from
  ./occupant-displacement-fixtures.js; add touchedAt, staleEntries to that import) and tryRunGitWithExit,
  COMMIT_ENV. Shape to build (A.5 U1), in BOTH twins with git: base = commitOn([KEEP, regular('f','base\n'),
  regular('s','s\n')]); side and main children with f = 'side\n' / 'main\n'; update-ref, reset --hard main;
  write s = 'stashed\n' and `git stash push -q` (git pushes in both, which isolates the apply); then
  `git merge -q side` (exit 1, conflict on f, MERGE_HEAD present). Do NOT call settleIndex here
  (`update-index --refresh` refuses an unmerged index); touchedAt('keep') moves keep's mtime 5 s forward, which
  is enough. Record `statSync('.git/index').ino` in both.
- git's outcome (A.5 U1): exit 1, stdout `f: needs merge\n`, stderr `error: could not write index\n`, index
  rewritten (inode changed), keep fresh, stages of f kept. tsgit today: OPERATION_IN_PROGRESS { operation:
  'merge' }, inode kept, keep stale.

### TDD steps

1. RED (stash.test.ts, stashApply) — Given a stash of an edit to a.txt and a clean bystander b.txt rewritten
   with the same bytes 10 s later, When stash apply runs, Then b.txt's index entry records its new mtime and
   keeps its id. Fails: the apply commits `unstageChangesUnlessNew(newIndexEntries, currentIndex.entries)`
   built from the unrefreshed index, so b.txt keeps its old mtimeSeconds.
2. RED (stash.test.ts, stashApply) — Given the same drifted bystander and a dirty a.txt on the stashed path,
   When stash apply refuses STASH_APPLY_WOULD_OVERWRITE, Then b.txt's index entry is refreshed anyway (assert
   the code AND b.txt's new mtime). Fails: nothing writes the index on a refusal today.
3. RED (stash.test.ts, stashPop) — Given the drifted bystander and a clean pop, Then the bystander is
   refreshed and the stash dropped. Fails for the reason of step 1.
4. RED (stash-unmerged-index.test.ts, stashApply) — Given a stash and a merge left conflicted on c with
   MERGE_HEAD still present and a bystander o rewritten later with the same bytes, When stash apply runs, Then
   it refuses MERGE_HAS_CONFLICTS { count: 1, paths: ['c'] }, the stages 1/2/3 of c are kept and o's entry is
   refreshed. Fails: assertNoPendingOperation throws OPERATION_IN_PROGRESS { operation: 'merge' } first.
5. RED (stash-interop.test.ts) — U1 row: 'Given a merge left conflicted on f, a stash and a stat-drifted
   clean entry' > 'When git and tsgit stash apply' > 'Then both refresh the clean entry, rewrite the index and
   refuse on the unmerged path'. Assert: git exit 1, git stdout equals the lines "<path>: needs merge" (one per
   path, newline-terminated) rebuilt from tsgit's MERGE_HAS_CONFLICTS paths, git stderr `error: could not write index\n`, tsgit code
   MERGE_HAS_CONFLICTS, staleEntries equal between twins and not containing keep, inode changed in both,
   `ls-files -s` equal. Fails: tsgit throws OPERATION_IN_PROGRESS.
6. GREEN — reorder stashApply as in Context. Steps 1-5 pass.
7. GUARD (stash.test.ts, stashApply) — Given an empty stack and a drifted bystander, When stash apply runs,
   Then it refuses STASH_NOT_FOUND { index: 0, stackSize: 0 } and the index bytes are unchanged
   (`ctx.fs.read('.git/index')` before/after). Passes because resolveStashEntry runs before the refresh; it
   pins git's order (A.1 DL rows: no stash ⇒ index inode kept).
8. GUARD — existing rows in stash-unmerged-index.test.ts (MERGE_HEAD removed) still refuse MERGE_HAS_CONFLICTS
   and keep the stages: the refresh refuses after writing; "index and work tree untouched" in the first `it`
   asserts stages and o's content, both unchanged by a refresh.
9. REFACTOR — none expected; keep stashApply under 20 lines.

### Gate

`PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/stash.test.ts test/unit/application/commands/stash-unmerged-index.test.ts test/unit/application/commands/stash-pool.test.ts test/unit/application/commands/stash-clean-order.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/stash-unmerged-index.test.ts test/integration/stash-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`
then the apply family (conventions), which includes test/integration/stash-interop.test.ts.

### Commit

`fix(stash): refresh and write the index before stash apply as git does`
(size delta ~30–50 B gzip)

## Part 3 — `stash push -u` cleans before its reset and records git's empty untracked tree

### Context

- Requirements R7 (design P6, RC6, F9) and R8 (ADR-1099, RC7, F10). Ordered before the apply parts because the
  `-u` type-swap stashes (DF, DFn, FD, LD) cannot be saved by tsgit today (A.4 S1–S4): push throws after
  saving the stash and resetting, before finishStashReset.
- Edit `src/application/commands/stash.ts`:
  - `resetAfterPush` (823-844): today reads the index, runs materializeTreeJudging (oneway, force,
    forceRewriteAll), commits, THEN removes `untracked.paths` with removeWorkingTreeFile (840-843). git runs
    `clean --force --quiet -d :/` BEFORE `reset --hard` (A.4 trace). Move the `if (opts.includeUntracked === true)`
    removal block (with its existing `// Stryker disable next-line ConditionalExpression` comment, verbatim)
    to the top of resetAfterPush, before readIndex. removeWorkingTreeFile
    (src/application/primitives/internal/write-working-tree-file.ts:350-354) is rmIfExists on one path and
    skips escaped names. After the move: DF's untracked file d is gone before the reset re-creates d/x; FD's
    f/y is removed leaving an empty f/ that the forced oneway reset displaces when it writes file f (git's
    `clean -d` removed f/ itself; the end state is the same — the S3/S4 listing assertion proves it; if the
    reset trips on the empty directory, stop and report a blocker with the error data).
  - `createStashCommits` (741-757): `u` is `[]` when `untracked.paths.length === 0` (750-753). New rule (DC4,
    ADR-1099): write the U commit whenever `opts.includeUntracked === true`, its tree the empty tree when nothing
    was found (synthesizeTreeFromIndex over zero entries yields 4b825dc642cb6eb9a060e54bf8d69288fbee4904);
    `writer.untracked` already writes the parentless commit with subject `untracked files on <branch>: <short> <subject>`.
    hasLocalChanges (528) is unchanged, so `-u` on a clean tree still returns no-local-changes (A.4 E0).
    createAutostash (600-604) passes no includeUntracked: unchanged.
- Edit `test/unit/application/commands/stash.test.ts`: describe('Given untracked files with includeUntracked')
  at 661-684 (3-parent W, U tree content, untracked removed) is the model; add sibling describes under
  describe('stash push') (191). Memory adapter facts: its rm of a non-empty directory throws
  DIRECTORY_NOT_EMPTY, and a walk through a regular file throws NOT_A_DIRECTORY, so both failures reproduce
  in unit tests.
- Edit `test/integration/stash-push-reset-interop.test.ts`: header 1-11 (`@proves` block, `interopSurface:
  stash`); helpers reflogOf, logEntries, origHeadOf, refTail (60-63, 261-282) and the 'stash push ref tail
  interop' suite (289-) with its arrange (buildHistory, settleIndex, user config). Add a describe for the
  `-u` type swaps and one for the U-commit shape. Twin seed for S rows: buildHistory(dir, tracked, tracked)
  with tracked = [regular('d/x','x\n'), regular('n/s/y','y\n'), regular('f','f\n'), symlink('l','keep')]
  (symlink, regular from ./occupant-displacement-fixtures.js), settleIndex, then plant per shape:
  DF rm -r d + write file d; DFn rm -r n + write file n; FD rm f + write f/y; LD rm l + write l/y.
- Read-only references: src/application/primitives/internal/write-working-tree-file.ts:46-59 (rmIfExists).

### TDD steps

1. RED (stash.test.ts, stashPush) — Given a tracked d/x replaced in the work tree by an untracked file d, When
   push runs with includeUntracked, Then it saves (kind 'saved'), the work tree holds d/x with the committed
   content and no file d, and the W commit has 3 parents whose U tree holds d. Fails: removeWorkingTreeFile('d')
   after the reset throws DIRECTORY_NOT_EMPTY.
2. RED (stash-push-reset-interop.test.ts) — A.4 S1–S4: describe.each over DF, DFn, FD, LD: 'Given a tracked
   path swapped for an untracked type' > 'When git and tsgit stash push -u' > 'Then both save, reset the tree
   and write the same ref tail'. git pushes in the peer (`stash push -q -u`, env COMMIT_ENV, exit 0); tsgit runs
   `repo.stash.push({ includeUntracked: true })` in the twin. Assert: listing equal; W, I and U trees equal
   (`rev-parse stash@{0}^{tree}`, `stash@{0}^2^{tree}`, `stash@{0}^3^{tree}`); refTail equal (HEAD reflog
   `reset: moving to HEAD` written by finishStashReset, ORIG_HEAD). Fails: the push throws DIRECTORY_NOT_EMPTY
   (S1, S2) or NOT_A_DIRECTORY (S3, S4) after saving, so no HEAD reflog entry and no ORIG_HEAD.
3. GREEN — move the removal block before the reset in resetAfterPush. Steps 1-2 pass.
4. GUARD (stash.test.ts, stashPush) — Given a tracked f replaced by an untracked f/y, When push -u runs, Then it
   saves and the work tree holds file f again. Passes after step 3 (S3 already proved the RED through the
   interop row).
5. RED (stash.test.ts, stashPush) — Given a tracked edit and no untracked file, When push runs with
   includeUntracked, Then W has 3 parents, parent 3 is a parentless commit whose tree is the empty tree and
   whose message starts `untracked files on main: `. Fails: W has 2 parents (createStashCommits skips U).
6. RED (stash-push-reset-interop.test.ts) — A.4 E1 (edited f) and E2 (staged edit of f): 'When git and tsgit
   stash push -u' > 'Then the W commit has three parents and an empty untracked tree as git writes'. Assert per
   twin: `git rev-list --parents -n 1 stash@{0}` has 4 tokens; `git rev-parse stash@{0}^3^{tree}` is
   4b825dc642cb6eb9a060e54bf8d69288fbee4904; `git rev-list --parents -n 1 stash@{0}^3` has 1 token;
   `git log -1 --format=%s stash@{0}^3` equal between twins (buildHistory gives equal base ids, so the short id
   agrees). Fails: tsgit's W has 3 tokens and no third parent.
7. GREEN — createStashCommits writes U whenever includeUntracked is true.
8. GUARD (stash.test.ts + interop A.4 E0) — Given a clean tree, When push -u runs, Then no-local-changes and no
   refs/stash in either twin. Passes: hasLocalChanges is unchanged.
9. GUARD — the existing row at stash.test.ts:661-684 (3-parent W with new.txt) and the existing '-u' variants of
   PUSH_VARIANTS / REF_TAIL_VARIANTS stay green.
10. REFACTOR — none expected.

### Gate

`PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/stash.test.ts test/unit/application/commands/stash-pool.test.ts test/unit/application/commands/stash-clean-order.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/stash-push-reset-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`
then the push family AND the apply family (conventions): createAutostash shares resetAfterPush and the U rule.

### Commit

`fix(stash): clean untracked paths before the push reset and record git's empty untracked tree`
(size delta ~10–30 B gzip)

## Part 4 — no merge when the stash tree equals its base; the type-change interop suite

### Context

- Requirement R6 (design P5, RC5, F8) and the bulk of R1/R11's A.1 pins. git's stash goes through the
  non-recursive merge-ort entry point, which returns early ("Already up to date.") when the merge base equals
  theirs: no merge, no AUTO_MERGE; the index step then runs as for a clean merge. tsgit always calls
  applyMergeToWorktree, which writes AUTO_MERGE on every clean merge
  (src/application/primitives/apply-merge-to-worktree.ts:551).
- Edit `src/application/commands/stash.ts`:
  - `mergeStash` (1079-1098) returns ApplyMergeResult minus would-overwrite (it throws on that kind today).
    Introduce a stash-local, non-exported result:
    StashMerge = { kind: 'clean'; newIndexEntries: ReadonlyArray<IndexEntry> } | the conflict variant of
    ApplyMergeResult (ApplyMergeResult is at apply-merge-to-worktree.ts:106-124; its clean variant carries
    mergedTree, indexTree and result: MaterializeTreeResult — the stash only reads result.newIndexEntries).
    In mergeStash, before applyMergeToWorktree: if trees.wTree === trees.bTree return
    `unchangedMerge(trees.currentIndex)` = { kind: 'clean', newIndexEntries: currentIndex.entries }; otherwise
    map the clean result to { kind: 'clean', newIndexEntries: result.result.newIndexEntries }.
  - `applyUnderLock` (1038-1067): replace `result.result.newIndexEntries` with `result.newIndexEntries`. The
    index step is unchanged: restoreIndex + hasStagedChanges → reinstateIndex, else unstageChangesUnlessNew +
    lock.commit; with W = B, unstageChangesUnlessNew(current, current) restores nothing.
  - Do NOT touch applyMergeToWorktree (shared by cherry-pick, revert, rebase; their W = parent case is not
    probed).
- Edit `test/unit/application/commands/stash.test.ts`: add under describe('stash apply') (896). A W = base
  stash on the memory adapter: tracked f replaced by a directory f/y, plain push (the W tree keeps f's index
  entry, so W = base; A.1 FD plain). AUTO_MERGE lives at `${ctx.layout.gitDir}/AUTO_MERGE`.
- Create `test/integration/stash-apply-type-change-interop.test.ts`. Header, copied in form from
  test/integration/stash-push-reset-interop.test.ts:1-11:
  a JSDoc paragraph (cross-tool interop — stash apply and pop over directory, file and symlink swaps), then
  `@proves` with `surface: repo.stash.apply`, `bucket: cross-tool-interop`, `unique: stash apply and pop
  leave the work tree, index, refs and state files git leaves across type swaps`, `interopSurface: stash`.
  Harness (shared by Parts 4, 6, 7, keep it table-driven):
  - Seed both twins: `runGit(['init','-q','-b','main',dir])`, user.name/user.email config,
    buildHistory(dir, BASE, BASE) with BASE = [regular('d/x','x\n'), regular('n/s/y','y\n'),
    regular('f','f\n'), symlink('l','keep')] (KEEP is added by buildHistory).
  - SHAPES (plant + optional `git add -A` for the 'a' variants): DF rm -r d, file d; DFn rm -r n, file n; FD rm
    f, file f/y; DL rm -r d, link d → keep; LD rm l, file l/y; LF rm l, file l; FL rm f, link f → keep; and
    DFa, DFna, FDa, DLa, LDa, LFa, FLa.
  - PUSH: plain [] / {}, '-u' ['-u'] / { includeUntracked: true }, '--keep-index' ['--keep-index'] /
    { keepIndex: true } (same table shape as PUSH_VARIANTS in stash-push-reset-interop.test.ts:98-102).
  - pushedBy: 'each' (git in the peer, tsgit `stashPush` / `repo.stash.push` in the twin — when both saved, assert W, I, U
    trees equal and parent counts equal) or 'git' (git pushes in both; A.2 and A.3 rows).
  - After the push: settleIndex(dir) in both (back-dates tracked files, `update-index --refresh`), plant the
    post state (A.1: none), touchedAt('keep'), record the index inode.
  - COMMANDS: apply, apply --index, pop, pop --index ↔ stashApply/stashPop with { restoreIndex } via
    `createNodeContext({ workDir: pair.ours })` or `openRepository({ cwd })` (`const sut = …`). Run git with
    tryRunGitWithExit(['-C', peer, 'stash', ...]) (env COMMIT_ENV).
  - Row shape `{ shape, push, post, command, git: { exit, autoMerge } }`; the `git` field is Appendix A's pin
    and is asserted against the peer first (lesson 017), then tsgit is compared with the peer.
  - Assertions per row: git exit equals the pin; tsgit outcome agrees (exit 0 ↔ result kind 'applied'; exit 1
    ↔ an error whose code the row names); listing, indexState, flagListing equal; staleEntries equal; AUTO_MERGE
    presence equals the pin in both; refs/stash reflog line count equal (0 when absent); "index inode changed"
    equal.
  - Fixtures (read-only): test/integration/interop-helpers.ts — GIT_AVAILABLE 301, runGit 177, git 352,
    makePeerPair 333, tryRunGitWithExit 430, lsStage 384; test/integration/occupant-displacement-fixtures.ts —
    COMMIT_ENV 28, regular 44, symlink 49, KEEP 88, buildHistory 91, emptyDirectoryAt 115, fileAt 120,
    danglingLinkAt 126, directoryHolding 130, ignoring 173, fileWith 181, touchedAt 191, linkAt 201,
    settleIndex 257, staleEntries 326, flagListing 356, Outcome 358, outcomeOfGitStderr 382, listing 430,
    indexState 441. Per-row timeout as stash-apply-index-interop.test.ts (ROW_TIMEOUT_MS 60_000).

### TDD steps

1. RED (stash.test.ts, stashApply) — Given a stash whose work tree equals its base (f replaced by a directory
   f/y, plain push), When stash apply runs, Then it returns 'applied', writes no AUTO_MERGE and leaves the index
   entries as they were (paths and ids). Fails: applyMergeToWorktree writes AUTO_MERGE.
2. RED (stash-apply-type-change-interop.test.ts) — create the suite with the A.1 rows whose git pin is W = base:
   FD and LD × {plain, --keep-index} × the 4 commands, pushedBy 'each', git { exit: 0, autoMerge: false }. Fail:
   tsgit writes AUTO_MERGE.
3. GREEN — unchangedMerge early return in mergeStash, StashMerge type, applyUnderLock reads newIndexEntries.
4. PIN, then GUARD (stash.test.ts) — the design did not probe a staged I ≠ B under W = B, so pin it first in a
   mktemp throwaway against git 2.55 (same isolation as Part 8 step 1): commit a, stage a = 'staged', rewrite
   the work file a to the committed bytes, `stash push -q`, `stash apply --index -q`, record exit and
   `ls-files -s`. If git reinstates the staged blob, write the GUARD: Given that stash, When apply runs with
   restoreIndex, Then the index holds the staged blob for a and the work file keeps the committed bytes (passes:
   the index step is untouched and hasStagedChanges holds). If git differs, write no test, change nothing, and
   put an IMPACT line with the pin in the final report.
5. GUARD (interop) — the remaining A.1 rows that are SAME once Parts 2-3 landed, pushedBy 'each', × the 4
   commands, each pinned from A.1: DF, DFn × {plain, --keep-index} (exit 0, autoMerge true); DFa, DFna, FDa,
   LDa, LF, LFa, FL, FLa × {plain, -u, --keep-index} (exit 0, autoMerge true); DL, DLa × all pushes (both pushes
   refuse — git exit 1 `error: 'd/x' is beyond a symbolic link`, tsgit PATHSPEC_BEYOND_SYMLINK; then apply/pop
   git exit 1, tsgit STASH_NOT_FOUND; autoMerge false; inode kept in both — R5's no-stash order). Plus A.2
   DFa × {empty-de, ign-du, rm-dx} pushedBy 'git' (post: emptyDirectoryAt('d/e'); ignoring('d/u',
   fileWith('d/u', 'untracked\n')); rm of d/x) → exit 0, d a file. They pass because Part 2 refreshed `keep`
   and Part 3 fixed the `-u` U tree (LF/FL × -u carry an empty U tree, A.4 E). Any failure here is a finding:
   stop and report back with the row and the diff.
6. REFACTOR — keep mergeStash and the harness helpers under 20 lines each.

### Gate

`PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/stash.test.ts test/unit/application/commands/stash-unmerged-index.test.ts test/integration/stash-apply-type-change-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/stash-apply-type-change-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`
then the apply family (now including the new suite).

### Commit

`fix(stash): skip the merge and AUTO_MERGE when the stash tree equals its base`
(size delta ~40–70 B gzip)

## Part 5 — the STASH_UNTRACKED_NOT_RESTORED error

### Context

- ADR-1096 (DC1, user-ratified option 1). A clean merge whose untracked restore left something unwritten
  throws STASH_UNTRACKED_NOT_RESTORED { existing, blockedAt? }: existing = every path that already existed,
  in index order; blockedAt = the leading component git names when the restore stopped. Its caller lands in
  Part 6; this part is the public surface alone so Part 6 fits its file budget. knip counts test files as
  entries (knip.json `vitest` plugin), so a constructor exercised only by error.test.ts passes check:dead-code.
- Edit `src/domain/commands/error.ts`:
  - New exported interface beside WouldOverwriteClasses (581-590), with a TSDoc saying what git prints from it:
    UntrackedNotRestored { readonly existing: ReadonlyArray<FilePath>; readonly blockedAt?: FilePath }.
  - Union member after STASH_APPLY_WOULD_OVERWRITE (line 451):
    { readonly code: 'STASH_UNTRACKED_NOT_RESTORED'; readonly existing: ReadonlyArray<FilePath>; readonly blockedAt?: FilePath }
    (flat fields, as ADR-1096 states; TSDoc on each field).
  - Constructor after stashApplyWouldOverwrite (1395-1396), extend the stash comment block (1385-1389):
    stashUntrackedNotRestored(report: UntrackedNotRestored): TsgitError, building blockedAt with a
    conditional spread.
- Edit `src/domain/error.ts`: message case after 'STASH_APPLY_WOULD_OVERWRITE' (739-740), wording only
  (ADR-249): `could not restore untracked files from stash`.
- Edit `test/unit/domain/exhaustiveness.ts`: add `case 'STASH_UNTRACKED_NOT_RESTORED':` after line 238.
- Edit `test/unit/domain/commands/error.test.ts`: import list (97), helper describe after the
  stashApplyWouldOverwrite one (192-202), message table rows near 1983-1985.
- Regenerate `reports/api.json` with `npm run docs:json` and stage it.

### TDD steps

1. RED (error.test.ts, stashUntrackedNotRestored) — 'Given the stashUntrackedNotRestored error helper' > 'When
   called with existing paths and a blocking component' > 'Then data carries both'; and a second `it` for a
   report without blockedAt → data has no blockedAt key (`toEqual` exact, which fails on a key set to
   undefined). Fails: the helper is not exported (type error / undefined import).
2. RED (error.test.ts, message table) — rows `{ code: 'STASH_UNTRACKED_NOT_RESTORED', existing: ['u'] }` and
   one with blockedAt → 'STASH_UNTRACKED_NOT_RESTORED: could not restore untracked files from stash'. Fails:
   the code is not in the union.
3. GREEN — interface, union member, constructor, message case, exhaustiveness case.
4. REFACTOR — none. Regenerate reports/api.json last (see Gate).

### Gate

`PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/commands/error.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/commands/error.ts src/domain/error.ts test/unit/domain/exhaustiveness.ts test/unit/domain/commands/error.test.ts && npm run check:spelling && npm run check:test-pyramid && npm run check:dead-code`
then, as the last step before staging, `npm run docs:json` and stage reports/api.json with the part's files.

### Commit

`fix(stash): add the STASH_UNTRACKED_NOT_RESTORED error`
(size delta ~60–90 B gzip; reports/api.json staged in this commit)

## Part 6 — restore untracked files after the merge with git's checkout-index rules

### Context

- Requirements R2 (clean-merge half), R3, R4 (design P3 first half + P4, RC1, RC3, F2, F4, F5, F6). git
  merges first, then restores the stash's untracked tree with `read-tree <u_tree>` + `checkout-index --all`
  (no --force) on a temporary index (A.4 trace). Per entry, in index order:
  1. a leading component that lstat finds and that is not a directory (regular file, any symlink — to a
     file, to a directory, dangling) → `fatal: cannot create directory at '<component>': File exists`: the
     restore STOPS there, the component is kept, earlier entries stay written, later ones are not;
  2. else lstat of the path finds anything (file, directory, empty directory, symlink, dangling symlink) →
     `<path> already exists, no checkout`: not written, recorded, the restore continues;
  3. else written (leading directories created).
  Any report → exit 1 after the merge's index and work tree are written; pop keeps the stash.
- Edit `src/application/commands/stash.ts`:
  - `applyUnderLock` (1038-1067): delete the pre-merge `refuseUntrackedOverwrites` call (1046); keep the restore
    after the clean index commit (1065) and turn it into: `const restore = await restoreUntracked(ctx, uTree)`;
    if it reported anything (`existing.length > 0 || blockedAt !== undefined`) throw
    stashUntrackedNotRestored(restore), else return applied. Conflict and would-overwrite branches are unchanged
    in this part (Part 7).
  - Delete `refuseUntrackedOverwrites` (1069-1076) and `untrackedOverwrites` (881-893). Keep the pathIsOccupied
    import (73): the `exists` verdict reuses it (no-follow presence probe; reads NOT_A_DIRECTORY and
    FILE_NOT_FOUND as absent — src/application/primitives/internal/path-occupied.ts:42-46).
  - `restoreUntracked` (912-931) returns `Promise<UntrackedNotRestored>` (import the type and
    stashUntrackedNotRestored from ../../domain/commands/error.js, where Part 5 put them). Keep the whole-tree
    name gate (validateTreePath loop) first and unchanged. Then, per entry of the flattened U tree (Map order
    = index order for full paths):
    - escaped (lossy) names: keep today's rule — writer.writeBlob skips them (hasEscapedBytes); give them no
      verdict (the unit row at stash.test.ts:1207 must stay green);
    - verdict via a stash-local `RestoreVerdict = { kind: 'free' } | { kind: 'exists' } | { kind: 'blocked'; at: FilePath }`:
      blocked ← `scanner.obstructingLeadingComponent(path)` (the scanner the restore already creates,
      createLeadingPathScanner, src/application/primitives/internal/symlinked-leading-path.ts:64; its
      obstructingLeadingComponent at :165-183 is git's check_leading_path — the first leading component that is
      a symlink OR a regular file, LeadingObstruction { path, kind } at :18-21, memoised per directory). This
      supersedes the design's "own walk for the file half": the scanner already classifies a leading regular
      file as kind 'file'. blockedAt = obstruction.path (the component, e.g. m, not m/z).
      exists ← pathIsOccupied(ctx, joinPath(workDir, path)).
      free → writer.writeBlob(path, id, mode, scanner) + forgetAfterLink(scanner, [mode]) as today.
    - blocked stops the loop; exists appends and continues. A free verdict guarantees no leading symlink or file,
      so the writer's unlinkSymlinkedLeadingComponent (write-working-tree-file.ts:94/:340) finds nothing to
      displace; a leading directory created by an earlier entry is a real directory (the scanner's memo is
      invalidated by the write's unlink step, symlinked-leading-path.ts:193-215, forgetPrefix at :208).
  - restoreUntracked needs workDir: StashApplication already carries it.
  - pop: stashPop drops only on 'applied' (1113-1114), so a thrown STASH_UNTRACKED_NOT_RESTORED keeps the stash
    with no pop change.
- Edit `test/unit/application/commands/stash.test.ts`: the it.each at 1036-1101 ('Given content already present
  at the stashed path') holds a tracked-dirty row (stays STASH_APPLY_WOULD_OVERWRITE) and two untracked rows
  (dangling symlink at 1052-1063, untracked file at 1064-1075) that move to the new code
  ({ code: 'STASH_UNTRACKED_NOT_RESTORED', existing: ['new.txt'] }) — split them into their own it.each since
  the expected code differs. The '-u' apply rows live at 1105-1160; pushHostileUntrackedStash (104) builds a W
  with an arbitrary U tree (useful for a link-to-directory or dangling-link leading component, which stashPush
  cannot produce directly). pop rows at 1411-1465.
- Edit `test/integration/stash-apply-type-change-interop.test.ts` (Part 4's harness): add the rows below.
  Stderr rebuild helper for restore failures (ADR-1096): one line "<p> already exists, no checkout" per path of
  existing, then, when blockedAt is set, "fatal: cannot create directory at '<blockedAt>': File exists", then
  "error: could not restore untracked files from stash" (each newline-terminated); assert git's stderr ENDS WITH
  that string (git prints merge output before it).
- Edit `test/integration/stash-interop.test.ts`: the dangling-symlink pop row (203-231) expects
  STASH_APPLY_WOULD_OVERWRITE today; it becomes STASH_UNTRACKED_NOT_RESTORED with existing ['u.txt'], stash kept
  on both, and git's stderr rebuilt (`u.txt already exists, no checkout` …).
- Untracked shapes for the new rows (A.3, pushedBy 'git'): FU = f edited ('f2\n') + untracked u; UP = f edited
  + untracked a, m/z, u, z; both pushed with `-u`. Post planters: untr-u fileWith('u','other\n'); emptydir-u
  emptyDirectoryAt('u') after removing nothing (u is absent after the push); file-m fileAt('m'); link-m
  linkAt('m','keep'); linked-dir-m linkAt('m','d'); dangling-m danglingLinkAt('m'); file-m-untr-u both.
  A.2 posts on DF-u (pushedBy 'git'): untr-du fileWith('d/u','untracked\n'); empty-de emptyDirectoryAt('d/e');
  ign-du ignoring('d/u', fileWith('d/u','untracked\n')); rm-dx rm of d/x.

### TDD steps

1. RED (stash.test.ts, stashApply) — it.each over a leading component m that is a regular file, a link to a
   file, a link to a directory, a dangling link (untracked a, m/z, u, z stashed with -u, then m planted; or a U
   tree built with pushHostileUntrackedStash): 'Then it throws STASH_UNTRACKED_NOT_RESTORED { existing: [],
   blockedAt: 'm' }, a is restored, m is kept as it was (lstat kind and link target), m/z, u and z are not
   written'. The pre-merge check does not fire here (it reads a path under a file or a link as absent), so the
   failure is the restore's: the file case throws the adapter's raw NOT_A_DIRECTORY; the link cases replace m
   with a directory and return 'applied'.
2. RED (stash.test.ts, stashPop) — Given a link at m to a directory, When pop runs, Then it throws the new code
   and the stash is kept (stashList length 1). Fails: pop returns 'applied' and drops it.
3. RED (interop, before step 4) — A.3 UP × file-m, link-m, linked-dir-m, dangling-m (pushedBy 'git', apply and
   pop; git exit 1, stderr ends with the rebuilt fatal + error lines, a restored, m kept) and A.1 FD × -u, LD × -u
   (pushedBy 'each', × 4 commands; git exit 1; blockedAt f / l; autoMerge false since W = base; pop keeps the
   stash). Fail: raw NOT_A_DIRECTORY carrying an absolute path (file-m, FD-u) or 'applied' with the link
   replaced by a directory (link rows, LD-u).
4. GREEN — RestoreVerdict with the blocked arm (blocked → stop; otherwise write), restoreUntracked returns the
   report, applyUnderLock throws stashUntrackedNotRestored on a non-empty report.
5. RED (stash.test.ts, stashApply) — Given a tracked d/x replaced by an untracked file d, pushed with -u, When
   apply runs on the reset tree, Then it returns 'applied', d/x is deleted and d is a file with the stashed
   content. Fails: the pre-merge check finds directory d occupied and throws STASH_APPLY_WOULD_OVERWRITE
   { paths: ['d'] }.
6. RED (interop) — A.1 DF × -u and DFn × -u (pushedBy 'each', × 4 commands, exit 0, autoMerge true; file d / n
   restored, ` D d/x`, `?? d`), A.2 DF-u × rm-dx (pushedBy 'git', exit 0, empty d removed, file d restored) and
   A.3 UP × file-m-untr-u (exit 1, the fatal for m only: the restore stops before u, so existing is empty). Fail:
   the pre-merge check throws STASH_APPLY_WOULD_OVERWRITE (['d'], ['n'], ['u']).
7. RED (stash.test.ts, stashApply) — Given untracked a, m/z, u, z stashed with -u and u recreated with other
   content, When apply runs, Then it throws STASH_UNTRACKED_NOT_RESTORED { existing: ['u'] } (no blockedAt key),
   a, m/z and z are restored, u keeps 'other', and the tracked edit is applied. In the same step, reshape the
   it.each at 1036-1101: its two untracked rows (dangling link at new.txt, untracked file at new.txt) move to a
   sibling it.each expecting { code: 'STASH_UNTRACKED_NOT_RESTORED', existing: ['new.txt'] } and the link /
   content kept; and update the stash-interop.test.ts dangling pop row (203-231) to the new code with existing
   ['u.txt'], stash kept on both, git stderr ending with the rebuilt lines. Fails today: the pre-merge check
   throws STASH_APPLY_WOULD_OVERWRITE { paths: ['u'] } (resp. ['new.txt'], ['u.txt']).
8. RED (interop) — A.3 FU × untr-u, UP × untr-u, UP × emptydir-u, A.2 DF-u × untr-du, empty-de, ign-du (pushedBy
   'git', apply and pop; git exit 1; merge applied — ` M f` resp. d/x deleted, AUTO_MERGE written — then
   existing ['u'] resp. ['d']; the stash kept on pop). Fail: STASH_APPLY_WOULD_OVERWRITE before the merge.
9. GREEN — delete refuseUntrackedOverwrites, untrackedOverwrites and their call; add the exists arm
   (pathIsOccupied) to the verdict. Steps 5-8 pass. If DF-u × rm-dx then fails only because an empty d/ survives
   the merge, stop and report a blocker with the listing diff (that deletion lives in the shared materializeTree primitive).
10. GUARD (stash.test.ts) — it.each of exists shapes at u: a directory holding a file, an empty directory, a
    dangling link, with a second existing path later in index order (existing lists both, in order; later free
    entries still written). Passes: pathIsOccupied is a no-follow lstat probe and the loop continues on exists.
11. GUARD (stash.test.ts) — Given U entries m/y and m/z with no m on disk, Then both are restored (a leading
    directory created by an earlier entry is not blocked). Passes: the write's unlink step invalidates the
    scanner's memo for the missing prefix.
12. GUARD — stash.test.ts:1207 (lossy name), :1242 (hostile name refuses INVALID_INDEX_ENTRY before any write),
    :1314 and :1370 stay green: the name gate and the escaped-name skip are unchanged.
13. REFACTOR — restoreUntracked split into the verdict and the loop, each under 20 lines.

### Gate

`PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/stash.test.ts test/unit/application/commands/stash-unmerged-index.test.ts test/integration/stash-apply-type-change-interop.test.ts test/integration/stash-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/stash-apply-type-change-interop.test.ts test/integration/stash-interop.test.ts && npm run check:spelling && npm run check:test-pyramid && npm run check:dead-code`
then the apply family.

### Commit

`fix(stash): restore untracked files after the merge with git's checkout-index rules`
(size delta ~90–190 B gzip: verdict and report ~150–250 B, minus ~60 B for the deleted pre-check)

## Part 7 — a merge refusal or conflict still restores untracked files; refusal keeps git's two classes

### Context

- Requirements R2 (refusal and conflict halves), R4 (DC2), R10 (DC3) — design P3 second half and P7 DC2/DC3;
  ADR-1097 (user-ratified option 1) and ADR-1098 (option 1). git restores the untracked tree after a merge
  refusal and after a conflict, and prints both reports (A.3 FU dirty-f, conflict-f, dirty-f-untr-u,
  conflict-f-untr-u; A.2 DF-u × dirty-dx). Its merge refusal has two classes: "Your local changes to the
  following files would be overwritten by merge" (localChanges) and the untracked header (A.2 DFa × dirty-dx vs
  untr-du). ADR-212 still holds for the tracked merge (its refusal writes no tracked path).
- Edit `src/domain/commands/error.ts`:
  - STASH_APPLY_WOULD_OVERWRITE member (451) gains `localChanges`, `untracked` (ReadonlyArray<FilePath>) and
    `untrackedNotRestored?: UntrackedNotRestored`; `paths` stays as localChanges then untracked (ADR-1098).
  - stashApplyWouldOverwrite (1395-1396) becomes
    `(classes: WouldOverwriteClasses, untrackedNotRestored?: UntrackedNotRestored)`; WouldOverwriteClasses is at
    581-590 in the same file. Optional field via conditional spread; add only when the report is non-empty.
- Edit `src/application/commands/stash.ts`:
  - StashMerge (Part 4) gains the would-overwrite variant of ApplyMergeResult; mergeStash stops throwing.
  - applyUnderLock becomes "merge, settle the index, restore, report" (design P3 sketch):
    merged = mergeStash(…) → settled = settleIndex(ctx, lock, merged, app) (conflict: lock.commit(indexEntries,
    'replace') and the conflict list; clean: today's reinstateIndex / unstageChangesUnlessNew branch;
    would-overwrite: nothing, the lock is released uncommitted — Part 2's refresh is already on disk) →
    restore = uTree === undefined ? NOTHING_RESTORED : restoreUntracked(…) → reportApply(settled, restore, w):
    would-overwrite → throw stashApplyWouldOverwrite({ localChanges, untracked }, restore if non-empty);
    conflict → return { kind: 'conflict', conflicts, …(non-empty ? { untrackedNotRestored: restore } : {}) };
    clean + non-empty → throw stashUntrackedNotRestored(restore); else applied. NOTHING_RESTORED is a named
    constant { existing: [] }.
  - `StashApplyResult` (856-858) and `StashPopResult` (1100-1102): conflict variants gain
    `readonly untrackedNotRestored?: UntrackedNotRestored` (TSDoc: what git printed after the conflict).
    stashPop returns the conflict result unchanged (1113).
  - applyAutostash (979-994): no U parent, so only the merge half applies; it catches TsgitError and logs
    `{ code }` (test/unit/application/commands/stash-unmerged-index.test.ts:175 stays green).
- Edit `test/unit/domain/commands/error.test.ts`: stashApplyWouldOverwrite helper test (192-202) and the
  message table row (1983-1985) take the new data shape.
- Edit `test/unit/application/commands/stash.test.ts`: the tracked-dirty row of the it.each at 1036-1101 asserts
  the full data `{ code, paths: ['a.txt'], localChanges: ['a.txt'], untracked: [] }`; new rows below.
  pop conflict rows at 1431-1465.
- Edit `test/integration/stash-apply-type-change-interop.test.ts`: rows below. Class check: compare
  `{ localChanges, untracked }` of tsgit's data with outcomeOfGitStderr(git.stderr) (fixtures :382; its
  UNTRACKED_HEADER also matches the trailing "could not restore untracked files" line but no tab line follows,
  so it adds nothing).
- Regenerate `reports/api.json` (`npm run docs:json`) and stage it.
- test/integration/stash-interop.test.ts runTsgitStash (518-534) reads `data.paths`: unchanged and still valid.

### TDD steps

1. RED (error.test.ts, stashApplyWouldOverwrite) — data carries localChanges, untracked, paths = their
   concatenation; a second `it` with a restore report carries untrackedNotRestored; without one the key is
   absent. Fails: the helper takes a path list.
2. RED (stash.test.ts, stashApply) — Given a staged dir→file stash (DFa) and d/x edited, Then
   STASH_APPLY_WOULD_OVERWRITE { paths: ['d/x'], localChanges: ['d/x'], untracked: [] }; Given an untracked d/u
   instead, Then { paths: ['d'], localChanges: [], untracked: ['d'] }. Fails: data has paths only.
3. RED (interop) — A.2 DFa × dirty-dx and DFa × untr-du (pushedBy 'git', 4 commands; git exit 1; classes equal
   to outcomeOfGitStderr; work tree and index unchanged apart from the refresh). Fail: the classes are absent.
4. GREEN — data shape and constructor; mergeStash passes the two lists (still throwing at this step).
5. RED (stash.test.ts, stashApply) — Given an f-edit + untracked u stash (-u) and f edited again (FU dirty-f),
   Then it throws STASH_APPLY_WOULD_OVERWRITE { localChanges: ['f'] …} AND u is restored with the stashed
   content, the stash kept on pop. Fails: the throw leaves before the restore.
6. RED (stash.test.ts, stashApply) — Given FU with f committed as c after the push (conflict-f), Then it returns
   { kind: 'conflict' } with f's conflict, no untrackedNotRestored key, and u restored. Fails: the conflict
   branch returns before the restore.
7. RED (interop) — A.3 FU × dirty-f (exit 1, local-changes block, u restored) and FU × conflict-f (exit 1, UU f
   markers, u restored, autoMerge as the peer shows — A.3 says AUTO_MERGE present). Fail as steps 5-6.
8. GREEN — StashMerge with would-overwrite, settleIndex, reportApply; the restore runs after every merge outcome.
9. RED (stash.test.ts) — FU dirty-f-untr-u: the refusal's data carries untrackedNotRestored { existing: ['u'] };
   FU conflict-f-untr-u: the conflict result carries untrackedNotRestored { existing: ['u'] } (stashApply and
   stashPop; pop keeps the stash). Fails: the fields are not set.
10. RED (interop) — A.3 FU × dirty-f-untr-u, FU × conflict-f-untr-u, A.2 DF-u × dirty-dx (pushedBy 'git'; exit 1;
    git stderr = merge block then `u already exists, no checkout` / `d already exists, no checkout` then the
    error line; rebuild the restore suffix from untrackedNotRestored). Fail: the field is absent.
11. GREEN — reportApply attaches the non-empty report to the refusal and to the conflict result; regenerate
    reports/api.json.
12. GUARD — stash-unmerged-index.test.ts autostash rows (:140-176) and every MERGE_FAMILY_ROWS stash row in
    stash-interop.test.ts stay green (autostash and tracked-only refusals are unchanged in kind).
13. REFACTOR — applyUnderLock, settleIndex, reportApply each under 20 lines, nesting ≤ 2.

### Gate

`PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/commands/error.test.ts test/unit/application/commands/stash.test.ts test/unit/application/commands/stash-unmerged-index.test.ts test/integration/stash-apply-type-change-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/commands/error.ts src/application/commands/stash.ts test/unit/domain/commands/error.test.ts test/unit/application/commands/stash.test.ts test/integration/stash-apply-type-change-interop.test.ts && npm run check:spelling && npm run check:test-pyramid && npm run check:dead-code`
then the apply family, then, as the last step before staging, `npm run docs:json` and stage reports/api.json
with the part's files.

### Commit

`fix(stash): restore untracked files after a refused or conflicted stash merge and keep git's refusal classes`
(size delta ~60–120 B gzip; reports/api.json staged in this commit)

## Part 8 — `stash apply` / `pop` run during a pending operation

### Context

- Requirement R9 (ADR-1100, DC5, RC8, F11). git applies a stash while MERGE_HEAD, CHERRY_PICK_HEAD,
  REVERT_HEAD or REBASE_HEAD stands and keeps the marker (A.5 P1–P5); an unmerged index is already refused by
  Part 2's refresh (MERGE_HAS_CONFLICTS). ADR-1100's precondition: pin one real resolved cherry-pick and one real
  stopped rebase first; if either disagrees with the planted-marker rows, STOP — no code change, hand back a
  blocker `{ unit: 'Part 8', reason, options }`.
- Edit `src/application/commands/stash.ts`: remove `await assertNoPendingOperation(ctx)` from stashApply (moved
  after the refresh by Part 2) and `assertNoPendingOperation` from the repo-state import (82). Its 22 other
  callers in src are unchanged (src/application/primitives/internal/repo-state.ts:482-497, PENDING_MARKERS
  459-467).
- Edit `test/unit/application/commands/stash.test.ts`: new describe under describe('stash apply').
  Markers on the memory adapter: write `${gitDir}/MERGE_HEAD` (a file) and the root refs
  `${gitDir}/CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, each holding the HEAD oid + '\n' (headId helper).
- Edit `test/integration/stash-interop.test.ts`: pending-operation rows (planted and real), comparing exit /
  result kind, listing, indexState, and the marker files' presence in both twins.

### TDD steps

1. PIN (before any code; state-mutating, so in a throwaway, never the worktree). In one Bash call:
   ```bash
   G=$(mktemp -d) && [ -n "$G" ] && [ -d "$G" ] || exit 1
   H="$G/home"; mkdir -p "$H"
   run() { env -i PATH="$HOME/.local/git-2.55.0/bin:/usr/bin:/bin" HOME="$H" GIT_CONFIG_NOSYSTEM=1 git "$@"; }
   run --version   # must print: git version 2.55.0
   run config --global user.name Ada; run config --global user.email ada@example.com
   run config --global commit.gpgsign false; run config --global init.defaultBranch main
   R="$G/cp"; run init -q "$R"; [ -n "$R" ] && [ -d "$R/.git" ] && cd "$R" || exit 1
   # base: keep, f, s → side: f=side → main: f=main; stash an edit of s; cherry-pick side (conflict);
   # resolve f, `add f`; CHERRY_PICK_HEAD present → `stash apply`: record exit, s content, marker kept, ls-files -s
   R2="$G/rb"; …same seed…; `rebase side` from a branch whose commit conflicts on f; resolve, `add f`;
   # .git/rebase-merge present → `stash apply`: record exit, s content, rebase-merge/ and REBASE_HEAD kept
   ```
   Expected (agreeing with A.5 P2–P5): exit 0, s = stashed content, the marker kept. Write the observed exit,
   stdout, stderr and marker presence into the final report. Disagreement → blocker, stop here.
2. RED (stash.test.ts, stashApply) — it.each over MERGE_HEAD, CHERRY_PICK_HEAD, REVERT_HEAD, REBASE_HEAD
   planted at HEAD with a stashed edit of a.txt: 'Then it applies and the marker stays'. Fails:
   OPERATION_IN_PROGRESS { operation: 'merge' | 'cherry-pick' | 'revert' | 'rebase' }.
3. RED (stash.test.ts, stashPop) — one row (CHERRY_PICK_HEAD): pop applies, drops the stash, marker kept. Fails
   the same way.
4. RED (stash-interop.test.ts) — A.5 P2–P5 planted rows (git and tsgit both apply, marker kept, listing and
   indexState equal) and A.5 P1 (real resolved merge: `merge --no-commit` of a side adding f, then the stashed
   edit of keep applies; MERGE_HEAD, MERGE_MODE, MERGE_MSG kept in both). Fail: tsgit refuses
   OPERATION_IN_PROGRESS.
5. RED (stash-interop.test.ts) — the two pinned shapes from step 1 (resolved cherry-pick with
   CHERRY_PICK_HEAD; stopped rebase with rebase-merge/), built in both twins with git, applied by each tool.
   Fail: OPERATION_IN_PROGRESS.
6. GREEN — remove the gate call and its import.
7. GUARD — stash-unmerged-index.test.ts step-4 row from Part 2 (MERGE_HEAD + unmerged index →
   MERGE_HAS_CONFLICTS) stays green: the refresh refuses first.
8. REFACTOR — none.

### Gate

`PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/stash.test.ts test/unit/application/commands/stash-unmerged-index.test.ts test/integration/stash-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/stash.ts test/unit/application/commands/stash.test.ts test/integration/stash-interop.test.ts && npm run check:spelling && npm run check:test-pyramid`
then the apply family.

### Commit

`fix(stash): apply and pop during a pending operation as git does`
(size delta about −20 B gzip)

## Requirement map

| Req | Parts |
|---|---|
| R1 dir↔file / dir↔symlink apply and pop end as git leaves them | 1 (DFa guard), 4 (A.1 non-`-u` rows), 6 (DF/DFn/FD/LD × `-u`) |
| R2 untracked restored after the merge, whatever its outcome | 6 (clean), 7 (refusal, conflict) |
| R3 checkout-index verdicts | 6 |
| R4 a restore report fails the command after the merge; pop keeps the stash | 5 (code), 6 (throw, pop), 7 (on refusal and conflict) |
| R5 opening refresh, its order, unmerged and no-stash cases | 2 (pinned again by every row of 4, 6, 7) |
| R6 W = base runs no merge, writes no AUTO_MERGE | 4 |
| R7 push `-u` cleans before its reset | 3 |
| R8 push `-u` writes the empty-tree U commit | 3 |
| R9 no pending-operation gate | 8 (after the ADR-1100 pin) |
| R10 two refusal classes | 7 |
| R11 SAME rows stay SAME, DIFF rows become SAME | 4 (SAME guards incl. DL/DLa, DFa, FDa, LDa, LF, FL), 6, 7; every part runs the apply family |

## Decision candidates

Choices the design and ADRs do not settle; each part assumes the recommendation.

| # | Choice | Alternatives | Recommendation | Why |
|---|---|---|---|---|
| PC-A | Leading-component probe for the `blocked` verdict | (a) the scanner's existing obstructingLeadingComponent (symlink or regular file, memoised); (b) a new per-restore lstat walk as the design sketched; (c) classifyBeneathObstruction from occupant-clash.ts | (a) | It is git's check_leading_path already (added by #331 after the design's survey of the scanner's symlink half), shares the restore's memo, and its verdict for a file, a link to a file, a link to a directory and a dangling link is 'blocked', matching A.3. (b) duplicates it; (c) answers verify_uptodate's question, not checkout-index's (lesson 019). |
| PC-B | Where the DC1 error surface lands | (a) its own Part 5 before its caller; (b) inside Part 6 | (a) | Part 6 would touch 8 files with the four surface-gate files and api.json. knip counts tests as entries, so the constructor is not dead between the parts. |
| PC-C | `UntrackedNotRestored` barrel export | (a) not barrelled, like WouldOverwriteClasses; (b) re-export from stash.ts and src/application/commands/index.ts | (a) | House precedent for error-data shapes; typedoc renders it from the public result and error types. (b) adds a barrel entry nobody asked for. |
| PC-D | Home of the new apply unit rows | (a) test/unit/application/commands/stash.test.ts as the design says; (b) a new sibling stash-untracked-restore.test.ts | (a) | Follows the design and keeps the existing it.each it reshapes in place; the file already holds the apply/pop describes the rows extend. |
| PC-E | Where the pending gate sits between Parts 2 and 8 | (a) after the refresh (Part 2), removed in Part 8; (b) leave it first until Part 8 | (a) | (a) makes A.5 U1 SAME in Part 2 and leaves Part 8 a one-line removal guarded by its pin; (b) keeps U1 red until Part 8. |
