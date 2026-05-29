# `mergeBase`

Best common ancestor(s) of one or more commits. Always returns an array, sorted by oid; empty when the histories are disjoint.

By default it returns at most one base (the lexicographically smallest), mirroring `git merge-base`. Two flags extend it:

- `{ all: true }` — every best common ancestor (`git merge-base --all`). In criss-cross histories there can be more than one.
- `{ octopus: true }` — the n-way octopus base (`git merge-base --octopus`), folded pairwise across all commits. `all` still controls truncation.

## Signature

```ts
repo.primitives.mergeBase(
  commits: readonly ObjectId[],
  options?: { readonly all?: boolean; readonly octopus?: boolean },
): Promise<readonly ObjectId[]>;
```

`commits[0]` is treated as `one`, the rest as the others. An empty `commits` array throws `INVALID_WALK_INPUT`.

## Examples

```ts
const head = await repo.primitives.resolveRef('HEAD');
const feature = await repo.primitives.resolveRef('refs/heads/feature/x');

// single best base (or [] for disjoint histories)
const [base] = await repo.primitives.mergeBase([head, feature]);

// all best bases — multiple in criss-cross merges
const bases = await repo.primitives.mergeBase([head, feature], { all: true });

// octopus base of three branches
const a = await repo.primitives.resolveRef('refs/heads/a');
const b = await repo.primitives.resolveRef('refs/heads/b');
const [octopusBase] = await repo.primitives.mergeBase([head, a, b], { octopus: true });
```

## See also

- Tier-1: [`merge`](../commands/merge.md), [`log`](../commands/log.md) (range A..B)
- Related primitives: [`walkCommits`](walk-commits.md), [`resolveRef`](resolve-ref.md)
