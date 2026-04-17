# Design: Diff & Merge

**Status: Proposed** — Phase 5 of the [backlog](../BACKLOG.md).

### Review Notes

Changes applied after Round 5 (final coherence sweep):

- **§2 module tree updated** — added `diff/flat-tree.ts` (was undocumented despite having a §11 export block), corrected `merge-types.ts` contents (was listing nonexistent `MergeResult`), and annotated file-level contents with the full export set.
- **"4 variants" → "5 variants" drift fixed** — both the Review Notes bullet and §4.4 Design decisions block had stale "4 variants" wording after `resolved-deleted` was split out in Round 2. Now consistently "5 variants" everywhere.
- **Redundant editorial bullet in §12.2 deleted** — the "Merge applies-theirs law (symmetric partner)" bullet was a meta-comment pointing at two laws already listed just above it. Removed to avoid implying a third distinct law.
- **§14 parallelizable-groups dependencies fixed** — Step 9 (mergeContent) now correctly lists Step 3 (for ConflictMarkerOptions / ContentMergeResult), and Step 10 (mergeTrees) correctly notes it needs only Steps 3 and 7a (not Step 9 — the `contentMerger` is injected by Phase 7, not called via `mergeContent`).
- **§13.3 sync/async distinction made explicit** — `mergeContent` is sync + pure; `mergeTrees` is async because it awaits the injected callback. Prevents readers of §13.3 alone from inferring both are sync.
- **New §15 Phase 7 Contracts (Summary)** — consolidates the 7 scattered Phase-7 obligations (sorted FlatTree insertion, async contentMerger, validateSymlinkTarget, gitlink discipline, resolved-merged hashing, direct-call size discipline, diffTreesRecursive + working-tree status). Future Phase 7 implementers have a single audit list.

Changes applied after Round 4 (architecture + test-design) review:

- **`mergeTrees` and `contentMerger` made async** — Phase 7's real callback reads three blobs through `FileSystem.read` (async). Sync signature would force O(N) pre-materialization. Signature now `=> Promise<ContentMergeResult> | ContentMergeResult`, return is `Promise<TreeMergeResult>`.
- **`ContentMergeResult.clean` gains optional `id?: ObjectId`** — short-circuit when the callback knows the merged bytes equal an existing blob. `mergeTrees` then emits `resolved-known{ id }` instead of `resolved-merged{ bytes }`, sparing a re-hash + re-write. Invariant: if `id` is set, `bytes` must hash to `id` under the repository's `HashService`.
- **§8.6 added — option threading model** — explicit paragraph on how `ConflictMarkerOptions` flow through the `contentMerger` closure (labels end up embedded in `markedBytes`). `MergeConflict.ourId`/`theirId`/`baseId` are the authoritative pointer source; labels are presentation-only.
- **`mergeTrees` validates `contentMerger` return-byte size** — callback returning `bytes`/`markedBytes` larger than `MAX_CONFLICT_OUTPUT_BYTES` throws `INVALID_MERGE_INPUT`. Closes the bypass where a callback smuggles oversize buffers past the `writeConflictMarkers` pre-allocation defense.
- **`FlatTree` iteration-order contract pinned** — insertion MUST be byte-order on `FilePath`; Phase 5 functions rely on this for O(N) walks and do NOT sort internally. Caller (Phase 7 `walkTree`) responsible.
- **`MAX_FLAT_TREE_ENTRIES` applied to union** — `mergeTrees` rejects when `union(base ∪ ours ∪ theirs).size` exceeds the cap (in addition to per-input check). Caps 3× blow-up where fully-disjoint trees could hit `3 × MAX_FLAT_TREE_ENTRIES` under attack.
- **`TreeMergeResult.outcomes` / `.conflicts` ordering specified** — byte-order on `path` (using `conflict.path` for conflict variants). `conflicts` is the path-filtered subsequence of `outcomes`. Deterministic rendering guaranteed for Phase 9 `merge` CLI.
- **Stale §6 signature block removed** — the `Tree | undefined` version was superseded by the `FlatTree | undefined` version earlier in the round; one authoritative signature now.
- **§5.3 rename-detect output sort key clarified** — per-variant primary sort key spelled out (RenameChange uses `newPath`).
- **§11 `RenameDetectOptions` stale signature fixed** — dropped `exactMatch`, added `maxSameIdDeletes?`, both now optional. Matches §4.5.
- **Boundary tests enumerated for every cap** — BINARY_DETECTION_BYTES, MAX_LINE_BYTES, MAX_LINES, MAX_DIFF_EDIT_DISTANCE, MAX_DIFF_ITERATION_FACTOR, MAX_FLAT_TREE_ENTRIES (incl. union), MAX_CONFLICT_OUTPUT_BYTES, maxSameIdDeletes. Just-under / at / just-over triples pin `>` vs `>=` mutants.
- **Error-code specificity tests added** — `INVALID_MERGE_TREE` vs `INVALID_MERGE_INPUT` vs `INVALID_TREE_FOR_DIFF` pinned per function. Mutation-resistant per CLAUDE.md.
- **Label validation tests gained positive-baseline cases** — printable ASCII, multi-byte UTF-8, leading/trailing-space labels, all must be accepted. Complements the reject-list cases.
- **`groupUnmergedEntries` coverage expanded to all 4 semantic subsets** — stages 1+2+3, 1 only, 2 only, 1+3, pinning the "forgiving" contract.
- **`contentMerger` mode assertions + gitlink spy-zero test added** — verifies `ctx.baseMode/ourMode/theirMode` reach the callback correctly, and callback is NEVER invoked for gitlink rows.
- **Property laws added:** `splitLines` roundtrip, `detectRenames` idempotence, base-unchanged-on-their-side mirror law.
- **Static golden fixture for `writeConflictMarkers`** — byte-exact `Uint8Array` snapshot pins git-compatible output format without waiting for Phase 11 interop harness.

Changes applied after Round 3 (architecture + security) review:

- **`statFactory` signature fixed in §11** — `(mode: FileMode) => StatData` now matches §6.1; previous zero-arg signature would have dropped per-stage mode info.
- **`StatData` origin declared in §3** — now lists the three domain types pulled from `domain/git-index/`.
- **Label validation hardened against terminal injection** — rejects all C0 controls (U+0000–U+001F), U+007F (DEL), and C1 controls (U+0080–U+009F). Closes ANSI-escape-sequence injection via a hostile branch name. Empty / whitespace-only labels also rejected. Error `reason` no longer embeds the label value (branch-name privacy).
- **`MAX_CONFLICT_OUTPUT_BYTES = 256 MiB`** on `writeConflictMarkers` — pre-allocation DoS defense for the publicly-exported direct-call path that bypasses `isBinary`.
- **§8.1 decision table clarified** — new outcome-variant mapping subsection explicitly says `resolved-merged` is produced *only* by `contentMerger`-returns-clean; every other row produces `resolved-known` / `resolved-deleted`. Mode handling is orthogonal per §8.2 and produces `type-change` conflict for within-kind mode divergence.
- **`splitLines` added as a public export** — canonical byte-to-line split, usable by `writeConflictMarkers` callers that bypass `diffLines`.
- **`RenameDetectOptions.exactMatch` removed** — vestigial knob (same effect as not calling `detectRenames`). Added `maxSameIdDeletes = 100` for per-id fan-out DoS defense in rename detection.
- **`rename-rename` documented as reserved** — new §8.5 explains Phase 5 v1 never emits it; the type stays in the union for a future Phase 7 rename-aware merge primitive.
- **`MergeConflict.baseId` comment cleaned up** — "and some renames" phantom removed; now says "Absent only for 'add-add'".
- **`isBinary([])` and `diffLines(empty, empty)` behavior specified** — empty blob is text; diffLines of two empties returns a zero-length common hunk.
- **`MergeError` split into `INVALID_MERGE_TREE` + `INVALID_MERGE_INPUT`** — tree-shape errors symmetric with `DiffError.INVALID_TREE_FOR_DIFF`. Callers can now switch on `code` for unified "tree too big" handling.
- **`ConflictMarkerOptions` ownership pinned to `merge/merge-types.ts`** — avoids circular-import risk between `conflict-markers.ts` and `three-way-content.ts`.
- **`conflictsToIndexEntries` duplicate-path invariant** — throws instead of emitting a malformed (path, stage)-duplicated index.
- **§14 Step 7 split into 7a (FlatTree type) + 7b (diffIndexAgainstTree impl)** — Step 10 (mergeTrees) now transitively depends only on the type, not the impl. More work parallelizable.

Changes applied after Round 1 architecture + security review:

- **`DiffChange` → per-variant discriminated interfaces** — the original flat type with optional fields didn't narrow in TypeScript, forcing callers into `!` assertions. Now 5 variants (Add/Delete/Modify/Rename/TypeChange) each with precisely the fields they carry.
- **`MergeOutcome` unified into the Merge Types section (now §4.4)** — design previously declared 3 variants in §4.4 and 4 in §12.1 (contradiction). Final shape has 5 variants: `unchanged`, `resolved-known` (id carried), `resolved-merged` (bytes carried, Phase 7 hashes; Round 4 added optional `id` short-circuit), `resolved-deleted` (path only), `conflict`.
- **`FlatTree` has a named value type `FlatTreeEntry`** — no more anonymous object shapes; documented key invariants.
- **`contentMerger` callback enriched with context** — receives `{ path, baseId?, ourId, theirId }` alongside the bytes. Invocation conditions enumerated explicitly. Error-propagation semantics documented (errors bubble).
- **`MergeConflict` content field renamed `conflictContent`** — present on content, add-add, and binary conflicts (anywhere bytes exist). Absent for modify-delete / rename-rename / type-change where there's no canonical bytestream.
- **Unmerged index entries addressed** — new §6.1 specifies `groupUnmergedEntries` and `conflictsToIndexEntries` helpers that bridge merge output to index state.
- **Submodules (gitlinks, mode 160000) have their own rule** — §8.4: `contentMerger` never invoked; any modify-modify with different ids is a new `ConflictType: 'gitlink'`.
- **`DIFF_LIMIT_EXCEEDED` removed** — fallback is now a `degraded: true` flag on `LineDiff`, not an error. Dead code eliminated.
- **Identity laws restated against `TreeMergeResult` shape** — `mergeTrees(X, X, X).outcomes === [unchanged entries]`, not structural tree equality.
- **Myers hardened**: `MAX_ITERATIONS = (M + N) × 1000` budget bounds total work even when edit distance stays under the cap.
- **Conflict marker label injection defended**: `writeConflictMarkers` validates labels — rejects newlines, carriage returns, and `<<<<<<<` / `=======` / `>>>>>>>` substrings. Throws `INVALID_MERGE_INPUT` with a clear reason.
- **Binary detection hardened**: adds `MAX_LINE_BYTES = 65_536` and `MAX_LINES = 100_000`-per-side caps; either one triggers the binary fallback. Closes the "NUL after byte 8000" bypass.
- **Rename detection cap moved earlier**: `adds.length * deletes.length > limit` check runs BEFORE the delete-map is built, preventing O(M) allocation on hostile inputs.
- **`FlatTree` capped**: `MAX_FLAT_TREE_ENTRIES = 1_000_000` enforced by `mergeTrees` / `diffIndexAgainstTree` — throws structured error when exceeded.
- **Symlink write obligation documented**: design explicitly states that Phase 7 write layer MUST validate symlink targets on any `resolved-*` outcome with `mode === '120000'` (path traversal defense). Phase 5 cannot see paths; Phase 7 owns the check.
- **Conflict marker content caveat**: documented that content containing literal `<<<<<<< ` is NOT escaped (matches git). Known limitation; downstream tools inherit git's ambiguity.
- **Empty tree SHA equivalence**: `Tree | undefined` and `Tree { entries: [] }` produce identical output — test case required.
- **Output order contracts explicit**: both `diffTrees` and `diffIndexAgainstTree` produce output in byte-order on path (via `compareBytes`).

---

## 1. Overview

Phase 5 adds the domain-layer algorithms for comparing and combining git trees. Git's working model is content-addressed: every change is ultimately expressed as a difference between two snapshots (trees) or as a combination of two snapshots against a common base (three-way merge). This phase provides four layered capabilities:

1. **Tree diff** — compare two tree objects, yield structural changes (add / modify / delete / rename / type-change).
2. **Line diff** — compare two byte sequences, yield line-level hunks (required for three-way merge of text content).
3. **Index diff** — compare the staging index against a tree, yield structural changes.
4. **Three-way merge** — combine two trees (`ours`, `theirs`) against a common base, yielding a merge result with either a clean tree or conflicts.

All code is pure — no I/O, no filesystem access. Functions accept parsed domain types (trees, indexes, byte sequences) and return new domain types. Actual object reads (needed for content-level merge of blobs referenced by a tree) happen through the application layer (Phase 7) — Phase 5 operates on fully-materialized inputs.

**Scope boundary:** This phase defines the _algorithms_. Working-tree diff (filesystem vs index) requires I/O and lives in Phase 7 as the `status` primitive, which composes Phase 5's `diffIndexAgainstTree` with the `FileSystem` port. Phase 5 provides the _building blocks_; application-layer orchestration is Phase 7/9.

---

## 2. Module Structure

```
src/domain/
├── diff/
│   ├── diff-change.ts       # DiffChange discriminated union + DiffChangeType
│   ├── flat-tree.ts         # FlatTree, FlatTreeEntry, MAX_FLAT_TREE_ENTRIES
│   ├── tree-diff.ts         # diffTrees(a, b): TreeDiff
│   ├── index-diff.ts        # diffIndexAgainstTree + groupUnmergedEntries + conflictsToIndexEntries
│   ├── rename-detect.ts     # detectRenames(changes, options): TreeDiff (content-hash based)
│   ├── line-diff.ts         # diffLines + splitLines + isBinary (Myers algorithm + caps)
│   ├── error.ts             # DiffError union + factories
│   └── index.ts             # Barrel export
├── merge/
│   ├── merge-types.ts       # MergeConflict, ConflictType, MergeOutcome, TreeMergeResult, ContentMergeResult, ContentMergeContext, ConflictMarkerOptions, MAX_CONFLICT_OUTPUT_BYTES
│   ├── three-way-tree.ts    # mergeTrees(base, ours, theirs, contentMerger): Promise<TreeMergeResult>
│   ├── three-way-content.ts # mergeContent(base, ours, theirs): ContentMergeResult
│   ├── conflict-markers.ts  # writeConflictMarkers(oursLines, theirsLines, options): Uint8Array
│   ├── error.ts             # MergeError union + factories
│   └── index.ts             # Barrel export
├── error.ts                 # TsgitErrorData += DiffError | MergeError
└── index.ts                 # Domain barrel re-export
```

---

## 3. Domain Boundary

Phase 5 sits in the domain layer. **No I/O dependencies.**

| Concern | Who handles it | Phase |
|---|---|---|
| Tree-to-tree structural diff | Domain (this phase) | 5 |
| Index-to-tree structural diff | Domain (this phase) | 5 |
| Line-level diff (Myers) | Domain (this phase) | 5 |
| Three-way tree merge (structural) | Domain (this phase) | 5 |
| Three-way content merge (byte-level) | Domain (this phase) | 5 |
| Conflict marker serialization | Domain (this phase) | 5 |
| Reading blob contents to feed content merge | `readObject` primitive | 7 |
| Walking filesystem to compute working-tree diff | `status` primitive | 7 |
| Finding the merge base between two commits | `mergeBase` primitive | 7 |
| CLI formatting of diff/merge output | `diff` / `merge` commands | 9 |

**Dependency direction:** `domain/diff/` and `domain/merge/` are sibling modules alongside `domain/objects/`, `domain/storage/`, `domain/refs/`, `domain/git-index/`. They import domain types only — never ports, adapters, or application code. Both contribute error unions to `domain/error.ts` via `import type`.

**Imports within Phase 5:**
- `domain/merge/` imports from `domain/diff/` (tree-diff and line-diff are building blocks for three-way merge).
- `domain/diff/` does **not** import from `domain/merge/` (no circular dependency).
- Both import `TreeEntry`, `ObjectId`, `FileMode`, `FilePath` from `domain/objects/`.
- `domain/diff/index-diff.ts` imports `IndexEntry`, `GitIndex`, and `StatData` from `domain/git-index/` (all three defined in Phase 3; `StatData` is a pure domain value type with no port or adapter coupling).

---

## 4. Types

### 4.1 Diff Change

```typescript
/** Tag for the kind of structural change — used as the discriminator. */
type DiffChangeType = 'add' | 'delete' | 'modify' | 'rename' | 'type-change';

/** A new entry in the new tree that was absent in the old. */
interface AddChange {
  readonly type: 'add';
  readonly newPath: FilePath;
  readonly newId: ObjectId;
  readonly newMode: FileMode;
}

/** An entry that existed in the old tree and was removed in the new. */
interface DeleteChange {
  readonly type: 'delete';
  readonly oldPath: FilePath;
  readonly oldId: ObjectId;
  readonly oldMode: FileMode;
}

/** Same path, different content id and/or mode within the same kind (see §5.1 `isSameKind`). */
interface ModifyChange {
  readonly type: 'modify';
  readonly path: FilePath;       // unchanged
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly oldMode: FileMode;
  readonly newMode: FileMode;
}

/** Exact-match rename: same blob id, different path. Only produced by `detectRenames` post-processing. */
interface RenameChange {
  readonly type: 'rename';
  readonly oldPath: FilePath;
  readonly newPath: FilePath;
  readonly id: ObjectId;          // same id on both sides (exact match)
  readonly mode: FileMode;         // same mode on both sides
}

/** Same path, kind of file-mode category changed (e.g., regular file → symlink, or file ↔ gitlink). */
interface TypeChangeChange {
  readonly type: 'type-change';
  readonly path: FilePath;
  readonly oldId: ObjectId;
  readonly newId: ObjectId;
  readonly oldMode: FileMode;
  readonly newMode: FileMode;
}

type DiffChange = AddChange | DeleteChange | ModifyChange | RenameChange | TypeChangeChange;

/** Complete structural diff between two trees. Output is sorted by byte-order on path (see §5.3). */
interface TreeDiff {
  readonly changes: ReadonlyArray<DiffChange>;
}
```

**Design decisions — DiffChange:**

- **Per-variant discriminated interfaces** — each variant carries exactly the fields it needs. TypeScript narrows correctly in `switch (change.type)`: inside `case 'add':`, `change.newPath` is `FilePath`, not `FilePath | undefined`. No `!` assertions required at call sites.
- **`ModifyChange` and `TypeChangeChange` use a single `path`** — git requires exact path equality for both classifications, so there's no "old" vs "new" path to distinguish.
- **`RenameChange` has a single `id` and `mode`** — exact-match rename (Phase 5 v1) means the blob is byte-identical on both sides. Similarity-based rename (deferred to Phase 7+) may need separate old/new ids; that will become a different variant or a `similarity: number` field at that time.
- **`type-change` is separate from `modify`** — file-mode-only changes (e.g., regular file → executable, or file → symlink with same path) are semantically different from content modifications and often handled differently in tools.
- **No `copy` variant in v1** — copy detection requires similarity scoring against all blobs (expensive). Git's `-C` detection is deferred to v2.

### 4.2 FlatTree — the fully-flattened tree projection

Many Phase 5 operations need a single path-keyed view of a whole tree (all subdirectories recursively expanded). Building this view requires reading subtree objects, which is I/O — so Phase 5 cannot produce a `FlatTree` itself. Phase 7's `walkTree` primitive does the recursion and hands a `FlatTree` to Phase 5 for diff/merge.

```typescript
/** A single tree entry in the flattened view — no `name` because the path is the map key. */
interface FlatTreeEntry {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

/**
 * Flat, path-keyed projection of a tree. Keys are repo-root-relative forward-slash paths
 * (no leading '/', no '.', no '..', no backslashes, no empty segments). Callers must produce
 * valid paths; Phase 5 does NOT re-validate on each use.
 *
 * **Iteration order:** `entries` MUST be inserted in byte-order on `FilePath` (same ordering
 * as `compareBytes` used throughout Phase 1). `mergeTrees` and `diffIndexAgainstTree` rely
 * on the `Map`'s insertion-order iteration semantics to perform an O(N) merge-walk without
 * an internal sort pass. Callers (Phase 7's `walkTree`) are responsible for inserting in
 * sorted order. Phase 5 does NOT re-sort on entry; it does NOT detect unsorted input — a
 * caller passing unsorted entries will receive un-sorted output. (A sortedness validator
 * can be added later if this becomes a hazard.)
 *
 * Cap: `MAX_FLAT_TREE_ENTRIES = 1_000_000` per tree. Additionally, `mergeTrees` rejects
 * three-way calls where `union(base ∪ ours ∪ theirs).size` exceeds the cap — the union
 * cap defends the total-work invariant regardless of per-input sizes. Violations throw
 * `INVALID_MERGE_TREE` (for merge) or `INVALID_TREE_FOR_DIFF` (for diff).
 */
interface FlatTree {
  readonly entries: ReadonlyMap<FilePath, FlatTreeEntry>;
}

const MAX_FLAT_TREE_ENTRIES = 1_000_000;
```

**Design decisions — FlatTree:**

- **Named `FlatTreeEntry`** — not an anonymous object literal. Enables focused documentation and reuse.
- **Validation is the caller's (Phase 7's) responsibility** — Phase 5 trusts its inputs. The Phase 7 `walkTree` primitive enforces path normalization and traversal-free paths when building the `FlatTree` from real subtree objects.
- **Entry-count cap of 1,000,000** — defends against hostile repositories with pathologically large trees. Realistic repos have at most ~100k files; a cap of 1M is generous but finite. Exceeding the cap throws a structured error; Phase 5 never OOMs silently.

### 4.3 Line Diff

Line-level diff is needed internally by three-way content merge. It is not exposed as a public "diff between two files" API — that is a Phase 7 concern that may use the same algorithm via a public primitive.

```typescript
/** One contiguous range of lines with the same fate in the diff. */
interface LineHunk {
  readonly kind: 'common' | 'ours-only' | 'theirs-only';
  /** Line indices into the respective input. Inclusive start, exclusive end. */
  readonly oursStart: number;
  readonly oursEnd: number;
  readonly theirsStart: number;
  readonly theirsEnd: number;
}

interface LineDiff {
  readonly hunks: ReadonlyArray<LineHunk>;
  /** The line-split inputs, preserved for conflict-marker rendering. */
  readonly oursLines: ReadonlyArray<Uint8Array>;
  readonly theirsLines: ReadonlyArray<Uint8Array>;
  /**
   * True if the diff exceeded size or algorithm limits (see §7.2/§7.3) and fell back
   * to the whole-file replacement hunk pair. Callers treat this as a binary-like
   * outcome (no auto-merge).
   */
  readonly degraded: boolean;
}
```

**Design decisions — LineDiff:**

- **Myers algorithm** — the canonical diff algorithm (O(N*D) in the number of edits). Good enough for typical file sizes and matches git's default `--diff-algorithm=myers`. Patience and histogram algorithms are deferred.
- **Byte-level line splitting** — lines are split on `\n` (LF). Trailing LF preserved; a file with no trailing LF has a final line with no terminator. This matches git's behavior; the domain never normalizes line endings.
- **`Uint8Array` lines, not strings** — git diff operates on bytes. Non-UTF-8 files (binary-detected-as-text edge cases) must not corrupt. Content-level merge still only attempts merge on text files; binary detection is below.
- **`degraded: boolean` flag instead of throwing** — when the diff exceeds algorithm or size caps (§7), callers receive a usable-but-imprecise `LineDiff` rather than an exception. This matches the `ContentMergeResult` interface: a degraded line-diff leads to a binary-like conflict, not a thrown error.
- **No context / diff-header metadata** — Phase 5 produces raw hunks. CLI-formatted unified diff (with `@@ -a,b +c,d @@` headers) is a Phase 9 concern.

### 4.4 Merge Types

```typescript
/** Why a given path conflicted during merge. */
type ConflictType =
  | 'content'         // same path, both sides modified text content, neither subsumes the other
  | 'add-add'         // same path added on both sides with different content
  | 'modify-delete'   // modified on one side, deleted on the other
  | 'type-change'     // file-mode category differs between sides (e.g., file vs symlink)
  | 'rename-rename'   // RESERVED — same source path renamed to different targets; NOT emitted by Phase 5's mergeTrees in v1 (see §8.5). Kept in the union so a future Phase 7 rename-aware merge primitive can synthesize it without widening this type later.
  | 'gitlink'         // both sides changed a gitlink (submodule) SHA — no content merge possible
  | 'binary';         // both sides modified, and content is binary — no auto-merge possible

interface MergeConflict {
  readonly type: ConflictType;
  /** The path in the merged tree where the conflict appears (usually matches ours or theirs). */
  readonly path: FilePath;
  /** The base object id, if a base entry existed. Absent only for 'add-add'. */
  readonly baseId?: ObjectId;
  readonly ourId?: ObjectId;
  readonly theirId?: ObjectId;
  readonly baseMode?: FileMode;
  readonly ourMode?: FileMode;
  readonly theirMode?: FileMode;
  /**
   * Bytes to write to the working tree if the caller wants to record this conflict on disk.
   * Present ONLY for: 'content' (line-marked merge) and 'binary' (ours' bytes from contentMerger).
   * Absent for: 'add-add', 'modify-delete', 'type-change', 'rename-rename', 'gitlink' —
   * Phase 5 doesn't read blobs, so these conflicts have no byte stream at the domain layer.
   * Phase 7 synthesizes bytes from the relevant ObjectId via `readObject` when materializing.
   */
  readonly conflictContent?: Uint8Array;
}

/** The per-path outcome of a three-way tree merge. */
type MergeOutcome =
  /** No change needed — entry in the merged tree is identical to all three sides. */
  | { readonly status: 'unchanged';        readonly path: FilePath; readonly id: ObjectId; readonly mode: FileMode }
  /** Resolved to an existing blob id (e.g., one side's change was applied cleanly). */
  | { readonly status: 'resolved-known';   readonly path: FilePath; readonly id: ObjectId; readonly mode: FileMode }
  /**
   * Resolved by merging content at the byte level (line-merge produced clean bytes).
   * The caller (Phase 7 `merge` primitive) MUST hash these bytes via HashService and
   * write the blob via FileSystem before building the final tree — Phase 5 cannot
   * compute the resulting ObjectId because hashing is an I/O-capable operation.
   */
  | { readonly status: 'resolved-merged';  readonly path: FilePath; readonly bytes: Uint8Array; readonly mode: FileMode }
  /** Resolved as a delete — the path is absent in the merged tree (one or both sides deleted it). */
  | { readonly status: 'resolved-deleted'; readonly path: FilePath }
  /** Auto-merge failed; human intervention required. */
  | { readonly status: 'conflict';         readonly conflict: MergeConflict };

interface TreeMergeResult {
  /**
   * Per-path outcomes ordered by byte-order on `path`. For `resolved-deleted` the
   * ordering key is `path`; for `conflict` it is `conflict.path`. Ordering is stable
   * and deterministic — callers (Phase 7 `status`, Phase 9 `merge` CLI) can directly
   * stream outcomes without an intermediate sort.
   */
  readonly outcomes: ReadonlyArray<MergeOutcome>;
  /**
   * Denormalized view: `outcomes.filter(o => o.status === 'conflict').map(o => o.conflict)`,
   * preserving the byte-order-on-path ordering from `outcomes`.
   */
  readonly conflicts: ReadonlyArray<MergeConflict>;
  readonly cleanMerge: boolean;  // === conflicts.length === 0
}

/** Result of merging a single blob's bytes (content merge). */
type ContentMergeResult =
  | {
      readonly status: 'clean';
      readonly bytes: Uint8Array;
      /**
       * Optional fast-path: when the callback (or `mergeContent` itself) knows the clean
       * bytes are byte-identical to an existing blob (e.g., the merge reduced to ours or
       * theirs' exact content), it may set `id` to that blob's `ObjectId`. `mergeTrees`
       * then emits `resolved-known{ id }` instead of `resolved-merged{ bytes }`, sparing
       * Phase 7 a re-hash + re-write. **Invariant:** if `id` is set, `bytes` MUST hash to
       * `id` under the repository's `HashService`. Phase 5 does NOT verify this (no hash
       * access); wrong id causes a content-addressed corruption — callers are responsible.
       */
      readonly id?: ObjectId;
    }
  | { readonly status: 'conflict'; readonly markedBytes: Uint8Array; readonly conflictType: 'content' | 'binary' };
```

**Design decisions — Merge types:**

- **Per-path outcome with 5 variants** — every path in the union `keys(base) ∪ keys(ours) ∪ keys(theirs)` produces exactly one `MergeOutcome`. `unchanged` carries id + mode of the unchanged entry; `resolved-known` carries an existing `ObjectId` + mode; `resolved-merged` carries bytes + mode (Phase 7 hashes — unless the callback populated the optional `id` fast-path, in which case `mergeTrees` emits `resolved-known` instead); `resolved-deleted` carries only `path` (the path is absent in the merged tree); `conflict` carries a `MergeConflict`.
- **`cleanMerge` and `conflicts` both on the result** — denormalized for caller convenience. Invariant `cleanMerge === (conflicts.length === 0)` enforced at construction.
- **No "final tree" in `TreeMergeResult`** — building the new tree object requires hashing (for `resolved-merged` outcomes) and writing through `HashService` / `FileSystem` ports. Phase 5 returns per-path decisions; the caller assembles and writes.
- **`conflictContent` replaces `markedContent`** — clearer name; always carries bytes when bytes exist (content / add-add / binary). Absent for conflict types where there's no canonical byte stream (modify-delete, rename-rename, type-change, gitlink).
- **`ContentMergeResult.conflictType`** distinguishes `content` (line-level merge with marker bytes) from `binary` (no marker attempt, returns ours' bytes). Tree merge uses this to populate `MergeConflict.type` correctly.

**⚠ Symlink write obligation — contract, not just a warning:** When any `resolved-known` or `resolved-merged` outcome has `mode === '120000'` (symlink), the Phase 7 write layer MUST call `validateSymlinkTarget(targetBytes, repoRoot)` (a Phase 7 primitive, to be defined in Phase 7's design doc) before materializing the symlink on disk. That function throws `MergeError{code: INVALID_MERGE_INPUT, reason: 'symlink target escapes repo root'}` when the target resolves outside `repoRoot`. Phase 5 cannot perform the check — it has no filesystem context or repo-root knowledge — but surfaces `mode === '120000'` in every outcome so Phase 7 can route through the validator by type inspection. Failure to validate enables an attacker with a crafted repo to produce a symlink pointing outside the worktree.

**⚠ Gitlink write obligation:** Gitlinks (mode `160000`) have opaque SHA content — Phase 7 MUST NOT invoke `validateSymlinkTarget` on them (no target bytes to validate) and MUST NOT write them as filesystem symlinks. Gitlink write is "update the submodule pointer in the parent tree" — handled by Phase 9's `submodule update` command (out of v1 scope per PRD §3), which means in v1 the Phase 7 merge primitive simply records gitlink entries in the tree without touching the filesystem.

**Additional design notes — merge types:**

- **Add-add conflicts carry no bytes.** `conflictContent` is absent for 'add-add' (Phase 5 cannot read blobs; Phase 7 synthesizes the bytes from `ourId` via `readObject` when the caller wants to write ours' version to disk during conflict materialization).
- **Binary conflicts ALWAYS carry bytes**, because they only originate from `contentMerger` (which has the bytes by construction). `mergeTrees` never creates a binary conflict on its own — it lacks the blob contents to classify binary vs text.
- **`resolved-merged.bytes` hashing** is Phase 7's responsibility using the repository's configured `HashService` (Phase 4's `Context.hash`). Phase 5 is hash-algorithm-agnostic — it returns raw bytes; Phase 7 hashes them using the same `HashService` instance that hashes every other blob for that repository, guaranteeing algorithmic consistency. A repository that switches hash algorithms mid-merge is not supported (and not supportable — any git implementation would fail the same way).

### 4.5 Rename Detection Options

```typescript
interface RenameDetectOptions {
  /**
   * Maximum number of add×delete pairs to consider. Pairs beyond this are left as
   * independent add/delete. Default: 1000 (matches git's diff.renameLimit).
   * To disable rename detection entirely, don't call `detectRenames` — do not
   * pass `limit: 0` (ambiguous with git's "unlimited" sentinel).
   */
  readonly limit?: number;
  /**
   * Per-id fan-out cap: if any single ObjectId appears in more than this many
   * deletes (an adversarial or pathological shape), rename detection for that
   * id is skipped and its adds/deletes are left as-is. Default: 100.
   */
  readonly maxSameIdDeletes?: number;
}
```

**Design decisions — rename detection:**

- **Only exact-match in v1** — content-similarity scoring (git's `-M50%` style) requires loading blob contents and running sub-line diff on every candidate pair. Too expensive for the domain layer to attempt speculatively; also requires I/O. Deferred to Phase 7 as an application-layer primitive that composes tree-diff + blob reads. An `exactMatch: boolean` toggle was considered but rejected as vestigial — a caller that wants no renames simply doesn't call `detectRenames`.
- **`limit` as a hard cap** — prevents pathological quadratic blowups on rename-heavy diffs.
- **`maxSameIdDeletes` per-id cap** — defends against the case where `adds × deletes` passes the product budget but a single ObjectId appears in hundreds of deletes, forcing O(N) scan per matching add. Realistic repos never see the same blob at more than a handful of paths.
- **`detectRenames` is a post-processing step** — `diffTrees` produces raw add/delete/modify changes, then `detectRenames` folds matching pairs into `rename` entries. Keeps the tree-walking pass simple.

---

## 5. Tree Diff Algorithm

### 5.1 Algorithm

`diffTrees` walks two sorted tree entry arrays in parallel (git trees are always byte-sorted by name-with-virtual-slash-for-directories; see Phase 1's `sortTreeEntries` / `treeEntryCompare`).

```typescript
function diffTrees(
  oldTree: Tree | undefined,
  newTree: Tree | undefined,
): TreeDiff;
```

Either tree may be `undefined` (represents an empty tree). `undefined + undefined` yields an empty diff.

**Two-pointer walk:**

```
i = 0, j = 0
sorted(old) = [ ...oldEntries ]
sorted(new) = [ ...newEntries ]
changes = []

while i < old.length and j < new.length:
  cmp = treeEntryCompare(old[i], new[j])
  if cmp < 0:
    changes.push(delete(old[i]))
    i++
  elif cmp > 0:
    changes.push(add(new[j]))
    j++
  else:
    # same name — classify
    if old[i].mode !== new[j].mode and isSameKind(old[i].mode, new[j].mode) === false:
      changes.push(typeChange(old[i], new[j]))
    elif old[i].id !== new[j].id or old[i].mode !== new[j].mode:
      changes.push(modify(old[i], new[j]))
    # else: unchanged — emit nothing
    i++; j++

while i < old.length: changes.push(delete(old[i++]))
while j < new.length: changes.push(add(new[j++]))
```

**Output order:** the two-pointer walk preserves the input tree's sort order (byte-level on name-with-virtual-slash; see Phase 1 `treeEntryCompare`). No post-sort needed.

**`isSameKind` classification:**
- Regular file (`100644`, `100755`) are the same kind (mode-only change within kind → `modify`, not `type-change`).
- Symlink (`120000`) is its own kind.
- Gitlink (`160000`) is its own kind.
- Directory (`40000`) cannot appear at the same path as any non-directory without being a `type-change`.

### 5.2 Subtree Recursion — Not Phase 5

**Phase 5's `diffTrees` compares entries of a single tree level.** It does not recurse into subdirectories. When a tree entry is a subtree (directory), the diff records it as a single `modify` (or whatever) entry referring to the subtree's ObjectId.

Recursive, flattened tree diff — walking into subtrees to produce a path-relative list of changes across the whole tree — is a **required Phase 7 primitive** (`diffTreesRecursive`) because it requires I/O to read the subtree objects. Phase 5 provides the single-level building block; Phase 7 composes it with `readObject` + `walkTree` to produce whole-tree recursive diff. This primitive is what the `diff` command (Phase 9) will use by default.

### 5.3 Post-Processing: Rename Detection

`detectRenames` operates on a `TreeDiff` and produces a new `TreeDiff` with exact-match renames folded:

```typescript
function detectRenames(diff: TreeDiff, options?: RenameDetectOptions): TreeDiff;
```

Algorithm:
1. Partition changes into `adds`, `deletes`, and `other`.
2. **Budget check (BEFORE map construction):** if `adds.length * deletes.length > options.limit`, skip rename detection entirely and return the diff unchanged. This prevents a hostile tree with many deletes from forcing O(M) map allocation regardless of the add count.
3. Build a `Map<ObjectId, Array<DeleteChange>>` from `deletes` keyed by `oldId`. After construction, any key whose array exceeds `options.maxSameIdDeletes` (default 100) is **removed** from the map — adds matching that id will fall through to add+delete without scanning the oversized array. This closes the per-id fan-out path where hundreds of deletes share a single ObjectId.
4. For each add, look up deletes with matching `newId`. If exactly one match exists, replace the add+delete pair with a single `rename` change. Otherwise leave them as add+delete.
5. Return a new `TreeDiff` with rearranged changes, preserving byte-order on the _primary sort key_ per variant: `AddChange.newPath`, `DeleteChange.oldPath`, `RenameChange.newPath` (the "add" side being consumed), `ModifyChange.path`, `TypeChangeChange.path`. This matches the byte-order of the pre-rename diff — a caller that renders output from the post-rename `TreeDiff` sees changes in the same order `diffTrees` would have produced, with each exact-match rename positioned where its "add" was.

**Why exact-match only:** Similarity-based rename detection (git's `-M` flag) requires blob reads and string similarity scoring (Levenshtein or histogram). Both are expensive and require I/O. Phase 7 can introduce `detectRenamesWithSimilarity(diff, blobReader, threshold)` as an application-layer primitive.

**Default `limit = 1000`** matches git's historical `diff.renameLimit`; recent git versions bumped this to 7000. Phase 5 stays conservative; callers can raise the limit explicitly.

---

## 6. Index Diff

Compare the staging index (flat list of entries with full paths) against a single tree. Since a `Tree` is hierarchical and an index is flat, the algorithm walks the index entries and a flattened view of the tree.

**Scope boundary:** The flattening of the tree — reading subtrees recursively — is impossible in pure domain code (subtree blobs must be fetched). `diffIndexAgainstTree` requires the caller to pass an already-flattened tree representation. The `FlatTree` type (§4.2, `readonly entries: ReadonlyMap<FilePath, FlatTreeEntry>`) is the contract:

```typescript
function diffIndexAgainstTree(
  index: GitIndex,
  tree: FlatTree | undefined,
): TreeDiff;
```

Algorithm:
1. Build `indexMap: Map<FilePath, IndexEntry>` from `index.entries` (skip stage > 0; those are unmerged entries, handled by `merge` not `diff`).
2. For each path in `indexMap ∪ tree.entries`:
   - Both present with same id and mode → emit nothing.
   - Both present, different id OR mode with same kind → `modify`.
   - Both present, different kind → `type-change`.
   - Only in index → `add` (staged addition).
   - Only in tree → `delete` (staged deletion).
3. Sort changes by path for stable output.

**Index invariants exploited:**
- `index.entries` is byte-sorted by path (git invariant, enforced by `serializeIndex`).
- Stage 0 entries = "resolved" (normal tracked files). Stages 1/2/3 = unmerged (base/ours/theirs) — Phase 5 skips them in this function; they belong to merge-in-progress state.
- Total entries capped at `MAX_FLAT_TREE_ENTRIES`; exceeding → `INVALID_TREE_FOR_DIFF`.

### 6.1 Bridging Merge → Index: Unmerged Entries

A merge that produces conflicts leaves the working state in "merge-in-progress": conflicting paths have stage-1/2/3 entries in the index representing base/ours/theirs respectively. Phase 7's `writeIndex` and `status` primitives need pure helpers to move between the merge result and the index state. Phase 5 provides them as pure structural transforms:

```typescript
/**
 * Partition an index into stage-0 entries (clean) and path-grouped stages 1/2/3.
 * Used by Phase 7 `status` to report "Unmerged paths" during a conflict-state merge.
 *
 * Validation: forgiving — does NOT throw on git-invalid states (e.g., stage-1 without
 * stage-2/3). Callers may observe any subset of {stage1, stage2, stage3}; a corrupt
 * index produces a corrupt grouping. Phase 7 `status` surfaces the raw state to the user;
 * it is not Phase 5's job to "fix" a malformed index silently.
 */
function groupUnmergedEntries(index: GitIndex): {
  readonly staged: ReadonlyArray<IndexEntry>;   // stage-0 only
  readonly unmerged: ReadonlyMap<FilePath, {
    readonly stage1?: IndexEntry;  // base
    readonly stage2?: IndexEntry;  // ours
    readonly stage3?: IndexEntry;  // theirs
  }>;
}

/**
 * Convert a list of merge conflicts into a flat list of index entries with stages
 * 1/2/3 populated. The caller supplies a `statFactory` that builds StatData for a
 * given FileMode — unmerged entries are fully virtual (no filesystem stat), so the
 * factory typically returns a zero-stat record with the correct mode injected.
 *
 * Output ordering: returned entries are sorted by (path ASC, stage ASC) — compatible
 * with direct serialization into a git index via `serializeIndex`.
 *
 * Conflicts that carry none of baseId/ourId/theirId (e.g., some degenerate
 * rename-rename shapes) produce zero output entries — the caller must synthesize
 * separately. Other conflicts produce 1–3 entries (one per non-null id, with the
 * stage determined by which id field is set).
 *
 * Duplicate-path invariant: if two conflicts in `conflicts` share the same `path`,
 * the function throws `MergeError{code: INVALID_MERGE_INPUT, reason: 'duplicate
 * conflict path'}`. Deduplication is the caller's responsibility — Phase 5 refuses
 * to produce a malformed (path, stage)-duplicated index silently.
 */
function conflictsToIndexEntries(
  conflicts: ReadonlyArray<MergeConflict>,
  statFactory: (mode: FileMode) => StatData,
): ReadonlyArray<IndexEntry>;
```

**Design decisions — unmerged helpers:**

- **Pure domain functions** — no I/O. The `statFactory` callback lets Phase 7 inject a zero-stat record while correctly threading the file mode from the conflict (each stage entry carries its own mode from `baseMode` / `ourMode` / `theirMode`).
- **Why three stages, not four** — stage 0 is "resolved", stages 1/2/3 are "unmerged". The git index format reserves 2 bits for stage (§Phase 3 design), so the compile-time type `0 | 1 | 2 | 3` is already in `IndexEntryFlags.stage`.
- **Forgiving grouping** — `groupUnmergedEntries` surfaces whatever the index contained; it does not validate git invariants. `status` can then display "corrupt unmerged state" to the user rather than failing silently.
- **Structured output order** — `conflictsToIndexEntries` returns entries in (path, stage) byte-order so callers can splice the result directly into a sorted index without re-sorting.

---

## 7. Line Diff (Myers Algorithm)

```typescript
function diffLines(
  ours: Uint8Array,
  theirs: Uint8Array,
): LineDiff;
```

### 7.1 Myers O(ND) Algorithm — High-Level

The Myers diff algorithm finds the shortest edit script (SES) converting `ours` into `theirs`, where each edit is an insert or delete of one line. It runs in `O((M+N) × D)` time where `D` is the edit distance. For typical source files with small diffs, this is linear in file size.

**Implementation outline:**
1. Split `ours` and `theirs` into `Uint8Array[]` at `\n` boundaries (keep the `\n` in each line; final line may lack one).
2. Run the Myers forward-search algorithm on the two arrays, using byte-level line equality (`areBytesEqual(a, b)`).
3. Reconstruct the edit path as a sequence of (common | ours-only | theirs-only) ranges → `LineHunk[]`.

### 7.2 Complexity Bounds — Two Caps, Not One

For very large files or pathological diffs, edit distance `D` can approach `M + N`, making the algorithm quadratic. The edit-distance cap alone bounds the _final_ result size but not the _work done before the cap fires_ — a Myers search can evaluate billions of inner-loop iterations before converging on a distance of 9,999. To bound total work, Phase 5 imposes two independent caps:

```typescript
const MAX_DIFF_EDIT_DISTANCE       = 10_000;   // matches git's rename-limit spirit
const MAX_DIFF_ITERATION_FACTOR    = 1_000;    // iteration budget = (M + N) * factor
// Effective budget for any given (M, N): maxIterations = (M + N) * MAX_DIFF_ITERATION_FACTOR

// Fallback triggered when EITHER cap fires:
//   LineDiff{ hunks: [ours-only-whole, theirs-only-whole], degraded: true }
// Three-way content merge observes `degraded: true` and records a 'binary' conflict type
// (no marker rendering attempted).
```

The iteration budget is **input-relative** (`(M+N) × factor`) rather than a fixed absolute number: a fixed cap of 1M iterations would fire falsely on legitimate large-file diffs (e.g., a 50k-line log file with realistic edits easily needs ≈ 200k iterations). Scaling with file size preserves the pathological-input guard while allowing normal-sized diffs to converge.

This cap is a v1 simplification. Patience/histogram algorithms, which are asymptotically well-behaved on realistic diffs, are a v2 optimization.

### 7.3 Binary Detection — Multi-Signal, Not Just NUL

`diffLines` is called only by content-merge, which first checks `isBinary(bytes)`. The check considers multiple signals — not just a NUL in the first 8000 bytes — to defend against adversarial inputs:

```typescript
const BINARY_DETECTION_BYTES = 8_000;
const MAX_LINE_BYTES         = 65_536;   // any single line longer than this → treat as binary
const MAX_LINES              = 100_000;  // per side — exceeding → treat as binary

/**
 * A blob is considered binary if ANY of:
 *   1. A NUL byte appears in the first BINARY_DETECTION_BYTES (git's classic heuristic).
 *   2. Any line (sequence of bytes terminated by \n or end-of-blob) exceeds MAX_LINE_BYTES.
 *   3. The total line count exceeds MAX_LINES.
 * Signals (2) and (3) defend against "NUL placed after byte 8000" bypass attempts:
 * without them, a blob can pass the NUL check and feed arbitrary binary as "lines"
 * into Myers, causing DoS or incorrect marker rendering.
 */
function isBinary(bytes: Uint8Array): boolean;
```

**Empty-input contract:**
- `isBinary(new Uint8Array(0))` returns `false` — the empty blob is text (no NUL, no oversized line, zero lines is under the cap).
- `diffLines(empty, empty)` returns `{ hunks: [{ kind: 'common', oursStart: 0, oursEnd: 0, theirsStart: 0, theirsEnd: 0 }], oursLines: [], theirsLines: [], degraded: false }` — a single zero-length common hunk. Callers must not treat this as an error.
- `mergeContent(undefined, empty, empty)` for the base-absent add-add case with identical empty bytes returns `{ status: 'clean', bytes: empty }`.

**Known limitation — UTF-16 text:** UTF-16-encoded text files contain NUL bytes for ASCII characters and are therefore classified as binary. Git has the same limitation; `.gitattributes` with `text=utf-16` is the user-level workaround. This is deferred to Phase 10 (working-tree filters / `.gitattributes`); until then, UTF-16 files bypass three-way content merge and are recorded as binary conflicts.

**Known limitation — content containing conflict-marker-like strings:** If a blob contains a literal line starting with `<<<<<<< `, `=======`, or `>>>>>>> `, `writeConflictMarkers` emits it verbatim — identical to git's behavior. This produces ambiguous output that downstream tools (editors, resolution helpers) may misparse. No escaping is attempted because git has no canonical escape mechanism; adding one would break interop. Callers relying on parsing merge output should be aware. This is documented, not fixed.

---

## 8. Three-Way Tree Merge

```typescript
interface ContentMergeContext {
  readonly path: FilePath;
  readonly baseId?: ObjectId;     // absent for add-add
  readonly ourId: ObjectId;
  readonly theirId: ObjectId;
  /**
   * Modes for the three sides. Included so Phase 7 `merge` primitive can short-circuit
   * mode-only changes (skip content merge when ourId === baseId but mode differs), route
   * symlinks (`120000`) through target-validation logic, and log accurate context.
   * Gitlinks (`160000`) never reach this callback (see §8.4), so modes here are always
   * `100644`, `100755`, or `120000`.
   */
  readonly baseMode?: FileMode;   // absent for add-add
  readonly ourMode: FileMode;
  readonly theirMode: FileMode;
}

function mergeTrees(
  base: FlatTree | undefined,
  ours: FlatTree | undefined,
  theirs: FlatTree | undefined,
  /**
   * Content merger — invoked iff (base is present) AND (ours and theirs both differ from base)
   * AND (ours differs from theirs) AND (entry kind is a regular file or symlink — NOT gitlink).
   * For gitlinks (mode '160000'), `mergeTrees` records a 'gitlink' conflict without invoking
   * the callback (see §8.4).
   *
   * **Async by contract.** Phase 7's concrete callback reads three blobs through `readObject`
   * (backed by the `FileSystem` port, whose `read` method is async). Forcing a sync signature
   * would require Phase 7 to pre-materialize every blob that *might* be modify-modify before
   * calling `mergeTrees` — O(N) unnecessary reads. Async is the only non-regressive contract.
   * `mergeTrees` itself is therefore async (returns `Promise<TreeMergeResult>`).
   *
   * Errors thrown by the callback (including promise rejections) propagate unchanged — the
   * domain does not catch or convert them. Phase 7's `merge` primitive may catch read errors
   * and convert to TsgitError, but that wrapping happens in the application layer.
   */
  contentMerger: (
    ctx: ContentMergeContext,
    base: Uint8Array | undefined,
    ours: Uint8Array,
    theirs: Uint8Array,
  ) => Promise<ContentMergeResult> | ContentMergeResult,
): Promise<TreeMergeResult>;
```

**Why `FlatTree` and not `Tree`:** Same reason as `diffIndexAgainstTree` — full-tree merge requires reading subtree objects. Phase 5 operates on a fully-materialized flat projection; Phase 7 `merge` primitive flattens the trees by reading their subtrees through `readObject`, then calls `mergeTrees`. Cap: `MAX_FLAT_TREE_ENTRIES` per input; exceeding throws `INVALID_MERGE_TREE`.

**Why `contentMerger` is a callback:** Content merge needs the **bytes** of blobs — which requires reading them through the `FileSystem` port. The domain cannot perform I/O, so the application layer (Phase 7) injects a `contentMerger` closure that reads the three blobs and calls `mergeContent`. This keeps `mergeTrees` pure while allowing real content merges.

**`ContentMergeContext`** gives the callback path/id visibility so it can route reads through its own cache or log decisions — without breaking the pure-function contract of the merge itself.

### 8.1 Per-Path Decision Table

For each path in `keys(base) ∪ keys(ours) ∪ keys(theirs)`:

| Base | Ours | Theirs | Outcome |
|---|---|---|---|
| —    | —    | —    | (impossible — path wouldn't be in the union) |
| X    | X    | X    | **unchanged** |
| X    | X    | Y    | **resolved** with theirs (ours unchanged from base, theirs modified) |
| X    | Y    | X    | **resolved** with ours (theirs unchanged from base, ours modified) |
| X    | Y    | Y    | **resolved** with ours (both sides modified the same way — same id) |
| X    | Y    | Z    | **content merge** (modify-modify) → resolved or content conflict |
| —    | X    | —    | **resolved** with ours (added only by us) |
| —    | —    | X    | **resolved** with theirs (added only by them) |
| —    | X    | X    | **resolved** with ours (same add on both sides) |
| —    | X    | Y    | **conflict: add-add** |
| X    | —    | X    | **resolved** as delete (deleted only by us, theirs unchanged from base) |
| X    | X    | —    | **resolved** as delete (deleted only by them) |
| X    | —    | —    | **resolved** as delete (deleted on both sides) |
| X    | —    | Y    | **conflict: modify-delete** (we deleted, they modified) |
| X    | Y    | —    | **conflict: modify-delete** (we modified, they deleted) |

Where X/Y/Z denote distinct (id, mode) tuples. "resolved" means the outcome has a concrete (id, mode) for the merged tree.

**Outcome-variant mapping (clarifies which `MergeOutcome.status` each row produces):**

- `unchanged` — emitted only for the `X | X | X` row (all three sides identical id AND mode).
- `resolved-known` — emitted for every other "resolved" row where Phase 5 has a concrete `ObjectId` to use without hashing (one or both sides agree with base, sides agree with each other, or a single-side add/delete with no content merge).
- `resolved-merged` — emitted **only** by the modify-modify row (`X | Y | Z`) when `contentMerger` returns `{ status: 'clean', bytes }`. This is the single code path that yields bytes requiring a Phase 7 hash. Every other row in the table produces a `resolved-known` or `resolved-deleted` outcome with an id already known to Phase 5.
- `resolved-deleted` — emitted for delete-delete rows (`X | — | X`, `X | X | —`, `X | — | —`).
- `conflict` — emitted for `add-add`, `modify-delete`, and the modify-modify row when `contentMerger` returns `{ status: 'conflict' }` or when gitlinks disagree (see §8.4).

**Mode handling (applies orthogonally to every "resolved" row):** The decision table above classifies by content id. §8.2 determines the resulting `FileMode` independently:

- If all three sides share the same mode → that mode is used.
- If exactly one side changed mode and the other agrees with base → the changed side's mode is used.
- If both sides changed mode identically → the new mode is used.
- If both sides changed mode differently **within the same kind** (e.g., `100644` vs `100755` on a regular file) → mode sub-conflict, represented as `ConflictType: 'type-change'` (the row's content resolution is discarded; no `resolved-*` outcome is produced for this path).
- If the kinds differ at all (file ↔ symlink, file ↔ gitlink, etc.) → `ConflictType: 'type-change'` (handled before the content-id table; see `isSameKind` in §5.1).

### 8.2 Mode-Only Changes

Two same-id entries with different modes (e.g., `100644` vs `100755`) within the same kind (both are regular files) are handled as if it were a modify: the merge prefers ours for mode, or records a conflict if modes differ on both sides. Specifically:

- Same kind, both ours and theirs changed mode identically → `resolved` with the new mode.
- Same kind, ours changed mode, theirs didn't → `resolved` with ours' mode.
- Same kind, ours changed mode one way, theirs another → mode sub-conflict. Phase 5 represents this as a `type-change` conflict since conflict markers don't express mode changes.

### 8.3 Directory vs File at Same Path

If one side adds `foo/bar.txt` (a file under a directory `foo/`) while the other side adds a file named `foo` (no slash), the paths collide at `foo`. Phase 5 flattens hierarchies to `FilePath` strings, so this manifests as `add-add` conflict with different modes and types — caught by the `type-change` conflict rule. Application layer is responsible for refusing to write both.

### 8.4 Gitlinks (Submodules, mode 160000)

Gitlinks reference a commit in a sub-repository by SHA. They have no byte content to merge — only an ObjectId. `mergeTrees` treats them as opaque pointers:

- **Unchanged / one-side-changed / same-side-change:** classified and resolved like any other entry (no `contentMerger` invocation needed).
- **Modify-modify with same new id on both sides:** `resolved-known` with that id.
- **Modify-modify with different new ids on both sides:** `ConflictType: 'gitlink'`. The callback is NEVER invoked for gitlinks, even in the otherwise-content-mergeable "base + both sides modified differently" row of the decision table.
- **Mode change involving gitlink:** mode `160000` is its own kind — changing between `160000` and any file/symlink mode is a `type-change`. This is already covered by §5.1's `isSameKind`.

**PRD alignment:** The v1 scope (PRD §3) excludes submodule _commands_ (no `submodule add`, `submodule update`, etc.), but the domain must still handle trees that contain gitlinks sanely — a repo might already have gitlink entries when tsgit clones or reads it. Phase 5's behavior: structurally correct, no auto-merge of commit SHAs, conflicts recorded with enough data for a tool/human to resolve.

### 8.5 Rename-Rename — Reserved, Not Emitted in v1

`ConflictType: 'rename-rename'` is reserved in the union (§4.4) but `mergeTrees` in v1 never emits it. Rationale:

- Rename detection in Phase 5 is a **post-diff** transform (`detectRenames` in §5.3), not a merge-time classification. Both sides are diffed separately against base, each side's renames are detected independently, and then `mergeTrees` sees the trees via `FlatTree` (path-keyed) — rename information is already "flattened away" into add/delete pairs by the time the merge decision table runs.
- A rename-aware merge requires correlating ours' renames with theirs' renames (same source renamed to different targets) — this is a Phase 7-level composition that couples `detectRenames(diffTrees(base, ours))` with `detectRenames(diffTrees(base, theirs))` and then routes matching source paths through a specialized conflict emitter. That primitive, when added, will synthesize `MergeConflict{type: 'rename-rename'}` values — hence the type is kept in the Phase 5 union.

For v1, callers that want rename-aware conflict reporting must perform the correlation themselves on top of Phase 5's outputs. Phase 9's `merge` command will not expose rename-aware conflicts until Phase 7 ships the correlating primitive.

### 8.6 Option Threading: Labels and Size Validation

`mergeTrees` itself is **label-agnostic** — it has no `ConflictMarkerOptions` parameter. Branch-name labels reach `writeConflictMarkers` via the `contentMerger` closure: Phase 7's `merge` primitive captures `ConflictMarkerOptions` (built from ref names / CLI flags) and passes them to its internal `mergeContent` call. The resulting `markedBytes` already contain the labels by the time `mergeTrees` sees them, so they flow verbatim into `MergeConflict.conflictContent`.

**Authoritative fields:** `MergeConflict` carries `ourId` / `theirId` / `baseId` as the source-of-truth pointers — independent of whatever labels happen to be embedded in `conflictContent`. Tools rendering conflicts should prefer the typed id fields over parsing labels out of bytes.

**`contentMerger` output-size validation:** When the callback returns `{ status: 'conflict', markedBytes }` or `{ status: 'clean', bytes }`, `mergeTrees` validates that the byte length does not exceed `MAX_CONFLICT_OUTPUT_BYTES`. Violations throw `MergeError{code: INVALID_MERGE_INPUT, reason: 'contentMerger returned oversize bytes'}`. This mirrors the `writeConflictMarkers` cap — a misbehaving callback cannot smuggle attacker-controlled gigabyte buffers into `TreeMergeResult` and bypass the pre-allocation defense that the direct-call path enforces.

---

## 9. Three-Way Content Merge

```typescript
function mergeContent(
  base: Uint8Array | undefined,
  ours: Uint8Array,
  theirs: Uint8Array,
): ContentMergeResult;
```

**Scope:** Content merge attempts to combine two text file variants against a common base. Inputs are the raw bytes of three blobs. Outputs either clean bytes or bytes with conflict markers.

### 9.1 Algorithm

1. If any of `ours`, `theirs`, or `base` (when present) is binary (contains NUL in first 8000 bytes), return `{ status: 'conflict', markedBytes: ours }` — no auto-merge attempted.
2. If `base` is `undefined`, there is no common ancestor — this is an add-add scenario. If `ours === theirs` byte-for-byte, return `{ status: 'clean', bytes: ours }`. Otherwise conflict.
3. Compute `diffLines(base, ours)` and `diffLines(base, theirs)`.
4. Walk the two diffs in lockstep against `base`'s lines, emitting:
   - Unchanged lines (both sides leave it alone) → copy to output.
   - One-sided change (ours OR theirs modified, other left alone) → use the changed side's lines.
   - Both-sided change with identical result → use either.
   - Both-sided change with different results → emit conflict markers:
     ```
     <<<<<<< ours
     <ours' lines>
     =======
     <theirs' lines>
     >>>>>>> theirs
     ```
5. If any conflict markers were emitted → `status: 'conflict'`. Else → `status: 'clean'`.

### 9.2 Conflict Marker Format

Git's canonical conflict markers:

```
<<<<<<< {label-for-ours}
{ours' lines}
||||||| {label-for-base}      ← optional, 'diff3' style
{base's lines}
=======
{theirs' lines}
>>>>>>> {label-for-theirs}
```

**Phase 5 v1 decision:** Emit **two-way** markers (no `|||||||` base block). Three-way markers are controlled by `merge.conflictStyle` config (deferred to Phase 7+ where config is read).

**Marker labels:** Phase 5 takes optional `ours`, `base`, `theirs` label strings (default `'ours'`, `'base'`, `'theirs'`). The application layer supplies branch names (e.g., `HEAD`, `feature-x`).

**Label validation (security):** Labels are caller-supplied strings. They MUST NOT:
- Contain any C0 control character (U+0000–U+001F) — covers `\n`, `\r`, `\t`, `\v`, `\f`, NUL, and every ANSI-escape-capable byte (U+001B). Defends against terminal-control-sequence injection via a hostile branch name (ref names permit most control bytes).
- Contain U+007F (DEL) or any C1 control character (U+0080–U+009F) — same rationale.
- Contain any of the substrings `<<<<<<<`, `=======`, `>>>>>>>`, `|||||||` — would allow marker injection.
- Be empty or whitespace-only after `trim()` — produces `<<<<<<< \n` (or `<<<<<<< \t\n` etc.), which canonical git parsers treat as malformed.

`writeConflictMarkers` and `mergeContent` throw `MergeError{code: INVALID_MERGE_INPUT, reason: 'conflict marker label contains forbidden sequence'}` (or `'… is empty or whitespace-only'`) on any failure. The error `reason` identifies the violated rule; the label value itself is **not** embedded in the error message (branch names may be sensitive — avoid leaking them into diagnostics).

A malicious branch name cannot corrupt merge output, inject terminal escapes when the conflict file is displayed in a terminal, or confuse downstream conflict-parsing tools.

### 9.3 `writeConflictMarkers` — Low-Level Helper

```typescript
interface ConflictMarkerOptions {
  readonly labels?: {
    readonly ours?: string;
    readonly base?: string;
    readonly theirs?: string;
  };
  /** 'merge' = two-way markers (v1 default). 'diff3' throws UNSUPPORTED in v1; reserved for v2. */
  readonly conflictStyle?: 'merge' | 'diff3';
}

function writeConflictMarkers(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  options?: ConflictMarkerOptions,
): Uint8Array;
```

Pure function used by `mergeContent` for the both-sided-change-with-different-results case. Exposed for testing and for Phase 7 primitives that need to format conflicts without going through full content merge. Labels validated per §9.2.

The `options` shape is forward-compatible: v1 accepts `conflictStyle: 'merge'` (implicit default) and rejects `'diff3'` with a domain-native `MergeError{code: INVALID_MERGE_INPUT, reason: 'diff3 conflict style requires base lines — not supported in v1'}`. v2 can enable `'diff3'` by accepting a `baseLines` parameter without breaking v1 callers.

**Why not `UNSUPPORTED_OPERATION`?** That error code is an `AdapterError` reserved for adapter-layer capability gaps (e.g., OPFS lacks symlinks). Domain-layer rejections of unsupported options use `INVALID_MERGE_INPUT` with a descriptive reason — keeps the error union partitioned cleanly between layers.

**Output contract:**
- Always ends with `>>>>>>> <theirs-label>\n`, regardless of whether input lines had trailing newlines.
- Marker lines themselves always end with `\n`.
- Content lines are emitted verbatim (no escaping of marker-like content — see §7.3 known limitation).

**Output-size cap:** `writeConflictMarkers` sums `oursLines` + `theirsLines` byte lengths before allocating and throws `MergeError{code: INVALID_MERGE_INPUT, reason: 'conflict output exceeds MAX_CONFLICT_OUTPUT_BYTES'}` when the total would exceed the cap. This closes the pre-allocation DoS where a caller (or a `contentMerger` with attacker-controlled blobs) feeds megabytes of `Uint8Array` lines through the function.

```typescript
const MAX_CONFLICT_OUTPUT_BYTES = 256 * 1024 * 1024; // 256 MiB — generous for real code, finite under attack
```

Note: `isBinary` catches pathological inputs *before* `diffLines` is invoked, but `writeConflictMarkers` is publicly exported and may be called directly without routing through binary detection (e.g., by Phase 7 primitives rendering a pre-computed line split). The cap protects that direct call path.

---

## 10. Error Types

### 10.1 DiffError

```typescript
type DiffError =
  | { readonly code: 'INVALID_TREE_FOR_DIFF'; readonly reason: string };  // e.g., unsorted entries or FlatTree > MAX_FLAT_TREE_ENTRIES
```

Note: line-diff size/iteration caps do NOT throw — they return `LineDiff{ degraded: true }` instead. There is no `DIFF_LIMIT_EXCEEDED` error code because the fallback is a usable value, not a failure.

### 10.2 MergeError

```typescript
type MergeError =
  /**
   * Structural problem with the FlatTree shape itself — cap violations (MAX_FLAT_TREE_ENTRIES),
   * duplicate paths, malformed keys. Symmetric with DiffError.INVALID_TREE_FOR_DIFF so callers
   * can provide a single user-facing message for "tree too large to process".
   */
  | { readonly code: 'INVALID_MERGE_TREE';  readonly reason: string }
  /**
   * Problem with non-tree merge inputs: forbidden/empty conflict marker label, unsupported
   * conflict style (diff3 in v1), duplicate conflict paths into conflictsToIndexEntries,
   * conflict output size cap exceeded.
   */
  | { readonly code: 'INVALID_MERGE_INPUT'; readonly reason: string };
```

The split keeps tree-shape errors (`INVALID_MERGE_TREE`) partitioned from input-parameter errors (`INVALID_MERGE_INPUT`), mirroring `DiffError.INVALID_TREE_FOR_DIFF`. Callers switching on `code` can handle "my tree is too big" uniformly across diff and merge without inspecting `reason` strings.

Note: conflicts are NOT errors. They are reported via `TreeMergeResult.conflicts`. `MergeError` is reserved for structural input problems.

### 10.3 TsgitError Extension

`domain/error.ts` widened:

```typescript
type TsgitErrorData =
  | DomainObjectError
  | StorageError
  | RefsError
  | IndexError
  | AdapterError
  | DiffError
  | MergeError;
```

`extractDetail` extended with new cases using the same `basename`-based sanitization pattern introduced in Phase 4 (no full-path leakage in message strings).

**Note:** A `MergeConflict` is **not** an error — it is a successful outcome of `mergeTrees` that happens to report un-auto-resolvable paths. Callers inspect `TreeMergeResult.conflicts`. Throwing an error for conflicts would be wrong; conflicts are the normal business case.

---

## 11. Function Signatures

### diff/diff-change.ts
```typescript
export type DiffChangeType = 'add' | 'delete' | 'modify' | 'rename' | 'type-change';
export interface AddChange { /* per §4.1 */ }
export interface DeleteChange { /* per §4.1 */ }
export interface ModifyChange { /* per §4.1 */ }
export interface RenameChange { /* per §4.1 */ }
export interface TypeChangeChange { /* per §4.1 */ }
export type DiffChange = AddChange | DeleteChange | ModifyChange | RenameChange | TypeChangeChange;
export interface TreeDiff { readonly changes: ReadonlyArray<DiffChange> }
```

### diff/flat-tree.ts
```typescript
export interface FlatTreeEntry {
  readonly id: ObjectId;
  readonly mode: FileMode;
}
export interface FlatTree {
  readonly entries: ReadonlyMap<FilePath, FlatTreeEntry>;
}
export const MAX_FLAT_TREE_ENTRIES = 1_000_000;
```

### diff/tree-diff.ts
```typescript
export function diffTrees(oldTree: Tree | undefined, newTree: Tree | undefined): TreeDiff;
```

### diff/index-diff.ts
```typescript
export function diffIndexAgainstTree(index: GitIndex, tree: FlatTree | undefined): TreeDiff;
export function groupUnmergedEntries(index: GitIndex): {
  readonly staged: ReadonlyArray<IndexEntry>;
  readonly unmerged: ReadonlyMap<FilePath, {
    readonly stage1?: IndexEntry;
    readonly stage2?: IndexEntry;
    readonly stage3?: IndexEntry;
  }>;
};
export function conflictsToIndexEntries(
  conflicts: ReadonlyArray<MergeConflict>,
  statFactory: (mode: FileMode) => StatData,
): ReadonlyArray<IndexEntry>;
```

### diff/rename-detect.ts
```typescript
export interface RenameDetectOptions {
  readonly limit?: number;              // default 1000 — see §4.5
  readonly maxSameIdDeletes?: number;   // default 100 — see §4.5
}
export function detectRenames(diff: TreeDiff, options?: RenameDetectOptions): TreeDiff;
```

### diff/line-diff.ts
```typescript
export interface LineHunk { /* per §4.3 */ }
export interface LineDiff { /* per §4.3 — includes `degraded: boolean` */ }
export const MAX_DIFF_EDIT_DISTANCE: 10_000;
export const MAX_DIFF_ITERATION_FACTOR: 1_000;   // effective cap = (M+N) * factor
export const BINARY_DETECTION_BYTES: 8_000;
export const MAX_LINE_BYTES: 65_536;
export const MAX_LINES: 100_000;
export function diffLines(ours: Uint8Array, theirs: Uint8Array): LineDiff;
/** Public utility — useful for callers that want to know BEFORE invoking diffLines. */
export function isBinary(bytes: Uint8Array): boolean;
/**
 * Public utility — split a byte buffer into lines on `\n`. Each line retains its trailing
 * `\n` (if any). Shared by `diffLines` and callers that invoke `writeConflictMarkers` directly
 * without a preceding `diffLines` pass (e.g., rendering a pre-computed fallback).
 */
export function splitLines(bytes: Uint8Array): ReadonlyArray<Uint8Array>;
```

### merge/merge-types.ts
All shared merge types live here. `conflict-markers.ts` and `three-way-content.ts` import from this module — `ConflictMarkerOptions` is owned by `merge-types.ts` (not `conflict-markers.ts`) so `three-way-content.ts` can use it without pulling in `conflict-markers.ts`'s implementation dependency. Public re-exports through `merge/index.ts` give callers a single ergonomic import surface regardless of module layout.

```typescript
export type ConflictType = 'content' | 'add-add' | 'modify-delete' | 'type-change' | 'rename-rename' | 'gitlink' | 'binary';
export interface MergeConflict { /* per §4.4 — conflictContent, not markedContent */ }
export type MergeOutcome = /* per §4.4 — 5 variants: unchanged | resolved-known | resolved-merged | resolved-deleted | conflict */;
export interface TreeMergeResult { /* per §4.4 */ }
export type ContentMergeResult = /* per §4.4 */;
export interface ContentMergeContext { /* per §8 */ }
export interface ConflictMarkerOptions { /* per §9.3 — owned here, consumed by conflict-markers.ts and three-way-content.ts */ }
export const MAX_CONFLICT_OUTPUT_BYTES: 268_435_456;  // 256 MiB — see §9.3
```

### merge/three-way-tree.ts
```typescript
export function mergeTrees(
  base: FlatTree | undefined,
  ours: FlatTree | undefined,
  theirs: FlatTree | undefined,
  contentMerger: (
    ctx: ContentMergeContext,
    base: Uint8Array | undefined,
    ours: Uint8Array,
    theirs: Uint8Array,
  ) => Promise<ContentMergeResult> | ContentMergeResult,
): Promise<TreeMergeResult>;
```

### merge/three-way-content.ts
```typescript
export function mergeContent(
  base: Uint8Array | undefined,
  ours: Uint8Array,
  theirs: Uint8Array,
  options?: ConflictMarkerOptions,
): ContentMergeResult;
```

### merge/conflict-markers.ts
```typescript
export function writeConflictMarkers(
  oursLines: ReadonlyArray<Uint8Array>,
  theirsLines: ReadonlyArray<Uint8Array>,
  options?: ConflictMarkerOptions,
): Uint8Array;
```

---

## 12. Testing Strategy

### 12.1 Unit Tests

**tree-diff.ts:**
- Empty-vs-empty → empty diff
- Add-only (old is empty) → only 'add' changes
- Delete-only (new is empty) → only 'delete' changes
- Pure modify (same paths, different ids) → only 'modify' changes
- Mode change within same kind (100644 → 100755) → 'modify' (not 'type-change')
- Kind change (100644 → 120000) → 'type-change'
- Mixed: add + delete + modify in one call → correctly classified and sorted
- Directory ordering: entries respect the virtual-slash sort order
- Roundtrip equivalence: `diffTrees(A, A)` always empty

**rename-detect.ts:**
- Add+delete with matching ObjectId → single 'rename' change
- Add+delete with matching ObjectId but multiple candidates → left as add+delete (ambiguous)
- `Given adds × deletes at limit exactly, When detectRenames called, Then renames detected`
- `Given adds × deletes at limit + 1, When detectRenames called, Then diff returned unchanged`
- `Given exactly maxSameIdDeletes deletes sharing one ObjectId, When detectRenames called, Then rename detected` (at boundary)
- `Given maxSameIdDeletes + 1 deletes sharing one ObjectId, When detectRenames called, Then that id is skipped and adds remain unchanged`

**index-diff.ts:**
- Index empty, tree empty → empty diff
- Index with only stage-0 entries (normal case)
- Index with stage-1/2/3 entries → those entries skipped
- Tree with entries absent from index → 'delete'
- Index with entries absent from tree → 'add'
- Sorted output (stable order by path)

**line-diff.ts:**
- Identical inputs → single `common` hunk spanning everything
- Pure prepend (theirs starts with new lines) → `theirs-only` hunk then `common`
- Pure append → `common` then `theirs-only`
- Pure delete (ours is empty, theirs has content) → `theirs-only` only; reverse → `ours-only` only
- File with and without trailing newline (both directions)
- Binary file (NUL in first 8000 bytes) → `isBinary` returns true
- Edit-distance cap → returns fallback hunk pair with `degraded: true`
- Property: for any `ours`, `theirs` where `ours === theirs`, exactly one `common` hunk covering all lines

**Boundary tests — caps and thresholds (mutation-resistance):** For every numeric constant, test *just-under*, *at*, and *just-over* to kill `>` vs `>=` and off-by-one mutants.

- `Given BINARY_DETECTION_BYTES - 1 offset NUL, When isBinary called, Then returns true`
- `Given BINARY_DETECTION_BYTES offset NUL (the boundary byte itself — outside the window), When isBinary called, Then returns false`
- `Given MAX_LINE_BYTES - 1 bytes on one line, When isBinary called, Then returns false`
- `Given MAX_LINE_BYTES bytes on one line, When isBinary called, Then returns true`
- `Given MAX_LINES - 1 lines, When isBinary called, Then returns false`
- `Given MAX_LINES lines exactly, When isBinary called, Then returns true`
- `Given input needing exactly MAX_DIFF_EDIT_DISTANCE edits, When diffLines called, Then succeeds with degraded: false`
- `Given input needing MAX_DIFF_EDIT_DISTANCE + 1 edits, When diffLines called, Then returns degraded: true whole-file fallback`
- `Given input requiring exactly (M+N) * MAX_DIFF_ITERATION_FACTOR iterations, When diffLines called, Then succeeds`
- `Given input requiring (M+N) * MAX_DIFF_ITERATION_FACTOR + 1 iterations (pathological crafted pair), When diffLines called, Then returns degraded: true`

**three-way-tree.ts:**
- All 14 rows of the decision table from §8.1 — one test per row
- Mode-only changes (kept mode / changed mode / both changed) per §8.2
- Empty base (null-merge of two independent trees) → add-add conflicts where paths overlap with different content
- Empty ours (only theirs has changes) → resolved with theirs
- Empty theirs → resolved with ours
- `contentMerger` invoked only for modify-modify scenarios with regular file / symlink entries (never gitlinks) — verify via spy/stub counting
- `Given modify-modify on a regular file, When mergeTrees called, Then contentMerger's ctx.ourMode matches the ours FlatTree entry's mode exactly`
- `Given modify-modify on a regular file, When mergeTrees called, Then contentMerger's ctx.theirMode matches the theirs FlatTree entry's mode exactly`
- `Given modify-modify with a base entry, When mergeTrees called, Then contentMerger's ctx.baseMode matches the base FlatTree entry's mode`
- `contentMerger` returning `{ status: 'conflict', conflictType: 'content' }` → tree merge records `ConflictType: 'content'` with `conflictContent`
- `contentMerger` returning `{ status: 'conflict', conflictType: 'binary' }` → tree merge records `ConflictType: 'binary'` with `conflictContent: ours`
- `contentMerger` returning `{ status: 'clean', bytes }` (no `id`) → `resolved-merged` with `bytes` (Phase 7 hashes + writes to fill the ObjectId before assembling the final tree)
- `contentMerger` returning `{ status: 'clean', bytes, id: ourId }` (short-circuit fast path) → `resolved-known{ id: ourId }`, NOT `resolved-merged`
- `contentMerger` returning a Promise that resolves to `ContentMergeResult` → `mergeTrees` awaits and behaves identically to sync return
- `contentMerger` returning `markedBytes.length > MAX_CONFLICT_OUTPUT_BYTES` → `MergeError{code: 'INVALID_MERGE_INPUT', reason: contains 'oversize'}` from `mergeTrees`
- `contentMerger` returning `bytes.length > MAX_CONFLICT_OUTPUT_BYTES` (clean path) → same error
- Gitlink (mode `160000`) with different ids on both sides → `conflict` with `ConflictType: 'gitlink'`, callback NOT invoked (assert spy count === 0 for this test)
- `contentMerger` throws synchronously → error propagates unchanged from `mergeTrees`
- `contentMerger` returns rejected Promise → rejection propagates unchanged from `mergeTrees`

**three-way-content.ts:**
- No modifications on either side → return base content unchanged
- Only ours modified → return ours' bytes
- Only theirs modified → return theirs' bytes
- Both sides make the identical modification → one clean copy
- Both sides modify different non-overlapping regions → merged bytes, both changes applied
- Both sides modify overlapping regions with different content → conflict with markers
- Base absent (add-add) with identical bytes → clean
- Base absent with different bytes → conflict (whole-file markers)
- Binary input → immediate conflict without line work
- Marker labels respected (custom labels appear in output)

**conflict-markers.ts:**
- Basic three-section output
- Empty ours or empty theirs → still emit the marker sections
- Labels appear in `<<<<<<< {label}` and `>>>>>>> {label}`
- Output ends with `\n` if the final theirs line lacks one (canonical git behavior)

_Label validation — each reject rule needs a positive (accept) baseline test:_
- `Given label of printable ASCII (e.g., 'HEAD'), When writeConflictMarkers called, Then label appears verbatim in <<<<<<< and >>>>>>> lines` (baseline accept)
- `Given label of multi-byte UTF-8 (e.g., 'feature/Ⓐ'), When writeConflictMarkers called, Then accepted and round-trips through output` (baseline accept — distinguish UTF-8 continuation bytes 0x80-0xBF from C1 controls, which share the byte range)
- `Given label with leading/trailing spaces but non-empty after trim, When writeConflictMarkers called, Then accepted (whitespace-only check uses trim, not hasSpace)` (baseline accept edge)
- Label with `\n` / `\r` → `MergeError{code: 'INVALID_MERGE_INPUT'}`
- Label with C0 control char (e.g., `\x1b` ANSI escape) → `MergeError{code: 'INVALID_MERGE_INPUT'}`
- Label with DEL (`\x7f`) → `MergeError{code: 'INVALID_MERGE_INPUT'}`
- Label with C1 control char (e.g., `\x9b`) → `MergeError{code: 'INVALID_MERGE_INPUT'}`
- Label containing each of `<<<<<<<` / `=======` / `>>>>>>>` / `|||||||` (one test each — kill per-substring mutants) → `MergeError{code: 'INVALID_MERGE_INPUT'}`
- Empty label `''` → `MergeError{code: 'INVALID_MERGE_INPUT'}`
- Whitespace-only label (`' \t\v\f '`) → `MergeError{code: 'INVALID_MERGE_INPUT'}`
- Error `reason` does NOT include the label value (branch-name privacy) — assert via substring non-inclusion
- `Given combined bytes equal MAX_CONFLICT_OUTPUT_BYTES, When writeConflictMarkers called, Then succeeds` (boundary accept)
- `Given combined bytes exceed MAX_CONFLICT_OUTPUT_BYTES by one byte, When writeConflictMarkers called, Then throws MergeError{code: 'INVALID_MERGE_INPUT', reason: contains 'MAX_CONFLICT_OUTPUT_BYTES'}` (boundary reject)
- `diff3` conflict style option → `MergeError{code: 'INVALID_MERGE_INPUT'}` (v1 does not accept base lines)

_Golden fixture (byte-exact git-compatibility snapshot, no harness needed):_
- `Given ours-lines ['a\n', 'b\n'], theirs-lines ['a\n', 'c\n'], labels {ours: 'HEAD', theirs: 'feature'}, When writeConflictMarkers called, Then output equals the hard-coded golden Uint8Array: '<<<<<<< HEAD\na\nb\n=======\na\nc\n>>>>>>> feature\n'` — one static fixture pins the byte-exact format against git's canonical output. Subtle framing regressions (missing `\n`, extra space before label, wrong `<` count) produce immediate test failure without waiting for Phase 11 interop.

**Utilities — line-diff.ts additional:**
- `isBinary(new Uint8Array(0))` → `false` (empty is text)
- `diffLines(empty, empty)` → single zero-length `common` hunk, `degraded: false`
- `splitLines(bytes)` → each element retains trailing `\n`; final element lacks `\n` iff the input lacks a trailing `\n`; `splitLines(empty)` → `[]`

**index-diff.ts additional — unmerged helpers:**
- `groupUnmergedEntries` on all-stage-0 index → `staged` populated, `unmerged` empty
- `Given index with stage 1, 2, and 3 for a path, When groupUnmergedEntries called, Then unmerged entry contains all three stages` (normal conflict case)
- `Given index with stage 2 only (no base, no theirs), When groupUnmergedEntries called, Then unmerged entry has only stage2 populated and no throw`
- `Given index with stage 1 only (orphan base), When groupUnmergedEntries called, Then unmerged entry has only stage1 populated and no throw` (forgiving)
- `Given index with stage 1 + stage 3 only (base + theirs, no ours), When groupUnmergedEntries called, Then unmerged entry has stage1 and stage3 populated, stage2 absent`
- `conflictsToIndexEntries` with a conflict carrying all three ids → 3 entries (stages 1/2/3) in (path, stage) byte-order
- `conflictsToIndexEntries` with two conflicts sharing the same `path` → `MergeError{code: INVALID_MERGE_INPUT, reason: 'duplicate conflict path'}`
- `conflictsToIndexEntries` passes `mode` argument to `statFactory` correctly per stage (baseMode → stage 1, ourMode → stage 2, theirMode → stage 3)

**Cap tests — tree-shape errors (pinning `INVALID_MERGE_TREE` vs `INVALID_TREE_FOR_DIFF`):**
- `Given FlatTree with MAX_FLAT_TREE_ENTRIES entries, When diffIndexAgainstTree called, Then succeeds`
- `Given FlatTree with MAX_FLAT_TREE_ENTRIES + 1 entries, When diffIndexAgainstTree called, Then throws DiffError{code: 'INVALID_TREE_FOR_DIFF', reason: contains 'MAX_FLAT_TREE_ENTRIES'}`
- `Given FlatTree inputs whose union size equals MAX_FLAT_TREE_ENTRIES, When mergeTrees called, Then succeeds`
- `Given FlatTree inputs whose union size equals MAX_FLAT_TREE_ENTRIES + 1, When mergeTrees called, Then throws MergeError{code: 'INVALID_MERGE_TREE', reason: contains 'MAX_FLAT_TREE_ENTRIES'}`
- `Given single FlatTree input > MAX_FLAT_TREE_ENTRIES even before union, When mergeTrees called, Then throws MergeError{code: 'INVALID_MERGE_TREE'}` (fast-fail before union computation)

### 12.2 Property-Based Tests

- **Diff roundtrip:** `diffTrees(A, B)` then synthesizing a "patched" tree from `A` and the diff → equals `B` (up to sort order). Explicitly test with both `A === undefined` and `B === undefined`.
- **Empty-tree equivalence:** `diffTrees(undefined, X) === diffTrees({ entries: [] }, X)` for any `X` (and symmetric). Same for `mergeTrees`.
- **Merge identity — both-sides-unchanged:** for any `FlatTree X`, `mergeTrees(X, X, X).outcomes` is a list of `{ status: 'unchanged', path, id, mode }` for every entry in `X` (not structural tree equality — `TreeMergeResult` is not a tree).
- **Merge identity — ours-unchanged-from-base:** for any `base, theirs`, `mergeTrees(base, base, theirs)` resolves every path in `keys(base) ∪ keys(theirs)` according to `theirs`:
  - Path in both → `resolved-known{ id: theirs[p].id, mode: theirs[p].mode }` (or `unchanged` if id+mode equal across all three).
  - Path only in base (deleted in theirs, unchanged in ours) → `resolved-deleted{ path }`.
  - Path only in theirs (added in theirs) → `resolved-known{ id: theirs[p].id }`.
- **Merge identity — theirs-unchanged-from-base:** symmetric — `mergeTrees(base, ours, base)` resolves according to `ours` with the same structural cases.
- **Merge is clean when no conflicts:** for any inputs where the decision table never yields a conflict, `cleanMerge === true` and `conflicts === []`.
- **Line diff coverage law:** for any `ours`, `theirs`, the union of `common` + `ours-only` hunks (sorted by `oursStart`) covers exactly `[0, ours.length)`; symmetric for `theirs`.
- **Line diff identity:** for any `X`, `diffLines(X, X).hunks` is a single `common` hunk covering the whole input, `degraded: false`.
- **`splitLines` roundtrip:** for any `bytes`, `concat(splitLines(bytes)) === bytes` (byte-identical reconstruction).
- **Rename detection idempotence:** `detectRenames(detectRenames(d, opts), opts)` is deep-equal to `detectRenames(d, opts)` for any `TreeDiff d` and `opts`. Guards against double-folding: once a rename is synthesized, re-running the detector must produce no additional changes.

**Note:** "applying edits to ours yields theirs" is NOT a property law — `LineDiff.hunks` describes a bidirectional alignment, not a directed edit script. Phase 7 may add a public `applyLineDiff` operator; then a directed roundtrip law becomes testable.

### 12.3 Coverage Targets

- 100% line, branch, function, statement coverage (matches project standard)
- 0 surviving non-equivalent mutants (Stryker)
- Equivalent mutants documented with `// equivalent-mutant:` comments per CONTRIBUTING.md

### 12.4 Interop Tests (Phase 11)

Deferred — real canonical-git interop testing requires an end-to-end test harness. Phase 5 establishes the contracts; Phase 11 verifies byte-for-byte equivalence against canonical git for a fixture repo.

---

## 13. Key Design Decisions

### 13.1 Pure Domain, Tree-Centric

**Decision:** Phase 5 operates on fully-materialized trees (`Tree` or `FlatTree`). Subtree loading is the caller's responsibility (Phase 7).

**Why:** Keeps the domain free of I/O. Callers who only need single-level diff (e.g., a `log` command that shows per-commit tree-level changes for a specific directory) avoid the cost of flattening. Callers who need recursive diff compose Phase 5 with Phase 7 primitives.

### 13.2 `FlatTree` Interface for Multi-Level Operations

**Decision:** `diffIndexAgainstTree` and `mergeTrees` accept a `FlatTree` — a pre-flattened `Map<FilePath, {id, mode}>` — rather than walking subtrees themselves.

**Why:** Flattening requires reading subtree objects (I/O). Phase 5 cannot. Phase 7's `walkTree` primitive produces the `FlatTree` by recursively reading subtree blobs through `readObject`.

### 13.3 Content Merge via Injected `contentMerger`

**Decision:** `mergeTrees` takes a `contentMerger` callback for modify-modify scenarios. The callback receives blob bytes and returns a `ContentMergeResult`.

**Why:** Reading blob contents requires I/O. Phase 7's `merge` primitive supplies a closure that reads the three blobs through `readObject`. `mergeContent` itself is **synchronous** and pure — content merge over in-memory bytes does no I/O. `mergeTrees` is **async** because it `await`s the injected `contentMerger`, which Phase 7 backs by async blob reads (§8). Only the async wiring lives in the application layer; the pure byte-level merge algorithm is usable directly.

### 13.4 `MergeConflict` Is a Value, Not an Error

**Decision:** Merge conflicts are normal outcomes, returned in `TreeMergeResult.conflicts`. `MergeError` is reserved for structural problems (invalid input, missing base when required, etc.).

**Why:** Conflicts are the business case. Throwing for conflicts would force callers to catch+rethrow to inspect them. The PRD (§8 error catalog) originally listed `MERGE_CONFLICT` as an error code — this design corrects that: the PRD error code is retained but is thrown only by the application-layer `merge` command when the user has opted out of conflicts via `--abort` or similar, not by the domain merge engine.

### 13.5 Myers Algorithm, Hard Edit-Distance Cap

**Decision:** Use Myers algorithm for line-level diff with `MAX_DIFF_EDIT_DISTANCE = 10_000`. Fallback to whole-file replacement for larger diffs.

**Why:** Myers is the canonical diff algorithm, matches git's default, and is implementable in ~100 lines of TypeScript. The cap prevents quadratic blowups on pathological inputs. Patience/histogram algorithms are a future optimization.

### 13.6 Exact-Match Rename Detection Only in v1

**Decision:** Rename detection considers only add+delete pairs with identical ObjectId. Similarity-based detection is deferred. Default `limit = 1000`; budget check fires BEFORE map construction.

**Why:** Similarity scoring requires blob reads (I/O) and is O(N×M) in the worst case. Exact-match catches the common case (file moved without edits) and is O(N+M). Phase 7 can layer similarity-based detection as a primitive that composes Phase 5's tree-diff with blob reads and a scoring function. The pre-map budget check defends against hostile trees with millions of deletes.

### 13.7 Conflict Markers as Bytes, Two-Way Only

**Decision:** Conflict markers use the canonical `<<<<<<<`/`=======`/`>>>>>>>` format with two-way content (no `|||||||` base section). Labels are caller-supplied.

**Why:** Two-way markers are git's default. Three-way (`merge.conflictStyle = diff3`) is a config option — surfacing it here would require threading config through the domain. Phase 7/9 can add a `conflictStyle` parameter when config reading is implemented. For v1, two-way is sufficient.

---

## 14. Implementation Order

```
Step 0: Error types (DiffError + MergeError, extend TsgitErrorData)
  │
  ├──────────────┬──────────────┐
  ▼              ▼              ▼
Step 1         Step 2         Step 3
(DiffChange    (LineHunk /    (MergeConflict /
 / TreeDiff    LineDiff        MergeOutcome /
 types)        types +         TreeMergeResult
               isBinary)       types)
  │              │              │
  ▼              ▼              │
Step 4         Step 5           │
(diffTrees)    (diffLines —     │
               Myers + cap)     │
  │              │              │
  ▼              │              │
Step 6           │              │
(detectRenames)  │              │
  │              │              │
  ▼              ▼              ▼
Step 7a      Step 8          Step 9
(FlatTree    (writeConflict  (mergeContent —
 type +       Markers +       uses line-diff +
 MAX_FLAT_    MAX_CONFLICT_   conflict-markers +
 TREE_        OUTPUT_BYTES)   splitLines)
 ENTRIES)                      │
  │              │              │
  ▼              │              │
Step 7b          │              │
(diffIndex-      │              │
 AgainstTree     │              │
 + groupUn-      │              │
 merged +        │              │
 conflicts-      │              │
 ToIndex)        │              │
  │              │              │
  └──────────────┼──────────────┤
                 ▼              ▼
              Step 10
              (mergeTrees —
               uses FlatTree (7a) +
               contentMerger)
                 │
                 ▼
             Step 11
             (Barrel exports +
              domain/index.ts update +
              full validate)
                 │
                 ▼
             Step 12
             (Mutation testing +
              4× parallel reviews +
              finalize)
```

**Parallelizable groups:**
- After Step 0: Steps 1, 2, 3 (type definitions) independent.
- Steps 4 (diffTrees), 5 (diffLines + splitLines) independent after their respective type steps.
- Step 9 (mergeContent) needs Steps 2, 3, 5, 8 — including Step 3 for `ConflictMarkerOptions` / `ContentMergeResult`.
- **Step 10 (mergeTrees) needs only Steps 3 and 7a** — Step 3 for shared merge types + `MAX_CONFLICT_OUTPUT_BYTES`, Step 7a for the `FlatTree` type. Does NOT need Step 9 (`mergeContent`) — the `contentMerger` callback is injected by Phase 7 and receives bytes, not a `mergeContent` function reference. Steps 7b, 8, 9 can run in parallel with Step 10.
- Step 6 (rename detect) only needs Step 4.

---

## 15. Phase 7 Contracts (Summary)

Phase 5 is pure domain. The following obligations are delegated to Phase 7's `merge` / `status` / `diff` / `walkTree` primitives. Implementers of Phase 7 must audit this list before shipping:

1. **Byte-sorted `FlatTree` construction.** `walkTree` produces `FlatTree` with `entries` inserted in byte-order on `FilePath`. `mergeTrees` and `diffIndexAgainstTree` rely on insertion-order iteration for O(N) merge-walks and do not sort internally (§4.2).
2. **Async `contentMerger` closure.** Phase 7's `merge` primitive constructs and injects the callback passed to `mergeTrees`. The callback reads three blobs through `readObject` (async), captures `ConflictMarkerOptions` for branch-name labels in its closure, and calls `mergeContent` internally (§8, §8.6, §13.3).
3. **Symlink target validation.** For every `resolved-known` / `resolved-merged` outcome with `mode === '120000'`, Phase 7 MUST call `validateSymlinkTarget(targetBytes, repoRoot)` before materializing the symlink on disk — path-traversal defense (§4.4).
4. **Gitlink write discipline.** Gitlink outcomes (`mode === '160000'`) MUST NOT be written to the filesystem and MUST NOT pass through `validateSymlinkTarget` — opaque SHA, no target bytes (§4.4, §8.4).
5. **`resolved-merged` hashing.** For every `resolved-merged` outcome, Phase 7 hashes `bytes` via `HashService` and writes the blob via `FileSystem` before assembling the final tree. If the `contentMerger` populated the optional `id` short-circuit, Phase 7 may skip the hash + write and trust the id — at the caller's risk of content-addressed corruption if the invariant `id == HashService.hash(bytes)` is violated (§4.4).
6. **Direct-call output-size discipline.** Callers of `writeConflictMarkers` that bypass `mergeContent` MUST ensure input line totals do not exceed `MAX_CONFLICT_OUTPUT_BYTES`, or catch `MergeError{code: INVALID_MERGE_INPUT}` (§9.3).
7. **Recursive tree diff and working-tree status.** `diffTreesRecursive` (cross-subtree diff) and `status` (filesystem vs index) live in Phase 7, each composing a Phase 5 primitive with I/O-capable helpers (§1, §5.2, §6).

---

## 16. File Conventions

- Source files: `src/domain/diff/*.ts`, `src/domain/merge/*.ts`
- Test files: `test/unit/domain/diff/*.ts`, `test/unit/domain/merge/*.ts`
- File names: kebab-case (enforced by ls-lint)
- Test names: `<module>.test.ts`, arbitraries in `arbitraries.ts` per module
- Test format: Given/When/Then titles, AAA body, `sut` variable (project convention)
- Import extensions: all imports use `.js` suffix
- Error pattern: module-local error unions with `import type` into `domain/error.ts` (consistent with Phases 2/3/4)
