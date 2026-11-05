---
subjects:
  - src/application/primitives/resolve-oid-prefix.ts
---
# 1142 — an unreadable fanout directory is skipped and logged as structured error data

- **Status:** accepted
- **Date:** 2026-11-04
- **Design:** docs/design/rev-parse-corrupt-input.md · **Supersedes/Refines:** refines ADR-222, ADR-887, ADR-249

## Context

`scanLooseIn`, the loose half of the abbreviated-oid scan, folds `FILE_NOT_FOUND` and
`NOT_A_DIRECTORY` to an empty listing and rethrows every other `readdir` fault, so a branch named
`abcd` beside an `objects/ab` of mode 000 makes `rev-parse abcd` throw `PERMISSION_DENIED`. git's
`for_each_file_in_obj_subdir` logs `error: unable to open .git/objects/ab: <the C library error text>` for every
`errno` but `ENOENT` and carries on: `rev-parse`, `show`, `describe`, `merge` and `blame` exit 0
with the commit (pinned twice on git 2.56.0), and a regular file at the fanout path logs
`Not a directory` where tsgit is silent.

## Options considered

1. **Skip the directory and log `logger.error('unable to open <dir>', { path, code })`** — git's
   words minus the errno text, which the consumer renders from `code` — pros: matches the `error:`
   channel mapping the ambiguity interop suite already rebuilds / cons: none found. The designer's
   recommendation.
2. **Skip and log an ADR-887-style namespaced `warn`** — pros: mirrors the unreadable pack directory
   case / cons: the interop test cannot map it to git's `error:` channel.
3. **Keep refusing** — cons: contradicts git's exit 0 on every pinned route.

## Decision

**User's judgment: option 1.** In the abbreviation scan a fanout directory that cannot be listed is
skipped: `FILE_NOT_FOUND` yields an empty listing silently (git's `ENOENT`); any other coded fault —
`PERMISSION_DENIED`, `NOT_A_DIRECTORY`, … — yields an empty listing plus one
`logger.error('unable to open <dir>', { path, code })` per scan git makes; an error without a code is
rethrown, as ADR-887 does. `isMissingFanoutDir` is left as it is: the object-read path in
`loose-oid-cache.ts` shares it and is out of this change's scope.

## Consequences

- `PERMISSION_DENIED` no longer escapes from name resolution on any route; the interop test rebuilds
  `error: unable to open <relative dir>: <error text>` from `path` and `code`.
- The log count per route is governed by ADR-1143.
