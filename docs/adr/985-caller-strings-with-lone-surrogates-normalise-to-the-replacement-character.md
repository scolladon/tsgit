---
subjects:
  - src/domain/git-index/index-path-key.ts
---
<!-- cspell:ignore FFFD -->
# 985 — Caller strings with lone surrogates normalise to the replacement character

- **Status:** accepted
- **Date:** 2026-10-16
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-981

## Context

Under ADR-981 a lossy key holds lone surrogates `U+DC80`–`U+DCFF`. A caller string (a pathspec, an
`mv` argument) can hold the same code units and would then address a lossy entry by string, which
ADR-972 rules out. Encoding such a string to UTF-8 already yields U+FFFD for each lone surrogate.

## Options considered

1. **Normalise lone surrogates to U+FFFD at the intakes** (recommended).
2. Refuse with a typed error.
3. Accept.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** A caller string means what its UTF-8
encoding means, so it never equals a lossy key.

## Consequences

- No new error code; a string names exactly the bytes it encodes to.
