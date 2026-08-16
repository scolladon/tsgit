# `walkWorkingTree`

`AsyncIterable<WalkWorkingTreeEntry>` walker. DFS through `FileSystem.readdir`, lazily `lstat`ing a leaf only when a consumer reads its stat. Skips `.git`, embedded clones, and ignored directories (when an `ignore` predicate is supplied).

## Signature

```ts
repo.primitives.walkWorkingTree(
  options?: WalkWorkingTreeOptions,
): AsyncIterable<WalkWorkingTreeEntry>;

interface WalkWorkingTreeOptions {
  readonly maxDepth?: number;     // default core.maxTreeDepth (2048 when unset), honoured unclamped
  readonly maxEntries?: number;   // default MAX_FLAT_TREE_ENTRIES
  readonly ignore?: WalkIgnorePredicate;
}

type WalkIgnorePredicate = (
  path: FilePath,
  isDirectory: boolean,
) => boolean | Promise<boolean>;

interface WalkWorkingTreeEntry {
  readonly path: FilePath;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly stat: () => Promise<FileStat>;  // lazy, memoised per entry
}
```

## Behaviour

- **`stat` is lazy.** The three kind bits (`isFile`/`isDirectory`/`isSymbolicLink`) come straight off the underlying `readdir` batch — free, no syscall. `stat` is a memoised per-entry accessor: the `lstat` fires on first call, not at yield time, so a consumer that only reads `path` (or just the kind bits) never pays it — the shape `status`'s untracked pass relies on. Calling `stat()` more than once on the same entry issues exactly one `lstat`.
- **`.git` is always skipped** — folded only by case (matching `core.ignorecase`). An NTFS/HFS-obscured alias on disk (`git~1`, a `.git:`-stream name, an HFS+ ignorable-codepoint spelling) is walked like any other entry, exactly as git's own directory walk treats it; the wider rejection matrix applies only at the index-write boundary, never here.
- **Embedded clones** (directories with a `.git` child) and worktree-pointer files mark their parent as opaque; no `160000` gitlink is materialised.
- **Symlinks are never followed** — a symlink to a directory is yielded as a leaf, not descended into; staged as mode `120000` upstream by `add`.
- **Walk-time ignore pruning:** when `ignore` is supplied, ignored directories are not descended into — big perf win on `node_modules`.
- **Depth/entry caps:** `maxDepth` throws `TREE_DEPTH_EXCEEDED`; `maxEntries` throws `TREE_ENTRY_LIMIT_EXCEEDED`. `maxDepth` defaults to `core.maxTreeDepth`, read from the repository-local config only (default 2048 when unset) and honoured unclamped at any configured value.
- **The default depth cap is effectively unreachable on a real filesystem walk.** Every walked path is independently checked against `MAX_PATH_BYTES` (4096 bytes total), a pre-existing, unrelated cap on the working-tree path validator. Even a maximally compact one-character-per-level path exceeds 4096 bytes before it reaches a depth past the default 2048 `maxDepth` — the byte cap throws `PATHSPEC_OUTSIDE_REPO` first, so a path "at exactly the depth cap" does not, in practice, succeed here the way it does for the in-memory tree walkers (`walkTree`, `flattenTree`). Raising `core.maxTreeDepth` does not change this — the byte cap is independent of it.

## Example

```ts
for await (const entry of repo.primitives.walkWorkingTree()) {
  if (entry.isFile) {
    const stat = await entry.stat();
    console.log(entry.path, stat.size);
  }
}
```

## Throws

- `TREE_DEPTH_EXCEEDED` — walk depth exceeds `maxDepth`.
- `TREE_ENTRY_LIMIT_EXCEEDED` — yielded-entry count exceeds `maxEntries`.
- `OPERATION_ABORTED` — the context's `AbortSignal` fired mid-walk.
- `CONFIG_BAD_NUMERIC_VALUE` — the repository-local config holds a `core.maxTreeDepth` value git's numeric grammar refuses. Primitives resolve the cap themselves, so this reaches a direct primitive caller that never went through a command.

## See also

- Tier-1: [`add`](../commands/add.md), [`status`](../commands/status.md)
- Related primitives: [`readIndex`](read-index.md), [`walkTree`](walk-tree.md)
- ADRs: [030](../../adr/030-add-all-walk-strategy.md), [031](../../adr/031-add-all-symlink-gitlink-policy.md), [035](../../adr/035-walk-ignore-pruning.md), [633](../../adr/633-walk-working-tree-lazy-stat.md)
