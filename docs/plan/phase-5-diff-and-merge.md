# Plan: Phase 5 — Diff & Merge

Implements [design/diff-and-merge.md](../design/diff-and-merge.md).
Covers [backlog](../BACKLOG.md) items 5.1–5.5.

### Backlog → Step Mapping

| Backlog Item | Description | Steps |
|---|---|---|
| **5.1** | Tree diff algorithm | 4, 6 (`diffTrees` + `detectRenames`) |
| **5.2** | Working tree diff (filesystem vs index) | Deferred to Phase 7 `status` (domain building block in Step 7b) |
| **5.3** | Index diff (index vs HEAD tree) | 7b (`diffIndexAgainstTree`) |
| **5.4** | Three-way merge engine | 9, 10 (`mergeContent` + `mergeTrees`) |
| **5.5** | Conflict detection and representation | 3 (types), 8 (`writeConflictMarkers`), 9, 10 |
| — | Error types (`DiffError` + `MergeError`) | 0 |
| — | Line diff + binary detection | 2, 5 |
| — | Unmerged index bridges | 7b (`groupUnmergedEntries`, `conflictsToIndexEntries`) |
| — | Barrel exports + validation | 11 |
| — | Mutation + parallel reviews + finalize | 12 |

---

## Workflow

Each step follows TDD: write test (red) → implement (green) → refactor.
After every green step run: `npm run check:types && npm run test:unit && npm run check:architecture`

**Commit strategy:** One commit per completed step (green + refactor). Message format: `feat(domain): add <module> — <what it does>`. Feature branch with worktree — never commit directly to main.

## Prerequisites (before step 0)

1. Create directories: `src/domain/diff/`, `src/domain/merge/`, `test/unit/domain/diff/`, `test/unit/domain/merge/`
2. Coverage config in `vitest.config.ts` already includes `src/domain/**/*.ts` — `diff/` and `merge/` covered automatically
3. Existing dependency-cruiser rule enforces `domain/ ✗→ ports|adapters` — no new rules required (diff + merge are siblings of existing domain modules)
4. Update `cspell.json` as needed — new domain terms (`myers`, `flattree`, `hunks`, `gitlink`, `diff3`, `rename`, `unmerged`, etc.) may trigger spelling failures
5. No new runtime dependencies. `fast-check` already a devDependency for property tests

## File Conventions

- Source files under `src/domain/diff/` and `src/domain/merge/`
- Test files under `test/unit/domain/diff/` and `test/unit/domain/merge/`
- File names: kebab-case (enforced by ls-lint)
- Test names: `<module>.test.ts`, arbitraries in `arbitraries.ts` per module
- Test format: Given/When/Then titles, AAA body, `sut` variable
- **Import extensions:** All imports MUST use `.js` extension
- **Imports from `domain/objects/`:** `ObjectId`, `FilePath`, `FileMode`, `Tree`, `TreeEntry`, `treeEntryCompare`, `compareBytes` from `../objects/index.js`
- **Imports from `domain/git-index/`:** `IndexEntry`, `GitIndex`, `StatData` from `../git-index/index.js`
- **Cross-module imports inside Phase 5:** `merge/` may import from `diff/` (line-diff + FlatTree); `diff/` must NOT import from `merge/` (no circular dependency)
- **Error pattern:** Same as Phases 2/3/4 — module-local error unions with `import type` into `domain/error.ts`

## Design Decisions (applied in this plan)

- **`diff/flat-tree.ts`** separated from `diff-change.ts` — allows Step 10 (`mergeTrees`) to depend only on the `FlatTree` type without pulling in the whole diff module
- **`ContentMergeResult.clean` short-circuit `id?`** — optional fast-path (see design §4.4). Test with and without the id field to pin both code paths
- **`mergeTrees` is async** — takes `(... ) => Promise<ContentMergeResult> | ContentMergeResult` callback. Tests use both sync and async spy closures
- **`conflictsToIndexEntries` rejects duplicate paths** — throws `INVALID_MERGE_INPUT` before emitting; tested directly
- **`MAX_FLAT_TREE_ENTRIES` enforced at union in `mergeTrees`** — fast-fail per-input first, then union check
- **Label validation** — single regex test drives all four classes (C0/C1/DEL/marker-substring) but individual tests pin each class separately (mutation-killing)
- **Golden fixture for `writeConflictMarkers`** — one hard-coded `Uint8Array` literal in the test for byte-exact format (no Phase 11 harness dependency)
- **fast-check arbitraries** in `test/unit/domain/diff/arbitraries.ts` and `test/unit/domain/merge/arbitraries.ts`

---

## Step 0: Prerequisites & Error Types

**Create:** `src/domain/diff/`, `src/domain/merge/`, `test/unit/domain/diff/`, `test/unit/domain/merge/`
**Create:** `src/domain/diff/error.ts`, `src/domain/merge/error.ts`
**Test:** `test/unit/domain/diff/error.test.ts`, `test/unit/domain/merge/error.test.ts`
**Modify:** `src/domain/error.ts` (add `DiffError | MergeError` to `TsgitErrorData`)

### Actions

1. Create `src/domain/diff/error.ts`:
   - `DiffError` type: 1 variant (`INVALID_TREE_FOR_DIFF`)
   - Factory function: `invalidTreeForDiff(reason: string)`

2. Create `src/domain/merge/error.ts`:
   - `MergeError` type: 2 variants (`INVALID_MERGE_TREE`, `INVALID_MERGE_INPUT`)
   - Factory functions: `invalidMergeTree(reason)`, `invalidMergeInput(reason)`

3. Update `src/domain/error.ts`:
   - `import type { DiffError } from './diff/error.js'`
   - `import type { MergeError } from './merge/error.js'`
   - Widen `TsgitErrorData = DomainObjectError | StorageError | RefsError | IndexError | AdapterError | DiffError | MergeError`
   - Add switch cases to `extractDetail` (all new codes use `data.reason`; sanitize with `basename` where paths may appear — same pattern as AdapterError)

4. Write tests for both error modules (same pattern as `storage/error.test.ts` / `refs/error.test.ts`)

5. Update exhaustive-switch tests in every existing error module's `error.test.ts` to include the new codes (keep pattern consistent)

### Verify

```bash
npm run check:types && npm run test:unit && npm run check:architecture
```

---

## Step 1: `diff-change.ts` + `flat-tree.ts` — Diff Type Definitions

**Create:** `src/domain/diff/diff-change.ts`, `src/domain/diff/flat-tree.ts`
**Test:** type-only — exercised via Step 4 and Step 7b tests

Depends on: Step 0, `ObjectId` / `FilePath` / `FileMode` from `domain/objects/`

### Types in `diff-change.ts`

- `DiffChangeType = 'add' | 'delete' | 'modify' | 'rename' | 'type-change'`
- `AddChange { type: 'add'; newPath; newId; newMode }`
- `DeleteChange { type: 'delete'; oldPath; oldId; oldMode }`
- `ModifyChange { type: 'modify'; path; oldId; newId; oldMode; newMode }`
- `RenameChange { type: 'rename'; oldPath; newPath; id; mode }`
- `TypeChangeChange { type: 'type-change'; path; oldId; newId; oldMode; newMode }`
- `DiffChange = AddChange | DeleteChange | ModifyChange | RenameChange | TypeChangeChange`
- `TreeDiff { readonly changes: ReadonlyArray<DiffChange> }`

### Types in `flat-tree.ts`

- `FlatTreeEntry { readonly id: ObjectId; readonly mode: FileMode }`
- `FlatTree { readonly entries: ReadonlyMap<FilePath, FlatTreeEntry> }`
- `export const MAX_FLAT_TREE_ENTRIES = 1_000_000`

### Verify

`check:types` only — no runtime tests yet; types are exercised in later steps.

---

## Step 2: `line-diff.ts` — Line Types + `isBinary` + `splitLines`

**Create:** `src/domain/diff/line-diff.ts` (partial — types, constants, `isBinary`, `splitLines` only; `diffLines` in Step 5)
**Test:** `test/unit/domain/diff/line-diff.test.ts` (partial)

Depends on: Step 0

### Types + constants

- `LineHunk { kind; oursStart; oursEnd; theirsStart; theirsEnd }`
- `LineDiff { hunks; oursLines; theirsLines; degraded }`
- `export const MAX_DIFF_EDIT_DISTANCE = 10_000`
- `export const MAX_DIFF_ITERATION_FACTOR = 1_000`
- `export const BINARY_DETECTION_BYTES = 8_000`
- `export const MAX_LINE_BYTES = 65_536`
- `export const MAX_LINES = 100_000`

### Test first (red) — `splitLines`

```
Given empty Uint8Array, When splitLines called, Then returns []
Given 'a\nb\n' bytes, When splitLines called, Then returns [bytes('a\n'), bytes('b\n')]
Given 'a\nb' bytes (no trailing \n), When splitLines called, Then returns [bytes('a\n'), bytes('b')]
Given '\n\n' bytes (two empty lines), When splitLines called, Then returns [bytes('\n'), bytes('\n')]
Property: concat(splitLines(bytes)) === bytes for any bytes (roundtrip)
```

### Test first (red) — `isBinary`

```
Given empty Uint8Array, When isBinary called, Then returns false
Given bytes with no NUL, When isBinary called, Then returns false
Given bytes with NUL at offset 0, When isBinary called, Then returns true
Given BINARY_DETECTION_BYTES - 1 offset NUL (within window), When isBinary called, Then returns true
Given BINARY_DETECTION_BYTES offset NUL (boundary — outside window), When isBinary called, Then returns false
Given MAX_LINE_BYTES - 1 bytes on one line, When isBinary called, Then returns false
Given MAX_LINE_BYTES bytes on one line, When isBinary called, Then returns true
Given MAX_LINES - 1 lines (all short, all non-NUL), When isBinary called, Then returns false
Given MAX_LINES lines (all short, all non-NUL), When isBinary called, Then returns true
```

### Implement (green)

- `splitLines` — single pass, slice on each `\n`, emit final buffer verbatim if no trailing `\n`
- `isBinary` — single pass: check first `BINARY_DETECTION_BYTES` for NUL; track current line length and total line count; short-circuit on any signal

---

## Step 3: `merge-types.ts` — Merge Type Definitions

**Create:** `src/domain/merge/merge-types.ts`
**Test:** type-only — exercised via Steps 9 and 10 tests

Depends on: Step 0, Step 1 (`FlatTree` for context), Step 2 (`LineDiff` structures used by `ContentMergeResult`)

### Types

- `ConflictType = 'content' | 'add-add' | 'modify-delete' | 'type-change' | 'rename-rename' | 'gitlink' | 'binary'`
- `MergeConflict { type; path; baseId?; ourId?; theirId?; baseMode?; ourMode?; theirMode?; conflictContent? }`
- `MergeOutcome = 5 variants` (see design §4.4: `unchanged | resolved-known | resolved-merged | resolved-deleted | conflict`)
- `TreeMergeResult { outcomes; conflicts; cleanMerge }`
- `ContentMergeResult { status: 'clean', bytes, id? } | { status: 'conflict', markedBytes, conflictType }`
- `ContentMergeContext { path; baseId?; ourId; theirId; baseMode?; ourMode; theirMode }`
- `ConflictMarkerOptions { labels?: {ours?, base?, theirs?}; conflictStyle?: 'merge' | 'diff3' }`
- `export const MAX_CONFLICT_OUTPUT_BYTES = 256 * 1024 * 1024`

### Verify

`check:types` — runtime tests arrive in Steps 9/10.

---

## Step 4: `tree-diff.ts` — `diffTrees`

**Create:** `src/domain/diff/tree-diff.ts`
**Test:** `test/unit/domain/diff/tree-diff.test.ts`
**Create:** `test/unit/domain/diff/arbitraries.ts` (with `arbTree()` — reuse Phase 1 arbitrary, dedupe entry names)

Depends on: Step 1

### Test first (red)

Cover every row of design §5.1 two-pointer walk + every `isSameKind` case:

```
Given two undefined trees, When diffTrees called, Then returns empty TreeDiff
Given undefined old tree and new tree with one entry, When diffTrees called, Then returns [AddChange]
Given old tree with one entry and undefined new tree, When diffTrees called, Then returns [DeleteChange]
Given same tree on both sides, When diffTrees called, Then returns empty TreeDiff
Given same path with different ids (same kind), When diffTrees called, Then returns [ModifyChange]
Given same path with 100644 → 100755 mode, When diffTrees called, Then returns [ModifyChange] (within kind)
Given same path with 100644 → 120000 mode, When diffTrees called, Then returns [TypeChangeChange]
Given same path with file → gitlink, When diffTrees called, Then returns [TypeChangeChange]
Given mixed add + delete + modify at different paths, When diffTrees called, Then all three emitted and sorted byte-order on path
Given byte-order test: entries 'a', 'a-', 'a/b', 'b' mixed across trees, When diffTrees called, Then output respects treeEntryCompare ordering
Property: diffTrees(A, A).changes is always empty for any tree A
Property: diffTrees(undefined, X) deep-equals diffTrees({entries:[]}, X) for any X
```

### Implement (green)

Two-pointer walk per design §5.1 pseudocode. Use `treeEntryCompare` from Phase 1 for ordering. Emit `modify` when same path and ids/modes differ within same kind; emit `type-change` when kinds differ; skip when fully identical.

---

## Step 5: `line-diff.ts` completion — `diffLines` (Myers)

**Modify:** `src/domain/diff/line-diff.ts` (add `diffLines`)
**Extend:** `test/unit/domain/diff/line-diff.test.ts`

Depends on: Step 2

### Test first (red)

```
Given identical Uint8Arrays, When diffLines called, Then single common hunk covering all lines, degraded: false
Given empty + empty, When diffLines called, Then single zero-length common hunk, degraded: false
Given pure prepend (theirs has extra leading line), When diffLines called, Then theirs-only hunk then common
Given pure append, When diffLines called, Then common then theirs-only
Given pure delete (ours empty, theirs non-empty), When diffLines called, Then single theirs-only hunk
Given symmetric delete (ours non-empty, theirs empty), When diffLines called, Then single ours-only hunk
Given file with trailing \n vs without, When diffLines called, Then final line hunk classification matches byte-level difference
Given input requiring exactly MAX_DIFF_EDIT_DISTANCE edits, When diffLines called, Then succeeds with degraded: false
Given input requiring MAX_DIFF_EDIT_DISTANCE + 1 edits, When diffLines called, Then returns whole-file fallback, degraded: true
Given input requiring more iterations than (M+N) × MAX_DIFF_ITERATION_FACTOR, When diffLines called, Then returns degraded: true fallback
Property: for any X, diffLines(X, X) yields single common hunk covering all lines, degraded: false
Property: sum of (common-end - common-start) + (ours-only-end - ours-only-start) over hunks === oursLines.length; symmetric for theirs
```

### Implement (green)

Myers O(ND) forward-search with dual cap. Use an iteration counter that compares against `(M + N) * MAX_DIFF_ITERATION_FACTOR`; abort when either D or iteration count exceeds cap. On abort: return `LineDiff{ hunks: [full-ours-only, full-theirs-only], oursLines, theirsLines, degraded: true }`.

### Refactor

Extract trace reconstruction into a named helper; extract the edit-path backtrack into a separate function for testability.

---

## Step 6: `rename-detect.ts` — `detectRenames`

**Create:** `src/domain/diff/rename-detect.ts`
**Test:** `test/unit/domain/diff/rename-detect.test.ts`

Depends on: Step 4

### Test first (red)

```
Given diff with Add+Delete matching ObjectId on distinct paths, When detectRenames called, Then single RenameChange replacing the pair
Given diff with Add+Delete with matching id but multiple candidates, When detectRenames called, Then no fold (ambiguous — kept as add+delete)
Given diff with no matching pairs, When detectRenames called, Then unchanged diff returned
Given adds × deletes at limit exactly, When detectRenames called, Then renames detected
Given adds × deletes at limit + 1, When detectRenames called, Then diff returned unchanged
Given exactly maxSameIdDeletes deletes sharing one ObjectId, When detectRenames called, Then that id's rename detected
Given maxSameIdDeletes + 1 deletes sharing one ObjectId, When detectRenames called, Then that id skipped, adds remain as add+delete
Given output after fold, When comparing to byte-order invariant, Then RenameChange sorts by newPath; DeleteChange by oldPath; Modify/TypeChange by path
Property (idempotence): detectRenames(detectRenames(d)) deep-equals detectRenames(d)
```

### Implement (green)

Per design §5.3 algorithm: partition into adds/deletes/other; product budget check **before** map construction; build `Map<ObjectId, DeleteChange[]>`; prune keys with `> maxSameIdDeletes` entries after construction; for each add, look up and fold if exactly one match; return new TreeDiff with sort-preserving merge of folded + unfolded changes.

---

## Step 7a: `flat-tree.ts` already created in Step 1 — verify

No new code. `FlatTree` type was defined in Step 1. Confirmed present, MAX_FLAT_TREE_ENTRIES exported.

---

## Step 7b: `index-diff.ts` — `diffIndexAgainstTree` + unmerged bridges

**Create:** `src/domain/diff/index-diff.ts`
**Test:** `test/unit/domain/diff/index-diff.test.ts`

Depends on: Step 1 (DiffChange, FlatTree), Step 3 (MergeConflict), Step 0 (DiffError)

### `diffIndexAgainstTree` — test first (red)

```
Given empty index + empty tree, When diffIndexAgainstTree called, Then empty TreeDiff
Given index with only stage-0 entries matching tree exactly, When diffIndexAgainstTree called, Then empty TreeDiff
Given index with stage 1/2/3 unmerged entries, When diffIndexAgainstTree called, Then those entries are skipped (not treated as stage 0)
Given path in tree but not index, When diffIndexAgainstTree called, Then DeleteChange emitted
Given path in index but not tree, When diffIndexAgainstTree called, Then AddChange emitted
Given same path with different id or mode (same kind), When diffIndexAgainstTree called, Then ModifyChange
Given same path with different kind, When diffIndexAgainstTree called, Then TypeChangeChange
Given FlatTree with MAX_FLAT_TREE_ENTRIES entries, When diffIndexAgainstTree called, Then succeeds
Given FlatTree with MAX_FLAT_TREE_ENTRIES + 1 entries, When diffIndexAgainstTree called, Then throws DiffError{code: 'INVALID_TREE_FOR_DIFF', reason: contains 'MAX_FLAT_TREE_ENTRIES'}
Given mixed case output, When diffIndexAgainstTree called, Then changes sorted byte-order on primary path key
```

### `groupUnmergedEntries` — test first (red)

```
Given index with only stage-0 entries, When groupUnmergedEntries called, Then staged populated, unmerged empty
Given index with stage 1, 2, 3 for one path, When groupUnmergedEntries called, Then unmerged entry contains all three
Given index with only stage 2 for a path, When groupUnmergedEntries called, Then unmerged entry has stage2 only; does NOT throw (forgiving)
Given index with only stage 1 for a path, When groupUnmergedEntries called, Then unmerged entry has stage1 only; does NOT throw
Given index with stages 1 + 3 only, When groupUnmergedEntries called, Then unmerged entry has stage1 + stage3, stage2 absent
```

### `conflictsToIndexEntries` — test first (red)

```
Given one conflict with baseId/ourId/theirId all set, When conflictsToIndexEntries called, Then 3 entries emitted in (path, stage) byte-order
Given one conflict with only ourId set, When conflictsToIndexEntries called, Then 1 entry at stage 2
Given one conflict with no ids set (degenerate), When conflictsToIndexEntries called, Then 0 entries emitted
Given two conflicts sharing same path, When conflictsToIndexEntries called, Then throws MergeError{code: 'INVALID_MERGE_INPUT', reason: 'duplicate conflict path'}
Given conflict with baseMode/ourMode/theirMode distinct, When conflictsToIndexEntries called, Then statFactory invoked with baseMode for stage 1, ourMode for stage 2, theirMode for stage 3
```

### Implement (green)

- `diffIndexAgainstTree` — enforce cap first; build map from index stage-0 entries; walk the union of index and tree paths in byte-sorted order; emit appropriate change per design §6
- `groupUnmergedEntries` — single pass over index entries; bucket by stage into `unmerged` map (forgiving) and `staged` array
- `conflictsToIndexEntries` — validate no duplicate paths; for each conflict, emit up to 3 entries (one per non-null id); return sorted by (path, stage)

---

## Step 8: `conflict-markers.ts` — `writeConflictMarkers` + label validation

**Create:** `src/domain/merge/conflict-markers.ts`
**Test:** `test/unit/domain/merge/conflict-markers.test.ts`

Depends on: Step 3 (MergeError, ConflictMarkerOptions, MAX_CONFLICT_OUTPUT_BYTES)

### Test first (red) — positive baseline

```
Given printable ASCII label 'HEAD', When writeConflictMarkers called, Then label appears in <<<<<<< HEAD\n and >>>>>>> HEAD\n
Given multi-byte UTF-8 label 'feature/Ⓐ', When writeConflictMarkers called, Then label round-trips verbatim in output
Given label with surrounding spaces but non-empty after trim, When writeConflictMarkers called, Then accepted verbatim
Given ours-lines ['a\n','b\n'], theirs-lines ['a\n','c\n'], labels {ours:'HEAD', theirs:'feature'}, When writeConflictMarkers called, Then output equals hard-coded golden Uint8Array: '<<<<<<< HEAD\na\nb\n=======\na\nc\n>>>>>>> feature\n'
Given theirs-lines ending without \n, When writeConflictMarkers called, Then output ends with >>>>>>> <label>\n (canonical git behavior)
```

### Test first (red) — negative (each rule isolated for mutation killing)

```
Given label with \n, When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT'}
Given label with \r, When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT'}
Given label with \x1b (C0 ANSI escape), When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT'}
Given label with \x7f (DEL), When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT'}
Given label with \x9b (C1 control), When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT'}
Given label containing '<<<<<<<', When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT'}
Given label containing '=======', When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT'}
Given label containing '>>>>>>>', When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT'}
Given label containing '|||||||', When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT'}
Given empty label '', When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT'}
Given whitespace-only label ' \t\v\f ', When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT'}
Given any invalid label, When writeConflictMarkers called, Then error reason does NOT contain the label value (branch-name privacy)
Given combined oursLines + theirsLines byte sum equal MAX_CONFLICT_OUTPUT_BYTES, When writeConflictMarkers called, Then succeeds
Given combined oursLines + theirsLines byte sum equal MAX_CONFLICT_OUTPUT_BYTES + 1, When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT', reason: contains 'MAX_CONFLICT_OUTPUT_BYTES'}
Given conflictStyle 'diff3' option, When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT', reason: contains 'diff3'}
```

### Implement (green)

- `validateLabel(label: string, which: 'ours' | 'base' | 'theirs')` helper — runs all 4 classes of check, throws with reason strings that identify the rule but NOT the label value
- `writeConflictMarkers(oursLines, theirsLines, options?)`:
  1. Validate labels (defaults: `'ours'`, `'theirs'`)
  2. Reject `conflictStyle === 'diff3'`
  3. Sum input byte lengths; reject over-cap
  4. Allocate output buffer, emit marker lines + line contents, return `Uint8Array`

---

## Step 9: `three-way-content.ts` — `mergeContent`

**Create:** `src/domain/merge/three-way-content.ts`
**Test:** `test/unit/domain/merge/three-way-content.test.ts`

Depends on: Step 2 (`isBinary`, `splitLines`), Step 3 (types), Step 5 (`diffLines`), Step 8 (`writeConflictMarkers`)

### Test first (red)

```
Given identical bytes on all three sides, When mergeContent called, Then {status: 'clean', bytes: base}
Given base + ours modified + theirs unchanged from base, When mergeContent called, Then {status: 'clean', bytes: ours}
Given base + theirs modified + ours unchanged from base, When mergeContent called, Then {status: 'clean', bytes: theirs}
Given base + both sides make identical modification, When mergeContent called, Then {status: 'clean', bytes: ours}
Given non-overlapping modifications on both sides, When mergeContent called, Then {status: 'clean', bytes: merged} (both changes applied)
Given overlapping modifications on both sides (different content), When mergeContent called, Then {status: 'conflict', conflictType: 'content', markedBytes: contains markers}
Given any side binary (NUL in first 8000 bytes), When mergeContent called, Then {status: 'conflict', conflictType: 'binary', markedBytes: ours}
Given undefined base (add-add) with identical bytes, When mergeContent called, Then {status: 'clean', bytes: ours}
Given undefined base (add-add) with different bytes, When mergeContent called, Then {status: 'conflict', conflictType: 'content', markedBytes: whole-file markers}
Given mergeContent called with labels option, When output emitted, Then labels appear in markedBytes
```

### Implement (green)

Per design §9.1 algorithm — short-circuit binary + add-add first; split all three via `splitLines`; compute `diffLines(base, ours)` and `diffLines(base, theirs)`; walk in lockstep emitting clean lines, one-sided changes verbatim, and invoking `writeConflictMarkers` for both-sided-change-with-different-results regions. Result status = 'conflict' iff any conflict region was emitted.

### Refactor

Extract the lockstep walk into a `mergeLinesByBase` helper; extract conflict-region detection into its own predicate.

---

## Step 10: `three-way-tree.ts` — `mergeTrees` (async)

**Create:** `src/domain/merge/three-way-tree.ts`
**Test:** `test/unit/domain/merge/three-way-tree.test.ts`

Depends on: Step 1 (FlatTree), Step 3 (merge types + MAX_CONFLICT_OUTPUT_BYTES)

### Test first (red) — decision table coverage (design §8.1)

All 14 rows of the per-path decision table, one test each:

```
Row "X | X | X": Given all three sides identical, When mergeTrees called, Then outcome is 'unchanged' with id+mode carried
Row "X | X | Y": Given theirs modified, ours unchanged, When mergeTrees called, Then 'resolved-known' with theirs' id+mode
Row "X | Y | X": Given ours modified, theirs unchanged, When mergeTrees called, Then 'resolved-known' with ours' id+mode
Row "X | Y | Y": Given both sides modified identically, When mergeTrees called, Then 'resolved-known' with ours' id (either side — same)
Row "X | Y | Z": Given modify-modify with different ids, When mergeTrees called, Then contentMerger invoked and result threaded
Row "— | X | —": Given add by us only, When mergeTrees called, Then 'resolved-known' with ours
Row "— | — | X": Given add by them only, When mergeTrees called, Then 'resolved-known' with theirs
Row "— | X | X": Given same add on both sides, When mergeTrees called, Then 'resolved-known' with ours (either side)
Row "— | X | Y": Given add-add with different content, When mergeTrees called, Then 'conflict' with ConflictType 'add-add'
Row "X | — | X": Given we deleted, theirs unchanged, When mergeTrees called, Then 'resolved-deleted'
Row "X | X | —": Given they deleted, ours unchanged, When mergeTrees called, Then 'resolved-deleted'
Row "X | — | —": Given both deleted, When mergeTrees called, Then 'resolved-deleted'
Row "X | — | Y": Given we deleted, they modified, When mergeTrees called, Then 'conflict' with ConflictType 'modify-delete'
Row "X | Y | —": Given we modified, they deleted, When mergeTrees called, Then 'conflict' with ConflictType 'modify-delete'
```

### Test first (red) — contentMerger contract

```
Given modify-modify on a regular file, When mergeTrees called, Then contentMerger's ctx.ourMode matches ours FlatTree entry's mode
Given modify-modify on a regular file, When mergeTrees called, Then contentMerger's ctx.theirMode matches theirs FlatTree entry's mode
Given modify-modify with base entry, When mergeTrees called, Then contentMerger's ctx.baseMode matches base FlatTree entry's mode
Given contentMerger returning {status:'clean', bytes}, When mergeTrees called, Then outcome is 'resolved-merged' with bytes + mode
Given contentMerger returning {status:'clean', bytes, id}, When mergeTrees called, Then outcome is 'resolved-known' with id (fast-path)
Given contentMerger returning {status:'conflict', conflictType:'content', markedBytes}, When mergeTrees called, Then conflict with ConflictType 'content' and conflictContent = markedBytes
Given contentMerger returning {status:'conflict', conflictType:'binary', markedBytes}, When mergeTrees called, Then conflict with ConflictType 'binary' and conflictContent = markedBytes
Given contentMerger returning bytes of length MAX_CONFLICT_OUTPUT_BYTES + 1, When mergeTrees called, Then throws MergeError{code: 'INVALID_MERGE_INPUT', reason: contains 'oversize'}
Given contentMerger returning Promise resolving to ContentMergeResult, When mergeTrees called, Then awaits and threads result identically to sync
Given contentMerger throwing synchronously, When mergeTrees called, Then error propagates unchanged
Given contentMerger returning rejected Promise, When mergeTrees called, Then rejection propagates unchanged
Given gitlink (mode 160000) modify-modify with different ids, When mergeTrees called, Then outcome is 'conflict' with ConflictType 'gitlink' AND contentMerger spy count === 0
```

### Test first (red) — caps

```
Given FlatTree inputs whose union size equals MAX_FLAT_TREE_ENTRIES, When mergeTrees called, Then succeeds
Given FlatTree inputs whose union size equals MAX_FLAT_TREE_ENTRIES + 1, When mergeTrees called, Then throws MergeError{code: 'INVALID_MERGE_TREE'}
Given single FlatTree input exceeding MAX_FLAT_TREE_ENTRIES before union, When mergeTrees called, Then throws MergeError{code: 'INVALID_MERGE_TREE'} (fast-fail)
```

### Test first (red) — property laws

```
Property: for any X, mergeTrees(X, X, X).outcomes is all-unchanged, conflicts: [], cleanMerge: true
Property: mergeTrees(base, base, theirs) resolves every path per theirs (resolved-known or resolved-deleted)
Property: mergeTrees(base, ours, base) resolves every path per ours (mirror law)
Property: outcomes are ordered byte-order on path (deterministic)
Property: conflicts === outcomes.filter(o => o.status==='conflict').map(o => o.conflict)
```

### Implement (green)

1. Validate per-input caps; reject early via `INVALID_MERGE_TREE` if any exceeds
2. Compute path union as `Set<FilePath>` from all three inputs; reject if union size exceeds cap
3. Sort union byte-order
4. For each path:
   - Look up entry in base/ours/theirs
   - Classify per decision table + §8.2 mode handling
   - For modify-modify regular-file/symlink: await `contentMerger`; validate returned byte-size; dispatch on `status` + optional `id`
   - Emit outcome
5. Assemble `TreeMergeResult { outcomes, conflicts: outcomes.filter(...), cleanMerge: conflicts.length === 0 }`

### Refactor

Extract the per-row classification into a pure helper `classifyPath(base, our, their): 'unchanged' | 'ours' | 'theirs' | 'modify-modify' | 'add-add' | 'modify-delete' | 'delete-delete' | ...`. Extract mode-conflict detection into `resolveMode`.

---

## Step 11: Barrel Exports + Full Validate

**Modify:** `src/domain/diff/index.ts` (create if absent), `src/domain/merge/index.ts` (create if absent)
**Modify:** `src/domain/index.ts`

### Actions

1. Create `src/domain/diff/index.ts` exporting:
   - From `diff-change.ts`: `DiffChangeType`, all 5 change interfaces, `DiffChange`, `TreeDiff`
   - From `flat-tree.ts`: `FlatTreeEntry`, `FlatTree`, `MAX_FLAT_TREE_ENTRIES`
   - From `tree-diff.ts`: `diffTrees`
   - From `index-diff.ts`: `diffIndexAgainstTree`, `groupUnmergedEntries`, `conflictsToIndexEntries`
   - From `rename-detect.ts`: `RenameDetectOptions`, `detectRenames`
   - From `line-diff.ts`: `LineHunk`, `LineDiff`, constants, `diffLines`, `splitLines`, `isBinary`
   - From `error.ts`: `DiffError`, `invalidTreeForDiff`

2. Create `src/domain/merge/index.ts` exporting:
   - From `merge-types.ts`: `ConflictType`, `MergeConflict`, `MergeOutcome`, `TreeMergeResult`, `ContentMergeResult`, `ContentMergeContext`, `ConflictMarkerOptions`, `MAX_CONFLICT_OUTPUT_BYTES`
   - From `three-way-tree.ts`: `mergeTrees`
   - From `three-way-content.ts`: `mergeContent`
   - From `conflict-markers.ts`: `writeConflictMarkers`
   - From `error.ts`: `MergeError`, `invalidMergeTree`, `invalidMergeInput`

3. Update `src/domain/index.ts`:
   - Add `export * from './diff/index.js'`
   - Add `export * from './merge/index.js'`

4. Update `knip.json` entry points if any new public export surface emerges outside domain.

### Verify

```bash
npm run validate   # Full quality gate — types, lint, tests, coverage, architecture
```

---

## Step 12: Mutation Testing & Branch Finalization

**Not a code step** — finalization workflow per CLAUDE.md §5.

1. Run `npx stryker run` — fix surviving mutants, accept only provably equivalent ones (documented with `// equivalent-mutant:` comments per CONTRIBUTING.md)
2. Run 4× parallel reviews: code review, security review, performance review, test review (via test-review skill)
3. Update docs:
   - `docs/BACKLOG.md` — mark 5.1–5.5 as `[x]`, update "Progress" line
   - `README.md` — update feature matrix if diff/merge now listed
   - `DESIGN.md` / `CONTRIBUTING.md` — note new module pair if patterns emerged
   - Design doc — add post-implementation notes if any design decision changed during TDD
4. Commit final docs update
5. Squash-and-merge to main (per Phase 4 convention — single commit with subject `feat(domain): add phase 5 — diff and merge`)
6. Cleanup: `git worktree remove .claude/worktrees/phase-5-diff-and-merge && git branch -D worktree-phase-5-diff-and-merge`

---

## Dependency Graph

```
Step 0  (errors + setup)
  │
  ├──────────┬──────────┐
  ▼          ▼          ▼
Step 1     Step 2     Step 3
(DiffChange (LineHunk/  (merge-types)
 + FlatTree  LineDiff
 types)      types +
             isBinary +
             splitLines)
  │           │          │
  ├───────────┤          │
  ▼           ▼          │
Step 4     Step 5        │
(diffTrees) (diffLines)  │
  │           │          │
  ▼           ▼          ▼
Step 6      Step 8     Step 9
(detect-    (writeConf  (mergeContent —
 Renames)    Markers)    uses 2, 3, 5, 8)
              │
              │          Step 7a: FlatTree type
              │          (already created in Step 1)
              │           │
              │           ▼
              │         Step 7b
              │         (diffIndex-
              │          AgainstTree +
              │          groupUnmerged +
              │          conflicts-
              │          ToIndex)
              │
              ▼
           Step 10
           (mergeTrees — uses 3, 7a)
              │
              ▼
           Step 11
           (barrels + validate)
              │
              ▼
           Step 12
           (mutations + 4× reviews + finalize)
```

**Parallelizable groups:**
- After Step 0: Steps 1, 2, 3 (type definitions) fully independent
- After Steps 1 + 2 + 3: Steps 4 (diffTrees), 5 (diffLines), 8 (writeConflictMarkers) fully independent
- After Step 4: Step 6 (detectRenames)
- After Steps 1 + 3 (only): Step 7b can run parallel with Steps 4–10
- Step 9 (mergeContent) needs Steps 2, 3, 5, 8
- Step 10 (mergeTrees) needs Steps 3 and 7a (the FlatTree *type*); does NOT need Step 9 (contentMerger is injected by Phase 7)
