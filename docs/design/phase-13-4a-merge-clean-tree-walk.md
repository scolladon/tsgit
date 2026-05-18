# Phase 13.4a — `merge` clean-merge tree walk

## 1. Goal

Wire the existing domain-layer `mergeTrees` primitive (Phase 5) into
the `merge` command so a true (diverged) merge produces a commit
whose tree reflects the **three-way merged content**, not just HEAD's
tree.

Today `merge.ts:113` writes `tree: ourTree` — the user must run
`add` afterward to incorporate their content. After this PR, a clean
merge writes the correct merged tree directly. Conflict handling
(working-tree markers + unmerged stage-1/2/3 index + merge state
files) is deferred to **Phase 13.4b**; this PR throws
`MERGE_CONFLICTS_NOT_RESOLVED` for any non-clean merge.

BACKLOG §13.4 acceptance (partial — clean half only):

> A clean merge produces the correct merge commit's tree without
> re-running `add`.

The conflicting-merge half of §13.4 (markers + unmerged index)
remains open.

## 2. Surface

No public change. `repo.merge({ target })` keeps its signature.
The only observable difference for callers is:

- A clean true-merge now writes the **merged** tree (was: HEAD's tree).
- A conflicting merge now throws `MERGE_CONFLICTS_NOT_RESOLVED` instead
  of silently writing HEAD's tree as the merge commit.

The second change is technically a breaking-behaviour difference
but the prior behaviour was clearly buggy (no merge-commit should
ignore conflicts).

## 3. Behaviour

### 3.1 Clean-merge flow

1. Existing prelude (`assertRepository`, `assertNotBare`,
   `assertNoPendingOperation`, HEAD resolution, `mergeBase`).
2. Same up-to-date and fast-forward early returns.
3. **NEW** in `mergeCommit`:
   - Read `ourTree`, `theirTree`, `baseTree` (resolve commits → trees).
   - **Flatten** each tree into a `FlatTree` (NEW primitive
     `flattenTree`).
   - Build a content-merger closure that reads blobs via `readBlob`
     and calls the domain `mergeContent`.
   - Call `mergeTrees(baseFlat, ourFlat, theirFlat, contentMerger)`.
   - If `result.cleanMerge === false`: throw
     `MERGE_CONFLICTS_NOT_RESOLVED` with the conflict paths.
   - If clean: convert outcomes to a flat
     `{ path, id, mode }[]` (writing resolved-merged bytes as new
     blobs first), then synthesise the merged tree via
     `synthesizeTreeFromIndex`.
4. Create the merge commit with the merged tree id and update HEAD.

### 3.2 `MERGE_CONFLICTS_NOT_RESOLVED`

New error code. `data.code === 'MERGE_CONFLICTS_NOT_RESOLVED'`,
plus `data.paths: ReadonlyArray<FilePath>` listing the conflicting
paths. Future Phase 13.4b will replace this throw with the full
conflict-resolution machinery (markers, stage 1/2/3, merge state).

### 3.3 Out of scope for 13.4a

- **Working-tree materialisation**. The merged tree is committed,
  but the working tree is NOT updated. Users can run
  `repo.checkout({ target: HEAD })` to bring the working tree into
  sync. Phase 13.4c will materialise automatically on clean merge.
- **Conflict markers / unmerged index / merge-state files**
  (`.git/MERGE_HEAD`, `MERGE_MSG`, `ORIG_HEAD`). Phase 13.4b.
- **Unrelated histories**. `mergeBase` returning undefined still
  produces a commit error today; 13.4a does not touch that path.

## 4. New primitive

```ts
// src/application/primitives/flatten-tree.ts
export const flattenTree = async (
  ctx: Context,
  treeId: ObjectId,
): Promise<FlatTree>;
```

Walks the tree (existing `walkTree`) and produces the FlatTree
shape that `mergeTrees` expects:

```ts
{ entries: Map<FilePath, { id: ObjectId; mode: FileMode }> }
```

Recurses via `walkTree`. Pure with respect to the working tree.

## 5. Module layout

```
src/application/
├── commands/
│   └── merge.ts                          # extended: clean-merge tree walk
├── primitives/
│   ├── flatten-tree.ts                    # NEW
│   └── index.ts                            # extend barrel
src/domain/commands/
└── error.ts                                # add MERGE_CONFLICTS_NOT_RESOLVED
test/unit/application/
├── commands/merge.test.ts                  # extend with clean-merge + conflict-throw tests
└── primitives/flatten-tree.test.ts         # NEW
```

## 6. Testing strategy

- **Unit, `flatten-tree.test.ts`**: empty tree, single-file tree,
  nested tree (path-prefix is canonical), gitlink at leaf, symlink
  preserved.
- **Unit, `merge.test.ts`** (extended):
  - Clean merge where the diverged side adds a non-conflicting file —
    assert the resulting commit's tree contains both sides' files.
  - Clean merge where the diverged side modifies a different file —
    assert merged tree.
  - Conflicting merge (same file, divergent content) — assert
    throws `MERGE_CONFLICTS_NOT_RESOLVED` with the conflict path.
- **Mutation**: stryker on touched files. Target: 0 new survivors.

## 7. Self-review log

### Pass 1 → Pass 2

- Originally proposed building outcomes directly into `IndexEntry`-
  shaped records and feeding them to `synthesizeTreeFromIndex`.
  Killed: that adds path-validation overhead and a defence-in-depth
  duplicate check. Instead, write resolved-merged bytes as blobs
  first, then build `{ path, mode, id }` records, then
  call `synthesizeTreeFromIndex` with a thin `IndexEntry` wrapper
  (zero stats). The synthesise primitive's per-call validation is
  irrelevant because the paths come from `flattenTree` which gets
  them from a parsed git tree — paths are already validated.
- Added §3.3 explicitly listing what's deferred to 13.4b/13.4c.
  Reviewers will ask.

### Pass 2 → Pass 3

- Renamed the primitive `flattenTreeToFlatTree` → `flattenTree`. The
  output type's `FlatTree` name carries the suffix; no need to repeat.
- §6 added the "gitlink at leaf" case explicitly — Phase 5's
  `mergeTrees` already treats gitlinks specially (conflict on
  divergence), and our flattenTree needs to preserve the mode so
  the upstream check fires.

### Pass 3 → Pass 4 (final pass)

- Decided to **extend** `MERGE_HAS_CONFLICTS` with a `paths` field
  rather than add a separate `MERGE_CONFLICTS_NOT_RESOLVED` code.
  Reusing the existing code keeps the public surface tighter; the
  additive field is non-breaking (existing consumers that only read
  `count` keep working). The factory takes `paths` as an optional
  argument defaulting to `[]` so existing call sites compile
  unchanged.
- §3.1 step "build a content-merger closure" clarified: the closure
  reads ALL three blobs (ours, theirs, base if defined) and calls
  `mergeContent(base, ours, theirs)`. The stub `Uint8Array(0)`s
  that Phase 5's `mergeTrees` passes into the merger callback are
  discarded — Phase 5 documents that as the integration contract
  (`three-way-tree.ts:160` "Phase 5 has no blob bytes — Phase 7
  supplies real content via its closure").
- §3.1 step 3 (synthesise) — uses a local `writeNestedTree` helper
  built from `LeafRecord`s rather than reusing
  `synthesizeTreeFromIndex`. The synth primitive runs path
  validation per entry; the merge outcomes come from a parsed
  `FlatTree` whose paths are already validated. Avoiding the
  double-validation is YAGNI-correct.
