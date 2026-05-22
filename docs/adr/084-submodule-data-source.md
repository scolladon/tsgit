# ADR-084: Submodule data is read from a tree-ish, default `HEAD`

## Status

Accepted (at `2ad72af`)

## Context

A submodule has two on-disk representations:

- A **gitlink** — a tree entry, mode `160000`, whose object id is the commit
  the superproject pins.
- A row in **`.gitmodules`** — a tracked file in `.git/config` INI format,
  giving the submodule's name, url, and optional branch.

A walk must join the two. Where it reads them from is a choice:

- **Working tree + index.** `.gitmodules` from the working-tree file, the
  pinned commit from the index gitlink. This is what `git submodule status`
  does. It reflects uncommitted edits to `.gitmodules`, but it cannot run in a
  bare repository (no working tree), and its result depends on the checkout
  state — non-deterministic for a given commit.
- **A tree-ish.** Walk a commit/tree: gitlink entries give the pinned commits,
  the `.gitmodules` blob *in that same tree* gives the metadata. Works in bare
  repositories, deterministic for a given ref, and "recurse into `.gitmodules`"
  (the backlog wording) is literally a tree traversal.

tsgit supports bare repositories as a first-class target and prizes
deterministic, object-store-driven primitives. The library is an inspection
tool over committed history, not a working-tree status reporter.

## Decision

`walkSubmodules` reads from a **tree-ish**. The primitive takes
`ref?: RefName | ObjectId`; the command takes `ref?: string`. Both default to
`HEAD`.

`readTree` peels a commit/tag to its tree. The `.gitmodules` file is the
root-tree entry named `.gitmodules`; its blob is read from the object store,
not the filesystem. Gitlinks are located by a recursive `walkTree`.

The join is **gitlink-driven**: every mode-`160000` tree entry yields a
`SubmoduleEntry`; `.gitmodules` supplies `name`/`url`/`branch` when a row's
`path` matches the gitlink's path. A gitlink with no matching row still yields
(its `name` falls back to the path); a `.gitmodules` row with no matching
gitlink is dropped as stale config.

## Consequences

### Positive

- Works in bare repositories and on any historical commit, not just the
  current checkout.
- Deterministic: `submodules({ ref })` depends only on `ref`'s objects.
- No working-tree or index read — fewer moving parts, no `core.bare` branching.
- Gitlink-driven join is git-faithful: the tree is the source of truth for
  *what* is a submodule and *which commit* it pins; `.gitmodules` is advisory
  metadata.

### Negative

- Uncommitted edits to `.gitmodules` are invisible — a caller mid-edit sees
  the committed metadata. Acceptable: the library inspects committed state.
- Finding gitlinks needs a full recursive `walkTree`; it cannot be pruned to
  known submodule paths because gitlinks may exist with no `.gitmodules` row.

### Neutral

- An unborn `HEAD` (empty repo) makes the default call propagate `readTree`'s
  ref-resolution error — the same behaviour `log` already has resolving
  `HEAD`.
</content>
</invoke>
