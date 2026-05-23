# `diff`

Compare two tree-like targets. Returns a structured `TreeDiff` object — **not** unified-diff text. Patch-text serialisation is roadmap (Phase 20.3).

## Signature

```ts
repo.diff(opts?: DiffOptions): Promise<TreeDiff>;

interface DiffOptions {
  readonly from?: string;          // ref / oid / 'HEAD'; default 'HEAD'
  readonly to?: string;            // ref / oid; default empty tree
  readonly detectRenames?: boolean;
}

interface TreeDiff {
  readonly added: ReadonlyArray<TreeDiffEntry>;
  readonly deleted: ReadonlyArray<TreeDiffEntry>;
  readonly modified: ReadonlyArray<TreeDiffEntry>;
  readonly renamed: ReadonlyArray<{ from: TreeDiffEntry; to: TreeDiffEntry }>;
}
```

## Examples

```ts
// Diff HEAD against the empty tree (every tracked file shows as added)
const everything = await repo.diff();

// Diff two refs
const incoming = await repo.diff({ from: 'main', to: 'feature/x' });

// Detect renames (off by default)
const withRenames = await repo.diff({ from: 'HEAD~1', detectRenames: true });
```

## See also

- Primitives: [`diffTrees`](../primitives/diff-trees.md), [`walkTree`](../primitives/walk-tree.md), [`resolveRef`](../primitives/resolve-ref.md)
- Related commands: [`log`](log.md), [`status`](status.md)
- Roadmap: Phase 20.3 — unified patch-text output (`diff({ format: 'patch' })`)
