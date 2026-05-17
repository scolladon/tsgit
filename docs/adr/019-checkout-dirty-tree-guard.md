# ADR-019: Checkout dirty-tree guard

## Status

Accepted (at `7e413881902fd6346edf2eec96109c1f136799dc`)

## Context

When `checkout` would overwrite an uncommitted local modification,
canonical git refuses with _"Your local changes to the following
files would be overwritten by checkout"_ and aborts. The user passes
`--force` to override.

For Phase 13.1, the question is: **how aggressive is the dirty-tree
check?**

- Option A — **Hash every touched file**. For each file that `add`/
  `update`/`delete` would touch, read it from disk and hash it.
  Compare to the index's recorded oid. Robust but O(touched bytes).
- Option B — **Stat-cache fast path then hash on mismatch**.
  `lstat` the file. If ctime/mtime/dev/ino/size/mode all match the
  index entry's recorded stat, the file is unchanged. Only on
  stat-mismatch do we read and hash.
- Option C — **Stat-only**. Trust the stat-cache without ever
  hashing. Faster, but a clock-skew or filesystem quirk could let
  a modified file slip through.

The existing `status` command (Phase 9.4) uses **Option B** —
stat-clean files are reported as unchanged without re-reading.
`isStatClean(entry, stat)` is already exported by
`src/domain/git-index/index-entry.ts`.

## Decision

Phase 13.1 uses **Option B** — the same stat-cache fast path that
`status` uses. The dirty-tree guard:

1. For each path that the changeset would `update` or `delete`:
   a. `lstat` the working-tree file.
   b. If `isStatClean(indexEntry, stat)` is true → safe (stat-clean
      means content unchanged).
   c. If stat-mismatch → read the file, hash it, compare to
      `indexEntry.id`. Equal → safe (stat-stale but content
      matches). Unequal → flag as dirty.
2. If any path was flagged → throw `WORKTREE_DIRTY` with the full
   list. Caller may retry with `force: true`.

For **untracked** paths (in target tree, not in current index):

1. `lstat` the path. If it does not exist → safe.
2. If it exists → flag as untracked-collision.
3. Throw `WORKTREE_UNTRACKED_OVERWRITE` with the list.

Both guards short-circuit on the first flag in a tight loop; the
error carries the full list because users want to fix them all
before retrying.

## Consequences

### Positive

- Reuses `isStatClean`, the same canonical check `status` uses.
  Behaviour is identical to what users already expect from
  `repo.status()`.
- Stat-clean files cost a single `lstat`; the hash path is only
  paid for genuinely stat-dirty files.
- The hash path is provably correct: if `lstat` shows a different
  mtime but the content actually matches the index, we don't
  spuriously reject (matches git's `--quiet` behaviour).

### Negative

- A clock-skewed filesystem or a `touch` that doesn't change
  content will fall into the hash path. We accept this — the
  hash path is fast enough on small files and rare enough on a
  healthy system.
- Adds one read + hash per stat-dirty path. On the 99.9% case
  (clean working tree), this is zero extra cost.

### Neutral

- Symlinks: `lstat` (not `stat`) is required so we don't follow
  the link. `FileSystem.lstat` is already on the port.
- Gitlinks: skipped entirely (submodule directories aren't
  content-checked at the parent level).

## Alternatives considered

- **Option A — always hash.** O(touched bytes) of extra I/O on
  every checkout. Rejected: makes the 99.9% case slow.
- **Option C — stat-only.** A `touch` that changes mtime but
  not content would falsely reject. Rejected.
