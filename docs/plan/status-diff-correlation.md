# Plan — status↔diff correlation

TDD, per-slice. `npm run validate` green before every commit. No ignore
directives, no phase/ADR refs in source.

## Slice 1 — richer working-tree comparison delta

Surface the working file's mode (`mW`) without a second `lstat` and without
churning the four enum-only consumers.

- **Red** — extend `test/unit/application/primitives/compare-working-tree-entry.test.ts`:
  - `compareWorkingTreeDelta` returns `{ status, worktreeMode }` with the derived
    working mode for `modified` (regular/exec/symlink), `type-changed`,
    `mode-changed`, and `unchanged`; `worktreeMode` omitted for `absent`.
  - `compareWorkingTreeEntry` still returns the bare `WorkingTreeComparison` enum
    (projection unchanged).
  - Run `npx vitest run test/unit/application/primitives/compare-working-tree-entry.test.ts` → fails (`compareWorkingTreeDelta` absent).
- **Green** — in `src/application/primitives/compare-working-tree-entry.ts`:
  - Add `export interface WorkingTreeDelta { readonly status: WorkingTreeComparison; readonly worktreeMode?: FileMode; }`.
  - Move the body into `export const compareWorkingTreeDelta = async (ctx, entry): Promise<WorkingTreeDelta>`: `absent` → `{ status: 'absent' }`; every present branch returns `{ status, worktreeMode: workingMode }` (the value already computed by `deriveWorkingMode`).
  - Redefine `compareWorkingTreeEntry` as `async (ctx, entry) => (await compareWorkingTreeDelta(ctx, entry)).status`.
  - Export `compareWorkingTreeDelta` + `WorkingTreeDelta` from `application/primitives/index.ts` if the barrel re-exports the comparator (match existing export style).
- **Refactor** — keep `isWorkingTreeModified(WorkingTreeComparison)` as-is; the four enum consumers (`rm`, `stash`, `clean-work-tree`, `apply-merge-to-worktree`) are untouched.
- `npm run validate`; commit `refactor(primitives): surface worktree mode via comparison delta`.

## Slice 2 — correlated `ChangedPath` record (pivot, breaking)

The breaking type restructure; lands atomically with every consumer so validate
stays green.

- **Red** — rewrite `test/unit/application/commands/status.test.ts` to the new
  shape. Cases (assert endpoints, not only kinds — mutation resistance):
  - staged-only: add (no `head`, `index`+`worktree`, `staged:'added'`), modify
    (`head`+`index`+`worktree`, `staged:'modified'`), delete (`head` only,
    `staged:'deleted'`), type-change, mode-change.
  - unstaged-only: modify (`head`==`index`, `worktree`, `unstaged:'modified'`),
    delete (`head`+`index`, no `worktree`, `unstaged:'deleted'`), type/mode.
  - both columns on one path: `MM`, `AM`, `MD`.
  - `rm --cached`: path in `changes` (`staged:'deleted'`, `head`) **and** in
    `untracked`.
  - untracked-only: path in `untracked`, absent from `changes`.
  - unborn HEAD: all `staged:'added'`, no `head`.
  - clean tree: `changes`/`untracked`/`unmerged` empty, `clean === true`.
  - conflicted index: paths only under `unmerged`, absent from `changes`/
    `untracked`; `clean === false`.
  - `toStagedKind` / `toUnstagedKind` direct unit cases (each arm).
  - Run the file → fails (old shape).
- **Green** — `src/application/commands/status.ts`:
  - Types: add `BlobSide { id, mode }`, `WorktreeSide { mode }`, `ChangedPath`;
    `ChangeKind` drops `'untracked'`; `StatusResult` → `{ branch, detached,
    changes, untracked, unmerged, clean }`. Rename `ConflictStage` → `BlobSide`;
    `UnmergedEntry.base/ours/theirs: BlobSide`. Remove `ChangeEntry`,
    `toStagedChange`, `toWorkingTreeChange`.
  - Mappers: `toStagedKind(change: DiffChange): ChangeKind`; `toUnstagedKind(status: WorkingTreeComparison): ChangeKind | undefined` (`unchanged` → undefined, `absent` → `'deleted'`).
  - `buildChangedPath(path, staged, delta, headTree, indexEntry)` — spreads `staged`/`unstaged`/`head`/`index`/`worktree` only when defined (per design §Algorithm).
  - `status()` body: build `stage0Map`; working pass → `workingMap: Map<path, WorkingTreeDelta>` over all stage-0 entries (skip-worktree skipped); untracked pass → `untracked: FilePath[]` (not in `stage0 ∪ unmerged`), sorted; staged pass → `stagedKindMap` (minus unmerged paths); merge the union → `changes` sorted by `comparePaths`; `clean` = all three empty.
  - `toUnmergedEntries` unchanged except `ConflictStage` → `BlobSide`.
  - Run `status.test.ts` → pass.
- **Consumers** (same commit, for green validate):
  - `describe.ts` dirty check → `state.changes.length > 0 || state.unmerged.length > 0`.
  - `commands/index.ts` barrel: drop `ChangeEntry`, `ConflictStage`; add
    `ChangedPath`, `BlobSide`, `WorktreeSide`.
  - Update every test that reads the old fields (verified by validate): grep
    `indexChanges|workingTreeChanges|ChangeEntry|kind: 'untracked'|ConflictStage`
    across `test/` — `checkout.test.ts`, `sparse-checkout.test.ts`,
    `sparse-reset-merge.test.ts`, `gitignore-end-to-end.test.ts`,
    `snapshot/stash-snapshot.test.ts`, `materialize-tree.test.ts` (only those that
    actually consume `StatusResult`; string-only matches left alone).
  - `status-interop.test.ts`: `reconstruct` (v1) sources from `changes`
    (`staged`/`unstaged`) + `untracked` + `unmerged`.
  - `test/parity/scenarios/init-add-commit-status.scenario.ts` + `test/browser/opfs-roundtrip.spec.ts`: field renames.
  - Regenerate `reports/api.json` (`npm run` doc-typedoc target; prepush gate).
- `npm run validate`; commit `feat(status)!: correlate staged/unstaged per path with diff endpoints`.

## Slice 3 — porcelain v2 endpoint interop

Pin the new endpoints byte-for-byte (the faithfulness anchor for the added data).

- **Red/Green** (interop tests are additive, asserted against live git) — in
  `test/integration/status-interop.test.ts` add a `reconstructV2(s)` building the
  ordinary `1 <XY> N... <mH> <mI> <mW> <hH> <hI> <path>` lines from `changes`
  endpoints (`.` for an unchanged side; `000000`/40×`0` for an absent side) +
  untracked `? <path>` lines, asserted byte-equal with
  `git status --porcelain=v2 --no-renames` across the non-conflict scenarios
  (add/modify/delete/MM/cached-delete/type/mode/unborn/clean). Conflict scenario
  stays v1 (unmerged `u`-line `mW` is out of scope — 23.4m).
- `npm run validate`; commit `test(status): reconstruct git porcelain v2 from change endpoints`.

## Review / refactor / mutation / docs

- **Step 6** — typescript / security / tests review passes over `git diff main...HEAD`.
- **Step 7** — architecture pass: `BlobSide` consolidation is done in-feature;
  reconsider whether `head` population from `FlatTreeEntry` warrants a shared
  helper (likely no — single call site). Justify no-op if nothing else surfaces.
- **Step 8** — `stryker run --mutate` on `status.ts`, `compare-working-tree-entry.ts`.
- **Step 9** — `docs/use/commands/status.md`, `README.md` (status example;
  command count unchanged — no new command), `docs/get-started/{node,deno}.md` +
  `migrate-from-isomorphic-git.md` if they show the status shape; flip
  `docs/BACKLOG.md` 23.4h `[ ]` → `[x]`; add 23.4m follow-up.
