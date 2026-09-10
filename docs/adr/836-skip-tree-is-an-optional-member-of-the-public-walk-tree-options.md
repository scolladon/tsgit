---
subjects:
  - src/application/primitives/types.ts
  - src/application/primitives/walk-tree.ts
  - src/application/primitives/internal/closure-engine.ts
---
# 836 — `skipTree` is an optional member of the public `WalkTreeOptions`

- **Status:** accepted
- **Date:** 2026-09-10
- **Design:** docs/design/closure-history-walks.md (DC-1) · **Supersedes/Refines:** none

## Context

The interesting side of the object closure runs a full recursive `walkTree` for every walked
commit and deduplicates only at emission, so it visits O(commits × tree entries) where git's
`process_tree` returns on `SEEN | UNINTERESTING` and expands each distinct tree once. The prune
needs a per-directory-entry verdict taken **before** the entry is yielded — the closure's consumer
emits the directory entry while the generator is suspended, so a post-yield check against the
emitted set would skip every subtree. `walkTree` is the shared traversal with a dozen callers, and
its options type is public.

## Options considered

1. **An optional member on the public `WalkTreeOptions`** (recommended, chosen) — pros: smallest diff; git's `SEEN` prune is a legitimate consumer need; one traversal keeps every guard / cons: one more public member (`reports/api.json`, a `walk-tree.md` row).
2. **An internal-only options type behind a second entry point** — pros: public surface untouched / cons: forks a public/internal signature pair for one predicate.
3. **An emit-aware tree walker duplicated inside the closure engine** — cons: duplicates ~280 lines of depth-, cycle- and entry-guarded traversal.

## Decision

**Adopted-as-recommended (no user judgment).** `WalkTreeOptions` gains
`readonly skipTree?: (id: ObjectId) => boolean`. It is evaluated once per directory entry, after
`shouldRecurse` and **before** the entry is yielded; a consumer that reacts to the yield cannot
influence the verdict. `true` means the entry is still yielded but its subtree is not entered. It
is never called for a blob or a gitlink entry. Absent, the walk is exactly today's.

## Consequences

The public surface grows by one optional member; `reports/api.json` is regenerated and the
primitive's documentation gains the row in the same slice. Pre-yield evaluation is part of the
contract and is pinned by a test whose consumer mutates the predicate's set on yield.

Two tsgit-only guards change meaning under the prune, both in the direction of "visits are the
work": the flat-entry limit counts entries actually visited, and a tree that contains itself is no
longer reachable through the closure (its second encounter is pruned, as git's `SEEN` return does)
while `walkTree` alone still detects it. The depth cap is unchanged — a deep tree is entered in
full on its first encounter.
