# `diffTrees`

Compare two tree-ids; return a structured `TreeDiff`. Optional rename detection (off by default — quadratic cost) and optional recursion into sub-trees (off by default — single-level, like `git diff-tree`).

## Signature

```ts
repo.primitives.diffTrees(
  a: ObjectId,
  b: ObjectId | undefined,
  options?: {
    detectRenames?: boolean;
    renameOptions?: RenameDetectOptions; // threshold, copies, copyThreshold, breakRewrites
    recursive?: boolean;
  },
): Promise<TreeDiff>;

interface TreeDiff {
  readonly changes: ReadonlyArray<DiffChange>;
}
```

`renameOptions` threads through to the detection engine unchanged. See
[`diff`](../commands/diff.md) for the full `RenameDetectOptions` knob reference
(`threshold`, `copies`, `copyThreshold`, `breakRewrites`).

`b` may be `undefined`, interpreted as the empty tree (every entry under `a` shows as added).

With `recursive: true`, both trees are flattened to full-path blob entries before classification, so a changed sub-directory surfaces as per-file changes (`src/foo.ts`) rather than a single `src` tree-entry change. This is the mode the Tier-1 `diff` and `show` commands build on.

## Example

```ts
const a = (await repo.primitives.readTree('HEAD~1')).id;
const b = (await repo.primitives.readTree('HEAD')).id;
const diff = await repo.primitives.diffTrees(a, b, { detectRenames: true });
console.log(diff.changes.length);
```

## See also

- Tier-1: [`diff`](../commands/diff.md), [`merge`](../commands/merge.md)
- Related primitives: [`readTree`](read-tree.md), [`walkTree`](walk-tree.md)
