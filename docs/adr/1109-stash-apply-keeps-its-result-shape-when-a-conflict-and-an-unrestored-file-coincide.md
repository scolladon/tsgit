---
subjects:
  - src/application/commands/stash.ts
  - docs/use/commands/stash.md
---
# 1109 — stash apply keeps its result shape when a conflict and an unrestored file coincide

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (F3, D-F3) · **Supersedes/Refines:** refines ADR-1097 and ADR-249

## Context

git 2.56's 786fc39 ("stash: reserve exit status 1 for conflicts") maps every negative return of
a stash subcommand to 128 and leaves 1 for a merge conflict alone. Pinned on 2.56.0: a refused
apply, an index conflict under `--index`, an untracked occupant, a push on an unmerged index, a
beyond-symlink push, a `safecrlf` refusal, `stash branch` on an existing name, a missing entry and
`drop` with no entries all exit 128 (2.55.0: 1), with identical stderr. One shape moved class: an
apply or pop whose merge conflicted and whose untracked restore also failed now exits 128, a
failure, where 2.55.0 exited 1, a conflict. tsgit carries no exit status; `reportApply` returns
`{ kind: 'conflict', untrackedNotRestored }` for that shape (ADR-1097).

## Options considered

1. **Keep the return shape; the interop row rebuilds 128 from `untrackedNotRestored`** — pros:
   the data already holds every field git's two outcomes differ on; no caller breaks / cons: the
   result kind says `conflict` for an outcome git classes as a failure.
2. **Throw a typed error carrying the conflicts, superseding ADR-1097** — pros: throw/return
   mirrors git's failure/conflict split / cons: callers lose the written merge's report to encode
   a CLI number.
3. **A new result kind `'conflict-unrestored'`** — pros: self-describing / cons: a third kind for
   a shape two fields already describe.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** `reportApply` keeps returning
`{ kind: 'conflict', ...report }`; the presence of `untrackedNotRestored` is what distinguishes
git's exit 128 from its exit 1, and the interop twin rebuilds the status from it. Exit status is a
property of git's CLI layer, not of the library's data (ADR-249).

## Consequences

- Every stash interop constant that pinned a refusal at 1 moves to 128; conflict rows stay at 1.
- The `reportApply` comment that cites git's exit 1 is corrected, and the stash docs page states
  git's split.
