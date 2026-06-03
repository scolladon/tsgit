# Design — `status` faithfulness follow-ups (type-change / mode-only + unmerged)

> Two faithfulness gaps left open by the staged-column work, both logged as
> follow-ups on that design's §7 and ADR-254:
>
> 1. **Type-change (`T`) and mode-only changes** are collapsed to `modified` in
>    **both** columns today — the working-tree side in `compareWorkingTreeEntry`,
>    the staged side in the `DiffChange → ChangeKind` projection. Promote them to
>    first-class `ChangeKind` values so the structured output reconstructs git's
>    porcelain `T` (and carries the mode-only/content distinction git's diff
>    machinery already makes).
> 2. **Unmerged paths** (stage 1/2/3) are absent from `StatusResult` entirely —
>    `diffIndexAgainstTree` is stage-0-only, and the working-tree pass currently
>    mis-classifies a conflicted path using whichever stage entry lands last.
>    Add a first-class `unmerged` field reporting git's seven conflict states.

## 1. What git computes (grounded against real `git`)

Isolated env, signing off. Two observations fix the design.

### 1.1 Type-change vs mode-only (both columns)

| change | staged (`X`) | worktree (`Y`) | porcelain v2 modes |
|--------|--------------|----------------|--------------------|
| content edit | `M` | `M` | `100644 100644 100644` |
| exec-bit flip (same blob) | `M` | `M` | `100644 100755 100755` |
| regular file → symlink/gitlink | `T` | `T` | `100644 120000 120000` |

So git's status **XY** distinguishes exactly **`M` vs `T`**: a *kind* change
(`file`↔`symlink`↔`gitlink`) is `T`; a content **or** mode-only change within a
kind is `M`. Porcelain **v2** additionally surfaces the old/new modes, so the
content-vs-mode distinction is real data git carries, just not rendered as a
distinct XY letter.

### 1.2 Unmerged paths

A conflicted merge leaves stages 1 (base) / 2 (ours) / 3 (theirs). The porcelain
**XY** code is a *total function of which stages are present*:

| s1 | s2 | s3 | code | meaning |
|----|----|----|------|---------|
| ✓ | ✓ | ✓ | `UU` | both modified |
| | ✓ | ✓ | `AA` | both added |
| ✓ | | | `DD` | both deleted |
| | ✓ | | `AU` | added by us |
| | | ✓ | `UA` | added by them |
| ✓ | | ✓ | `DU` | deleted by us |
| ✓ | ✓ | | `UD` | deleted by them |

The seven rows are exactly the seven non-empty subsets of `{1,2,3}`. An unmerged
path appears **only** in its own porcelain line — never *also* in the
working-tree column (verified: a `UU` path emits one `UU`, no ` M`). A
conflicted path also never reaches the staged column (it has no stage-0 entry).
`git describe --dirty` treats a mid-merge index as dirty (`diff-index HEAD`
reports the unmerged entries).

## 2. What exists already

- `compareWorkingTreeEntry(ctx, entry): 'absent' | 'unchanged' | 'modified'` —
  the single working-tree dirtiness oracle. It returns `'modified'` the moment
  the derived working mode differs, *without* hashing — so it cannot tell a
  type-change from a mode-only change from a content change. Consumed by `status`
  (reporting), `rm` / `apply-merge-to-worktree` (the `=== 'modified'` dirty
  valve), `clean-work-tree` (`!== 'unchanged'`), `stash` (explicit
  `absent`/`unchanged`/else branches).
- `diffIndexAgainstTree(index, tree): TreeDiff` — staged column. Its
  `ModifyChange` already carries `oldId`/`newId`/`oldMode`/`newMode`, and it emits
  a distinct `type-change` `DiffChange` when kinds differ. **No domain change is
  needed** to distinguish staged mode-only (a `modify` with `oldId === newId`)
  from content (`oldId !== newId`) from type-change.
- `groupUnmergedEntries(index): { staged, unmerged }` and `UnmergedEntryGroup
  { stage1?, stage2?, stage3? }` — **already written, unit-tested, and exported
  from the domain barrel, but consumed by nothing.** This is the plumbing for the
  unmerged field; §3.3 is the wiring + a classifier.

## 3. Design

### 3.1 `ChangeKind` enrichment (both columns)

```ts
export type ChangeKind =
  | 'modified' | 'added' | 'deleted' | 'untracked'
  | 'type-changed' | 'mode-changed';
```

`type-changed` reconstructs git's `T`; `mode-changed` reconstructs `M` (same as
`modified`) but preserves the blob-unchanged/mode-changed fact. This **revisits
ADR-254**, which deliberately deferred exactly this enrichment "across both
columns together"; the new ADR supersedes it.

**Staged projection** (`toStagedChange`, pure mapping over `DiffChange`):

| `DiffChange` | `ChangeKind` | git `X` |
|--------------|--------------|---------|
| `add` | `added` | `A` |
| `delete` | `deleted` | `D` |
| `type-change` | `type-changed` | `T` |
| `modify`, `oldId === newId` | `mode-changed` | `M` |
| `modify`, `oldId !== newId` | `modified` | `M` |

`toStagedChange` is exported and unit-tested **directly** over hand-built
`DiffChange`s: the memory adapter's `chmod` is a no-op and lstat returns a fixed
mode, so a *staged* exec-bit change is not producible through the `add` flow —
the `oldId === newId → mode-changed` arm can only be pinned (for mutation
coverage) by a direct test on the pure projection (plus a real-git interop case).
The `type-change → type-changed` arm is additionally reachable end-to-end via a
staged symlink in memory.

**Working-tree oracle** — `compareWorkingTreeEntry` becomes a finer total
function (same I/O, reordered to hash before deciding mode-vs-content):

```ts
export type WorkingTreeComparison =
  | 'absent' | 'unchanged' | 'modified' | 'type-changed' | 'mode-changed';

// absent          → no working file
// type-changed    → kindOf(workingMode) !== kindOf(entry.mode)   (T)
// modified        → same kind, content hash differs               (M)
// mode-changed    → same kind, content identical, mode differs    (M, exec bit)
// unchanged       → same kind, same content, same mode
```

Content-change dominates mode-change (matching git's `M` when both differ):
mode-changed is emitted **only** when the blob hash is identical. The unreadable
working file `catch` still degrades to `modified` (never silently `unchanged`).

**Consumer compatibility** — the dirty valves widen from `=== 'modified'` to "any
modified-variant". A single exported predicate keeps that honest:

```ts
export const isWorkingTreeModified = (c: WorkingTreeComparison): boolean =>
  c !== 'unchanged' && c !== 'absent';
```

- `rm` (`local = worktree === 'modified'`) and `apply-merge-to-worktree`
  (`=== 'modified'`) switch to `isWorkingTreeModified(...)` — a type/mode change
  is a local modification git refuses to clobber, so this *fixes* a latent
  faithfulness gap, not just preserves behaviour.
- `clean-work-tree` (`!== 'unchanged'`) and `stash` (explicit branches) are
  already correct for the new variants — no change.

### 3.2 `status` working-tree pass uses stage-0 + tracked-set split

Today `status` builds one `indexByPath` from **all** entries (last stage wins),
used for both pass-1 iteration and untracked exclusion. Split it via
`groupUnmergedEntries`:

- **Pass 1 (working-tree)** iterates `grouped.staged` (stage-0 only). Conflicted
  paths are no longer mis-classified by a stray stage entry.
- **Untracked exclusion** tests membership against the *tracked set* = stage-0
  paths ∪ unmerged paths (a conflicted path is tracked, never `??`).

### 3.3 `unmerged` field + conflict classifier

```ts
export type ConflictKind =
  | 'both-modified' | 'both-added' | 'both-deleted'
  | 'added-by-us' | 'added-by-them'
  | 'deleted-by-us' | 'deleted-by-them';

export interface UnmergedEntry {
  readonly kind: ConflictKind;
  readonly path: FilePath;
}

export interface StatusResult {
  // …existing…
  readonly unmerged: ReadonlyArray<UnmergedEntry>;
}
```

A pure domain classifier `classifyUnmerged(group: UnmergedEntryGroup):
ConflictKind` maps the stage-presence triple to one of the seven states (§1.2),
structured as a fall-through decision tree whose final arm is the
single-stage-3 case — total over a non-empty group (every group from
`groupUnmergedEntries` has ≥1 stage), no dead branch. It lives in the domain
next to `groupUnmergedEntries` (`domain/diff/`), enabling reuse by any future
conflict-aware command.

`status` maps `grouped.unmerged` entries → `UnmergedEntry[]`, sorted by path
(git order). `unmerged` carries the semantic state only, **not** the per-stage
blobs: that reconstructs porcelain v1 (the project's faithfulness bar) fully;
per-stage `{id, mode}` (needed only for porcelain **v2** `u` lines) is YAGNI
until a consumer needs it — logged, not built (§7).

### 3.4 `clean`

```ts
const clean =
  indexChanges.length === 0 &&
  workingTreeChanges.length === 0 &&
  unmerged.length === 0;
```

### 3.5 `describe` dirtiness

`computeDirty` adds the unmerged column — a mid-merge index is dirty per
`git diff-index HEAD`:

```ts
return state.indexChanges.length > 0
  || state.workingTreeChanges.some((c) => c.kind !== 'untracked')
  || state.unmerged.length > 0;
```

## 4. Faithfulness pinning

`status-interop` reconstruction (`code()` + `reconstruct()`) extends:

- `code('type-changed') → 'T'`, `code('mode-changed') → 'M'`.
- `reconstruct` interleaves unmerged paths into the tracked-line set (union of
  staged ∪ worktree ∪ unmerged paths, sorted by path; an unmerged path emits its
  two-letter conflict code), untracked last — matching git's observed ordering.

New cross-tool cases (byte-equal vs `git status --porcelain --no-renames`):

- Staged + worktree **type change** (file → symlink): now `T` /` T` — the
  existing structural-only case is promoted to full byte-equal (no longer the
  ADR-254 `T`→`M` carve-out).
- Staged + worktree **mode change** (exec bit, `core.fileMode=true`): `M` /` M`.
- **Unmerged**: a real conflicted merge exercising the reachable states
  (`UU`/`AA`/`UD`/`DU`), asserting byte-equal porcelain and `clean === false`.
- `describe --dirty` over a conflicted index reconstructs `-dirty`.

A `ConflictKind → XY` mapping table is unit-tested directly (all seven states),
so the rarer `DD`/`AU`/`UA` are pinned even though a natural merge rarely
produces them.

## 5. Tests (TDD)

- **`classify-unmerged.test.ts`** (domain): parameterised sweep over the seven
  stage-presence combinations → expected `ConflictKind`; each decision arm
  triggered independently (mutation-resistant). Small enum → example sweep, not a
  property test (per the testing guide).
- **`compare-working-tree-entry.test.ts`**: type change (entry mode overridden to
  `120000`/symlink vs a regular working file, or vice-versa) → `type-changed`;
  exec-bit entry (`100755`) vs identical-content regular working file →
  `mode-changed` (the existing "mode mismatch → `modified`" case **flips** to
  `mode-changed`); content edit → `modified`; content + mode both change →
  `modified` (content dominates); identical → `unchanged`; absent → `absent`;
  unreadable → `modified`. `isWorkingTreeModified` truth table over all five
  variants.
- **`status.test.ts`**: staged type-change → `type-changed`; staged mode-change →
  `mode-changed`; worktree type/mode changes; a conflicted index populates
  `unmerged` and leaves that path out of `workingTreeChanges`/`indexChanges`/
  untracked; `clean` reflects the unmerged column; ordering byte-sorted.
- **`rm` / `apply-merge`**: a type/mode-changed working file is treated as a local
  modification (valve fires) — pins the widened predicate.
- **`describe.test.ts`**: conflicted index ⇒ `dirty: true`.
- Interop (§4).

## 6. Architecture pass (Step 7 seed)

Candidates, executed in-PR unless feature-sized:

- The stage-0-map / unmerged-split pattern now lives in `status`; `index-diff`'s
  `stage0IndexMap` and `groupUnmergedEntries` overlap — check whether `status`
  should consume `groupUnmergedEntries` as the *single* index-partition entry
  point and whether `diffIndexAgainstTree` can take the pre-grouped stage-0 set
  (avoid re-filtering). Centralise if it reads cleaner; no speculative port.
- `isWorkingTreeModified` is the new single definition of "modified-variant";
  verify `rm`/`apply-merge`/`clean-work-tree`/`stash` all route through the
  comparator's vocabulary rather than re-deriving dirtiness.

## 7. Follow-ups (logged only if feature-sized)

- Per-stage `{id, mode}` on `UnmergedEntry` for porcelain **v2** `u`-line
  reconstruction — additive, deferred until a consumer needs v2.

## 8. Non-goals

- No rename/copy detection in `status` (unchanged).
- No submodule (`gitlink`) working-tree semantics beyond the existing kind check.
- No cosmetic/rendering surface — `status` stays structured-data-only (ADR-249);
  XY/conflict letters are reconstructed in the interop test, never emitted.
