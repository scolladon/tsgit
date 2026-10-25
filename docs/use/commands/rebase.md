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
    upstream: string; // revision peeling to a commit: the fork-point side (`git rebase <upstream>`; `-` is `@{-1}`)
    onto?: string; // --onto <newbase>: replay onto this base instead of `upstream`
    interactive?: ReadonlyArray<RebaseInstruction>; // present → `rebase -i`
    rebaseMerges?: boolean | 'rebase-cousins' | 'no-rebase-cousins'; // --rebase-merges[=<mode>]
    autostash?: boolean; // --autostash / --no-autostash; unset reads rebase.autostash
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
- **Unrelated histories.** When `upstream` and `HEAD` share no common ancestor,
  `mergeBase` is empty and the **whole** `HEAD` history replays onto `onto` — the
  root commit against the empty-tree base (an add-add 3-way merge), faithful to
  `git rebase <unrelated>`.
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
- **Raw path bytes.** The replay carries non-UTF-8 path names byte-exact through the merge, the index and the new commits; results report the U+FFFD view.
- **Conflict path safety.** Before any conflict is materialised, every
  outcome/conflict path the replay is about to write is checked in one pass
  against git's own index-entry name rules (absolute path; `.`, `..`, or empty
  segment; `.git`/`.gitmodules` alias) — a hostile path anywhere in the set
  refuses the whole write with `INVALID_INDEX_ENTRY`, atomically, before the
  first byte lands, whether or not it is the path a straightforward per-entry
  write would reach first.
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
- **Gitlinks.** The pre-flight judges a staged gitlink change by its submodule
  ignore mode. A configured `none`, `dirty` or `untracked` refuses
  `WORKING_TREE_DIRTY` before HEAD moves, a gitlink removed from the index
  included; under `all`, or with no `.gitmodules` row, the change is let through
  and **carried**: the checkout of `onto` keeps it in the index and the replayed
  commit records it, a removal included. The ignore modes read by the pre-flight
  are kept for the whole run (git's in-process submodule config), so each pick
  judges the index by them even when `onto`'s `.gitmodules` differs.
- **Checkout of `onto`.** git's two-way rule decides what a staged path
  becomes: one HEAD and `onto` agree on is kept, one the index already holds as
  `onto` does is kept, anything else refuses `CHECKOUT_OVERWRITE_DIRTY
  { localChanges }` before HEAD moves, with nothing written.
- **First pick refused over a staged change.** When the todo opens with a pick, a
  staged change the pre-flight let through but the pick judges dirty (a gitlink
  move under only `diff.ignoreSubmodules = all`, which is porcelain-only) leaves
  git's rescheduled-pick state: `rebase-merge/` holding `done` (the refused pick
  included), `git-rebase-todo` with the pick, `end` and `msgnum`, no `message` or
  `author-script`, plus `REBASE_HEAD`, and the staged change is dropped by the
  hard reset of the detach. `continue` refuses `WORKING_TREE_DIRTY` again until
  the change is unstaged, then replays the pick, which `done` lists a second time
  as git's does; `skip` hard-resets and replays the rescheduled pick and the
  rest; `abort` restores the branch and hard-resets the index. A todo opening
  with a `label` or a `reset` (`--rebase-merges`) never refuses: the reset sets
  the index to `onto`'s tree, carried change included, before any pick runs.
- **Start checks out before HEAD moves.** `run` (flat or interactive, and the fast-forward onto `onto`) checks out `onto`'s tree as an unforced two-way checkout, before HEAD moves and before any rebase state is written. An untracked file or symlink in the way refuses (`untracked`; ignored ones are overwritten), leaving HEAD on the branch, the work tree and the absence of `rebase-merge/` as they were.
- **`abort`, `skip` and the `reset` step protect untracked files.** These reset like git's untracked-protecting hard reset: tracked paths are rewritten, an occupant is displaced as in [`reset`](reset.md#behaviour), and an untracked file or symlink where the reset adds a path (at the path or in a leading component), a directory holding an untracked file where it adds or deletes one, refuse with `WORKING_TREE_DIRTY`, every offending path listed in `untracked`. Ignored occupants are overwritten. A refused `abort` or `skip` keeps `rebase-merge/` and HEAD; a refused `reset <label>` step stays at the head of `git-rebase-todo` and at the end of `done`. The `skip` of an `edit` stop and of a rescheduled pick resets the same way. An unmerged path holding a directory with an untracked file refuses; a file there is overwritten.
- **A refused line is rescheduled.** A `pick`, `edit`, `reword`, `squash` or `fixup` line whose merge or checkout an untracked occupant refuses (fast-forwards included; on `run`, `continue` and `skip`, flat or interactive) throws `WORKING_TREE_DIRTY` and leaves git's rescheduled state: HEAD stays on the last replayed commit, the line heads `git-rebase-todo` and is appended to `done` (`msgnum` counts `done`; `end` counts `done` plus the todo minus one), `REBASE_HEAD` names the line's commit and `author-script` holds its author, and `amend`, `message`, `patch` and `stopped-sha` are removed. Inside a squash/fixup group the group files (`current-fixups` with the refused member, `rewritten-pending`, `message-squash`, and `message-fixup` for a fixup-only group) take their place. `continue` refuses a staged change (`localChanges`) and otherwise retries the line, which a second refusal appends to `done` once more; `skip` resets as above and retries it. A `merge -C` line keeps throwing without rescheduling.
- **State files for the empty-commit policy and the rewrite list.** `drop_redundant_commits` is written on a flat start only (git's `--empty=drop` default) and is absent from an interactive start, whose policy is to stop; a resume leaves the file as the start wrote it. `rewritten-list` is written only once it holds a rewrite.
- **Refusals.** A dirty index/working tree (`WORKING_TREE_DIRTY`), an operation
  already in progress (`OPERATION_IN_PROGRESS`), an unborn branch
  (`NO_INITIAL_COMMIT`), no work tree (`WORK_TREE_REQUIRED`).

## Autostash (`--autostash`)

With `autostash: true` (or `rebase.autostash`), a dirty tree is stashed as git's
`stash create "autostash"` does (`On <branch>: autostash`, logged `Created
autostash: <abbrev>`) and the tree reset before the rebase. The stash oid is kept in
`.git/rebase-merge/autostash` while the rebase is stopped. When the rebase finishes,
aborts, or turns out up to date, the stash is re-applied (`Applied autostash.`); a
conflicting or refused re-apply (any `TsgitError`, such as `MERGE_HAS_CONFLICTS` or
`STASH_APPLY_WOULD_OVERWRITE`) stores the stash in `refs/stash` with the reflog
message `autostash` and logs git's warning, carrying the refusal's `code` when
there was one.

## Recreating merges (`--rebase-merges`)

`rebaseMerges: true` (git's default `no-rebase-cousins`) or `'rebase-cousins'`
runs git's `--rebase-merges` todo instead of flattening the branch:

- **Todo.** git's script, byte for byte: `label onto`, one block per merged
  branch tip and per `HEAD`, each opened by `reset <label>` (a blank line before
  it), `pick` lines, `label branch-point` on a commit with several children,
  `label <name>` on each merged tip (its `refs/heads/` name, else the name the
  merge subject quotes, sanitized), and `merge -C <oid> <label> # <subject>`.
  Commits already upstream, and originally empty ones, are left out. A block
  rooted outside the range resets to that commit's abbreviation, unless
  `'rebase-cousins'` resets it `onto`.
- **Run.** A `label` names HEAD `refs/rewritten/<label>` (no reflog; the refs are
  deleted when the rebase finishes or aborts, `refs-to-delete` lists them on a
  stop). A `reset` moves HEAD (`rebase (reset): '<label>'`, no entry when HEAD
  does not move), the index following git's one-way merge: a staged gitlink
  change carried past the pre-flight becomes the label's entry, the submodule
  checkout left alone. A `pick` or `merge` whose parents are unchanged fast-forwards
  (`rebase: fast-forward`). Otherwise `merge -C` merges HEAD with the label and
  commits with the original message and author (`rebase (merge): <subject>`); a
  label HEAD already contains leaves the merge out.
- **Merge conflict.** Stops with `MERGE_HEAD` (no line feed), `MERGE_MODE`
  (`no-ff`), `MERGE_MSG` and `message` holding the original message, an empty
  `patch`, and the merge recorded in `rewritten-list` against HEAD, as git does.
  `continue` commits the two-parent merge (`rebase (continue): <subject>`);
  `skip` drops it.
- **Refusals.** `INVALID_OPTION` (`rebaseMerges`) alongside `interactive`;
  `UNSUPPORTED_OPERATION` for an octopus merge.

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
  (nothing to meld into), an empty/all-`drop` list, a `reword` without a
  `message`, or a `reword`/`squash` whose `message` cleans to empty all throw
  `INVALID_OPTION` — **before any state change** (HEAD never moves).
- **`post-rewrite amend`.** Each `squash` or `fixup` amends the group commit, so the `post-rewrite` hook also runs with `amend`, fed `<previous> <created>` for that commit, once per meld commit, besides the `rebase` call at the end.
- **Cross-stop messages (limitation).** Inline `reword`/`squash` messages are
  consumed during the single `run()` pass and are **not** carried across a stop.
  A `reword`/`squash` scheduled *after* a conflict or `edit` stop replays with
  its original / default message on `continue()`.

## Throws

- `WORKING_TREE_DIRTY` — `run` against a dirty index / working tree; `continue` while a refused first pick's staged change is still in the index.
- `CHECKOUT_OVERWRITE_DIRTY` — the checkout of `onto` would overwrite a staged path HEAD and `onto` disagree on and the index does not hold as `onto` does (`localChanges`); nothing is written.
  An untracked occupant of a path the checkout adds refuses the same way (`untracked`).
- `INVALID_INDEX_ENTRY` — a conflicting replay's outcome or conflict path fails
  git's own index-entry name rules. Every path the conflict write is about to
  touch is checked in one pass before any of them is written, so a hostile
  path anywhere in the batch refuses the whole write, atomically.
- `OPERATION_IN_PROGRESS` — another operation (merge / cherry-pick / revert /
  rebase) is already pending.
- `NO_INITIAL_COMMIT` — `run` on an unborn branch.
- `WORK_TREE_REQUIRED` — `run`/`continue`/`skip`/`abort` against a repository with no work tree (bare, or opened without one).
- `NO_OPERATION_IN_PROGRESS` — `continue`/`skip`/`abort` with no rebase in progress.
- `MERGE_HAS_CONFLICTS` — `continue` while the index still has unmerged entries.
- `AMBIGUOUS_OID_PREFIX` — an abbreviated `upstream`/`onto` matched more than one object.
- `INVALID_OPTION` — an interactive todo with an out-of-range `oid`, a leading
  `squash`/`fixup`, an empty/all-`drop` list, a `reword` without a `message`, or a
  `reword`/`squash` whose `message` cleans to empty.

See [`../errors.md`](../errors.md) for the canonical `TsgitError.data.code` list.

## See also

- Building block: [`cherryPick`](cherry-pick.md) (each replay is a cherry-pick)
- Primitives: [`mergeBase`](../primitives/merge-base.md), [`readObject`](../primitives/read-object.md)
