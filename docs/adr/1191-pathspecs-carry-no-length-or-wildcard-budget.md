---
subjects:
  - src/application/commands/internal/resolve-pathspec.ts
supersedes:
  - adr: "1043"
    scope: "the 256-byte and four-double-star pathspec budgets stay"
---
# 1191 — Pathspecs carry no length or wildcard budget

- **Status:** accepted
- **Date:** 2026-11-16
- **Design:** docs/design/long-pathspec-refusals.md (D1) · **Supersedes/Refines:** supersedes ADR-1043 (the pathspec-budget clause)

## Context

`resolvePathspec` refused a pattern over 256 UTF-8 bytes and one holding more than four `**`
tokens with `INVALID_OPTION`. git 2.56 has neither limit: `add`, `rm`, `checkout --` and
`grep --` act on an 805-byte path, a 257-byte path and `**a**b**c**d**x`, and an unmatched long
pattern ends in git's no-match outcome. ADR-1043 kept both budgets only to stay inside the 32.11
scope. Measured on the matcher (`compileRefGlobBytes`, a non-backtracking two-row dynamic
program): compile is linear (131 KB pattern, 6.6 ms) and the cost per path is bounded by the
path's length, not the pattern's (131 KB hostile pattern: 39 µs per 100-byte path). A run of `*`
is one token, so the `**` count bounds nothing. A 256-byte pattern already costs 1.8 ms on a
4000-byte path, so the byte budget does not bound the cost it names.

## Options considered

1. **Delete both** (recommended) — no refusal git does not make.
2. **Delete the refusals, add a non-refusing short-circuit** (no match when the pattern has more
   consuming tokens than the path has bytes) — same outcome; saves time only on paths far longer
   than usual, which no measured caller sends.
3. **Keep both** — the budget rows keep refusing where git acts.

## Decision

**ratified by the user** — option 1. `MAX_PATHSPEC_PATTERN_BYTES`, `MAX_DOUBLE_STAR_PER_PATTERN`,
`PATTERN_ENCODER`, `enforcePatternBudget` and `countDoubleStars` are deleted. `resolvePathspec`
refuses a pattern by its shape only.

Superseded from ADR-1043: the clause keeping the 256-byte and four-`**` budgets.
Carried forward from ADR-1043: the browser-bundle cap procedure (offset first, then raise by the
measured delta).

## Consequences

### Positive

- `add`, `rm`, `checkout` paths and `grep` paths accept every pattern git accepts.

### Negative

- A pathological pattern against a pathologically long path costs tens of milliseconds per path;
  git's own `wildmatch` has no bound either.
