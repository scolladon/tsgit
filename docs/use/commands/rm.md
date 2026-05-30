# `rm`

Remove files from the index, and by default from the working tree. Accepts the same pathspec syntax as [`add`](add.md).

## Signature

```ts
repo.rm(
  paths: ReadonlyArray<string>,
  opts?: { cached?: boolean; force?: boolean; breakStaleLockMs?: number },
): Promise<RmResult>;

interface RmResult {
  readonly removed: ReadonlyArray<FilePath>;
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `cached` | `boolean` | `false` | Index only — leave the working-tree file in place. |
| `force` | `boolean` | `false` | Override the safety valve (`-f`) — remove even staged or locally-modified paths. |
| `breakStaleLockMs` | `number` | (none) | Break a stale `.git/index.lock` older than this many ms. |

## Safety valve

Like `git rm`, `rm` refuses to destroy un-recoverable changes (validated up front
— a refusal removes nothing). For a path whose working file exists:

| State | Plain `rm` | `{ cached: true }` | `{ force: true }` |
|---|---|---|---|
| index differs from `HEAD` (staged) | refuses `RM_STAGED_CHANGES` | removes index entry | removes |
| working tree differs from index (local) | refuses `RM_LOCAL_MODIFICATIONS` | removes index entry | removes |
| both staged **and** local | refuses `RM_STAGED_AND_LOCAL_CHANGES` | still refuses | removes |
| clean (matches index and `HEAD`) | removes | removes | removes |

A path whose working file is already gone is never refused. `cached` keeps the
working file in every case; `force` overrides the valve entirely.

## Examples

```ts
// Remove from index AND working tree
await repo.rm(['old.txt']);

// Index only (file stays on disk)
await repo.rm(['secret.env'], { cached: true });

// Force removal of a staged / modified path
await repo.rm(['wip.txt'], { force: true });

// Glob
await repo.rm(['*.log']);
```

## Throws

- `PATHSPEC_NO_MATCH` — a literal pattern matched nothing. (Glob no-match is a silent no-op.)
- `BARE_REPOSITORY` — `rm` is not valid in a bare repository.
- `RM_STAGED_CHANGES` / `RM_LOCAL_MODIFICATIONS` / `RM_STAGED_AND_LOCAL_CHANGES` — the safety valve refused (see above); each `data.paths` lists the refused paths.

## See also

- Primitives: [`readIndex`](../primitives/read-index.md), [`writeObject`](../primitives/write-object.md)
- Related commands: [`add`](add.md), [`checkout`](checkout.md) (share the pathspec syntax)
