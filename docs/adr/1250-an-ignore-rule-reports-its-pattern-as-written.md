---
subjects:
  - src/domain/ignore/parse-gitignore.ts
  - src/application/primitives/is-ignored.ts
---
# 1250 — An ignore rule reports its pattern as written

- **Status:** accepted
- **Date:** 2026-11-23
- **Design:** docs/design/wildmatch-bracket-class.md (G-b, R7) · **Supersedes/Refines:** applies DOCTRINE(D-5), ADR-249

## Context

`IgnoreRule.pattern` is the line with its escapes removed, and `isIgnored` returns it as
`source.pattern`. `git check-ignore -v` prints the pattern as written once trailing spaces are
trimmed: `\#a`, `c\ `, `d\*`, `g\\h`, `!e\[x]`, `f\[ab]/` (rows P1, P2). tsgit returns `#a`, `c `,
`d*`, `g\h`.

## Options considered

1. **Report the line after the trailing-space trim, with escapes, `!` and `/` kept**
   (recommended).
2. Keep the unescaped text.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-5): the value is computed in
`parseGitignore`, which the change edits, and it is structured data under ADR-249. Option 1.

## Consequences

### Positive

- A caller can rebuild `check-ignore -v`'s `<source>:<line>:<pattern>` byte for byte.

### Negative

- `IsIgnoredMatchSource.pattern` changes value for every escaped pattern; its type is unchanged.
