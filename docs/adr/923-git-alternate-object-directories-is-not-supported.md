---
subjects: []
---
# 923 — `GIT_ALTERNATE_OBJECT_DIRECTORIES` is not supported

- **Status:** accepted
- **Date:** 2026-10-01
- **Design:** docs/design/alternates-object-lookup.md (DC-11) · **Supersedes/Refines:** none

## Context

git also reads alternates from `GIT_ALTERNATE_OBJECT_DIRECTORIES`. This feature was scoped to the
`objects/info/alternates` file. tsgit already reads a few variables through `ctx.env`
(`GIT_NOTES_REF`, `GIT_SSH_COMMAND`), so support would be possible later.

## Options considered

1. **Unsupported, recorded here** (recommended).
2. **An `openRepository` option `alternateObjectDirectories`**.
3. **Read through `ctx.env`** — cheap later.

## Decision

**Adopted-as-recommended (no user judgment) — option 1.** Revisit on a reported need; option 3 is the cheap path then.

## Consequences

- A repository relying solely on the environment variable resolves fewer objects in tsgit than in git.
