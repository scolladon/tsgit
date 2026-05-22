# ADR-073: Phase 17.3 integrates sparse into checkout/status/add; reset/merge deferred

## Status

Accepted (at `c85927a`)

## Context

git applies sparse-checkout rules in *every* operation that rewrites the
working tree — `checkout`, `reset --hard`, `reset --mixed`, `merge`, etc. all
route through `unpack-trees`, which is sparse-aware. A faithful tsgit could
likewise make every such command honour the skip-worktree bit.

But 17.3 is already a large feature (index v3, the sparse pattern engine, a
new command, a config writer). Touching `checkout`, `status`, `add`, `reset`
*and* `merge` in one change produces a PR that is hard to review and risks
regressions across unrelated commands. The workflow values atomic, reviewable
PRs.

## Decision

Phase 17.3 integrates sparse checkout into the commands where it is
**correctness-critical**, and **defers** the rest to follow-up **17.3a**.

**In scope:**

- **`checkout`** (branch switch) — the operation the feature is named for.
- **`status`** — without it, every excluded file reads as `deleted` and a
  sparse repo is permanently "dirty". The feature is unusable otherwise.
- **`add --all`** — without it, the post-walk removal pass stages every
  skip-worktree entry as a deletion; the next `commit` then drops those paths.
  This is corruption-adjacent, so it is mandatory.

**Deferred to 17.3a:**

- **`reset --hard`**, **`reset --mixed`**, **`merge`** sparse-awareness.

To keep the follow-up a *wiring* change rather than a redesign,
`materializeTree` carries the `sparse` predicate as an optional option. A
deferred command simply does not pass it yet; 17.3a wires it in.

## Consequences

### Positive

- A reviewable 17.3 PR scoped to a coherent, non-corrupting feature: you can
  set patterns, `checkout` honours them, and `status`/`add`/`commit` neither
  lie nor corrupt.
- The deferred commands need no redesign — the `materializeTree` predicate is
  already the integration seam.

### Negative

- `reset --hard` in a sparse repo re-materialises excluded files and drops
  their skip-worktree bits (it does not pass the predicate). `reset --mixed`
  rebuilds the index without the bits. This is a **documented sharp edge**,
  not silent corruption: the files come back, history is intact, and recovery
  is one `repo.sparseCheckout({ action: 'reapply' })`.
- `merge` likewise re-materialises excluded paths it touches.

### Neutral

- 17.3a is filed in `docs/BACKLOG.md`.
- The deferral is documented in `README.md` / `RUNBOOK.md` so users are not
  surprised.
