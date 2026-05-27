# ADR-149: Snapshots are lazy descriptions, not eager parses

## Status

Accepted (at `1c35bc3`)

## Context

A snapshot represents a sorted set of `(path, mode, oid?, stat?)` entries
from one source (tree, commit, index, workdir, mergeHead, etc.). The
construction-vs-iteration question: when does the parse / enumeration cost
land?

Two models:

1. **Eager** — construction parses the source. `repo.snapshot.index()` reads
   and parses `.git/index` immediately; iteration just streams from memory.
2. **Lazy** — construction is free; first iteration triggers parse.

isomorphic-git's `walk` is implicitly eager via `WALKER` factory functions
that immediately bind to fs/dir. Cost is hidden behind the factory call.

## Decision

Construction is free. A snapshot stores at most: source kind, root identifier
(`commitOid` / `treeOid` / nothing for index/workdir), pathspec, options. No
I/O, no parse, no syscall. Iteration is the only cost.

For mutable sources (index, workdir), iteration triggers a first-touch parse;
the parsed value is cached on the snapshot handle for its lifetime. Multiple
iterations of the same snapshot reuse the cache. Multiple snapshots passed
to the same `join({...})` call share the cache via the resolver layer.

## Consequences

### Positive

- `repo.snapshot.head()` is sync and trivial. Users can construct N snapshots
  in a hot loop without paying anything; only the ones iterated cost.
- `join({head, index, workdir})` becomes cheap to set up; the work starts on
  the first `for await`.
- Removes the "did I just trigger I/O?" anxiety that haunts isomorphic-git.
  Construction is provably free; iteration is the only async surface.
- Consistent mental model across every snapshot kind.

### Negative

- First-iteration cost is delayed relative to construction. Users tracing perf
  must look at iteration, not factory call. Mitigated: iteration is `for await`,
  obviously async, and explicit.

### Neutral

- Tree/commit snapshots cache by `oid` (content-addressed, immutable).
- Index snapshots cache parsed value + generation; invalidated per ADR-150.
- Workdir snapshots cache per-row lstat, not globally.
