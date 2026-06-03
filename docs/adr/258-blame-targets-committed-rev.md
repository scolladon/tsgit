# ADR-258: `blame` targets a committed rev; working-tree pseudo-commit deferred

## Status

Accepted (at `33fa9f4f`)

## Context

The bare command `git blame <file>` (no rev) blames the **working-tree**
content: lines matching `HEAD` are attributed to their committing history, but
any *uncommitted* modification is attributed to a synthetic zero-oid pseudo-commit
rendered as `00000000 … Not Committed Yet`. `git blame <rev> -- <file>` instead
blames the committed content at `<rev>`.

tsgit's `blame` must pick what v1's `repo.blame(path, opts?)` targets. Forces:

- The prime directive favours replicating the bare command exactly, including the
  not-committed-yet pseudo-commit.
- But the pseudo-commit requires reading the **working tree** (a filesystem read,
  hashing the worktree blob, synthesising a fake commit/identity) — machinery the
  pure history walk does not otherwise need. tsgit runs on memory and browser
  adapters that frequently have **no working tree at all**; a worktree-only
  default is a poor fit for the library's primary surface.
- On a **clean** working tree, `git blame <file>` and `git blame HEAD -- <file>`
  produce identical data — the divergence is only over *uncommitted* changes.

## Decision

v1 `blame` targets a **committed rev**: `opts.rev` (default `HEAD`). It blames the
content of `rev:path` and never synthesises a not-committed-yet pseudo-commit.

This is a **faithful divergence** (recorded here per the prime directive): on a
clean tree `repo.blame('f')` equals `git blame -- f`; on a dirty tree it equals
`git blame HEAD -- f` rather than the bare `git blame f` (uncommitted lines blame
to their last committed state instead of the zero-oid pseudo-commit).

Faithfulness pinning (`blame-interop`) therefore reconstructs `git blame
<rev> --porcelain` (an explicit rev, committed content) — the surface v1
implements — not the bare working-tree form.

## Consequences

### Positive

- Adapter-agnostic: works identically on node, memory, and browser — no worktree
  dependency, matching how the library is predominantly used.
- Bounded v1: no worktree read, blob hashing, or synthetic-commit construction.
- The committed-rev path is the foundation the deferred working-tree mode layers
  on (it blames the worktree blob against `HEAD` as its first step).

### Negative

- `repo.blame('f')` on a **dirty** tree diverges from bare `git blame f`:
  uncommitted lines are attributed to their last committed state, not the
  `00000000` "Not Committed Yet" pseudo-commit. Documented; logged as a follow-up.

### Neutral

- A future working-tree-blame follow-up adds an opt-in (e.g. default-on
  worktree resolution when `rev` is omitted and a worktree exists) without
  changing the committed-rev semantics decided here.
