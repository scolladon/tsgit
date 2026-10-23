---
subjects:
  - src/domain/commands/error.ts
  - src/application/commands/add.ts
---
# 1057 — A selected repository without a resolvable HEAD refuses `NO_COMMIT_CHECKED_OUT`

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1037, ADR-1050 and ADR-1054

## Context

git refuses to add an untracked embedded repository whose HEAD does not resolve — unborn, an
unparsable ref, a refused repository format — with `error: 'sub/' does not have a commit checked
out` and `fatal: adding files failed`, exit 128 (design rows EM40–EM52). That is a different
refusal from a tracked gitlink's broken repository (`NOT_A_REPOSITORY`, ADR-1050) and from a
missing ref.

## Options considered

1. **A new error member `NO_COMMIT_CHECKED_OUT { path }`** — git's refusal, precise data; about
   30 B gzip. The designer's recommendation.
2. **Reuse `NOT_A_REPOSITORY`** — conflates a repository that exists with one that does not.
3. **Reuse `REF_NOT_FOUND`** — names the wrong fault for a refused format or an unparsable ref.

## Decision

**Adopted as recommended (no user judgment) — option 1.** `path` is the directory as git spells it
(`sub/`). The refusal comes after the unmatched-pathspec and tracked-gitlink refusals and names the
first such directory in path order.

## Consequences

- The member joins the error union, the exhaustiveness switches and the barrel-surface test; the
  error table documents it.
