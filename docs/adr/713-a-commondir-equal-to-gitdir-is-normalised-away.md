---
subjects:
  - src/repository/resolve-layout.ts
  - src/repository/find-layout.ts
  - src/application/commands/list-worktrees.ts
---
# 713 — a `commonDir` equal to `gitDir` is normalised away but remembered

- **Status:** accepted
- **Date:** 2026-08-24
- **Design:** docs/design/common-dir-open-option.md (candidate D5)

## Context

The codebase omits `layout.commonDir` when it equals the gitDir, and two sites read the
field's **absence** as "not a linked worktree" (`list-worktrees`' main-entry branch and
`isLinkedWorktreeAdmin`). git accepts a `GIT_COMMON_DIR` equal to the gitDir and still
applies the bareness suppression (ADR-712) to it — so the degenerate value is meaningful
input, not a typo.

## Options considered

1. **Normalise away — record nothing on the layout, remember "supplied" separately**
   (design recommendation) — pros: keeps the on-layout invariant ("present ⇒ differs from
   gitDir") and makes the no-override byte-identity requirement provable / cons: needs a
   side-channel flag for ADR-712.
2. **Record it verbatim** — cons: silently flips `list-worktrees`' main-entry branch to
   the linked-worktree path for a repository that is not one.
3. **Refuse with `INVALID_OPTION`** — cons: wrong on the measurement; git accepts it and
   gives it semantics.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).**

A supplied `commonDir` that resolves equal to the gitDir is not emitted onto the layout;
the fact that the caller supplied one is carried as a separate marker, read only by the
work-tree resolution (ADR-712) and never emitted onto the layout.

## Consequences

- `layout.commonDir` keeps its invariant: present if and only if it differs from `gitDir`.
- Existing repositories opened without the option remain byte-identical, field by field.
