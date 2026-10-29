---
subjects:
  - src/application/commands/stash.ts
  - src/domain/commands/error.ts
---
# 1101 — `stash apply --index` refuses an index-side conflict before any write

> Amended for git 2.56: see ADR-1109. git exits 128 on the index conflict; 1 is reserved for a work-tree merge conflict.

- **Status:** accepted
- **Date:** 2026-10-27
- **Design:** docs/design/stash-apply-dir-file-replacement.md (review finding H2) · **Supersedes/Refines:** refines ADR-211, ADR-212, ADR-249

## Context

With `--index`, when the stashed index tree differs from both its base and the current index, git applies the
base-to-index patch onto the current index (`apply --cached`) before the work-tree merge. When that patch does not
apply, git prints `error: conflicts in index. Try without --index.`, exits 128 (git 2.56), writes nothing beyond its opening
index refresh and keeps the stash. tsgit runs its index-side three-way merge (base, current index, stashed index)
after the work-tree merge and, when it conflicts, skips the reinstatement without a word: the work-tree merge is
already written, the result is `applied`, and `pop` drops the stash, so the staged state is lost. A review probe
against git 2.55 pinned both sides (`f` staged then committed differently; `g` edited in the stash). ADR-211 kept
"the `--index` reinstatement of a conflicted staged state" out of v1 and left the silent skip; the carve-out
described a feature tsgit would not build, not a refusal git performs.

## Options considered

1. **Refuse before the merge with a new code** — pros: git's order and outcome, nothing written, the stash kept;
   `paths` names the conflicting index paths (ADR-249) / cons: a new public error code, an additive `api.json`
   change; the silent-skip branch of the reinstatement disappears.
2. **Keep the silent skip, defer** — pros: no change / cons: a proven data-loss path (`pop` drops a stash git
   keeps) on the function this change already edits.
3. **Return `applied` with an "index not reinstated" field** — pros: no throw / cons: `pop` still drops the
   stash git keeps; git does not reach the work-tree merge at all.

## Decision

**User-ratified: option 1.** When `restoreIndex` is set and the stashed index tree differs from both its base and
the current index, the index-side merge runs first. A result that is not clean refuses with
`STASH_INDEX_CONFLICT { paths }` — the conflicting paths in index order — before the work-tree merge writes
anything; the opening index refresh stays on disk, as in git, and the stash is kept. A clean result proceeds as
today. git decides "applies cleanly" with a patch (`apply --cached`, no three-way fallback) where tsgit decides it
with a three-way merge; the design pins the rows where both agree and records any shape where they do not.

## Consequences

- A new public error code: union member, constructor, message case (wording only), exhaustiveness switch and a
  regenerated `reports/api.json`.
- The reinstatement's "not clean, return" branch has no caller and is removed; ADR-211's carve-out now reads: a
  conflicted staged state is refused before any write, never reinstated and never silently dropped.
- Interop rows pin `apply --index` and `pop --index` on the conflicting shape: git exit 128, nothing written, stash
  kept; tsgit `STASH_INDEX_CONFLICT`, same state.
