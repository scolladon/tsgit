---
subjects:
  - src/application/commands/status.ts
  - src/application/primitives/internal/index-lock.ts
---
# 959 — `status` takes the optional lock after the refresh and verifies the trailer

- **Status:** accepted
- **Date:** 2026-10-14
- **Design:** docs/design/status-refresh-index-extensions.md · **Supersedes/Refines:** refines ADR-958

## Context

The 2026-09-10 ruling (ADR-958) placed the optional lock before the index read, on the premise that git
does so to make a lost update impossible. git 2.55's `cmd_status` reads the index, refreshes it, and only
then calls `repo_hold_locked_index(…, 0)`. It holds the lock across `wt_status_collect` (the diffs and the
untracked scan) and writes through `repo_update_index_if_able`, which commits only when
`repo_verify_index` finds the on-disk index's trailer hash equal to the one it read, and rolls the lock
back otherwise. The lost update is prevented by the trailer check, not by the lock's position.

## Options considered

1. **git's order** — read → tracked scan (refresh) → optional lock → report and untracked scan → verify
   the on-disk trailer → write or roll back (recommended).
2. **Lock before the read** — the ruling as worded. Cons: a concurrent `git add` during a slow
   stat-invalid `status` fails with "index.lock exists" where git's `status` would not block it.
3. **git's order, lock only when a write is pending** — a shorter window than git's.

## Decision

**User-ratified — option 1.** `status` takes the optional lock after the tracked scan and before the
report and untracked scan, holds it to the end, and writes only when the trailer of the index on disk
equals the trailer of the index it read; on a mismatch, or a vanished index, it releases and writes
nothing. Only stat fields of refreshed entries are copied onto the entries as read, so no path, id, mode,
stage or flag can change on this path. The lock is released in a `finally` on every path.

## Consequences

- A writer that commits between the read and the lock makes `status` skip its write, as git does.
- `IndexLock` gains a refresh-only commit (`commitRefresh`) that carries the trailer guard.
