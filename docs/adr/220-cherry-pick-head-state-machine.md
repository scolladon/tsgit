# ADR-220: dedicated `CHERRY_PICK_HEAD` state machine, distinct from `MERGE_HEAD`

## Status

Accepted (at `b4faeceb`)

## Context

A conflicting cherry-pick, like a conflicting merge, must persist resumable
state. The 20.4 merge machine (`MERGE_HEAD` + `continueMerge`/`abortMerge`)
exists, and `continueMerge` thin-wraps `commit`. The temptation is to reuse it.
But cherry-pick differs in two load-bearing ways:

1. The resulting commit is **single-parent** (parent = HEAD); a merge commit is
   two-parent (HEAD + `MERGE_HEAD`).
2. The commit **preserves the source commit's author** and message; a merge
   commit authors freshly.

`commit` already special-cases `MERGE_HEAD`: it lets the pending-op check pass,
adds `MERGE_HEAD` as a second parent, and clears merge state.

## Decision

Cherry-pick gets its **own** state machine keyed on `.git/CHERRY_PICK_HEAD`
(already in `PENDING_MARKERS`), with its own `continue`/`abort`/`skip`.
`cherryPick.continue` builds a single-parent commit from the resolved index with
the **preserved source author** — it is *not* a thin wrap of `commit`.

`commit` is taught to clear `CHERRY_PICK_HEAD` (so the manual "edit → add →
commit" resolution works), but **without** promoting it to a parent and with a
`commit (cherry-pick): <subject>` reflog (verified). At most one of
`MERGE_HEAD`/`CHERRY_PICK_HEAD` is ever set at once.

## Consequences

### Positive

- Faithful single-parent, author-preserving cherry-pick commits.
- The manual git resolution flow (`git commit` then `git cherry-pick --continue`)
  works unchanged.

### Negative

- `commit.ts` grows a second marker branch (merge vs cherry-pick); kept small by
  sharing the "resolving commit may clear its marker" seam.

### Neutral

- `continue` reuses `commit`'s helpers (`rejectUnmergedIndex`, tree-from-index,
  `resolveCommitter`) without inheriting its two-parent semantics.
