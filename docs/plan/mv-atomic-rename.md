# Plan — `mv` (atomic rename in index + working tree)

Implements `docs/design/mv-atomic-rename.md` under ADR-200 (sources[]+destination
API), ADR-201 (force/dryRun/skipErrors), ADR-202 (granular `MV_*` error codes).

## Gate constraints discovered (shape the commit boundaries)

- **Error codes ⇔ messages are one commit.** `extractDetail` in
  `src/domain/error.ts` ends in `const _exhaustive: never = data` — adding a
  code to the `CommandError` union without its message arm fails `check:types`.
- **`dirname` / `renameInWorkingTree` land with their caller.** `knip`
  (`check:dead-code`) scans `src/**` only; test usage does not count and these
  helpers are not entry-reachable, so they must arrive in the same commit as
  `mv.ts`, which imports them. Error factories, by contrast, are re-exported
  from `domain/commands/index.ts` (entry-reachable) → knip-safe alone.
- **Binding `repo.mv` fires three blocking gates** that parse `repository.ts`:
  `check:doc-coverage` (needs `docs/use/commands/mv.md` + a README index row),
  `check:browser-surface` (needs `repo.mv(` in a `test/parity/scenarios/*.ts`
  or `test/browser/*.spec.ts`). So the facade-binding commit must also ship the
  doc page and the parity scenario.
- `check:write-surfaces` is warn-only and only inspects `@writes` JSDoc tags
  (no command has one) → no action. `check:parity-fixtures` forbids
  non-deterministic constructs in scenarios → use the fixed `AUTHOR` fixture.
- `check:spelling` (cspell) runs over the repo; new prose terms in comments
  (`reparent`, `repath`, …) may need a dictionary entry. If validate flags one,
  reword the comment rather than widening the dictionary (KISS), unless the term
  is genuinely domain vocabulary.

## Slice order & dependency graph

```
1 errors ──▶ 2 command ──▶ 3 facade+docs+parity
(1 is independent; 2 depends on 1; 3 depends on 2)
```

---

## Slice 1 — domain refusal errors

**Files**
- `src/domain/commands/error.ts` — 7 union members + 7 factories.
- `src/domain/error.ts` — 7 `extractDetail` arms.
- `src/domain/commands/index.ts` — re-export the 7 factories (keeps them
  entry-reachable for knip).
- `test/unit/domain/error.test.ts` — message-rendering + factory `.data` tests.

**Codes** (each `{ source: FilePath; destination: FilePath }`):
`MV_SOURCE_NOT_TRACKED`, `MV_BAD_SOURCE`, `MV_DESTINATION_EXISTS`,
`MV_INTO_SELF`, `MV_DESTINATION_NOT_DIRECTORY`,
`MV_DESTINATION_DIRECTORY_MISSING`, `MV_MULTIPLE_SOURCES_SAME_TARGET`.

**Factories** (mirror existing two-field factories like `nonFastForward`):
`mvSourceNotTracked`, `mvBadSource`, `mvDestinationExists`, `mvIntoSelf`,
`mvDestinationNotDirectory`, `mvDestinationDirectoryMissing`,
`mvMultipleSourcesSameTarget` — each `(source, destination) => new TsgitError(…)`.

**Messages** (faithful, verified against git):
- `not under version control, source=${source}, destination=${destination}`
- `bad source, source=${source}, destination=${destination}`
- `destination exists, source=${source}, destination=${destination}`
- `can not move directory into itself, source=${source}, destination=${destination}`
- `destination '${destination}' is not a directory, source=${source}`
- `destination directory does not exist, source=${source}, destination=${destination}`
- `multiple sources for the same target, source=${source}, destination=${destination}`

**Red** — add to `error.test.ts`, per code: construct via factory, assert
`sut.data.code`, `sut.data.source`, `sut.data.destination`, and the exact
`sut.message` string (kills StringLiteral mutants in `extractDetail`). One
isolated `it` per code. Run `npx vitest run test/unit/domain/error.test.ts` —
fails (codes/factories absent → type + runtime errors).

**Green** — add union members, factories, message arms, re-exports. Re-run file.

**Verify** — `npm run validate`. Commit: `feat(domain): mv refusal error codes`.

---

## Slice 2 — `mv` command + helpers

**Files**
- `src/domain/error.ts` — add `dirname(path)` next to `basename` (pure;
  everything before the final `/`, `''` for a root-level path).
- `src/application/commands/internal/working-tree.ts` — add
  `renameInWorkingTree(ctx, from, to)`: `validatePath` both, `ctx.fs.rename`.
- `src/application/commands/mv.ts` — the command (below).
- `src/application/commands/index.ts` — `export { type MvOptions, type MvMove,
  type MvSkipReason, type MvSkipped, type MvResult, mv } from './mv.js'`.
- `test/unit/application/commands/mv.test.ts` — full suite.
- `test/unit/domain/error.test.ts` — `dirname` cases.

**`mv.ts` structure** (small functions, early returns, ≤20 lines each):
- `mv(ctx, sources, destination, opts={})` — asserts, validate paths,
  `acquireIndexLock`, read index (tolerate `INDEX_MISSING_CODES` → empty),
  `resolveDestinationMode`, plan loop, `assertNoTargetCollision`, dryRun short-
  circuit, execute (mutate map → working-tree renames → `lock.commit`),
  `finally release`.
- `resolveDestinationMode(ctx, sources, destination)` →
  `{ kind:'rename', target } | { kind:'into-dir', destDir }`; throws
  `MV_DESTINATION_NOT_DIRECTORY` / `MV_DESTINATION_DIRECTORY_MISSING`.
- `classifySource(byPath, source)` → `'file' | 'directory' | 'untracked'`.
- `validateMove(ctx, byPath, source, target, opts)` →
  `{ ok, kind, entries } | { skip: MvSkipReason }` (throws structural errors).
- `reparent(entries, source, target)` → repathed `IndexEntry[]`.
- `assertNoTargetCollision(plan)` → throws `MV_MULTIPLE_SOURCES_SAME_TARGET`.
- `errorFor(reason, source, target)` → maps a `MvSkipReason` to its factory.

**Test cases** (GWT describe/it, AAA, `sut`; reuse `seedRepo` + `add` like
`rm.test.ts`; `expectError` helper for `.data` assertions):

Happy paths
- file rename → index entry repathed (same blob id), working file moved, old gone.
- **cache-entry copy** (headline): seed + commit `a`, modify `a` on disk
  (unstaged), `mv(['a'],'b')` ⇒ working `b` = modified bytes, index blob at `b`
  = the staged blob of `a` (not a re-hash of the modified content).
- move single file into existing dir → `dir/a`.
- move multiple files into existing dir → `dir/a`, `dir/b`; `moved` sorted.
- directory rename → all `dir/*` entries reparented; an untracked file inside
  the dir is carried by the single `fs.rename`.
- move directory into existing dir → `existing/dir/*`.
- `force`: overwrite a tracked dest (file source); overwrite an on-disk
  untracked dest (file source).
- `dryRun`: returns the planned `moved`, index unchanged, working tree unchanged.
- `skipErrors`: one bad + one good source ⇒ `skipped` has the bad with its
  reason, `moved` has the good; working tree reflects only the good move.

Refusals (each isolated, assert `.data.code` + `.data.source`/`.destination`)
- `MV_SOURCE_NOT_TRACKED` — untracked source.
- `MV_BAD_SOURCE` — tracked source missing from working tree.
- `MV_DESTINATION_EXISTS` — tracked dest (no force); on-disk untracked dest (no
  force); **directory source over an existing file even WITH force**.
- `MV_INTO_SELF` — `mv(['a'],'a')`; `mv(['dir'],'dir/sub')`.
- `MV_DESTINATION_NOT_DIRECTORY` — two sources, dest not a dir.
- `MV_DESTINATION_DIRECTORY_MISSING` — trailing-slash dest dir absent; single-
  source rename whose parent dir is absent.
- `MV_MULTIPLE_SOURCES_SAME_TARGET` — two sources mapping to one dir target.
- atomic abort (no skipErrors): one bad among good ⇒ throws, **no** working-tree
  mutation, index unchanged (assert both sources still present, dest absent).

Guards / infra (parallel to `rm.test.ts`)
- empty sources → `EMPTY_PATHSPEC`.
- bare repo → `BARE_REPOSITORY` with `operation:'mv'` + exact message.
- pending operation → `OPERATION_IN_PROGRESS`.
- source/dest path escape (`..`, `.git`) → `PATHSPEC_OUTSIDE_REPO`.
- corrupt/missing index tolerated → an untracked-source refusal still computed
  off the empty map.
- `breakStaleLockMs` breaks a stale lock; held lock → `RESOURCE_LOCKED`.
- lock released after success (second mv not locked) and after a pre-commit
  throw (`finally`).

`dirname` cases (in `error.test.ts`): `'a/b/c' → 'a/b'`, `'a' → ''`,
`'a/' → 'a'` (or document chosen rule), root-level path → `''`.

**No property tests** — orchestration over the index map + `fs.rename`; the four
CLAUDE.md lenses do not fit (documented in design + restated in the test-review
pass).

**Red** — write `mv.test.ts` (import `mv` — module absent → fail).
**Green** — implement helpers + `mv.ts`; iterate to green + 100% coverage on the
file (`npx vitest run test/unit/application/commands/mv.test.ts`).
**Verify** — `npm run validate`. Commit: `feat(commands): mv atomic rename`.

---

## Slice 3 — facade binding + docs page + parity scenario

**Files**
- `src/repository.ts` — `readonly mv: BindCtx<typeof commands.mv>;` in the
  interface (alphabetical, after `merge`/before `pull`) + the bound impl
  `mv: ((sources, destination, mvOpts) => { guard(); return commands.mv(ctx,
  sources, destination, mvOpts); }) as Repository['mv']`.
- `docs/use/commands/mv.md` — usage page (mirror `rm.md` structure).
- `docs/use/commands/README.md` — index row
  `| [\`mv\`](mv.md) | Rename/move tracked paths in the index + working tree. |`.
- `test/parity/scenarios/mv.scenario.ts` — `Scenario` exercising `repo.mv`
  (rename + move-into-dir), deterministic `AUTHOR`, pinned `expected`.
- `test/parity/scenarios/index.ts` — import + append `mvScenario` to `SCENARIOS`.

**Parity scenario shape** — init → add two files → commit (seed) → `repo.mv` a
file rename + a move-into-dir → assert `moved` pairs and (to lock the tree) a
follow-up `commit` id. `expected` oids captured by running the scenario once,
then cross-checked against real `git mv` producing the same tree (faithfulness).

**Red** — bind `repo.mv` only → `npm run validate` fails on `check:doc-coverage`
(missing page/row) and `check:browser-surface` (no `repo.mv(` coverage),
proving the gates bite.
**Green** — add the doc page, README row, and parity scenario + registration.
**Verify** — `npm run validate` (all gates green; node + memory parity drivers
run the new scenario). Commit:
`feat(repository): expose repo.mv with docs and parity scenario`.

---

## After the slices

- **Review ×3** (typescript / security / tests) over `git diff main...HEAD`.
- **Mutation** — `npm run test:mutation`; kill or annotate survivors in
  `mv.ts`, the error arms, and helpers.
- **Docs + PR (Step 8)** — `README.md` feature list, `RUNBOOK.md`,
  `CONTRIBUTING.md` if affected, flip `docs/BACKLOG.md` 21.2 `[ ] → [x]`,
  push, `gh pr create`.

## Commit sequence

1. `feat(domain): mv refusal error codes`
2. `feat(commands): mv atomic rename`
3. `feat(repository): expose repo.mv with docs and parity scenario`
4. (review fixes, as needed) `refactor|fix|test(...): apply <reviewer> findings`
5. (mutation) `test(mutation): mv`
6. `docs: mv usage + backlog 21.2`
