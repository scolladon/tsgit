# ADR-076: `merge` materialises conflicts even for sparse-excluded paths

## Status

Accepted (at `38f345e`)

## Context

[ADR-073](073-sparse-integration-scope.md) deferred `merge` sparse-awareness to
17.3a. A conflicting merge runs `persistConflictState` →
`writeConflictingWorkingTree`, which writes **every** path to the working tree:

- `writeOutcomeToTree` writes the *clean* outcomes — `unchanged`,
  `resolved-known`, `resolved-merged`, `resolved-deleted` — because a
  conflicting merge re-materialises the whole merged tree, not just the
  conflicts.
- `writeConflictToTree` writes the conflicted paths with conflict markers.

In a sparse repo this re-materialises excluded files. Making the clean-outcome
writes sparse-aware is obvious: skip the write for an excluded path. The
conflicted paths are the real question.

A conflict's index rows are stages 1/2/3. `skipWorktree` is a **stage-0-only**
flag — it has no representation on an unmerged entry. So the index cannot mark
a conflicted path "absent from the working tree" while the conflict is live.

Two options for a conflict on an excluded path:

1. **Skip writing it.** The index records stages 1/2/3, the file is absent.
   The user has an unmerged path they cannot see and cannot edit. To resolve it
   they must first realise it exists, then somehow surface it.
2. **Write it anyway.** The conflicted file lands on disk with markers, exactly
   as in a non-sparse repo. The user resolves it and `add`s it.

git itself takes option 2: a conflicted entry is materialised regardless of
skip-worktree (git clears the bit for the duration of the conflict).

## Decision

`merge`'s conflicting-merge path is made sparse-aware with an **asymmetric**
rule:

- **Clean outcomes** (`unchanged` / `resolved-known` / `resolved-merged`) for an
  excluded path are **not written** to the working tree. `resolved-deleted`
  needs no guard — an excluded file is already absent.
- **Conflicted paths are always written**, even when the matcher excludes them.
  A conflict the user cannot see is a conflict they cannot resolve.
- `buildConflictIndexEntries` sets `skipWorktree: true` on the **stage-0**
  entries it emits for excluded clean `unchanged` / `resolved-known` outcomes,
  so `status` does not report the un-written file as `deleted`. Conflict
  stage-1/2/3 rows are emitted unchanged.

The clean-merge path (`commitCleanMerge`) writes neither the index nor the
working tree, so it needs no change.

## Consequences

### Positive

- Git-faithful: a merge conflict is always resolvable, sparse or not.
- A sparse repo no longer re-materialises out-of-cone files on every
  conflicting merge — the 17.3a bug is fixed for the clean outcomes.
- `status` stays truthful after a conflicting merge: excluded clean paths carry
  skip-worktree, so they are not phantom `deleted` entries.

### Negative

- A conflicted out-of-cone file becomes transiently visible on disk. This is
  intentional and matches git, but a caller scripting against a strict sparse
  invariant must tolerate it for the duration of an unresolved conflict.
- The rule is asymmetric (clean outcomes skipped, conflicts written) — two
  behaviours in one command. Documented here and in the design doc.

### Neutral

- After the user resolves the conflict and `repo.add`s the path, `add` (already
  skip-worktree aware since 17.3) re-applies the sparse bit if the path is
  out-of-cone. 17.3a does not touch the resolution path.
- `resolved-merged` outcomes remain excluded from `buildConflictIndexEntries`
  (pre-existing behaviour); for an excluded such path the only change is that
  its working-tree write is skipped.
