---
subjects:
  - src/domain/diff/flat-tree.ts
---
# 977 — The merge engine carries raw path bytes

- **Status:** accepted
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-970

## Context

The merge engine flattens trees to strings, so an untouched lossy `\xff.txt` comes out of a tsgit merge commit renamed to its U+FFFD view; git keeps the bytes (design §D19). Pre-existing on `main`.

## Options considered

1. **Carry bytes** through the flattened trees, merge outcomes and tree synthesis (git-faithful).
2. **Refuse** a merge-engine run that holds a lossy name, with the faithful fix next (recommended by the design).
3. Document only.

## Decision

**User-ratified — option 1.** Every merge-engine consumer (merge, cherry-pick, revert, rebase, stash apply, octopus) keeps a lossy name byte-exact.

## Consequences

- No merge-engine divergence from git.
- The change reaches every flattened-tree consumer; the design sets the parts.
