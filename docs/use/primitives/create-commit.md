# `createCommit`

Build a commit object from tree id + parents + author/committer + message, write it, return its `ObjectId`. Does **not** update any ref — pair with [`updateRef`](update-ref.md) for the ref move.

## Signature

```ts
repo.primitives.createCommit(input: CreateCommitInput): Promise<ObjectId>;

interface CreateCommitInput {
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
  readonly author: AuthorIdentity;
  readonly committer: AuthorIdentity;
  readonly message: string;
}
```

## Example

```ts
const tree = await repo.primitives.writeTree(entries);
const commitId = await repo.primitives.createCommit({
  tree,
  parents: [await repo.primitives.resolveRef('HEAD')],
  author: { name: 'A', email: 'a@b', timestamp: 0, timezoneOffset: '+0000' },
  committer: { name: 'A', email: 'a@b', timestamp: 0, timezoneOffset: '+0000' },
  message: 'compose',
});
await repo.primitives.updateRef('refs/heads/main', commitId);
```

## See also

- Tier-1: [`commit`](../commands/commit.md), [`merge`](../commands/merge.md)
- Related primitives: [`writeTree`](write-tree.md), [`writeObject`](write-object.md), [`updateRef`](update-ref.md)
