# ADR-059: HEAD dual-logging on branch updates

## Status

Accepted (at `1e5f20b`)

## Context

When you `git commit` on `main`, git appends a reflog entry to **both**
`.git/logs/refs/heads/main` and `.git/logs/HEAD`. The HEAD reflog is the
single most-used reflog — `HEAD@{N}`, `git reflog` with no argument, and
orphaned-commit recovery all read it.

tsgit's `updateRef` writes the branch ref. It must decide whether — and where —
to also produce the HEAD entry. HEAD is a symbolic ref pointing at the current
branch; an update to that branch is, transitively, a HEAD movement.

Updating a branch that HEAD does **not** currently point at (e.g.
`branch -f other`) must *not* touch `.git/logs/HEAD` — git does not.

## Decision

`updateRef`, after writing branch `name`, resolves HEAD via the ref store
(`getRefStore(ctx).resolveDirect('HEAD')`). If HEAD is a **symbolic** ref whose
`target === name`, `updateRef` appends a second reflog entry — same
`oldId`/`newId`/`message` — for `HEAD`.

HEAD movements that do *not* go through `updateRef` (branch switch, detached
checkout, detached commit) call `recordRefUpdate(ctx, 'HEAD', …)` directly from
the command (§ADR-058).

## Consequences

### Positive

- Git-faithful: committing/resetting on the checked-out branch logs both the
  branch and HEAD, exactly as git does.
- The most-consulted reflog (`HEAD`) is correctly populated by the common
  commands without each command special-casing it.

### Negative

- One extra ref-store read per logged `updateRef` call, to learn HEAD's
  symbolic target. The read is served from the per-`Context` ref-store cache.

### Neutral

- Updating a branch HEAD is *not* on does not double-log — the
  `target === name` guard is exact. A detached HEAD (`resolveDirect` returns a
  direct id, not symbolic) likewise never triggers coupling.
