---
subjects:
  - src/application/commands/stash.ts
  - src/domain/diff/patch-serializer.ts
---
# 1103 — The stashed index is judged by git's patch rule, not a three-way merge

- **Status:** accepted
- **Date:** 2026-10-27
- **Design:** docs/design/stash-apply-dir-file-replacement.md (DC6, F14, Appendix A.7) · **Supersedes/Refines:** refines ADR-1101, ADR-226

## Context

ADR-1101 refuses `stash apply --index` when the stashed index "does not apply" to the current index and asked the
design to record where git's judge and a three-way merge disagree. git's judge is a patch: the base-to-index diff
(`diff-tree --binary`, Myers, three lines of context) applied with `apply --cached` onto the current index, with
exact context matching, an outward offset search, a hunk at line 1 anchored at the file start, a hunk without
trailing context anchored at the end, a creation refused when the path exists, a deletion, binary or type change
requiring the current content to equal the base's (a differing mode is only a warning), and a mode-only change
applying whatever the current content. tsgit's `mergeTreesToTree` is a three-way merge. On five
pinned shapes git refuses and the merge is clean: a current change inside the hunk's context, the current index
already holding the staged change, `stash push --keep-index` then a commit of the kept index then `pop --index`
(git's own documented partial-commit flow), the same file added on both sides, and a line-1 hunk shifted by lines
inserted above it. No pinned shape has git applying where the merge conflicts.

## Options considered

1. **Port git's `apply --cached` rule** — pros: git's refusal surface on every pinned shape, including the documented
   `--keep-index` flow; the reinstated tree is git's `index_tree` (the current index with patched blobs) / cons:
   a new domain module with its own property suite, about 1.2–2.0 kB gzip.
2. **Keep the three-way merge and record the five shapes as an accepted divergence** — pros: no new module / cons:
   tsgit reinstates where git refuses, and `pop` then drops a stash git keeps; the divergence sits on a documented
   workflow, not a corner.
3. **The three-way merge plus "refuse when the current entry differs from the base"** — pros: cheap / cons: wrong
   both ways: it refuses the non-overlapping and the shifted-middle hunk, which git applies.

## Decision

**User-ratified: option 1.** The index side is judged by applying the base-to-index hunks onto the current index's
blobs with git's `apply` matching rules; a path whose hunks do not apply, a creation onto an existing path, or a
deletion, binary or type change whose current content differs from the base's refuses `STASH_INDEX_CONFLICT { paths }`
with every failing path, in index order, before any write. A mode-only change applies onto any content, a mode
difference alone never refuses, and a reinstated entry keeps the current index's mode unless the stash changed it,
as `apply --cached` does. The reinstated index tree is the current index with the patched blobs. The hunks come from the repository's own diff (`computeHunks`, three lines of context, plumbing
reads no `diff.algorithm` or `diff.context`).

## Consequences

- A new domain module beside the patch serializer, with a property-test sibling: a hunk set applies to its own
  preimage and yields its postimage; offsets move nothing else.
- About 1.2–2.0 kB gzip on the library; the size caps are raised once with the change, attributed to this part.
- Interop rows pin every A.7 shape; the five formerly divergent shapes now refuse in both tools.
