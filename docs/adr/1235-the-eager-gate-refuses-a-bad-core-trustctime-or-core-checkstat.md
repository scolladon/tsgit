---
subjects:
  - src/application/primitives/internal/repo-state.ts
  - src/application/primitives/read-stat-check.ts
---
<!-- cspell:ignore trustctime checkstat -->
# 1235 — The eager gate refuses a bad core.trustctime or core.checkstat

- **Status:** accepted
- **Date:** 2026-11-20
- **Design:** docs/design/core-filemode-false.md (review fold) · **Supersedes/Refines:** refines ADR-1233, applies DOCTRINE D-3

## Context

Review of the assume-unchanged overwrite check made tsgit read `core.trustctime` and
`core.checkstat` (local plus the active `config.worktree`), so a stale assume-valid entry follows
git's `ce_match_stat_basic` field set. git parses both keys in `git_default_core_config`: a
non-boolean `trustctime` and a `checkstat` other than `default`/`minimal` make every command fail.
tsgit reads the keys but drops a bad value.

## Options considered

1. **Fold: gate both keys in the eager gate, local and active `config.worktree`, as ADR-1233 does
   for `core.fileMode`; breaking `!`** (ratified).
2. Freeze the change and send the gate to impact triage.

## Decision

Option 1, ratified by the user. A bad `core.trustctime` or `core.checkstat` in local config or in
the active worktree file is refused by the eager gate with git's refusal shape, pinned against git.

## Consequences

### Negative

- Every operational command throws on a value it used to ignore, as git does.
