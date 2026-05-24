# ADR-115: Empty AAA-section grammar — statement-bearing line, present markers only

## Status

Accepted (at `4db24d2`)

## Context

19.3a teaches `tooling/test-pyramid` to flag empty AAA sections —
adjacent markers with nothing between them. Three sub-decisions:

1. **What counts as "non-empty"?** Any token? Any non-comment? Any
   declaration / statement?
2. **Which markers does the rule check?** Every AAA marker that *could*
   appear (Arrange, Act, Assert), or only those that *are* present?
3. **How do compound marker lines** (`// Arrange + Act`) interact with
   between-marker section accounting?

The existing `aaaBody` detector (ADR-112) handles marker *presence*.
The new rule is orthogonal: among markers that exist, the section under
each must have content.

## Decision

### 1. "Non-empty" = at least one statement-bearing line

A *statement-bearing line* is a line whose first non-whitespace
character is **not** `//` (line comment) and **not** a closing bracket
(`}`, `)`, `]`). Empty lines (whitespace-only) and block-comment-only
lines (`/* ... */` whose entire content is comment) are also not
statement-bearing.

Rationale: the marker exists to label setup / action / observation.
Comments under a marker don't perform any of those — they decorate.
Closing brackets are syntax punctuation closing a prior construct, not
new work under the marker.

### 2. Only markers that are *present* are checked

If a body has `// Arrange` and `// Assert` but no `// Act`, the rule
inspects only the Arrange and Assert sections. The Act-folded-into-
assertion idiom (ADR-112) stays valid.

If a body explicitly carries `// Act`, the Act section is checked too —
the author put the marker there for a reason; it must have content.

### 3. Compound markers (`// Arrange + Act`) count as one marker line

When a single comment line matches multiple markers (per
`detect-missing-aaa` §MARKER_PATTERNS, the `\b` boundary allows
`Arrange` and `Act` to match on the same line), the *line* is one
marker line for between-marker section accounting. The "Arrange
section" runs from the line after the compound marker to the next
marker; the "Act section" is empty by construction (the marker
introduces no own section because the next marker is the same line).

A finding is emitted under the *first* marker name on a compound line
when the following section is empty. The rare case of an entirely-
compound body (`// Arrange + Act + Assert` on one line, then one
statement) is treated as a single marker — the statement satisfies the
section.

## Consequences

### Positive

- **Clean separation from `aaaBody`.** Presence and emptiness are two
  files, two gates, two reports.
- **No false positives on legitimate "Act folded into assert" tests.**
  Only present markers are checked.
- **Tolerates expressive marker prose.** `// Arrange — fixtures from
  test-helpers` is still a marker line; the section is whatever's
  underneath.

### Negative

- **Block-comment-only sections are flagged.** Rare; if a test
  genuinely uses a block comment as its Arrange step, the fix is to
  convert it to a `//` comment plus a statement (or accept the
  finding). Documented limitation.
- **Compound-marker rendering is asymmetric** — the finding fires
  under the *first* marker name. Slightly arbitrary; documented in
  the design.

### Neutral

- "Statement-bearing line" is a heuristic, not a TypeScript parse.
  Multi-line constructs whose first line is `}` would be misclassified
  as non-statement; that pattern is vanishingly rare inside an AAA
  section. If it surfaces, revisit.
- The rule emits at most one finding per empty marker — not per missing
  statement. Volume stays manageable.
