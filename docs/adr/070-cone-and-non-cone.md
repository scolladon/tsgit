# ADR-070: Sparse checkout ships both cone and non-cone pattern modes

## Status

Accepted (at `c85927a`)

## Context

`.git/info/sparse-checkout` selects which paths are in the working tree. git
has two pattern *modes*:

- **non-cone** — arbitrary `.gitignore`-syntax patterns, last-match-wins. Fully
  general; the original mechanism. Matching is a per-pattern regex sweep.
- **cone** (`core.sparseCheckoutCone=true`, the modern git default) — the
  pattern file is restricted to a directory-prefix shape git generates from a
  list of directories. Matching collapses to an O(1) directory-membership
  test, which is what makes sparse checkout fast on large repos.

The decision — confirmed with the repository owner — is whether 17.3 ships
non-cone only (smaller) or both.

## Decision

Ship **both modes**.

- **Cone** — a cone is a set of *recursive* directories `R` (every descendant
  included) and the derived *parent* directories `P` (proper ancestors of `R`,
  navigable, direct files only). `coneMatcher` is the membership test
  `dirname(p) ∈ {root} ∪ P ∪ {d : d or an ancestor ∈ R}`. The command's
  `set`/`add` take directories; `list` prints directories.
- **Non-cone** — patterns are tokenised with the same line parser as
  `.gitignore` (a shared `tokenizeIgnoreLine` helper) and compiled to regexes.
  `nonConeMatcher` is last-match-wins. A pattern is *recursive* (covers the
  whole subtree) when it is directory-only or its final segment has no glob
  metacharacter; a wildcard-last pattern such as `/src/*` covers direct
  children only.
- **Degradation** — when `core.sparseCheckoutCone=true` but the on-disk file
  is not cone-shaped (e.g. hand-edited), `parseSparseCheckout` falls back to
  non-cone matching of the same text and flags the result `degraded` so the
  caller logs a warning. This mirrors git's own behaviour.

## Consequences

### Positive

- Full parity with modern git: cone (the default users expect) and the
  general non-cone escape hatch.
- Cone matching is O(1) per path — no regex sweep on the hot checkout path.
- A hand-edited cone file never crashes and never silently mis-materialises;
  it degrades to well-defined non-cone matching with a warning.

### Negative

- Two matchers, two parsers, plus cone serialization and cone-file
  re-parsing — a larger surface than non-cone alone.
- Non-cone `/src/*`-style wildcard-last patterns cover direct children only,
  not the subtree — a documented deviation from a naive reading. Users wanting
  the subtree write `/src/` or `/src`; cone mode avoids the question entirely.

### Neutral

- The `set`/`add` input meaning and `list` output shape differ by mode
  (directories vs. raw patterns) — the command branches on
  `core.sparseCheckoutCone`, exactly as git does.
- Cone mode is the default for a fresh `set` (no `cone` option), matching
  modern git.
