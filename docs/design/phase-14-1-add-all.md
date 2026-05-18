# Phase 14.1 — `add --all` (bulk mode walking the working tree)

## 1. Goal

Extend `repo.add` so callers can stage every changed/new tracked path
plus every untracked, non-ignored path in one call, without having to
pre-enumerate the working tree themselves.

BACKLOG §14.1 acceptance, verbatim:

> `repo.add({ all: true })` (or equivalent) walks the working tree,
> stages every modified/new tracked path and every untracked path that
> isn't ignored, and surfaces the staged set in the result.
> No pathspec arg required when `all: true`.
> Existing `repo.add(paths)` literal-path mode unchanged.

Scope is deliberately narrow:

- `.gitignore` evaluation is §14.3 — out of scope. §14.1 ships a stub
  predicate that returns `false` for every path (no ignores). The
  predicate is injected so §14.3 can drop a real implementation in
  later without touching the walk. See [ADR-029](../adr/029-add-all-ignore-stub.md).
- Pathspec globs are §14.2 — out of scope. `all: true` is the only new
  mode.
- The walk strategy is a new `walkWorkingTree` primitive (DFS via
  `FileSystem.readdir` + `lstat`), not a reuse of `walkTree` (which
  walks Git tree objects, semantically different).
  See [ADR-030](../adr/030-add-all-walk-strategy.md).
- Symlinks stage as mode `120000` (same as the literal-path mode);
  embedded `.git` directories (gitlinks/submodules) are skipped — they
  are not auto-staged. See [ADR-031](../adr/031-add-all-symlink-gitlink-policy.md).
- Large-file guard: per-file `stat.size > MAX_WORKING_TREE_BLOB_BYTES`
  aborts the walk with `WORKING_TREE_FILE_TOO_LARGE` carrying
  `path` + `size` + `limit`. See [ADR-032](../adr/032-add-all-large-file-guard.md).

This phase touches:

- `src/application/primitives/walk-working-tree.ts` (new primitive)
- `src/application/commands/add.ts` (bulk-mode dispatch)
- `src/application/commands/internal/working-tree.ts` (reuse path
  validator)
- `test/unit/application/primitives/walk-working-tree.test.ts` (new)
- `test/unit/application/commands/add.test.ts` (new bulk-mode tests)

## 2. Public surface

### 2.1 `AddOptions` extension

`AddOptions.all` is already declared on `add.ts` (line 25) but the
behaviour is "not yet implemented". §14.1 implements it.

```typescript
export interface AddOptions {
  readonly force?: boolean;
  readonly all?: boolean;            // NEW behaviour
  readonly breakStaleLockMs?: number;
}
```

### 2.2 Calling shapes

```typescript
// Literal-path mode (unchanged).
await repo.add(['src/foo.ts', 'src/bar.ts']);

// Bulk mode (new).
await repo.add([], { all: true });
```

`paths` MUST be `[]` (or any empty array — the existing
`emptyPathspec()` early-throw guards against accidentally mixing
literal paths with `all: true`). See §4.4 below for the contract.

### 2.3 `AddResult` (unchanged shape)

```typescript
export interface AddResult {
  readonly added: ReadonlyArray<FilePath>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly removed: ReadonlyArray<FilePath>;
}
```

`removed` will be non-empty in bulk mode when an index entry exists
but the working-tree file is gone (Git's "add --all" semantics: a
disappeared tracked file is removed from the index). The
literal-path mode already returns `removed: []` and is untouched.

## 3. Primitive: `walkWorkingTree`

### 3.1 Signature

```typescript
export interface WalkWorkingTreeOptions {
  readonly maxDepth?: number;          // default 4096
  readonly maxEntries?: number;        // default MAX_FLAT_TREE_ENTRIES (1_000_000)
}

export interface WalkWorkingTreeEntry {
  readonly path: FilePath;             // posix, relative to workDir, validated
  readonly stat: FileStat;             // lstat result (no symlink follow)
}

export async function* walkWorkingTree(
  ctx: Context,
  options?: WalkWorkingTreeOptions,
): AsyncIterable<WalkWorkingTreeEntry>;
```

Returns leaf entries only — directories are descended into, not
yielded. Mirrors `walkTree`'s leaf-only contract.

### 3.2 Traversal rules

1. Start at `ctx.layout.workDir`.
2. `readdir` returns `DirEntry[]`. Pre-scan the entry list for a
   `.git` child:
   - **If present:** the current directory is an embedded repo /
     submodule / nested clone — yield nothing inside it (skip both
     `.git` and every sibling). Matches Git's default of not
     descending into embedded working trees and avoids an extra
     `lstat` round trip.
   - **If absent:** iterate entries normally, skipping any entry
     whose name matches `.git` (case-insensitive, NTFS-trimmed —
     reuse `isForbiddenGitComponent` from `working-tree.ts`).
     Defence-in-depth: also run `validatePath` on the joined
     relative path; reject the walk with `PATHSPEC_OUTSIDE_REPO` if
     validation fails. `readdir` should never produce a `..`
     segment, but a malicious adapter could.
3. For each leaf:
   - `lstat` (no symlink follow). If `isFile || isSymbolicLink`,
     yield `{ path, stat }`.
   - If `isDirectory`, descend (after the .git-child gate above).
   - Any other type (block device, fifo, socket) is silently
     skipped — Git ignores them too.
4. Aborts: check `ctx.signal.aborted` at the top of every directory
   visit; throw `OPERATION_ABORTED` to unwind. Same pattern as
   `walkTree`.
5. Depth/entry caps: depth excess throws `TREE_DEPTH_EXCEEDED`; entry
   count excess throws `TREE_ENTRY_LIMIT_EXCEEDED`. Reuses the
   existing factories from `domain/objects/error.ts`.

### 3.3 Sort order

`readdir` makes no guarantee about order across platforms. The walk
yields entries in `readdir`-returned order; sorting is the caller's
job (`add --all` sorts before staging so the staged set is
deterministic and stable across runs).

### 3.4 Symlink policy

`lstat` (not `stat`) — never follow symlinks. A symlink leaf yields
`{ path, stat: { isSymbolicLink: true, ... } }`; the caller decides
what to do with it. A symlink **to a directory** is NOT descended
into; the symlink itself is a leaf.

### 3.5 Concurrency

The walk yields sequentially (per-directory `readdir` is sequential;
descent is depth-first). Concurrency is the caller's choice — the
caller can wrap the async iterable in a bounded fan-out (e.g.
`pMap(walkWorkingTree(ctx), staging, { concurrency: 32 })`). For
§14.1 the caller (`add --all`) processes entries sequentially because
the index lock + blob write order matters for predictable error
behaviour. A follow-up perf pass can introduce bounded parallel
staging once the synchronous semantics are pinned down.

## 4. Command: `add` bulk-mode behaviour

### 4.1 Dispatch

```typescript
export const add = async (
  ctx: Context,
  paths: ReadonlyArray<string>,
  opts: AddOptions = {},
): Promise<AddResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'add');
  await assertNoPendingOperation(ctx, { except: 'merge' });

  if (opts.all === true) {
    if (paths.length !== 0) throw invalidOption('all', 'pathspec must be empty when all=true');
    return addAll(ctx, opts);
  }

  if (paths.length === 0) throw emptyPathspec();
  return addLiteral(ctx, paths, opts);
};
```

Literal path stays identical to today's implementation — extracted
into `addLiteral` for clarity. Bulk path lives in `addAll`.

### 4.2 `addAll`

```typescript
const addAll = async (ctx: Context, opts: AddOptions): Promise<AddResult> => {
  const lock = await acquireIndexLock(
    ctx,
    opts.breakStaleLockMs !== undefined ? { breakStaleLockMs: opts.breakStaleLockMs } : {},
  );
  try {
    const existing = await readExistingEntries(ctx);
    const seen = new Set<FilePath>();
    const added: FilePath[] = [];
    const modified: FilePath[] = [];
    const removed: FilePath[] = [];
    const newEntries = new Map<FilePath, IndexEntry>(existing);

    for await (const { path, stat } of walkWorkingTree(ctx)) {
      // Mark presence BEFORE the ignore filter so §14.3 doesn't
      // spuriously drop tracked-but-ignored files (Git semantics:
      // an ignored tracked file stays tracked until explicit rm).
      seen.add(path);
      if (isIgnored(path, stat.isDirectory)) continue;             // ADR-029 stub: returns false
      if (stat.size > MAX_WORKING_TREE_BLOB_BYTES) {
        throw workingTreeFileTooLarge(path, stat.size, MAX_WORKING_TREE_BLOB_BYTES);
      }
      const entry = await stageFromStat(ctx, path, stat);
      newEntries.set(path, entry);
      const previous = existing.get(path);
      if (previous === undefined) added.push(path);
      else if (previous.id !== entry.id || previous.mode !== entry.mode) modified.push(path);
    }

    // Index-only files (tracked but no longer on disk) → removed.
    for (const [path] of existing) {
      if (!seen.has(path)) {
        newEntries.delete(path);
        removed.push(path);
      }
    }

    sortFilePaths(added);
    sortFilePaths(modified);
    sortFilePaths(removed);
    await lock.commit(Array.from(newEntries.values()));
    return { added, modified, removed };
  } finally {
    await lock.release();
  }
};
```

Notes:

- The index lock is acquired BEFORE the walk so a concurrent writer
  cannot stage entries we then over-/under-write. Matches the
  lock-first pattern Phase 13.5 introduced for checkout.
- `existing` is read once under the lock; the walk + diff happen
  against this single snapshot — no TOCTOU window between read and
  commit.
- `seen` is the set of paths the walk found AFTER the ignore filter.
  Anything in the prior index but not in `seen` is removed. Ignored
  paths that were previously tracked are NOT auto-removed — Git's
  behaviour matches (an ignored tracked file stays tracked until the
  user explicitly `rm`s it). Since the §14.1 ignore predicate always
  returns false, this distinction is moot for now but the code must
  not regress it once §14.3 lands.
- `stageFromStat` is the existing `stageOne` body without the
  outer `lstat`-then-undefined-check (we already have the stat from
  the walk). Refactor below.

### 4.3 `stageFromStat`

```typescript
const stageFromStat = async (
  ctx: Context,
  path: FilePath,
  stat: FileStat,
): Promise<IndexEntry> => {
  const mode: FileMode = stat.isSymbolicLink
    ? '120000'
    : (stat.mode & 0o111) !== 0 ? '100755' : '100644';
  const bytes = stat.isSymbolicLink
    ? new TextEncoder().encode(await ctx.fs.readlink(`${ctx.layout.workDir}/${path}`))
    : await readFile(ctx, path);
  const id = (await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: bytes,
  })) as ObjectId;
  return makeEntry(stat, mode, id, path);
};
```

`stageOne` is rewritten in terms of `stageFromStat`:

```typescript
const stageOne = async (ctx: Context, path: FilePath): Promise<IndexEntry | 'missing'> => {
  const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/${path}`).catch(() => undefined);
  if (stat === undefined) return 'missing';
  return stageFromStat(ctx, path, stat);
};
```

### 4.4 Error contract

| Condition                                        | Error                        |
| ------------------------------------------------ | ---------------------------- |
| `all: true` + non-empty pathspec                 | `INVALID_OPTION` (option=`all`) |
| `all: true` + working tree leaf > cap            | `WORKING_TREE_FILE_TOO_LARGE` |
| `all: true` + dir traversal depth > 4096         | `TREE_DEPTH_EXCEEDED`         |
| `all: true` + entry count > 1_000_000            | `TREE_ENTRY_LIMIT_EXCEEDED`   |
| `all: true` + abort signal                       | `OPERATION_ABORTED`           |
| `all: true` + concurrent stale index lock        | propagates from `acquireIndexLock` |
| `all: false` (default) — every existing contract | unchanged                     |

Pending operations: `assertNoPendingOperation(ctx, { except: 'merge' })`
still applies. Conflict-resolution staging via `add --all` works the
same way as today's `add <path>` during a conflicted merge.

### 4.5 Constants

```typescript
// In src/application/primitives/types.ts:
/** Per-file size cap for working-tree → index blob writes (256 MiB).
 *  Mirrors MAX_CONFLICT_OUTPUT_BYTES — same memory-pressure ceiling. */
export const MAX_WORKING_TREE_BLOB_BYTES = 256 * 1024 * 1024;
```

A new path-shaped error variant is introduced rather than reusing
`OBJECT_TOO_LARGE` — the failure fires BEFORE the blob is hashed, so
there is no id to put in the error payload. See [ADR-032](../adr/032-add-all-large-file-guard.md)
for the rationale.

```typescript
// src/domain/commands/error.ts (new CommandError variant):
| {
    readonly code: 'WORKING_TREE_FILE_TOO_LARGE';
    readonly path: FilePath;
    readonly size: number;
    readonly limit: number;
  }

export const workingTreeFileTooLarge = (
  path: FilePath,
  size: number,
  limit: number,
): TsgitError =>
  new TsgitError({ code: 'WORKING_TREE_FILE_TOO_LARGE', path, size, limit });
```

A matching arm is added to `extractDetail` in `domain/error.ts`.

## 5. Ignore predicate (§14.3 seam)

```typescript
// src/application/commands/internal/add-ignore.ts
export type IgnorePredicate = (path: FilePath, isDirectory: boolean) => boolean;

/** §14.1 stub: nothing is ignored. Replaced in §14.3. */
export const defaultIgnorePredicate: IgnorePredicate = () => false;
```

`addAll` accepts `ignore?: IgnorePredicate` internally and defaults
to the stub. Tests inject a real predicate; §14.3 will swap the
default. This is the seam ADR-029 documents.

## 6. Testing strategy

### 6.1 Unit — `walk-working-tree.test.ts`

Each test follows Given/When/Then with `sut` and AAA bodies.

1. Given empty working tree, When walk, Then yields nothing.
2. Given two files at the root, When walk, Then yields both.
3. Given nested directories, When walk, Then DFS-yields every leaf.
4. Given a `.git` directory at the root, When walk, Then skips it.
5. Given a nested `.git` directory (embedded repo), When walk, Then
   skips the WHOLE embedded directory.
6. Given a `.GIT` (uppercase) directory, When walk, Then skips it
   (case-insensitive match).
7. Given a `.git ` (trailing space) directory, When walk, Then skips
   it (NTFS hardening).
8. Given a symlink leaf, When walk, Then yields with
   `isSymbolicLink: true`.
9. Given a symlink-to-directory, When walk, Then yields the symlink
   itself (no descent).
10. Given an already-aborted `ctx.signal`, When walk, Then throws
    `OPERATION_ABORTED`.
11. Given depth > maxDepth, When walk, Then throws
    `TREE_DEPTH_EXCEEDED`.
12. Given entries > maxEntries, When walk, Then throws
    `TREE_ENTRY_LIMIT_EXCEEDED`.
13. Given a directory entry whose joined path fails validation, When
    walk, Then throws `PATHSPEC_OUTSIDE_REPO` (defence-in-depth).

### 6.2 Unit — `add.test.ts` (new bulk-mode block)

Each test follows Given/When/Then with `sut` and AAA bodies.

14. Given `all: true` + non-empty paths, When add, Then throws
    `INVALID_OPTION` with `option=all`.
15. Given empty working tree + empty index, When `add({ all: true })`,
    Then returns `{ added: [], modified: [], removed: [] }`.
16. Given two untracked files, When `add({ all: true })`, Then
    `added` contains both in sorted order, index has both entries.
17. Given two tracked files + one modified, When `add({ all: true })`,
    Then `modified` contains the changed file only.
18. Given a tracked file deleted from disk, When `add({ all: true })`,
    Then `removed` contains it AND the index entry is dropped.
19. Given a symlink + a regular file, When `add({ all: true })`, Then
    the symlink stages as mode `120000`.
20. Given an executable file, When `add({ all: true })`, Then mode
    `100755` is recorded.
21. Given a `.git` directory at the root, When `add({ all: true })`,
    Then it is not staged.
22. Given an embedded `.git` subdirectory (nested repo), When
    `add({ all: true })`, Then the embedded contents are not staged
    AND no `160000` gitlink is created for the parent — the parent
    dir is just silently skipped.
23. Given a file > `MAX_WORKING_TREE_BLOB_BYTES`, When
    `add({ all: true })`, Then throws `WORKING_TREE_FILE_TOO_LARGE`
    carrying `path`, `size`, and `limit`, AND no partial index
    commit occurs (release-without-commit on throw).
24. Given a working tree containing `.git/MERGE_HEAD`, When
    `add({ all: true })`, Then succeeds (merge is excepted from the
    pending-operation gate — same as literal-path mode).
25. Given a working tree during a rebase, When `add({ all: true })`,
    Then throws `OPERATION_IN_PROGRESS`.
26. Given a custom `ignore` predicate that excludes `node_modules/*`,
    When `addAll` is called directly (internal test) Then those
    paths are skipped. (Wires the §14.3 seam.)
27. Given `ctx.signal` aborted mid-walk, When
    `add({ all: true })`, Then throws `OPERATION_ABORTED` and the
    lock is released.

### 6.3 Integration

A test that creates a real (memory-adapter) repo, scribbles a tree of
files, calls `add({ all: true })`, then re-reads `.git/index` via
`readIndex` and checks entry-count + path order. Goes under
`test/integration/`.

### 6.4 Mutation-resistance

Each error-throwing test uses `try`/`catch` + `data` assertions per
CLAUDE.md ("Prefer try/catch over toThrow for data assertions"). Each
guard (e.g. `all === true && paths.length !== 0`) gets its own
isolated test — see CLAUDE.md "Guard clauses need isolated tests".

## 7. Module structure

```
src/application/primitives/
  walk-working-tree.ts             NEW
src/application/commands/
  add.ts                           MODIFIED (dispatch + addAll + refactor stageOne)
  internal/add-ignore.ts           NEW (IgnorePredicate + stub)
src/application/primitives/types.ts MODIFIED (MAX_WORKING_TREE_BLOB_BYTES export)
src/application/primitives/index.ts MODIFIED (barrel: walkWorkingTree)
```

`walkWorkingTree` is exposed at the primitives barrel (and at
`repo.primitives.walkWorkingTree`) so library users can build their
own walks. Backlog §14.2 (pathspec globs) will compose against it.

## 8. Non-goals

- Per-line / per-hunk staging (`add -p`) — never planned for v1.
- Stat-cache fast path during the walk — `add --all` reads every
  blob unconditionally for §14.1. Phase 11 stat-cache work is
  separate.
- `add --update` (only re-stage tracked files; skip untracked) —
  out of scope for §14.1; revisit when §14.2 globs land if there's
  demand.

## 9. Acceptance checklist

- [ ] `repo.add([], { all: true })` walks the working tree.
- [ ] Modified tracked files appear in `result.modified`.
- [ ] New (previously untracked) files appear in `result.added`.
- [ ] Tracked files missing from disk appear in `result.removed` AND
      are dropped from the index.
- [ ] `.git` (and case/NTFS variants) is skipped.
- [ ] Embedded repos (nested `.git`) are not auto-staged.
- [ ] Symlinks stage as mode `120000`; bytes = link target.
- [ ] Files over the size cap throw `WORKING_TREE_FILE_TOO_LARGE`
      with no partial commit.
- [ ] Existing literal-path mode contract is byte-identical to
      pre-§14.1.
- [ ] Pending-operation gating still applies; merge is excepted.
- [ ] All new code has tests; coverage remains 100% on lines /
      branches / functions / statements.
- [ ] Stryker mutation score does not drop on touched files.
