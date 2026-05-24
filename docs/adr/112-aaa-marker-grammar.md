# ADR-112: AAA body-comment grammar — line-anchored, Arrange + Assert required

## Status

Accepted (at `36975ef`)

## Context

CLAUDE.md prescribes the test-body grammar:

> **Body:** AAA — Arrange / Act / Assert with section comments

Existing project tests follow this with one caveat: when the assertion
*is* the act (e.g. `expect(Object.isFrozen(sut))`), the body has only
`// Arrange` and `// Assert` — no separate `// Act` line. The detector
must reflect what the project actually does, not a stricter ideal that
would force noisy `// Act` comments on assertion-only tests.

Three questions to resolve:

1. **Which markers are required?** Arrange + Act + Assert (strict), or
   Arrange + Assert (with Act optional)?
2. **Where in the body must they appear?** Anywhere, or at line start
   (line-anchored)?
3. **Case-sensitive?** `Arrange`, or `arrange` / `ARRANGE` too?

## Decision

- **Arrange + Assert required, Act optional.** Matches the existing
  project tests where Act-folded-into-assertion is idiomatic.
- **Line-anchored.** Each marker must appear as `^\s*//\s*Arrange\b`
  (and similarly for Assert). Inline comments (`expect(...) // Assert`)
  and markers inside string literals don't count. The regex is:
  ```
  (?:^|\n)\s*\/\/\s*(Arrange|Act|Assert)\b
  ```
- **Case-sensitive.** `// arrange` won't match. CLAUDE.md prescribes
  capitalised names, and case-sensitivity removes ambiguity about
  whether `// ARRANGE` is intentional shouting or a typo.
- **`\b` trailing boundary** allows annotation prose (`// Assert —
  covers all three reporter methods.`) but rejects compound words
  (`// Assertion` would not match `Assert\b`).
- **`//` only, no `/* */`.** The project uses line comments
  exclusively for AAA markers; block-comment forms are out of scope.

Findings emit `{ path, line, title, missing: ('Arrange' | 'Assert')[] }`
so the report names exactly which marker the test lacks.

## Consequences

### Positive

- **Matches what the project already does** — no false-positive noise
  on the existing Arrange-then-Assert idiom.
- **Line-anchored prevents string-literal false positives** — a test
  whose assertion-message contains the word `Arrange` doesn't trigger.
- **Self-documenting findings** — developers see which marker(s) to
  add.

### Negative

- **`// Act` non-enforcement** means some tests will sit at the
  Arrange/Assert minimum. Accepted: enforcing Act would push noise into
  trivial assertion-only tests.
- **Case-sensitivity** rejects legitimate lowercase forms. Accepted:
  one uniform convention is easier than allowing both.

### Neutral

- The order of markers (Arrange before Assert) is not checked. Order is
  enforced socially via code review; a regex check is brittle without
  full control-flow analysis.
