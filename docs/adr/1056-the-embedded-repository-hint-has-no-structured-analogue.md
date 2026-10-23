---
subjects:
  - src/application/commands/add.ts
---
# 1056 — The "adding embedded git repository" hint has no structured analogue

- **Status:** accepted
- **Date:** 2026-10-23
- **Design:** docs/design/pathspec-glob-dialect.md · **Supersedes/Refines:** refines ADR-249 and ADR-1054

## Context

git prints a hint on stderr when `add` stages an embedded repository; its exit code is unaffected.
The library returns data (ADR-249): the gitlink is already visible as a `160000` entry and in
`added` or `modified`.

## Options considered

1. **No new field** — the designer's recommendation.
2. **An `AddResult.embedded` list of the paths staged as new gitlinks** — restates what the index
   and `added` already say, for a message git treats as advice.

## Decision

**Adopted as recommended (no user judgment) — option 1.**

## Consequences

- A caller that wants git's hint derives it from the mode of the staged entry.
