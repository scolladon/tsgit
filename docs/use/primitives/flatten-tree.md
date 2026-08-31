# `flattenTree`

Eagerly flatten a tree into a `FlatTree` — a `Map<FilePath, FlatTreeEntry>` of every blob/gitlink leaf keyed by its full slash-joined path. The bulk traversal path: one eager pass, no per-entry streaming overhead. Use it when you need the whole tree in memory at once (indexing, archive-shaped work); use [`walkTree`](walk-tree.md) when you want to stream entries one at a time.

## Signature

```ts
repo.primitives.flattenTree(treeIdOrObject: ObjectId | Tree): Promise<FlatTree>;

interface FlatTreeEntry {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

interface FlatTree {
  readonly entries: ReadonlyMap<FilePath, FlatTreeEntry>;
}
```

## Behaviour

Recurses into every sub-tree; directory entries themselves are not included in the result — only blob and gitlink leaves. Accepts either a tree `ObjectId` or an already-resolved `Tree` object — either form re-reads the root raw by its `id` before walking (passing a resolved `Tree` is not a redundant-root-read shortcut; see Throws below for what that means for a hand-forged `Tree`). An entry with an empty name is refused as a structural fault before it is recorded — mode, name and oid cannot otherwise be read apart. An entry named `.` or `..`, or containing an embedded `/`, is recorded like any other name — no git read path refuses those shapes either; `.` and `..` are refused only where git refuses them, at worktree materialisation and index construction (not by this primitive), and an embedded `/` is refused nowhere outside `git fsck --strict`.

## Example

```ts
const tree = await repo.primitives.readTree('HEAD');
const flat = await repo.primitives.flattenTree(tree.id);
for (const [path, entry] of flat.entries) {
  console.log(path, entry.id, entry.mode);
}
```

## Throws

- `OBJECT_NOT_FOUND` — the root oid (or a passed-in `Tree`'s `id`) is not in the store.
- `UNEXPECTED_OBJECT_TYPE` — the root oid (or a passed-in `Tree`'s `id`) does not resolve to a tree. A directory-mode entry deeper in the walk whose oid resolves to a non-tree is silently skipped instead — never recursed into, never recorded — mirroring `walkTree`'s own asymmetry.
- `INVALID_TREE_ENTRY` — a structurally malformed entry: missing space after the mode, an empty or non-octal mode, a missing NUL after the name, an empty name, or a truncated hash. A `.`/`..`/embedded-`/`-named entry is **not** refused here — see Behaviour above.
- `TREE_DEPTH_EXCEEDED` / `TREE_ENTRY_LIMIT_EXCEEDED` / `TREE_CYCLE_DETECTED` — the traversal's bounded-recursion guards. The depth bound is `core.maxTreeDepth`, read from the repository-local config only (default 2048 when unset) and honoured unclamped at any configured value; there is no caller override.
- `OPERATION_ABORTED` — `ctx.signal` is already aborted.
- `CONFIG_BAD_NUMERIC_VALUE` — the repository-local config holds a `core.maxTreeDepth` value git's numeric grammar refuses. Primitives resolve the cap themselves, so this reaches a direct primitive caller that never went through a command.

Two on-disk entries sharing the same name are not refused here — the later entry on disk wins; `git fsck --strict` is where duplicate-name detection lives.

## See also

- Related primitives: [`walkTree`](walk-tree.md), [`readTree`](read-tree.md), [`diffTrees`](diff-trees.md)
