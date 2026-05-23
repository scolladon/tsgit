# `readTree`

Read a tree object by ref name or oid. Peels through commits and annotated tags — pass `'HEAD'` and you get the commit's tree.

## Signature

```ts
repo.primitives.readTree(ref: RefName | ObjectId): Promise<Tree>;
```

## Example

```ts
const tree = await repo.primitives.readTree('HEAD');
for (const entry of tree.data.entries) console.log(entry.name, entry.mode, entry.id);
```

## See also

- Tier-1: [`diff`](../commands/diff.md), [`checkout`](../commands/checkout.md)
- Related primitives: [`walkTree`](walk-tree.md), [`readObject`](read-object.md), [`writeTree`](write-tree.md)
