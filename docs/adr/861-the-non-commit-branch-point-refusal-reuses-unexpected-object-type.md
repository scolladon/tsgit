---
subjects:
  - src/application/commands/branch.ts
---
# 861 — The non-commit branch-point refusal reuses `UNEXPECTED_OBJECT_TYPE`

- **Status:** accepted
- **Date:** 2026-09-12
- **Design:** docs/design/session-caches-per-command-floor.md (NDC-3) · **Supersedes/Refines:** refines ADR-860

## Context

ADR-860 gives `branch.create` a refusal when its start point does not peel to a commit, but names
the behaviour only, not the error it raises. The design's requirements say no new error code, and a
new one is not a one-line addition here: it trips the error union, every exhaustiveness switch over
it, the barrel-surface test, the errors documentation page and the API report.

`UNEXPECTED_OBJECT_TYPE` already exists with the shape this refusal needs —
`{ code, expected: ObjectType, actual: ObjectType, id: ObjectId }` — and its documented meaning is
precisely "asked for one object type, got another".

Git prints two lines here: an `error:` line that reconstructs 1:1 from that data, and
`fatal: not a valid branch point: '<start>'`, which needs the start point as the **caller** spelled
it. Under this library's structured-output rule the caller already holds that string, because it
passed it; rendering is the caller's job.

## Options considered

1. **Reuse `UNEXPECTED_OBJECT_TYPE` with `expected: 'commit'`** (recommended, chosen) — pros: the
   right data, no new public surface, git's message reconstructs from it. Cons: the start point as
   spelled is beside the error rather than inside it.
2. **A new `INVALID_BRANCH_POINT { startPoint, id, objectType }`** — pros: one error carries both
   of git's lines, start point verbatim. Cons: a public addition and five gates, for data the
   caller supplied.
3. **Reuse `BRANCH_NOT_FOUND`** — wrong on the pins: git distinguishes "not a valid object name"
   from "not a valid branch point", and these are different refusals.

## Decision

**Adopted-as-recommended (no user judgment).** Option 1. The refusal raises
`UNEXPECTED_OBJECT_TYPE` with `expected: 'commit'`, `actual` the resolved type and `id` the
resolved object id. An interop test proves git's `error:` line reconstructs from those fields.

This follows the reasoning ADR-637 ratified for `CONFIG_BAD_NUMERIC_VALUE`: where an existing code
carries the right data, reusing it is preferred to growing the public surface.

## Consequences

No change to the error union, the exhaustiveness switches, the barrel-surface test, the errors page
beyond a row, or the API report.

A consumer that wants git's second line composes it from the start point it passed. That is the
structured-output rule working as intended rather than a gap, and it is stated on the errors page
so the composition is documented rather than inferred.

If a later change gives tsgit a reason to carry a caller's raw spelling inside errors generally,
option 2 becomes available for this refusal and for its siblings at once; it is not worth doing for
one verb.
