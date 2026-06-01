# ADR-228: non-interactive `rebase` replays on a detached HEAD (merge backend)

## Status

Accepted (at `06489642`)

## Context

`cherry-pick` (22.1) and `revert` (22.2) commit directly on the current branch:
each pick advances `refs/heads/<b>` with its own reflog entry. Real `git rebase`
(the **merge backend**, default since 2.26) does **not** work that way. Verified
against git 2.54 (`GIT_*` scrubbed, signing off):

- HEAD is **detached at `onto`** (`rebase (start): checkout <onto>` on the `HEAD`
  reflog); the branch ref does not move during the replay.
- Each replayed commit advances the detached HEAD (`rebase (pick): <subject>`).
- Only at the end does `finish` update `refs/heads/<b>` to the new tip (one
  reflog entry `rebase (finish): refs/heads/<b> onto <onto-oid>`) and reattach
  HEAD (`rebase (finish): returning to <head-name>`).

This is **observable state**, not an implementation detail: mid-rebase
`.git/HEAD` holds a raw oid, `head-name` records the branch to reattach, and
`--abort` touches `HEAD` (not the branch). A cross-tool `git rebase --continue`
on a tsgit stop relies on it. The prime directive (ADR-226) therefore forces the
detached-HEAD model.

The alternative — replaying on the branch like cherry-pick (simpler, reuses the
exact 22.1 ref mechanics) — would produce a branch reflog with N `rebase (pick)`
entries and a non-detached mid-rebase HEAD, diverging from git in both the
reflog and the on-disk HEAD. Rejected: it violates faithfulness.

## Decision

tsgit's `rebase` replicates the merge-backend model: **detach HEAD at `onto`,
replay each commit on the detached HEAD, then update the branch and reattach
HEAD at `finish`**. The branch ref moves exactly once (at finish), never during
the replay. Each commit replay reuses cherry-pick's 3-way merge through the
shared `applyMergeToWorktree` primitive (`base = parent(C)`, `ours = running
detached HEAD`, `theirs = C`).

## Consequences

### Positive

- Byte-faithful HEAD + branch reflogs, faithful mid-rebase detached `.git/HEAD`,
  and a state shape `git rebase --continue` can consume.
- The replay engine is the same 3-way merge cherry-pick/revert already use.

### Negative

- More machinery than cherry-pick: a detach step, a HEAD-reattach finish, and a
  faithfully-different abort (HEAD reattach, not a branch reset — see ADR-232).

### Neutral

- Detached-HEAD rebase (`head-name = detached HEAD`) falls out naturally: the
  same model, with no branch to reattach (finish/abort target an oid).
