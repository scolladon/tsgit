# `mergeBase`

Best common ancestor of two commits. Returns `undefined` when no ancestor exists (disjoint histories). Single-base only in v1; multi-base / octopus deferred to Phase 20.7.

## Signature

```ts
repo.primitives.mergeBase(a: ObjectId, b: ObjectId): Promise<ObjectId | undefined>;
```

## Example

```ts
const head = await repo.primitives.resolveRef('HEAD');
const feature = await repo.primitives.resolveRef('refs/heads/feature/x');
const base = await repo.primitives.mergeBase(head, feature);
```

## See also

- Tier-1: [`merge`](../commands/merge.md), [`log`](../commands/log.md) (range A..B)
- Related primitives: [`walkCommits`](walk-commits.md), [`resolveRef`](resolve-ref.md)
- Roadmap: Phase 20.7 — multi-base / octopus `mergeBase`
