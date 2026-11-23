---
subjects:
  - src/domain/ignore/parse-gitignore.ts
  - src/domain/attributes/parse-gitattributes.ts
  - src/domain/sparse/non-cone.ts
  - src/domain/pathspec/compile-glob.ts
---
# 1249 — Pattern escapes are resolved by the matcher, not the line parser

- **Status:** accepted
- **Date:** 2026-11-23
- **Design:** docs/design/wildmatch-bracket-class.md (G-a, R6) · **Supersedes/Refines:** applies DOCTRINE(D-2), DOCTRINE(D-5)

## Context

`tokenizeIgnoreLine` strips every `\` before `compileGlob` sees the pattern. In `.gitignore` and
non-cone sparse rules `\*` and `\?` therefore become wildcards (`\*` ignores every file, rows E2,
E3, E10, SP8), and a trailing lone `\` stays a literal where git matches nothing (E6, SP12).
`.gitattributes` passes `\` through as a literal, so `\*`, `\[a]`, `a\b`, `\!a` and `\#a` never
match what git matches (E1–E13). git has no unescape step: `parse_path_pattern` reads `!`, `/` and
the wildcard-free prefix on raw bytes, and `dowild` resolves each `\`.

## Options considered

1. **Keep escapes in the pattern handed to the matcher for all three consumers; the matcher
   resolves them** (recommended).
2. Keep the parser-side unescape and special-case `\*`, `\?` and `\[`.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-2): the class rows make `\[a]` reach
the unescape, and the shared primitive already diverges on main; DOCTRINE(D-5): the divergence is
proven in a seam the change edits. Option 1: `unescapePattern` is deleted, `cleanPattern` keeps
its escapes, and `.gitattributes` hands its C-unquoted pattern over intact. Negation, comment,
anchoring and directory-only detection stay on raw characters, as in `parse_path_pattern`.

## Consequences

### Positive

- `\*`, `\?`, `\[`, `\!`, `\#` and `\ ` match the literal character in all three consumers.

### Negative

- A `.gitignore` relying on `\*` as a wildcard stops matching every file.
