# ADR-318: with-base distinct types reuse `distinct-types` with an explicit `basePath`

## Status

Accepted (at `<sha-after-merge>`)

## Context

24.9f (ADR-311) implemented git's `path~<label>` rename for **no-base** (add/add)
file-vs-symlink collisions. When a **base exists** and the two sides diverge to
different kinds, git's ort performs the *same* per-side rename — plus one new
behaviour with no prior ADR: the base's **stage-1 entry travels with the side
whose kind matches the base** (base = regular file ⇒ stage 1 lands at the
renamed regular side's path, which then carries stages 1+2; base = symlink ⇒
stage 1 stays at the original path with the symlink side). Verified against
git 2.54.0 ort on twin repos, both side orders, both base kinds.

tsgit today routes these pairs to the bare take-ours `type-change` conflict — a
silent divergence on the index, worktree, and refusal surfaces.

Alternatives considered for the conflict's type: a new dedicated type
(duplicates the writer/refusal/recorded-paths plumbing), or extending
`type-change` with rename fields (silently changes the semantics of an existing
type). For the stage-1 placement: deriving the kind-match rule inside
`index-diff.ts` at emission time (moves the rule away from the classification
that owns it).

## Decision

- With-base file-vs-symlink pairs emit the existing **`distinct-types`**
  conflict, extended with the already-optional `baseId`/`baseMode` plus a new
  optional `basePath`. Presence of `baseId` discriminates with-base from the
  24.9f no-base shape.
- `basePath` is an **explicit `MergeConflict` field**: classification computes
  the kind-match placement once; stage emission and consumers read it directly.
  `basePath` always equals `ourPath` or `theirPath`.
- Stage emission adds `{ baseId, baseMode, stage: 1, path: basePath }` when all
  three are present; rename mechanics, labels, unique-path probing, and the
  untracked-rename-target refusal are inherited unchanged from ADR-311.

## Consequences

### Positive

- One conflict type and one writer path cover both the no-base and with-base
  shapes; consumers discriminate with a single optional-field check.
- The kind-match rule lives next to the classification that derives it, pinned
  by interop in both base-kind directions.

### Negative

- A recorded path can now carry **two** stages (stages 1+2 at the renamed
  regular side when the base is a file) — invariants and equivalence comments
  claiming "distinct-types: one stage per path" become false and must be
  re-derived.

### Neutral

- `recordedPaths` uniqueness keys are unchanged (`basePath` aliases an existing
  side path).
