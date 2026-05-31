# Plan — no-op abort reflog skip + cherry-pick abort guard mutant

TDD, one atomic commit per slice. `npm run validate` green before each commit.
Per ADR-225: gate the direct-ref reflog in `updateRef` on `oldId !== newId`, keep
`logCoupledHead` unconditional.

## Slice 1 — `updateRef` no-op reflog skip (production + every affected test)

**Files:** `src/application/primitives/update-ref.ts`,
`test/unit/application/primitives/update-ref.test.ts`,
`test/unit/application/commands/cherry-pick.test.ts`,
`test/unit/application/commands/revert.test.ts`,
`test/unit/application/commands/abort-merge.test.ts` (if it pins a no-move entry).

- **Red:** add two `reflog logging` blocks to `update-ref.test.ts`:
  1. `Given an existing branch updated to the same id (no move) › When updateRef
     is called › Then no branch reflog entry is appended` — seed
     `refs: [{ name: MAIN, id: ID_A }]`, `updateRef(MAIN, ID_A, { reflogMessage })`,
     assert `readReflog(MAIN)` is `[]`.
  2. `Given HEAD symbolically targets the branch and it is updated to the same id
     (no move) › When updateRef is called › Then HEAD still records the entry` —
     seed `refs: [{ name: MAIN, id: ID_A }]`, `writeSymbolicRef(HEAD, MAIN)`,
     `updateRef(MAIN, ID_A, { reflogMessage: 'reset: moving to <a>' })`, assert
     `readReflog(HEAD)` has length 1 with `oldId === newId === ID_A` and the
     message.
  Run `npx vitest run test/unit/application/primitives/update-ref.test.ts` → test
  1 fails (production writes a branch entry on no-move); test 2 already passes
  (`logCoupledHead` writes HEAD).
- **Green:** in `updateRef`, wrap the direct-ref `recordRefUpdate(ctx, name, …)` in
  `if (oldId !== newId) { … }`; leave `atomicWriteRef` and `logCoupledHead`
  unconditional. Re-run the file → both pass.
- **Fix the breakage the production change causes** (same commit — these tests
  pinned the bug):
  - `cherry-pick.test.ts` `Given a stopped lone pick › When abort runs`
    (≈ 1226–1238): retitle to the faithful split — branch reflog top is **not**
    `reset: moving to` (assert `readReflog(MAIN).at(-1)?.message` ≠ the reset
    string, e.g. it stayed the last commit/pick entry), and `readReflog(HEAD)
    .at(-1)?.message` **is** `` `reset: moving to ${head}` ``.
  - `revert.test.ts` `Given a lone single-revert conflict › When abort runs`
    (≈ 771–792): same flip — branch unchanged, HEAD gets the reset string. Keep
    the existing `sut.head` / state-clear assertions.
  - `abort-merge.test.ts`: if any test asserts a no-move **branch** reflog entry,
    flip it to faithful (branch unchanged, HEAD keeps `merge: aborted` — the
    message-text gap is a separate follow-up).
- **Run the full suite** (`npm run validate`) and faithful-flip **any** other test
  that asserted a no-move branch/tracking-ref reflog entry (candidates: `reset`,
  `fetch`, `push`, `merge` unit tests). The gate only changes `old === new` paths,
  so move-case tests are untouched.
- **Commit:** `fix(ref): skip the direct-ref reflog on a no-op update`.

## Slice 2 — interop pins: no-move abort reflog parity vs real git

**Files:** `test/integration/cherry-pick-interop.test.ts`,
`test/integration/revert-interop.test.ts`.

- **Add** a `topHeadReflog(dir)` helper alongside the existing `topReflog`:
  `git(dir, 'log', '-g', '--format=%gs', 'HEAD').split('\n')[0]`.
- **cherry-pick:** add `Given a lone cherry-pick conflict aborted (no move) › Then
  tsgit and git agree: branch reflog unchanged, HEAD records reset: moving to`:
  - Seed the same lone-conflict history in `pair.peer` and `pair.ours`; capture
    `pre = rev-parse refs/heads/main` and `branchTop = topReflog(peer)` before the
    pick (sanity-assert peer == ours).
  - **peer (oracle):** `tryRunGit([… 'cherry-pick', <conflict-oid>])` (stops),
    then `runGit([… 'cherry-pick', '--abort'])`.
  - **ours:** `repo.cherryPick.run({ commits: [<conflict-oid>] })` → expect
    `kind === 'conflict'`; `repo.cherryPick.abort()`; `dispose`.
  - **Assert:** `topReflog(peer) === branchTop` (branch entry NOT added — oracle),
    `topReflog(ours) === topReflog(peer)` (tsgit parity), and
    `topHeadReflog(peer) === \`reset: moving to ${pre}\``,
    `topHeadReflog(ours) === topHeadReflog(peer)`.
- **revert:** the analogous lone-conflict no-move abort case (mirror the helpers /
  shape of the revert-interop suite).
- `npm run validate` (interop runs only when `GIT_AVAILABLE`).
- **Commit:** `test(ref): pin no-op abort reflog parity against git`.

## Slice 3 — kill the `cherryPickAbort` guard mutant (test-only)

**File:** `test/unit/application/commands/cherry-pick.test.ts`.

- **Add** `Given a multi-pick range stopped at a merge commit (sequencer present,
  no CHERRY_PICK_HEAD) › When abort runs › Then it resets to the pre-sequence HEAD
  and clears the sequencer` — reuses the existing `seedMerge()` helper, exactly as
  the "Given a range containing a merge commit" test does (cherry-pick.test.ts
  ≈ 188–207). `seedMerge` builds `feature = base → c1(f1) → merge(side) → c2`;
  `base..feature` expands oldest-first to `[c1, merge, c2]`, so:
  - **Arrange:** `const { ctx, base } = await seedMerge();
    await codeOf(() => cherryPickRun(ctx, { commits: [\`${base}..feature\`] }));`
    — c1 commits onto `main` (branch moves off `base`), then the run stops at the
    merge with the sequencer persisted and **no** `CHERRY_PICK_HEAD`. (`base` is
    the pre-sequence head, since `main` started at `base`.)
  - **Act:** `const sut = await cherryPickAbort(ctx);`
  - **Assert:** `sut.head === base`; `resolveRef(MAIN) === base`;
    `f1.txt` is gone from the working tree (the c1 pick undone);
    `sequencer` dir absent; `CHERRY_PICK_HEAD` absent. (No
    `NO_OPERATION_IN_PROGRESS`.)
- **Red note:** production is already correct, so it passes immediately; its job is
  to kill the surviving `ConditionalExpression` mutant (`seqHead === undefined` →
  `true`), which would make `abort` throw `NO_OPERATION_IN_PROGRESS` in this state.
  Verified in Step 8.
- `npm run validate`.
- **Commit:** `test(cherry-pick): cover abort after a merge-no-mainline range stop`.

## Step 6 — Reviews (typescript / security / tests)

Scoped to `git diff main...HEAD`. Watch: the `oldId !== newId` gate's branch and
boundary mutants; that the faithful-flipped tests assert specific data (not just
absence); interop seeds are date-pinned/deterministic.

## Step 7 — Architecture refactor + scoped re-review

Expected near no-op. Explicitly **defer** the `abortSequencerReset` extraction
(`cherryPickAbort` / `revertAbort` are byte-identical bar three injected points):
rule-of-three needs `rebase --abort` (22.3) as the third consumer; extracting at
two consumers is speculative (YAGNI). Record the justification; leave it tracked.

## Step 8 — Mutation

Confirm killed: the `updateRef` gate mutants (`!==`→`===`, conditional boundary)
via the Slice-1 no-move/move unit tests; the `cherryPickAbort` `seqHead ===
undefined` `ConditionalExpression` mutant via Slice 3. New survivors → kill or
prove equivalent inline.

## Step 9 — Docs + faithfulness cluster + backlog + PR

- **Faithfulness docs cluster** (user-requested, this PR): add a Git-faithfulness
  principle to `docs/understand/architecture.md`; new meta-ADR 226
  "git-faithfulness as the prime directive" (escape hatch: divergence ⇒ its own
  ADR); promote "be git-faithful" to a standalone invariant in `CLAUDE.md`; a
  top-level faithfulness statement in `CONTRIBUTING.md`; a faithfulness checkbox in
  `.github/PULL_REQUEST_TEMPLATE.md`. Architecture/CONTRIBUTING/CLAUDE/PR-template
  link back to ADR-226. Commit(s): `docs(architecture): enforce git-faithfulness
  principle` (+ the meta-ADR / template as their own commits if cleaner).
- **Backlog:** flip 22.2b (items 1 + 3 done; item 2 = `abortSequencerReset`
  extraction explicitly deferred to 22.3). Log the two audit follow-ups: detached
  `reset --hard HEAD` no-op `HEAD` reflog, and `merge --abort` `HEAD` message text.
- No README/RUNBOOK surface change (internal reflog faithfulness; no public API or
  porcelain behaviour change).
- Push `-u origin`; `gh pr create` with summary + test plan.
