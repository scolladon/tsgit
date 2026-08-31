# `writeTree`

Write a tree object from a list of entries. Returns the resulting `ObjectId`. Entries do **not** need to be pre-sorted — `writeTree` canonically sorts them itself (git sorts case-sensitive, with a directory compared as if its name carried a trailing `/`) before serializing, so passing them out of order never throws.

`TreeEntry` is a branded type — an object literal cannot satisfy it. Build every entry through the exported `treeEntry` factory, which accepts either a `string` or raw `Uint8Array` name and does the encoding itself.

## Signature

```ts
repo.primitives.writeTree(entries: ReadonlyArray<TreeEntry>): Promise<ObjectId>;

function treeEntry(mode: FileMode, name: string | Uint8Array, id: ObjectId): TreeEntry;
```

## Example

```ts
import { treeEntry } from '@scolladon/tsgit';

const tree = await repo.primitives.writeTree([
  treeEntry('100644', 'README.md', readmeBlobId),
  treeEntry('40000', 'src', srcTreeId),
]);
```

## Throws

- `TREE_ENTRY_LIMIT_EXCEEDED` — more than `MAX_FLAT_TREE_ENTRIES` entries.

## See also

- Tier-1: [`commit`](../commands/commit.md)
- Related primitives: [`readTree`](read-tree.md), [`createCommit`](create-commit.md), [`writeObject`](write-object.md)
