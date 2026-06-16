# ADR-352: Eager all-`[merge *]` driver valueless validation at the content-merge chokepoint, replacing `namedChoice`'s per-driver guard

## Status

Accepted (closes backlog 24.9v)

## Context

24.9r (#179) guards a valueless `merge.<d>.driver`/`name` only inside `resolve-merge-driver.ts` `namedChoice`, which is reached **only when a path's `merge=<d>` attribute resolves the named driver** (lazy, attribute-selected). Pinned on this base (matrix M4, git 2.54): git loads the **whole `[merge *]` table** at content-merge time and dies on the first valueless `driver`/`name` by config-file line — **even when no path's `merge=<d>` attribute selects driver `<d>`** (configured-but-unused), and independent of whether the merge conflicts or auto-resolves. `merge-tree` (no worktree) dies identically. So `namedChoice` MISSES every content merge that does not carry a custom `merge=` attribute — the common case. 24.9r recorded this as the under-refusal backlog 24.9v.

## Decision

Validate **all** `[merge *]` subsections **eagerly at the content-merge chokepoint** (`buildContentMerger`'s returned closure, once-latched per operation, fired the first time any path enters 3-way content merge), and **remove** the per-driver guard from `namedChoice`.

- A new subsection-**wildcard** finder (`findFirstValuelessInSection`, sibling of the exact `findFirstValuelessEntry`) scans every `[merge *]` subsection and refuses on the first valueless `driver`/`name` by file line — reproducing M4 (any content merge, attribute-independent).
- It stays **lazy** (M3): the guard is inside the per-path closure, so constructing the merger does not run it; a fast-forward / no-content-merge merge invokes it for zero paths and never throws. The latch runs the scan at most once per operation.
- **`namedChoice`'s `assertNoValuelessConfig(ctx,'merge',name,['driver','name'])` is removed.** The chokepoint scan fires on a strict superset of `namedChoice`'s cases (every content merge, before any specific driver resolves), at the same-or-earlier key by file-line order — so the attribute-selected case `namedChoice` used to catch is still refused, via the chokepoint. Keeping both would be dead defence (the second guard is unreachable when the first always fires first) and risks a divergent "first key" message; a wildcard pre-pass *inside* `namedChoice` cannot reproduce M4 (a no-`merge=` content merge never reaches `namedChoice`).

Every 3-way consumer (`merge` directly; `cherry-pick`/`revert`/`rebase`/`stash` via `apply-merge-to-worktree`) routes through `buildContentMerger`, so all inherit the eager guard.

## Consequences

### Positive

- Closes 24.9v: a configured-but-unused valueless `[merge *]` driver now refuses, matching git's whole-table load (M4). One guard, one chokepoint, all consumers covered.

### Negative

- Converts the previously-narrow `namedChoice` refusal into a broader one: any 3-way content merge with a valueless `[merge *]` key now refuses (not only attribute-selected paths). This is the faithful behaviour (git does the same) but a behaviour widening for repos that (mis)configured an unused valueless driver — accepted as the point of 24.9v.

### Neutral

- The removed `namedChoice` guard's case is preserved (a no-regression test pins that an attribute-selected valueless driver still refuses via the chokepoint). The new wildcard finder is internal (consumed within `src/`); no public surface change.
