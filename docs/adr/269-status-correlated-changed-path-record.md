# ADR-269: `status` returns one correlated `ChangedPath` record per path, carrying its diff endpoints (endpoints only, no hunks)

## Status

Accepted (at `c1a6c014`)

## Context

The 23.4 API review's finding **M3**: `status` and `diff` return unrelated
shapes, so a consumer that wants "for this path, the staged change, the unstaged
change, and the actual hunks" must re-derive HEAD's tree, the index, and the
working file by hand. `status`'s `ChangeEntry { kind, path }` discards the diff
endpoints it already computes — the staged column builds a full `DiffChange`
(`oldId`/`newId`/`oldMode`/`newMode`) via `diffIndexAgainstTree` then keeps only
`kind`/`path`; the working column hashes the working file in
`compareWorkingTreeEntry` then collapses to a coarse enum.

23.2c (ADR-256) already made the **unmerged** column self-describing — each
`UnmergedEntry` carries its per-stage `base`/`ours`/`theirs` `{ id, mode }` blobs,
lossless against `git status --porcelain=v2`'s `u` line. The staged and
working-tree columns are the remaining gap.

`git status --porcelain=v2 --no-renames` models an ordinary changed path as one
line carrying both the staged (`X`) and unstaged (`Y`) state plus the three sides'
modes and the HEAD/index oids:
`1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>` (no worktree hash — the file need
not be in the object store). Untracked and unmerged paths are separate `?` and
`u` lines.

Two judgment calls, settled with the user:

1. **How should the staged + working columns carry their endpoints?**
   - **A.** Enrich the existing two columns (`indexChanges`/`workingTreeChanges`)
     with per-side blobs; keep them as separate arrays. Minimal; the staged↔
     unstaged correlation stays a by-path join the consumer performs.
   - **B.** One correlated record per path (porcelain v2 model): a single
     `changes: ChangedPath[]` array whose record carries `staged?`/`unstaged?`
     kinds and `head?`/`index?`/`worktree?` sides. Pre-correlates the two columns
     on one record; larger `StatusResult` restructure; closer to v2's line.

2. **Should `status` also materialise the hunks?**
   - **A.** Endpoints only — the caller materialises a `LineDiff` from the oids/
     path with one `readBlob` + `diffLines`.
   - **B.** A `withHunks` selector attaches a materialised `LineDiff` per change
     (like `diff`'s `withStat`), folding blob reads + Myers into `status`.

## Decision

**Decision 1 → option B: one correlated `ChangedPath` record per path.**
`StatusResult.changes: ReadonlyArray<ChangedPath>` replaces the separate
`indexChanges` / `workingTreeChanges` arrays. A `ChangedPath` carries `path`,
`staged?` / `unstaged?` (the X/Y `ChangeKind`s, at least one present), and the
`head?` / `index?` (`BlobSide = { id, mode }`) and `worktree?`
(`WorktreeSide = { mode }`, no oid) sides. It is the structured form of a
porcelain v2 ordinary line, so a consumer reconstructs the line directly and the
hunks for any path are one `readBlob` away.

Following git's category separation (and ADR-256's separate `unmerged` field),
the two *other* categories become their own fields rather than folding into
`changes`:

- **`untracked: ReadonlyArray<FilePath>`** — git's `?` lines. Bare paths (v2's `?`
  line carries no mode/oid). Keeps a path that is both staged-deleted and on-disk
  (`rm --cached` → git's `D ` + `??`) as two clean sources rather than one
  overloaded record. `ChangeKind` accordingly drops the `'untracked'` member.
- **`unmerged`** — unchanged (ADR-256).

`clean` is true iff `changes`, `untracked`, and `unmerged` are all empty.

`ConflictStage` is renamed to **`BlobSide`** and reused for `head`/`index` and
`base`/`ours`/`theirs` — one `{ id, mode }` endpoint type across the status
surface (it is also structurally the domain `FlatTreeEntry`).

**Decision 2 → option A: endpoints only, no `withHunks`.** `status` surfaces the
oids/modes; the caller materialises hunks (staged: `readBlob(head)` ↔
`readBlob(index)`; unstaged: `readBlob(index)` ↔ read working file by path). This
keeps `status` — a hot command — free of folded-in blob reads + Myers, and stays
faithful to porcelain v2 (which carries oids, not hunks). A `withHunks` selector
is addable additively later if a real consumer appears.

Every side is populated whenever it exists, independent of which axis flagged the
change (e.g. an unstaged-only modify still carries `head`, equal to `index`), so
each record reconstructs a v2 ordinary line directly. `head` comes from the
already-read HEAD `FlatTree`, `index` from the stage-0 index map, `worktree` from
the working comparator — the comparator is split into a richer
`compareWorkingTreeDelta` core (`{ status, worktreeMode? }`) with the existing
`compareWorkingTreeEntry` enum function as a one-line projection, so its four
enum-only consumers (`rm`, `stash`, `clean-work-tree`, `apply-merge-to-worktree`)
are untouched.

This restructure is breaking; the 23.4 window permits breaking changes without
release-bundling (ADR-260). It changes no git-observable behaviour — SHAs, refs,
reflogs, on-disk state, and refusals are identical; `describe --dirty/--broken`'s
verdict is preserved (its check simplifies to `changes.length > 0 ||
unmerged.length > 0`).

## Consequences

### Positive

- M3 closed: staged + unstaged state and the diff endpoints for a path live on
  one record; the hunks are directly retrievable. Symmetric with the
  already-self-describing `unmerged` column.
- Lossless against `git status --porcelain=v2` ordinary lines — pinned by a new v2
  reconstruction in the interop suite, alongside the retained v1 reconstruction.
- `status` stays cheap (no folded-in Myers); the endpoints are data already
  computed and previously discarded.
- `describe`'s dirty check and the working-tree comparator's four enum consumers
  simplify or stay untouched.

### Negative

- Larger, restructured public `StatusResult` (`changes`/`untracked` replace
  `indexChanges`/`workingTreeChanges`; new `ChangedPath`/`BlobSide`/`WorktreeSide`;
  `ChangeEntry`/`ConflictStage` removed). Breaking for callers reading the old
  columns.

### Neutral

- Untracked moves to a dedicated field; `ChangeKind` loses `'untracked'`.
- Full porcelain-v2 `u`-line reconstruction still needs the conflict path's
  worktree mode (`mW`) on `UnmergedEntry` — out of scope, logged as backlog
  **23.4m**.
- Read-model convergence (commands as projections over a unified model) remains
  the 23.4j capstone; this defines the v2-faithful `StatusResult` shape it will
  converge on without forcing the abstraction early.
