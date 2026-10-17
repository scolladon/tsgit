---
subjects:
  - src/application/commands/add.ts
---
# 998 — An exclusion does not shield an unmerged path from add

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** —

## Context

`git add . ':!f'` stages an unmerged `f` despite the exclusion (pinned on git 2.55: `add 'f'`, `f` at
stage 0), as it reports an excluded unmerged `a/b` removed (design row R12). tsgit's walk leaf filter
skips `f`, leaving the conflict in place.

## Options considered

1. Leave it out with a backlog entry (designer's recommendation).
2. Fold it: a positive pathspec that covers an unmerged path stages it whatever the exclusions say.

## Decision

**User-ratified — option 2 (deviates from the design's recommendation).** The walk's leaf filter lets an
unmerged path through when a positive pathspec element covers it.

## Consequences

- Conflict resolution through `add` with exclusions matches git.
