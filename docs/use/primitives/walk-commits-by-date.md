# `walkCommitsByDate`

`AsyncIterable<Commit>` walker over **all** parents of every reachable commit,
yielding them in commit-date priority order — newest committer date first,
oid-ascending on ties. The date-ordered companion to [`walkCommits`](walk-commits.md)
(whose orders are a topological FIFO and first-parent); it underpins history
summaries such as `shortlog`. Composable with the
[operator toolkit](README.md#composition-pattern).

## Signature

```ts
repo.primitives.walkCommitsByDate(options: WalkCommitsByDateOptions): AsyncIterable<Commit>;

interface WalkCommitsByDateOptions {
  readonly from: ReadonlyArray<ObjectId>;     // seed commits (≥ 1)
  readonly until?: ReadonlyArray<ObjectId>;   // excluded boundaries
  readonly shallow?: ReadonlySet<ObjectId>;   // yielded, but parents not walked
  readonly ignoreMissing?: boolean;           // skip a missing object instead of throwing
  readonly verifyHash?: boolean;              // default true
}
```

## Behaviour

- Walks every parent (not first-parent-only), newest committer-date first.
- Each reachable commit is yielded exactly once; a diamond's shared base appears
  once.
- `until` excludes a commit before it is read — neither yielded nor expanded.
- `shallow` boundaries are yielded but their parents are not walked.
- Reads eagerly to order the frontier, so a fake/missing parent cannot enter the
  queue; the frontier is bounded by the reachable-commit count.
- Throws `INVALID_WALK_INPUT` on an empty or over-cap `from`, and aborts at the
  next loop head when `ctx.signal` is aborted.

## Example

```ts
import { pipe, map, take } from '@scolladon/tsgit/operators';

const head = await repo.primitives.resolveRef('HEAD');

const newest = pipe(
  repo.primitives.walkCommitsByDate({ from: [head] }),
  map((c) => ({ id: c.id, when: c.data.committer.timestamp })),
  take(10),
);

for await (const c of newest) console.log(c.id, c.when);
```

## See also

- Sibling walker: [`walkCommits`](walk-commits.md) (topological / first-parent)
- Tier-1: [`log`](../commands/log.md)
- Related primitives: [`mergeBase`](merge-base.md), [`readObject`](read-object.md)
