# ADR-075: `reset` sparse integration — the matcher is authoritative over donor skip-worktree bits

## Status

Accepted (at `38f345e`)

## Context

[ADR-073](073-sparse-integration-scope.md) deferred `reset --hard` /
`reset --mixed` sparse-awareness to follow-up 17.3a. 17.3a now wires it in.

`reset --hard` is straightforward: it already calls `materializeTree`, which
carries the `sparse?: SparseMatcher` predicate, so it threads the matcher in
exactly as `checkout` does.

`reset --mixed` is the open question. It rebuilds the index from the target
commit's tree via `buildIndexFromTree`, **without touching the working tree**.
`buildIndexFromTree` uses a stat-cache **donor** strategy: when a path in the
target tree matches an index entry by `id` + `mode`, the donor entry's
stat-cache fields *and its `flags`* are reused (`{ ...donor.flags, stage: 0 }`).

That donor `flags` spread copies `skipWorktree`. So a question arises when
sparse is active: does the donor's skip-worktree bit win, or does the current
sparse matcher?

- If the **donor wins**: a path that was in-pattern before the reset but is
  excluded now keeps `skipWorktree: false` — `status` then reports the absent
  file as `deleted`. A path that was excluded before but is in-pattern now
  keeps `skipWorktree: true` — `status` hides a file that should be visible.
  Both are wrong.
- If the **matcher wins**: the rebuilt index always reflects the *current*
  patterns, which is exactly what a working tree already shaped by those
  patterns needs.

There is a second, smaller question. `reset --hard`'s index commit is guarded
by `written > 0 || deleted > 0`. Under sparse, an all-excluded target tree
writes and deletes nothing yet still changes the index (synthesised
skip-worktree entries whose `id` may differ from the pre-reset index).

## Decision

**For `reset --mixed`, when sparse is active the matcher is authoritative over
the skip-worktree bit.** `buildIndexFromTree` gains an optional
`sparse?: SparseMatcher`:

- An **excluded** path (`!matcher(path)`) is rebuilt as a zero-stat
  `skipWorktree: true` entry (the shared domain `skipWorktreeEntry` builder).
  The donor is ignored — the file is not on disk, its stats are meaningless.
- An **in-pattern** path clears any stale skip-worktree bit:
  `{ ...donorFlags, stage: 0, skipWorktree: false }`.
- When sparse is **inactive** (`sparse === undefined`), donor `flags` pass
  through verbatim (`{ ...donorFlags, stage: 0 }`) — a non-sparse repo where
  the user manually ran `git update-index --skip-worktree` keeps that bit,
  exactly as before 17.3a.

**For `reset --hard`, the index-commit guard widens to
`written > 0 || deleted > 0 || matcher !== undefined`.** When a matcher exists
the index is committed unconditionally — `checkout` already does this for the
identical reason. Non-sparse repos keep the narrower guard, so their behaviour
is byte-identical to before 17.3a.

## Consequences

### Positive

- A `reset --mixed` in a sparse repo produces an index whose skip-worktree bits
  match the working tree the patterns already shaped — `status` is truthful.
- `reset --hard` reuses `checkout`'s proven `materializeTree` sparse path; no
  new working-tree logic.
- Non-sparse `reset` is provably unchanged: the `sparse === undefined` branch
  preserves donor flags and the narrower commit guard.

### Negative

- `projectLeaf` gains a branch (`includedFlags`) split on `sparse !==
  undefined`. Two code paths to test — but each is small and independently
  unit-tested.

### Neutral

- A repo that hand-set skip-worktree bits *and* enabled `core.sparseCheckout`
  has those bits overwritten by the pattern matcher on the next
  `reset --mixed`. This matches git: with sparse-checkout enabled, the pattern
  file is the single source of truth for skip-worktree.
