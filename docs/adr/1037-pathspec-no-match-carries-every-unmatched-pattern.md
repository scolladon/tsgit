---
subjects:
  - src/domain/commands/error.ts
  - src/application/commands/checkout.ts
---
# 1037 — `PATHSPEC_NO_MATCH` carries every unmatched pattern

- **Status:** accepted
- **Date:** 2026-10-22
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-249 (structured output); none superseded

## Context

`add` and `rm` die on the first unmatched pathspec. `checkout -- <pathspecs>` reports every
unmatched one, in argument order, one `error: pathspec '…' did not match any file(s) known to git`
line each, then exits 1 (C4, C5). `PATHSPEC_NO_MATCH` holds a single `pattern`. The wording and
the exit status are display: the caller knows which command it called and renders them from the
code (ADR-249).

## Options considered

1. **Additive `patterns: ReadonlyArray<string>`** (designer's recommendation) — every unmatched
   spelling in order; `pattern` stays the first. Pros: C4/C5's data without breaking `code`
   consumers. Cons: two fields carry the first spelling.
2. **First only** — drops a pinned line.
3. **A new checkout-specific code** — breaks callers matching `PATHSPEC_NO_MATCH` from `checkout`.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** `PATHSPEC_NO_MATCH` gains
`patterns`, always non-empty, with `patterns[0] === pattern`. `add` and `rm` fill it with one
entry; `checkout` with every unmatched positive pathspec in argument order.

## Consequences

- An additive public type change on the error union; no consumer breaks.
- The interop test reconstructs git's multi-line report from `patterns`.
