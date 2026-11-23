---
subjects:
  - src/domain/attributes/parse-gitattributes.ts
---
# 1256 — A negative attribute pattern is dropped without a diagnostic

- **Status:** accepted
- **Date:** 2026-11-23
- **Design:** docs/design/wildmatch-bracket-class.md (G-e, DC-F, R9) · **Supersedes/Refines:** applies DOCTRINE(D-5), ADR-249

## Context

`parseGitattributes` treats a `!`-led pattern as a literal: `.gitattributes` `!a foo` gives the
file `!a` the attribute. git skips the line and warns "Negative patterns are ignored in git
attributes", so `!a` stays unspecified (row N1). A literal leading `!` is written `\!`, which the
matcher now resolves (N2).

## Options considered

1. **Drop the line silently** (recommended).
2. Drop it and write git's warning through the logger.
3. Drop it and record the dropped line on the parse result.

## Decision

**Adopted-as-recommended (no user judgment)** — DOCTRINE(D-5) for the drop: the divergence is
proven in `buildRule`, which the change edits. ADR-249 for the diagnostic: git's warning is text
on standard error, and no command result carries parse diagnostics. Option 1.

## Consequences

### Positive

- `!pattern` lines no longer attribute a file named with a leading `!`.

### Negative

- A caller cannot learn that a line was dropped.
