---
subjects:
  - src/application/commands/add.ts
  - src/domain/git-index/resolve-undo.ts
---
# 999 — add writes resolve-undo when it resolves a conflict

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** —

## Context

Staging an unmerged path makes git record its stages 1–3 in the index's `REUC` extension, which
`git ls-files --resolve-undo` lists (pinned on git 2.55). tsgit reads `REUC` (fsck) but no command
writes it. A full fix spans every command that resolves a conflict.

## Options considered

1. Leave it out with its own backlog item (recommended).
2. Fold for `add` only.

## Decision

**User-ratified — option 2 (deviates from the design's recommendation).** When `add` collapses or
removes an unmerged path, it records that path's prior stages in `REUC`, keeping any existing record
for other paths, as git does. Other commands (`rm`, `update-index`, `checkout -m`) stay as they are.

## Consequences

- The `REUC` extension gains a serializer and the index write path carries it.
- `rm`, `update-index` and `checkout -m` still diverge on resolve-undo; that remains to be reported.
