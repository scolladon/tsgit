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

| Field | Default | Meaning |
|---|---|---|
| `target` | (required) | Ref name, oid, or `'HEAD'` of the branch to merge in. |
| `message` | auto | Override the merge-commit message. |
| `fastForwardOnly` | `false` | Reject when a fast-forward is not possible. |
| `noFastForward` | `false` | Always create a merge commit, even when fast-forward would work. |
| `author` / `committer` | from config | Identities for the merge commit. |

## Conflict handling

When the merge cannot resolve cleanly, the result is `{ kind: 'conflict', conflicts, mergeHead, origHead }`:

- Per-path conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) are written to the working tree.
- The index gains stage-1/2/3 entries for each conflict.
- `.git/MERGE_HEAD`, `.git/MERGE_MSG`, `.git/ORIG_HEAD` persist the merge state.

Resolve the working-tree files, `repo.add` the resolved paths, then `repo.commit({ message })`. The next `commit` reads `MERGE_HEAD` as a second parent and clears the merge-state files atomically.

Unsupported conflict types (`rename-rename`, `gitlink`) reject upfront with `unsupportedOperation` before any disk write.

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

- `MERGE_NOT_FAST_FORWARD` — `fastForwardOnly: true` and no fast-forward exists.
- `UNSUPPORTED_OPERATION` — conflict type not supported in v1 (e.g. rename/rename).
- `REF_NOT_FOUND` — `target` does not resolve.

## See also

- Primitives: [`mergeBase`](../primitives/merge-base.md), [`diffTrees`](../primitives/diff-trees.md), [`materializeTree`](../primitives/materialize-tree.md)
- Related commands: [`commit`](commit.md) (clears merge state), [`reset`](reset.md) (abort a merge with `mode: 'hard'` to `ORIG_HEAD`)
- ADRs: [025](../../adr/025-merge-parallel-blob-reads.md), [026](../../adr/026-merge-conflict-returns-not-throws.md), [027](../../adr/027-merge-conflict-write-order.md), [028](../../adr/028-merge-msg-content.md), [076](../../adr/076-merge-conflict-materialization.md)
- Roadmap: Phase 20.4 — explicit `abortMerge` / `continueMerge`
