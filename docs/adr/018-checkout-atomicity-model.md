# ADR-018: Checkout atomicity model

## Status

Accepted (at `7e413881902fd6346edf2eec96109c1f136799dc`)

## Context

`checkout:materialize` writes, deletes, and chmods a working-tree
sized batch of files. The acceptance text says _"write/delete/chmod
files atomically"_. There are several plausible interpretations:

- **Atomic per file** — each individual file becomes new content
  atomically (tmp + rename), but partial progress across the batch
  is observable.
- **Atomic per batch** — the whole working tree update either
  succeeds or rolls back to the previous state.
- **Atomic transaction** — bracket the working tree with a journal
  that survives a crash and replays on next open.

Canonical git uses **atomic per file** and accepts partial progress
on crash; the user re-checkouts to recover. There is no journal.

Per-batch rollback would require either:

- Snapshotting every file the checkout will touch before writing.
  O(touched bytes) of extra disk + I/O. Forbidden on large
  checkouts.
- Writing every file to a side-tree and renaming the whole tree
  into place. The tree-rename strategy works only if the entire
  checkout root is rename-stable (it is not for typical
  checkouts that touch arbitrary subdirs).

A transactional journal is firmly outside v1 scope: needs crash-safe
log replay on next `openRepository`, recovery semantics, etc.

## Decision

Phase 13.1 implements **atomic per file**: each `fs.write` /
`fs.symlink` / `fs.rm` is the smallest atomic unit. Across the batch,
no rollback is provided.

Ordering across the batch is fixed:

1. **Working-tree writes / deletes / chmods.** Partial progress
   here is observable on crash; the index still points at the old
   tree so `status` flags the half-written files.
2. **Index commit.** Atomic via `acquireIndexLock` → `commit`
   (writes `index.lock` then renames over `index`).
3. **HEAD update.** Atomic via existing primitive (`writeSymbolicRef`
   or `writeUtf8('HEAD', oid)`).

A crash between any two steps leaves a recoverable state. The user
re-runs checkout; the dirty-tree guard either reports
`WORKTREE_DIRTY` (and they re-attempt with `force`) or the half-
written files get rewritten cleanly.

## Consequences

### Positive

- Matches canonical git's behaviour; no surprises for users
  migrating from `git checkout`.
- Zero extra I/O compared to a single-pass write.
- The recovery path is trivial: re-run `checkout`.
- Index integrity is preserved across crashes (existing
  `acquireIndexLock` invariant).

### Negative

- A crashed checkout leaves the working tree in an intermediate
  state. `status` will report half the new tree + half the old.
  The user is expected to re-checkout.
- No "all-or-nothing" guarantee on the working tree even with
  `force`.

### Neutral

- The user-visible API change is documented in the result shape
  (`changedPaths` is the count of writes + deletes that actually
  reached disk before any error).

## Alternatives considered

- **Snapshot-then-write.** O(touched bytes) extra I/O on every
  checkout. Rejected: cost is paid even on the 99.9% no-crash
  path.
- **Side-tree + tree-rename.** Doesn't compose with subtree
  checkouts. Rejected.
- **Journal + replay.** Crash-safe but requires a new on-disk
  format and replay logic on `openRepository`. Deferred to v2.
