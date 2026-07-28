# 523 — flattenTree is reimplemented on the raw cursor (no parallel variant)

- **Status:** accepted
- **Date:** 2026-07-28
- **Design:** docs/design/raw-tree-cursor-diff.md · **Refines:** ADR-515 (flattenTree as bulk traversal path)

## Context

The diff's added/deleted-subtree expansion and the Tier-1 `repo.flattenTree` (consumer treeIndex path) both flatten trees through `walkTree`, paying intermediate `Tree` objects, mode-string decodes, and per-level machinery. Every flattened entry is emitted, so hex oid + path string are still produced — the win is the intermediate representation only.

## Options considered

1. **Reimplement `flattenTree` itself (recommended)** — one implementation, one behaviour; `merge`, `rm`, `apply-merge-to-worktree`, and the facade all inherit the win. Name validation stays (costs nothing — every emitted entry decodes its name anyway).
2. **Parallel `flattenTreeRaw`** — narrower blast radius, but two flatteners with two validation surfaces and a permanent which-one question.

## Decision

**Ratified by user — Option 1.** `flattenTree` walks the raw cursor directly; the `walkTree`-based implementation leaves the flatten path.

## Consequences

All flatten consumers speed up together and share one validation surface (names still validated per ADR-518's flatten carve-out). `walkTree` remains for its other consumers.

**Boundary note:** the diff's added/deleted-subtree expansion (`expandAddedSubtree`/`expandDeletedSubtree`) is no longer among `flattenTree`'s consumers — it walks the raw bytes directly via its own dedicated per-entry walker (`walkRawSubtree`), which preserves duplicate-name entries the way `git diff-tree -r` does, rather than `flattenTree`'s last-name-wins `Map` (the right shape for its OWN consumers — worktree materialisation — but the wrong one for a per-entry diff expansion). `flattenTree` remains the shape for worktree-facing consumers (`merge`, `rm`, `apply-merge-to-worktree`, `stash`, `clean-work-tree`, `read-head-tree`, `repo.primitives.flattenTree`, ...); `buildPreimage` consumes `flattenRawTree` directly.

The reimplementation also dropped the per-tree `Set<string>` duplicate-name check the old `walkTree`-backed path had: `flattenRawTree` inserts each entry into a plain `Map` keyed by path, so a tree with a repeated name resolves last-wins, matching `git read-tree`. Duplicate-name refusal is fsck's job (`duplicateEntries`), same as the merge-join side of ADR-518.
