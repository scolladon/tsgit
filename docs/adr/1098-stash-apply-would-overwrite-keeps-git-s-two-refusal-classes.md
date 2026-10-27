---
subjects:
  - src/application/commands/stash.ts
  - src/domain/commands/error.ts
---
# 1098 — `STASH_APPLY_WOULD_OVERWRITE` keeps git's two refusal classes

- **Status:** accepted
- **Date:** 2026-10-27
- **Design:** docs/design/stash-apply-dir-file-replacement.md (DC3, F12) · **Supersedes/Refines:** refines ADR-212, ADR-249

## Context

git's pre-merge abort prints one of two blocks: `Your local changes to the following files would be overwritten by
merge:` for a dirty tracked path, or `Updating the following directories would lose untracked files in them:` /
`The following untracked working tree files would be overwritten by merge:` for an untracked occupant (A.2 DFa ×
dirty-dx vs untr-du). The shared pre-flight (`findWouldOverwrite`) already returns `localChanges` and `untracked`
separately, and `merge` exposes them as `WORKING_TREE_DIRTY { localChanges, untracked }`. `stash apply`
concatenates both into one `paths` list, so a caller cannot tell which block git would print.

## Options considered

1. **Add `localChanges` and `untracked` beside `paths`** (designer's recommendation) — pros: the house shape
   `merge` already uses; ADR-249's rule that the caller rebuilds git's output from the data; `paths` kept, so no
   caller breaks / cons: additive `api.json` change; `paths` becomes a redundant concatenation.
2. **Leave as is, report an impact** — pros: no change / cons: a proven data loss on the exact refusal path this
   change restructures, deferred against the fold rule.

## Decision

**Adopted as recommended (no user judgment): option 1.** It aligns with ADR-249 (structured fields the caller
renders) and with the `WORKING_TREE_DIRTY` shape the merge family already exposes. `STASH_APPLY_WOULD_OVERWRITE`'s
data carries `localChanges`, `untracked` and the existing `paths` (their concatenation, in that order).

## Consequences

- `reports/api.json`: two added fields on the error's data; `paths` stays for existing callers.
- Interop rows assert the class per path and reconstruct git's header from the two lists.
- A later major may drop `paths`; nothing here decides that.
