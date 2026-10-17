---
subjects:
  - src/application/commands/add.ts
---
# 993 — add stages the removal beneath a regular file instead of refusing

- **Status:** accepted
- **Date:** 2026-10-17
- **Design:** docs/design/add-dir-replaced-by-non-dir.md · **Supersedes/Refines:** —

## Context

With a regular file `a` where a tracked directory was, `add a/b` and `add a a/b` throw
`NOT_A_DIRECTORY` in tsgit. git 2.55 stages the removal of `a/b` and exits 0 (rows R13, R14).

## Options considered

1. Fold: the fast-path probe treats `NOT_A_DIRECTORY` as missing, so the walk stages the removal
   (recommended).
2. Leave it out with a backlog entry.

## Decision

**User-ratified — option 1.** Only `NOT_A_DIRECTORY` joins `FILE_NOT_FOUND` as "missing"; every
other failure still propagates.

## Consequences

- A wrong refusal becomes git's removal; no other error is absorbed.
