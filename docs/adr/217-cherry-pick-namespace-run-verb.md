# ADR-217: `cherry-pick` as a `repo.cherryPick.{run,continue,abort,skip}` namespace

## Status

Accepted (at `b4faeceb`)

## Context

`cherry-pick` is a multi-verb porcelain: the pick itself plus the
in-progress-operation verbs `--continue` / `--abort` / `--skip`. The codebase
offers two precedents: top-level bound functions (`merge`, `continueMerge`,
`abortMerge`) and frozen nested namespaces (`stash`, `branch`, `config`, …, per
ADR-181/192/193). The `merge` family pre-dates the namespace convention.

The primary verb also needs a name: git's noun is "cherry-pick", but the
namespace is already `cherryPick`, so the method needs its own word.

## Decision

Ship a **frozen, non-callable nested namespace** `repo.cherryPick` with verbs
`run` / `continue` / `abort` / `skip`, bound via `bindCherryPickNamespace`
mirroring `bindStashNamespace`. The primary verb is **`run`**
(`repo.cherryPick.run({ commits })`).

`continue`/`abort`/`skip` are cherry-pick-specific (they drive
`CHERRY_PICK_HEAD` + the sequencer, ADR-220), distinct from the `merge` family's
`continueMerge`/`abortMerge` (which drive `MERGE_HEAD`).

## Consequences

### Positive

- Consistent with every post-ADR-181 multi-verb surface; one binding idiom.
- `run`/`continue`/`abort`/`skip` read as a cohesive operation group.

### Negative

- A fifth nested namespace to maintain; `cherryPick.run` is slightly more verbose
  than a bare `cherryPick(...)` call (ruled out by ADR-193's non-callable rule).

### Neutral

- `run` over `pick`/`apply`: `cherryPick.pick` stutters; `apply` collides with
  the 3-way "apply" vocabulary (`applyMergeToWorktree`, `stash.apply`).
