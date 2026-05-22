# Implementation Plan — Sparse-checkout awareness in `reset` / `merge` (17.3a)

Derived from [`docs/design/sparse-reset-merge.md`](../design/sparse-reset-merge.md),
[ADR-075](../adr/075-reset-sparse-integration.md),
[ADR-076](../adr/076-merge-conflict-materialization.md).

TDD throughout: Red → Green → Refactor. `Given/When/Then` titles, AAA bodies,
`sut`. `npm run validate` before every commit. One concept per commit.

## Step 1 — Shared `skipWorktreeEntry` domain helper

**Depends on:** nothing.

- **Test first** — extend `test/unit/domain/git-index/index-entry.test.ts`:
  - Given `{ path, id, mode }`, When `skipWorktreeEntry`, Then every stat field
    is `0`, `flags` equals `STAGE0_FLAGS` with `skipWorktree: true`, and
    `id` / `mode` / `path` are copied verbatim.
- **Implement** — add `export const skipWorktreeEntry` to
  `src/domain/git-index/index-entry.ts`; re-export from
  `src/domain/git-index/index.ts`.
- **Refactor** — `src/application/primitives/materialize-tree.ts`: delete the
  file-private `skipWorktreeEntry`, import the domain one. The point-free
  `plan.excluded.map(skipWorktreeEntry)` call site is preserved (the domain
  helper takes a structural `{ path, id, mode }`).
- **Verify** — `npm run validate`: the materialize-tree suite is green (the
  helper is identical in behaviour), `check:duplicates` no longer has the
  two-copy risk.
- **Commit** — `refactor(git-index): extract skipWorktreeEntry to the domain`.

## Step 2 — `buildIndexFromTree` sparse parameter

**Depends on:** Step 1.

- **Test first** — extend
  `test/unit/application/primitives/build-index-from-tree.test.ts`:
  - `sparse` excludes a path with a *matching* donor (real stats) → entry has
    `skipWorktree: true` and zeroed stats (donor ignored).
  - `sparse` excludes a path with *no* donor → zero-stat skip-worktree entry.
  - `sparse` includes a path whose donor carries `skipWorktree: true` → entry
    has `skipWorktree: false`, donor stats preserved.
  - `sparse` includes a path with a matching donor → stats preserved,
    `skipWorktree: false`.
  - `sparse` includes a path with no donor → zero stats, `skipWorktree: false`.
  - the existing `sparse`-omitted tests stay green unchanged (regression
    guard for the `sparse === undefined` branch).
- **Implement** — `src/application/primitives/build-index-from-tree.ts`:
  add `sparse?: SparseMatcher` to `BuildIndexFromTreeOpts`; `projectLeaf` gains
  the `sparse` argument and the excluded-path early return; add `includedFlags`
  (matcher-active vs inactive flag spread); thread `opts.sparse` through
  `buildIndexFromTree`'s `.map`.
- **Verify** — `npm run validate`.
- **Commit** — `feat(primitives): buildIndexFromTree honours a sparse matcher`.

## Step 3 — `reset --mixed` wiring

**Depends on:** Step 2.

- **Test first** — extend `test/unit/application/commands/reset.test.ts`:
  - `reset --mixed` in a sparse repo → the committed index marks excluded paths
    `skipWorktree: true`, in-pattern paths clear.
  - `reset --mixed` in a non-sparse repo → index byte-identical to today
    (regression).
- **Implement** — `src/application/commands/reset.ts` `rebuildIndexFromCommit`:
  `const matcher = await loadSparseMatcher(ctx)` before `acquireIndexLock`;
  conditional-spread `sparse` into the `buildIndexFromTree` call.
- **Verify** — `npm run validate`.
- **Commit** — `feat(reset): reset --mixed honours core.sparseCheckout`.

## Step 4 — `reset --hard` wiring + commit-guard widening

**Depends on:** nothing — `materializeTree.sparse` already exists from 17.3.
Sequenced after Step 1 only for a tidy diff.

- **Test first** — extend `reset.test.ts`:
  - `reset --hard` in a sparse repo → excluded files are not re-materialised on
    disk and their index entries carry `skipWorktree: true`; in-pattern files
    are written; `status` is clean afterwards.
  - `reset --hard` in a non-sparse repo → behaviour unchanged (regression).
  - the widened commit guard: a `reset --hard` whose target tree is *entirely*
    excluded still commits the index (excluded entries' ids updated).
- **Implement** — `hardResetFromCommit`: `loadSparseMatcher` before the lock;
  conditional-spread `sparse` into `materializeTree`; widen the guard to
  `result.written > 0 || result.deleted > 0 || matcher !== undefined`.
- **Verify** — `npm run validate`.
- **Commit** — `feat(reset): reset --hard honours core.sparseCheckout`.

## Step 5 — `merge` sparse integration

**Depends on:** nothing (independent of Steps 2–4).

- **Test first** — extend `test/unit/application/commands/merge.test.ts`:
  - `writeOutcomeToTree` with a matcher excluding the path → `unchanged` /
    `resolved-known` / `resolved-merged` outcomes are **not written**; each
    status tested independently.
  - `writeOutcomeToTree` with a matcher including the path, or `undefined`
    matcher → written (regression).
  - `writeConflictToTree` / `writeConflictingWorkingTree` → an excluded
    conflicted path **is** written (ADR-076).
  - `buildConflictIndexEntries` → an excluded `unchanged` / `resolved-known`
    stage-0 entry carries `skipWorktree: true`; an included one does not;
    conflict stage-1/2/3 rows unchanged.
  - a full conflicting `merge` in a sparse repo (integration-style, memory
    adapter) → excluded clean paths absent, conflicted path materialised.
- **Implement** — `src/application/commands/merge.ts`:
  `persistConflictState` calls `loadSparseMatcher` before `acquireIndexLock`;
  thread the `matcher` (`SparseMatcher | undefined`) through
  `writeConflictingWorkingTree` → `writeOutcomeToTree`, and into
  `buildConflictIndexEntries`. `writeConflictToTree` is unchanged.
- **Verify** — `npm run validate`.
- **Commit** — `feat(merge): conflicting merge honours core.sparseCheckout`.

## Step 6 — Integration tests

**Depends on:** Steps 3–5.

- **Implement** — add `test/integration` coverage exercising real `reset
  --hard`, `reset --mixed`, conflicting `merge` end-to-end in a sparse repo
  (enable `core.sparseCheckout`, set a pattern file, run the command, assert
  disk + index + `status`). Extend the sparse interop proof if a real-`git`
  harness exists: `git` accepts the index `reset --mixed` writes.
- **Verify** — `npm run validate` + `npm run test:integration`.
- **Commit** — `test(integration): sparse reset/merge end-to-end`.

## Step 7 — Review ×3, harness, mutation

- Three review passes over the diff (code / perf / security / tests), parallel
  agents, fixing every finding each pass.
- `npm run validate` fully green.
- `stryker run` over `index-entry.ts`, `build-index-from-tree.ts`, `reset.ts`,
  `merge.ts`, `materialize-tree.ts` — kill every killable mutant; document
  provable equivalents inline.

## Step 8 — Docs refresh, BACKLOG flip, deps

- `docs/design/sparse-checkout.md` — flip the §1 "out of scope" 17.3a note to
  "delivered in 17.3a".
- `docs/adr/073-sparse-integration-scope.md` — add a forward note: the deferral
  is resolved in 17.3a (ADR-075, ADR-076).
- `README.md`, `RUNBOOK.md` — drop the "reset/merge re-materialise excluded
  files" sharp-edge note.
- `docs/BACKLOG.md` — flip **17.3a** `[ ]` → `[x]` inside this PR's commits.
- `npm run check:deps` green — bring outdated dependencies current.
- **Commit** — `docs: record sparse reset/merge delivery (17.3a)`.

## Dependency graph

```
Step 1 ─┬─> Step 2 ──> Step 3 ─┐
        └─> Step 4 ────────────┼─> Step 6 ──> Step 7 ──> Step 8
Step 5 ───────────────────────┘
```
