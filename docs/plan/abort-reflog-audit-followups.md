# Plan — abort/reflog audit follow-ups

TDD, one slice = one atomic commit. `npm run validate` green before every commit.
Reflog assertions read the **exact** subject (never "an entry exists"). Two
independent items: merge-abort message (simpler, first), detached-reset routing.

## Slice 1 — `merge --abort` HEAD reflog message (item 2)

**Source:** `src/application/commands/abort-merge.ts:46`.

- **Red.** Flip the existing assertion in
  `test/unit/application/commands/abort-merge.test.ts` (the
  "`Then HEAD records ...`" case, ~L330–347):
  - title → `Then HEAD records 'reset: moving to HEAD' and the branch reflog is left unchanged (no-move skip)`
  - L343 → `expect(sut.at(-1)?.message).toBe('reset: moving to HEAD');`
  - L346 → `expect(branchAfter.at(-1)?.message).not.toBe('reset: moving to HEAD');`
  Run `npx vitest run test/unit/application/commands/abort-merge.test.ts` → fails
  (current message is `merge: aborted`).
- **Green.** Change `abort-merge.ts:46` reflogMessage
  `'merge: aborted'` → `'reset: moving to HEAD'`. Re-run → passes.
- **Validate + commit:** `fix(abort-merge): faithful 'reset: moving to HEAD' HEAD reflog message`.

Note: the branch reflog is already skipped (22.2b no-move gate — the conflicted
merge never moved HEAD, `origHead === tip`); only the coupled-HEAD message changes.

## Slice 2 — merge-abort HEAD reflog parity pin (item 2)

**New file:** `test/integration/merge-abort-interop.test.ts`. Model on
`revert-interop.test.ts`'s lone-abort case (git-built date-pinned seed in **both**
peer and ours; tsgit drives `ours` via `openRepository`).

- Build a conflicting-merge seed via real `git` in both repos (`base` →
  `feature` edits a line → `main` edits the same line), with `COMMIT_ENV`
  date-pinned so SHAs match.
- Capture `topReflogSubject(peer, 'refs/heads/main')` (branch top) and the same on
  `ours`.
- Conflict on both: `git -C peer merge feature` (via `tryRunGit`) /
  `repo.merge({ target: 'feature', author })` (expect `kind === 'conflict'`).
- Abort on both: `git -C peer merge --abort` / `await repo.abortMerge()`.
- **Assert:**
  - `topReflogSubject(ours, 'HEAD')` === `topReflogSubject(peer, 'HEAD')` === `'reset: moving to HEAD'`.
  - branch reflog top **unchanged** on both (no-move skip): equals the captured
    pre-abort branch top on each tool.
- Run → passes (slice 1 already green). Guard `describe.skipIf(!GIT_AVAILABLE)`.
- **Validate + commit:** `test(merge-abort): pin HEAD reflog parity vs git`.

## Slice 3 — detached `reset` routes through `updateRef` (item 1, ADR-227)

**Source:** `src/application/commands/reset.ts` (detached branch, ~L80–82).

- **Red.** Add to `test/unit/application/commands/reset.test.ts` under
  `Given a detached HEAD`:
  1. `When reset is a no-move (target === current detached oid)` →
     `Then no HEAD reflog entry is appended`. Arrange: `seedTwoCommits` (c1, c2,
     HEAD→main→c2), detach via `writeUtf8(HEAD, '${c2}\n')`, capture
     `(await readReflog(ctx, HEAD)).length` and `.at(-1)?.message`; Act:
     `reset(ctx, { mode: 'soft', target: c2 })`; Assert: reflog length **and** top
     message unchanged (no `reset: moving to` appended).
  2. `When reset moves the detached HEAD` →
     `Then HEAD records 'reset: moving to <target>'`. Arrange: detach to c2; Act:
     `reset(ctx, { mode: 'soft', target: c1 })`; Assert:
     `(await readReflog(ctx, HEAD)).at(-1)?.message === 'reset: moving to ' + c1`,
     and `sut.branch` undefined, `sut.id === c1`.
  Import `readReflog` + `HEAD` const (mirror abort-merge.test.ts). Run
  `npx vitest run test/unit/application/commands/reset.test.ts` → test (1) fails
  (current detached path writes a spurious `reset: moving to c2`).
- **Green.** In `reset.ts`, replace the detached branch
  ```ts
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/HEAD`, `${id}\n`);
  await recordRefUpdate(ctx, 'HEAD' as RefName, head.id, id, reflogMessage);
  return { mode: opts.mode, id, branch: undefined };
  ```
  with
  ```ts
  await updateRef(ctx, 'HEAD' as RefName, id, { reflogMessage });
  return { mode: opts.mode, id, branch: undefined };
  ```
  Remove the now-unused `recordRefUpdate` import. Re-run → both pass.
- **Refresh** the pre-existing detached-move test (~L503–521): its rationale comment
  cites `L64/L65` `writeUtf8` line numbers that no longer exist — rewrite it to
  describe the `updateRef('HEAD', …)` routing (HEAD ends at the target; an emptied
  `'HEAD'` literal or message would leave HEAD at c2 / mis-log). Keep its
  HEAD-file-content assertion.
- **Validate + commit:** `fix(reset): route detached HEAD write through updateRef`.

## Slice 4 — detached `reset` HEAD reflog parity pins (item 1)

**File:** `test/integration/reset-interop.test.ts`. Add a
`Given a detached HEAD` describe with two cases (reuse `seedTwoCommits`,
`topReflogSubject`, `repo.checkout({ target, detach: true })`):

- **No-move:** seed two commits in both, detach to the tip on both
  (`git -C peer checkout --detach` / `repo.checkout({ target: <c1tip>, detach: true })`),
  capture each tool's `HEAD` reflog top, `reset --hard HEAD` on both
  (`git -C peer reset --hard HEAD` / `repo.reset({ mode: 'hard', target: 'HEAD' })`),
  assert each tool's `HEAD` reflog top is **unchanged by the reset** (before ==
  after on the same tool — isolates from `checkout`-message formatting differences).
- **Move:** same seed, detached at the tip, `reset --hard <c0>` on both, assert both
  write the identical `'reset: moving to ' + c0` `HEAD` entry.

Add `topReflogSubject` to the interop-helpers import. Run → passes (slice 3 green).
- **Validate + commit:** `test(reset): pin detached HEAD reflog parity vs git`.

## Validation gates (every slice)

`npm run validate` (biome + types + unit + coverage) green before each commit.
Never `--no-verify`, no ignore directives, no phase/ADR refs in source or test code.

## Out of plan (later steps)

- Step 6 reviews (ts / security / tests), Step 7 architecture-refactor pass
  (candidate: collapse reset's symbolic/detached branches into one `updateRef`
  call — behaviour-preserving, evaluate then), Step 8 mutation, Step 9 docs +
  BACKLOG 22.2c flip + PR.
