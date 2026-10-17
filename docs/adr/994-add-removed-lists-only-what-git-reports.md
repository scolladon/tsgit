---
subjects:
  - src/application/commands/add.ts
---
# 994 — add's removed lists only what git reports

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** —

## Context

The directory/file rule drops some entries silently: git prints no `remove` line for them (rows R6, R7,
M1). `AddResult.removed` is the structured source a caller uses to reconstruct `add -v`.

## Options considered

1. `removed` holds git's reported removals only (recommended).
2. `removed` holds every dropped entry.

## Decision

**Adopted-as-recommended (no user judgment)** — option 1, aligned with ADR-226 (git-faithfulness) and
ADR-249 (structured data reconstructs git's display): a reconstruction must not print lines git does not.

## Consequences

- Silent drops are visible only through the resulting index, as in git.
