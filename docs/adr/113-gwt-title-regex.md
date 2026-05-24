# ADR-113: GWT title regex — comma-separated, three clauses, no property-test escape hatch

## Status

Accepted (at `36975ef`)

## Context

CLAUDE.md prescribes the unit-test title format:

> **Titles:** `Given <context>, When <action>, Then <expected>`

19.3's detector turns this into a CI gate. Three design questions:

1. **What's the regex?** Strict GWT (`Given X, When Y, Then Z`), or
   permit a Given/Then short form when there's no separate action?
2. **What about property-based tests?** Some legacy titles begin with
   `Property: ...`. Should the regex carve out a property-test escape
   hatch?
3. **What about `it.each([...])('title', body)`?** The title is a
   template literal — does the same regex apply?

## Decision

- **Strict GWT regex** — three clauses required, comma-separated,
  case-sensitive:
  ```
  ^Given .+?, When .+?, Then .+$
  ```
  Reluctant quantifiers (`.+?`) ensure each clause picks the shortest
  prefix before the next delimiter. A clause containing the literal
  sub-string `, When ` or `, Then ` would mis-parse; the project's
  current titles have no such occurrences, and the false-negative risk
  is documented in the design doc.
- **No property-test escape hatch.** Property-based tests should be
  framed as `Given <property> over <generator>, When <relation> holds,
  Then <invariant>`. The handful of `'Property: ...'` titles in the
  tree get converted in the cleanup commits of the 19.3 PR. Tier-level
  test conventions are decided per-tier; promoting a separate property
  tier is a 19.6 conversation.
- **`it.each([...])('title', body)` uses the same regex.** The
  template-literal title is treated as a literal string by the scanner;
  embedded `$0` / `$key` placeholders count as part of the literal and
  don't affect matching.
- **Modifier-blocks (`.skip`, `.todo`, `.fails`) are still validated.**
  A skipped test should still have an expressive title; if you're
  documenting an intent, the GWT grammar makes the intent legible.

Findings emit `{ path, line, title, reason }` where reason is `'missing'`
(no literal title) or `'malformed'` (title doesn't match the regex).

## Consequences

### Positive

- **One uniform shape across the entire unit suite** — readers grok the
  test in seconds without context-switching between formats.
- **Strictness pays off in PR review** — non-GWT titles surface as CI
  findings, not as "did the reviewer notice?".
- **`.skip`/`.todo` enforcement** documents intent even when the test
  isn't running, which matters for tests that are aspirational.

### Negative

- **Cleanup work in the 19.3 PR** to convert non-GWT titles. The
  population is small (< 10 in the current tree at design time) so the
  cleanup is bounded.
- **A clause containing `, When ` or `, Then ` mis-parses** — accepted
  false negative. The fix is to rephrase the clause.

### Neutral

- The regex is the **only** rule on title shape; it does not enforce
  clause content, length, or punctuation beyond the three required
  delimiters. Reviewers still judge clarity.
- If a future testing tier (property-based, scenario, etc.) emerges and
  warrants its own title shape, a new ADR + manifest extension can
  carve out a tier-specific regex. The current design covers
  `test/unit/**` only.
