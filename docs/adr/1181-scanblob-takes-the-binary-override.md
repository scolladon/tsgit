---
subjects:
  - src/application/commands/grep.ts
---
# 1181 — `scanBlob` takes the binary override; grep passes a per-path reader

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-diff-attribute-binary.md · **Supersedes/Refines:** —

## Context

The attribute verdict has to reach the one place grep branches on binary content.

## Decision

**adopted-as-recommended (no user judgment)** — no trade-off between the mechanics.
`scanBlob(matcher, bytes, override?)` branches on `sideIsBinary(bytes, override)`;
`grepCandidates` takes an optional `overrideOf(path)` reader resolved per candidate after the
pathspec filter. `Candidate` is unchanged.

Rejected: an `override` field on `Candidate` resolved eagerly (reads attributes for paths the
pathspec drops) and separate text/binary scan functions (duplicated result assembly).

## Consequences

### Positive

- One branch point, shared with diff's `sideIsBinary` semantics.
