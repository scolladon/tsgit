# `resolveRef`

Resolve a ref name (or symbolic ref) to an `ObjectId`. Follows symbolic refs through `HEAD`.

## Signature

```ts
repo.primitives.resolveRef(name: RefName, options?: { peel?: boolean }): Promise<ObjectId>;
```

| Option | Default | Meaning |
|---|---|---|
| `peel` | `false` | If `true` and the target is an annotated tag, peel through the tag to its commit (or tree). |

## Example

```ts
const head = await repo.primitives.resolveRef('HEAD');
const tagCommit = await repo.primitives.resolveRef('refs/tags/v1.0.0', { peel: true });
```

## Unreadable refs

A loose ref the file system refuses as too long (`PATH_TOO_LONG`) reads as an
unreadable ref, with a cycle or a malformed file: git's `lstat` failing with an
errno other than `ENOENT`. Every resolution made for reading treats it as git's
NULL, so [`status`](../commands/status.md) reports such a HEAD as unknown and
initial. `resolveRef` itself still throws the fault.

## Throws

- `REF_NOT_FOUND` — name does not resolve.
- `INVALID_REF` — syntactically invalid.
- `PATH_TOO_LONG` — the loose ref's path exceeds what the file system allows.

## See also

- Tier-1: [`revParse`](../commands/rev-parse.md), [`branch`](../commands/branch.md)
- Related primitives: [`updateRef`](update-ref.md)
