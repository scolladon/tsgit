# ADR-196: `pull` reads strict upstream config; `clone` writes it

## Status

Accepted (at `1dbd41e`)

## Context

`pull` must decide what to merge after fetching. Stock git records the merge
source in per-branch upstream config that `clone` writes at clone time:

```ini
[remote "origin"]
	url = <url>
	fetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
	remote = origin
	merge = refs/heads/main
```

`pull` then reads `branch.<current>.remote` + `branch.<current>.merge` to find
the remote-tracking ref to integrate.

tsgit's `clone` writes **none** of this for a normal (non-partial) clone — only
partial clones write a `[remote "origin"]` block (via `writePromisorConfig`). A
strict, upstream-driven `pull` would therefore be unusable immediately after a
normal clone, and even `fetch` after a normal clone fails `REMOTE_NOT_CONFIGURED`
because `remote.origin.url` is absent.

Three options were weighed:

1. **Strict + clone writes upstream** — clone writes the remote block (all
   clones) and the `[branch …]` upstream block (non-detached clones); `pull`
   reads upstream strictly and errors when none is configured and no explicit
   args are given.
2. **Pull infers, clone untouched** — `remote` defaults to `origin`, merge
   branch defaults to the current branch name; both overridable. No clone
   change. Deviates from git (which errors when no upstream is configured).
3. **Hybrid** — clone writes upstream AND pull is lenient (falls back to
   current-branch when upstream is missing, never errors).

## Decision

Adopt option 1 (**strict + clone writes upstream**).

- `clone` writes `remote.origin.url` + `remote.origin.fetch` for **every** clone,
  and `branch.<head>.remote=origin` + `branch.<head>.merge=refs/heads/<head>`
  for non-detached clones. The existing partial-clone config (`promisor`,
  `partialclonefilter`, `extensions.partialClone`, `repositoryformatversion=1`)
  layers on top; `writePromisorConfig` is subsumed by a single
  `writeCloneConfig`.
- `pull` resolves the remote as `opts.remote ?? branch.<cur>.remote ?? 'origin'`
  and the merge branch as `opts.branch ?? short(branch.<cur>.merge)`; when
  neither yields a branch it throws a new `NO_UPSTREAM_CONFIGURED` error.

## Consequences

### Positive

- Most git-faithful on both ends: clone writes exactly what stock git writes;
  pull reads exactly what stock git reads.
- Closes a latent gap — normal clones now produce a working `[remote "origin"]`
  block, so `fetch`/`pull` work immediately after clone.
- No-arg `pull()` works on a freshly-cloned default branch; explicit
  `pull({ remote, branch })` always works; a locally-created upstream-less
  branch correctly requires an explicit branch.

### Negative

- Expands the scope of `clone` (config authoring) within the pull work.
- A locally-created branch with no upstream needs explicit `pull({ branch })`
  — same friction as stock git's "no tracking information" error.

### Neutral

- Adds the `NO_UPSTREAM_CONFIGURED` domain error code.
- git's "non-default remote requires an explicit branch" arg-parsing nicety is
  not replicated; pull defaults the branch from `branch.<cur>.merge` regardless
  of which remote is named (documented simplification).
