# 547 — Masked commits keep their oid: graft in place, no new type

- **Status:** accepted
- **Date:** 2026-07-30
- **Design:** docs/design/shallow-boundary-commit-walk.md · **Supersedes/Refines:** none

## Context

The grafted read tier (ADR-542) must hand consumers a commit whose `parents` list is
masked. The shape choice determines whether ~20 downstream consumers need edits and
whether the `id ≡ hash(data)` invariant survives.

## Options considered

1. **Mask in place** (designer's recommendation) — `applyGraft` returns a new commit
   object with `parents: []`, `id` keeping the true oid. Pros: git's own in-memory
   representation; every consumer (`log.parents`, blame's `parents.length === 0`, show's
   parent-diff) is correct with no edit / cons: a masked commit's `id` no longer equals
   `hash(data)`.
2. **Keep `Commit` raw + `graftedParentsOf(ctx, commit)` at every site** — pros:
   invariant-safe / cons: re-opens ~20 sites and silently rots as new ones land.
3. **Distinct `GraftedCommit` type with `parents` + `rawParents`** — pros: explicit /
   cons: doubles the type surface; forces a public-API decision inside a bug fix.

## Decision

Adopted-as-recommended (no user judgment): **option 1**. `applyGraft` returns
`{ …commit, data: { …data, parents: [] } }` immutably, referentially identical input
when nothing masks.

## Consequences

The `id ≡ hash(data)` desync is confined to masked commits and documented; it is safe
because no code path writes a walked commit back (`create-commit` builds its own data).
Any future surface that re-serialises a read commit must graft-strip first or read raw —
that constraint travels with this ADR.
