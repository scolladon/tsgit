# Plan — `cherry-pick` faithfulness + test follow-ups

TDD, one atomic commit per slice. `npm run validate` green before each commit.

## Slice 1 — close the `CHERRY_PICK_MERGE_NO_MAINLINE` message mutant (test-only)

**File:** `test/unit/domain/commands/error.test.ts`

- **Add** a `Given the cherryPickMergeNoMainline error helper` block mirroring the
  existing `revertMergeNoMainline` block (≈ lines 126–139): assert `.data` equals
  `{ code: 'CHERRY_PICK_MERGE_NO_MAINLINE', commit: OID1 }` **and** assert the
  rendered `.message` equals
  `CHERRY_PICK_MERGE_NO_MAINLINE: commit ${OID1} is a merge but no -m option was given`.
- Import `cherryPickMergeNoMainline` from `src/domain/commands/error.ts` (add to
  the existing import group).
- **Red note:** production is already correct, so the test passes immediately;
  its purpose is to kill the surviving `StringLiteral` mutant on `error.ts`'s
  `CHERRY_PICK_MERGE_NO_MAINLINE` arm. The `.message` assertion is what fails
  against that mutant (verified in Step 8 mutation run). No production change.
- `npm run validate`.
- **Commit:** `test(error): assert CHERRY_PICK_MERGE_NO_MAINLINE rendered message`.

## Slice 2 — git-faithful `cherryPick.abort` reflog (behaviour: reflog string only)

**Files:** `src/application/commands/cherry-pick.ts`,
`test/unit/application/commands/cherry-pick.test.ts`

- **Red:** rewrite the existing `Given a stopped lone pick › When abort runs`
  test (≈ lines 1226–1238). Title → `Then the branch reflog records the faithful
  reset move`; assert `sut.at(-1)?.message` equals `` `reset: moving to ${head}` ``
  where `head` is `resolveRef(ctx, 'refs/heads/main')` *before* abort (the branch
  does not move in a lone conflict, so pre == post). Run
  `npx vitest run test/unit/application/commands/cherry-pick.test.ts` → fails
  (production still writes `cherry-pick: aborted`).
- **Green:** in `cherryPickAbort`, change the `updateRef` call's `reflogMessage`
  from `'cherry-pick: aborted'` to `` `reset: moving to ${target}` `` (identical
  to `revertAbort`). Update the abort doc comment to mention the faithful
  `reset: moving to <oid>` reflog (mirror `revert`'s comment). Re-run → passes.
- `npm run validate`.
- **Commit:** `fix(cherry-pick): write git-faithful abort reflog`.

## Slice 3 — interop pin: abort reflog parity vs real git (move case)

**File:** `test/integration/cherry-pick-interop.test.ts`

- **Add** a builder `buildMovingConflictRange(dir)` (git CLI): `base` (f.txt),
  `feature` = `clean add g` (g.txt — applies cleanly on main) then `conflict f`
  (f.txt — conflicts), `main` = `main diverge` (f.txt). Uses `gitCommit`
  (pinned dates) so the seed is byte-deterministic. `main..feature` therefore
  expands to `[clean add g, conflict f]`: the first pick commits (branch moves),
  the second conflicts.
- **Add** a helper `topReflog(dir)` =
  `git(dir, 'log', '-g', '--format=%gs', 'refs/heads/main').split('\n')[0]`.
- **Add** a case `Given a range cherry-pick aborted mid-sequence › Then tsgit and
  git write the same faithful reset reflog`:
  - Build the moving range in **both** `pair.peer` and `pair.ours`; capture
    `pre = rev-parse refs/heads/main` (identical on both — sanity-assert equal).
  - **peer (oracle):** `tryRunGit([... 'cherry-pick', 'main..feature'])` (stops),
    then `runGit([... 'cherry-pick', '--abort'])`.
  - **ours:** `openRepository`, `repo.cherryPick.run({ commits: ['main..feature'] })`
    → expect `kind === 'conflict'`; `repo.cherryPick.abort()`; `dispose`.
  - **Assert:** `topReflog(pair.peer)` equals `` `reset: moving to ${pre}` ``
    (pins git's literal format — oracle) **and** `topReflog(pair.ours)` equals
    `topReflog(pair.peer)` (tsgit parity, byte-identical since the pre-oid is
    shared).
- **Red demonstration:** before Slice 2's production change this case fails
  (tsgit would write `cherry-pick: aborted`); verified by reasoning + optional
  local stash of the Slice-2 diff. Lands green post-fix.
- Update the file header `@writes` comment block / prose to mention the abort
  reflog-parity case.
- `npm run validate` (interop runs only when `GIT_AVAILABLE`).
- **Commit:** `test(cherry-pick): pin abort reflog parity against git`.

## Step 6 — Reviews (typescript / security / tests), Step 7 — refactor, Step 8 — mutation

- Reviews scoped to `git diff main...HEAD`.
- Refactor pass: expect a near no-op — the change is a one-line message + a test;
  consider whether the two identical abort bodies (`cherryPickAbort` /
  `revertAbort`) warrant a shared helper, bounded by YAGNI (likely *not* — they
  differ in head/state-clearing calls and a premature seam would couple two
  command modules). Record the justification.
- Mutation: confirm the `CHERRY_PICK_MERGE_NO_MAINLINE` StringLiteral mutant is
  now killed and the new reflog string mutant (`reset: moving to`) is killed by
  the unit + interop assertions.

## Step 9 — Docs + backlog

- Flip `docs/BACKLOG.md` 22.2a `[ ]` → `[x]` with a one-line shipped summary.
- **Log a new backlog follow-up:** the `updateRef` no-op reflog-skip gap — tsgit
  writes `reset: moving to <oid>` on a no-move abort where git writes nothing;
  shared by `revert.abort` + `cherryPick.abort`. Separate, cross-cutting, tracked
  not folded in.
- No README/RUNBOOK/CONTRIBUTING surface changes (internal reflog faithfulness +
  test strengthening; no public API or porcelain behaviour change).
