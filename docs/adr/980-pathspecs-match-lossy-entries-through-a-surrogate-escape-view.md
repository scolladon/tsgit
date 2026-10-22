---
subjects:
  - src/domain/pathspec/compile-glob.ts
---
<!-- cspell:ignore FFFD multibyte -->
# 980 — Pathspecs match lossy entries through a surrogate-escape view


> **Superseded by [ADR-1033](1033-pathspecs-match-with-gits-default-wildmatch-over-the-escape-views-bytes.md)**
> for the wildcard width: `?` and `[…]` now match one byte of the escape view, as git's do, instead
> of one code unit. The surrogate-escape matching view itself, the internal-only rule and the
> public U+FFFD `path` are carried forward.

- **Status:** superseded by ADR-1033
- **Date:** 2026-10-15
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-972

## Context

A string pathspec matched against a lossy entry's U+FFFD view selects its literal twin too: `rm --cached '\uFFFD.txt'` removes both where git removes only the literal (design §D15).

## Options considered

1. **Surrogate-escape matching view** (`U+DC00 + byte` per invalid byte), internal only (recommended).
2. Exclude lossy entries from literal matches only.
3. A byte-level pathspec matcher.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Literals, `*`, `**`, directory prefixes and `?` give git's answers; UTF-8 entries pay nothing. The public `path` stays the U+FFFD view (ADR-968).

## Consequences

- A user string never names a lossy entry literally; globs reach it as git's do.
- Valid multibyte `?` keeps its existing behaviour (separate, pre-existing).
