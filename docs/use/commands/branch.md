# `branch`

List, create, or delete branches. The action is selected by the discriminated `kind` field.

## Signature

```ts
repo.branch(action:
  | { kind: 'list' }
  | { kind: 'create'; name: string; startPoint?: string; force?: boolean }
  | { kind: 'delete'; name: string; force?: boolean }
): Promise<BranchResult>;

type BranchResult =
  | { kind: 'list'; branches: ReadonlyArray<BranchInfo> }
  | { kind: 'create'; name: RefName; id: ObjectId }
  | { kind: 'delete'; name: RefName };

interface BranchInfo {
  readonly name: RefName;
}
```

## Options

| Field | Type | Meaning |
|---|---|---|
| `kind: 'list'` | — | List local branches (`refs/heads/*`). |
| `kind: 'create'` | — | Create a branch. `startPoint` defaults to HEAD. `force` overwrites an existing branch with the same name. |
| `kind: 'delete'` | — | Delete a local branch. `force` removes branches whose tip is not merged into HEAD. |

## Examples

```ts
const { branches } = await repo.branch({ kind: 'list' });
await repo.branch({ kind: 'create', name: 'feature/x', startPoint: 'main' });
await repo.branch({ kind: 'delete', name: 'feature/x' });
```

## Throws

- `BRANCH_EXISTS` — `kind: 'create'` with an existing name and no `force`.
- `INVALID_REF` — name violates git ref syntax.
- `BRANCH_NOT_FOUND` — `kind: 'delete'` on a name that does not exist.
- `CANNOT_DELETE_CHECKED_OUT_BRANCH` — `kind: 'delete'` on the branch HEAD points at.

## See also

- Primitives: [`resolveRef`](../primitives/resolve-ref.md), [`updateRef`](../primitives/update-ref.md), [`enumerateRefs`](../primitives/internals.md#enumeraterefs)
- Related commands: [`checkout`](checkout.md), [`tag`](tag.md), [`merge`](merge.md)
- Recipes: [navigate ref history](../recipes.md#navigate-ref-history)
