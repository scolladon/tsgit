---
subjects:
  - src/application/primitives/internal/resolve-tree-path.ts
---
# 762 — Path descent walks git's prefix boundaries

- **Status:** accepted
- **Date:** 2026-08-30
- **Design:** docs/design/tree-entry-byte-sensitivity.md (review round 1) · **Supersedes/Refines:** completes ADR-759

## Context

ADR-759 ratified matching the whole remaining path against entry names on a descent miss.
Its ratified text described git's actual loop: accept an entry whose name equals the whole
remaining path, **or** one that equals a prefix followed by a separator, and descend with
the rest. Only the first clause shipped.

The gap is observable. Measured, git 2.55.0, over a root tree whose sole entry is a
**tree** literally named `a/b` holding `c`:

```
git rev-parse <root>:a/b/c   -> 5626abf0f72e58d7a153368ba57db4c673c0e171
tsgit findTreeEntry(<root>, 'a/b/c') -> undefined (PATH_NOT_IN_TREE)
```

ADR-759's own probe covered only the single-level case, so the interop suite did not pin
it and the gap survived implementation.

## Options considered

1. **Implement the full prefix walk** — pros: closes the gap; the descent finally is git's loop rather than an approximation of it / cons: more work on a measured hot path, on top of a fallback that already doubles the miss cost.
2. **Amend ADR-759 down to the shipped subset** — pros: cheap, and git's own fsck refuses such trees so no well-formed repository has one / cons: leaves a pinned divergence on three published surfaces.
3. **Revert the fallback entirely** — cons: contradicts a decision ratified the same day and widens the divergence.

## Decision

**Ratified by the user: option 1.** At each level the descent tries the segment, then walks
the separator boundaries of the remaining path: an entry whose name equals a prefix and
which is a tree is descended into with the unconsumed tail; an entry whose name equals the
whole remaining path terminates the walk. This is `find_tree_entry`'s loop.

The extra work stays on the **miss** path. The hit path is unchanged, and is pinned by
benchmark rather than by assertion.

## Consequences

### Positive

- `rev-parse <tree-ish>:<path>`, `read-file-at` and `blame` resolve every path git resolves, including through a separator-bearing tree name.

### Negative

- The miss path does more work: bounded by the number of separator boundaries in the remaining path, so linear in path depth, not in directory width. Interop rows pin both the multi-level hit and the miss.
