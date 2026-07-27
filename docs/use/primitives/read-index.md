# `readIndex`

Read `.git/index` (v2 or v3). Returns the full index — entries, extensions (including skip-worktree / intent-to-add in v3), tree extension cache when present.

## Signature

```ts
repo.primitives.readIndex(): Promise<GitIndex>;

interface GitIndex {
  readonly version: 2 | 3;
  readonly entries: ReadonlyArray<IndexEntry>;
  readonly indexMtime?: { seconds: number; nanoseconds: number };
  // …extensions
}

interface IndexEntry {
  readonly path: FilePath;
  readonly mode: FileMode;
  readonly id: ObjectId;
  readonly stage: 0 | 1 | 2 | 3;
  readonly flags: IndexEntryFlags;
  readonly stat?: StatFields;
}
```

`indexMtime` is the `.git/index` file's own mtime (seconds + nanoseconds), as observed at read time — `undefined` when the index is unborn or absent. `status` threads it into the working-tree comparator as the racy-clean guard's reference point: an entry not provably older than this mtime is re-hashed rather than trusted.

## Example

```ts
const index = await repo.primitives.readIndex();
for (const entry of index.entries) {
  if (entry.flags.skipWorktree) console.log(entry.path, '(skip-worktree)');
}
```

## See also

- Tier-1: [`status`](../commands/status.md), [`add`](../commands/add.md), [`reset`](../commands/reset.md)
- Related primitives: [`writeObject`](write-object.md), [`walkWorkingTree`](walk-working-tree.md)
