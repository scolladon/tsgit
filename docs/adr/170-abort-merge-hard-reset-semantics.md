# ADR-170: `abortMerge` uses hard-reset semantics

## Status

Accepted (at `f6678401f5a103a69747c81239b1d8e42a0d1fff`)

## Context

`git merge --abort` in canonical git is documented as equivalent to
`git reset --merge`. `reset --merge` is subtly different from
`reset --hard`: it tries to preserve uncommitted local changes that
existed *before* the merge started, on the theory that they're
orthogonal to the in-progress conflict and the user shouldn't lose
them.

`reset --merge` is non-trivial: it has to walk the working tree, the
index, and the merge sides to compute the path-set that's "safe to
keep" vs. "must be reverted". The implementation is around 200 lines
of canonical git's `merge.c` plus the `read-tree -m -u` plumbing.

tsgit's `merge` does NOT autostash today (canonical git's
`merge.autoStash` setting is out of scope for v1). And `merge`
explicitly rejects starting with a dirty working tree on the
conflict path — `materializeTree`'s dirty-tree guard would fire
upstream. So in practice, *the working tree is clean when a
conflicting merge starts*. There are no "pre-merge uncommitted local
changes" to preserve.

## Decision

`abortMerge` does a hard reset to `ORIG_HEAD` and clears the merge
state. Specifically:

1. Restore the working tree to `ORIG_HEAD`'s tree (every path
   rewritten — `materializeTree({ force: true, forceRewriteAll: true })`).
2. Rebuild the index from `ORIG_HEAD`'s tree (stage-0 entries only;
   drops the stage-1/2/3 conflict entries).
3. Update the branch ref to `ORIG_HEAD`.
4. Delete `MERGE_HEAD` and `MERGE_MSG`.
5. Preserve `ORIG_HEAD` on disk (per ADR-173).

The "preserve pre-merge local changes" semantic of `reset --merge` is
explicitly NOT implemented in v1.

## Consequences

### Positive

- **Simple, predictable behaviour.** The user knows exactly what
  state they'll have after `abortMerge`: HEAD == ORIG_HEAD, working
  tree == ORIG_HEAD's tree, index == ORIG_HEAD's tree.
- **Reuses existing machinery.** The implementation is the same
  `materializeTree` + index-commit pattern as `reset --hard`.
  No new pathways through the system.
- **No silent data preservation surprises.** Users can rely on
  abort being destructive of in-progress merge state — no
  half-preserved files lingering in the working tree.

### Negative

- **Diverges from canonical git's `reset --merge` semantic.** Users
  with the muscle memory of "I had uncommitted changes before the
  merge, abort will keep them" will be surprised. Mitigation:
  documented at the surface in `docs/use/merge.md` and the
  `RUNBOOK.md` recovery section.
- **Edge case: user staged unrelated files BEFORE running merge,
  then merge produced a conflict.** The staged files are lost.
  Canonical git's `reset --merge` would have preserved them.

### Neutral

- A future `reset --merge` mode (Phase 22 or later) could be wired
  into `abortMerge` once the underlying read-tree-three-way logic
  exists. The surface stays stable; only the destructiveness shrinks.
- The `merge` command's existing dirty-working-tree guard makes the
  edge case above rare in practice — the user typically can't even
  *start* a merge with uncommitted changes.

## Alternatives considered

- **Implement `reset --merge` semantics.** Rejected for v1: ~200
  lines of new logic to handle an edge case that the upstream
  dirty-tree guard already makes rare.
- **Make abort optional and lazy: just delete MERGE_HEAD/MERGE_MSG,
  leave working tree and index alone.** Rejected: this is closer
  to "delete the markers and hope" than "abort". Users would still
  have stage-1/2/3 entries blocking `commit` and marker bytes in
  files. Worse UX than the hard reset.
- **Call `reset({ mode: 'hard', target: origHead })` directly.**
  Rejected: `reset`'s first action is `assertNoPendingOperation`,
  which would fire on the very `MERGE_HEAD` we're trying to clear.
  Inlining the hard-reset path with the assert bypassed is cleaner
  than threading an `except: 'merge'` option through `reset`'s API.
