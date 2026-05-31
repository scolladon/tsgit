# `abortMerge`

End an in-progress conflicting merge. Hard-resets the working tree, index, and current branch to `ORIG_HEAD`, then deletes `MERGE_HEAD` and `MERGE_MSG`. `ORIG_HEAD` is preserved on disk as a cross-operation recovery aid (ADR-173). Mirrors `git merge --abort`.

## Signature

```ts
repo.abortMerge(): Promise<AbortMergeResult>;

interface AbortMergeResult {
  readonly origHead: ObjectId;
  readonly branch: RefName;
}
```

## Behaviour

- **Hard-reset semantics.** The working tree, index, and the current branch ref all move back to `ORIG_HEAD`. Files modified during the merge are overwritten. Pre-merge uncommitted local changes (if any) are lost — canonical git's `--merge` mode that preserves them is out of scope for v1 (ADR-170).
- **State files.** `MERGE_HEAD` and `MERGE_MSG` are deleted via `clearMergeState`. `ORIG_HEAD` is intentionally preserved — `repo.reset({ mode: 'hard', target: 'ORIG_HEAD' })` remains a meaningful follow-up after abort.
- **Reflog.** A conflicted merge never advanced the branch, so the abort is a no-move reset: the branch reflog gets **no** entry, and the coupled `HEAD` symref records `reset: moving to HEAD` — byte-faithful to `git merge --abort`.
- **Detached HEAD.** Rejected upstream (`merge` itself rejects starting on detached HEAD), so this command's defensive guard surfaces `UNSUPPORTED_OPERATION` if a synthetic state ever reaches it.
- **Sparse-aware.** The hard-reset honours an active sparse pattern; excluded paths remain unmaterialised with `skipWorktree: true`.

## Examples

```ts
const m = await repo.merge({ target: 'feature/x' });
if (m.kind === 'conflict') {
  const aborted = await repo.abortMerge();
  // aborted.origHead points at the pre-merge HEAD commit;
  // aborted.branch is the symbolic ref HEAD was on (e.g. refs/heads/main).
}
```

## Throws

- `NO_OPERATION_IN_PROGRESS` (`operation: 'merge'`) — `MERGE_HEAD` is absent, or present but `ORIG_HEAD` is missing (corrupt half-state).
- `BARE_REPOSITORY` — `abortMerge` cannot run in a bare repository.
- `NOT_A_REPOSITORY` — `.git/HEAD` is absent at the working directory.
- `UNSUPPORTED_OPERATION` — defensive: HEAD is detached at the time of abort.

## See also

- Related commands: [`merge`](merge.md), [`continueMerge`](continue-merge.md), [`reset`](reset.md) (`mode: 'hard'` to `ORIG_HEAD` is the manual equivalent).
- ADRs: [170](../../adr/170-abort-merge-hard-reset-semantics.md), [171](../../adr/171-no-operation-in-progress-error.md), [172](../../adr/172-flat-abort-continue-surface.md), [173](../../adr/173-abort-merge-preserves-orig-head.md)
- Roadmap: Phase 22 — `abortCherryPick`, `abortRebase`, `abortRevert` follow the same shape.
