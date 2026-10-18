---
subjects:
  - src/domain/path/verify-path.ts
  - src/domain/working-tree-path.ts
---
# 1004 — The `.git` alias scan skips a backslash that opens a component

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/gitmodules-backslash-alias.md · **Supersedes/Refines:** refines ADR-1003

## Context

git's `verify_path` consumes the first byte of each component in its `inside:` block, so a
backslash in that position is never tested. Pinned against git 2.55 (3/3, mode 100644):
`\.git`, `\git~1`, `x/\.git`, `\.git\y`, `x/\.git/y` and `\.git:s` are admitted; `\\.git`
and `x\.git` are refused. tsgit's `matchAliasComponent` splits on every `\`, so it refuses
the first six.

## Options considered

1. Fix it in `matchAliasComponent`, which serves `verifyPath` and `isDotGitAlias`.
2. File a backlog item (recommended by the designer: outside the brief).
3. Fix `verifyPath` only.

## Decision

**User-chosen** — option 1. `isDotGitAlias`'s only caller, `working-tree-path.ts`, rejects
any input holding `\` before it calls the alias check, so the shared fix changes nothing
observable there and needs no separate pin.

## Consequences

- An over-refusal becomes faithful admission for index entries whose component opens with `\`.
