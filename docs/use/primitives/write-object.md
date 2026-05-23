# `writeObject`

Write any `GitObject` to storage as a loose object. Returns the resulting `ObjectId`. Idempotent — writing the same content twice yields the same id and is a no-op the second time.

## Signature

```ts
repo.primitives.writeObject(object: GitObject): Promise<ObjectId>;
```

## Example

```ts
const id = await repo.primitives.writeObject({
  type: 'blob',
  content: new TextEncoder().encode('hello'),
});
```

## See also

- Tier-1: [`commit`](../commands/commit.md), [`add`](../commands/add.md)
- Related primitives: [`writeTree`](write-tree.md), [`createCommit`](create-commit.md), [`readObject`](read-object.md)
