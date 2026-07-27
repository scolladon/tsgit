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

Recurses into every sub-tree; directory entries themselves are not included in the result — only blob and gitlink leaves. Accepts either a tree `ObjectId` or an already-resolved `Tree` object (passing the resolved object avoids a redundant root read when the caller already has it).

## Example

```ts
const tree = await repo.primitives.readTree('HEAD');
const flat = await repo.primitives.flattenTree(tree.id);
for (const [path, entry] of flat.entries) {
  console.log(path, entry.id, entry.mode);
}
```

## Throws

Propagates `readObject`'s errors for a missing or malformed tree object.

## See also

- Related primitives: [`walkTree`](walk-tree.md), [`readTree`](read-tree.md), [`diffTrees`](diff-trees.md)
