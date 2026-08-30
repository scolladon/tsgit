# `branch`

List, create, delete, or rename branches via the `repo.branch.{list,create,delete,rename}` nested namespace.

## Signature

```ts
interface BranchInfo {
  readonly name: RefName;
  readonly id: ObjectId;
  readonly current: boolean;
}

interface BranchNamespace {
  list(): Promise<{ branches: ReadonlyArray<BranchInfo> }>;
  create(input: { name: string; startPoint?: string; force?: boolean }): Promise<{
    name: RefName;
    id: ObjectId;
  }>;
  delete(input: { name: string; force?: boolean }): Promise<{ name: RefName }>;
  rename(input: { from: string; to: string; force?: boolean }): Promise<{
    from: RefName;
    to: RefName;
  }>;
}

repo.branch: BranchNamespace;
```

Each method returns a concrete result — no discriminator to narrow on at the call site (ADR-181, ADR-192).

## Methods

| Method | Meaning |
|---|---|
| `list()` | List local branches (`refs/heads/*`), sorted by name; `current` flags the checked-out branch. |
| `create({ name, startPoint?, force? })` | Create a branch. `startPoint` defaults to HEAD; `force` overwrites an existing branch with the same name. |
| `delete({ name, force? })` | Delete a local branch. |
| `rename({ from, to, force? })` | Rename a branch, moving its reflog; updates HEAD when the renamed branch is checked out. `force` overrides an existing `to`. |

## Behaviour

- **Reflog move, not rewrite.** `rename` moves the source's reflog file byte-for-byte instead of parsing and re-serializing it, so a malformed line survives verbatim under the new name; the rename entry is appended afterward.
- **Renaming a branch onto its own name succeeds** — the ref and its log stay put, and only the rename entry is appended.
- **`force` onto an existing branch replaces its reflog**, not concatenates it: the destination's prior history is dropped before the source's log moves in.
- **An orphan reflog file under the destination name** (no live ref, left behind by an earlier delete) survives when the branch being renamed has no reflog of its own — the rename entry is appended onto it, matching git; when the source does have a reflog, moving it overwrites whatever log already sits at the destination.

## Examples

```ts
const { branches } = await repo.branch.list();
await repo.branch.create({ name: 'feature/x', startPoint: 'main' });
await repo.branch.rename({ from: 'feature/x', to: 'feature/y' });
await repo.branch.delete({ name: 'feature/y' });
```

## Throws

- `BRANCH_EXISTS` — `create` with an existing name and no `force`; `rename` whose `to` already exists and no `force`.
- `INVALID_REF` — name violates git ref syntax.
- `BRANCH_NOT_FOUND` — `delete` / `rename` on a name that does not exist, or an unresolvable `startPoint`.
- `CANNOT_DELETE_CHECKED_OUT_BRANCH` — `delete` on the branch HEAD points at.

## See also

- Primitives: [`resolveRef`](../primitives/resolve-ref.md), [`updateRef`](../primitives/update-ref.md), [`RefStore.moveReflog`](../primitives/internals.md#refstore--getrefstore)
- Related commands: [`checkout`](checkout.md), [`tag`](tag.md), [`merge`](merge.md)
- ADRs: [181](../../adr/181-nested-namespace-porcelain.md), [192](../../adr/192-crud-namespace-per-verb-results.md), [193](../../adr/193-no-transition-shim-hard-remove-callable.md), [740](../../adr/740-branch-rename-moves-the-reflog-through-a-move-reflog-verb.md)
- Recipes: [navigate ref history](../recipes.md#navigate-ref-history)