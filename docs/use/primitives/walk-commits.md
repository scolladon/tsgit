# `walkCommits`

`AsyncIterable<Commit>` walker. Any parent ordering — not first-parent-only like the `log` command. Composable with the [operator toolkit](../api-primitives.md#composition-pattern).

## Signature

```ts
repo.primitives.walkCommits(options?: WalkCommitsOptions): AsyncIterable<Commit>;

interface WalkCommitsOptions {
  readonly from?: RefName | ObjectId;       // default 'HEAD'
  readonly excluding?: ReadonlyArray<RefName | ObjectId>;  // stops
  readonly firstParent?: boolean;
}
```

## Behaviour

- DFS over reachable commits.
- `excluding` cuts subtrees rooted at the given oids.
- `firstParent: true` mirrors [`log`](../commands/log.md)'s semantics.
- Back-pressure: only advances when the consumer pulls.

## Example

```ts
import { pipe, filter, take } from '@scolladon/tsgit/operators';

const recent = pipe(
  repo.primitives.walkCommits(),
  filter(c => c.data.author.name === 'Alice'),
  take(5),
);

for await (const c of recent) console.log(c.id, c.data.message);
```

## See also

- Tier-1: [`log`](../commands/log.md), [`merge`](../commands/merge.md)
- Related primitives: [`walkTree`](walk-tree.md), [`mergeBase`](merge-base.md), [`readObject`](read-object.md)
