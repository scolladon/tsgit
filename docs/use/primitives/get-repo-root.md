# `getRepoRoot`

The repository's working-tree root as a `FilePath`. Synchronous.

## Signature

```ts
repo.primitives.getRepoRoot(): FilePath;
```

## Example

```ts
const root = repo.primitives.getRepoRoot();
// e.g. '/Users/alice/code/myrepo'
```

## See also

- Related primitives: [`readIndex`](read-index.md), [`walkWorkingTree`](walk-working-tree.md)
