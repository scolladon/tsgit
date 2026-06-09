# ADR-298: Worktree FS containment — a contained escape for out-of-workdir paths

## Status

Accepted (at `d346826a3c11535a5915627d30613870a69961d0`)

## Context

A linked worktree's working tree lives **outside** the repository's `workDir`
(git's canonical usage is a sibling — `git worktree add ../feature`). tsgit
confines all filesystem access to `workDir`:

- `wrapFsValidator` (node) throws `PATHSPEC_OUTSIDE_REPO` for any path not under
  `workDir` (a fixed root chosen at `openRepository` time).
- the memory adapter is rooted at a fixed `rootDir`.

So `add`'s materialise, the `.git` gitfile, `move`/`remove` of the worktree
directory, and `list`'s prunable existence check — all of which touch the
worktree directory — are blocked. Worktree paths are **dynamic** (chosen per
`add`), so they cannot be pre-allowlisted at open time, and a worktree child
Context needs to reach **two** disjoint subtrees: the worktree path (working-tree
files) and the common dir (objects + per-worktree admin state).

Confining worktrees under `workDir` would diverge from git (the prime
directive). Opening with `unsafeRawAdapters` would drop every guard. Neither is
acceptable as the default.

## Decision

Add a facade-provided capability to `Context`:

```ts
readonly worktreeFs?: (worktreePath: string) => FileSystem;
```

The facade implements it by re-wrapping the **raw** adapter fs with a
**multi-root** validator confined to exactly `[worktreePath, commonDir]` (plus
the existing config-scope escapes). `wrapFsValidator` is generalised to accept an
array of containment roots; a path is allowed iff it is contained in **any** root
(prefix check), so the worktree subtree and the shared object/admin subtree are
both reachable while everything else stays blocked. Under `unsafeRawAdapters` the
capability returns the raw fs (no validator), matching the existing opt-out.

Worktree commands:

- **validate** each worktree path before use — resolve to an absolute,
  normalised path and reject any `..` traversal segment;
- route worktree-directory I/O (materialise, gitfile, `move`/`remove`,
  `list` prunable check) through `ctx.worktreeFs?.(path) ?? ctx.fs`;
- keep admin/ref/object I/O on `ctx.fs` (the common dir is inside `workDir` for
  the main Context).

The worktree **child** Context (`deriveWorktreeContext`) uses
`ctx.worktreeFs?.(worktreePath) ?? ctx.fs` as its fs, so its object reads
(common dir) and working-tree writes (worktree path) both pass containment.

When `worktreeFs` is **unset** (memory/browser, which are inherently sandboxed
to a fixed root), worktrees are confined under that root — acceptable, since
those adapters are sandboxes, not real filesystems.

## Consequences

### Positive

- Worktrees work **anywhere** on the node adapter (`../sibling`, absolute),
  byte-faithful to git, the user's stated non-negotiable.
- The escape is **contained**: re-rooted at the validated worktree path + common
  dir, not the whole filesystem. The SSRF/path guards elsewhere are untouched.
- `wrapFsValidator` multi-root generalisation is backward compatible (a single
  root is the one-element case).

### Negative

- A new optional `Context` capability and a small facade closure. Worktree
  commands must remember to route worktree-dir I/O through `worktreeFs`.

### Neutral

- Memory/browser keep worktrees under their sandbox root; real-filesystem
  freedom is a node-adapter property, exercised by the interop suite.
