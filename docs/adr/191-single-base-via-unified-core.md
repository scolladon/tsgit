# ADR-191: Single-base merge-base routes through the unified core

## Status

Accepted (at `c232f238a1b7b45c9513b09b4c11c78aa6da430b`)

## Context

With ADR-189 (single array API) and ADR-190 (paint-down-to-common), there is a choice about the legacy bidirectional-BFS implementation that currently powers the singular `mergeBase(a, b)`:

- **Delegate / unify** — remove the legacy BFS; the single-best result is the lexicographically smallest element of the reduced LCA set produced by the one faithful core.
- **Keep the legacy BFS** — retain it as an early-terminating fast path for the two-commit single-base case, running the new reduce core only for `--all` / `--octopus`.

## Decision

**Unify.** Delete the legacy bidirectional-BFS. Every caller — including `merge.ts` and the default (`all` falsy) path of the public API — derives its single base from the one paint-down-to-common core, taking the lexicographically smallest reduced base.

The `a === b` self-base shortcut is also dropped: `mergeBase([a, a])` falls out of the core (the intersection reduces to `{a}`), so the special case is redundant.

## Consequences

### Positive

- A single algorithm; no risk of `mergeBase([a,b])` disagreeing with `mergeBase([a,b], { all: true })[*]` in criss-cross histories.
- The latent non-optimality of the old single-base path is fixed for `merge.ts` as a side effect.
- Less code overall — the legacy frontier/intersection helpers are removed.

### Negative

- The two-commit single-base path loses the legacy BFS's bidirectional early termination. Mitigated by ADR-190's date-ordered `STALE` pruning, which still terminates early; revisit under the v2 perf phase if merge-base appears in profiles.

### Neutral

- `merge.ts` changes from `const base = await mergeBase(ctx, ourId, theirId)` to `const [base] = await mergeBase(ctx, [ourId, theirId])`; `base` remains `ObjectId | undefined`.
- The lexicographic tie-break for the single-base result is unchanged from the prior implementation.
