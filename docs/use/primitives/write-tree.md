# `writeTree`

Write a tree object from a list of entries. Returns the resulting `ObjectId`. Entries MUST be canonically ordered (git sorts case-sensitive with trees having an implicit trailing `/`); pass them out of order and `writeTree` throws.

## Signature

```ts
repo.primitives.writeTree(entries: ReadonlyArray<TreeEntry>): Promise<ObjectId>;
```

## Example

```ts
const tree = await repo.primitives.writeTree([
  { name: 'README.md', mode: 0o100644, id: readmeBlobId, type: 'blob' },
  { name: 'src',       mode: 0o040000, id: srcTreeId,    type: 'tree' },
]);
```

## Throws

- `INVALID_TREE_ENTRY` — entries out of git-canonical order, or otherwise malformed.

## See also

- Tier-1: [`commit`](../commands/commit.md)
- Related primitives: [`readTree`](read-tree.md), [`createCommit`](create-commit.md), [`writeObject`](write-object.md)
