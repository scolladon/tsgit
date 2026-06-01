# ADR-235: replicate git's fast-forward fold + per-instruction fast-forward

## Status

Accepted (at `2e17819f`)

## Context

The interactive merge backend does **not** re-create every commit. Verified
against git 2.54:

- After `checkout <onto>` it fast-forwards the **maximal leading run of `pick`
  instructions that linearly continue HEAD** and folds them into the single
  `rebase (start): checkout <ontoName>` reflog entry — whose target oid is the
  *last folded commit*, not `onto` (the `onto` file still records the true onto).
- Thereafter, any `pick`/`reword`/`edit` whose commit linearly continues the
  running HEAD is **fast-forwarded** (`rebase: fast-forward`, original oid kept)
  rather than cherry-picked.

A commit `C` linearly continues the running detached HEAD `H` iff
`C.parents[0] === H`. The consequence is sharp: an **all-`pick` interactive
rebase onto the fork is a complete no-op** — every commit folds into `start` and
history is byte-identical, oids and committer dates intact.

Re-creating commits instead (fresh committer timestamps → new oids, a
`rebase (pick)` per instruction) is simpler but rewrites *untouched* commits on
**every** `-i` invocation — a large, ever-present divergence in oids, committer
dates, and reflog content.

## Decision

**Replicate the fast-forward behaviour in full.** The engine threads the running
detached HEAD `H` and, per instruction, branches on `C.parents[0] === H`:

- **leading `pick` run** (before the first non-`pick` verb or first
  non-continuing pick) → folded; `H` advances with no per-commit reflog; one
  `rebase (start): checkout <ontoName>` records the folded position.
- **`pick` that continues** → `rebase: fast-forward`, keep oid.
- **`pick` that does not** → 3-way cherry-pick, `rebase (pick): <subject>`.
- `reword`/`edit` reuse the same continue/cherry-pick split to *produce* their
  commit before amending/stopping.

The single `C.parents[0] === H` predicate drives all of it, so the added logic is
small relative to its faithfulness payoff, and it honours ADR-226 with no
divergence to document.

## Consequences

### Positive

- Byte-faithful reflogs (`rebase (start)` target, `rebase: fast-forward`),
  preserved oids/committer-dates for untouched commits, and a true no-op for an
  all-`pick` `-i` — exactly git.
- The non-interactive path (22.3), which always cherry-picks because its `onto`
  differs from the fork, is unaffected; the fast-forward branch is new logic on
  the shared `replayOne`.

### Negative

- More branching in the replay engine than an always-recreate loop, and an
  extra "compute the leading fold, then record `start` at the folded oid" step
  that the non-interactive detach did not need.

### Neutral

- `rewritten-list` for a fast-forwarded commit maps `old → old` (oid unchanged);
  pinned against git during implementation.
