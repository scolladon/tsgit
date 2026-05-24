# ADR-117: GWT clause partitioning between `describe` and `it`

## Status

Accepted (at `62dc683`)

## Context

ADR-113 fixed the GWT regex on the *leaf* `it()` title:

```
^Given .+?, When .+?, Then .+$
```

After 4,323 tests landed on that shape, the cost of repeating Given/
When at every leaf became visible. A typical file has six to eight
sibling tests under one `describe()`; every one of those `it()`
titles restates the same `Given X, When Y, ` prefix before the unique
`Then …` clause. Reading a file means re-parsing the same prefix
seven times. Vitest's runner output prints each leaf with the full
prefix repeated, so the hierarchy carries no signal.

The user weighed in on the convention:

> describe must (carry) the given and when (we regroup use cases per
> subject and context/event) and it is the then

Three design questions to settle:

1. **Where do the GWT clauses live?** Leaf-only (status quo), split
   across describe ancestors, or some hybrid.
2. **Is the combined form `describe('Given X, When Y')` allowed?**
3. **What happens to non-GWT describes** (e.g.
   `describe('moduleName')` wrapping GWT groups)?

## Decision

- **Three-level layout is the canonical form.** Outer `describe('Given
  <context>')`, inner `describe('When <action>')`, leaf `it('Then
  <expected>')`. Use-cases regroup naturally per subject (Given) and
  per event (When); leaves differ only by expectation.
- **The 2-level combined form `describe('Given X, When Y')` is
  permitted** for groups with a single `it()` child. Acceptable
  because the duplicate-prefix cost the convention solves only
  manifests with multiple leaves under one When. The codemod always
  emits the 3-level form; hand-edits may collapse.
- **Non-GWT describes are transparent** to the heuristic. A
  `describe('moduleName')` wrapping GWT groups is allowed and does
  not satisfy or block the rule — the validator walks past it. This
  preserves the common "module / subject" outer-describe pattern
  already in the tree.
- **Direction matters.** Closest-first, the GWT path under an `it()`
  must read `[When …, Given …]` — When is the innermost describe,
  Given is one level outside. Reversed nesting (`Given` inside `When`)
  is a `nested-gwt` finding.
- **Leaf titles must start with `Then `** (single trailing space,
  case-sensitive). Bare `it('does X')` is invalid.
- **Legacy `it('Given …, When …, Then …')` titles** are caught with a
  distinct `legacy-it-gwt` finding so the sweep can flip them
  explicitly. After the sweep PR lands, the rule remains in the
  manifest as the documented intent.

## Consequences

### Positive

- **Files read as specs.** The describe hierarchy carries Given/When
  context once; leaves enumerate expectations. Less noise, more
  signal.
- **Vitest output mirrors intent.** The runner's tree printout now
  groups by subject and event instead of repeating the same prefix
  on every line.
- **Sibling expectations are obviously related.** A failing leaf
  sits under its `When …` describe with all its peers — diagnosis
  starts from the shared context.

### Negative

- **Sweep cost** — 4,323 leaf titles need restructuring. Mitigated
  by a one-shot codemod (see [ADR-118](118-two-pass-scanner-describe-it-join.md)).
- **2-level shortcut adds a second accepted shape.** The detector
  must validate both 1- and 2-entry GWT paths; small extra branch.
- **Outer `describe` blocks now hold semantics** (`Given …`, `When …`)
  instead of subject names. Files that used `describe('subjectName')`
  must either keep that describe as an outer transparent wrapper or
  drop it; the convention prefers the former when natural.

### Neutral

- The convention is a project-internal rule. `vitest` does not enforce
  describe nesting; the audit does.
- Title content (the `<context>`, `<action>`, `<expected>` words
  themselves) is unconstrained — reviewers still judge clarity.
- ADR-113 stays accepted; this ADR refines its scope. The bare
  three-clause leaf regex now lives in the manifest as
  `legacyItGwt` — the deprecated shape we flag, not the required
  shape.
