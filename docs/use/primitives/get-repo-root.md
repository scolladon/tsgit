# `getRepoRoot`

The repository's working-tree root as a `FilePath`. Synchronous.

## Signature

```ts
repo.primitives.getRepoRoot(): FilePath;
```

## Behaviour

Returns `workDir ?? gitDir` — the working tree when the repository has one;
the gitDir itself for a bare repository, or one opened without a resolved
work tree. Matches `assertRepository`'s own root selection, so a caller that
only reads this primitive never needs to special-case bareness separately.

## Example

```ts
const root = repo.primitives.getRepoRoot();
// e.g. '/Users/alice/code/myrepo'
```

## See also

- Related primitives: [`readIndex`](read-index.md), [`walkWorkingTree`](walk-working-tree.md)
