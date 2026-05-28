# Design — Phase 20.4 Merge State Machine (`abortMerge`, `continueMerge`)

**Status:** Draft (target: Accepted at `<sha-after-merge>`).

Backlog: **20.4** — _"Merge state machine — `abortMerge`, `continueMerge`. Prereq for cherry-pick / rebase conflict flow."_

ADRs: 170 (hard-reset semantics for abort) · 171 (`NO_OPERATION_IN_PROGRESS` error shape) · 172 (flat surface — `abortMerge`/`continueMerge`) · 173 (`continueMerge` delegates to `commit`).

## 1. Goal

Two new Tier-1 commands on `repo.*` that move the merge state machine off
"the user has to know to run `reset --hard ORIG_HEAD`":

1. **`abortMerge`** — undo a conflicting merge. Restore the working tree
   and index to the pre-merge state, then delete the merge-state files.
   Mirrors `git merge --abort`.
2. **`continueMerge`** — finalise a conflicting merge once the user has
   staged the resolved files. Mirrors `git merge --continue`.

Both refuse with `NO_OPERATION_IN_PROGRESS` when `MERGE_HEAD` is absent.

### 1.1 Why now

Phase 22 (`cherry-pick`, `revert`, `rebase`) reuses the conflict
persistence machinery that Phase 13.4b put in place — `MERGE_HEAD`,
stage-1/2/3 index entries, marker bytes in the working tree. The
state machine that ends those operations (`abort`, `continue`) is the
shared building block. Shipping it under the `merge` umbrella first:

- isolates the semantics inside a well-understood command,
- gives Phase 22 a sibling pattern to copy (`abortCherryPick`,
  `continueRebase`, …),
- closes the "v1 user must know about ORIG_HEAD" usability gap called
  out in Phase 13.4b §7 ("Out of scope — `git merge --abort`").

## 2. Out of scope (does NOT ship in 20.4)

- `git reset --merge` semantics that preserve uncommitted pre-merge
  local changes. `abortMerge` is a hard reset to `ORIG_HEAD`. Anything
  uncommitted before the merge is lost. The simpler model is
  documented at the surface and tested.
- Cherry-pick / rebase / revert abort+continue. The mechanism lands
  in Phase 22 reusing the same primitives.
- Interactive conflict resolution helpers (`mergetool`, etc.).
- `MERGE_AUTOSTASH` / autostash recovery. Canonical git's autostash
  flow is out of scope; tsgit's `merge` does not autostash today.

## 3. Surface

Two new Tier-1 commands. Both bound under `repo.*` alongside `merge`.

```typescript
// abortMerge — restore pre-merge state.
export interface AbortMergeResult {
  /** The commit `ORIG_HEAD` pointed at; this is where HEAD now sits. */
  readonly origHead: ObjectId;
  /** The branch HEAD is on (always defined — detached merges are rejected upstream). */
  readonly branch: RefName;
}

export const abortMerge = (ctx: Context): Promise<AbortMergeResult>;

// continueMerge — finalise the resolution as a merge commit.
export interface ContinueMergeOptions {
  /** Override `MERGE_MSG`. Empty/undefined falls back to the draft. */
  readonly message?: string;
  /** Forwarded to commit. */
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
  /** Skip the `pre-commit` and `commit-msg` hooks. */
  readonly noVerify?: boolean;
}

export type ContinueMergeResult = CommitResult; // shape is identical to commit's

export const continueMerge = (
  ctx: Context,
  opts?: ContinueMergeOptions,
): Promise<ContinueMergeResult>;
```

Both are bound on the `Repository` handle as flat methods (ADR-172):

```typescript
repo.abortMerge();
repo.continueMerge({ message: 'resolve conflicts' });
```

### 3.1 Why two methods rather than `repo.merge.abort()` / `repo.merge.continue()`?

Considered. Rejected because:

- `repo.merge` is a function, not a namespace. Turning it into a
  callable object adds a non-trivial typing dance (overloaded call
  signature + properties) for marginal gain.
- The "two namespaces" precedent isn't established elsewhere on the
  surface (`branch`, `tag`, `sparseCheckout` all use a single
  function with an `action` discriminator; `checkout`, `reset`,
  `commit` are flat).
- Phase 22 will need `abortCherryPick`/`continueCherryPick`,
  `abortRebase`/`continueRebase`. Flat methods compose naturally
  into a state-machine surface; nested namespaces don't.

ADR-172 captures the choice.

## 4. Behaviour

### 4.1 `abortMerge` — the state transitions

| Pre-condition                                                  | Result                                                                                         |
|----------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| `MERGE_HEAD` absent                                            | throw `NO_OPERATION_IN_PROGRESS` with `operation: 'merge'`                                     |
| `MERGE_HEAD` present, `ORIG_HEAD` absent                       | throw `NO_OPERATION_IN_PROGRESS` (corrupt state — `ORIG_HEAD` is part of the merge contract)   |
| `MERGE_HEAD` present, `ORIG_HEAD` present, HEAD is detached    | throw `UNSUPPORTED_OPERATION` (`merge.ts` rejects detached HEAD upstream, but defensive guard) |
| `MERGE_HEAD` present, `ORIG_HEAD` present, HEAD is symbolic    | hard-reset HEAD's branch to `ORIG_HEAD`; clear `MERGE_HEAD` + `MERGE_MSG`; return result       |

The state transitions executed under the index lock:

1. **Read `MERGE_HEAD`** — if absent, throw.
2. **Read `ORIG_HEAD`** — if absent, throw.
3. **Read HEAD** — must be symbolic (defensive).
4. **Hard-reset to `ORIG_HEAD`**: working tree + index + branch ref.
   Reuses the existing `reset --hard` machinery (`materializeTree` +
   index commit). The branch ref's old value is the post-conflict
   HEAD (unchanged from pre-merge, because `merge` never advanced
   it on a conflicting outcome — but we use `expected: current` for
   safety).
5. **Clear `MERGE_HEAD` + `MERGE_MSG`** via the existing
   `clearMergeState` helper. `ORIG_HEAD` is intentionally preserved
   (ADR-173, matches canonical git).

### 4.2 `continueMerge` — the state transitions

| Pre-condition                                       | Result                                                                                      |
|-----------------------------------------------------|---------------------------------------------------------------------------------------------|
| `MERGE_HEAD` absent                                 | throw `NO_OPERATION_IN_PROGRESS` with `operation: 'merge'`                                  |
| `MERGE_HEAD` present, unmerged entries in index     | throw `MERGE_HAS_CONFLICTS` (existing error; `commit` already raises this)                  |
| `MERGE_HEAD` present, index fully resolved          | delegate to `commit({ message, author?, committer?, noVerify? })`; return its result        |

ADR-174 captures the "delegate to commit" decision. The motivation:
`commit` already has the merge-resolution path (`commit.ts:58-83`). It
reads `MERGE_HEAD`, skips `assertNoPendingOperation`'s merge marker,
builds `parents = [HEAD, MERGE_HEAD]`, falls back to `MERGE_MSG` when
the user provides an empty message, runs hooks, and clears merge state
after the commit lands. `continueMerge` is a thin precondition
checker on top of that — it asserts `MERGE_HEAD` is present (the inverse
of commit's behaviour, which TOLERATES it) and forwards.

### 4.3 Error codes

A new domain error code lands alongside `OPERATION_IN_PROGRESS`:

```typescript
| {
    readonly code: 'NO_OPERATION_IN_PROGRESS';
    readonly operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
  }
```

ADR-171 captures the shape choice. Mirror of the existing
`OPERATION_IN_PROGRESS` (same `operation` discriminator) — the natural
"opposite" semantic for a state-machine-end command. Phase 22 will
reuse the same code with different `operation` values.

### 4.4 ORIG_HEAD preservation

`abortMerge` clears `MERGE_HEAD` and `MERGE_MSG`. It does NOT clear
`ORIG_HEAD`. Rationale (ADR-173):

- Canonical git preserves `ORIG_HEAD` across operations — the user can
  later run `git reset --hard ORIG_HEAD` from a NEW operation to
  retrieve the same pre-merge state.
- The merge state contract owns `MERGE_HEAD` and `MERGE_MSG`;
  `ORIG_HEAD` is shared with `reset`, `rebase`, and other history
  rewriters.
- Clearing it would silently break canonical-git muscle memory.

### 4.5 Concurrency

Both commands acquire `index.lock` for the duration of their work
(`abortMerge` via the existing `reset --hard` path; `continueMerge`
via `commit`'s lock). A concurrent `add` between abort precondition
checks and the reset would otherwise race against the index commit.

### 4.6 Hooks

`continueMerge` runs the same hook surface as `commit` —
`pre-commit` and `commit-msg`. `abortMerge` runs no hooks
(canonical git's `merge --abort` does not invoke them either; the
operation is purely destructive of in-progress state).

### 4.7 Reflog

- `abortMerge` writes a reflog entry on the branch and on HEAD via
  `updateRef`'s existing reflog hook (the `reset --hard` path
  records `reset: moving to <oid>` by default; we override with a
  more specific message: `merge: aborted`). The format matches
  canonical git's `merge: aborted` entry.
- `continueMerge` inherits `commit`'s existing reflog format
  (`commit (merge): <subject>`).

## 5. Module layout

```
src/application/commands/
├── abort-merge.ts                       # NEW
├── continue-merge.ts                    # NEW
├── internal/
│   └── merge-state.ts                   # extended: readOrigHead
├── index.ts                             # extended: export abortMerge, continueMerge

src/domain/commands/
└── error.ts                             # extended: NO_OPERATION_IN_PROGRESS

src/repository.ts                        # extended: bind abortMerge, continueMerge
src/index.ts                             # (re-export from repository — unchanged)

test/unit/application/commands/
├── abort-merge.test.ts                  # NEW
├── continue-merge.test.ts               # NEW
└── internal/merge-state.test.ts         # extended: readOrigHead

test/integration/
└── merge-abort-continue.test.ts         # NEW — round-trip integration
```

### 5.1 Why two new modules rather than extending `merge.ts`?

Three reasons:

- **Single responsibility.** `merge.ts` is already 700 lines doing the
  three-way merge engine work. `abort` and `continue` are state-machine
  transitions that don't touch the merge engine.
- **Test isolation.** Each file is independently unit-testable
  without setting up the full merge fixture.
- **Future symmetry.** Phase 22 will add `abort-cherry-pick.ts`,
  `continue-rebase.ts`, etc. Each follows the same one-file-per-
  command pattern.

### 5.2 `readOrigHead`

`merge-state.ts` gains a single new export, parallel to the existing
`readMergeHead`:

```typescript
export const readOrigHead = async (ctx: Context): Promise<ObjectId | undefined> => {
  const path = `${ctx.layout.gitDir}/ORIG_HEAD`;
  if (!(await ctx.fs.exists(path))) return undefined;
  const content = await ctx.fs.readUtf8(path);
  const trimmed = content.trim();
  if (trimmed.length === 0) return undefined;
  return ObjectIdFactory.from(trimmed);
};
```

Same validation contract as `readMergeHead` (factory rejects non-hex,
so a corrupt `ORIG_HEAD` produces a clear `INVALID_OBJECT_ID` rather
than a silent reset to an invalid commit).

## 6. Algorithm — `abortMerge`

```
1. assertRepository(ctx);
2. assertNotBare(ctx, 'merge --abort');
3. const mergeHead = await readMergeHead(ctx);
4. if (mergeHead === undefined) throw noOperationInProgress('merge');
5. const origHead = await readOrigHead(ctx);
6. if (origHead === undefined) throw noOperationInProgress('merge');
7. const head = await readHeadRaw(ctx);
8. if (head.kind !== 'symbolic') throw unsupportedOperation('merge --abort', 'cannot abort with detached HEAD');
9. // Hard-reset to origHead. Reuses materializeTree + buildIndexFromTree.
10. const lock = await acquireIndexLock(ctx);
11. try {
12.   const matcher = await loadSparseMatcher(ctx);
13.   const commit = await readObject(ctx, origHead);
14.   if (commit.type !== 'commit') throw unexpectedObjectType('commit', commit.type, origHead);
15.   const currentIndex = await readIndex(ctx);
16.   const result = await materializeTree(ctx, {
17.     targetTree: commit.data.tree,
18.     currentIndex,
19.     force: true,
20.     forceRewriteAll: true,
21.     ...(matcher !== undefined ? { sparse: matcher } : {}),
22.   });
23.   await lock.commit(result.newIndexEntries);
24. } finally {
25.   await lock.release();
26. }
27. await updateRef(ctx, head.target, origHead, { reflogMessage: 'merge: aborted' });
28. await clearMergeState(ctx);     // MERGE_HEAD + MERGE_MSG only (ORIG_HEAD preserved)
29. return { origHead, branch: head.target };
```

**Note on step 27:** the branch ref's old value is HEAD's current
value (which equals `origHead`, since `merge` never advanced the
branch on a conflicting outcome). `updateRef` performs its own CAS
without an `expected` clause; we let it resolve the current value
internally — passing `expected: head's-current-value` would require
an extra read for no functional gain (single-threaded library; no
concurrent ref writers between line 7 and line 27).

**Equivalent to a `reset --hard ORIG_HEAD` followed by `clearMergeState`?**
Yes, except we skip the `assertNoPendingOperation` guard (which
`reset` runs) — that guard would itself fire because `MERGE_HEAD`
exists. We inline the hard-reset machinery and trade one helper-
function call for the bypass. ADR-170 captures the equivalence.

**Why not extract a shared `hardResetToCommit` helper?** Considered.
Deferred: the inlined block is ~25 lines, all isolated to one file.
Extracting a helper now would couple `abort-merge.ts` and `reset.ts`
through a third module mid-phase; a follow-up refactor PR can land
the helper once Phase 22 brings a third caller (abort-cherry-pick,
abort-rebase) — three call sites is the natural extract-trigger.

## 7. Algorithm — `continueMerge`

```
1. assertRepository(ctx);
2. assertNotBare(ctx, 'merge --continue');
3. const mergeHead = await readMergeHead(ctx);
4. if (mergeHead === undefined) throw noOperationInProgress('merge');
5. // Delegate. commit handles unmerged-index rejection and the rest.
6. return commit(ctx, { message: opts.message ?? '', author?, committer?, noVerify? });
```

The empty-string `message` falls through `commit`'s
`resolveCommitMessage` to the `MERGE_MSG` draft.

Note: spreading is conditional to honour `exactOptionalPropertyTypes`:
`author`/`committer`/`noVerify` are forwarded only when supplied.

## 8. Testing strategy

### 8.1 Unit — `abort-merge.test.ts`

- "Given no MERGE_HEAD, When abortMerge runs, Then throws
  NO_OPERATION_IN_PROGRESS(merge)".
- "Given MERGE_HEAD but no ORIG_HEAD, When abortMerge runs, Then
  throws NO_OPERATION_IN_PROGRESS(merge)".
- "Given a conflicting merge, When abortMerge runs, Then the working
  tree matches ORIG_HEAD's tree".
- "Given a conflicting merge, When abortMerge runs, Then the index
  matches ORIG_HEAD's tree (all stage-0)".
- "Given a conflicting merge, When abortMerge runs, Then the branch
  ref points at ORIG_HEAD".
- "Given a conflicting merge, When abortMerge runs, Then MERGE_HEAD
  is removed".
- "Given a conflicting merge, When abortMerge runs, Then MERGE_MSG
  is removed".
- "Given a conflicting merge, When abortMerge runs, Then ORIG_HEAD
  is preserved" (load-bearing — ADR-173).
- "Given a conflicting merge, When abortMerge runs, Then the reflog
  records `merge: aborted` on the branch".
- "Given a detached HEAD with MERGE_HEAD on disk (synthetic), When
  abortMerge runs, Then throws UNSUPPORTED_OPERATION" (defensive).
- "Given a bare repo, When abortMerge runs, Then throws
  BARE_REPOSITORY".
- "Given a non-repo, When abortMerge runs, Then throws
  NOT_A_REPOSITORY".

### 8.2 Unit — `continue-merge.test.ts`

- "Given no MERGE_HEAD, When continueMerge runs, Then throws
  NO_OPERATION_IN_PROGRESS(merge)".
- "Given MERGE_HEAD and unmerged index entries, When continueMerge
  runs, Then throws MERGE_HAS_CONFLICTS" (delegated to commit).
- "Given a resolved merge index, When continueMerge() runs without
  a message, Then the resulting commit's message is MERGE_MSG's
  draft".
- "Given a resolved merge index, When continueMerge({ message })
  runs, Then the resulting commit's message is the explicit one".
- "Given a resolved merge index, When continueMerge runs, Then the
  resulting commit has parents=[HEAD, MERGE_HEAD]".
- "Given a resolved merge index, When continueMerge runs, Then
  MERGE_HEAD and MERGE_MSG are cleared" (delegated to commit's
  existing cleanup).
- "Given a resolved merge index, When continueMerge({ noVerify })
  runs, Then pre-commit / commit-msg hooks are skipped".
- "Given a bare repo, When continueMerge runs, Then throws
  BARE_REPOSITORY".

### 8.3 Unit — `merge-state.test.ts` extension

- "Given an absent ORIG_HEAD, When readOrigHead runs, Then returns
  undefined".
- "Given a valid ORIG_HEAD, When readOrigHead runs, Then returns the
  ObjectId".
- "Given an empty ORIG_HEAD, When readOrigHead runs, Then returns
  undefined".
- "Given a malformed ORIG_HEAD, When readOrigHead runs, Then throws
  INVALID_OBJECT_ID" (factory rejection).

### 8.4 Integration — `merge-abort-continue.test.ts`

End-to-end round-trip:

- "Given an aborted merge, When the same merge runs again, Then it
  produces the same conflict result" (round-trip — abort restores the
  pre-merge state exactly).
- "Given a conflicting merge, When the user resolves conflicts and
  runs continueMerge, Then HEAD is a two-parent merge commit".
- "Given an aborted merge, When the user runs a non-conflicting
  command (e.g. `add`), Then `assertNoPendingOperation` passes"
  (no state pollution).

Pyramid bucket: `feature` (state-machine transitions, not a parser).
`@proves` surface: `repo.abortMerge` / `repo.continueMerge`.

### 8.5 Property tests

None for this phase. The state machine is closer to a small finite
controller than a parser/serializer pair (per the four lenses in
CLAUDE.md). Abort/continue are total functions over a *very* small
state space (3 markers × {present, absent}) covered exhaustively by
example tests. No `*.properties.test.ts` sibling.

### 8.6 Mutation

Stryker on `abort-merge.ts`, `continue-merge.ts`, and the
`readOrigHead` addition to `merge-state.ts`. Target: 0 new killable
survivors. Equivalent mutants documented inline with
`// equivalent-mutant: <why>` per existing convention.

## 9. Repository binding

The `Repository` interface in `src/repository.ts` gains two new
properties:

```typescript
readonly abortMerge: BindCtx<typeof commands.abortMerge>;
readonly continueMerge: BindCtx<typeof commands.continueMerge>;
```

Bound in the factory with the standard `guard()` + `commands.*` glue
that every other Tier-1 command uses.

`src/application/commands/index.ts` re-exports:

```typescript
export { type AbortMergeResult, abortMerge } from './abort-merge.js';
export {
  type ContinueMergeOptions,
  type ContinueMergeResult,
  continueMerge,
} from './continue-merge.js';
```

## 10. Browser-surface coverage

Per Phase 19.5a, every name on `repo.*` needs a parity-scenario or
allowlist entry. Two new scenarios under `test/parity/scenarios/`:

- `merge-abort.ts` — clone fixture; run `merge` to produce a
  conflict; assert kind=conflict; run `abortMerge`; assert HEAD
  equals pre-merge; capture golden `commit.id`.
- `merge-continue.ts` — clone fixture; run `merge` to produce a
  conflict; resolve via `stageEntry`; run `continueMerge`; assert
  HEAD is a two-parent merge commit; capture golden `commit.id`.

The `tooling/audit-browser-surface.ts` audit picks both new names
up automatically and the bundled scenarios close the gap with no
allowlist entries.

## 11. Open questions

- **Q1: Should `abortMerge` accept a `target` override (e.g., to abort
  to a different commit than `ORIG_HEAD`)?** No. `ORIG_HEAD` is the
  contract. A user who wants a different target uses `reset --hard
  <other>` directly. v1 stays minimal.
- **Q2: Should `continueMerge` accept `allowEmpty` / `allowEmptyMessage`?**
  No. These belong on `commit`; `continueMerge` is a thin wrapper. A
  user with the edge case can call `commit` directly (it tolerates
  `MERGE_HEAD`). We keep the surface narrow.
- **Q3: Should we surface a single `merge({ action: 'abort' | 'continue' })`
  variant instead?** No. The `action` pattern fits CRUD families
  (`branch.list`/`branch.create`/`branch.delete`) where the verbs share
  inputs. `merge` / `abortMerge` / `continueMerge` have disjoint inputs
  and outputs; conflating them on one option object would just push the
  discriminator pattern into the user code.

## 12. Self-review log

### Pass 1 → Pass 2

- §4.4 added — ORIG_HEAD preservation is the non-obvious bit; an
  earlier draft cleared it alongside MERGE_HEAD, which would silently
  break canonical-git muscle memory. ADR-173 split out to capture.
- §7 added the empty-string default for `message` and the conditional
  spreading note — without it, the `exactOptionalPropertyTypes` rule
  would bite the implementation.
- §5.1 added — the "why a new module" justification mirrors
  Phase 13.4b §4.1's defence of `merge-state.ts`. Without it, the
  pass-2 reviewer asks "why not inline these in `merge.ts`?".

### Pass 2 → Pass 3

- §4.7 added — reflog format is a load-bearing canonical-git
  compatibility detail. The `merge: aborted` literal matches
  canonical git's reflog entry exactly.
- §6 step 27 note added — the `expected: ...` question is the kind
  of nit a reviewer raises; document the single-threaded library
  invariant once.
- §8.5 added — the property-tests-yes-or-no question is now an
  explicit no with the four-lens justification. CLAUDE.md flags
  this as a review checkpoint.
- §10 added — Phase 19.5a's audit will gate the PR otherwise.

### Pass 3 → final

- §3.1 added — the "namespace vs flat" question is the most likely
  bikeshed; document the rationale once with the precedent rather
  than handle it again during review.
- §4.6 added — hooks behaviour is non-obvious and matters for
  pre-commit-driven workflows.
- §11 Q3 added — caught a third bikeshed (single-method-with-action)
  early; ADR-172 covers the choice.
