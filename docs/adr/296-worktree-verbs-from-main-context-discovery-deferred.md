# ADR-296: Worktree verbs operate from the main Context; `openRepository` discovery deferred

## Status

Accepted (at `d346826a3c11535a5915627d30613870a69961d0`)

## Context

"Operating on worktrees" has two separable capabilities:

1. **Manage** linked worktrees — `list` / `add` / `move` / `remove` run from the
   main (or any already-open) worktree's Context, producing byte-faithful
   on-disk state.
2. **Operate as** a linked worktree — `openRepository(<linked-worktree-path>)`
   discovers the `.git` gitfile → admin dir → `commondir` at construction time,
   so every command works from *inside* a linked worktree as cwd.

Capability 2 needs runtime layout **discovery** changes (the node shim,
gitfile/commondir resolution) on top of the `commonDir` split (ADR-294).
Backlog 24.2 is the four management verbs; layout discovery is a distinct,
already-deferred concern (the facade's `RepositoryLayoutInput` comment notes
discovery is supplied by the runtime shim).

## Decision

Deliver the four management verbs (capability 1) in this PR. They operate from
the caller's Context and build worktree **child Contexts** internally (ADR-294's
split) for the materialise (`add`) and dirty-check (`remove`) steps. Defer
`openRepository`-from-inside-a-linked-worktree discovery (capability 2) to a
follow-up.

This is the scope the user selected: a single, cohesive PR with a bounded blast
radius (no runtime layout-discovery change).

## Consequences

### Positive

- The four verbs are fully faithful and functional now, pinned by
  `worktree-interop` against real git.
- The blast radius excludes the runtime shims and the layout-discovery code.

### Negative

- tsgit cannot yet be *opened* on a linked-worktree path; the verbs must be
  driven from an already-open repo. A follow-up will close this.

### Neutral

- ADR-294's split is exactly the substrate a later discovery item needs, so the
  follow-up is additive, not a rework.
