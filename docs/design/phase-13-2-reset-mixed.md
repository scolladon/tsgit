# Phase 13.2 — `reset --mixed`

## 1. Goal

Make `repo.reset({ mode: 'mixed', target })` rebuild the index from
the target commit's tree (per canonical git's mixed-reset semantics)
**without** touching the working tree. Today the command only moves
HEAD; the index keeps its previous content, which silently breaks
the next `status` / `add` / `commit` cycle until the user re-stages.

BACKLOG §13.2 acceptance:

> `reset --mixed`: clear index entries beyond the lock-release stub.

Read between the lines: "clear" really means "replace with the
target tree's projection" — `git reset --mixed <oid>` makes the
index equal to `<oid>`'s tree. The current `reset.ts` already moves
HEAD; the missing piece is the index rewrite.

## 2. Surface

### 2.1 Existing (preserved)

```ts
export type ResetMode = 'soft' | 'mixed' | 'hard';

export interface ResetOptions {
  readonly mode: ResetMode;
  readonly target: string;
}

export interface ResetResult {
  readonly mode: ResetMode;
  readonly id: ObjectId;
  readonly branch: RefName | undefined;
}

export const reset: (ctx: Context, opts: ResetOptions) => Promise<ResetResult>;
```

No public shape change in v1.x — `mode: 'mixed'` was already
exported. Adding the missing side effect is internal.

### 2.2 New primitive

```ts
// src/application/primitives/build-index-from-tree.ts
export const buildIndexFromTree = async (
  ctx: Context,
  opts: BuildIndexFromTreeOpts,
): Promise<ReadonlyArray<IndexEntry>>;

export interface BuildIndexFromTreeOpts {
  /** Root tree of the target commit. */
  readonly targetTree: ObjectId;
  /** Pre-reset index — stat-cache donor for unchanged entries. */
  readonly currentIndex: GitIndex;
}
```

Returns a fresh, sorted `IndexEntry[]` ready for
`acquireIndexLock(...).commit(entries)`. The primitive is **pure
in its `fs.read` discipline**: it never touches the working tree.

## 3. Behaviour

### 3.1 The reset --mixed flow

1. `assertRepository` + `assertNoPendingOperation` (already there).
2. Resolve `target` to an `ObjectId` (already there).
3. **NEW**: read the target commit, read its tree, walk the tree.
4. **NEW**: read the current index.
5. **NEW**: build a new stage-0 index entry list:
   - For each `{ path, mode, id }` from the target tree (skip
     `FILE_MODE.DIRECTORY`):
     - If the current index has an entry at the same path with the
       same `id` and the same `mode` → **clone it** (preserve all
       stat-cache fields, including ctime/mtime/dev/ino/uid/gid/size).
     - Else → **synthesise** a new entry with `id`/`mode` from the
       tree and zero-valued stat fields. Stage 0, no flags. The next
       `status` call will see the zero stats, fall through to the
       hash path, and produce the correct answer. Canonical git
       does the same after `reset` — `git status` is slow on the
       first call, fast afterwards.
6. **NEW**: sort the merged list by path (the index format requires
   ascending byte order).
7. **NEW**: `acquireIndexLock` → `commit(entries)` → `release` (in a
   `finally`, matching the Phase 13.1 pattern).
8. Move HEAD to the resolved oid (already there — soft path is
   reused).
9. Return `{ mode, id, branch }`.

### 3.2 Bare-repo guard for `mode: 'mixed'`

Today `reset --mixed` doesn't call `assertNotBare`. Adding the index
rewrite means we touch `.git/index`, which is valid in a bare repo
too (a bare repo can have an index in theory, though it's
unusual). Decision: **don't** add a bare-repo guard. A bare repo
that runs `reset --mixed` rebuilds `.git/index` — same semantics as
canonical git.

Caveat: `assertNoPendingOperation` already gates this (a bare repo
in the middle of a merge would still throw). No new error code.

### 3.3 Soft mode (unchanged)

`mode: 'soft'` keeps its current behaviour: HEAD-only, no index
touch.

### 3.4 Hard mode (out of scope — Phase 13.3)

`mode: 'hard'` keeps its current behaviour in this phase: HEAD-only.
Phase 13.3 will compose `buildIndexFromTree` with `materializeTree`
to add the working-tree write — but the primitive landing in this
phase is the building block that makes Phase 13.3 a small composer
on top.

### 3.5 Untracked files

`reset --mixed` is **never** concerned with untracked files. The
working tree is not touched; untracked files remain untracked
across the reset, period. No new error code, no guard needed.

### 3.6 Pathspec (mixed-reset path scoping)

Canonical git supports `git reset --mixed <commit> -- <pathspec>`
to scope the index rewrite to specific paths only. Phase 13.2
**does not** add pathspec support — the API stays `{ mode, target }`.
Adding pathspec is captured as Phase 14.2 (pathspec globs). See
ADR-022 for the rationale.

## 4. Atomicity model

Same as Phase 13.1 §4 for the index half:

- Index commit is atomic (`acquireIndexLock` writes `index.lock`
  via `writeExclusive`, then renames over `index`). Crash leaves
  either the old index or the new index — never a partial.
- HEAD update is atomic (existing `updateRef` / `writeUtf8`).
- The order is **index commit → HEAD update**. A crash between the
  two leaves the index ahead of HEAD; canonical git has the same
  hazard and lets the user re-run `reset`. We accept it.

No cross-step rollback. The user re-runs `reset --mixed` on the
same target — idempotent.

## 5. Module layout

```
src/application/
├── commands/
│   └── reset.ts                              # extended: dispatch on mode, call buildIndexFromTree
├── primitives/
│   ├── build-index-from-tree.ts              # NEW — pure-ish: walkTree → IndexEntry[]
│   └── index.ts                              # NEW barrel export
test/unit/application/
├── commands/reset.test.ts                    # extended: index assertions
└── primitives/build-index-from-tree.test.ts  # NEW
```

## 6. Testing strategy

### 6.1 Unit — `buildIndexFromTree`

Memory adapter. Build a small tree fixture (two blobs, one nested
directory) plus a seed index, call the primitive, assert:

- The returned list has one entry per **file** in the tree (zero
  entries for `FILE_MODE.DIRECTORY`, which `walkTree` skips at the
  composition layer).
- Paths come out in sorted order.
- For an entry that exists in the seed index with the same `id` +
  `mode` → all stat-cache fields are preserved byte-for-byte.
- For an entry that's new (or whose `id` differs) → stat-cache
  fields are zero, `flags.stage` is 0, `flags.extended`/`assumeValid`
  are false.
- For an entry that was in the seed index but absent from the
  target tree → it is **not** in the result.
- Stage-0-only: a seed index containing stage-1/2/3 entries is
  ignored (mixed reset wipes the unmerged state).

### 6.2 Unit — `reset.test.ts` (extended)

Re-use the existing `seedTwoCommits` helper plus a couple of new
ones:

- **Given mixed reset to parent, When reset, Then index matches
  parent's tree**: add a second file in commit-2, reset --mixed to
  commit-1 → re-read the index → the new file's index entry is
  gone; the old file's entry is present with the commit-1 blob id.
- **Given mixed reset, When reset, Then working tree is
  untouched**: assert both files still exist on disk with the
  commit-2 content.
- **Given mixed reset with stat-cache donor, When reset, Then
  unchanged-path stat fields are preserved**: write a file, add,
  commit, reset --mixed to the same commit → the index entry's
  stat fields equal the pre-reset entry's stat fields (no fresh
  zero stats).
- **Given mixed reset on a bare repo, When reset, Then succeeds**:
  bare repos accept index writes; we don't throw `BARE_REPOSITORY`
  for mixed mode.

### 6.3 Mutation

Stryker on `src/application/primitives/build-index-from-tree.ts`
and `src/application/commands/reset.ts`. Target: 0 new survivors.
The primitive is small and pure-ish; mutation coverage should be
straightforward.

### 6.4 Integration

No new integration test in this phase. The existing reset unit
tests + memory-adapter cover the surface; Phase 13.3 will add the
hard-reset integration which exercises the same primitive at the
filesystem level.

## 7. Out of scope (recorded)

- Pathspec scoping (`reset --mixed -- <pathspec>`). Deferred to
  Phase 14.2. See ADR-022.
- `reset --hard`'s working-tree write. Deferred to Phase 13.3.
- `reset --keep` / `reset --merge`. Not part of v1 surface.
- Reflog entries for the HEAD move. Deferred to Phase 17.1.
- Index-restoration optimisation (skip the rewrite when the
  current index is already byte-identical to the target tree).
  Deferred — adds complexity for a corner-case speedup.

## 8. Open questions

- **Q1: Why preserve stat-cache for unchanged paths?** Because
  `status` short-circuits on `isStatClean` — losing the cache means
  the next `status` re-hashes every file. Canonical git preserves
  the cache; matching it keeps benchmark parity.
- **Q2: What if the target tree contains a path that's currently a
  directory in the working tree?** Working tree is not touched —
  the index gets the new entry, `status` will then report the
  working tree dirty until the user runs `checkout` / `reset --hard`.
  Matches canonical git.
- **Q3: What if the index has unmerged entries (stage > 0)?** Mixed
  reset clears them — that's the point of `git reset` after a
  failed merge. The primitive's stage-0-only projection handles it
  implicitly: stage-1/2/3 entries are never matched as
  "stat-cache donors", and the new index only has stage-0 entries.

## 9. Self-review log

### Pass 1 → Pass 2 diffs

- Originally proposed reading the working-tree lstat for each
  rebuilt entry. Killed: that's `checkout --hard` semantics, not
  `reset --mixed`. Replaced with stat-cache-donor strategy (clone
  from prior index when `id+mode` match; zero stats otherwise).
- Originally proposed adding a `BARE_REPOSITORY` guard for mixed
  mode. Killed: bare repos can have an index, canonical git lets
  this through.
- Clarified §3.5: untracked files are categorically untouched —
  no need to enumerate them or guard against them.

### Pass 2 → Pass 3 diffs

- Renamed the new primitive from `rebuildIndex` to
  `buildIndexFromTree`. The verb "rebuild" implies "from
  somewhere" — being explicit (`fromTree`) matches the
  Phase-13.1 naming pattern (`materializeTree`, `applyChangeset`).
- Added §3.6 explicitly stating pathspec is out of scope, with an
  ADR pointer. Reviewers will ask; cheaper to fence it off in the
  design.
- §6.1 added the stage-1/2/3 ignore assertion — this is the
  mutation-bait case. Without an explicit test, a future
  refactor could drop the stage-0 filter unnoticed.

### Pass 3 → Pass 4 diffs (final pass)

- §4 reordered: now states **index → HEAD** explicitly. Phase 13.1
  used **working-tree → index → HEAD**; reset --mixed has no
  working-tree step, but the index-before-HEAD invariant must be
  preserved for the same crash-recovery reason.
- §3.1 step 5: clarified that the donor match is `id+mode`, not
  just `id`. A path that changed mode (regular → executable) at
  the same `id` should NOT donate stat-cache — the mode delta is
  exactly what mixed reset should reflect.
