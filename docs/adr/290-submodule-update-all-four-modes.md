# ADR-290: `submodule update` implements all four modes (checkout / rebase / merge / none) faithfully

## Status

Accepted (at `6adba128c25b`)

## Context

git's `submodule.<name>.update` (and `git submodule update --rebase`/`--merge`)
selects how the pinned commit is brought into the submodule worktree:

- `checkout` (default) — **detached** checkout of the pinned oid.
- `rebase` — `git rebase <pinned>` on the submodule's current branch.
- `merge` — `git merge <pinned>` into the submodule's current branch.
- `none` — skip the submodule.

Verified against git 2.54: `update --rebase` emits `rebase (start)/(finish)`
reflog entries and stays **on the branch**; `update --merge` runs an ordinary
merge. The alternative considered was checkout-only, refusing rebase/merge.

## Decision

Implement all four. On the submodule's child `Context`:

- `checkout` → `checkout(child, { rev: pinned, detach: true })` (skipped when the
  module HEAD already equals the pinned oid — git's idempotent no-op).
- `rebase` → `rebaseRun(child, { upstream: pinned })`.
- `merge` → `mergeRun(child, { rev: pinned })`.
- `none` → skip.

The mode is read from `submodule.<name>.update` in `.gitmodules`/config via 24.1a's
`parseUpdateMode` (already a four-value union). rebase/merge **delegate to the
existing, already-faithful `rebaseRun`/`mergeRun` commands** — their reflog,
conflict-state files (`rebase-merge/`, `MERGE_HEAD`), and refusal conditions are
inherited unchanged. A conflict during a submodule rebase/merge surfaces exactly
as the underlying command surfaces it (the submodule is left mid-operation, the
verb reports the failure); resolving/continuing is done through the submodule's
own `repo.rebase`/`repo.merge`, not re-driven by `update`.

## Consequences

### Positive

- Byte-faithful to git across all configured update modes — no silent divergence.
- Zero new merge/rebase logic: the heavy machinery is reused on the child context.

### Negative

- rebase/merge modes require the submodule to be on a branch (mergeRun refuses a
  detached HEAD); this matches git's own precondition and is documented.
- Wider interop surface (a rebase fixture + a merge fixture) than checkout-only.

### Neutral

- The pinned oid must already be present in the module objects (see ADR-291); for
  rebase/merge that is the realistic case (the commit was fetched at clone time).
