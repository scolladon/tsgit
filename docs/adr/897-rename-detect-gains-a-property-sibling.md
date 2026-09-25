---
subjects:
  - test/unit/domain/diff/rename-detect.properties.test.ts
---
# 897 — `detectRenames` gains a property-test sibling

- **Status:** accepted
- **Date:** 2026-09-25
- **Design:** docs/design/rename-exact-one-shot-delete.md (§6 Part 3, D5) · **Supersedes/Refines:** none

## Context

`detectRenames` is a matcher reducing changes to a pairing. Issue #300 part A is a
conservation violation no example caught.

## Options considered

1. **`rename-detect.properties.test.ts`** — one-shot source, path conservation, id/mode
   soundness, pass-through, idempotence. *Recommended by the design.*
2. Examples only.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Aligns with the property-testing
guidance (ADRs 134–136).

## Consequences

- The pairing grammar is proved over generated inputs; examples keep documenting git's rows.
