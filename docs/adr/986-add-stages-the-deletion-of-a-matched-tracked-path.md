---
subjects:
  - src/application/commands/add.ts
---
# 986 — `add` stages the deletion of a matched tracked path

- **Status:** accepted
- **Date:** 2026-10-16
- **Design:** docs/design/index-entry-path-bytes.md · **Supersedes/Refines:** refines ADR-226

## Context

`git add <pathspec>` stages the removal of a tracked path the pathspec matches when it is missing from
the working tree. tsgit's pathspec route never stages a deletion, for any path. Lossy entries read as
absent from disk (ADR-973), so git's `add '*.txt'` outcome for them depends on this rule.

## Options considered

1. Keep lossy entries out of the matching view only.
2. **Stage the deletion of every matched tracked path missing from disk**, as git does (recommended).

## Decision

**Adopted-as-recommended (no user judgment) — option 2.** A git-faithful fold of a gap that also
exists for UTF-8 paths; pinned against git before the fix lands.

## Consequences

- `add <pathspec>` reports and stages removals the way git does.
