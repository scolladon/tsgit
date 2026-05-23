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

## Throws

- `REF_NOT_FOUND` — name does not resolve.
- `INVALID_REF_NAME` — syntactically invalid.

## See also

- Tier-1: [`revParse`](../commands/rev-parse.md), [`branch`](../commands/branch.md)
- Related primitives: [`updateRef`](update-ref.md), [`recordRefUpdate`](record-ref-update.md)
