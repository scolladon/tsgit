---
subjects:
  - src/application/commands/add.ts
  - src/application/commands/internal/pathspec-intake.ts
---
# 1046 — `add` reports ignored and sparse entries in additive result fields

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** supersedes ADR-1045 (the ignored-literal interim refusal); refines ADR-1035 and ADR-1037

## Context

git's `add` has two outcomes that are neither a refusal nor a clean success. An ignored entry a
positive pathspec reaches is listed under `The following paths are ignored by one of your
.gitignore files:` with exit 1, and a positive that only a skip-worktree entry matches is listed
under the sparse advice with exit 1; in both cases every other match is still staged and committed
(design rows I2, I3, I10, I17, I19–I23, S5–S7). The library returns structured data, not rendered
text (ADR-249), and a thrown error means nothing durable was written (ADR-1035). tsgit today
either stages the ignored literal (I1–I4, I9) or refuses the whole call with the wrong code (I5,
I6), and stages a skip-worktree entry's blob (S1–S7).

## Options considered

1. **Return normally with additive `AddResult` fields** — `ignored: ReadonlyArray<FilePath>` (the
   paths git lists, sorted) and `sparse: ReadonlyArray<string>` (the pathspec spellings git
   lists), both `[]` when nothing is reported; every other match is staged and committed. Pros:
   the only shape whose index matches git on every mixed row; no new error member; the caller
   derives git's exit 1 from a non-empty list. Cons: a caller that only checks for a throw misses
   the report. Designer's recommendation.
2. **Refuse atomically with new members `PATHSPEC_IGNORED { paths }` / `PATHSPEC_SPARSE {
   patterns }`** — pros: one failure channel; cons: diverges from git's index on every mixed row,
   turns I20–I23 (right today) into refusals, costs about 30 B gzip per member.
3. **Stage the rest, then throw an error carrying the report and the result** — cons: a throw
   after a durable write breaks the rule that a refusal leaves nothing written.

## Decision

**Ratified by the user — option 1.** `AddResult` gains `ignored` and `sparse`. `add` stages every
match the report does not cover, commits the index, and returns the two lists; it never throws
for an ignored or sparse report. The unmatched-pathspec refusal of ADR-1035 still runs first and
wins: when a positive matches nothing and escapes nothing, `PATHSPEC_NO_MATCH` is thrown and the
index is untouched (I5, I6, I24, S9).

Superseded from ADR-1045: the interim rule that a literal naming an ignored path keeps refusing
`PATHSPEC_NO_MATCH`. Every literal naming something on disk now takes git's `file_exists` escape,
ignored or not (I1, I7), and the ignored entry is reported.

Carried forward from ADR-1045: the on-disk escape itself, probed with one `lstat` on the refusal
path only, and the directory-only reading of a trailing-slash literal.

## Consequences

- `PATHSPEC_NO_MATCH` keeps the shape ADR-1037 gave it; no error-union member is added.
- A consumer reconstructing git's exit status treats a non-empty `ignored` or `sparse` as exit 1.
- The interop tests rebuild git's two advice blocks from the lists and compare them to git 2.55.
