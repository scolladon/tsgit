# `diffTrees`

Compare two tree-ids; return a structured `TreeDiff`. Optional rename detection (off by default — quadratic cost).

## Signature

```ts
repo.primitives.diffTrees(
  a: ObjectId,
  b: ObjectId | undefined,
  options?: { detectRenames?: boolean },
): Promise<TreeDiff>;

interface TreeDiff {
  readonly added: ReadonlyArray<TreeDiffEntry>;
  readonly deleted: ReadonlyArray<TreeDiffEntry>;
  readonly modified: ReadonlyArray<TreeDiffEntry>;
  readonly renamed: ReadonlyArray<{ from: TreeDiffEntry; to: TreeDiffEntry }>;
}
```

`b` may be `undefined`, interpreted as the empty tree (every entry under `a` shows as added).

## Example

```ts
const a = (await repo.primitives.readTree('HEAD~1')).id;
const b = (await repo.primitives.readTree('HEAD')).id;
const diff = await repo.primitives.diffTrees(a, b, { detectRenames: true });
console.log(diff.added.length, diff.deleted.length, diff.modified.length, diff.renamed.length);
```

## See also

- Tier-1: [`diff`](../commands/diff.md), [`merge`](../commands/merge.md)
- Related primitives: [`readTree`](read-tree.md), [`walkTree`](walk-tree.md)
