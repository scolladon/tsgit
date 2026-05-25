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

## Interop with canonical git

Equivalent under readback: the on-disk loose-object SHA matches `git hash-object -w`'s for the same content, and `git cat-file -p <sha>` reads the payload back verbatim. The compressed disk bytes themselves differ — Node's zlib default level is 6, git's is 1 — but the spec doesn't pin compression. See [`design/phase-19-7-interop-suite.md`](../../design/phase-19-7-interop-suite.md).

## See also

- Tier-1: [`commit`](../commands/commit.md), [`add`](../commands/add.md)
- Related primitives: [`writeTree`](write-tree.md), [`createCommit`](create-commit.md), [`readObject`](read-object.md)
