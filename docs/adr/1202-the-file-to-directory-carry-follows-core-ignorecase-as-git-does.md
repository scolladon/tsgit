---
subjects:
  - src/application/primitives/materialize-tree.ts
---
# 1202 — The file-to-directory carry follows `core.ignoreCase` as git does

- **Status:** accepted
- **Date:** 2026-11-17
- **Design:** docs/design/checkout-branch-on-unborn-head.md (D6, R7(a)) · **Supersedes/Refines:** refines ADR-1201

## Context

ADR-1201's rows were pinned on macOS, where `git init` writes `core.ignorecase=true`. With
`core.ignorecase=false`, the Linux default, git 2.56.0 refuses a staged file `dir` against a target
`dir/x` with `untracked working tree files would be overwritten: dir`, as tsgit already does. This
was re-verified twice per setting, from a born and an unborn HEAD. git's `verify_absent` reaches
`check_ok_to_remove`, whose `icase_exists` lets a stat-clean file go only when the setting is
true. Separately, when no file stands at `dir` on disk, tsgit succeeds but leaves an index that
holds both `dir` and `dir/x`.

## Options considered

1. **Replicate git's whole rule** (recommended): the colliding staged file never stays in the
   index. Its file on disk goes only under `core.ignoreCase` when stat-clean; otherwise the switch
   refuses `untracked: [p]`. The setting is read only when such a collision exists.
2. **Only the setting-independent half**: fix the index and leave the `core.ignoreCase=true` rows
   diverging.
3. **Reopen ADR-1201.**

## Decision

**ratified by the user**: option 1. ADR-1201's decision to fold stands; its context now names the
setting.
