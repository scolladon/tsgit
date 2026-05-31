# `cherryPick`

Apply the change introduced by one or more commits onto the current `HEAD`,
creating one new **single-parent** commit per picked commit — faithful to
`git cherry-pick`. Each new commit **preserves the source author and message**;
the committer becomes the current identity. The patch is a 3-way merge
(`base = parent(C)`, `ours = HEAD`, `theirs = C`). Conflicts and empty picks
stop under a dedicated `CHERRY_PICK_HEAD` state machine (distinct from
`MERGE_HEAD`), and a range / multi-arg run uses a git-byte-faithful,
bidirectionally cross-tool-resumable `.git/sequencer/` work-list.

Nested namespace: `repo.cherryPick.{run, continue, skip, abort}`.

## Signature

```ts
interface CherryPickNamespace {
  run(input: {
    commits: ReadonlyArray<string>; // commit-ish (ref/oid/abbrev/tag) or `A..B` range, in argv order
    recordOrigin?: boolean; // -x: append "(cherry picked from commit <oid>)"
    allowEmpty?: boolean; // --allow-empty: commit a redundant pick instead of stopping
    noCommit?: boolean; // -n: apply to index + working tree only, never commit
  }): Promise<CherryPickResult>;

  continue(input?: { allowEmpty?: boolean }): Promise<CherryPickResult>;
  skip(input?: { allowEmpty?: boolean }): Promise<CherryPickResult>;
  abort(): Promise<{ head: ObjectId; branch: RefName }>;
}

type CherryPickResult =
  | { kind: 'picked'; commits: ReadonlyArray<{ source: ObjectId; created: ObjectId }> }
  | { kind: 'no-commit'; sources: ReadonlyArray<ObjectId> } // -n
  | { kind: 'conflict'; commit: ObjectId; conflicts: ReadonlyArray<{ path: FilePath; type: ConflictType }>; remaining: number }
  | { kind: 'empty'; commit: ObjectId; remaining: number };
```

## Behaviour

- **Single vs range.** `commits: ['feature']` picks one commit; `commits:
  ['main..feature']` expands the range oldest-first. `A...B` / `^`-exclusion
  forms are rejected (`INVALID_OPTION`), never mis-expanded.
- **Conflict.** Returns `{ kind: 'conflict', ... }`, writing `CHERRY_PICK_HEAD`,
  a `MERGE_MSG` draft (with a `# Conflicts:` block), stage-1/2/3 index entries,
  and `<<<<<<<` markers. Resolve with `repo.add(paths)` then
  `repo.cherryPick.continue()` (or `repo.commit()` — both keep a single parent).
- **Empty.** A redundant pick stops as `{ kind: 'empty' }`; `--allow-empty`
  commits it.
- **Range resume.** A mid-range stop persists `.git/sequencer/{head,todo,
  abort-safety,opts}`. `continue` finishes the rest; `skip` drops the current
  pick and resumes; `abort` resets the working tree, index, and branch to the
  pre-sequence `HEAD`. The sequencer is byte-faithful to git, so a tsgit-started
  range can be finished with `git cherry-pick --continue`, and vice-versa.
- **Merge commits.** Picking a merge commit (≥2 parents) without a mainline
  refuses with `CHERRY_PICK_MERGE_NO_MAINLINE`; in a range, earlier picks are
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
- `OPERATION_IN_PROGRESS` — another operation (merge / rebase / cherry-pick)
  is already pending.
- `NO_OPERATION_IN_PROGRESS` — `continue`/`skip`/`abort` with nothing in progress.
- `INVALID_OPTION` — an unsupported revision form (`A...B`, `^`-exclusion).
- `CHERRY_PICK_MERGE_NO_MAINLINE` — picking a merge commit (≥2 parents) without `-m`.
- `AMBIGUOUS_OID_PREFIX` — an abbreviated commit-ish matched more than one object.
- `INVALID_SEQUENCER_TODO` — a corrupt `.git/sequencer/todo` on resume.
- `MERGE_HAS_CONFLICTS` — `continue` while the index still has unmerged entries.

See [`../errors.md`](../errors.md) for the canonical `TsgitError.data.code` list.

## See also

- Primitives: [`mergeBase`](../primitives/merge-base.md), [`readObject`](../primitives/read-object.md)
- Related commands: [`merge`](merge.md) · [`revParse`](rev-parse.md) · [`commit`](commit.md)
- Recipes: [`../recipes.md`](../recipes.md)
- ADRs: 217–222
- Roadmap: Phase 22.1
