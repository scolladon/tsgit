---
subjects:
  - src/application/primitives/ref-store.ts
  - src/application/primitives/update-ref.ts
  - src/application/primitives/path-layout.ts
---
# 1167 — the lock collision is keyed by the loose file through the backend table

- **Status:** accepted
- **Date:** 2026-11-08
- **Design:** docs/design/fsck-worktree-private-refs.md · **Supersedes/Refines:** refines ADR-1164

## Context

git's files backend refuses a transaction in which two update names land on one loose file:
`lock_ref_for_update` (refs/files-backend.c:2714) keys its lock map by refname, so the second
name reaches `lock_raw_ref` and fails `EEXIST`. The HEAD case comes from `split_head_update`
(:2499), which adds a log-only `HEAD` update when an update's name equals the current HEAD's
referent, suppressed only for the literal name `HEAD` (:2579): `main-worktree/HEAD` from the
main worktree on a branch locks `<gitdir>/HEAD` twice (W1, W10, W16, W18, W31, W33). The
reftable backend has no such collision (W43). tsgit needs the identity of "the loose file a
name writes" per backend to refuse the same shapes.

## Options considered

1. **A `sharedLooseFile: 'refused' | 'allowed'` field on the per-backend transaction table
   (`TransactionLogging`), with the file identity taken from `refLocation(name).loose`** —
   pros: the table already holds every per-backend transaction shape; no port change. The
   designer's recommendation.
2. **A new port method `RefStore.lockIdentity(name)`** — cons: one more port method for a
   fact the locator already knows.

## Decision

**Adopted-as-recommended (no user judgment) — no trade-off beyond mechanics: option 1.** The
files backend's table entry refuses a shared loose file; the reftable entry allows it. The
colliding file is `refLocation(ctx, name).loose`, compared across the names of the chain plus
the coupled HEAD entry the table adds for a branch HEAD.

## Consequences

- `RefStore` keeps its surface; the backend table carries the rule where the other
  transaction shapes already live.
