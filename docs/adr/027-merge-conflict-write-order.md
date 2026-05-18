# ADR-027: Conflicting-merge write order — working tree, ORIG_HEAD, MERGE_HEAD, MERGE_MSG, index

## Status

Accepted (at `3ca03a7a1820ee89b2b3e4bc3e902fb2c098b4e8`)

## Context

A conflicting merge writes five distinct kinds of disk state:

1. Working-tree files (marker bytes for content conflicts; full bytes
   for binary / add-add / modify-delete).
2. `.git/ORIG_HEAD` — the pre-merge HEAD's ObjectId, so the user can
   `reset --hard ORIG_HEAD` to abort.
3. `.git/MERGE_HEAD` — the merge target's ObjectId, so the user can
   resume / inspect.
4. `.git/MERGE_MSG` — the merge message draft.
5. `.git/index` — stage-0 entries for clean paths + stage-1/2/3
   entries for conflicting paths.

A crash between any two steps leaves an inconsistent on-disk state.
The question is: what ordering minimises the damage?

Considerations:
- The index lock (`acquireIndexLock`) serialises all index writes.
  Whatever happens to the index must happen under it.
- The user's recovery options after a crash depend on which pieces
  of state exist. The two failure modes that matter:
  - **A — merge state exists, but working tree / index hasn't been
    written.** The user runs `git merge --abort` (or our future
    equivalent) and gets back to a clean pre-merge state.
  - **B — working tree has markers, but merge state is missing.**
    The user is left with marker files but no signal that a merge
    was in progress. `assertNoPendingOperation` passes (MERGE_HEAD
    is absent), so a second `merge` call would conflict against the
    polluted working tree — bad.

## Decision

The write order is:

1. **Compute everything in memory** (markers, IndexEntry[], message).
2. **Acquire `index.lock`.**
3. **Write working-tree files** for each conflicting path. Crash
   here → user sees marker files but no MERGE_HEAD; recovery is
   manual but the state is greppable.
4. **Write `.git/ORIG_HEAD`.** Crash here → ORIG_HEAD points at the
   old HEAD; harmless (subsequent operations don't read ORIG_HEAD
   for state).
5. **Write `.git/MERGE_HEAD`.** Crash here → next mutation triggers
   `assertNoPendingOperation` and surfaces the in-progress merge.
6. **Write `.git/MERGE_MSG`.** Crash here → user has merge state
   minus the message; recovery is the user typing the message.
7. **Commit the index** via the lock (`index.lock` → `index`
   atomic rename).

Working-tree writes precede merge-state writes deliberately: the
worst-case crash window leaves the user with a clean (pre-merge)
index and a working tree that won't validate as clean. The user
can `git status` and see the markers, then either resolve or
`reset --hard ORIG_HEAD` to recover.

## Consequences

### Positive

- **No crash window leaves the index in a half-merged state.** The
  index is the LAST disk write; until it commits, the on-disk
  index still reflects pre-merge HEAD.
- **MERGE_HEAD's presence is the load-bearing recovery signal.**
  Once written, `assertNoPendingOperation` will surface the
  in-progress merge on the next mutation. We write it AFTER the
  working tree but BEFORE the index, so the signal is present
  even if the index commit fails.
- **The index lock guards the lifetime of the in-memory state.**
  Concurrent mutations can't slip in between working-tree writes
  and the index commit.

### Negative

- **The marker files can be left behind by a partial crash before
  MERGE_HEAD is written.** Without MERGE_HEAD, `assertNoPendingOperation`
  passes and the user might run another command unaware of the
  pollution. Mitigation: future `merge --abort` will diff the
  working tree against HEAD and surface marker-bearing files.
- **No fsync between steps.** Crash-safety relies on the FS's
  rename atomicity (for the index) and the OS's eventual durability
  of `writeUtf8`. The latter is best-effort — a power loss between
  step 5 and the disk flush could lose MERGE_HEAD. This is the
  same robustness story canonical git has.

### Neutral

- Matches `builtin/merge.c`'s effective ordering: canonical git
  writes the working tree, then MERGE_MSG, then MERGE_HEAD, then
  the index. Our ordering is close enough that user expectations
  carry over.
- The `index.lock` is held for the full duration. For a large
  conflict set this can serialise concurrent commands; acceptable
  given merges are user-initiated and rare.

## Alternatives considered

- **Index first, then everything else.** Rejected. If the working
  tree write crashes after the index commit, the user has a
  half-merged index pointing at stage-1/2/3 entries that don't
  exist on disk. Confusing and harder to recover.
- **MERGE_HEAD first, then working tree, then index.** Considered.
  Pro: the recovery signal is present from the very first write.
  Con: a crash after MERGE_HEAD but before working-tree writes
  leaves the user in an "in-progress merge with no markers"
  state — they can't see what to resolve. We chose to write
  working-tree files FIRST so the marker presence and MERGE_HEAD
  presence stay roughly in sync.
- **Lock-free.** Rejected — TOCTOU between read-index and
  commit-index. The existing `checkout` / `reset` pattern locks
  upfront for the same reason.
