# `readIndex`

Read `.git/index` (v2 or v3). Returns the full index — entries, extensions (including skip-worktree / intent-to-add in v3), tree extension cache when present. Under sparse checkout the skip-worktree bits are the cleared view described below.

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
  /** Present only when the path is not valid UTF-8. */
  readonly pathBytes?: Uint8Array;
  readonly mode: FileMode;
  readonly id: ObjectId;
  readonly stage: 0 | 1 | 2 | 3;
  readonly flags: IndexEntryFlags;
  readonly stat?: StatFields;
}
```

`pathBytes` carries the entry's exact path bytes and is present only when they are not valid UTF-8; `path` is then the U+FFFD view (each invalid sequence decoded to U+FFFD) and may collide with a sibling's. Index writers key entries by the bytes, so a lossy entry round-trips byte-exact. Entries are ordered by raw path bytes.

`indexMtime` is the `.git/index` file's own mtime (seconds + nanoseconds), as observed at read time — `undefined` when the index is unborn or absent. `status` threads it into the working-tree comparator as the racy-clean guard's reference point: an entry not provably older than this mtime is re-hashed rather than trusted.

## Present files clear the skip-worktree bit

Under sparse checkout (`core.sparseCheckout` on) with `sparse.expectFilesOutsideOfPatterns` false, the default, every read clears `flags.skipWorktree` on an entry whose path is present in the work tree, as git's `clear_skip_worktree_from_present_files` does. Present means `lstat` succeeds at the path: a file, a directory, or a symlink, live or dangling. Any `lstat` refusal reads as absent and the bit stays. The clear is in memory only: nothing is written to `.git/index`, and the next read recomputes it, so a file that appears or vanishes between two reads is seen without an index change. The key is read from the local config, then from `config.worktree` when `extensions.worktreeConfig` is on. With `sparse.expectFilesOutsideOfPatterns` true, or sparse checkout off, entries are returned as stored. A value of that key outside git's boolean grammar refuses every operational command with `CONFIG_BAD_BOOLEAN_VALUE`, even with sparse checkout off.

The snapshot index rows (`repo.snapshot`) carry the same cleared view; the clear sits above the cache, so the cached parse stays as stored. The stored bits are available to library code as `readRawIndex`, a module-path export (not in the barrel, not bound on `repo.primitives`); see [internals](internals.md#readrawindex).

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
