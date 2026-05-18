# Plan — Phase 13.4b — Three-way merge conflict handling

Design: `docs/design/phase-13-4b-merge-conflict-handling.md`.
ADRs: `docs/adr/026-merge-conflict-returns-not-throws.md`,
`docs/adr/027-merge-conflict-write-order.md`,
`docs/adr/028-merge-msg-content.md`.

Branch: `feat/merge-conflict-handling`.

Atomic conventional-commits per step. `npm run validate` green before
committing.

## Step 1 — `MergeResult` discriminated union extension

**Files touched**:
- `src/application/commands/merge.ts` — extend `MergeResult` union with
  the `'conflict'` variant.

**Test first** (`test/unit/application/commands/merge.test.ts`,
update the existing "Given conflicting modifications" test):
- Change `expect(data?.code).toBe('MERGE_HAS_CONFLICTS')` to
  `expect(result.kind).toBe('conflict')` (test will fail until step 2
  wires the behaviour).

**Commit**: `feat(merge): add conflict result variant`.

## Step 2 — `merge-state.ts` helper module

**Files touched**:
- `src/application/commands/internal/merge-state.ts` — NEW. Exports:
  - `writeMergeHead(ctx, targetId)`
  - `writeMergeMsg(ctx, message)`
  - `writeOrigHead(ctx, oldHeadId)`

Each is a thin wrapper around `ctx.fs.writeUtf8` that builds the
path under `${ctx.layout.gitDir}` and appends a trailing `\n`.

**Test first** (`test/unit/application/commands/internal/merge-state.test.ts`):

- "Given a target id, When writeMergeHead is called, Then
  `.git/MERGE_HEAD` contains the id + \n".
- "Given a message, When writeMergeMsg is called, Then
  `.git/MERGE_MSG` contains the message".
- "Given an old head id, When writeOrigHead is called, Then
  `.git/ORIG_HEAD` contains the id + \n".
- "Given repeated calls, When the writer fires twice, Then the
  second write replaces the first (idempotent overwrite)".

**Commit**: `feat(merge-state): add MERGE_HEAD / MERGE_MSG / ORIG_HEAD writers`.

## Step 3 — Conflict-branch implementation in `merge.ts`

**Files touched**:
- `src/application/commands/merge.ts` — extend `computeMergedTree` to
  return either `{ kind: 'clean', tree }` or `{ kind: 'conflict',
  conflicts, outcomes }`. `mergeCommit` branches: clean path
  unchanged, conflict path persists state and returns
  `{ kind: 'conflict', ... }`.

Sub-steps:
1. Reject `rename-rename` / `gitlink` conflicts with
   `unsupportedOperation` BEFORE writing anything.
2. Materialise marker bytes per conflict type (§3.1 matrix).
3. Acquire `index.lock`.
4. Write working-tree files for each conflicting path.
5. Write ORIG_HEAD, MERGE_HEAD, MERGE_MSG.
6. Combine stage-0 outcomes + stage-1/2/3 conflict entries; sort by
   (path, stage); commit the index via the lock.
7. Return the conflict result.

**Test first** (extend `merge.test.ts`):

- "Given a content conflict, When merge runs, Then result.kind ===
  'conflict' with the path and type".
- "Given a content conflict, When merge runs, Then the working tree
  has `<<<<<<<` markers at the conflicting path".
- "Given a content conflict, When merge runs, Then `.git/MERGE_HEAD`
  matches the target's id".
- "Given a content conflict, When merge runs, Then `.git/ORIG_HEAD`
  matches the pre-merge HEAD id".
- "Given a content conflict, When merge runs, Then `.git/MERGE_MSG`
  matches the merge message".
- "Given a content conflict, When merge runs, Then the index has
  stage-1, stage-2, stage-3 entries for the conflicting path".
- "Given a resolved conflict, When `add` + `commit` runs, Then a
  merge commit is created with parents=[ORIG_HEAD, MERGE_HEAD]".
- "Given add-add conflict (no base), When merge runs, Then stage-2
  and stage-3 entries are written (no stage-1)".
- "Given modify-delete conflict, When merge runs, Then stage-1 +
  surviving side's stage are written".
- "Given a rename-rename conflict, When merge runs, Then throws
  UNSUPPORTED_OPERATION before any disk write".
- "Given an existing MERGE_HEAD, When merge runs, Then throws
  OPERATION_IN_PROGRESS (regression)".

**Commit**: `feat(merge): persist conflict state — markers, stages, MERGE_HEAD`.

## Step 4 — `commit` parent-resolution

If `commit` does not already pick up MERGE_HEAD as a second parent,
extend it. Check `src/application/commands/commit.ts` — if MERGE_HEAD
is read for parent computation, this step is a no-op; otherwise:

**Files touched (conditional)**:
- `src/application/commands/commit.ts` — read MERGE_HEAD before
  computing parents; if present, include it as the second parent and
  delete the file after commit succeeds (atomic with index commit).

**Test first**:
- The "resolved conflict produces merge commit" test in step 3 is the
  driver. If it passes today (commit already handles MERGE_HEAD),
  no implementation work needed.

**Commit (conditional)**: `feat(commit): honour MERGE_HEAD when present`.

## Step 5 — Docs + BACKLOG tick

**Files touched**:
- `docs/BACKLOG.md` — flip `[ ]` to `[x]` on §13.4b.
- `MIGRATION.md` — note the `MergeResult` change.

**Commit**: `docs: tick BACKLOG §13.4b, update MIGRATION for conflict variant`.

## Step 6 — Reviews × 3

Four parallel reviewers per pass: typescript-reviewer, security-reviewer,
perf review (general-purpose), test-quality review (general-purpose).
Fix every HIGH each pass.

## Step 7 — Harness + mutation

- `npm run validate` (14/14 gates).
- `npx stryker run` scoped to:
  - `src/application/commands/merge.ts`
  - `src/application/commands/internal/merge-state.ts`
  - `src/application/commands/commit.ts` (if step 4 ran)
- Kill killable mutants; document equivalents.

## Step 8 — Push + await PR

- `git push -u origin feat/merge-conflict-handling`
- Await user to open the PR.

## Sequencing rationale

- Step 1 first: every downstream test pattern depends on the new
  `MergeResult` variant.
- Step 2 before Step 3: step 3's writes use step 2's helpers.
- Step 3 lands the bulk of the work in one atomic commit (conflict
  branch is a coherent unit; splitting further would force tests to
  reference partial state).
- Step 4 conditional: only adds a commit if `commit.ts` doesn't
  already handle MERGE_HEAD.
- Reviews and mutation last; documentation tick lands inside the PR
  per project policy.

## Self-review log

### Pass 1 → Pass 2

- Originally proposed three separate commits for working-tree
  writes / merge-state writes / index commit. Rolled into Step 3:
  the three writes are atomic within the index lock and don't
  produce useful intermediate test states.
- Step 4 added — without it, the resolved-merge-commit test relies
  on an unverified assumption about `commit.ts`'s MERGE_HEAD
  handling. Make it explicit as a CONDITIONAL step so the plan
  doesn't over-promise.

### Pass 2 → Pass 3

- Step 1's test update is the discriminator: changing the
  assertion from `throw` to `return` is the "Red" pin for the
  whole phase. Without this step, downstream tests would be
  refactor-heavy.
- Step 3's sub-steps now match the design's §3.2 write order
  exactly. Without that alignment, a reviewer would have to
  cross-reference design and plan to confirm consistency.

### Pass 3 → final

- Added the explicit "regression test for OPERATION_IN_PROGRESS"
  to Step 3. The existing `assertNoPendingOperation` already
  reads MERGE_HEAD; this PR's writes mean the second run of
  `merge` MUST surface the error. Reviewers will look for this.
- Step 5 wording clarifies that the BACKLOG tick lands INSIDE
  this PR's commits (per project policy, not as a follow-up).
