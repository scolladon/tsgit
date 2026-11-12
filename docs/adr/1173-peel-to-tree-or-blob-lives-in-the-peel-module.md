---
subjects:
  - src/application/primitives/internal/peel.ts
  - src/application/commands/internal/resolve-rev.ts
---
# 1173 — the tree-or-blob peel lives in the peel module beside `peel`

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-blob-target.md · **Supersedes/Refines:** —

## Context

grep dispatches on the object a rev reaches: tags followed to any depth, a commit read as its
tree, a tree or a blob searched. `peel(…, 'tree')` already walks there but refuses a blob.

## Decision

**Ratified by the user.** `peel.ts` exports `peelToTreeOrBlob`, sharing `peel`'s walk;
`resolve-rev.ts` exports `resolveTreeOrBlob`, which replaces `resolveTreeish` (grep was its
only caller). `peel`'s signature is unchanged.

Rejected: inspecting the object type inside `grep.ts` (duplicates the hop policy in a command)
and widening `peel`'s target to a set (changes a signature `rev-parse`, `archive`,
`write-commit-graph` and `diff` share, each wanting one kind).

## Consequences

### Positive

- One peel policy, one module; the command stays thin.

### Negative

- `peel.ts` gains a second export over the same walk.

### Neutral

- `resolveTreeish` disappears; no other caller exists.
