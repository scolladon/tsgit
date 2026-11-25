---
subjects:
  - src/domain/glob/wildmatch.ts
  - src/domain/refs/ref-glob.ts
  - src/domain/pathspec/compile-glob.ts
supersedes:
  - adr: "1041"
    scope: "`[…]` and `\\` stay verbatim and `?` is one UTF-16 unit in `compileGlob`"
---
<!-- cspell:ignore casefold -->
# 1248 — The ignore-family glob runs on one shared wildmatch core

- **Status:** accepted
- **Date:** 2026-11-23
- **Design:** docs/design/wildmatch-bracket-class.md (DC-A, R2, R4, R5) · **Supersedes/Refines:** supersedes ADR-1041 (verbatim `[…]` and `\`); refines ADR-040 and ADR-077

## Context

`compileGlob` reads `[…]` and `\` as literal text; git's `dowild` reads a bracket expression as a
character class and `\` as an escape (rows C1–C63, E1–E13). `src/domain/refs/ref-glob.ts` already
implements `dowild`'s whole grammar over UTF-8 bytes as a linear dynamic program, with a
`WM_PATHNAME` dialect, but without case folding or anchoring. Its bracket parser scans to the
next `]` again from every `[:`, so compiling `'[' + '[:'.repeat(n) + 'x]'` took 20, 62 and 250 ms for
n = 5000, 10000 and 20000: a factor of four per doubling.

## Options considered

1. **Move ref-glob's tokenizer and matcher into `src/domain/glob/wildmatch.ts`, taking
   `{ pathname, caseFold }`; `ref-glob.ts` and `compile-glob.ts` become wrappers** (recommended).
2. Extend `ref-glob.ts` in place with a `{ pathname, caseFold }` entry that `compileGlob` imports.
3. Write a class token into `compile-glob.ts` over UTF-16 units.

## Decision

**User-ratified — option 1.** One module owns git's grammar: the ordered `dowild` branches T0–T7
and B1–B9 of the design. `ref-glob.ts` keeps its four exports as dialect wrappers with unchanged
behaviour. `compileGlob` keeps its signature and adds anchoring and git's fast paths on top of the
core. A pattern `dowild` would abort on compiles to a matcher that accepts nothing.

Compilation is linear in the pattern's bytes: the `[:` lookahead reads a precomputed index of the
next `]` and never scans the same bytes twice. Matching keeps ADR-077's bound, `O(tokens × path bytes)` with no
backtracking.

Refused: option 2 makes `.gitignore`, `.gitattributes` and sparse matching depend on a module
named for refs. Option 3 duplicates about 150 lines of bracket parsing, still needs bytes for `?`
and sets, and leaves the quadratic compile in `ref-glob.ts`.

## Consequences

### Positive

- One bracket grammar; the two parsers cannot drift.
- The quadratic bracket compile is fixed for ref globs, pathspecs and `merge.suppressDest` too.

### Negative

- The diff moves code that five importers reach through `ref-glob.ts`, and the moved code
  re-enters the mutation scope.
