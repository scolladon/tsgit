---
subjects:
  - src/application/commands/commit.ts
  - src/application/primitives/build-index-from-tree.ts
  - src/application/primitives/materialize-tree.ts
---
# 970 — Raw index path bytes close the tree round trip

- **Status:** accepted
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-226

## Context

Fixing the parser alone leaves two re-admission routes (design §D1.2): `commit` emits tree names
from the decoded path (U+FFFD), and `reset`/checkout rebuild entries from the decoded tree-walk path.
Both are pinned against git 2.55 (rows A4, B4, E1).

## Options considered

1. **Parse, write, order, keys, cache-tree, index → tree and tree → index** (recommended).
2. **Parse and write only**; tree routes to a later entry.
3. **Option 1 plus the merge engine**, which is string-pathed end to end.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Every pinned gap is folded (ADR-226).
The merge engine is not pinned for lossy names; an untouched lossy entry survives a merge through
the carried index. It is triaged separately before any fold.

## Consequences

- A lossy path survives add → commit → reset → checkout byte-exact.
- Merge outcomes on a lossy path remain a known, unpinned residual.
