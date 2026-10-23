---
subjects:
  - src/domain/pathspec/compile-pathspec.ts
  - src/domain/pathspec/looks-like-pathspec.ts
supersedes:
  - adr: "037"
    scope: "the glob-special character set that classifies a pathspec as a glob"
---
# 1034 — A pathspec is a wildcard when it holds `*`, `?`, `[` or `\`

- **Status:** accepted
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** supersedes ADR-037 (the character set)

## Context

ADR-037 classifies a pathspec by content: a glob iff it holds `*`, `?` or `[`. The shipped
`containsGlob` tests `*` and `?` only, so `[a-c].txt` and `a\*b` are literals that match nothing
(D5a, D6) and `a\b` refuses where git stages `ab` (E2). git's `is_glob_special` — used by
`simple_length` to find the no-wildcard prefix and to decide whether `wildmatch` runs at all — is
`*`, `?`, `[` and `\`. A pattern whose verbatim form exists still matches it first (D8a `a[`, D8b
`a\`, E3 `a[b`), so widening the set loses no literal file. `looksLikePathspec`
(`looks-like-pathspec.ts`) is git's `looks_like_pathspec` for argument disambiguation — a
different function with its own escape rule — and is untouched.

## Options considered

1. **git's `is_glob_special`: `* ? [ \`** (designer's recommendation) — every pinned row; the
   verbatim-first rule keeps `a[`, `a\` and `a[b` matching their literal files.
2. **ADR-037's text, `* ? [`** — `[…]` works, `\` escapes do not (D6, D17, E1, E2 diverge).
3. **Today's `* ?`** — the pinned wrong results stay.

## Decision

**User-ratified — option 1** (decided with ADR-1033 as one dialect question). `isLiteral` is
`!hasGlobSpecial(body)` with the set `*`, `?`, `[`, `\`. A literal keeps git's directory-prefix
semantics; a wildcard runs the ADR-1033 verbatim-then-wildmatch rule. `looksLikePathspec` keeps
its own set and escape handling.

Superseded from ADR-037: the character set — `*`, `?`, `[` — that makes a pattern a glob.

Carried forward from ADR-037: classification by content with no prefix vocabulary; a literal is a
directory prefix (`src` covers everything under it); `!` is stripped before detection (ADR-038);
`validateWorkingTreePath` rejects hostile bodies for literals and globs alike.

## Consequences

- A body holding a `\` or `[` can no longer be a literal; it still reaches a file spelled exactly
  like it through the verbatim rule, so no existing call site loses a match.
- The 256-byte and `**`-count budgets in `resolve-pathspec.ts` are unchanged.
