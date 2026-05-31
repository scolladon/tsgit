# `revert`

Record new commits that **undo** the changes introduced by existing commits —
the inverse of `cherry-pick`, faithful to `git revert`. Each revert is a new
**single-parent** commit whose **author and committer are the current identity**
(not the reverted commit's author), with the default message
`Revert "<subject>"` / `This reverts commit <oid>.`. The patch is the **reverse**
3-way merge (`base = C`, `ours = HEAD`, `theirs = parent(C)`). Conflicts stop
under a dedicated `REVERT_HEAD` state machine; a range / multi-arg run uses a
git-byte-faithful, bidirectionally cross-tool-resumable `.git/sequencer/`
work-list (`revert <oid> <subject>` lines).

Nested namespace: `repo.revert.{run, continue, skip, abort}`.

## Signature

```ts
interface RevertNamespace {
  run(input: {
    commits: ReadonlyArray<string>; // commit-ish (ref/oid/abbrev/tag) or `A..B` range, in argv order
    noCommit?: boolean; // -n: apply to index + working tree only, never commit
  }): Promise<RevertResult>;

  continue(): Promise<RevertResult>;
  skip(): Promise<RevertResult>;
  abort(): Promise<{ head: ObjectId; branch: RefName }>;
}

type RevertResult =
  | { kind: 'reverted'; commits: ReadonlyArray<{ source: ObjectId; created: ObjectId }> }
  | { kind: 'no-commit'; sources: ReadonlyArray<ObjectId> } // -n
  | { kind: 'conflict'; commit: ObjectId; conflicts: ReadonlyArray<{ path: FilePath; type: ConflictType }>; remaining: number }
  | { kind: 'empty'; commit: ObjectId; remaining: number };
```

## Behaviour

- **Single vs range.** `commits: ['HEAD']` reverts one commit; `commits:
  ['main..HEAD']` expands the range **newest-first** (to undo a span you revert
  its tip first — the opposite of cherry-pick). `A...B` / `^`-exclusion forms are
  rejected (`INVALID_OPTION`), never mis-expanded.
- **Conflict.** Returns `{ kind: 'conflict', ... }`, writing `REVERT_HEAD`, a
  `MERGE_MSG` draft (the `Revert "…"` message plus a `# Conflicts:` block),
  stage-1/2/3 index entries, and `<<<<<<<` markers. Resolve with
  `repo.add(paths)` then `repo.revert.continue()` (or `repo.commit()` — both keep
  a single parent and write a plain `commit:` reflog).
- **Empty.** `git revert` has no `--allow-empty`. A revert that yields no net
  change stops as `{ kind: 'empty' }` with **no** `REVERT_HEAD`: a single revert
  writes no state, a multi-revert persists only the sequencer. `skip` and
  `continue` drop the empty and proceed; to keep it, resolve with
  `repo.commit({ allowEmpty: true })`.
- **Range resume.** A mid-range stop persists `.git/sequencer/{head,todo,
  abort-safety}`. `continue` finishes the rest; `skip` drops the current revert
  and resumes; `abort` resets the working tree, index, and branch to the
  pre-sequence `HEAD` (with git's `reset: moving to <oid>` reflog). The sequencer
  is byte-faithful to git, so a tsgit-started range can be finished with
  `git revert --continue`, and vice-versa.
- **Merge commits.** Reverting a merge commit (≥2 parents) without a mainline
  refuses with `REVERT_MERGE_NO_MAINLINE`; in a range, earlier reverts are
  committed and the sequence stops at the merge (git-faithful partial-apply).
- **Refusals.** Detached HEAD (`UNSUPPORTED_OPERATION`), unborn branch
  (`NO_INITIAL_COMMIT`), a dirty index/working tree (`WORKING_TREE_DIRTY`,
  git's `require_clean_work_tree`), and an operation already in progress
  (`OPERATION_IN_PROGRESS`).

## Throws

- `UNSUPPORTED_OPERATION` — `run`/`continue`/`skip`/`abort` with a detached HEAD.
- `NO_INITIAL_COMMIT` — `run` on an unborn branch (no commit yet).
- `WORKING_TREE_DIRTY` — `run` against a dirty index / working tree
  (git's `require_clean_work_tree`).
- `OPERATION_IN_PROGRESS` — another operation (merge / cherry-pick / revert)
  is already pending.
- `NO_OPERATION_IN_PROGRESS` — `continue`/`skip`/`abort` with nothing in progress.
- `INVALID_OPTION` — an unsupported revision form (`A...B`, `^`-exclusion).
- `REVERT_MERGE_NO_MAINLINE` — reverting a merge commit (≥2 parents) without `-m`.
- `AMBIGUOUS_OID_PREFIX` — an abbreviated commit-ish matched more than one object.
- `INVALID_SEQUENCER_TODO` — a corrupt `.git/sequencer/todo` on resume.
- `MERGE_HAS_CONFLICTS` — `continue` while the index still has unmerged entries.

See [`../errors.md`](../errors.md) for the canonical `TsgitError.data.code` list.

## See also

- Inverse: [`cherryPick`](cherry-pick.md)
- Primitives: [`mergeBase`](../primitives/merge-base.md), [`readObject`](../primitives/read-object.md)
