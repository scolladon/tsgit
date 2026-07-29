# 539 — Two distinct error codes for gitfile refusals

- **Status:** accepted
- **Date:** 2026-07-29
- **Design:** docs/design/linked-worktree-discovery.md · **Supersedes/Refines:** refines ADR-249 (structured data only)

## Context

git distinguishes `fatal: invalid gitfile format` from `fatal: no path in gitfile`
(both exit 128); a dangling or non-git pointer target is `fatal: not a git repository`.
tsgit ships structured errors, and the taxonomy determines both faithfulness of the
refusal conditions and mutation-test resistance.

## Options considered

1. **One code with a `reason: 'format' | 'no-path'` discriminant** — pros: fewer codes / cons: a shared code with a string field survives `StringLiteral` mutants that distinct codes kill.
2. **Two codes: `GITFILE_INVALID_FORMAT` and `GITFILE_NO_PATH`** (recommended) — pros: mirrors git's two refusals; mutation-resistant / cons: one more code in the union.
3. **Reuse `NOT_A_REPOSITORY` for everything** — pros: no new codes / cons: erases "not a gitfile" (caller bug) vs "points nowhere" (stale worktree).

## Decision

**Adopted-as-recommended (no user judgment).** Option 2: new codes
`GITFILE_INVALID_FORMAT` and `GITFILE_NO_PATH` in `src/domain/worktree/error.ts`, both
carrying `path`; an empty `commondir` maps to `GITFILE_INVALID_FORMAT` (with the
commondir path); a dangling/non-git target keeps the existing `NOT_A_REPOSITORY` with
the worktree path the caller named.

## Consequences

Tests assert code + data per the mutation-resistant conventions; interop co-pins each
refusal against git's exit 128.
