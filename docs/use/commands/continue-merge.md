# `continueMerge`

Finalise a conflicting merge as a two-parent merge commit. Thin wrapper around [`commit`](commit.md) with a precondition that `MERGE_HEAD` exists on disk (ADR-174). Mirrors `git merge --continue`.

## Signature

```ts
repo.continueMerge(opts?: ContinueMergeOptions): Promise<CommitResult>;

interface ContinueMergeOptions {
  readonly message?: string;
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
  readonly noVerify?: boolean;
}
```

## Options

| Field | Type | Default | Meaning |
|---|---|---|---|
| `message` | `string` | (falls back to `MERGE_MSG`) | Override the merge-commit message. Empty/omitted reads the draft `merge` wrote. |
| `author` | `AuthorIdentity` | from `.git/config` `[user]` | Forwarded to `commit`. |
| `committer` | `AuthorIdentity` | derived from `author` | Forwarded to `commit`. |
| `noVerify` | `boolean` | `false` | Skip `pre-commit` and `commit-msg` hooks (forwarded to `commit`). |

## Behaviour

- **Delegates to `commit`.** All the commit-resolution logic lives in [`commit`](commit.md): reading `MERGE_HEAD` for the second parent, falling back to `MERGE_MSG` when `message` is empty, running hooks, clearing merge state on success.
- **Stage-0 only.** The index must be fully resolved — any stage-1/2/3 entries surface `MERGE_HAS_CONFLICTS` (raised by `commit`).
- **Two parents.** The resulting commit has `parents = [HEAD_before_merge, MERGE_HEAD]`. Tree-equality with HEAD is allowed (no `nothing to commit` — a merge that re-takes "ours" is still a real merge commit).
- **State cleanup.** `MERGE_HEAD` and `MERGE_MSG` are removed once the commit lands. `ORIG_HEAD` is preserved (matches canonical git).

## Examples

```ts
const m = await repo.merge({ target: 'feature/x' });
if (m.kind === 'conflict') {
  // Edit each conflicted file, then stage it.
  await repo.add(m.conflicts.map((c) => c.path));

  const result = await repo.continueMerge({ message: 'resolve merge' });
  // result.parents has length 2: [pre-merge HEAD, m.mergeHead].
}
```

```ts
// Empty message → falls back to the MERGE_MSG draft.
await repo.continueMerge();
```

## Throws

- `NO_OPERATION_IN_PROGRESS` (`operation: 'merge'`) — `MERGE_HEAD` is absent.
- `MERGE_HAS_CONFLICTS` — the index still has stage-1/2/3 entries (delegated from `commit`).
- `BARE_REPOSITORY` — `continueMerge` cannot run in a bare repository.
- `NOT_A_REPOSITORY` — `.git/HEAD` is absent at the working directory.
- `HOOK_FAILED`, `AUTHOR_UNCONFIGURED`, `EMPTY_COMMIT_MESSAGE` — surfaced from the delegated `commit`.

## See also

- Related commands: [`merge`](merge.md), [`abortMerge`](abort-merge.md), [`commit`](commit.md).
- ADRs: [171](../../adr/171-no-operation-in-progress-error.md), [172](../../adr/172-flat-abort-continue-surface.md), [174](../../adr/174-continue-merge-delegates-to-commit.md)
- Roadmap: Phase 22 — `continueCherryPick`, `continueRebase`, `continueRevert` follow the same shape.
