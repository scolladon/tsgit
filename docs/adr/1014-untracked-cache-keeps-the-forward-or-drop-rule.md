---
subjects:
  - src/domain/git-index/carry-extensions.ts
---
# 1014 — The untracked cache keeps the forward-or-drop rule

- **Status:** accepted
- **Date:** 2026-10-18
- **Design:** docs/design/cache-tree-write-path-perf.md · **Supersedes/Refines:** diverges from ADR-226 (named, bounded)

## Context

git updates `UNTR` in place when `add` grows the tracked set (pin U5). tsgit forwards `UNTR` iff the tracked set did not change, else drops it. With `core.untrackedCache=true` git rebuilds it on the next status (U1). With the config unset, an `UNTR` created by `git update-index --untracked-cache` stays lost after a tsgit write.

## Options considered

1. Keep the current rule and record the divergence (recommended).
2. Maintain `UNTR`: parser, serializer, an EWAH writer, and per-directory invalidation.
3. Drop `UNTR` on every write.

## Decision

**User-ratified — option 1.**

**Divergence (named, bounded):** on a write that changes the tracked set, tsgit drops `UNTR` where git updates it.

## Consequences

- Equal under readback when `core.untrackedCache=true`. With the config unset, the untracked cache is lost after a tracked-set change.
