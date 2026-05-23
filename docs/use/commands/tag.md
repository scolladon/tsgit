# `tag`

List, create, or delete tags. v1 ships lightweight tags only; annotated tags are roadmap.

## Signature

```ts
repo.tag(action: TagAction): Promise<TagResult>;

type TagAction =
  | { kind: 'list' }
  | { kind: 'create'; name: string; target?: string; force?: boolean }
  | { kind: 'delete'; name: string };

type TagResult =
  | { kind: 'list'; tags: ReadonlyArray<TagInfo> }
  | { kind: 'create'; name: RefName; id: ObjectId }
  | { kind: 'delete'; name: RefName };

interface TagInfo {
  readonly name: RefName;
  readonly id: ObjectId;
}
```

## Options

| Field | Meaning |
|---|---|
| `kind: 'list'` | List tags (`refs/tags/*`). |
| `kind: 'create'` | Create a lightweight tag. `target` defaults to HEAD. `force` overwrites an existing tag with the same name. |
| `kind: 'delete'` | Delete a tag. |

## Examples

```ts
const { tags } = await repo.tag({ kind: 'list' });
await repo.tag({ kind: 'create', name: 'v1.0.0' });
await repo.tag({ kind: 'create', name: 'v1.0.0', target: 'main', force: true });
await repo.tag({ kind: 'delete', name: 'v1.0.0' });
```

## Throws

- `TAG_EXISTS` — `kind: 'create'` with an existing name and no `force`.
- `INVALID_REF` — name violates git ref syntax.
- `TAG_NOT_FOUND` — `kind: 'delete'` on a name that does not exist.

## See also

- Primitives: [`resolveRef`](../primitives/resolve-ref.md), [`updateRef`](../primitives/update-ref.md)
- Related commands: [`branch`](branch.md), [`log`](log.md), [`revParse`](rev-parse.md)
- Roadmap: annotated tag API distinct from lightweight (v3)
