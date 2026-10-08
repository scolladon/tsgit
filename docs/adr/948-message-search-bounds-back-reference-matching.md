---
subjects:
  - src/domain/regex/extended-regex.ts
  - src/application/commands/internal/commit-message-search.ts
---
# 948 — Message search bounds back-reference matching with a step budget

- **Status:** accepted
- **Date:** 2026-10-08
- **Design:** docs/design/alternates-object-lookup.md · **Supersedes/Refines:** refines ADR-226

## Context

`:/<re>` and `<rev>^{/<re>}` match a GNU extended regular expression against commit messages. tsgit
runs patterns without back-references on a linear-time automaton. Patterns with `\1`–`\9` need a
backtracking matcher; tsgit used V8's `RegExp`, which is exponential on adversarial pattern/subject
pairs and cannot be interrupted mid-match. Measured: `(a+)+b\1c` over `a…abc` takes 0.6 s at 24
characters and 2 s at 26, doubling per character, while glibc's `regexec` (git on Linux) stays flat at
5–26 ms up to 72 characters. A linear superset check refuses most subjects first, but one it cannot
rule out still reaches V8. The pattern comes from the caller; the subject is repository-controlled.

## Options considered

1. **Step-limited backtracking matcher** over the existing compiled program, with a step budget and the
   caller's abort check; past the budget the pattern refuses as no match.
2. **Cap the subject length** for back-reference patterns.
3. **Accept** the exponential case and document that callers must reject `\1`–`\9` themselves.

## Decision

**User-ratified — option 1.** Back-reference patterns run on a backtracking matcher of tsgit's own, bounded by a
named step budget and consulting the same abort check as the linear automaton. A match that exhausts
the budget answers "no match" — git's own silent outcome for a pattern its `regcomp` refuses — so
`:/` reports the revision as unresolved. V8's `RegExp` is no longer used for message search.

## Consequences

- Divergence, recorded here: on a subject where glibc would find a match only after more work than the
  budget allows, tsgit answers "no match". Below the budget, answers are identical (pinned by the
  differential property against an independent ECMAScript oracle and by rev-parse interop rows).
- The search can be aborted on every path; worst-case work per message is bounded.
- Size: the backtracking matcher adds to the regex module; the cost is reported in the size-trim record.

**Amendment (2026-10-08) — platform split in git itself.** git hands extended patterns to the C
library's regex: glibc (Linux) and the bundled GNU regex (Windows) read `\1`–`\9` as back-references,
while the macOS C library reads them as a literal digit (`:/(a)\1` matches `za1` there). tsgit follows the GNU
reading on every platform, as it did before this decision; interop rows whose answer depends on the
reading run on non-darwin platforms only.
