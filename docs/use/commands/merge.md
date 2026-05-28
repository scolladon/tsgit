# `merge`

Three-way merge of `target` into `HEAD`. Returns a discriminated `MergeResult` — **conflicts do not throw**; the working tree, index, and merge-state files are written, and the caller resolves and commits.

## Signature

```ts
repo.merge(opts: MergeOptions): Promise<MergeResult>;

interface MergeOptions {
  readonly target: string;
  readonly message?: string;
  readonly fastForwardOnly?: boolean;
  readonly noFastForward?: boolean;
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
}

type MergeResult =
  | { kind: 'up-to-date'; head: ObjectId }
  | { kind: 'fast-forward'; head: ObjectId; from: ObjectId; to: ObjectId }
  | { kind: 'merge'; id: ObjectId; parents: ReadonlyArray<ObjectId> }
  | { kind: 'conflict';
      conflicts: ReadonlyArray<MergeConflictDescriptor>;
      mergeHead: ObjectId;
      origHead: ObjectId;
    };
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `target` | `string` | (required) | Ref name, oid, or `'HEAD'` of the branch to merge in. |
| `message` | `string` | auto | Override the merge-commit message. |
| `fastForwardOnly` | `boolean` | `false` | Reject when a fast-forward is not possible. |
| `noFastForward` | `boolean` | `false` | Always create a merge commit, even when fast-forward would work. |
| `author` / `committer` | `AuthorIdentity` | from config | Identities for the merge commit. |

## Conflict handling

When the merge cannot resolve cleanly, the result is `{ kind: 'conflict', conflicts, mergeHead, origHead }`:

- Per-path conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) are written to the working tree.
- The index gains stage-1/2/3 entries for each conflict.
- `.git/MERGE_HEAD`, `.git/MERGE_MSG`, `.git/ORIG_HEAD` persist the merge state.

Resolve the working-tree files, `repo.add` the resolved paths, then `repo.commit({ message })`. The next `commit` reads `MERGE_HEAD` as a second parent and clears the merge-state files atomically.

Unsupported conflict types (`rename-rename`, `gitlink`) reject upfront with `UNSUPPORTED_OPERATION` before any disk write.

## State machine — `abortMerge` and `continueMerge`

A conflicting merge leaves the repository in an "in-progress" state recorded by `.git/MERGE_HEAD`, `.git/MERGE_MSG`, and `.git/ORIG_HEAD`. Two dedicated commands end that state:

- `repo.abortMerge()` — hard-reset the working tree, index, and current branch back to `ORIG_HEAD`, then delete `MERGE_HEAD` and `MERGE_MSG`. `ORIG_HEAD` is preserved so `reset --hard ORIG_HEAD` remains a meaningful follow-up (ADR-173). Returns `{ origHead, branch }`.
- `repo.continueMerge({ message?, author?, committer?, noVerify? })` — finalise the resolution as a two-parent merge commit. Equivalent to `repo.commit({ ... })` plus a precondition that `MERGE_HEAD` exists. An empty/omitted `message` falls back to `MERGE_MSG`'s draft.

Both refuse with `NO_OPERATION_IN_PROGRESS` (`operation: 'merge'`) when `MERGE_HEAD` is absent. `abortMerge` additionally requires `ORIG_HEAD` to be present.

`abortMerge` uses simple hard-reset semantics — any pre-merge uncommitted local changes are lost. (ADR-170 — canonical git's `--merge` variant that preserves them is out of scope for v1.)

```ts
const m = await repo.merge({ target: 'feature/x' });
if (m.kind === 'conflict') {
  // Option A — give up on the merge.
  await repo.abortMerge();

  // Option B — resolve, stage, then continue.
  // … edit working-tree files, call repo.add(paths) …
  await repo.continueMerge({ message: 'resolve merge' });
}
```

## Examples

```ts
const result = await repo.merge({
  target: 'feature/x',
  author: { name: 'A', email: 'a@b', timestamp: 0, timezoneOffset: '+0000' },
});

switch (result.kind) {
  case 'up-to-date':
    break;
  case 'fast-forward':
    console.log('advanced to', result.to);
    break;
  case 'merge':
    console.log('merge commit', result.id);
    break;
  case 'conflict':
    // edit each conflicted file, then:
    await repo.add(result.conflicts.map(c => c.path));
    await repo.commit({ message: 'resolve merge' });
    break;
}
```

## Throws

- `UNSUPPORTED_OPERATION` — conflict type not supported in v1 (e.g. rename/rename) or `fastForwardOnly: true` and no fast-forward exists. Also surfaced by `abortMerge` when HEAD is detached.
- `REF_NOT_FOUND` — `target` does not resolve.
- `NO_OPERATION_IN_PROGRESS` — `abortMerge` / `continueMerge` called outside an in-progress merge.

## See also

- Primitives: [`mergeBase`](../primitives/merge-base.md), [`diffTrees`](../primitives/diff-trees.md), [`materializeTree`](../primitives/internals.md#materializetree)
- Related commands: [`commit`](commit.md) (clears merge state), [`reset`](reset.md) (`mode: 'hard'` to `ORIG_HEAD` is the manual equivalent of `abortMerge`)
- ADRs: [025](../../adr/025-merge-parallel-blob-reads.md), [026](../../adr/026-merge-conflict-returns-not-throws.md), [027](../../adr/027-merge-conflict-write-order.md), [028](../../adr/028-merge-msg-content.md), [076](../../adr/076-merge-conflict-materialization.md), [170](../../adr/170-abort-merge-hard-reset-semantics.md), [171](../../adr/171-no-operation-in-progress-error.md), [172](../../adr/172-flat-abort-continue-surface.md), [173](../../adr/173-abort-merge-preserves-orig-head.md), [174](../../adr/174-continue-merge-delegates-to-commit.md)
