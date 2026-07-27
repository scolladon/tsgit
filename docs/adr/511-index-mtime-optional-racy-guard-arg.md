# 511 — Thread the index file's own mtime as an optional racy-guard argument

- **Status:** accepted
- **Date:** 2026-07-27
- **Design:** docs/design/close-isogit-perf-gap.md · **Supersedes/Refines:** realises ADR-209's stat-cache extension point; reuses ADR-050/150 racy-stat concepts

## Context

The `ie_match_stat`-faithful stat-cache short-circuit in `compareWorkingTreeDelta` needs the index file's own mtime for the racy-clean guard (an entry whose mtime ≥ the index mtime must be re-hashed). That timestamp is observed by `readIndex` today but discarded. Several ADR-209 consumers share the comparator; only `status` needs the fast path initially.

## Options considered

1. **`readIndex` surfaces the index mtime; comparator gains an optional argument (recommended)** — pros: localised; absent argument ⇒ short-circuit disabled, so every other consumer keeps today's behaviour / cons: one more parameter.
2. **Route through `CachingIndexResolver`** — pros: it already holds the index `FileStat` / cons: couples the comparator to a snapshot-resolver adapter.
3. **Carry the index mtime on `Context`** — pros: no signature change / cons: widens shared context for one command.

## Decision

**Adopted-as-recommended (no user judgment) — Option 1.** `readIndex` surfaces the index file's mtime (sec + ns); `status` passes it to `compareWorkingTreeDelta` as an optional racy-guard argument. Absent ⇒ the short-circuit never fires and the comparator behaves exactly as before.

## Consequences

Only `status` opts into the fast path initially; `rm`/`stash`/clean-work-tree/apply-merge adopt it later by passing the argument. The comparator stays a pure primitive with no adapter coupling.
