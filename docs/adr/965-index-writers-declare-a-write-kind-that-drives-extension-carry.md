---
subjects:
  - src/application/primitives/internal/index-lock.ts
  - src/domain/git-index/carry-extensions.ts
---
# 965 — Index writers declare a write kind that drives extension carry

- **Status:** accepted
- **Date:** 2026-10-14
- **Design:** docs/design/status-refresh-index-extensions.md · **Supersedes/Refines:** refines ADR-963, ADR-964

## Context

Eighteen modules (28 call sites) write the index through `IndexLock.commit`. git's per-writer behaviour
for `REUC` and `UNTR` (§D1.5) falls into three classes: refresh-only writes keep everything; in-place
writers keep `REUC` and keep `UNTR` unless the tracked set changed; `unpack_trees`-class writers drop
`REUC`.

## Options considered

1. **A declared kind** — each writer passes `'update'` or `'replace'`; `status` alone uses
   `commitRefresh`; pure rules derive `TREE`/`REUC`/`UNTR` from the kind and the entry diff
   (recommended).
2. **Drop `REUC` and `UNTR` on every non-refresh write.** Cons: drops `REUC` where git keeps it.
3. **An explicit extension list at every call site.** Cons: the policy spread over 29 sites.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** `IndexLock.commit(entries, kind)` takes a
required `IndexWriteKind` (`'update' | 'replace'`), so the type checker makes the migration total.
`carryExtensions` in the domain applies the table: `REUC` verbatim on `refresh`, verbatim on `update`
unless a conflicted path was resolved, dropped on `replace`; `UNTR` verbatim on `refresh` and, on
`update`/`replace`, only when the tracked set did not change; any `UNTR` is dropped under
`core.untrackedCache=false`. Output order is `TREE`, `REUC`, `UNTR`. Aligns with ADR-226.

## Consequences

- A new writer cannot compile without choosing its class.
- tsgit does not record `REUC` when `add`/`rm` resolves a conflict; that recording is a later change.
