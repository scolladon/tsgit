# 654 — Two work-tree refusal codes; `BARE_REPOSITORY` narrowed to mixed reset

- **Status:** accepted
- **Date:** 2026-08-18
- **Design:** docs/design/bare-repo-custom-gitdir.md (candidate D2)

## Context

git refuses work-tree commands in three distinct shapes: no work tree
(`fatal: this operation must be run in a work tree`), self-contradictory config
(`fatal: unable to set up work tree using invalid config` when `core.bare` and
`core.worktree` are both set), and `reset --mixed` in a bare repository
(`fatal: mixed reset is not allowed in a bare repository`). The last is keyed on
`is_bare_repository()`, the first two on work-tree presence — measurably different
predicates.

## Options considered

1. **Two new codes `WORK_TREE_REQUIRED { operation }` and
   `WORK_TREE_CONFIG_INVALID { gitDir }`, keeping `BARE_REPOSITORY { operation }` for
   mixed reset (design recommendation)** — pros: three git conditions stay
   distinguishable; no published code removed / cons: two additions to the error union.
2. **Reuse `BARE_REPOSITORY` for everything** — collapses conditions that git separates
   and is wrong where bareness and work-tree absence disagree.
3. **One new code with a `reason` discriminant** — survives StringLiteral mutants that
   distinct codes kill; blurs "repo has no work tree" with "config is a caller bug".

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Aligns with the structured
refusal doctrine (ADR-249) and the mutation-resistance conventions: distinct codes with
data payloads, message bytes reconstructed only in the interop tests.
