# `walkTree`

`AsyncIterable<TreeEntry>` walker. Recursive by default — yields every entry at every depth.

## Signature

```ts
repo.primitives.walkTree(
  treeIdOrObject: ObjectId | Tree,
  options?: { recursive?: boolean; maxDepth?: number; maxEntries?: number },
): AsyncIterable<TreeEntry>;

interface TreeEntry {
  readonly name: string;
  readonly path: FilePath;
  readonly mode: FileMode;
  readonly id: ObjectId;
  readonly type: 'blob' | 'tree' | 'commit';
}
```

| Option | Default | Meaning |
|---|---|---|
| `recursive` | `true` | Descend into sub-trees. When `false`, yields only the top-level entries. |
| `maxDepth` | `core.maxTreeDepth` | Cap on recursion depth, read from the repository-local config (default 2048 when unset) and honoured unclamped at any configured value — never read from `~/.gitconfig` or any other scope. Descends with an explicit stack, not JS recursion, so `maxDepth` is the only ceiling on how deep a walk can go. Exceeding it throws `TREE_DEPTH_EXCEEDED`. |
| `maxEntries` | `MAX_FLAT_TREE_ENTRIES` | Cap on the total entry count yielded. Exceeding it throws `TREE_ENTRY_LIMIT_EXCEEDED`. |

## Example

```ts
import { pipe, filter } from '@scolladon/tsgit/operators';

// Every .ts file under HEAD's tree
const ts = pipe(
  repo.primitives.walkTree(await repo.primitives.resolveRef('HEAD')),
  filter(e => e.type === 'blob' && e.path.endsWith('.ts')),
);
for await (const entry of ts) console.log(entry.path, entry.id);
```

## Throws

- `TREE_DEPTH_EXCEEDED` — the walk descends past the depth bound. That bound is `core.maxTreeDepth`, read from the repository-local config only (default 2048 when unset) and honoured unclamped at any configured value, unless the caller supplies `maxDepth` explicitly.
- `TREE_ENTRY_LIMIT_EXCEEDED` — yielded-entry count exceeds `maxEntries`.
- `TREE_CYCLE_DETECTED` — a tree oid reappears on its own root-to-current path.
- `OBJECT_NOT_FOUND` / `UNEXPECTED_OBJECT_TYPE` — the root oid is missing, or does not resolve to a tree.
- `OPERATION_ABORTED` — `ctx.signal` is already aborted.
- `CONFIG_BAD_NUMERIC_VALUE` — the repository-local config holds a `core.maxTreeDepth` value git's numeric grammar refuses. Primitives resolve the cap themselves, so this reaches a direct primitive caller that never went through a command.

## See also

- Tier-1: [`diff`](../commands/diff.md), [`checkout`](../commands/checkout.md)
- Related primitives: [`readTree`](read-tree.md), [`walkWorkingTree`](walk-working-tree.md)
