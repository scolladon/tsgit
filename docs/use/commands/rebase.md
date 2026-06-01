# `rebase`

Replay the commits unique to the current branch on top of another base, faithful
to `git rebase` (the **merge backend**, default since git 2.26). HEAD is detached
at the new base, each commit is replayed as a cherry-pick (3-way merge through the
shared `applyMergeToWorktree` primitive — **source author preserved, current
committer**, single parent), then the branch is updated and HEAD reattached at
finish. Commits already present upstream (cherry-pick equivalents) are dropped by
patch-id. Conflicts stop under a byte-faithful, bidirectionally cross-tool
resumable `.git/rebase-merge/` state + `.git/REBASE_HEAD`.

Interactive editing (`rebase -i`) is supported via the `interactive` field — see
[Interactive](#interactive-rebase--i) below.

Nested namespace: `repo.rebase.{run, continue, skip, abort}`.

## Signature

```ts
interface RebaseNamespace {
  run(input: {
    upstream: string; // commit-ish: the fork-point side (`git rebase <upstream>`)
    onto?: string; // --onto <newbase>: replay onto this base instead of `upstream`
    interactive?: ReadonlyArray<RebaseInstruction>; // present → `rebase -i`
  }): Promise<RebaseResult>;

  continue(): Promise<RebaseResult>;
  skip(): Promise<RebaseResult>;
  abort(): Promise<{ head: ObjectId; headName: string }>;
}

interface RebaseInstruction {
  action: 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';
  oid: string; // a commit-ish in the `onto..HEAD` range
  message?: string; // reword (required) / squash (optional combined message)
}

type RebaseResult =
  | { kind: 'rebased'; commits: ReadonlyArray<{ source: ObjectId; created: ObjectId }> }
  | { kind: 'up-to-date' }
  | { kind: 'conflict'; commit: ObjectId; conflicts: ReadonlyArray<{ path: FilePath; type: ConflictType }>; remaining: number }
  | { kind: 'stopped'; commit: ObjectId; remaining: number }; // an `edit` pause
```

## Behaviour

- **Decision.** With `mergeBase = merge-base(upstream, HEAD)`: when `onto ===
  mergeBase` the branch already sits on `onto` → `{ kind: 'up-to-date' }` (no
  reflog, no state change); when `mergeBase === HEAD` it **fast-forwards** to
  `onto` (the rebase reflog dance, zero picks); otherwise it replays
  `mergeBase..HEAD` oldest-first.
- **`--onto`.** `run({ upstream: 'main', onto: 'newbase' })` replays
  `merge-base(main, HEAD)..HEAD` onto `newbase`.
- **Cherry-pick-equivalent drop.** A commit whose change is already upstream
  (compared by patch-id against `mergeBase..upstream`) is removed before the
  replay loop — git's default. It is never reapplied (no `rebase (pick)` reflog).
- **Reflogs.** `HEAD`: `rebase (start): checkout <onto>` · `rebase (pick):
  <subject>` per commit · `rebase (continue): <subject>` (the resolved commit) ·
  `rebase (finish): returning to <branch>`. The branch ref gets a single
  `rebase (finish): refs/heads/<b> onto <onto-oid>`; abort writes **no** branch
  entry (the branch never moved during the detached replay).
- **Conflict.** Returns `{ kind: 'conflict', ... }`, leaving HEAD detached at the
  last good pick and writing the full `.git/rebase-merge/` state + `REBASE_HEAD`.
  Resolve with `repo.add(paths)` then `repo.rebase.continue()`.
- **Resume.** `continue` commits the resolution (preserved author from
  `author-script`, current committer, `rebase (continue)` reflog) and replays the
  rest; `skip` discards the conflicted commit and replays the rest; `abort`
  hard-resets the working tree + index to the pre-rebase tip and reattaches
  `head-name` (`rebase (abort): returning to <name>`). The `.git/rebase-merge/`
  state is byte-faithful to git, so a tsgit-started rebase can be finished with
  `git rebase --continue`, and vice-versa.
- **Detached HEAD.** Rebasing a detached HEAD records `head-name = detached HEAD`;
  finish leaves HEAD at the new tip (no `returning to` entry), abort returns HEAD
  to the original oid.
- **Refusals.** A dirty index/working tree (`WORKING_TREE_DIRTY`), an operation
  already in progress (`OPERATION_IN_PROGRESS`), an unborn branch
  (`NO_INITIAL_COMMIT`), a bare repository (`BARE_REPOSITORY`).

## Interactive (`rebase -i`)

Passing `interactive` selects the interactive engine: the array **is** the
post-`$EDITOR` todo (a library has no editor — you supply the edited instruction
list as data). It is processed top-to-bottom, replacing the default
pick-everything todo. The non-interactive path (no `interactive` field) is
unchanged.

```ts
await repo.rebase.run({
  upstream: 'HEAD~3',
  interactive: [
    { action: 'pick',   oid: a },
    { action: 'reword', oid: b, message: 'clearer subject' },
    { action: 'squash', oid: c }, // melds into b's reworded commit
    { action: 'drop',   oid: d },
  ],
});
```

- **Verbs.** `pick` (replay), `reword` (replay + amend message), `edit` (replay
  then pause for amending), `squash` (meld into the previous commit, combining
  messages), `fixup` (meld keeping only the previous message), `drop` (skip).
- **Messages.** `reword` requires `message`; `squash` takes an optional
  `message` (the combined message), defaulting to git's combination template.
- **Fast-forward.** Unchanged leading picks fold into `rebase (start)` and any
  commit that linearly continues HEAD is fast-forwarded (original oid kept) — an
  all-`pick` `-i` is a byte-identical no-op, exactly like git.
- **`edit`.** Returns `{ kind: 'stopped', commit, remaining }` with HEAD detached
  at the produced commit and an `amend` marker on disk. Amend the tree (e.g.
  `repo.add(...)`), then `continue()` (an unchanged tree keeps the commit; a
  changed tree amends it). `skip()` drops the edit; `abort()` unwinds.
- **squash/fixup chains.** Reproduced faithfully — each member commits with the
  running combination template, cleaned only at the group's end (ADR-237).
- **Refusals.** An `oid` outside the replayed range, a leading `squash`/`fixup`
  (nothing to meld into), an empty/all-`drop` list, or a `reword` without a
  `message` all throw `INVALID_OPTION`.
- **Cross-stop messages (limitation).** Inline `reword`/`squash` messages are
  consumed during the single `run()` pass and are **not** carried across a stop.
  A `reword`/`squash` scheduled *after* a conflict or `edit` stop replays with
  its original / default message on `continue()`.

## Throws

- `WORKING_TREE_DIRTY` — `run` against a dirty index / working tree.
- `OPERATION_IN_PROGRESS` — another operation (merge / cherry-pick / revert /
  rebase) is already pending.
- `NO_INITIAL_COMMIT` — `run` on an unborn branch.
- `BARE_REPOSITORY` — `run`/`continue`/`skip`/`abort` in a bare repository.
- `NO_OPERATION_IN_PROGRESS` — `continue`/`skip`/`abort` with no rebase in progress.
- `UNSUPPORTED_OPERATION` — no common ancestor between HEAD and upstream
  (`--root` is not supported in v1).
- `MERGE_HAS_CONFLICTS` — `continue` while the index still has unmerged entries.
- `AMBIGUOUS_OID_PREFIX` — an abbreviated `upstream`/`onto` matched more than one object.
- `INVALID_OPTION` — an interactive todo with an out-of-range `oid`, a leading
  `squash`/`fixup`, an empty/all-`drop` list, or a `reword` without a `message`.

See [`../errors.md`](../errors.md) for the canonical `TsgitError.data.code` list.

## See also

- Building block: [`cherryPick`](cherry-pick.md) (each replay is a cherry-pick)
- Primitives: [`mergeBase`](../primitives/merge-base.md), [`readObject`](../primitives/read-object.md)
