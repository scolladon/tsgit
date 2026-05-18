# Plan — Phase 14.1 — `add --all` (bulk-mode walking the working tree)

Design: `docs/design/phase-14-1-add-all.md`.
ADRs: `docs/adr/029-add-all-ignore-stub.md`,
`docs/adr/030-add-all-walk-strategy.md`,
`docs/adr/031-add-all-symlink-gitlink-policy.md`,
`docs/adr/032-add-all-large-file-guard.md`.

Branch: `feat/add-all`.

Atomic conventional-commit per step. `npm run validate` green before
committing. Every step is TDD: write tests first, then implementation.

## Step 1 — Error variant `WORKING_TREE_FILE_TOO_LARGE`

**Files touched:**

- `src/domain/commands/error.ts` — add the variant + factory
  `workingTreeFileTooLarge(path, size, limit)`.
- `src/domain/error.ts` — add `extractDetail` arm
  `"working-tree file too large: <basename(path)> size=<size> limit=<limit>"`
  (mirrors `OBJECT_TOO_LARGE` format; `basename` keeps the path
  short in the message).

**Test first** (`test/unit/domain/commands/error.test.ts`):

- Given factory call with `(path, 100, 50)`, When constructed, Then
  `data.code = 'WORKING_TREE_FILE_TOO_LARGE'`, `data.path = path`,
  `data.size = 100`, `data.limit = 50`.
- Given the error, When `extractDetail`, Then formatted message
  matches the contract above.

**Commit:** `feat(error): add WORKING_TREE_FILE_TOO_LARGE variant`.

## Step 2 — `MAX_WORKING_TREE_BLOB_BYTES` constant

**Files touched:**

- `src/application/primitives/types.ts` — export
  `MAX_WORKING_TREE_BLOB_BYTES = 256 * 1024 * 1024`.

**Test first** — covered by step 5 (the addAll throw-on-cap test).
No standalone test for the literal value.

**Commit:** `feat(primitives): export MAX_WORKING_TREE_BLOB_BYTES`.

## Step 3 — `walkWorkingTree` primitive

**Files touched:**

- `src/application/primitives/walk-working-tree.ts` — new file.
- `src/application/primitives/types.ts` — append
  `WalkWorkingTreeEntry` + `WalkWorkingTreeOptions` interfaces.
- `src/application/primitives/index.ts` — barrel export
  `walkWorkingTree` + types.

**Test first** (`test/unit/application/primitives/walk-working-tree.test.ts`):

Per design §6.1, 13 specs, Given/When/Then with `sut` and AAA bodies:

1. Empty working tree → yields nothing.
2. Two files at root → yields both.
3. Nested dirs → DFS leaves only.
4. `.git` at root → skipped.
5. Nested `.git` (embedded repo) → directory's entire contents
   skipped, including the `.git` itself.
6. `.GIT` (uppercase) → skipped (case-insensitive).
7. `.git ` (trailing space) → skipped (NTFS).
8. Symlink leaf → yielded with `isSymbolicLink: true`.
9. Symlink-to-directory → yielded as a leaf, NO descent.
10. Pre-aborted `ctx.signal` → throws `OPERATION_ABORTED`.
11. Depth > maxDepth → throws `TREE_DEPTH_EXCEEDED`.
12. Entries > maxEntries → throws `TREE_ENTRY_LIMIT_EXCEEDED`.
13. `readdir` returns a `..` segment (mock a hostile adapter) →
    throws `PATHSPEC_OUTSIDE_REPO`.

**Implementation:**

- DFS via async generator.
- Pre-scan each `readdir` for `.git` child (using
  `isForbiddenGitComponent`). If found, yield nothing from that
  directory.
- `lstat` every leaf; yield `{ path, stat }` for file / symlink;
  recurse for directory (no follow on symlink-to-dir — `lstat`
  returns `isSymbolicLink: true, isDirectory: false`).
- Abort check at the top of each entry iteration (matches
  `walkTree` pattern).
- Depth + entry counters; throw on overflow.
- Path joining uses POSIX `'/'`; reuse `validatePath` for the
  defence-in-depth segment check.

**Commit:** `feat(primitives): walkWorkingTree DFS walker`.

## Step 4 — Refactor `add.ts` extract `stageFromStat`

**Files touched:**

- `src/application/commands/add.ts` — extract `stageFromStat`;
  rewrite `stageOne` in terms of it.

**Test first:** existing `add.test.ts` suite must pass unchanged.
No new test — this is pure refactor.

**Commit:** `refactor(add): extract stageFromStat from stageOne`.

## Step 5 — `addAll` core flow

**Files touched:**

- `src/application/commands/add.ts` — dispatch + `addAll`.
- `src/application/commands/internal/add-ignore.ts` — new file with
  `IgnorePredicate` type + `defaultIgnorePredicate` (no-op stub).

**Test first** (`test/unit/application/commands/add.test.ts`, new
`describe('add --all')` block, 14 specs per design §6.2):

14. `all: true` + non-empty paths → `INVALID_OPTION` with
    `option = 'all'` and a reason containing `pathspec`.
15. Empty working tree + empty index → `{ added: [], modified: [],
    removed: [] }`.
16. Two untracked files → both in `added` (sorted), index has both.
17. Two tracked + one modified → `modified` contains the changed
    file only.
18. Tracked file deleted from disk → `removed` contains it AND
    index entry dropped.
19. Symlink + regular file → symlink stages as `120000`.
20. Executable file → `100755`.
21. `.git` at root → not staged.
22. Embedded `.git` subdir → not staged, no `160000`.
23. File > cap → `WORKING_TREE_FILE_TOO_LARGE` with `path`, `size`,
    `limit`; index unchanged (separate read after the throw
    confirms the on-disk index is byte-identical to pre-call).
24. `.git/MERGE_HEAD` present → succeeds (merge exempt).
25. `.git/REBASE_HEAD` present → `OPERATION_IN_PROGRESS`.
26. Custom `ignore` predicate excluding `node_modules` → those
    paths skipped (internal-only test, invokes `addAll` directly
    with the predicate injected via a re-export or test seam).
27. Pre-aborted `ctx.signal` → `OPERATION_ABORTED` and lock
    released.

**Implementation:**

- Add `addAll` per design §4.2. Dispatch on `opts.all` from `add`.
- Reject `all: true` + non-empty pathspec with `invalidOption`.
- Acquire index lock; read existing entries once; walk; diff; commit.
- Sort `added` / `modified` / `removed` before returning.
- `removed` is computed from "in existing, not in `seen`". `seen` is
  populated BEFORE the ignore filter (per design §4.2 fix).

**Commit:** `feat(add): bulk-mode --all walks the working tree`.

## Step 6 — Repository facade barrel + primitive export

**Files touched:**

- `src/application/primitives/index.ts` — already updated in
  Step 3; verify `walkWorkingTree` is exported.
- `src/repository.ts` — add
  `walkWorkingTree: BindCtx<typeof primitives.walkWorkingTree>`
  to `Repository['primitives']` + the bound implementation block.

**Test first** (`test/unit/repository/repository.test.ts`):
`repository.test.ts:79-101` has an explicit primitives-list spec
that hard-codes the expected key set. Append `'walkWorkingTree'`
to the expected array. The `typeof` loop spec at lines 103-113
already iterates every primitive, so the binding shape is checked
automatically.

**Commit:** `feat(repository): expose primitives.walkWorkingTree`.

## Step 7 — Integration test

**Files touched:**

- `test/integration/add-all.test.ts` — new file.

**Test contents:**

- Spin a memory-context repo via `seedRepo`.
- Populate working tree: `src/a.ts`, `src/b.ts`, `README.md`,
  `node_modules/foo/index.js`, `dist/main.js`, a symlink `link → src/a.ts`,
  an embedded `vendor/lib/.git/config`.
- Run `repo.add([], { all: true })`.
- Read `.git/index` via `readIndex`. Expect entries for
  `README.md`, `dist/main.js` (yes — ignore stub returns false),
  `link`, `node_modules/foo/index.js`, `src/a.ts`, `src/b.ts`. NO
  entries under `vendor/lib/` (embedded repo skipped).
- Stable order: paths sorted.

**Commit:** `test(integration): add --all walks the working tree`.

## Step 8 — Coverage / mutation polish

**Files touched:** add tests as needed to plug coverage gaps that
`npm run test:coverage` surfaces.

Common holes (predicted from the design):

- Guard `all === true && paths.length !== 0` needs an isolated test
  (already #14 in step 5).
- Guard `seen.has(path)` in the removed loop — needs a test where
  multiple paths are in existing, only one missing from disk.
- `previous.mode !== entry.mode` branch — needs a test where the
  blob bytes stay the same but mode flips (e.g. `chmod +x`).
- `existing.get(path) === undefined` vs. `existing.get(path) !== undefined`
  for the "stage but unchanged" case — already covered by spec #17
  via the modified-only check, but assert added/modified are BOTH
  empty when nothing changed.

**Commit:** `test(add): plug coverage gaps in --all flow`.

## Step 9 — Mutation testing

Run `stryker run --mutate src/application/commands/add.ts,src/application/primitives/walk-working-tree.ts`.

For every surviving mutant:

- Add a focused test that kills it (try/catch + `data` assertion
  for error-shape mutants; isolated guard tests for combined
  predicates).
- Equivalent mutants get an inline `// equivalent-mutant: <why>`
  comment per CLAUDE.md, only if provably equivalent (e.g. loop
  `i < len` vs `i <= len` where out-of-bounds returns undefined in
  homogeneous data).

**Commit:** `test(add): kill mutants in --all walk + stageFromStat`.

## Step 10 — Docs refresh

**Files touched:**

- `README.md` — `add()` section gains a `--all` example. Call out
  that ignore evaluation is §14.3 ("v1.x patch follow-up — embedded
  repos already skipped, but `.gitignore` is not honoured yet").
- `MIGRATION.md` — note the new mode under "additions in 14.x".
- `RUNBOOK.md` — operator notes: file-size cap, behaviour on
  embedded repos, no `.gitignore` yet.
- `docs/BACKLOG.md` — flip `[ ] 14.1` → `[x] 14.1 …` with the
  acceptance summary.

**Commit:** `docs(add-all): update README/MIGRATION/RUNBOOK + BACKLOG`.

## Order summary

```
1. error variant
2. cap constant
3. walkWorkingTree primitive (TDD ×13)
4. refactor stageFromStat
5. addAll core (TDD ×14)
6. repository facade exposure
7. integration test
8. coverage polish
9. mutation polish
10. docs + BACKLOG
```

Then: 3 review passes (4 reviewers each) → harness green → push →
open PR.

## Dependencies

- Step 2 depends on Step 1 (constant cannot reference cap error
  without the error variant existing).
- Step 5 depends on Steps 1-4.
- Step 6 depends on Step 3.
- Steps 7-10 depend on Step 5.
- Steps 1-3 are parallel-safe (no shared file) if multiple agents
  are used; in practice run serially per the conventional-commit
  atomicity rule.
