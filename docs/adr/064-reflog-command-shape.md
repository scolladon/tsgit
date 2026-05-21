# ADR-064: `reflog` command shape

## Status

Accepted (at `1e5f20b`)

## Context

Phase 17.1 ships a tier-1 `reflog` command. Canonical `git reflog` is really
several sub-commands: `show` (the default), `exists`, `delete`, and `expire`.
Two design questions:

1. **One command or several?** A single `repo.reflog()` with a discriminated
   `action`, or separate `repo.reflogShow()` / `repo.reflogExpire()` / … .
2. **How faithful is `expire`?** Git's `reflog expire` distinguishes
   *reachable* entries (default cutoff `gc.reflogExpire` = `90.days`) from
   *unreachable* ones (`gc.reflogExpireUnreachable` = `30.days`) — unreachable
   entries are pruned on a shorter clock. Computing reachability needs a walk
   over all current refs.

## Decision

**One command, discriminated `action`** — `repo.reflog(opts?)` where `opts`
carries `action: 'show' | 'exists' | 'delete' | 'expire'` (default `'show'`).
This matches the existing `branch` / `tag` command pattern and keeps one
binding on the `Repository` facade.

**`expire` is fully faithful** — both cutoffs:

- `expire` (default `90.days.ago`) and `expireUnreachable` (default
  `30.days.ago`) are parsed via `parseApproxidate` (ADR-062).
- A reachable-commit `Set` is built: `enumerateRefs` (a new primitive listing
  `HEAD` + loose `refs/**` + packed-refs) → `walkCommits` from each tip.
- An entry is kept iff
  `reachable(entry.newId) ? ts >= expireCut : ts >= expireUnreachableCut`.

**`delete` supports `--rewrite`** — deleting entry `@{N}` optionally rewrites
the following entry's `oldId` to the deleted entry's `oldId`, repairing the
old→new chain (git's `--rewrite`).

Nothing in the `reflog` command is deferred.

## Consequences

### Positive

- One cohesive command, consistent with `branch`/`tag`; a single facade
  binding.
- `expire` matches `git reflog expire` semantics, including the
  reachable/unreachable two-clock prune that `git gc` relies on.
- `delete --rewrite` keeps a hand-edited reflog internally consistent.

### Negative

- `expire`'s reachability pass is O(history) — a full `walkCommits` from every
  ref tip. Acceptable: `expire` is an explicit, rare, maintenance operation,
  never on a hot path.
- Requires a new `enumerateRefs` primitive (loose-ref walk + packed-refs +
  HEAD).

### Neutral

- The `reflog` command bypasses the `core.logAllRefUpdates` write gate
  (ADR-063) — inspecting and pruning existing logs is always allowed.
- `show` on a ref with no reflog returns an empty list, not an error —
  matching `git reflog` on a fresh repo.
