---
subjects:
  - src/domain/diff/similarity.ts
---
# 911 — Similarity hashing wraps to 32 bits and skips the CR of a CRLF pair

- **Status:** accepted
- **Date:** 2026-09-26
- **Design:** docs/design/diff-core-parity-hardening.md (item 3, H5) · **Supersedes/Refines:** none

## Context

Probes against git 2.55.0 show two scoring divergences in the spanhash port: the bucket hash
does not wrap to 32 bits (`-M47250`: git pairs, tsgit does not) and the CR of a CRLF pair is
counted in text (git R065, tsgit R071).

## Options considered

1. **Fix both before the typed-fingerprint rewrite, so the rewrite's oracle is correct** —
   *recommended by the design.*
2. Hash fix only.
3. Defer both.

## Decision

**Option 1 — adopted-as-recommended (no user judgment).** Faithfulness prime directive.

## Consequences

- Similarity scores match git on the pinned rows.
