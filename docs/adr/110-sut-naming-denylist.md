# ADR-110: Enforce `sut` naming via deny-list of synonyms

## Status

Accepted (at `36975ef`)

## Context

CLAUDE.md prescribes a fixed name for the system-under-test variable:

> **Variable:** System under test is always named `sut`

19.3 needs a regex-only detector (per ADR-097 and the 19.2 §6 tooling
choice) that catches violations of this rule. Two designs:

- **Allow-list** — require every unit `it()` body to declare exactly one
  variable named `sut`. Forces every test to have a SUT declaration,
  which doesn't match reality: some tests assert on module-level
  constants (`expect(MAX_DEPTH).toBe(64)`) or branch on imported pure
  functions without binding them. The rule would over-fire.
- **Deny-list** — flag any declaration that uses a known synonym for the
  SUT (`subject`, `objectUnderTest`, `systemUnderTest`, `cut`). Tests
  without a SUT declaration pass; tests with the prescribed name `sut`
  pass; only tests that picked a synonymous name are flagged.

The synonym set was chosen by surveying common conventions:

- `subject` — RSpec / Mocha lineage. Common enough to need explicit
  banning.
- `objectUnderTest` / `systemUnderTest` — long forms that occasionally
  slip in.
- `cut` — short form (Component Under Test) used in some Angular and
  C++ projects.

`instance`, `service`, `controller`, etc. were considered but rejected:
they're more often legitimate collaborator names than SUT aliases. The
deny-list stays tight on the four unambiguous synonyms.

## Decision

Adopt the **deny-list** approach. Regex matches at *declaration sites*
only:

```
\b(?:const|let|var)\s+(subject|objectUnderTest|systemUnderTest|cut)\b
```

This deliberately ignores:

- **Reads of those identifiers** — a test that imports `subject` from a
  fixture or reads `result.subject` is not flagged.
- **Destructured declarations** (`const { subject } = ...`) — known false
  negative, documented. Rare in this project's style.

Findings carry `{ path, line, title, alias }` so the report shows
exactly which synonym fired in which test.

## Consequences

### Positive

- **Tight regex, low false-positive rate** — only flags the four explicit
  synonyms in fresh declarations.
- **Pure addition** — tests that have no SUT (e.g. constant-assertion
  tests) pass without any change.
- **Self-documenting fix** — the report names the alias the developer used;
  the fix is mechanical (rename to `sut`).

### Negative

- **Destructured aliases bypass the check.** Accepted; the project's
  style does not currently include this pattern, and switching to an
  AST-aware scanner is out of scope per ADR-097.
- **The deny-list isn't exhaustive** — a developer could invent a new
  synonym (`sutVar`, `target`, `myObj`) and bypass the check. Mitigated by
  code review and the social convention of `sut`.

### Neutral

- The list can grow ADR-by-ADR if new synonyms slip in. The starting set
  of four covers what's been seen in similar codebases.
