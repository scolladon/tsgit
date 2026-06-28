# `bisectMidpoint`

Find the commit that best halves a bisect candidate set — the commits reachable
from `bad` but not reachable from any `good` commit.

Returns structured halving data faithful to `git rev-list --bisect-vars`:
no rendered string is returned; field derivation mirrors git's `bisect_good`,
`bisect_bad`, `bisect_all`, and `bisect_steps` output.

Returns `undefined` when the candidate set is empty (the `bad` commit is already
reachable from a `good` commit, or all ancestors are known-good).

## Signature

```ts
repo.primitives.bisectMidpoint(
  good: ReadonlyArray<ObjectId>,
  bad: ObjectId,
): Promise<BisectMidpoint | undefined>
```

## Return type

```ts
interface BisectMidpoint {
  nextCommit: ObjectId;       // bisect_rev — the commit to test next
  candidateCount: number;     // bisect_all — total candidates in the range
  remainingIfGood: number;    // bisect_good — candidates left if this is good
  remainingIfBad: number;     // bisect_bad  — candidates left if this is bad
  remainingSteps: number;     // bisect_steps — estimated rounds remaining
}
```

`remainingIfGood` is `−1` when `candidateCount === 1` (the only candidate is the
midpoint; if it tests good there is nothing left to test, which is a sentinel for
"impossible in a well-structured bisect").

## Example

```ts
const badHead = await repo.primitives.resolveRef('refs/bisect/bad');
const goodRefs = await repo.primitives.resolveRef('refs/bisect/good');

const result = await repo.primitives.bisectMidpoint([goodRefs], badHead);
if (result === undefined) {
  console.log('No candidates — bisect complete.');
} else {
  console.log(`Test: ${result.nextCommit}`);
  console.log(`${result.candidateCount} candidates, ~${result.remainingSteps} steps left`);
  console.log(`If good: ${result.remainingIfGood} remain`);
  console.log(`If bad:  ${result.remainingIfBad} remain`);
}
```

## Related

Tier-2: [`mergeBase`](merge-base.md), [`walkCommits`](walk-commits.md),
[`resolveRef`](resolve-ref.md)
