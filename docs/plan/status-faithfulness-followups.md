# Plan — `status` faithfulness follow-ups

TDD, one slice = one atomic commit. `npm run validate` green before every commit.
ADRs 255 (type/mode-change) + 256 (unmerged). Source code carries no phase/ADR
refs.

## Slice 1 — Working-tree column: `type-changed` + `mode-changed`

Enrich the working-tree comparator and the pass-1 projection; widen the
dirty-valve consumers.

**Red** — `test/unit/application/primitives/compare-working-tree-entry.test.ts`:
- type change: entry mode overridden to `120000` vs a regular working file (and
  the symmetric symlink-working-file vs `100644` entry) → `'type-changed'`.
- exec-bit entry (`{...entry, mode:'100755'}`) vs identical-content regular
  working file → `'mode-changed'` — **flip the existing** "mode mismatch →
  `'modified'`" case (lines 88–102) to expect `'mode-changed'`.
- content edit → `'modified'`; content **and** mode both change → `'modified'`
  (content dominates — override entry mode to `100755` *and* rewrite content).
- `unchanged` / `absent` / unreadable-`modified` cases stay green.
- `isWorkingTreeModified` truth table: `modified`/`type-changed`/`mode-changed`
  → true; `unchanged`/`absent` → false.

**Green**:
- `compare-working-tree-entry.ts`: widen `WorkingTreeComparison` to
  `'absent' | 'unchanged' | 'modified' | 'type-changed' | 'mode-changed'`.
  Reorder: `absent` → compute `workingMode` → if `!isSameKind(workingMode,
  entry.mode)` return `'type-changed'` → hash content → `id !== entry.id` return
  `'modified'` → `workingMode !== entry.mode` return `'mode-changed'` →
  `'unchanged'`. Keep the unreadable-`catch` → `'modified'`. Import `isSameKind`
  from `domain/diff/mode-kind.js`.
- Add `export const isWorkingTreeModified = (c) => c !== 'unchanged' && c !==
  'absent';` Export it + the widened type from the primitives barrel.
- `status.ts`: `ChangeKind` gains `'type-changed' | 'mode-changed'`. `classifyEntry`
  maps `compareWorkingTreeEntry` result → kind: `absent`→`deleted`,
  `type-changed`→`type-changed`, `mode-changed`→`mode-changed`,
  `modified`→`modified`, `unchanged`→`undefined`.
- `rm.ts` (`local = worktree === 'modified'`) and `apply-merge-to-worktree.ts`
  (`=== 'modified'`) → `isWorkingTreeModified(...)`. Check the Stryker comment
  above the apply-merge line still applies.

**Commit**: `feat(status)!: first-class type-changed / mode-changed in the working-tree column`

## Slice 2 — Staged column: `type-changed` + `mode-changed`

**Red**:
- New `test/unit/application/commands/status.test.ts` (or a sibling
  `staged-change.test.ts`) testing the **exported** `toStagedChange` directly over
  hand-built `DiffChange`s: `add`→`added`, `delete`→`deleted`,
  `type-change`→`type-changed`, `modify` with `oldId===newId`→`mode-changed`,
  `modify` with `oldId!==newId`→`modified`. Each arm isolated (mutation-resistant).
- Flip the existing status staged-type-change test (lines 338–354): expect
  `indexChanges` `[{ kind: 'type-changed', path: 'a.txt' }]`.

**Green**: `export const toStagedChange`; enrich its body — `type-change`
→`type-changed`; `modify` → `oldId === newId ? 'mode-changed' : 'modified'` (use
the `ModifyChange.oldId/newId`); add/delete unchanged. `primaryPath` still keys
modify/type-change.

**Commit**: `feat(status)!: first-class type-changed / mode-changed in the staged column`

## Slice 3 — Domain `classifyUnmerged` + `ConflictKind`

**Red** — `test/unit/domain/diff/classify-unmerged.test.ts`: seven-case sweep
over stage-presence triples (`{s1,s2,s3}` boolean combos) → expected
`ConflictKind` per §1.2 of the design; each decision arm triggered independently.

**Green** — `src/domain/diff/classify-unmerged.ts`:
```ts
export type ConflictKind =
  | 'both-modified' | 'both-added' | 'both-deleted'
  | 'added-by-us' | 'added-by-them' | 'deleted-by-us' | 'deleted-by-them';
export const classifyUnmerged = (g: UnmergedEntryGroup): ConflictKind => {
  const s1 = g.stage1 !== undefined, s2 = g.stage2 !== undefined, s3 = g.stage3 !== undefined;
  if (s1 && s2 && s3) return 'both-modified';
  if (s2 && s3) return 'both-added';
  if (s1 && s2) return 'deleted-by-them';
  if (s1 && s3) return 'deleted-by-us';
  if (s1) return 'both-deleted';
  if (s2) return 'added-by-us';
  return 'added-by-them'; // stage-3 alone (group is non-empty)
};
```
Export `ConflictKind` + `classifyUnmerged` from `domain/diff/index.js`.

**Commit**: `feat(diff): classifyUnmerged maps stage presence to conflict state`

## Slice 4 — `status` unmerged field + index repartition + `clean`

**Red** — `status.test.ts`:
- Drive a real conflicting merge in memory (mirror `merge.test.ts`'s setup), then
  `status(ctx)`: `unmerged` has one `UnmergedEntry` with `kind:'both-modified'`,
  `path`, and `ours`/`theirs`/`base` `{id, mode}` matching the stage entries; the
  conflicted path is **absent** from `indexChanges`, `workingTreeChanges`, and the
  untracked set; `clean === false`.
- A clean repo still has `unmerged: []`.

**Green** — `status.ts`:
- Add `ConflictStage`, `UnmergedEntry` interfaces; `StatusResult.unmerged`.
- Replace the all-entries `indexByPath` with `groupUnmergedEntries(index)`:
  pass-1 iterates `grouped.staged`; tracked-set for untracked exclusion = stage-0
  paths ∪ `grouped.unmerged` keys.
- Build `unmerged`: for each `[path, group]`, `{ kind: classifyUnmerged(group),
  path, base: stageBlob(group.stage1), ours: stageBlob(group.stage2), theirs:
  stageBlob(group.stage3) }` where `stageBlob(e) = e && { id: e.id, mode: e.mode }`;
  sort by path.
- `clean = indexChanges.length === 0 && workingTreeChanges.length === 0 &&
  unmerged.length === 0`.
- Export the new types from `commands/index.js` barrel.
- Regenerate `reports/api.json` (`npm run` doc-typedoc task) and stage it.

**Commit**: `feat(status)!: report unmerged paths with conflict state and per-stage blobs`

## Slice 5 — `describe` dirtiness counts unmerged

**Red** — `describe.test.ts`: a conflicted index ⇒ `repo.describe({ dirty: true })`
reports `dirty: true`.

**Green** — `describe.ts` `computeDirty`: `|| state.unmerged.length > 0`. Refresh
the adjacent comment (both columns + unmerged).

**Commit**: `fix(describe): count a conflicted index as dirty`

## Slice 6 — Interop pinning

**Red/Green** — `test/integration/status-interop.test.ts`:
- `code()`: add `'type-changed'→'T'`, `'mode-changed'→'M'`.
- `reconstruct()`: fold `unmerged` into the tracked-line set (union of staged ∪
  worktree ∪ unmerged paths, sorted; an unmerged path emits `conflictXY(kind)`),
  untracked last. Add a `conflictXY` map (the 7 states → `UU`/`AA`/`DD`/`AU`/`UA`/
  `DU`/`UD`).
- New byte-equal cases vs `git status --porcelain --no-renames`:
  - staged + worktree **type change** (file→symlink) → promote the existing
    structural-only case to full byte-equal.
  - staged + worktree **mode change** (exec bit; `git config core.fileMode true`).
  - **unmerged** conflicted merge exercising `UU`/`AA`/`UD`/`DU`, asserting
    byte-equal porcelain and `clean === false`.

`test/integration/describe-interop.test.ts` (or the existing describe interop):
- conflicted index reconstructs `-dirty`.

**Commit**: `test(status): interop pins type/mode-change and unmerged reconstruction`

## Cross-cutting

- **api.json**: `check:doc-typedoc` is the **prepush** gate (not in `validate`),
  so per-commit validate stays green without regen. Regenerate `reports/api.json`
  once before push — fold into slice 4 (final public-type delta) or a trailing
  `docs(api):` commit.
- **TSDoc on new public exports**: `validate` *does* run `check:doc-coverage`, so
  every new public export (`ConflictKind`, `ConflictStage`, `UnmergedEntry`, the
  `StatusResult.unmerged` field, the new `ChangeKind` members if member-level docs
  are required) needs a `/** … */` comment in the commit that introduces it, or
  that commit's validate goes red.
- **No source/test provenance refs** (no `ADR-`/`§`/phase numbers in code).
- **Property tests**: `classifyUnmerged` is a small-enum total function → a
  parameterised example sweep, not a property test (per the testing guide). The
  comparator/projection changes are matchers over a tiny enum domain — same call.

## Step 7 (architecture) candidates — execute in-PR unless feature-sized

- Single index-partition entry point: have `status` (and any future caller)
  consume `groupUnmergedEntries` as the one place index entries are split into
  staged/unmerged; check whether `diffIndexAgainstTree` should accept the
  pre-grouped stage-0 set instead of re-running `stage0IndexMap`.
- `isWorkingTreeModified` as the single "modified-variant" definition — confirm
  `rm`/`apply-merge`/`clean-work-tree`/`stash` all route through the comparator
  vocabulary rather than re-deriving dirtiness.
