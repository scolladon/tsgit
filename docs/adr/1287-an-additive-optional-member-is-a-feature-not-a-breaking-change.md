---
subjects:
  - src/application/commands/checkout.ts
---
# 1287 — an additive optional member is a feature, not a breaking change

- **Status:** accepted
- **Date:** 2026-11-27
- **Design:** docs/design/checkout-remote-branch-dwim.md (DC-7) · **Supersedes/Refines:** refines ADR-1257; amends DOCTRINE(D-6)

## Context

This change adds the `guess` option (ADR-1281) and the `createdBranch` result field (ADR-1282).
D-6 keeps `!` for "signature or type changes", which read literally covers an added optional
member, although no caller compiled against the current types fails.

## Options considered

1. **`feat(checkout):` without `!`** for the additive members, with the guess and the folds in
   `fix(checkout):` (recommended).
2. Mark `!` per D-6's wording.
3. Everything in one `fix(checkout):`.

## Decision

**Ratified by the user** — option 1. ADR-1257's purpose is to warn the callers a change breaks;
an optional member breaks none. Option 3 hides a new option inside a fix. D-6 is amended: an
additive optional member (option or result field) ships as `feat(<scope>):` without `!`; `!`
stays for D-3's case and for type changes that break a compiled caller (a removed, renamed,
narrowed or newly required member).

## Consequences

### Positive

- The release is a minor version.

### Negative

- None.
