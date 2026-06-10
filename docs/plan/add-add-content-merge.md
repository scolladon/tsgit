# Plan — add/add content merge + distinct-types rename

Implements `docs/design/add-add-content-merge.md` (ADRs 310–311). Six slices,
sequential; each is a Red→Green→Refactor TDD unit ending in one atomic commit
on a green `npm run validate`.

Shared conventions for every slice: GWT describe/it split, AAA bodies, `sut`
names the unit under test, no ignore directives, no phase/ADR refs in code.
If `npm run validate` fails on `check:doc-typedoc` after a public-type change,
regenerate and commit `reports/api.json` in the same commit.

---

## Slice 1 — domain: empty-base content merge for regular add/add pairs

**Files:** `src/domain/merge/merge-types.ts`,
`src/domain/merge/three-way-tree.ts`,
`test/unit/domain/merge/three-way-tree.test.ts`.

1. **Red** — in `three-way-tree.test.ts`, under a new
   `describe('Given a both-added path with differing regular-file entries')`:
   - When the content merger resolves clean and modes are equal → Then the
     outcome is `resolved-merged` with the merger's bytes and the shared mode
     (and `resolved-known` when the merger returns an `id`).
   - When the merger resolves clean but modes differ (100644 vs 100755) → Then
     the outcome is a conflict `{ type: 'add-add', contentVerdict: 'clean' }`
     with `conflictContent` = the clean bytes, no `baseId`/`baseMode`.
   - When the merger conflicts (`conflictType: 'content'`) → Then
     `{ type: 'add-add', contentVerdict: 'content', conflictContent: markedBytes }`.
   - When the merger reports `binary` → Then `contentVerdict: 'binary'`.
   - Then the merger is invoked with a `ContentMergeContext` whose `baseId`
     and `baseMode` are absent (assert via a recording fake).
   - Given symlink/symlink or gitlink-involved pairs → Then the merger is
     **never** invoked and the bare `add-add` conflict (no `contentVerdict`)
     is returned.
   - Given oversize clean bytes / oversize marked bytes from the merger →
     Then `invalidMergeInput` refusal (assert error code + message data,
     each guard in its own test).
   - Existing test: identical entries still short-circuit to `resolved-known`
     without invoking the merger.
   Run `npx vitest run test/unit/domain/merge/three-way-tree.test.ts` — new
   tests fail (bare conflict returned / merger not called).
2. **Green** —
   - `merge-types.ts`: add
     `readonly contentVerdict?: 'clean' | 'content' | 'binary';` to
     `MergeConflict`.
   - `three-way-tree.ts`: `resolveAddAdd` takes the `contentMerger`; when both
     modes are regular-kind (100644/100755) and entries differ, await the
     merger with a base-less context (placeholder empty `Uint8Array`s, as
     `resolveContentMerge` does) and map per the tests above; enforce
     `MAX_CONFLICT_OUTPUT_BYTES` on clean and marked bytes. All other kind
     pairs keep the existing bare conflict. `resolvePath` passes the merger.
3. **Refactor** — share the oversize guard with `resolveContentMerge` if the
   extraction is clean; keep functions <20 lines.
4. Gate: `npm run validate`. Commit:
   `feat(merge): empty-base content merge for add/add paths`

## Slice 2 — domain: distinct-types rename conflict

**Files:** `src/domain/merge/merge-types.ts`,
`src/domain/merge/three-way-tree.ts`, `src/domain/merge/index.ts` (exports if
needed), `test/unit/domain/merge/three-way-tree.test.ts`.

1. **Red** — new describe blocks:
   - Given ours regular / theirs symlink, labels `{ours:'HEAD', theirs:'side'}`
     → Then one conflict
     `{ type: 'distinct-types', path: 'f', ourPath: 'f~HEAD', theirPath: 'f' }`
     carrying both sides' id/mode; the merger is never invoked.
   - Given ours symlink / theirs regular → Then `ourPath: 'f'`,
     `theirPath: 'f~side'` (regular side renamed, both orders).
   - Given theirs label `feature/x` → Then suffix flattens to `f~feature_x`.
   - Given `f~side` already present in any input tree → Then `f~side_0`; given
     both occupied → `f~side_0_1` (probe loop appends `_<n>` to the growing
     name, n starting at 0 — mirror git's `unique_path`).
   - Given two distinct-types conflicts whose renames would collide → Then the
     second probe also avoids the first generated path.
   - Given no labels passed to `mergeTrees` → Then the default labels
     (`DEFAULT_MERGE_LABELS`) drive the suffix.
   Run — fails (bare `add-add` returned today).
2. **Green** —
   - `merge-types.ts`: `ConflictType` gains `'distinct-types'`;
     `MergeConflict` gains `readonly ourPath?: FilePath` /
     `readonly theirPath?: FilePath`.
   - `three-way-tree.ts`: `mergeTrees(base, ours, theirs, contentMerger,
     labels = DEFAULT_MERGE_LABELS)`; build a `reserved` set from
     `buildUnionPaths`'s result; `resolveAddAdd` routes regular-vs-symlink to
     a `distinctTypesConflict` builder (flatten `/`→`_` in the label, probe
     uniqueness against `reserved`, add the generated path to `reserved`).
3. **Refactor** — keep the unique-path probe a small pure helper
   (`uniquePath(reserved, path, label)`), unit-tested through `mergeTrees`.
4. Gate + commit: `feat(merge): distinct-types add/add rename conflict`

## Slice 3 — domain: stage emission at per-side paths

**Files:** `src/domain/diff/index-diff.ts`,
`test/unit/domain/diff/index-diff.test.ts`.

1. **Red** —
   - Given a `distinct-types` conflict (`path f`, `ourPath f~HEAD`,
     `theirPath f`) → Then `conflictsToIndexEntries` emits exactly two
     entries: stage 2 at `f~HEAD` (ours id/mode), stage 3 at `f` (theirs
     id/mode), path-sorted.
   - Given two conflicts whose **recorded** paths collide → Then the
     duplicate-path refusal fires on recorded paths, not `conflict.path`
     (and a `distinct-types` conflict alongside an unrelated conflict at a
     different path does not).
2. **Green** — `conflictStageEmissions` returns per-emission paths
   (default `conflict.path`; `distinct-types` → `ourPath`/`theirPath`); the
   dedup check collects recorded paths.
3. Gate + commit: `feat(diff): stage distinct-types conflicts at per-side paths`

## Slice 4 — merge command: materialisation + labels threading

**Files:** `src/application/commands/merge.ts`,
`src/application/primitives/internal/write-working-tree-file.ts` (shared
mode-aware conflict write), `test/unit/application/commands/merge.test.ts`
(or the existing merge command test file — follow its layout).

1. **Red** —
   - `materialiseConflictBytes`: Given an `add-add` conflict **with**
     `conflictContent` → Then those bytes are returned (not ours' blob);
     Given a bare `add-add` (no content) → Then ours' blob (existing test
     stays).
   - Given a `distinct-types` conflict → Then the merge writes the regular
     side's blob at its recorded path and the symlink at its path via
     `ctx.fs.symlink` (memory adapter), and the unmerged index lands stage 2 /
     stage 3 at the recorded paths.
   - Given labels for the operation → Then `mergeTrees` receives them (the
     rename suffix in an end-to-end merge command test shows `~HEAD` /
     `~<rev>`).
2. **Green** —
   - Extend `write-working-tree-file.ts` with a mode-aware variant
     (symlink → `fs.symlink` after rm-if-exists, mirroring `apply-changeset`'s
     `writeFileEntry`); reuse it from `merge.ts` for distinct-types paths.
   - `materialiseConflictBytes` prefers `conflictContent` on `add-add`.
   - `writeConflictToTree` branches on `distinct-types` to write both sides.
   - Pass `mergeLabels(...)`'s result to `mergeTrees`.
3. Gate + commit:
   `feat(merge): materialise add/add merged content and renamed sides`

## Slice 5 — apply-merge primitives (cherry-pick/revert/rebase/stash path)

**Files:** `src/application/primitives/apply-merge-to-worktree.ts`,
`test/unit/application/primitives/apply-merge-to-worktree.test.ts`.

1. **Red** —
   - `conflictBytes`: Given any conflict with `conflictContent` → Then those
     bytes win (add-add markers now observably differ from ours — the old
     "equivalent" mutants are killable; assert marker bytes on disk).
   - Given a `distinct-types` conflict → Then both recorded paths are written
     (symlink-aware) and staged; `changedPaths` includes both, so a dirty or
     untracked file at the rename target yields `would-overwrite` with that
     path (one test per guard).
2. **Green** —
   - First branch of `conflictBytes` → `conflictContent !== undefined`.
   - Distinct-types dual-path write via the slice-4 shared helper; extend
     `changedPaths` to recorded paths (the unmerged-index build inherits them
     from slice 3's `conflictsToIndexEntries`).
   - Thread `input.labels` into `mergeTrees`.
   - **Re-derive every touched `Stryker disable` / equivalence comment**:
     delete the ones the new tests kill; re-justify any that remain against
     the new behaviour.
3. Gate + commit: `feat(merge): add/add content and distinct-types in apply-merge`

## Slice 6 — cross-tool interop

**Files:** `test/integration/add-add-content-interop.test.ts` (new; model on
`merge-conflict-interop.test.ts` — twin repos via `makePeerPair`, `runGit`
with scrubbed env, one shared `beforeAll` repo per scenario group if spawn
cost bites, 60s timeout per the interop-flake note).

Pin one case per design evidence row, comparing worktree bytes byte-for-byte
and stages via `lsStage` (git peer) vs tsgit's index:

1. Text add/add, shared prefix → per-region markers + stages 2/3.
2. Ours ⊂ theirs → empty-ours marker region.
3. Identical bytes, 100644 vs 100755 → clean bytes on disk, stage modes
   differ.
4. Binary add/add → ours bytes on disk.
5. `merge=union` add/add → clean merge, stage 0, concatenated bytes.
6. Symlink vs symlink → ours link on disk, stages 2/3.
7. Distinct types (both orders) → regular renamed `f~HEAD`/`f~side`, link at
   `f`, single-stage entries at recorded paths.
8. Slashed branch name → `f~feature_x`.
9. Tracked `f~side` → `f~side_0`.
10. Untracked file at rename target → both tools refuse, nothing written
    (tsgit: `would-overwrite`; git: "untracked working tree files").

Cherry-pick label suffix (`f~<abbrev> (<subject>)`) — one case driven through
`repo.cherryPick` vs git peer.

Gate + commit: `test(interop): add/add content merge and distinct-types parity`

---

## Post-implementation (session-run, not slices)

- Reviews ×3 (typescript / security / tests), architecture pass, mutation run
  scoped to touched files (`./node_modules/.bin/stryker run --mutate` per the
  local-scoping note).
- Docs: README command notes if any, `docs/BACKLOG.md` 24.9f → `[x]` with the
  distinct-types absorption noted; check `docs/use`/`docs/understand` merge
  pages for conflict-type tables mentioning add/add.
- `reports/api.json` regeneration (public `MergeConflict` widened).
