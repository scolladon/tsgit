# Phase 13.1 — `checkout:materialize`

## 1. Goal

Make `repo.checkout({ target })` actually update the working tree (and
the index) so that immediately after checkout, the working tree is
byte-identical to canonical git's output for the same target, and the
next `repo.status()` returns `clean: true`.

Today `checkout` only moves HEAD; the index and working tree are
untouched. The README acknowledges this gap: _"Working-tree
materialization (`checkout`) lands in v1.x"_.

BACKLOG §13.1 acceptance:

> branch switch + path-checkout both leave the working tree
> byte-identical to canonical git, with line-ending + executable-bit
> fidelity. Progress tick per file.

## 2. Surface

### 2.1 Existing (preserved)

```ts
interface CheckoutOptions {
  readonly target: string;
  readonly detach?: boolean;
  readonly force?: boolean;
}

interface CheckoutResult {
  readonly branch: RefName | undefined;
  readonly id: ObjectId;
  readonly detached: boolean;
}
```

### 2.2 Extended

```ts
type CheckoutOptions =
  | CheckoutSwitchOptions      // branch switch (default; backwards-compatible)
  | CheckoutPathsOptions;      // path-restore from index or tree

interface CheckoutSwitchOptions {
  readonly target: string;
  readonly detach?: boolean;
  readonly force?: boolean;
}

interface CheckoutPathsOptions {
  readonly paths: ReadonlyArray<string>;
  /** Source of truth for the restore. Default `'index'`. */
  readonly source?: 'index' | 'HEAD' | ObjectId;
}

interface CheckoutResult {
  readonly branch: RefName | undefined;
  readonly id: ObjectId;
  readonly detached: boolean;
  /** Number of working-tree entries written/updated/removed. */
  readonly changedPaths: number;
}
```

Backwards compat: any caller passing `{ target, ... }` keeps working —
the discriminator is the presence of `paths`. No existing test breaks.

### 2.3 New primitive

```ts
// src/application/primitives/materialize-tree.ts
export const materializeTree = async (
  ctx: Context,
  opts: MaterializeTreeOpts,
): Promise<MaterializeTreeResult>;

interface MaterializeTreeOpts {
  readonly targetTree: ObjectId;        // root tree of the target
  readonly currentIndex: GitIndex;      // pre-checkout index (the "from" side)
  readonly force?: boolean;             // ignore dirty-tree guard
  readonly paths?: ReadonlySet<string>; // null = whole-tree; non-null = path-restore
}

interface MaterializeTreeResult {
  readonly newIndexEntries: ReadonlyArray<IndexEntry>;
  readonly written: number;
  readonly deleted: number;
}
```

The primitive is composable: `repo.reset({ kind: 'hard' })` in Phase
13.3 reuses it.

## 3. Behaviour

### 3.1 Branch switch (no `paths`)

1. Resolve `target` to an ObjectId (existing logic).
2. Read the current index (the "from" side).
3. Read the target commit's tree.
4. Walk the target tree, enumerate every entry into a map
   `path → { id, mode }`.
5. Compute the **change set**:
   - **add**: in target tree, not in current index
   - **update**: in both, but content/mode differs
   - **delete**: in current index, not in target tree
   - **noop**: in both, same content + mode
6. **Dirty-tree guard** (when `!force`):
   - For every `delete` and `update`: lstat the working-tree file;
     compare against the current index's stat cache via `isStatClean`.
     If stat-clean → safe. If stat-dirty → hash blob, compare to
     index's recorded oid. If oids differ → throw
     `WORKTREE_DIRTY` with the offending path.
   - Skips the slow path when stat-clean (matches git's stat-cache
     optimisation already used by `status`).
7. **Apply** (atomic per file, no cross-file rollback):
   - For each `delete`: `fs.rm(path)`. Then walk up parents and
     `fs.rm(emptyDir)` opportunistically.
   - For each `add`/`update`:
     - Regular/executable file: `readBlob(id) → fs.write(path, content)`
       then `fs.chmod(path, mode === EXEC ? 0o755 : 0o644)`.
     - Symlink: `readBlob(id) → fs.symlink(content as target, path)`.
     - Gitlink: `fs.mkdir(path)` (empty placeholder dir; submodule
       contents are out of scope for v1).
   - Emit `progress.update('checkout:materialize', { path, written: N })`
     per file.
8. **Update the index**: re-stat every written file (or read from
   the cached stat we already have) and build new `IndexEntry`
   records. Acquire `index.lock` via `acquireIndexLock`, commit new
   entries, release.
9. **Move HEAD** (existing logic from current `checkout.ts`).
10. Return `{ branch, id, detached, changedPaths: written + deleted }`.

### 3.2 Path-checkout (`paths` set)

1. Resolve `source`: `'index'` → read current index; `'HEAD'` → read
   HEAD's tree; ObjectId → treat as tree/commit oid.
2. For each `path` in `paths`:
   - Find the entry in `source`. If absent → throw
     `PATHSPEC_NOT_FOUND` with the offending path.
   - Always overwrite (path-checkout is the explicit-restore
     operation; `force` is implicit).
   - Apply the same per-file write logic from §3.1 step 7.
3. The index is **not** updated by path-checkout when `source ===
   'index'` (the index already matches). When `source !== 'index'`,
   update the index entries for the touched paths.
4. HEAD is **not** moved.
5. Return `{ branch: <unchanged>, id: <HEAD oid>, detached: <unchanged>, changedPaths }`.

### 3.3 Untracked-file handling

Untracked files (present in working tree, absent from current index)
are **left alone** during switch:

- If `path` is also absent from the target tree → unchanged. The
  untracked file persists across the checkout.
- If `path` IS in the target tree → **collision**. Canonical git
  refuses with _"untracked working tree files would be overwritten"_.
  Without `force` we throw `WORKTREE_UNTRACKED_OVERWRITE` with the
  paths. With `force` we overwrite (matches `git checkout --force`).

The untracked check is bounded: we only `lstat` paths that are in the
target tree but not in the index — i.e. would-be-overwritten paths.
We do **not** walk the working tree to enumerate every untracked
file (that would be O(working tree size) work for no benefit).

### 3.4 Dirty-tree errors

Two new `TsgitError` discriminants:

```ts
{
  code: 'WORKTREE_DIRTY',
  paths: ReadonlyArray<FilePath>,         // tracked files with local mods
}

{
  code: 'WORKTREE_UNTRACKED_OVERWRITE',
  paths: ReadonlyArray<FilePath>,         // untracked files that target tree would clobber
}
```

Reasoning: a single error carries the list of all dirty paths so the
caller can show them in one go. Reuses the existing `TsgitError`
union extension pattern.

A separate code for path-checkout misses:

```ts
{
  code: 'PATHSPEC_NOT_FOUND',
  pathspec: string,
}
```

## 4. Atomicity model (see ADR-018)

- **Per file**: `fs.write` is atomic on POSIX (we already write via
  tmp + rename in `acquireIndexLock`'s `commit`). For working-tree
  files, we use `fs.write` directly — Node's `writeFile` is not
  atomic by default. We accept this: matches git's behaviour, where
  a crashed checkout can leave a half-written file. Recovery is a
  re-checkout.
- **Cross-file**: no rollback on partial failure. If the dirty-tree
  guard succeeds but a downstream `readBlob` fails (corrupted
  object), files already written stay; we throw and let the caller
  inspect.
- **Index update**: atomic via `acquireIndexLock` (writes
  `index.lock` then renames over `index`). The index is committed
  **after** all working-tree writes succeed. Pre-existing
  invariant: the index is never partially committed.
- **HEAD update**: after index commit, via `writeSymbolicRef` or
  `writeUtf8('HEAD')` (existing atomic-write semantics).

The ordering is: working-tree writes → index commit → HEAD update.
A crash between steps leaves a recoverable state:
- crash during working-tree: index + HEAD still point at old tree,
  next `status` flags the half-written files, user re-checkouts.
- crash during index commit: `acquireIndexLock` cleans up
  `index.lock` on next acquire.
- crash during HEAD update: HEAD lock semantics already handle this
  (existing primitive).

## 5. Module layout

```
src/application/
├── commands/
│   └── checkout.ts                 # extended: dispatch switch vs paths, call materializeTree
├── primitives/
│   ├── materialize-tree.ts         # NEW — the workhorse
│   ├── compute-changeset.ts        # NEW — pure: index + targetTree → changeset
│   └── apply-changeset.ts          # NEW — impure: changeset → fs writes (+ progress)
src/domain/
├── errors/                          # extended: WORKTREE_DIRTY, PATHSPEC_NOT_FOUND
test/unit/application/
├── commands/checkout.test.ts        # extended: working-tree + index assertions
├── primitives/materialize-tree.test.ts          # NEW
├── primitives/compute-changeset.test.ts         # NEW
└── primitives/apply-changeset.test.ts           # NEW
test/integration/
└── checkout-materialize.test.ts     # NEW — branch switch against a real fixture
```

## 6. Testing strategy

- **Unit**: `compute-changeset` is pure; covered by table-driven tests
  for every kind tuple (add/update/delete/noop, regular/exec/symlink/
  gitlink, dirty/clean). Mutation target: 100%.
- **Unit**: `apply-changeset` uses the memory adapter. Verifies file
  bytes, file modes (where the adapter records them), symlink target,
  per-path progress ticks.
- **Unit**: `materialize-tree` integrates the two; uses the memory
  adapter to assemble a small repo + index + target tree.
- **Integration**: `checkout-materialize.test.ts` against the clone
  fixture (`test/fixtures/clone-source/source.git`). Clone → checkout
  to each of the 5 commits → assert working tree matches `git
  diff-tree --no-commit-id --name-status` output.
- **Property-based**: not in this phase (deferred).

## 7. Out of scope (recorded for the next phase)

- Sparse checkout (Phase 17.3).
- `.gitattributes`-driven smudge/clean filters.
- CRLF line-ending conversion (`core.autocrlf`). The blob is written
  byte-for-byte; on Windows the file content is whatever git stored.
  Full Windows fidelity is Phase 14.4.
- Submodule recursion. Gitlinks become empty placeholder dirs only.
- Two-tree merge during checkout (preserve local untracked
  modifications across switch). v1 dirty-tree guard either rejects
  with `WORKTREE_DIRTY` or, with `force`, overwrites.

## 8. Open questions

- **Q1: Concurrent runs.** Two `repo.checkout` calls on the same repo
  race on the working tree. v1 answer: the same way two `git checkout`
  invocations race in a real terminal — undefined behaviour, recover
  with re-checkout. `acquireIndexLock` prevents index corruption.
- **Q2: Empty directories.** Git never tracks empty directories.
  Phase 13.1 follows suit — if a target tree has no entries under
  `subdir/`, we delete `subdir/`. If a subdir starts empty in the
  working tree but is not in the target tree, it stays.
- **Q3: Permission bits beyond exec.** Git's mode only encodes
  executable vs not. We set `0o755` or `0o644`; we don't preserve
  other Unix bits. Group/world readability follows umask.

## 9. Self-review log

### Pass 1 → Pass 2 diffs

- Originally proposed a single `materialize-tree.ts` doing everything.
  Split into pure `compute-changeset` + impure `apply-changeset` so
  the changeset can be unit-tested without an FS.
- Added the dirty-tree guard's stat-cache fast path (matches existing
  `status` semantics — without it, every checkout would re-hash every
  blob).
- Added the ordering rationale (working-tree → index → HEAD) to §4.

### Pass 2 → Pass 3 diffs

- Changed the index entry's stat data source: originally proposed
  `fs.stat` after the write. Reuse the stat from the post-write
  syscall to avoid a redundant round-trip (FS stat is one of the
  hottest paths in `status`).
- Added §7 to fence off out-of-scope features that reviewers might
  ask about (sparse, autocrlf, smudge filters, submodules).
- Clarified §3.2: when `source === 'index'`, the index is unchanged.
  When `source !== 'index'`, only the touched paths' entries are
  rewritten — not the whole index.
