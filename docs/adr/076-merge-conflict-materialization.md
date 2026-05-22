# ADR-076: `merge` materialises in-memory-only content even for sparse-excluded paths

## Status

Accepted (at `38f345e`)

## Context

[ADR-073](073-sparse-integration-scope.md) deferred `merge` sparse-awareness to
17.3a. A conflicting merge runs `persistConflictState` →
`writeConflictingWorkingTree`, which writes **every** path to the working tree.

The outcomes a conflicting merge produces split by **where their content
lives**:

- **`unchanged` / `resolved-known`** — the content is a committed blob,
  addressed by an `ObjectId`. It is already in the object store; the
  working-tree write merely materialises a recoverable copy.
- **`resolved-merged`** — the file merged cleanly at the content level; its
  bytes are computed in memory. In the *conflicting*-merge path nothing hashes
  those bytes into a blob (unlike the clean-merge path, which does). The
  working-tree write is their **sole persistence**.
- **`conflict`** — the conflict-marker bytes likewise exist only in memory.
- **`resolved-deleted`** — no content; the file is removed.

Making blob-backed clean outcomes sparse-aware is obvious: skip the write for
an excluded path, since the content is recoverable. But skipping the write for
a `resolved-merged` or `conflict` path **destroys data** — there is no blob to
recover the merged/marker bytes from. And a conflict the user cannot see is a
conflict they cannot resolve. So the rule cannot be a blanket "skip excluded
paths".

A conflict's index rows are stages 1/2/3. `skipWorktree` is a **stage-0-only**
flag — it has no representation on an unmerged entry. git itself materialises a
conflicted entry regardless of skip-worktree.

## Decision

`merge`'s conflicting-merge path is made sparse-aware with a rule that gates on
**content provenance**, not on "clean vs conflict":

- **Blob-backed clean outcomes** (`unchanged` / `resolved-known`) for an
  excluded path are **not written** to the working tree — their content is a
  committed blob, recoverable on the next `checkout`/`reset`.
- **In-memory-only content is always written**, even when the matcher excludes
  the path: `resolved-merged` (the working-tree file is the sole home of the
  merged bytes) and `conflict` (an invisible conflict is unresolvable).
- `resolved-deleted` needs no guard — an excluded file is already absent and
  `removeWorkingTreeFile` is a no-op for it.
- `buildConflictIndexEntries` sets `skipWorktree: true` on the **stage-0**
  entries it emits for excluded `unchanged` / `resolved-known` outcomes, so
  `status` does not report the un-written file as `deleted`. Conflict
  stage-1/2/3 rows are emitted unchanged.

The clean-merge path (`commitCleanMerge`) writes neither the index nor the
working tree, so it needs no change.

## Consequences

### Positive

- Git-faithful: a merge conflict is always resolvable, sparse or not, and the
  merged bytes of a `resolved-merged` path are never silently lost.
- A sparse repo no longer re-materialises out-of-cone **blob-backed** files on
  every conflicting merge — the 17.3a bug is fixed where it is safe to fix.
- `status` stays truthful after a conflicting merge: excluded blob-backed paths
  carry skip-worktree, so they are not phantom `deleted` entries.

### Negative

- A conflicted or `resolved-merged` out-of-cone file becomes transiently
  visible on disk. This is intentional — its content has no other home — but a
  caller scripting against a strict sparse invariant must tolerate it until the
  merge is resolved and committed.
- The rule gates on content provenance (blob-backed vs in-memory), not on a
  single status field — two behaviours in one command. Documented here and in
  the design doc.

### Neutral

- After the user resolves the conflict and `repo.add`s the path, `add` (already
  skip-worktree aware since 17.3) re-applies the sparse bit if the path is
  out-of-cone. 17.3a does not touch the resolution path.
- `resolved-merged` outcomes remain excluded from `buildConflictIndexEntries`
  (pre-existing behaviour); 17.3a leaves their working-tree write in place for
  every path, so no merged content is dropped.
