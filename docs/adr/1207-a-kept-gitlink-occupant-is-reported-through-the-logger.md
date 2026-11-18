---
subjects:
  - src/application/primitives/apply-changeset.ts
---
# 1207 — A kept gitlink occupant is reported through the logger

- **Status:** accepted
- **Date:** 2026-11-18
- **Design:** docs/design/gitlink-rmdir-keeps-occupant.md · **Supersedes/Refines:** none

## Context

git prints `warning: unable to rmdir '<p>': Not a directory` when it leaves a file or symlink at
a removed gitlink's path. `removeGitlinkDirectory` already logs git's `Directory not empty` line
through `ctx.logger?.warn`. No result of `reset`, `checkout`, `stash` or `merge` carries a
warnings field, and ADR-249 forbids rendered text in results.

## Options considered

1. **`ctx.logger?.warn` with git's text**, beside the existing directory-case line.
2. **Report nothing.**
3. **A structured `kept`/`warnings` field on four results.**

## Decision

**ratified by the user** — option 1. The logger is the existing diagnostic side channel, not a
result, so ADR-249 is not engaged; a result field would be new public surface for a diagnostic.

## Consequences

Both arms of the gitlink removal warn with git's wording; no result type changes.
