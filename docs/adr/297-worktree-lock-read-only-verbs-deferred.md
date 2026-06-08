# ADR-297: Lock is read-only here; `lock`/`unlock`/`prune` verbs deferred

## Status

Accepted (at `d346826a3c11535a5915627d30613870a69961d0`)

## Context

Backlog 24.2 scopes the `worktree` command to **add / list / move / remove**.
git also ships `worktree lock` / `unlock` / `prune` / `repair`. Two of the
in-scope verbs interact with lock state: `list` reports `locked`, and
`move`/`remove` refuse a locked worktree. So the lock **state** must be
observed, even though writing it is a different verb.

Separately, `git worktree add` to a sparse-checkout repo materialises only the
sparse subset; reproducing that needs sparse config to flow into the worktree
child Context.

## Decision

- **Read lock state, do not write it.** `list` reads `<admin>/locked` (presence
  ⇒ locked; trimmed content ⇒ reason) and `move`/`remove` honour it
  (`WORKTREE_LOCKED` unless forced). The `lock`/`unlock`/`prune`/`repair` verbs
  are out of scope for this PR (a later backlog item).
- **`prunable` is reported, not acted on.** `list` flags an admin entry whose
  worktree directory is gone; no automatic pruning happens here.
- **Sparse-checkout interaction on `add` is a documented non-goal.** A fresh
  linked worktree materialises the full start tree; sparse config is not
  inherited in v1.

## Consequences

### Positive

- `list`/`move`/`remove` are faithful for the common (locked-aware) cases
  without pulling the lock-writing verbs into this PR.
- Keeps the already-large single PR bounded to the four verbs.

### Negative

- A user cannot lock/unlock/prune via tsgit yet, and `add` ignores sparse
  config. Both are documented and tracked for follow-up.

### Neutral

- Lock reading and `prunable` detection are pure file probes — no new state
  machinery, so adding the write verbs later is additive.
