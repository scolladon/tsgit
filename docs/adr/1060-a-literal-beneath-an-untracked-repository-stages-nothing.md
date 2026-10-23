---
subjects:
  - src/application/commands/add.ts
---
# 1060 — A literal beneath an untracked repository stages nothing

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1054 and ADR-1035

## Context

`git add sub/u` where `sub` is an untracked repository exits 0 and stages nothing (design rows EM8,
EM49, EM65); tsgit's literal fast path stages the file.

## Options considered

1. **The fast path probes an untracked literal's ancestors that have no index entries beneath
   them; tracked literals pay nothing** — the designer's recommendation.
2. **Route every literal through the walk** — a walk per literal add.

## Decision

**Adopted as recommended (no user judgment) — option 1.**

## Consequences

- The probe runs only for untracked literals; the common case (a tracked literal) is untouched.
