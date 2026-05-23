# `add`

Stage paths into `.git/index`. Two modes: literal paths (each validated and staged) or `all: true` (walk the working tree, stage every change).

## Signature

```ts
repo.add(
  paths: ReadonlyArray<string>,
  opts?: { force?: boolean; all?: boolean; breakStaleLockMs?: number },
): Promise<AddResult>;

interface AddResult {
  readonly added: ReadonlyArray<FilePath>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly removed: ReadonlyArray<FilePath>;
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `paths` | `ReadonlyArray<string>` | (required) | Literal paths or pathspec globs. **MUST be empty when `all: true`.** |
| `opts.all` | `boolean` | `false` | Bulk mode — walk the working tree and stage every change. |
| `opts.force` | `boolean` | `false` | Stage ignored paths anyway. |
| `opts.breakStaleLockMs` | `number` | (none) | Break a stale `.git/index.lock` older than this many ms. |

## Pathspec syntax

`*`, `?`, `**` are globs. `!`-prefixed entries exclude (last match wins, `.gitignore` semantics). Anything else is a literal that matches the exact path **and** its descendants. Character classes (`[abc]`) and magic prefixes (`:(top)`, `:(literal)`) are not supported in v1.

## Examples

```ts
// Literal paths
await repo.add(['README.md', 'src/index.ts']);

// Globs — stage every .ts except tests
await repo.add(['*.ts', '!*.test.ts']);

// Bulk mode — stage every change in the working tree
const result = await repo.add([], { all: true });
console.log(result.added.length, result.modified.length, result.removed.length);
```

## Throws

- `PATHSPEC_NO_MATCH` — a literal pattern matched nothing. (Glob no-match is a silent no-op.)
- `INVALID_OPTION { option: 'all' }` — `all: true` with a non-empty pathspec.
- `WORKING_TREE_FILE_TOO_LARGE` — a file exceeds `MAX_WORKING_TREE_BLOB_BYTES` (256 MiB).
- `BARE_REPO` — `add` is not valid in a bare repository.
- `EMPTY_PATHSPEC` — `paths` is empty and `all` is not set.

## See also

- Primitives: [`walkWorkingTree`](../primitives/walk-working-tree.md), [`readIndex`](../primitives/read-index.md), [`writeObject`](../primitives/write-object.md)
- Related commands: [`rm`](rm.md), [`checkout`](checkout.md) — share the pathspec syntax
- Recipes: [stage with globs](../recipes.md#stage-with-globs), [bulk add --all](../recipes.md#bulk-add-all)
- ADRs: [029](../../adr/029-add-all-ignore-stub.md), [030](../../adr/030-add-all-walk-strategy.md), [031](../../adr/031-add-all-symlink-gitlink-policy.md), [032](../../adr/032-add-all-large-file-guard.md), [037](../../adr/037-pathspec-auto-detect.md), [038](../../adr/038-pathspec-exclusion.md)
