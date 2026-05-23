# Primitives — Tier-2 reference

The composable building blocks every Tier-1 command is built from. Same `Context` users get — you can compose them into custom workflows that don't fit the command surface.

20 primitives bound on `repo.primitives.*`, alphabetical:

| Primitive | Summary |
|---|---|
| [`catFileBatch`](cat-file-batch.md) | Streaming object reader; `AsyncIterable<CatFileBatchEntry>` in input order. |
| [`createCommit`](create-commit.md) | Create a commit object from tree + parents. |
| [`diffTrees`](diff-trees.md) | Compare two tree iterables; returns a structured diff. |
| [`getRepoRoot`](get-repo-root.md) | The repository's working-tree root (`FilePath`). |
| [`mergeBase`](merge-base.md) | Best common ancestor of two commits. |
| [`readBlob`](read-blob.md) | Read a blob by id; optional `maxBytes` cap. |
| [`readIndex`](read-index.md) | Read `.git/index` (v2 or v3). |
| [`readObject`](read-object.md) | Read any git object by id; transparent partial-clone lazy-fetch. |
| [`readTree`](read-tree.md) | Read a tree object by ref or id (peeled). |
| [`recordRefUpdate`](record-ref-update.md) | Atomic ref CRUD + reflog write. |
| [`resolveRef`](resolve-ref.md) | Resolve a ref name to an `ObjectId`. |
| [`runHook`](run-hook.md) | Execute a `.git/hooks/<name>` script (Node only). |
| [`updateRef`](update-ref.md) | Convenience wrapper around `recordRefUpdate`. |
| [`walkCommits`](walk-commits.md) | `AsyncIterable<Commit>` walker (any parent ordering). |
| [`walkSubmodules`](walk-submodules.md) | `AsyncIterable<SubmoduleEntry>` walker. |
| [`walkTree`](walk-tree.md) | `AsyncIterable<TreeEntry>` walker. |
| [`walkWorkingTree`](walk-working-tree.md) | `AsyncIterable<WalkWorkingTreeEntry>` walker (DFS, ignore-aware). |
| [`writeObject`](write-object.md) | Write any git object; returns the resulting id. |
| [`writeSymbolicRef`](write-symbolic-ref.md) | Write a symbolic ref (e.g. `HEAD → refs/heads/main`). |
| [`writeTree`](write-tree.md) | Write a tree object from entries; returns the id. |

For internal building blocks referenced from command pages (`materializeTree`, `fetchPack`, `buildPack`, etc.) see [`internals.md`](internals.md).

## Composition pattern

Every walker is a real `AsyncIterable`. The operator toolkit (`pipe`, `filter`, `map`, `flatMap`, `take`, `find`, `groupBy`, `toArray`) composes against them directly:

```ts
import { pipe, filter, take } from '@scolladon/tsgit/operators';

const recent = pipe(
  repo.primitives.walkCommits({ from: 'HEAD' }),
  filter(c => c.data.author.name === 'Alice'),
  take(5),
);
for await (const commit of recent) console.log(commit.data.message);
```

Back-pressure is native — the walker only advances when the consumer pulls. Memory stays bounded across arbitrarily large repos.
