# `checkout`

Switch branches or restore working-tree files from a tree-ish or the index. Two modes, selected by the option shape.

## Signature

```ts
repo.checkout(opts: CheckoutOptions): Promise<CheckoutResult>;

type CheckoutOptions = CheckoutSwitchOptions | CheckoutPathsOptions;

interface CheckoutSwitchOptions {
  readonly target: string;
  readonly force?: boolean;
}

interface CheckoutPathsOptions {
  readonly paths: ReadonlyArray<string>;
  readonly source?: 'index' | 'HEAD' | ObjectId;
}
```

## Modes

| Mode | Triggered by | Effect |
|---|---|---|
| **Switch** | `{ target }` | Materialise `target`'s tree onto the working tree, commit a new index, move HEAD. Atomic per-file. |
| **Restore from index** (default) | `{ paths }` (no `source` or `source: 'index'`) | Restore staged content into the working tree. Index untouched. |
| **Restore from HEAD or tree** | `{ paths, source: 'HEAD' \| <ObjectId> }` | Restore content from HEAD's tree (or an arbitrary tree). Index entries for the listed paths are also rewritten. |

## Examples

```ts
// Switch branches (or to any commit)
await repo.checkout({ target: 'main' });
await repo.checkout({ target: '<oid>' });

// Restore a file from the index
await repo.checkout({ paths: ['src/foo.ts'] });

// Restore a file from HEAD's tree
await repo.checkout({ paths: ['src/foo.ts'], source: 'HEAD' });

// Force-switch through a dirty tree
await repo.checkout({ target: 'main', force: true });
```

## Behaviour

- **Dirty-tree guard.** Switch mode refuses to overwrite tracked modifications or to clobber untracked paths that would collide. Use `force: true` to override.
- **Atomicity.** Per-file (matches canonical git). The index commit is atomic; working-tree writes are not all-or-nothing if power is cut mid-write.
- **Sparse checkout.** Switch mode honours the active sparse pattern on the target branch.
- **Path restore via globs.** `paths` accepts the same pathspec syntax as [`add`](add.md).

## Throws

- `CHECKOUT_OVERWRITE_DIRTY` — switch without `force` against a dirty working tree.
- `REF_NOT_FOUND` / `INVALID_REF` — `target` does not resolve.
- `PATHSPEC_NO_MATCH` — a literal path pattern matched nothing.
- `BARE_REPOSITORY` — checkout is not valid in a bare repository.

## See also

- Primitives: [`materializeTree`](../primitives/internals.md#materializetree), [`buildIndexFromTree`](../primitives/internals.md#buildindexfromtree), [`synthesizeTreeFromIndex`](../primitives/internals.md#synthesizetreefromindex), [`readIndex`](../primitives/read-index.md)
- Related commands: [`reset`](reset.md), [`add`](add.md), [`rm`](rm.md), [`sparseCheckout`](sparse-checkout.md)
- Recipes: [clone + checkout](../recipes.md#clone-and-checkout)
- ADRs: [018](../../adr/018-checkout-atomicity-model.md), [019](../../adr/019-checkout-dirty-tree-guard.md), [020](../../adr/020-checkout-paths-api-shape.md)
