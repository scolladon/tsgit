# Design — checkout-branch-on-unborn-head

> Brief: backlog 32.41 — `checkout` cannot create a branch on an unborn HEAD (git's `checkout -b x`
> with no start point), and a start point given on an unborn HEAD throws `REF_NOT_FOUND` where git
> refuses `'<rev>' is not a commit and a branch '<name>' cannot be created from it`. Folded: every
> switch FROM an unborn HEAD to a real commit refuses in tsgit and succeeds in git.
> Status: draft → self-reviewed ×3

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
| `src/application/primitives/materialize-tree.ts` | `MaterializeTreeOpts.headTree`, `carryHeadAgreement`, `agreementWithHead` | the two-way rule; `readTree(emptyTreeOid)` is served virtually by `object-resolver.ts` |
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
| G1 | fetched + staged file `dir`, target has `dir/x` (×3) | 0; staged `dir` dropped from index and disk, `dir/x` and `f` written | `REF_NOT_FOUND` | `CHECKOUT_OVERWRITE_DIRTY { untracked: ['dir'] }` — **differs**, see G9 and D5 |
| G9 | **born** `main` (`f` only) + staged `dir`, `checkout tgt` (has `dir/x`) | 0, same as G1 | `CHECKOUT_OVERWRITE_DIRTY { untracked: ['dir'] }` on main | unchanged: a pre-existing born-HEAD divergence that G1 inherits (D5) |

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
| G1, G9 | — | **not met**: a born-HEAD d/f divergence in `materializeTree`'s two-way carry that the unborn path inherits. The same scratch mutant (`{}`, one-way) matches git on G1, so the gap is located in `carryHeadAgreement` / `agreementWithHead`, not in the one-way diff. D5 |
| H1–H3 | R4 | `rev ?? 'HEAD'` before resolution; `createRequestedBranch` receives `finish.arg === 'HEAD'` (git: `Created from HEAD`) |
| H4, H5 | R4 | D2 |
| B1–B3 | R5 | unchanged |

The walk found two gaps that the summary rule missed. (1) R3(c) must keep the
"index never written → `{}`" branch *ahead* of the unborn branch. The
alternative (always use the empty tree on an unborn HEAD) gives the same answer on F10–F12 in the
scratch run, but it changes nothing observable while it widens the edit. It is rejected as scope,
not as fault. (2) U18: git lets a second worktree take an unborn branch name that another worktree's
HEAD already names. R1 must not add a "checked out elsewhere" guard.

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
| F5, F9, F11 | `CHECKOUT_OVERWRITE_DIRTY { localChanges, untracked }` (existing) |
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
  occupant refuses even when its content is identical). Errors: **replace** the `REF_NOT_FOUND`
  line (HEAD unborn no longer refuses) with D2's code. **Delete** the `BRANCH_NOT_FOUND` line: the
  switch never raises it (`command grep -c "branchNotFound\|BRANCH_NOT_FOUND"
  src/application/commands/checkout.ts` ⇒ 0). An unresolvable `rev` is `PATHSPEC_NO_MATCH`, as the
  Behaviour section already says.
- `reports/api.json`: regenerated (`rev` optional).
- `docs/BACKLOG.md`: tick 32.41 and strike it in release-order row 3. The corrected statement above
  is recorded here, not in the tick.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | How the no-start-point form is expressed | **A** `rev?: string` on `CheckoutSwitchOptions`. An omitted `rev` means HEAD; unborn + `createBranch` → symref; unborn without → D2. `isSwitch` becomes `!isPaths`, and the "neither" refusal goes. **B** a discriminated variant: `{ rev: string; … } \| { rev?: undefined; createBranch: CheckoutCreateBranch; detach?: undefined; force?: boolean }`. Only `-b` may omit `rev`; `{}` and `{ detach: true }` stay type errors and runtime `INVALID_OPTION`. **C** a separate `orphan` option (git `--orphan`) | **A** | A mirrors git's argv: an absent start point is HEAD. H1–H3 match git with no extra code (scratch run), and it removes a refusal git does not make (`{}` is a no-op in git). B keeps that refusal and adds a union to every reader of the type. C is a wider feature (an orphan from a *born* HEAD discards the index's parent) that no pinned row needs |
| D2 | Refusal for an unborn HEAD with `rev` omitted and no `createBranch` (H4, H5; reachable only under D1-A, because under D1-B `assertSingleCheckoutMode` keeps refusing that shape first) | **A** reuse `NO_INITIAL_COMMIT` (existing member, no fields; already raised by `stash` and `history-rewrite` for an unborn HEAD). **B** a new `CHECKOUT_UNBORN_HEAD` member. **C** keep `INVALID_OPTION { option: 'rev' }` with a new reason | **A** | The condition is the one `NO_INITIAL_COMMIT` already names (HEAD has no commit). No union change and no `api.json` error entry. B adds a member for the same condition; C reports a valid option shape as invalid |
| D3 | Release marking | **A** `fix:`. **B** `fix!:`. **C** `feat:` | **A** | Facts: (1) refusals git does not make are removed (U1, F1–F15, H1–H3). (2) Codes move between existing members: `REF_NOT_FOUND` → `CHECKOUT_START_POINT_NOT_COMMIT` / `PATHSPEC_NO_MATCH` (S1–S7), and `INVALID_OPTION` → `NO_INITIAL_COMMIT` (H4/H5 under D2-A). (3) An input field is widened from required to optional: source-compatible for callers, but `api.json` changes and a reader of `CheckoutSwitchOptions['rev']` now sees `string \| undefined`. (4) `docs/use/commands/checkout.md` documents `REF_NOT_FOUND` for an unborn HEAD today. Precedents ADR-1048 / ADR-1196 shipped (1) + (2) as `fix`. No union member is removed (ADR-1024) and no new refusal is added where tsgit returned (ADR-1190). B is right if the user counts a documented code change, (4), as a break. C is right if a widened input counts as a feature |
| D4 | `CheckoutResult.id` after U1 (HEAD stays unborn) | **A** `zeroOid(ctx.hashConfig)`. **B** widen to `id: ObjectId \| undefined` | **A** | Precedent: `pathRestore` already reports the null oid for an unborn HEAD, and git hands its hooks the same. B breaks every reader of `id` for one row |
| D5 | G1 (unborn) / G9 (born): staged file `dir` vs target `dir/x`. git drops the staged file and switches (×3, exit 0); tsgit refuses `CHECKOUT_OVERWRITE_DIRTY { untracked: ['dir'] }` | **A** out of this change: report it (IMPACT line) and let the user decide whether to file it above the ADR-1170 bar. G1 ships as a pinned known difference in the interop suite (a `describe` that asserts both outcomes and links to the filed item, or no row). **B** fold it: change `materializeTree`'s d/f occupant judgement for a staged-but-not-in-HEAD file | **A** | The divergence exists on a born HEAD on main today (G9), in `materialize-tree.ts`'s two-way carry (`carryHeadAgreement` / `agreementWithHead`; the one-way path matches git on G1), which this change does not edit. Folding widens the change into the shared materialiser that every switch, `reset` and merge uses, on a row that loses staged content in git (the blob stays in the store) |

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
- G1 per D5.

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
- Stryker scope: `checkout.ts`, on the narrowed eponymous suites `checkout*.test.ts`.

## Out of scope

- **`-B`, `--orphan`, `switch -c/-C`** (U2, U9, S4, S5): tsgit has no such surface.
- **G1 / G9** staged-file vs target-directory: D5.
- **`reference-transaction` hook** (U11): git runs it on the symref update; tsgit runs that hook for
  no ref update anywhere (`command grep -rn "reference-transaction" src` ⇒ one comment in
  `reftable-transaction.ts`, no hook call). It is a project-wide hook gap, not this change's.
- **Exit status 255 with "Switched" on a held `HEAD.lock`** (U14): git's message and its exit code
  disagree. The data (HEAD unchanged) agrees, and tsgit throws.
- **An unborn HEAD whose branch ref is broken** (content that does not parse): `resolveRefOrMissing`
  propagates the read failure, as `resolveRef` did. Not pinned.
