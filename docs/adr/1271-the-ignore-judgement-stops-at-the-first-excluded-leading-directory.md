---
subjects:
  - src/domain/ignore/matcher-stack.ts
  - src/application/primitives/internal/ignore-evaluator.ts
  - src/application/primitives/is-ignored.ts
---
# 1271 — The ignore judgement stops at the first excluded leading directory

- **Status:** accepted
- **Date:** 2026-11-26
- **Design:** docs/design/is-ignored-leading-directory.md (git's rule, Matrices A and E, R1 to R4) · **Supersedes/Refines:** applies ADR-226 and DOCTRINE(D-5); refines ADR-163

## Context

tsgit's ignore judgement loads the `.gitignore` of every leading directory of a path, then
matches the full path only.

git 2.56.1 (`dir.c`, `last_matching_pattern` and `prep_exclude`) first tests each leading
directory, root-first and as a directory, against the lists loaded so far. The first directory
a positive pattern matches decides: its pattern is returned, and neither its own `.gitignore`
nor anything beneath it is read. A negative match counts as no match and the walk goes on. The
full path is matched only when no leading directory is excluded.

Pinned against git 2.56.1, both `core.ignorecase` values:

| Rows | git | tsgit on main |
|---|---|---|
| 22 of the 28 `git check-ignore -v --no-index` rows of Matrix A | ignored, naming the directory's rule | not ignored, or another rule |
| X1: a `.gitignore` over the size cap under an excluded directory | never opened | throws `GITIGNORE_FILE_TOO_LARGE` |
| X2: the same file unreadable | never opened | throws `PERMISSION_DENIED` |
| X3: a directory stands at that `.gitignore` | never opened | not ignored |

## Options considered

1. **Copy git's rule: test each leading directory root-first, as a directory, against the
   levels of the directories above it; the first excluded one decides and its rule is the
   `source`; no `.gitignore` at or beneath it is read** (recommended).
2. Keep the full-path match and let a directory rule match every path beneath the directory.
3. Leave the judgement and record the difference.

## Decision

**Adopted-as-recommended (no user judgment)** — ADR-226 for the rule; DOCTRINE(D-5) for rows X1
to X3, which sit in the loader this change edits. Option 1.

A leading directory is tested as a directory whatever stands on disk (rows E1 and Q1). The
query's own `isDirectory` stays declared by the caller, as ADR-163 has it. The shape of `source`
does not change. Its values do: a path under an excluded directory names that directory's rule
(row I1).

Refused: option 2 still lets a later negation or a nested `.gitignore` re-include the path
(rows C1, D1 and O1) and keeps the three fault rows. Option 3 ships a wrong answer for any
repository that ignores a directory.

## Consequences

### Positive

- Every row of Matrix A and rows X1 to X3 answer as git does.
- Nothing at or beneath an excluded directory is opened, so fewer `.gitignore` files are read.

### Negative

- A path that read "not ignored" can now read ignored, and an ignored path can name another
  rule. A caller that relied on the old answers sees the change.
