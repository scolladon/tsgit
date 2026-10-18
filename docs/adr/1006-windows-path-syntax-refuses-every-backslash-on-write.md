---
subjects:
  - src/domain/path/verify-path.ts
  - src/domain/git-index/path-validator.ts
  - src/application/primitives/internal/index-path-rules.ts
---
# 1006 — Under Windows path syntax, every index-write surface refuses a backslash

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/gitmodules-backslash-alias.md (Addendum) · **Supersedes/Refines:** refines ADR-1004, applies ADR-978

## Context

ADR-1004 admits `\.git\hooks\post-checkout` the way git on POSIX does. On Windows the node
adapter resolves `\` as a separator, so a checkout of such an entry writes into
`<worktree>\.git\hooks`. git for Windows refuses every `\` in `verify_path` (its
`GIT_WINDOWS_NATIVE` arm). tsgit had no such rule, and the old over-refusal of a
component-leading `\.git` was the only thing closing this route.

## Options considered

- WD1, where the rule applies: (a) write surfaces only, so parse, write-tree and archive stay
  posix (recommended); (b) at parse too.
- WD2, API shape: (a) the domain rule values `posixIndexPathRules` and `windowsIndexPathRules`,
  picked once by `indexPathRulesOf(ctx)` (recommended); (b) a member on `GitPathSyntax`;
  (c) a positional tag argument.
- WD3, merge re-checks after the merge gate: (a) stay posix, because the gate already checks
  the whole set with the Windows rule (recommended); (b) the Windows rule everywhere.
- WD4, reason order: `backslash` first, as a wrapper around `verifyPath` (recommended).
- WD5: a Windows-only interop test against real git for Windows, run by CI (recommended).

## Decision

**User-chosen**: keep ADR-1004 and add the Windows rule. WD1 (a), WD2 (a), WD3 (a), WD4 (a)
and WD5 (a) were all chosen as recommended.

## Consequences

- A repository written on Linux with a `\` filename still parses on Windows, as it does in git.
  Checking out that path is refused, as it is in git.
- The rule follows `ctx.windowsPathSyntax`, so it is on for the node runtime's own filesystem
  on Windows only.
- New rejection reason `backslash`.
- The git-for-Windows behaviour is read from source. The win-only interop test is its only
  empirical pin, and it runs only on CI.
