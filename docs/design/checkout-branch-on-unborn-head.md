# Design — checkout-branch-on-unborn-head

> Brief: backlog 32.41 — `checkout` cannot create a branch on an unborn HEAD (git's `checkout -b x`
> with no start point), and a start point given on an unborn HEAD throws `REF_NOT_FOUND` where git
> refuses `'<rev>' is not a commit and a branch '<name>' cannot be created from it`. Folded: every
> switch FROM an unborn HEAD to a real commit refuses in tsgit and succeeds in git; and (ADR-1201,
> DOCTRINE D-2) the two-way carry's file/directory displacement in `materialize-tree.ts` that the
> unborn path inherits (axis 6).
> Status: draft → self-reviewed ×3 → revised against ADRs 1197–1201 (axis 6 pinned, R7, §7)

## Context

### The corrected backlog statement

32.41 was filed against git 2.55 on 36a8b9b7. Both halves reproduce on main 3615a9e9 against git
2.56.0 (macOS), and the line numbers in the entry are stale (`rev` is now `checkout.ts:86`, the
`resolveRef(ctx, 'HEAD')` call is in `switchBranch`):

- (a) `checkout -b x` on an unborn HEAD: git moves `HEAD` to `ref: refs/heads/x` and touches nothing
  else; tsgit cannot express the call (`{ createBranch: { name: 'x' } }` throws
  `INVALID_OPTION { option: 'rev', reason: 'either rev or paths must be provided' }`).
- (b) `checkout -b x HEAD` on an unborn HEAD: git dies `'HEAD' is not a commit and a branch 'x'
  cannot be created from it`; tsgit throws `REF_NOT_FOUND { name: 'refs/heads/main' }`.

The family is wider than the entry. `switchBranch` resolves HEAD with `resolveRef` before it looks
at the target, so **every** switch whose HEAD is unborn refuses `REF_NOT_FOUND`, whatever the
target. git switches from an unborn HEAD (an orphan branch, or a fresh `git init` followed by a
fetch) with the empty tree as the two-way merge's "old" side. That is axis 3 below. It sits in the
same function and the same refusal path, so it is folded.

### Code map (names, not line numbers)

| Where | Symbol | Role today |
|---|---|---|
| `src/application/commands/checkout.ts` | `CheckoutSwitchOptions` (`rev: string` required), `CheckoutCreateBranch`, `CheckoutOptions`, `CheckoutResult` | public option and result shapes. Only `CheckoutOptions` / `CheckoutResult` are re-exported (`src/application/commands/index.ts`); `CheckoutSwitchOptions` is in `reports/api.json` through the union |
| same file | `isSwitch` (`'rev' in opts && opts.rev !== undefined`), `isPaths`, `assertSingleCheckoutMode` | mode selection: refuses `rev` + `paths`, and neither (`INVALID_OPTION { option: 'rev' }`) |
| same file | `switchBranch` | `readHeadRaw` → `assertEverySourceLoadable` (detached only) → **`resolveRef(ctx, 'HEAD')`** (throws on unborn) → `resolveCommitSwitch` → `readTree` → `loadSparseMatcher` → `materializeSwitch` → `finishSwitch` |
| same file | `resolveSwitch`, `resolveSwitchTarget`, `branchFor`, `unresolvedSwitch` | target resolution. `unresolvedSwitch` already raises `pathspecNoMatch(rev)` without `createBranch` and `checkoutStartPointNotCommit(rev, name)` with it. On an unborn HEAD it is never reached, because `resolveRef` throws first |
| same file | `assertBranchCreatable` | `createBranch` + `detach` → `INVALID_OPTION { option: 'createBranch' }`; `validateRefName`; `refResolvesForReading` → `BRANCH_EXISTS` |
| same file | `headTreeOption(ctx, opts, currentIndex, oldOid)` | the two-way merge's "old" side: `{}` when forced, `{}` when the index was never written (no file, no entries: git's `initial_checkout`), else `{ headTree: readTree(oldOid).id }` |
| same file | `finishSwitch`, `moveHeadForSwitch`, `headCheckoutLabel`, `staysOnHead`, `createRequestedBranch` | branch creation at `finish.arg`, HEAD move with reflog `checkout: moving from <label> to <name>`, `removeBranchState(ctx, 'announce')`, `post-checkout [oldOid, oid, '1']` |
| same file | `pathRestore` | precedent: an unborn HEAD reports `zeroOid(ctx.hashConfig)` as `id` and to the hook |
| `src/application/primitives/resolve-ref.ts` | `resolveRef` (missing → `REF_NOT_FOUND`), `resolveRefOrMissing` (missing → `undefined`, any other failure propagates) | |
| `src/application/primitives/ref-store.ts` | `applyRefUpdates([{ kind: 'setSymbolic', name: 'HEAD', target }])` | with no `reflog` field, `applyRefWrite` writes the HEAD file and no reflog line (files and reftable backends). HEAD resolves to the worktree's own HEAD in a linked worktree |
| `src/application/primitives/materialize-tree.ts` | `MaterializeTreeOpts.headTree`, `carryHeadAgreement`, `agreementWithHead`, `leadingDirectoriesOf`, `collidesWithTarget` | the two-way rule; `readTree(emptyTreeOid)` is served virtually by `object-resolver.ts`. `carryHeadAgreement` sets every kept stage-0 entry aside and re-appends it after the apply, with no file/directory check against the paths the switch writes (axis 6) |
| `src/application/primitives/internal/two-way-carry.ts` | `carryStagedChanges(head, target, index): TwoWayCarry` | per-path `kept` / `refused`; path-local, blind to d/f (unchanged by §7) |
| `src/application/primitives/internal/occupant-clash.ts` | `classifyLeadingObstruction`, `classifyAddedPath`, `holdsSurvivor` | the pre-flight: a file at an added path's leading directory is `untracked` unless the changeset deletes it (`scope.removed`) or it is ignored (unchanged by §7) |
| consumers passing `headTree` | `checkout.ts` `materializeSwitch`; `merge.ts` `attemptNonConflictTree` (fast-forward, squash); `apply-merge-to-worktree.ts` (three-way clean result, `force: true`); `internal/reset-worktree.ts` `attemptCheckoutWorktreeToCommit` (rebase) | `reset.ts`, `pull.ts`, `pull-into-void.ts`, `worktree.ts`, `stash.ts` pass no `headTree`, so `carryHeadAgreement` returns at its first line for them |
| `src/domain/objects/object-id.ts` | `emptyTreeOid(config)`, `zeroOid` | |
| `src/domain/commands/error.ts` | `checkoutStartPointNotCommit`, `pathspecNoMatch`, `noInitialCommit` (`NO_INITIAL_COMMIT`, used by `stash` and `history-rewrite`), `invalidOption`, `branchExists` | |
| `src/application/commands/stash.ts` | `headTreeOrEmpty` | precedent: git's `reset_head` reads an unborn HEAD as the empty tree |

### Constraining ADRs and doctrine

- ADR-226 (prime directive), ADR-249 (structured output: fields, never rendered text).
- ADR-1170 (filing bar): every axis 1–3 row is a refusal mismatch on a well-formed repository, so
  it is in scope.
- Release-marking precedents for D3: ADR-1048 and ADR-1196 shipped removed refusals and code moves
  between existing members as `fix`; ADR-1190 marked a new refusal breaking; ADR-1024 marked removing
  a union member breaking. DOCTRINE D-3 covers a fix that turns a returning method into a throwing
  one. This change goes the other way (throwing → returning), so D-3 does not decide the marking.
- Ratified for this change: ADR-1197 (D1 A), ADR-1198 (D2 A), ADR-1199 (D3 A, `fix`), ADR-1200
  (D4 A), ADR-1201 (D5 **B**: fold the two-way carry's d/f divergence, G1 and G9).
- DOCTRINE D-2: a row this change makes reachable that inherits a shared-primitive divergence is
  folded whole, with unit rows for the shared half and an interop pin per affected consumer.

## Pinned matrix (git 2.56.0, tsgit main 3615a9e9, 2026-11-16)

"unborn" = HEAD symbolic to a `refs/heads/<b>` that does not exist. "fresh" = `git init; echo a>f;
git add f`. "orphan" = clone of a repository with `main` (`dir/x`, `f`), then `checkout --orphan o`
(index and worktree carry `dir/x`, `f`). "fetched" = `git init` (unborn `main`, no index file) +
`git fetch <src> main:other`. "After" = a scratch copy of `src` with the design below applied (§1–§3),
run through the same probe. Probe scripts and raw outputs: `<scratch>`. G1 ran three times and U13 twice, with
identical outcomes; the other rows are deterministic file-state outcomes, run once.

### Axis 1 — `-b` with no start point on an unborn HEAD (git `switch_unborn_to_new_branch`)

| # | Form | git | tsgit main | After |
|---|---|---|---|---|
| U1 | fresh, `checkout -b x` | 0; HEAD → `ref: refs/heads/x`; no ref written; index and worktree untouched (`A f` kept) | `INVALID_OPTION { option: 'rev' }` (inexpressible) | `{ branch: 'refs/heads/x', id: <null>, detached: false, changedPaths: 0 }`, same state |
| U2 | `-B x`, `switch -c/-C x`, `--orphan x` | same as U1 | no such surface | — |
| U3 | `-b x --track` / `--no-track` | 0, no `branch.*` config | — | track ignored, no config (no `branchCreate` call) |
| U4 | `-f -b x` | 0, same as U1 | — | same as U1 |
| U5 | `-b x --detach` | fatal `'--detach' cannot be used with '-b/-B/--orphan'` | — | `INVALID_OPTION { option: 'createBranch' }` (existing refusal) |
| U6 | `-b 'x..y'` | fatal not a valid branch name | — | `INVALID_REF` |
| U7 | `-b main`, HEAD already `ref: refs/heads/main` (unborn) | 0, HEAD unchanged | — | 0, HEAD unchanged |
| U8 | orphan `o`, `-b main` (main exists) | fatal a branch named 'main' already exists | — | `BRANCH_EXISTS { name: 'refs/heads/main' }` |
| U9 | `-B main` where main exists | 0; HEAD → main, worktree/index not touched; reflog `0 → main` | no `-B` | out of scope (no `-B`) |
| U10 | reflog | none (HEAD nor x), even with `core.logAllRefUpdates=always`; no `.git/logs` created; reftable: `reflog show HEAD` fails identically | — | none (files and reftable) |
| U11 | hooks | `post-checkout` not run; `reference-transaction` runs | — | `post-checkout` not run; see Out of scope for `reference-transaction` |
| U12 | held `index.lock` | ignored, 0 | — | 0 (index never locked) |
| U13 | corrupt `.git/index` (`garbage`) | 0 (index never read), ×2 | — | 0 |
| U14 | held `HEAD.lock` | `error: cannot lock ref 'HEAD'`, exit 255, HEAD unchanged | — | `REF_LOCKED { name: 'HEAD' }`, HEAD unchanged |
| U15 | `MERGE_MSG` present | kept (no `remove_branch_state`) | — | kept |
| U16 | linked worktree on orphan `o2`, `-b x` | 0; worktree HEAD → x; main HEAD untouched; no ref | — | same |
| U17 | bare repository + linked worktree on orphan `o3`, `-b x` | 0; worktree HEAD → x; bare HEAD untouched | — | same |
| U18 | main worktree unborn on `main`, linked worktree on orphan `o2`, `-b main` in the linked one | 0; both HEADs on `refs/heads/main`; no ref | — | same |

### Axis 2 — a start point given on an unborn HEAD that does not resolve

| # | Form | git | tsgit main | After |
|---|---|---|---|---|
| S1 | `checkout -b x HEAD` | fatal `'HEAD' is not a commit and a branch 'x' cannot be created from it`; nothing changes | `REF_NOT_FOUND { name: 'refs/heads/main' }` | `CHECKOUT_START_POINT_NOT_COMMIT { revision: 'HEAD', branch: 'x' }` |
| S2 | `checkout -b x @` | same, `'@'` | `REF_NOT_FOUND` | `… { revision: '@', branch: 'x' }` |
| S3 | `checkout -b x main` (main missing) | same, `'main'` | `REF_NOT_FOUND` | `… { revision: 'main', branch: 'x' }` |
| S4 | `-B x HEAD`, `--orphan x HEAD` | same message | no surface | — |
| S5 | `switch -c x HEAD` | fatal `invalid reference: HEAD` | no surface | — |
| S6 | linked / bare-linked, `-b x HEAD` | same as S1 | — | same as S1 (same code path) |
| S7 | `checkout HEAD` / `checkout main` (no `-b`) | `error: pathspec 'HEAD'/'main' did not match any file(s) known to git`, exit 1 | `REF_NOT_FOUND` | `PATHSPEC_NO_MATCH { pattern, patterns: [pattern] }` |

### Axis 3 — switching FROM an unborn HEAD to a real commit

| # | Form | git | tsgit main | After |
|---|---|---|---|---|
| F1 | orphan, `checkout main` | 0; HEAD → main; staged `A` entries matching the target end clean; HEAD reflog `0000… <main> checkout: moving from o to main` | `REF_NOT_FOUND { name: 'refs/heads/o' }` | 0, same state, same reflog line (old-oid column all zeros) |
| F2 | orphan, `checkout --detach main` | 0; detached at main; reflog `moving from o to main` | `REF_NOT_FOUND` | same |
| F3 | orphan, `checkout -b x main` | 0; x at main (`branch: Created from main`); HEAD → x; reflog `moving from o to x` | `REF_NOT_FOUND` | same |
| F4 | `post-checkout` args (F1) | `0000…(null) <main> 1` | — | `[<null>, <main>, '1']` (from `oldOid`) |
| F5 | orphan, staged `f` = main's `f`, `checkout side` where `f` differs | refuse: local changes would be overwritten (`f`), exit 1 | `REF_NOT_FOUND` | `CHECKOUT_OVERWRITE_DIRTY { localChanges: ['f'], untracked: [] }` |
| F6 | orphan, unstaged-only change to `f` (index = target) | 0, ` M f` kept | `REF_NOT_FOUND` | 0, ` M f` kept |
| F7 | orphan, `git rm -f f` (index and disk without `f`), `checkout main` | 0, `f` restored, clean | `REF_NOT_FOUND` | same |
| F8 | orphan, untracked `g` | 0, `?? g` kept | `REF_NOT_FOUND` | same |
| F9 | fetched, index written then emptied (`add f; rm --cached f`), untracked `f` identical to target | refuse: untracked working tree files would be overwritten (`f`) | `REF_NOT_FOUND` | `CHECKOUT_OVERWRITE_DIRTY { localChanges: [], untracked: ['f'] }` |
| F10 | fetched (no index file), clean | 0, `dir/x` and `f` written | `REF_NOT_FOUND` | 0, `changedPaths: 2` |
| F11 | fetched (no index file), untracked `f` differing / identical, also `--detach`, also `-b y` with untracked `dir/x` | refuse untracked overwrite (each) | `REF_NOT_FOUND` | `CHECKOUT_OVERWRITE_DIRTY { untracked: ['f'] }` (each probed but `-b y`, which takes the same path) |
| F12 | fetched (no index file), untracked `f` differing, `-f` | 0, `f` overwritten | `REF_NOT_FOUND` | 0 |
| F13 | fetched + staged `g` (reftable repository), `checkout other` | 0, `A g` kept; HEAD reflog `moving from main to other` | `REF_NOT_FOUND` | same |
| F14 | sparse (no-cone `/g`), orphan → main | 0, `f` skip-worktree, absent on disk | `REF_NOT_FOUND` | not probed after; same `materializeSwitch` path as a born sparse switch (interop row) |
| F15 | linked worktree on orphan, `checkout --detach main` | 0; main worktree HEAD untouched | `REF_NOT_FOUND` | interop row |
| G1 | fetched + staged file `dir`, target has `dir/x` (×3, macOS `git init`, so `core.ignorecase=true`) | 0; staged `dir` dropped from index and disk, `dir/x` and `f` written | `REF_NOT_FOUND` | first-revision scratch: `CHECKOUT_OVERWRITE_DIRTY { untracked: ['dir'] }`. Re-pinned per `core.ignorecase` in axis 6 (A1, A2), fixed by R7 / §7 |
| G9 | **born** `main` (`f` only) + staged `dir`, `checkout tgt` (has `dir/x`) | 0, same as G1 | `CHECKOUT_OVERWRITE_DIRTY { untracked: ['dir'] }` on main | axis 6 (A3, A4) |

(git's `merge_working_tree` with a NULL old commit uses the empty tree as the two-way "old" side;
F5–F9 and F13 are its observable consequences.)

### Axis 4 — `rev` omitted (what an optional `rev` opens)

| # | Form | git | tsgit main | After |
|---|---|---|---|---|
| H1 | born, `checkout -b x` | = `-b x HEAD`: x at HEAD (`branch: Created from HEAD`), HEAD reflog `moving from main to x`, post-checkout `<oid> <oid> 1` | `INVALID_OPTION { option: 'rev' }` | same as git |
| H2 | born, `checkout --detach` | detached at HEAD, reflog `moving from main to HEAD` | `INVALID_OPTION` | same as git |
| H3 | born, `checkout` (no args) | 0, no-op, no reflog line | `INVALID_OPTION` | 0, no reflog line (the `staysOnHead` path) |
| H4 | unborn, `checkout` (no args), with or without an index | fatal `You are on a branch yet to be born`, exit 128 | `INVALID_OPTION` | D2 |
| H5 | unborn, `checkout --detach` | fatal `You are on a branch yet to be born` | `INVALID_OPTION` | D2 |

### Axis 5 — `branch.create` on an unborn HEAD

| # | Form | git | tsgit main |
|---|---|---|---|
| B1 | `branch x` | fatal not a valid object name: 'main' | `BRANCH_NOT_FOUND { name: 'main' }` |
| B2 | `branch x HEAD` | fatal not a valid object name: 'HEAD' | `BRANCH_NOT_FOUND { name: 'HEAD' }` |
| B3 | linked orphan `o`, `branch x` | fatal not a valid object name: 'o' | — |

No gap: tsgit refuses on the same condition and names the same thing. `test/integration/branch-start-point-interop.test.ts`
(`Given a fresh repository whose HEAD names a branch no commit backs`) already pins B1 and its
`--force` twin, so no row is added.

### Axis 6 — the two-way carry against a file/directory swap (ADR-1201, re-pinned 2026-11-17)

Twins are copies of one origin: `main` (`f`), `tgt` = main + `dir/x`, `tgt3` = tgt + `g`, `hf` =
main + file `dir` (`D`), `dv` = main + `h`. Each row sets `core.ignorecase` explicitly in both twins
(`ic=F` / `ic=T`), except M6, which ran under the macOS `git init` default (`true`). Row letters: A = staged file against a target directory, V = staged directory against a target file, M = merge consumers. "After" = a scratch copy of `src` with the §7 edit applied (born rows; the unborn
rows need §2–§4 as well and were pinned on git only). "staged `dir`" = `echo s > dir; git add dir` on
`main` (neither HEAD nor the target has `dir`). Raw outputs: `<scratch>/df/out{1..4}.txt`. A3 and A4
ran twice per setting, A1 twice per setting; identical outcomes.

**The finding that bounds the fold: the forward rows are gated on `core.ignorecase`.** The first
revision pinned G1/G9 on macOS, where `git init` writes `core.ignorecase=true`. With
`core.ignorecase=false` (the Linux default) git refuses A1/A3 exactly as tsgit does today. The
switch goes through only under `ic=T` and only when the file's cached stat matches (A6 refuses when
the content was modified after staging). This is git's `verify_absent` → `check_ok_to_remove` →
`icase_exists`: under `ignore_case`, a file in the added path's way that is in the source index and
`ie_match_stat`-clean may be replaced. The reverse direction (V rows) is git's
`verify_clean_subdirectory` and does not depend on the setting.

| # | Form | ic | git 2.56.0 | tsgit main | After |
|---|---|---|---|---|---|
| A1 | **unborn** (orphan, index emptied) + staged `dir`, `checkout tgt` (G1) | F | refuse `untracked working tree files would be overwritten: dir`, exit 1 (×2) | `REF_NOT_FOUND` | not run (needs §2–§4); same carry input as A3 with HEAD = empty tree |
| A2 | same (G1) | T | 0; index `dir/x`, `f`; disk `dir/x` (×2) | `REF_NOT_FOUND` | as A1 |
| A2d | unborn + staged `dir`, then `echo m > dir` | F, T | refuse untracked `dir` (both) | `REF_NOT_FOUND` | as A1 |
| A3 | born `main` + staged `dir`, `checkout tgt` (G9) | F | refuse untracked `dir`, exit 1 (×2) | `CHECKOUT_OVERWRITE_DIRTY { localChanges: [], untracked: ['dir'] }` (match) | same (match) |
| A4 | same (G9) | T | 0; index `dir/x`, `f`; disk `dir/x`; status clean (×2 + ×3 in the first revision) | refuse `untracked: ['dir']` | 0, same state |
| A5 | born + staged `dir`, `rm dir` (worktree file gone) | F, T | 0; index `dir/x`, `f` | **0 but the index holds both `dir` and `dir/x`**; status `AD dir` | 0; index `dir/x`, `f` |
| A6 | born + staged `dir`, then `echo m > dir` | F, T | refuse untracked `dir` (both) | refuse `untracked: ['dir']` (match) | same (match) |
| A7 | HEAD `hf` (file `dir` = `D`), index = HEAD, `checkout tgt` (staged content also in HEAD) | F, T | 0; `dir/x` | 0 (match) | 0 (match) |
| A8 | HEAD `hf`, staged `dir` = `S` (≠ HEAD, ≠ target) | F, T | refuse `local changes would be overwritten: dir` | `localChanges: ['dir']` (match) | same (match) |
| A9 | born, **untracked** `dir` (not staged), `checkout tgt` | F, T | refuse untracked `dir` | `untracked: ['dir']` (match) | same (match) |
| A10 | born + staged `dir`, `checkout -f tgt` | F, T | 0; `dir/x` | 0 (match; force skips the carry) | 0 (match) |
| A11 | HEAD `tgt`, `git rm -r --cached dir`, file `dir` staged in its place, `checkout tgt3` (HEAD and target agree on `dir/x`) | F, T | 0; index `dir`, `f`, `g`; status `A dir`, `D dir/x` | 0 (match) | 0 (match): an agreed target path displaces nothing |
| V1 | born + staged `dir/x` (neither HEAD nor target), `checkout hf` (file `dir`) | F, T | 0; index `dir`, `f`; disk file `dir` = `D` | refuse `untracked: ['dir']` | 0, same state |
| V2 | V1 + untracked `dir/u` | F, T | refuse `Updating the following directories would lose untracked files in them: dir` | `untracked: ['dir']` | `untracked: ['dir']` (the rebase-interop mapping of that message) |
| V3 | V1, then `echo m > dir/x` | F, T | refuse `local changes would be overwritten: dir/x` | `untracked: ['dir']` | `localChanges: ['dir/x']` |
| V4 | **unborn** + staged `dir/x`, `checkout hf` | F, T | 0; index `dir`, `f`; disk `dir` = `D` | `REF_NOT_FOUND` | not run (needs §2–§4) |
| M1 | born + staged `dir`, `merge tgt` (fast-forward) | F | refuse `untracked … would be overwritten by merge: dir` | `WORKING_TREE_DIRTY { localChanges: [], untracked: ['dir'] }` (match) | same (match) |
| M2 | same | T | 0, fast-forward; index `dir/x`, `f` | refuse `untracked: ['dir']` | `{ kind: 'fast-forward' }`, same state |
| M3 | born + staged `dir`, `merge --squash tgt` | F | refuse untracked `dir` | `WORKING_TREE_DIRTY { untracked: ['dir'] }` (match) | same (match) |
| M4 | same | T | 0; index `dir/x`, `f` | refuse `untracked: ['dir']` | `{ kind: 'squashed' }`, same state |
| M5 | `dv` (diverged) + staged `dir`, `merge -m m tgt` (three-way) | F, T | refuse `local changes … would be overwritten by merge: dir`, exit 2 (merge-ort's dirty-index check) | `WORKING_TREE_DIRTY { localChanges: ['dir'] }` (match) | not reached: refused before the carry |
| M6 | born + staged `dir`, `rebase tgt` | T | refuse `cannot rebase: Your index contains uncommitted changes` | `WORKING_TREE_DIRTY { localChanges: ['dir'] }` (match) | not reached: refused before the carry |

Consumers, per D-2. The carry runs only where `headTree` is passed. **Affected:** the checkout
switch (A, V rows) and `merge.ts` `attemptNonConflictTree` (fast-forward M2, squash M4; the
signing-failure path shares the function). **Not affected, with proof:** the three-way merge
(`apply-merge-to-worktree.ts`) and rebase (`reset-worktree.ts`) refuse a staged change before any
carry, in git and in tsgit (M5, M6), so no displaced kept entry can reach them. `reset --hard`
(`reset.ts`), `pull`, `pull-into-void`, `worktree add` and `stash` pass no `headTree` (`command grep
-n "headTree" src/application/commands/reset.ts src/application/commands/pull.ts` ⇒ no line), and
`carryHeadAgreement` returns `{ opts, allTarget, carried: [] }` before any carry when `headTree` is
undefined.

## Requirements

Lesson 037: each requirement is written per axis, then every pinned row is walked against it.

- **R1 — axis 1, unborn and no start point.** When HEAD is unborn, `rev` is absent and
  `createBranch` is given, the switch writes `HEAD` as a symbolic ref to `refs/heads/<name>` and does
  nothing else: no index read, no index lock, no worktree write, no reflog line, no `post-checkout`,
  no `removeBranchState`, no branch ref, no `branch.*` config (`track` / `noTrack` ignored). It still
  refuses before any write, in this order: `detach` (`INVALID_OPTION { option: 'createBranch' }`),
  the name (`INVALID_REF`), an existing branch (`BRANCH_EXISTS`). A held `HEAD.lock` refuses with the
  ref store's `REF_LOCKED`. In a linked worktree, only that worktree's HEAD moves. Result:
  `{ branch: refs/heads/<name>, id: zeroOid, detached: false, changedPaths: 0 }` (D4).
- **R2 — axis 2, unborn and a start point that does not resolve.** With `createBranch`:
  `CHECKOUT_START_POINT_NOT_COMMIT { revision: <rev as given>, branch: <name> }`. Without:
  `PATHSPEC_NO_MATCH { pattern: rev, patterns: [rev] }`. Nothing changes on disk. Both are produced
  by the existing `unresolvedSwitch`; R2 only requires that nothing throws before it.
- **R3 — axis 3, unborn and a start point that resolves to a commit.** Plain, `detach` and
  `createBranch` switches run exactly as from a born HEAD, with three substitutions. (a) `oldOid` is
  `zeroOid`, so the HEAD reflog's old-oid column and `post-checkout`'s first argument are the null
  oid. (b) The reflog label is the unborn branch's short name (`moving from o to main`), which is
  what `headCheckoutLabel` already gives for a symbolic HEAD. (c) The two-way "old" side is the
  empty tree when the index file exists, and `{}` (initial checkout) when it does not; `force` still
  means `{}`.
- **R4 — axis 4, born HEAD and `rev` omitted.** An omitted `rev` means `HEAD`: `createBranch`
  creates at HEAD with start-point spelling `HEAD`; `detach` detaches at HEAD and labels the reflog
  `HEAD`; neither stays on HEAD with no reflog line. **Unborn HEAD and `rev` omitted without
  `createBranch`** refuses before any read or write, with D2's code. (These rows exist only if D1
  makes `rev` omissible in that shape; under D1-B, H2–H5 stay type errors and keep today's runtime
  `INVALID_OPTION`.)
- **R5 — axis 5.** `branch.create` is unchanged.
- **R6 — output.** No new result field. Error codes per D2. `CheckoutSwitchOptions.rev` per D1.
- **R7 — axis 6, the two-way carry against a file/directory swap (ADR-1201; D6, D7).** Applies
  wherever `materializeTree` runs the two-way merge (`headTree` given, born or unborn HEAD): the
  checkout switch, and merge's fast-forward and squash. A *kept* path is a stage-0 index entry the
  two-way rule leaves alone because HEAD and the target agree on it (both lack it included). A
  *written* path is a target path where HEAD and the target disagree. When a written path and a
  kept path collide as file and directory:
  - (a) **kept file `p`, written `p/…`.** `p` is never in the resulting index. If no file stands at
    `p` on disk, the switch proceeds (A5; a directory at `p` is not pinned). If a file stands there, the switch refuses with
    `CHECKOUT_OVERWRITE_DIRTY { localChanges: [], untracked: [p] }` (merge: `WORKING_TREE_DIRTY`,
    same fields), nothing written (A1, A3, A6, M1, M3). The one exception: `core.ignoreCase` is
    true and the file's stat matches `p`'s index entry (a racy match decided by content, as
    `matchesCachedStat` does). Then the file is removed and `p/…` written (A2, A4, M2, M4). The
    refusal class is `untracked` even when the file was modified after staging (A2d, A6), never
    `localChanges`.
  - (b) **kept `p/…`, written file `p`.** Each kept entry below `p` is judged as a deletion. Up to
    date: removed from the index and the disk, and `p` written (V1, V4). Modified: refuse
    `localChanges: [p/…]` (V3). An untracked file under `p`: refuse `untracked: [p]` (V2).
    `core.ignoreCase` plays no part.
  - (c) **Bounds.** A written path that collides with no kept path changes nothing. A target path
    HEAD and the target agree on is kept, not written, so it displaces nothing (A11). An unstaged
    `p` is not kept (it is not in the index) and still refuses `untracked: [p]` (A9). A staged `p`
    equal to HEAD's `p` is not kept (HEAD and target disagree on it), so it is an ordinary deletion
    (A7). One that differs from both refuses `localChanges: [p]` through `carryStagedChanges` (A8).
    A forced switch passes no `headTree` and is unchanged (A10). The three-way merge and rebase
    refuse a staged change before the carry (M5, M6).

### Every pinned row against its requirement

| Rows | Req | Walk |
|---|---|---|
| U1, U4, U7, U10–U13, U15–U18 | R1 | symref only: no index, no reflog, no hook, no branch state. U7: `refResolvesForReading(refs/heads/main)` is false on an unborn `main`, so `BRANCH_EXISTS` does not fire, and the symref rewrite is a byte-identical HEAD write. U18: `refResolvesForReading` is false for an unborn branch held by another worktree, so no refusal (git: none) |
| U3 | R1 | ignored because `branchCreate` is never called — R1 must say so (it does) |
| U5, U6, U8 | R1 | refusal order: `assertBranchCreatable` today checks detach → name → existence, so it is reused unchanged |
| U14 | R1 | git exits 255 *after* printing "Switched"; HEAD is unchanged on both sides. The data agrees (refusal, HEAD unchanged); exit code 255 vs a throw is the only mapping |
| U2, U9, S4, S5 | — | no `-B` / `--orphan` / `switch` surface in tsgit: out of scope |
| S1–S3, S6 | R2 | `unresolvedSwitch` with `createBranch` |
| S7 | R2 | `unresolvedSwitch` without. In git the two words are both pathspec misses |
| F1–F4, F6–F8, F10, F12, F13 | R3 | empty-tree "old" side (index file exists) or `{}` (F10, F12: no index file; F12 forced) |
| F5 | R3 | needs the empty tree. A scratch mutant returning `{}` here (one-way) switches with exit 0 and silently replaces the staged `f` with `side`'s. This row is the mutation killer for R3(c) |
| F9 | R3 | index file exists and is empty: the empty tree. The untracked-occupant check refuses identical content, as git does |
| F11 | R3 | no index file → `{}`, the existing initial-checkout path; it already refuses identical untracked content |
| F14, F15 | R3 | no new logic: interop rows only |
| G1, G9 | R7(a) | re-pinned as A1–A4 per `core.ignorecase`: under `ic=F` today's refusal is already git's, under `ic=T` git switches |
| A1–A6, M1–M4 | R7(a) | §7: the forward collider leaves the carry. A stat-clean one under `ignoreCase` meets the one-way diff as a deletion, so `scope.removed` clears the leading obstruction. Any other one leaves the diff too, so `classifyLeadingObstruction` names it `untracked` when a file stands there (A1, A3, A6) and finds nothing when none does (A5). A5 also fixes today's index that holds both `dir` and `dir/x` |
| V1–V4 | R7(b) | §7: the reverse collider leaves the carry and meets the one-way diff as a deletion, so its own dirty check gives `localChanges: ['dir/x']` (V3), and `holdsSurvivor` on the added `dir` gives `untracked: ['dir']` (V2) |
| A7–A11, M5, M6 | R7(c) | unchanged paths: A7/A8 never enter the kept set; A9 is not in the index; A10 has no `headTree`; A11's target path is kept; M5/M6 refuse earlier. After = main on every one |
| H1–H3 | R4 | `rev ?? 'HEAD'` before resolution; `createRequestedBranch` receives `finish.arg === 'HEAD'` (git: `Created from HEAD`) |
| H4, H5 | R4 | D2 |
| B1–B3 | R5 | unchanged |

The walk found four gaps that the summary rules missed. (1) R3(c) must keep the
"index never written → `{}`" branch *ahead* of the unborn branch. The
alternative (always use the empty tree on an unborn HEAD) gives the same answer on F10–F12 in the
scratch run, but it changes nothing observable while it widens the edit. It is rejected as scope,
not as fault. (2) U18: git lets a second worktree take an unborn branch name that another worktree's
HEAD already names. R1 must not add a "checked out elsewhere" guard. (3) R7: the collision is
computed against the *written* target paths, not the whole target. Against the whole target, A11
would drop the staged `dir` that git keeps. (4) R7(a): sending every forward collider to the one-way
diff (the first revision's "the one-way path matches git on G1") is wrong twice over. It switches
on A3 where git refuses under `ic=F` (the one-way diff reads no config), and it names A6
`localChanges` where git says `untracked`. Both are read from `apply-changeset.ts`
`evaluateChangedPath`, whose content compare judges a deletion. Not run as a scratch mutant.

## Design

### 1. Option shape (D1 = A shown; B is a type-only variant)

```ts
export interface CheckoutSwitchOptions {
  /** The commit to switch to; omitted means HEAD, as git's bare `checkout [-b <name>]`. */
  readonly rev?: string;
  readonly detach?: boolean;
  readonly force?: boolean;
  readonly createBranch?: CheckoutCreateBranch;
}

const isPaths = (opts: CheckoutOptions): opts is CheckoutPathsOptions =>
  'paths' in opts && opts.paths !== undefined;
const isSwitch = (opts: CheckoutOptions): opts is CheckoutSwitchOptions => !isPaths(opts);

/** Refuses `rev` with `paths`. */
const assertSingleCheckoutMode = (opts: CheckoutOptions): void => {
  if (isPaths(opts) && 'rev' in opts && opts.rev !== undefined) {
    throw invalidOption('paths', 'cannot be combined with rev');
  }
};
```

The "neither" refusal disappears: `{}` is git's bare `checkout`. The `rev` + `paths` guard keeps its
code and reason. `checkoutInScope` keeps `isPaths(opts) ? pathRestore : switchBranch`.

### 2. `switchBranch` — read HEAD as possibly unborn, and branch on it

```ts
const switchBranch = async (ctx: Context, opts: CheckoutSwitchOptions): Promise<CheckoutResult> => {
  const priorHead = await readHeadRaw(ctx);
  if (priorHead.kind !== 'symbolic') await assertEverySourceLoadable(ctx);
  const headOid = await resolveRefOrMissing(ctx, HEAD_NAME);
  if (opts.rev === undefined && headOid === undefined) return switchUnbornToNewBranch(ctx, opts);
  return switchToCommit(ctx, { ...opts, rev: opts.rev ?? HEAD_NAME }, priorHead, headOid);
};
```

- `resolveRefOrMissing` answers `undefined` only for a chain that ends missing. A cycle, a broken
  ref or an invalid name still propagates, as `resolveRef` did.
- `switchToCommit` is today's body, from `resolveCommitSwitch` on, with
  `oldOid = headOid ?? zeroOid(ctx.hashConfig)` and `headOid` threaded to `headTreeOption` through
  `SwitchRequest` (one new field, `bornHead: boolean`, or the `ObjectId | undefined` itself). It
  stays under 20 lines by keeping today's split.
- Normalising `rev` to `HEAD` once means `previousCheckoutArg`, `resolveSwitch`, `staysOnHead` and
  `createRequestedBranch` keep their `string` parameter. H3 reaches `staysOnHead` (no reflog line),
  H2 detaches with the label `HEAD`, H1 creates the branch from `'HEAD'`.

### 3. `switchUnbornToNewBranch` — git's `switch_unborn_to_new_branch`

```ts
/** git's `switch_unborn_to_new_branch`: an unborn HEAD only changes the branch it names. */
const switchUnbornToNewBranch = async (
  ctx: Context,
  opts: CheckoutSwitchOptions,
): Promise<CheckoutResult> => {
  const request = opts.createBranch;
  if (request === undefined) throw unbornHeadRefusal();   // D2
  await assertBranchCreatable(ctx, opts);
  const target = validateRefName(`${HEADS_PREFIX}${request.name}`);
  await getRefStore(ctx).applyRefUpdates([{ kind: 'setSymbolic', name: HEAD_NAME as RefName, target }]);
  return { branch: target, id: zeroOid(ctx.hashConfig), detached: false, changedPaths: 0 };
};
```

- No `reflog` on the update: git's symref update on a null-oid HEAD logs nothing (U10), and
  `applyRefWrite` skips the reflog when the field is absent, on both backends (probed).
- `assertBranchCreatable` already validates the name. To avoid validating twice, it can return the
  validated `RefName`; that is a planning detail.
- `withFilterProcessPool` and the progress `start` / `end` around it stay. The pool spawns nothing
  unless a filter runs.

### 4. `headTreeOption` — the empty tree for an unborn HEAD with a written index

```ts
const headTreeOption = async (
  ctx: Context,
  opts: CheckoutSwitchOptions,
  currentIndex: GitIndex,
  headOid: ObjectId | undefined,
): Promise<{ readonly headTree?: ObjectId }> => {
  if (opts.force === true) return {};
  if (await indexNeverWritten(ctx, currentIndex)) return {};
  if (headOid === undefined) return { headTree: emptyTreeOid(ctx.hashConfig) };
  return { headTree: (await readTree(ctx, headOid)).id };
};
```

- The doc comment's "an index that was never written is an initial checkout" keeps its meaning. The
  existing `unborn` local is renamed `indexNeverWritten`, because "unborn" now means the HEAD.
- `readTree(emptyTreeOid)` is not needed: `materializeTree` diffs `headTree` against the target
  through `diffTreesPruned`, and `object-resolver.ts` serves the empty tree virtually.
- `stash.ts` `headTreeOrEmpty` stays as it is. It catches `NO_INITIAL_COMMIT` from
  `resolveHeadCommit`, a different reader; sharing would be a refactor this change does not need.

### 5. Error data shapes (ADR-249)

| Row | Code and fields |
|---|---|
| S1–S3, S6 | `CHECKOUT_START_POINT_NOT_COMMIT { revision, branch }` (existing) |
| S7 | `PATHSPEC_NO_MATCH { pattern, patterns }` (existing) |
| F5, F9, F11, A1–A3, A6, V2, V3 | `CHECKOUT_OVERWRITE_DIRTY { localChanges, untracked }` (existing) |
| M1, M3 | `WORKING_TREE_DIRTY { localChanges, untracked }` (existing; `merge.ts` maps the checkout refusal) |
| U5 / U6 / U8 / U14 | `INVALID_OPTION` / `INVALID_REF` / `BRANCH_EXISTS` / `REF_LOCKED` (existing) |
| H4, H5 | D2 |

Interop tests rebuild git's view from these fields: S1 ↔ `'<revision>' is not a commit and a branch
'<branch>' cannot be created from it`; S7 ↔ `pathspec '<pattern>' did not match`; H4/H5 ↔ `You are
on a branch yet to be born`.

### 6. Docs

- `docs/use/commands/checkout.md`: the signature block (`rev?`, per D1); the Modes table gains
  "Create on an unborn branch: `{ createBranch }` with no `rev`" and states that an omitted `rev`
  means HEAD. Add a Behaviour bullet saying that a switch from an unborn branch uses the empty tree
  as the old side (staged additions carried, a staged path the target changes refuses, an untracked
  occupant refuses even when its content is identical). Add a Behaviour bullet for R7: a staged
  path HEAD and the target both lack is dropped where the target needs its place for a file or a
  directory. A staged directory's files are judged like deletions. A staged file blocks the switch
  as an untracked occupant, unless `core.ignoreCase` is set and the file is unchanged since it was
  staged. Errors: **replace** the `REF_NOT_FOUND`
  line (HEAD unborn no longer refuses) with D2's code. **Delete** the `BRANCH_NOT_FOUND` line: the
  switch never raises it (`command grep -c "branchNotFound\|BRANCH_NOT_FOUND"
  src/application/commands/checkout.ts` ⇒ 0). An unresolvable `rev` is `PATHSPEC_NO_MATCH`, as the
  Behaviour section already says.
- `reports/api.json`: regenerated (`rev` optional).
- `docs/use/commands/merge.md`: the checkout paragraph (the one ending "The checkout follows git's
  two-way rule: … (a staged change survives a fast-forward) …") gains the R7 qualifier. A staged
  path HEAD and the result both lack does not survive when the result needs its place for a file
  or a directory. It is dropped, or refuses `WORKING_TREE_DIRTY` as above (M1–M4).
- `docs/BACKLOG.md`: tick 32.41 and strike it in release-order row 3. The corrected statement above
  is recorded here, not in the tick.

### 7. `materialize-tree.ts` — the carry yields to a written path it collides with (R7)

Current shape (unchanged signatures, all private to the module):

```ts
const carryHeadAgreement = async (
  ctx: Context, opts: MaterializeTreeOpts, allTarget: ReadonlyArray<TargetEntry>,
): Promise<CarriedOpts>;                       // { opts, allTarget, carried }
const agreementWithHead = async (…): Promise<HeadAgreement>;   // untouched
const leadingDirectoriesOf = (path: string): string[];          // reused
const sparseMovers = (…): Set<IndexPathKey>;                    // untouched
const stagedOutsideTarget = (…): IndexEntry[];                   // untouched
```

Today `isKept = agreed(key) && !movers.has(key)`. Every kept entry leaves `opts.currentIndex`, its
target twin leaves `allTarget`, and it is re-appended by `assembleIndexEntries`. Nothing compares
it to the target paths the switch writes. The edit splits the kept set by collision.

```ts
interface Displaced {
  /** Leave the carry and meet the one-way diff as deletions: dirty-checked, then removed. */
  readonly uncarried: ReadonlySet<IndexPathKey>;
  /** Leave the carry and the diff: an added path meets the file as a leading obstruction. */
  readonly dropped: ReadonlySet<IndexPathKey>;
}

/** git's icase_exists: under core.ignoreCase, a stat-clean tracked file in an added path's way may go. */
const obstructionMayGo = async (ctx: Context, index: GitIndex, entry: IndexEntry): Promise<boolean> => {
  const absPath = joinPath(requireWorkTree(ctx, 'materializeTree'), escapedPathOf(entry));
  const stat = await lstatIfReachable(ctx.fs, absPath);
  if (stat === undefined) return false;
  return matchesCachedStat({ entry, indexMtime: index.indexMtime }, absPath, stat, racyContentMatcher(ctx));
};

/** Kept entries a written target path displaces: git replaces them as it adds the written path. */
const displacedByTarget = async (
  ctx: Context, index: GitIndex, kept: ReadonlyArray<IndexEntry>, written: ReadonlyArray<TargetEntry>,
): Promise<Displaced> => {
  const files = new Set<string>(written.map((t) => t.path));
  const dirs = new Set<string>(written.flatMap((t) => leadingDirectoriesOf(t.path)));
  const beneath = kept.filter((e) => leadingDirectoriesOf(escapedPathOf(e)).some((d) => files.has(d)));
  const over = kept.filter((e) => dirs.has(escapedPathOf(e)));
  const going = await clearedObstructions(ctx, index, over);   // [] unless core.ignoreCase; config read lazily
  return { uncarried: keysOf([...beneath, ...going]), dropped: keysOf(over.filter((e) => !going.includes(e))) };
};
```

and in `carryHeadAgreement`, after `movers`:

```ts
const agreedKept = (key: IndexPathKey): boolean => agreed(key) && !movers.has(key);
const displaced = await displacedByTarget(
  ctx, opts.currentIndex,
  stageZero.filter((e) => agreedKept(indexPathKey(e))),
  allTarget.filter((e) => !agreedKept(indexPathKey(e))),      // the written paths (R7(c), A11)
);
const isKept = (key: IndexPathKey): boolean =>
  agreedKept(key) && !displaced.uncarried.has(key) && !displaced.dropped.has(key);
// currentIndex for the diff additionally drops `displaced.dropped`
```

- `clearedObstructions` filters `over` by `(await ignoreCase()) && (await obstructionMayGo(…))`. Here
  `ignoreCase = lazily(async () => (await readConfig(ctx)).core?.ignoreCase === true)`
  (`internal/lazily.ts`). The read is lazy by construction: an empty `over` never calls it, so an
  ordinary switch pays no config read and no `lstat`. There is no `over.length === 0` guard, which
  would only be an equivalent mutant. A missing file makes `obstructionMayGo` return `false`: the
  entry is dropped and nothing obstructs (A5).
- No change to `two-way-carry.ts`, `occupant-clash.ts` or `apply-changeset.ts`. The verdicts come
  from the existing pre-flight once the collider is routed: deletion → `scope.removed` /
  `evaluateChangedPath`; dropped → `classifyLeadingObstruction`.
- Whether a forward collider is uncarried or dropped needs config, so it stays in
  `materialize-tree.ts` and not in the pure `carryStagedChanges`. `carryHeadAgreement` is already over
  20 lines, so the planner splits off the `CarriedOpts` assembly as part of this edit.
- The After column of axis 6 ran a scratch copy with this edit, written inline. It matched git on
  every born row under both settings. Proven on that scratch only; the unit and interop rows below
  are the gate.

## Decision candidates

### Ratified (D1–D5)

| # | Choice | Outcome | ADR |
|---|---|---|---|
| D1 | How the no-start-point form is expressed | **A** adopted: `rev?: string`; an omitted `rev` means HEAD; the "neither" refusal goes | ADR-1197 |
| D2 | Refusal for an unborn HEAD with `rev` omitted and no `createBranch` (H4, H5) | **A** adopted: `NO_INITIAL_COMMIT` | ADR-1198 |
| D3 | Release marking | **A** adopted: `fix:`. The R7 fold also only removes refusals git does not make (A2, A4, A5, V1, M2, M4) and corrects one class (V3 `untracked` → `localChanges`), so it fits the same marking | ADR-1199 |
| D4 | `CheckoutResult.id` after U1 | **A** adopted: `zeroOid(ctx.hashConfig)` | ADR-1200 |
| D5 | G1 / G9 staged file vs target directory | **B** ratified (against the recommendation): fold the two-way carry's d/f divergence in this change, with unit rows and interop pins (DOCTRINE D-2) | ADR-1201 |

### Settled after the axis-6 re-pin (D6 → ADR-1202, D7 → ADR-1203, both ratified as recommended)

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D6 | ADR-1201's premise holds only under `core.ignorecase=true`. Under `false` (the Linux `git init` default) git refuses G1/G9 (A1, A3) exactly as tsgit does today. What does the fold replicate? | **A** git's rule whole (R7(a) as written): the forward collider never stays in the index; its file may go only under `core.ignoreCase` when stat-clean, else `untracked: [p]`. **B** only the setting-independent half: drop the collider from the index when no file stands there (A5) and leave the A2/A4/M2/M4 refusals. A macOS/Windows-initialised repository then keeps diverging. **C** reopen ADR-1201: G1/G9 are a match on Linux, so fold only A5's corrupt index | **A** | A matches git on all 26 born After rows under both settings (scratch run). B and C leave a pinned divergence that the row this change makes reachable inherits (A2), which DOCTRINE D-2 rules out. The `ignoreCase` read is lazy (only when a forward collider exists), so A costs an ordinary switch nothing. A amends ADR-1201's context ("git switches") with the setting; it does not reverse its decision |
| D7 | The mirror direction, staged `p/…` vs a target file `p` (V1–V4): git switches under both settings (`verify_clean_subdirectory`); tsgit refuses `untracked: ['dir']`, and names V3 wrongly. ADR-1201 names only the forward direction | **A** fold it in this change as R7(b). The same `displacedByTarget` partition routes it to the one-way diff, with no extra code path. **B** leave it out: an IMPACT line, then the user files it or not under the ADR-1170 bar | **A** | Same function (`carryHeadAgreement`), same refusal path, same consumers. The V rows become reachable from an unborn HEAD through this change (V4), which is D-2's trigger. The After run shows the routing that fixes the forward direction also fixes V1–V3 with no further edit. Leaving it out means writing code to exclude it |

## Test strategy

### Cross-tool interop — `test/integration/checkout-unborn-switch-interop.test.ts` (new)

Built like `checkout-unborn-path-restore-interop.test.ts`: `GIT_AVAILABLE`, `makePeerPair`,
`initBothRepos`, `runGit` / `tryRunGitWithExit` from `interop-helpers.ts`,
`describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`. Twins are built identically (an
origin repository built once per suite, then each twin is a `git clone` + `checkout --orphan o`, or a
`git init` + `git fetch <origin> main:other`). git runs in one twin, tsgit in the other. Compared
after each call: `cat .git/HEAD` (or the worktree's `rev-parse --git-path HEAD`), `for-each-ref
refs/heads`, `ls-files -s`, `status --porcelain --untracked-files=all`, the last HEAD reflog line
with its two oid columns, whether `logs/HEAD` exists, and the `post-checkout` arguments (the
`hook-args` pattern of the unborn path-restore suite). A refusal is compared field to message as in
§5, never as tsgit text.

- Axis 1: U1, U3 (`branch.x.*` absent from `config --get-regexp`), U4, U5, U6, U7, U8, U10 (with
  `core.logAllRefUpdates=always`; also once under `--ref-format=reftable`, comparing `reflog show
  HEAD` exit status), U11 (`post-checkout` not run), U12, U13, U14, U15, U16, U17, U18.
- Axis 2: S1, S2, S3, S6 (linked), S7 (`HEAD` and `main`).
- Axis 3: F1–F4, F5, F6, F7, F8, F9, F10, F11 (differing / identical / `detach`), F12, F13
  (reftable), F14 (no-cone sparse `/g`), F15.
- Axis 4: H1, H2, H3, H4, H5.
- Axis 6, unborn: A1, A2, A2d, V4. Each row runs twice, with `core.ignorecase` set to `false` and to
  `true` in **both** twins (`git config` in each twin after it is built). The rows then hold on
  Linux CI and macOS alike, and never ride the platform's `git init` default.

### Cross-tool interop — axis 6 on a born HEAD (one pin per affected consumer, D-2)

Every row is run under both `core.ignorecase` values, set in both twins, and compared on `ls-files
-s`, `status --porcelain --untracked-files=all`, the disk shape at `dir` (file content or directory
listing) and HEAD. A refusal is compared field to message (§5). V2 maps `would lose untracked files`
to `untracked`, as `rebase-interop.test.ts` already does.

- Checkout switch — extend `test/integration/checkout-file-directory-swap-interop.test.ts` (its
  `Given main holds file f and side holds directory f/` fixture shape): A3/A4 (one row, two
  settings), A5, A6, A7, A8, A9, A10, A11, V1, V2, V3.
- Merge fast-forward and squash (`attemptNonConflictTree`) — extend
  `test/integration/merge-interop.test.ts` beside `Given a change staged on a path the
  fast-forward leaves alone`: M1/M2 (one row, two settings) and M3/M4.
- Three-way merge and rebase are not affected (M5, M6 refuse before the carry), so they get no pin.
  Their existing staged-change refusal rows stay as they are.

### Unit tests (memory adapter)

- `test/unit/application/commands/checkout.test.ts`:
  - flip `Given neither rev nor paths` and the `rev: undefined` row near it. On a born seed, `{}` and
    `{ rev: undefined }` succeed with `{ branch: refs/heads/<current>, detached: false }`, no new
    reflog line and HEAD's id. Add an unborn twin that refuses with D2's code (assert `data`
    exactly).
  - keep `rev` + `paths` → `INVALID_OPTION { option: 'paths', reason: 'cannot be combined with rev' }`.
  - extend `Given an unborn branch with a staged file ($algorithm)` (sha1 + sha256) with switch rows.
    `{ rev: <commit-backed branch> }` succeeds; post-checkout args are `[<null>, <id>, '1']`; the
    HEAD reflog's `oldId` is the null oid with the message `checkout: moving from main to <b>`.
  - R3(c) isolated guards: F5 (index file present, empty-tree "old" side refuses a staged change),
    F11 (no index file → initial checkout refuses the untracked occupant), F12 (force → `{}`). Each
    kills one branch of `headTreeOption`.
- `test/unit/application/commands/checkout-create-branch.test.ts`:
  - `Given an unborn HEAD, When checkout creates a branch with no start point`: HEAD file is
    `ref: refs/heads/x\n`; no `refs/heads/x`; index bytes unchanged; no `logs/HEAD`; no
    post-checkout call (`MemoryHookRunner`); `MERGE_MSG` kept; `track` given → no `branch.x.*`
    config; result as R1.
  - guard order, each isolated: `detach` → `INVALID_OPTION { option: 'createBranch' }`; `x..y` →
    `INVALID_REF`; existing branch → `BRANCH_EXISTS`; same name as the unborn branch → succeeds.
  - a held index lock (`index.lock` present) does not refuse; a corrupt index does not refuse.
  - S1–S3: `{ rev: 'HEAD' | '@' | 'main', createBranch }` → `CHECKOUT_START_POINT_NOT_COMMIT` with
    both fields.
  - H1: born `{ createBranch: { name: 'x' } }`: x at HEAD, branch reflog `branch: Created from HEAD`.
- `test/unit/application/commands/checkout-switch-target.test.ts`: S7, `{ rev: 'HEAD' }` and
  `{ rev: 'main' }` on an unborn HEAD → `PATHSPEC_NO_MATCH { pattern, patterns }`.
- `test/unit/application/commands/checkout-head-stay.test.ts`: H2 (`{ detach: true }` on a born
  HEAD detaches, reflog `moving from main to HEAD`) and H3 (`{}` writes no reflog line).
- Linked-worktree unit rows only where the memory context already models a linked worktree.
  Otherwise U16–U18 rest on the interop suite.
- `test/unit/application/primitives/materialize-tree.test.ts`, inside `describe('materializeTree
  carrying staged changes (headTree)')`. Add a sibling fixture: head `f`, target `f` + `d/x`; and
  the mirror, head `f`, target `f` + file `d`. `core.ignorecase` is written with
  `ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n\tignorecase = true\n')`, the pattern
  the filter rows at line ~1090 use. A stat-clean entry is built with `indexEntryFromStat`
  (`src/application/primitives/internal/index-entry-from-stat.ts`) from the work file's `lstat`,
  so its cached stat matches.
  - `Given a staged file d neither head nor target has, and a target writing d/x`:
    - `When ignorecase is unset` → `CHECKOUT_OVERWRITE_DIRTY { localChanges: [], untracked: ['d'] }`
      (A3).
    - `When ignorecase is true and d is unchanged since staging` → no `d` in `newIndexEntries`,
      `d/x` present, `d` a directory on disk (A4).
    - `When ignorecase is true and d was modified after staging` → `untracked: ['d']`, not
      `localChanges` (A6). This kills a mutant that routes every forward collider to the diff.
    - `When d is absent from disk` (both settings, `it.each`) → `newIndexEntries` holds `d/x` and
      no `d` (A5). This kills the mutant that keeps the dropped entry in the index.
  - `Given a staged d/x neither head nor target has, and a target writing file d`: clean → `d/x`
    gone, `d` written (V1); `d/x` modified → `localChanges: ['d/x']` (V3); untracked `d/u` →
    `untracked: ['d']` (V2).
  - `Given head and target agree on d/x and the index stages file d in its place` → `d` kept, `d/x`
    absent from the index, no refusal (A11). This kills the mutant that computes collisions against
    the whole target.
- `test/unit/application/commands/checkout.test.ts`, unborn block: G1 (A1/A2) through `checkout`,
  one row per setting, so the R3 path and the R7 carry are proven together.
- `test/unit/application/commands/merge.test.ts` (fast-forward block): M2 and M1, one row each.

### Property tests

None. No parser, decoder, matcher or serializer is touched (lenses 1–4 do not apply).

### Mutation notes

- `opts.rev === undefined && headOid === undefined`: three isolated rows kill the `&&` → `||`
  mutant and each operand's `true` / `false` mutants: born + `rev` omitted (H3), unborn + `rev`
  given (F1), unborn + omitted (U1).
- `opts.rev ?? HEAD_NAME`: H1's branch reflog `Created from HEAD` kills the string-literal mutant.
- `headTreeOption`: F5 / F11 / F12 / a born switch, one per branch. `emptyTreeOid` vs `{}` is
  distinguishable only through F5.
- `switchUnbornToNewBranch` returns `changedPaths: 0`, `detached: false`, the null `id`: assert the
  whole result object.
- Assert `err.data` fully; never `toThrow(TsgitError)` alone.
- `displacedByTarget`: `beneath` vs `over` is killed by V1 vs A4. The `files` / `dirs` sets are
  killed by V1 / A4 respectively. The `written` filter (`!agreedKept`) is killed by A11.
  `ignoreCase === true` is killed by A3 vs A4, the stat match by A6, the missing-file `false` by
  A5, and `dropped` leaving `currentIndex` by A5.
- Stryker scope: `checkout.ts`, on the narrowed eponymous suites `checkout*.test.ts`; and
  `materialize-tree.ts`, on `materialize-tree*.test.ts` + `internal/two-way-carry.test.ts`. Per
  the narrowed-corpus rule, a survivor only `merge.test.ts` would kill is hand-verified against the
  full covering set.

## Out of scope

- **`-B`, `--orphan`, `switch -c/-C`** (U2, U9, S4, S5): tsgit has no such surface.
- **A case-only alias** under `core.ignorecase=true` (staged `DIR` against a target `dir/x`): git's
  `icase_exists` looks the index up case-insensitively, and R7 matches the exact path only. Not
  pinned. To prove it: an axis-6 twin pair on a case-insensitive filesystem, staged `DIR`, `checkout
  tgt`, compared with `ls-files -s`.
- **`reference-transaction` hook** (U11): git runs it on the symref update; tsgit runs that hook for
  no ref update anywhere (`command grep -rn "reference-transaction" src` ⇒ one comment in
  `reftable-transaction.ts`, no hook call). It is a project-wide hook gap, not this change's.
- **Exit status 255 with "Switched" on a held `HEAD.lock`** (U14): git's message and its exit code
  disagree. The data (HEAD unchanged) agrees, and tsgit throws.
- **An unborn HEAD whose branch ref is broken** (content that does not parse): `resolveRefOrMissing`
  propagates the read failure, as `resolveRef` did. Not pinned.
