# Plan — Phase 20.4 Merge State Machine

> Design: [docs/design/phase-20-4-merge-state-machine.md](../design/phase-20-4-merge-state-machine.md)
> ADRs: 170 · 171 · 172 · 173 · 174

Each numbered step lists, in order: **Test** (what to write first),
**Implement** (what to make the test pass), **Verify** (which `npm`
script covers it). Run `npm run validate` after each step's
implementation lands; commit atomically.

Sequence: domain error → readOrigHead helper → abort-merge → continue-merge →
exports + repository binding → integration → parity scenarios → docs.

The order is load-bearing only between steps 2→3 (readOrigHead is
called inside abort-merge) and 4→5 (continue-merge needs commit's
existing path which is already shipped). Other steps can move only
forward.

## Step 1 — `NO_OPERATION_IN_PROGRESS` error code

Per ADR-171.

### Test (`test/unit/domain/commands/error.test.ts`)

- "Given operation='merge', When noOperationInProgress is called, Then
  the returned error has code NO_OPERATION_IN_PROGRESS and operation
  matches".

### Implement

- Append to `CommandError` union in `src/domain/commands/error.ts`:
  ```typescript
  | {
      readonly code: 'NO_OPERATION_IN_PROGRESS';
      readonly operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert';
    }
  ```
- Export a constructor `noOperationInProgress(operation)`.

### Verify

- `npm run check:types` (union narrowing OK)
- `npm run test:unit -- error.test`
- `npm run check` (Biome formatting)

## Step 2 — `readOrigHead` in `merge-state.ts`

Per design §5.2.

### Test (`test/unit/application/commands/internal/merge-state.test.ts`)

- "Given an absent ORIG_HEAD, When readOrigHead runs, Then returns
  undefined".
- "Given a valid 40-hex ORIG_HEAD with trailing newline, When
  readOrigHead runs, Then returns the ObjectId".
- "Given an empty ORIG_HEAD, When readOrigHead runs, Then returns
  undefined".
- "Given a malformed ORIG_HEAD (39 hex), When readOrigHead runs, Then
  throws INVALID_OBJECT_ID".

### Implement

- New export in `src/application/commands/internal/merge-state.ts`:
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

### Verify

- `npm run test:unit -- merge-state.test`
- `npm run test:coverage` (100% on the new branch)

## Step 3 — `abortMerge` command

Per ADR-170, 173.

### Test (`test/unit/application/commands/abort-merge.test.ts`)

Fixture: in-memory adapter + helper that produces a conflicting merge
(reuse the existing `merge.test.ts` fixtures wherever possible).

Tests in design §8.1 order:

1. "Given a non-repo, When abortMerge runs, Then throws NOT_A_REPOSITORY"
2. "Given a bare repo, When abortMerge runs, Then throws BARE_REPOSITORY"
3. "Given no MERGE_HEAD, When abortMerge runs, Then throws NO_OPERATION_IN_PROGRESS(merge)"
4. "Given MERGE_HEAD but no ORIG_HEAD, When abortMerge runs, Then throws NO_OPERATION_IN_PROGRESS(merge)"
5. "Given a synthetic detached HEAD with MERGE_HEAD, When abortMerge runs, Then throws UNSUPPORTED_OPERATION"
6. "Given a conflicting merge, When abortMerge runs, Then the working tree matches ORIG_HEAD's tree"
7. "Given a conflicting merge, When abortMerge runs, Then the index has stage-0 entries matching ORIG_HEAD's tree (no stage-1/2/3 remain)"
8. "Given a conflicting merge, When abortMerge runs, Then the branch ref points at ORIG_HEAD"
9. "Given a conflicting merge, When abortMerge runs, Then MERGE_HEAD is removed"
10. "Given a conflicting merge, When abortMerge runs, Then MERGE_MSG is removed"
11. "Given a conflicting merge, When abortMerge runs, Then ORIG_HEAD is preserved (ADR-173)"
12. "Given a conflicting merge, When abortMerge runs, Then the reflog records `merge: aborted`"
13. "Given a conflicting merge, When abortMerge returns, Then result.origHead matches the on-disk ORIG_HEAD value"
14. "Given a conflicting merge, When abortMerge returns, Then result.branch matches HEAD's target"

### Implement

- New file `src/application/commands/abort-merge.ts`. Algorithm in
  design §6. Key wiring:
  - Imports: `assertRepository`, `assertNotBare`, `readHeadRaw` from
    `./internal/repo-state.js`; `readMergeHead`, `readOrigHead`,
    `clearMergeState` from `./internal/merge-state.js`;
    `acquireIndexLock` from `./internal/index-update.js`;
    `materializeTree`, `readObject`, `readIndex`, `loadSparseMatcher`,
    `updateRef` from `../primitives/*`; `noOperationInProgress`,
    `unsupportedOperation` from `../../domain/*`;
    `unexpectedObjectType` from `../../domain/objects/error.js`.
  - Surface: `export interface AbortMergeResult { origHead, branch }`
    and `export const abortMerge: (ctx: Context) => Promise<AbortMergeResult>`.

### Verify

- `npm run test:unit -- abort-merge.test`
- `npm run test:coverage` (100%)
- `npm run check`, `npm run check:types`

## Step 4 — `continueMerge` command

Per ADR-174.

### Test (`test/unit/application/commands/continue-merge.test.ts`)

1. "Given a non-repo, When continueMerge runs, Then throws NOT_A_REPOSITORY"
2. "Given a bare repo, When continueMerge runs, Then throws BARE_REPOSITORY"
3. "Given no MERGE_HEAD, When continueMerge runs, Then throws NO_OPERATION_IN_PROGRESS(merge)"
4. "Given MERGE_HEAD and unmerged stage-1/2/3 entries, When continueMerge runs, Then throws MERGE_HAS_CONFLICTS" (delegated)
5. "Given a resolved merge index, When continueMerge() runs without a message, Then the resulting commit's message is MERGE_MSG's draft"
6. "Given a resolved merge index, When continueMerge({ message }) runs, Then the resulting commit's message is the explicit one"
7. "Given a resolved merge index, When continueMerge runs, Then the resulting commit has parents=[HEAD, MERGE_HEAD]"
8. "Given a resolved merge index, When continueMerge runs, Then MERGE_HEAD and MERGE_MSG are cleared (delegated to commit)"
9. "Given a resolved merge index, When continueMerge({ noVerify }) runs, Then pre-commit and commit-msg hooks are skipped"
10. "Given a resolved merge index, When continueMerge({ author, committer }) runs, Then the commit object's author/committer are the explicit ones"

### Implement

- New file `src/application/commands/continue-merge.ts`. Algorithm in
  design §7. Key wiring:
  - Imports: `assertRepository`, `assertNotBare` from
    `./internal/repo-state.js`; `readMergeHead` from
    `./internal/merge-state.js`; `commit`, `CommitOptions`,
    `CommitResult` from `./commit.js`; `noOperationInProgress`
    from `../../domain/*`.
  - Surface: `export interface ContinueMergeOptions { message?, author?,
    committer?, noVerify? }`, `export type ContinueMergeResult =
    CommitResult`, `export const continueMerge: (ctx: Context, opts?:
    ContinueMergeOptions) => Promise<ContinueMergeResult>`.
  - Conditional spread on `author`, `committer`, `noVerify` for
    `exactOptionalPropertyTypes`.

### Verify

- `npm run test:unit -- continue-merge.test`
- `npm run test:coverage`
- `npm run check`, `npm run check:types`

## Step 5 — Export + repository binding

### Test (`test/unit/repository.test.ts` extension, or a new minimal `repository-merge-state.test.ts`)

- "Given a Repository, When .abortMerge is accessed, Then it is a function bound to ctx".
- "Given a Repository, When .continueMerge is accessed, Then it is a function bound to ctx".
- "Given a disposed Repository, When .abortMerge runs, Then throws REPOSITORY_DISPOSED".
- "Given a disposed Repository, When .continueMerge runs, Then throws REPOSITORY_DISPOSED".

### Implement

- `src/application/commands/index.ts`: re-export per design §9:
  ```typescript
  export { type AbortMergeResult, abortMerge } from './abort-merge.js';
  export {
    type ContinueMergeOptions,
    type ContinueMergeResult,
    continueMerge,
  } from './continue-merge.js';
  ```
- `src/repository.ts`: add the two `BindCtx` properties to the
  `Repository` interface (alphabetical-ish — slot near `merge`); bind
  them in the factory with the existing `guard()` + `commands.*`
  pattern.

### Verify

- `npm run test:unit -- repository`
- `npm run check:types` (interface union is intact)
- `npm run build` (the `dist/` artifact compiles)
- `npm run test:coverage`

## Step 6 — Integration round-trip

Per design §8.4.

### Test (`test/integration/merge-abort-continue.test.ts`)

Header: `// @proves repo.abortMerge, repo.continueMerge // bucket:
feature // interopSurface: n/a`.

1. "Given an aborted merge, When the same merge runs again, Then it produces the same conflict result"
2. "Given a conflicting merge, When the user resolves conflicts via stageEntry and runs continueMerge, Then HEAD is a two-parent merge commit"
3. "Given an aborted merge, When the user runs add against a fresh path, Then assertNoPendingOperation passes (no state pollution)"

Fixture: spin up a tmp Node repo via `init` → commit base → branch +
diverging commits → merge → assert conflict → abort/continue → assert.

### Verify

- `npm run test:integration -- merge-abort-continue`
- `npm run test:coverage`
- `tooling/audit-integration-tests.ts` accepts the new file (correct
  `@proves` header).

## Step 7 — Parity scenarios

Per design §10.

### Test/Implement

- `test/parity/scenarios/merge-abort.ts` — bundled scenario.
- `test/parity/scenarios/merge-continue.ts` — bundled scenario.
- Each follows the existing `Scenario<TResult>` shape (see
  `test/parity/scenarios/index.ts` for the pattern).
- Both must produce a deterministic `commit.id` golden (the
  parity harness asserts golden bytes).

### Verify

- `npm run test:parity` (or the equivalent: `npm run test` includes
  this when scenarios are auto-registered).
- `tooling/audit-browser-surface.ts` passes — both new repo names
  have parity coverage, no new allowlist entries.

## Step 8 — Docs

### Files to update

- `README.md` — command index: add `abortMerge`, `continueMerge`
  under the Merge section.
- `RUNBOOK.md` — the "merge conflict recovery" section: replace
  "run `reset --hard ORIG_HEAD`" with the dedicated commands.
- `CONTRIBUTING.md` — no change (workflow is unchanged).
- `docs/use/merge.md` — extend with abort/continue usage + the
  ORIG_HEAD-preservation behaviour (ADR-173 in plain English).
- `docs/understand/state-machine.md` — if it exists, extend; if not,
  the design doc + ADRs are sufficient reference.
- `docs/BACKLOG.md` — flip 20.4 from `[ ]` to `[x]`. Add a one-line
  summary mirroring the existing 20.x entries: "Merge state machine
  — `abortMerge`, `continueMerge`. … ADRs 170-174 ·
  `design/phase-20-4-merge-state-machine.md`".

### Verify

- `npm run check` (link/lychee)
- `npm run check:spelling` (cspell)
- `tooling/audit-docs.ts` if present.

## Step 9 — Validate + mutation

### Verify

- `npm run validate` — full suite (lint, types, dead-code, tests,
  100% coverage, integration, etc.).
- `npx stryker run` (or `npm run test:mutation`) — surviving mutants
  on `abort-merge.ts`, `continue-merge.ts`, the `readOrigHead` block
  in `merge-state.ts`, and the `NO_OPERATION_IN_PROGRESS` block in
  `error.ts` are killed or documented with
  `// equivalent-mutant: <why>` comments inline.
- The mutation budget in `mutation-budgets.json` for
  `src/application/commands` may need adjustment if the touched
  files raise the cap.

## Step 10 — Review × 3

Per CLAUDE.md §6. Parallel-agent pattern:

- `typescript-reviewer` — idiomatic patterns, type safety, error
  handling.
- `code-reviewer` — generic correctness, naming, dead code.
- `security-reviewer` — path injection, validation, lock semantics.
- `test-review` — coverage of behaviour, AAA/`sut`/GWT discipline,
  property-test gap (design §8.5 already documents the "no" decision
  with the four-lens justification, but the reviewer can re-check).

Three passes total. Fix every finding each pass. Stop when a pass
yields no new findings.

## Atomic-commit checkpoints

Each step ends with a commit. Suggested conventional-commit subjects:

1. `feat(domain): NO_OPERATION_IN_PROGRESS error`
2. `feat(merge-state): readOrigHead`
3. `feat(merge): abortMerge command`
4. `feat(merge): continueMerge command`
5. `feat(repository): bind abortMerge / continueMerge`
6. `test(integration): merge abort/continue round-trip`
7. `test(parity): merge abort/continue scenarios`
8. `docs(merge): document merge state machine`

If a step's commit exceeds ~250 lines diff, split it (e.g. step 3's
test file might land in one commit and the implementation in the
next). The TDD red→green cycle is the natural split boundary.

## Risk + rollback

- **Breaking change risk:** none. Two new methods; no existing
  signatures change.
- **Mutation-score regression:** unlikely — both new commands are
  thin orchestrators. The 100%-coverage gate plus targeted unit
  tests should land all branches on the first pass.
- **Rollback:** revert the merge commit. Each step's atomic commit
  is independently revertible if a downstream consumer surfaces
  an issue after merge.

## Self-review log

### Pass 1 → Pass 2

- Step 5 added an explicit test for the dispose path — without it, the
  repository binding's `guard()` wrapper would be untested.
- Step 7 added the audit-browser-surface invariant explicitly. Without
  it, the gate added in Phase 19.5a would fail at the validate step
  with no clear pointer back to the plan.
- Step 9's mutation-budgets note added — Phase 19.6 / 20.3 both ran
  into the budget file needing edits; flag it ahead of time.

### Pass 2 → Pass 3

- Step 6's `@proves` header detail spelled out — easy to forget the
  integration audit (Phase 19.4) header format until it bites at
  validate time.
- Step 3 test 13/14 added — the two-field result type should be
  asserted directly, not just inferred from "the branch ref points
  at ORIG_HEAD".
- Step 4 test 10 added — `author` and `committer` forwarding is a
  load-bearing forwarding path and worth its own test.

### Pass 3 → final

- Step 9's mutation pass moved AFTER Step 8 docs — docs touching
  markdown can shift lychee link targets, so the link-check that
  ships inside `npm run validate` belongs after docs are stable.
- Renamed Step 10 review from "code-quality / perf / security" to
  the explicit four reviewers — matches CLAUDE.md §6's documented
  parallel-agent pattern.
