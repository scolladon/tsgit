---
subjects:
  - src/domain/glob/wildmatch.ts
---
# 1254 — A bracket set compiles to a byte table

- **Status:** accepted
- **Date:** 2026-11-23
- **Design:** docs/design/wildmatch-bracket-class.md (DC-D, R5) · **Supersedes/Refines:** refines ADR-077

## Context

`ref-glob.ts` tests a set by scanning its member list for every table cell, so a cell costs the
set's size. The ignore family tests every walked path against every rule.

## Options considered

1. **A 256-entry table per set, built at compile time with the fold, the negation and the `/`
   exclusion applied** (recommended).
2. Scan the member list per cell.

## Decision

**Adopted-as-recommended (no user judgment)** — no trade-off: the alternatives differ in
mechanics. Option 1. `?` is the table that admits every byte but `/` under `WM_PATHNAME`.

## Consequences

### Positive

- A cell costs one indexed read whatever the set holds, so ADR-077's bound does not depend on set
  size.

### Negative

- Each set holds 256 bytes for the life of its compiled pattern.
