---
subjects:
  - src/application/commands/rm.ts
  - src/application/commands/grep.ts
---
# 1195 — No structured analogue for a failed-stat warning

- **Status:** accepted
- **Date:** 2026-11-16
- **Design:** docs/design/long-pathspec-refusals.md (D5) · **Supersedes/Refines:** refines ADR-249

## Context

`rm --cached` of an index-only name the host cannot stat succeeds in git with `warning: failed to
stat '<p>': File name too long` on stderr. The warning changes no state.

## Options considered

1. **None: success data only** (recommended).
2. **A new result field listing unreadable paths** — no consumer asks for it.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-249: faithfulness binds data and on-disk
state, not stderr.
