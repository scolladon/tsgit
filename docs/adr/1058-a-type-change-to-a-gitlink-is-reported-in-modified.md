---
subjects:
  - src/application/commands/add.ts
---
# 1058 — A type change to a gitlink is reported in `modified`

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1054

## Context

A tracked file replaced on disk by a repository becomes a `160000` entry (git's `T`). `AddResult`
already reports a file replaced by a symlink in `modified` (design row EM77) and a moved gitlink
the same way (GL14).

## Options considered

1. **`modified`, as the other type changes** — the designer's recommendation.
2. **A new field for type changes** — a shape no other command uses.

## Decision

**Adopted as recommended (no user judgment) — option 1.**

## Consequences

- The result shape does not change; the documentation names the type change under `modified`.
