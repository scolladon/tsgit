---
subjects:
  - src/application/commands/add.ts
---
# 1062 — The no-commit refusal comes before any blob write

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-1035 and ADR-1057

## Context

git's `does not have a commit checked out` refusal is not zero-write: blobs of paths sorted before
the repository are already written (design rows EM45, EM60 — four loose objects against three).
ADR-1035 commits every `add` refusal to leave zero loose objects.

## Options considered

1. **Refuse before any blob write, as ADR-1035 requires** — the divergence is unreachable loose
   objects only; the index is identical. The designer's recommendation.
2. **Match git's write order** — reopens ADR-1035 for a difference no caller can observe through
   the index.

## Decision

**Adopted as recommended (no user judgment) — option 1.**

## Consequences

- The interop twins compare the index and the refusal, not the loose-object count, for these rows.
