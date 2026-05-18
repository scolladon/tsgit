# Plan — Phase 14.3 — `.gitignore` evaluation + `status` untracked enumeration

Design: `docs/design/phase-14-3-gitignore.md`.
ADRs: 033 (sources), 034 (homedir), 035 (walk pruning), 036 (bounded read).

Branch: `feat/gitignore`.

Atomic conventional-commit per step. `npm run validate` green before
committing. TDD per slice.

## Step 1 — Error variant `GITIGNORE_FILE_TOO_LARGE`

**Files touched:**
- `src/domain/commands/error.ts` — variant + factory.
- `src/domain/error.ts` — `extractDetail` arm.
- `test/unit/domain/commands/error.test.ts` — factory + message tests.
- `test/unit/domain/exhaustiveness.ts` — add case.

**Commit:** `feat(error): add GITIGNORE_FILE_TOO_LARGE variant`.

## Step 2 — Constant `MAX_GITIGNORE_BYTES`

**Files touched:**
- `src/application/primitives/types.ts` — export
  `MAX_GITIGNORE_BYTES = 1 * 1024 * 1024`.

No standalone test — value asserted via the loader's boundary test.

**Commit:** `feat(primitives): export MAX_GITIGNORE_BYTES`.

## Step 3 — `RepositoryLayout.homeDir` plumbing

**Files touched:**
- `src/ports/context.ts` — add `homeDir?: string` to
  `RepositoryLayout`.
- `src/adapters/node/node-adapter.ts` — populate from `os.homedir()`.
- `src/adapters/memory/memory-adapter.ts` — accept `homeDir?` option;
  default undefined.
- `src/repository.ts` — `RepositoryLayoutInput` mirrors the new field.

**Tests first** (`test/unit/adapters/memory/...`,
`test/unit/repository/...`):
- Memory adapter: `createMemoryContext({ homeDir: '/home/me' })`
  surfaces it on `ctx.layout.homeDir`.
- Memory adapter: no option → `ctx.layout.homeDir === undefined`.
- Node shim: layout.homeDir is `os.homedir()` (snapshot one case).

**Commit:** `feat(ports): surface RepositoryLayout.homeDir`.

## Step 4 — `matchInStack` domain primitive

**Files touched:**
- `src/domain/ignore/matcher-stack.ts` — new file with
  `IgnoreLevel` + `matchInStack`.
- `src/domain/ignore/index.ts` — barrel export.

**Tests first** (`test/unit/domain/ignore/matcher-stack.test.ts`):
- Empty stack → `unset`.
- Single root level → identical to bare `matches()`.
- Two levels at root → last-rule-across-stack wins.
- Level at `<basedir>` → rules apply only to paths under it.
- Negation in inner level overrides ignore in outer.
- Path NOT under any level's basedir → `unset`.
- `basedir === ''` matches every path.
- Path-relative computation: a rule like `*.log` at basedir `src`
  matches `src/foo.log` but the relative path the matcher sees is
  `foo.log`.

**Commit:** `feat(ignore): add matcher-stack composition`.

## Step 5 — `readGitignore` loader

**Files touched:**
- `src/application/commands/internal/read-gitignore.ts` — new file:
  `readGitignore(ctx, dir)`, `readInfoExclude(ctx)`,
  `readGlobalExcludes(ctx)`, `loadAndParse(ctx, path)`,
  `expandUserPath(ctx, path)`.
- `src/application/commands/internal/config-read.ts` — extend
  `ParsedConfig.core` with `excludesFile?: string` and the
  assembleParsed branch.

**Tests first**
(`test/unit/application/commands/internal/read-gitignore.test.ts`):

- Missing file → `undefined`.
- Present + small → parsed rules.
- Size at cap (1 MiB exactly) → parsed.
- Size at cap + 1 → throws `GITIGNORE_FILE_TOO_LARGE`.
- Config without `excludesFile` → global = `undefined`.
- Config with `excludesFile` absolute → loads from path.
- Config with `excludesFile` starting `~/` + `homeDir` set → expanded
  correctly.
- Config with `~` path + `homeDir` undefined → `undefined`
  (silent miss, see ADR-034).
- Config parse change: a test that `ParsedConfig.core.excludesFile`
  round-trips.

**Commit:** `feat(ignore): gitignore loaders for repo + info + global`.

## Step 6 — `buildIgnoreEvaluator` + `buildRepoIgnorePredicate`

**Files touched:**
- `src/application/commands/internal/build-ignore-evaluator.ts` —
  new file: composes the base stack from the loaders, returns
  `{ stack, loadDirRules }`.
- `src/application/commands/internal/add-ignore.ts` — widen
  `IgnorePredicate` to `(path, isDir) => boolean | Promise<boolean>`;
  add `buildRepoIgnorePredicate(ctx)`; keep
  `defaultIgnorePredicate` as the sync fallback.

**Tests first**
(`test/unit/application/commands/internal/build-ignore-evaluator.test.ts`):

- No `.gitignore` anywhere → empty stack, predicate returns `false`
  for everything.
- Root `.gitignore` with `*.log` → predicate returns `true` for
  `foo.log` and `sub/bar.log`.
- Nested `.gitignore` in `sub/` with `!keep.log` overrides root's
  `*.log` for paths under `sub/`.
- `.git/info/exclude` rule honoured.
- `core.excludesFile` rule honoured (use memory adapter with custom
  `homeDir`).
- Predicate caches each nested ruleset (call `loadDirRules` directly
  in a spy).

**Commit:** `feat(ignore): build repo ignore evaluator + async predicate`.

## Step 7 — `walkWorkingTree` accepts the predicate

**Files touched:**
- `src/application/primitives/types.ts` — extend
  `WalkWorkingTreeOptions` with `ignore?: WalkIgnorePredicate`.
- `src/application/primitives/walk-working-tree.ts` — call predicate
  before descent and before yielding leaf; await every call.

**Tests first**
(extend `test/unit/application/primitives/walk-working-tree.test.ts`):
- Predicate that drops one leaf → only the other yielded.
- Predicate that prunes a directory → no leaves under it yielded AND
  `lstat` is NOT invoked for them (track via spy on fs.lstat).
- Predicate returning a `Promise<boolean>` → walker awaits.
- Without `ignore` option → §14.1 behaviour unchanged (regression
  pin).

**Commit:** `feat(primitives): walkWorkingTree honours ignore predicate`.

## Step 8 — Wire `add --all`

**Files touched:**
- `src/application/commands/add.ts` — `addAll` builds the predicate
  via `buildRepoIgnorePredicate` when no override is supplied and
  passes it to `walkWorkingTree` AND uses it for the existing
  `processWalkEntry` filter.

**Tests first** (extend `test/unit/application/commands/add.test.ts`):
- `node_modules/foo` ignored via repo-root `.gitignore` → not staged.
- `dist/` (directory rule) → entire subtree skipped; no leaf lstat.
- Tracked-but-ignored file stays staged across re-add (§14.1
  invariant pinned again).
- Nested `.gitignore` with negation: `*.log` in root, `!keep.log` in
  `sub/` → `sub/keep.log` staged, `sub/other.log` not.
- `.git/info/exclude` rule honoured at add level (smoke test).

**Commit:** `feat(add): bulk-mode honours gitignore stack`.

## Step 9 — `status` untracked enumeration

**Files touched:**
- `src/application/commands/status.ts` — fan out
  `walkWorkingTree(ctx, { ignore })` after the index pass, push
  `{ kind: 'untracked', path }` for leaves not in `indexByPath`,
  update `clean` to count them.

**Tests first** (extend `test/unit/application/commands/status.test.ts`):
- Untracked file (not in index, not ignored) → `'untracked'`
  ChangeEntry.
- Untracked + ignored → NOT in `workingTreeChanges`.
- Tracked + ignored → emits as modified/clean based on disk state.
- `clean = false` when untracked exists.
- `clean = true` when only ignored untracked files exist.
- Untracked ordering — pin sort order (alphabetical) to kill
  insertion-order mutants.

**Commit:** `feat(status): emit untracked entries honouring gitignore`.

## Step 10 — Integration test

**Files touched:**
- `test/integration/gitignore-end-to-end.test.ts` — populate a memory
  repo with a multi-level `.gitignore` setup + `.git/info/exclude` +
  global excludes via memory `homeDir`; run `add --all` + `status`;
  assert end-to-end behaviour.

**Commit:** `test(integration): gitignore end-to-end through add + status`.

## Step 11 — Coverage / mutation polish

Run coverage; fill any gap. Run stryker on the §14.3 surface; kill
killable mutants (boundary tests for the 1 MiB cap, ordering tests
for the stack iteration, isolated-guard tests for the negation
short-circuit).

**Commit:** `test(ignore): kill mutants on stack composition + loaders`.

## Step 12 — Docs refresh + BACKLOG tick

- `README.md` — add a "Ignore rules" subsection under the `add`
  section; mention status untracked emission.
- `MIGRATION.md` — update the `git.add` and `git.status` rows.
- `RUNBOOK.md` — note the gitignore cap; the four sources; how to
  configure `homeDir` for memory tests.
- `docs/BACKLOG.md` — flip `[ ] 14.3` → `[x] 14.3 …`.

**Commit:** `docs(gitignore): readme migration runbook + backlog`.

## Order summary

```
1. error variant
2. cap constant
3. homeDir on layout
4. matchInStack domain primitive
5. loaders (repo / info / global) + config extension
6. evaluator + repo predicate factory
7. walkWorkingTree predicate plumbing
8. add --all wiring
9. status untracked enumeration
10. integration test
11. coverage + mutation polish
12. docs + BACKLOG
```

Then: 3 review passes → harness green → push → open PR.

## Dependencies

- Step 4 (matcher-stack) is parallel-safe with steps 1-3 if multi-agent.
- Steps 5 & 6 chain: loaders → evaluator.
- Steps 7-9 depend on step 6.
- Step 10-12 depend on 7-9.
