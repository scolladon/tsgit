---
subjects:
  - src/domain/pathspec/compile-glob.ts
---
<!-- cspell:ignore fspathncmp -->
# 1253 — compileGlob keeps the three fast paths git has

- **Status:** accepted
- **Date:** 2026-11-23
- **Design:** docs/design/wildmatch-bracket-class.md (DC-C, R10) · **Supersedes/Refines:** refines ADR-077

## Context

`compileGlob` settles a pure-literal pattern by string comparison and rejects a path that lacks
the pattern's literal prefix before filling any table. Both count `[` and `\` as literal
characters, which is wrong once sets and escapes exist. git's `dir.c` has three such paths, each
decided on `simple_length`, the run before the first `* ? [ \`: a pattern with no special
character, a `*` followed by no special character (`*.log`), and a literal prefix. Each compares
with `fspathncmp`, which folds under `core.ignorecase`. The probes show all three agree with
wildmatch over the whole pattern.

## Options considered

1. **git's three, each on `simple_length` and on the folded path** (recommended).
2. Today's two, redefined on `simple_length`.
3. None: every call fills the table.

## Decision

**Adopted-as-recommended (no user judgment)** — no trade-off: the alternatives differ in
mechanics, and all three paths are git's own. Option 1. An aborting pattern beats every fast
path: it matches nothing. An escape or a set ends the prefix, so `\*x` and `[ab]c` have none.

## Consequences

### Positive

- `*.log`, the commonest `.gitignore` shape, is settled by one suffix comparison and never pays
  the encode or the table.

### Negative

- Three string shortcuts must stay in agreement with the table fill; the property suite checks it.
