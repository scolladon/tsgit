# Phase 13.4b — Three-way merge conflict handling

## 1. Goal

Replace the current `throw mergeHasConflicts(...)` behaviour with a
**persistent conflicted-merge state** that the user can inspect, edit,
and resolve. After a conflicting merge:

- The working tree carries conflict-marker files for every conflicting
  content path.
- `.git/index` carries stage-1/2/3 unmerged entries for every
  conflicting path (whatever sides are present: base, ours, theirs).
- `.git/MERGE_HEAD` records the merge target's commit id.
- `.git/MERGE_MSG` records the merge message draft.
- `.git/ORIG_HEAD` records HEAD's pre-merge tip so the user can
  `reset --hard ORIG_HEAD` to abort.
- HEAD is **not** advanced (we never commit a conflicted merge).

BACKLOG §13.4b acceptance:

> A conflicting merge leaves the working tree with `<<<<<<<` markers
> for resolved-merged-with-conflict paths, the index has stage-1/2/3
> entries, and `repo.merge({ target })` followed by manual `add` +
> `commit` produces a clean merge commit.

## 2. Surface

`repo.merge({ target })` keeps its current signature. On a conflicting
merge it returns a NEW `MergeResult` variant rather than throwing:

```typescript
| {
    readonly kind: 'conflict';
    readonly conflicts: ReadonlyArray<{
      readonly path: FilePath;
      readonly type: ConflictType;
    }>;
    readonly mergeHead: ObjectId;     // target commit (written to MERGE_HEAD)
    readonly origHead: ObjectId;      // pre-merge HEAD (written to ORIG_HEAD)
  }
```

**Rationale for return-vs-throw**: throwing was a placeholder.
A successful merge returns metadata about what happened; a conflicting
merge IS a successful library call (the state on disk is persisted
intentionally) — the only thing that didn't succeed is the
auto-commit. Throwing forces the caller to catch-and-inspect, which
is awkward. Returning a `kind: 'conflict'` variant follows the
established discriminated-union pattern of other `MergeResult` kinds
(`up-to-date` / `fast-forward` / `merge`). The existing
`mergeHasConflicts` error stays in the domain layer but is no longer
thrown from `merge` — it remains for primitives like `applyDelta`
that want to surface this code without the merge-state machinery.

ADR-026 captures the decision.

## 3. Behaviour

### 3.1 Per-conflict actions

For each `MergeConflict` returned by `mergeTrees`:

| Conflict type      | Working tree write                                                  | Index entries        |
|--------------------|---------------------------------------------------------------------|----------------------|
| `content`          | Write `writeConflictMarkers(...)` bytes at `path`                   | stage-1/2/3 (mode from each side) |
| `binary`           | Write `ours` bytes at `path` (matches `mergeContent`'s fallback)    | stage-1/2/3          |
| `add-add`          | Write `ours` bytes at `path` (preserve ours; theirs visible in idx) | stage-2/3 (no stage-1) |
| `modify-delete`    | Write the surviving side's bytes (whichever has id) at `path`       | stage-1/2 or stage-1/3 (omitted side absent) |
| `type-change`      | Write `ours` bytes (preserve current type)                          | stage-1/2/3          |
| `rename-rename`    | Out of scope for v1 — merge rejects with `unsupportedOperation`     | n/a                  |
| `gitlink`          | Out of scope for v1 — same                                          | n/a                  |

`rename-rename` and `gitlink` paths are rejected with
`unsupportedOperation` BEFORE any disk state is written; the merge
fails atomically and HEAD/index/working-tree are untouched.

### 3.2 Order of writes

The function performs a multi-step write whose ordering matters for
crash safety:

1. **Compute** all writes in memory (marker bytes for content
   conflicts, IndexEntry[] for stage-1/2/3, MERGE_MSG text).
2. **Acquire** `${gitDir}/index.lock` upfront — same pattern as
   `checkout` / `reset`.
3. **Write working-tree files** for conflicting paths under the lock
   (so an aborted process can't leave the index ahead of the working
   tree).
4. **Write `.git/ORIG_HEAD`** = pre-merge HEAD's ObjectId.
5. **Write `.git/MERGE_HEAD`** = target ObjectId.
6. **Write `.git/MERGE_MSG`** = the merge message draft.
7. **Commit the index** (stage-0 entries for clean paths +
   stage-1/2/3 entries for conflicting paths) via the lock.

If a crash occurs between any two of these:
- After (3) before (4): user has marker files but no MERGE_HEAD →
  treated as a fully-resolved working tree minus the merge state.
  The user can re-run merge (assertNoPendingOperation passes since
  MERGE_HEAD is absent) or manually clean up.
- After (4)/(5) before (7): MERGE_HEAD exists, index still reflects
  pre-merge HEAD. `assertNoPendingOperation` fires on the next
  mutation, surfacing the inconsistent state — user must `reset` or
  delete MERGE_HEAD.

The order is deliberately HEAD-data-first: the marker files and merge
state are written before the index, so the WORST-case crash leaves
the user with markers on disk and a clean (pre-merge) index — the
user can resolve manually and `git add` to recover. The BEST-case
sequence is all-or-nothing under the index lock.

ADR-027 captures the write-order choice.

### 3.3 MERGE_HEAD format

Single line: `<target-oid>\n`. Matches canonical git.

### 3.4 ORIG_HEAD format

Single line: `<pre-merge-oid>\n`. Matches canonical git.

### 3.5 MERGE_MSG format

The merge message draft is the same string we'd commit on a clean
merge: `opts.message ?? \`Merge ${opts.target}\``. Multi-line is
allowed; we don't append a "Conflicts:" block today (the unmerged
index entries already encode the same information, and the user
will normally rewrite the message before committing).

ADR-028 captures the MERGE_MSG content choice.

### 3.6 Working-tree file writes

Reuse `writeConflictMarkers` (already in `domain/merge`) for content
conflicts. The output's encoding matches `mergeContent`'s existing
contract (newline at end of file).

For non-content conflicts we materialise the surviving side's bytes
via `readBlob` (under the per-blob `maxBytes` cap). Files with mode
`FILE_MODE.EXECUTABLE` are written and then `chmod`'d. Symlinks and
gitlinks in a conflict context don't make sense for v1 (the matrix
above rejects them).

### 3.7 Index entry construction

`conflictsToIndexEntries` (already in `domain/diff/index-diff.ts`)
produces the stage-1/2/3 entries from `MergeConflict[]`. We pass a
`statFactory` that produces zero-filled stat data (the entries are
unmerged, so `status` ignores their stat cache anyway).

The clean-path entries come from `mergeTrees`'s `outcomes`: every
non-conflict outcome contributes a stage-0 entry. The combined
list is sorted by path then stage by `conflictsToIndexEntries`,
but our combined list needs a second sort pass to keep the stage-0
entries interleaved correctly. Implementation note: build a single
flat list of all entries (stage-0 from outcomes + stage-1/2/3 from
conflicts), then sort by `(path, stage)` once.

## 4. Module layout

```
src/application/commands/
├── merge.ts                            # extended: conflict branch
├── internal/
│   └── merge-state.ts                  # NEW — write MERGE_HEAD/MERGE_MSG/ORIG_HEAD
src/application/primitives/
└── (no new primitives — reuse readBlob, writeObject, acquireIndexLock)
src/domain/merge/
└── (no new domain types — MergeConflict / MergeOutcome cover the case)
test/unit/application/commands/
├── merge.test.ts                       # extended: conflict-result cases
└── merge-state.test.ts                 # NEW — file writers
```

### 4.1 Why a separate `merge-state.ts`?

Three reasons:
- Reuse: future `rebase` / `cherry-pick` will write the same files.
- Testability: a thin helper module is easier to unit-test in
  isolation than a chunk of `merge.ts`.
- Symmetry with `repo-state.ts` (which READS these markers).

## 5. Public API additions

The `MergeResult` discriminated union grows a `'conflict'` variant.
Existing callers that pattern-match on `kind` will get a TypeScript
error if they don't handle the new variant — by design. Existing
tests that throw `MERGE_HAS_CONFLICTS` will need to be updated to
inspect the return value. This is a breaking change at the type
level but not at the runtime level for callers that always
`catch` errors.

`MIGRATION.md` gets a note: callers should add a `case 'conflict':`
branch.

## 6. Testing strategy

### 6.1 Unit — `merge.test.ts` extension

Replace the existing "throws MERGE_HAS_CONFLICTS" tests with:

- "Given a content conflict, When merge runs, Then the working tree
  has marker bytes at the conflicting path".
- "Given a content conflict, When merge runs, Then the index has
  stage-1/2/3 entries for the conflicting path".
- "Given a content conflict, When merge runs, Then `.git/MERGE_HEAD`
  records the target's commit id".
- "Given a content conflict, When merge runs, Then `.git/MERGE_MSG`
  records the merge message".
- "Given a content conflict, When merge runs, Then `.git/ORIG_HEAD`
  records HEAD's pre-merge id".
- "Given a content conflict resolved by the user, When `add` +
  `commit` runs, Then a proper merge commit is created with
  parents=[ORIG_HEAD, MERGE_HEAD]".
- "Given an add-add conflict, When merge runs, Then ours is written
  to the working tree and stage-2/3 entries land in the index"
  (no stage-1 since the path has no common base).
- "Given a modify-delete conflict, When merge runs, Then the
  surviving side's bytes are in the working tree and stage-1/2
  or stage-1/3 entries are in the index".
- "Given a rename-rename or gitlink conflict, When merge runs, Then
  throws UNSUPPORTED_OPERATION before any disk write".
- "Given an existing MERGE_HEAD, When merge runs again, Then throws
  OPERATION_IN_PROGRESS (regression for assertNoPendingOperation)".

### 6.2 Unit — `merge-state.test.ts` (new)

Cover the three writers in isolation:

- writeMergeHead/MergeMsg/OrigHead happy path (file content matches
  expected format).
- Idempotent under repeated calls.
- Atomic: writes via `writeUtf8` (no partial-file states under
  test).

### 6.3 Integration regression

The "commit creates a merge commit" flow goes through `commit`'s
existing logic; we don't need new integration scaffolding —
verify the parents/tree fields are right.

### 6.4 Mutation

Stryker on `merge.ts` + `merge-state.ts`. Target: 0 new killable
survivors. Equivalent mutants documented inline.

## 7. Out of scope

- `git merge --abort`. The user can `reset --hard ORIG_HEAD` to
  abort today. A dedicated abort surface ships in a later phase.
- diff3-style conflict markers (writeConflictMarkers already rejects
  the option).
- `rename-rename` and `gitlink` conflict resolution. The matrix
  above rejects them with `unsupportedOperation`; full handling
  belongs in v2.
- Conflict-blob hashes for stage-1/2/3 are pre-existing blob ids
  from the trees being merged. We do NOT compute new ids for
  the marker-file content (that would defeat the purpose of the
  stage-cache).

## 8. Open questions

- **Q1: Should we write a "Conflicts:" trailer to MERGE_MSG?**
  Canonical git does. We don't, per §3.5. Adding it is trivial if
  the user demands; leaving it out keeps the message clean for
  the resolved-commit case (the user typically rewrites the
  message before committing).
- **Q2: Should `materializeTree`'s dirty-tree guard apply?** No —
  a conflicting merge writes markers, which by definition modify
  the working tree. The guard belongs to clean merges where the
  pre-existing working-tree state would be silently overwritten.

## 9. Self-review log

### Pass 1 → Pass 2

- Originally proposed throwing a NEW error variant carrying the
  merge state. Rejected: callers would need both `catch` AND
  `inspect data.something` to access the state. A return-value
  variant is cleaner.
- §3.1 matrix added — without it, "handle all conflict types"
  is too open-ended and Pass-2 reviewers will ask "what about
  rename-rename?". Explicit matrix locks scope.
- §3.2 ordering added — critical for crash safety; reviewers
  will probe the write order otherwise.

### Pass 2 → Pass 3

- §4.1 added — pass-3 reviewers tend to ask why we introduce a
  new helper module rather than inlining the writes in `merge.ts`.
  Document the reuse argument once.
- §6 expanded — the original test list was scoped to content
  conflicts; pass-2 review noted add-add and modify-delete need
  dedicated cases.
- §3.7 sort note added — without it, the index-entry combine step
  has a latent ordering bug (stage-0 + stage-1/2/3 must merge-sort,
  not concat).

### Pass 3 → final

- ADR-026 split out from this design: returning vs throwing is a
  user-influenced decision that warrants its own record.
- ADR-027 split out: write-order is a load-bearing crash-safety
  decision.
- ADR-028 split out: MERGE_MSG content choice (no Conflicts trailer)
  diverges from canonical git and deserves rationale.
