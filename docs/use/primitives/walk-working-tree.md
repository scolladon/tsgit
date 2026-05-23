# `walkWorkingTree`

`AsyncIterable<WalkWorkingTreeEntry>` walker. DFS through `FileSystem.readdir` + `lstat`. Skips `.git`, embedded clones, and ignored directories (when an `ignore` predicate is supplied).

## Signature

```ts
repo.primitives.walkWorkingTree(
  options?: WalkWorkingTreeOptions,
): AsyncIterable<WalkWorkingTreeEntry>;

interface WalkWorkingTreeOptions {
  readonly start?: FilePath;
  readonly ignore?: WalkIgnorePredicate;
  readonly maxBlobBytes?: number;       // default MAX_WORKING_TREE_BLOB_BYTES (256 MiB)
}

interface WalkWorkingTreeEntry {
  readonly path: FilePath;
  readonly mode: FileMode;
  readonly size: number;
  readonly stat: StatFields;
  readonly isSymlink: boolean;
  readonly isGitlink: boolean;
}
```

## Behaviour

- **`.git` is always skipped** — the host repository never auto-stages itself.
- **Embedded clones** (directories with a `.git` child) and worktree-pointer files mark their parent as opaque; no `160000` gitlink is materialised.
- **Symlinks are `lstat`-only** — never followed; staged as mode `120000` upstream by `add`.
- **Walk-time ignore pruning:** when `ignore` is supplied, ignored directories are not descended into — big perf win on `node_modules`.
- **Size cap:** files exceeding `maxBlobBytes` throw `WORKING_TREE_FILE_TOO_LARGE` at walk time (defended again at re-lstat in upstream callers).

## Example

```ts
for await (const entry of repo.primitives.walkWorkingTree({ start: 'src' })) {
  if (entry.mode === 0o100644) console.log(entry.path, entry.size);
}
```

## See also

- Tier-1: [`add`](../commands/add.md), [`status`](../commands/status.md)
- Related primitives: [`readIndex`](read-index.md), [`walkTree`](walk-tree.md)
- ADRs: [030](../../adr/030-add-all-walk-strategy.md), [031](../../adr/031-add-all-symlink-gitlink-policy.md), [032](../../adr/032-add-all-large-file-guard.md), [035](../../adr/035-walk-ignore-pruning.md)
