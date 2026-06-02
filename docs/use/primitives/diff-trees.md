# `diffTrees`

Compare two tree-ids; return a structured `TreeDiff`. Optional rename detection (off by default — quadratic cost) and optional recursion into sub-trees (off by default — single-level, like `git diff-tree`).

## Signature

```ts
repo.primitives.diffTrees(
  a: ObjectId,
  b: ObjectId | undefined,
  options?: { detectRenames?: boolean; recursive?: boolean },
): Promise<TreeDiff>;

interface TreeDiff {
  readonly added: ReadonlyArray<TreeDiffEntry>;
  readonly deleted: ReadonlyArray<TreeDiffEntry>;
  readonly modified: ReadonlyArray<TreeDiffEntry>;
  readonly renamed: ReadonlyArray<{ from: TreeDiffEntry; to: TreeDiffEntry }>;
}
```

`b` may be `undefined`, interpreted as the empty tree (every entry under `a` shows as added).

With `recursive: true`, both trees are flattened to full-path blob entries before classification, so a changed sub-directory surfaces as per-file changes (`src/foo.ts`) rather than a single `src` tree-entry change. This is the mode the Tier-1 patch path (`diff({ format: 'patch' })`, `show`) builds on.

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
