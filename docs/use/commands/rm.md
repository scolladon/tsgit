# `rm`

Remove files from the index, and by default from the working tree. Accepts the same pathspec syntax as [`add`](add.md).

## Signature

```ts
repo.rm(
  paths: ReadonlyArray<string>,
  opts?: { cached?: boolean; breakStaleLockMs?: number },
): Promise<RmResult>;

interface RmResult {
  readonly removed: ReadonlyArray<FilePath>;
}
```

## Options

| Field | Default | Meaning |
|---|---|---|
| `cached` | `false` | Index only — leave the working-tree file in place. |
| `breakStaleLockMs` | (none) | Break a stale `.git/index.lock` older than this many ms. |

## Examples

```ts
// Remove from index AND working tree
await repo.rm(['old.txt']);

// Index only (file stays on disk)
await repo.rm(['secret.env'], { cached: true });

// Glob
await repo.rm(['*.log']);
```

## Throws

- `PATHSPEC_NO_MATCH` — a literal pattern matched nothing. (Glob no-match is a silent no-op.)
- `BARE_REPOSITORY` — `rm` is not valid in a bare repository.

## See also

- Primitives: [`readIndex`](../primitives/read-index.md), [`writeObject`](../primitives/write-object.md)
- Related commands: [`add`](add.md), [`checkout`](checkout.md) (share the pathspec syntax)
