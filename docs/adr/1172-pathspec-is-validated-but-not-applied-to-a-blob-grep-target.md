---
subjects:
  - src/application/commands/grep.ts
---
# 1172 — a pathspec is validated but not applied to a blob grep target

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-blob-target.md · **Supersedes/Refines:** refines ADR-226

## Context

A blob target has no path to match a pathspec against. git 2.56 pinned:
`git grep NEEDLE HEAD:f1 -- nomatch` still matches; `-- ../outside` exits 128.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-226 (git pins the behaviour; the
alternatives diverge). The pathspec is resolved and validated as today, so its refusals hold,
and never filters a blob target.

## Consequences

### Positive

- Byte-for-byte with git on both the refusal and the non-filtering.

### Negative

- A caller passing a pathspec with a blob target gets a match the pathspec "excludes" — git does the same.

### Neutral

- Tree, index and working-tree targets keep pathspec filtering.
