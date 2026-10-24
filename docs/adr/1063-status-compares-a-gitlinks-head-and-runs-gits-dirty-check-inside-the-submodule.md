---
subjects:
  - src/application/primitives/compare-working-tree-entry.ts
  - src/application/commands/status.ts
  - src/application/commands/internal/submodule-state.ts
---
# 1063 — `status` compares a gitlink's HEAD and runs git's dirty check inside the submodule

- **Status:** accepted
- **Date:** 2026-10-24
- **Design:** docs/design/status-gitlink-parity.md · **Supersedes/Refines:** refines ADR-255, ADR-958, ADR-960, ADR-1049 and ADR-1050

## Context

Every tracked gitlink over a directory reads `modified` with a worktree mode of `100755`
(design rows ST1–ST10): the comparison primitive sends gitlinks past its stat arm and cannot hash
a directory. git 2.55 has two layers. `ce_compare_gitlink` resolves the submodule's HEAD through
`<path>/.git` and never dies: an unresolvable HEAD, a broken or an oversized `.git` all count as
a match (SF rows under `--ignore-submodules=dirty`). `status` then runs a dirty check inside the
submodule — the child's own status, whose tracked and untracked flags become `S.M.` / `S..U`
(ST11–ST16), whose index it refreshes and writes (SX4), and whose gitfile reader dies on a broken
or oversized `.git` (SF1–SF7) or on a symlink at the path (SF9). The ignore mode comes from
`.git/config`, then `.gitmodules`, then `diff.ignoreSubmodules` (SC rows). Today a dirty
submodule matches git only because everything reads `modified`.

## Options considered

1. **HEAD comparison, dirty check and ignore configuration** — the designer's recommendation.
   Pros: no divergence from git on any pinned row. Cons: the largest option — a child status
   per populated submodule, recursion, the gitfile reader's refusals, three configuration sources.
2. **HEAD comparison and dirty check, no ignore configuration** — an ADR would record the
   divergence on rows n1–n4 and p1–p9, where git honours the ignore keys.
3. **HEAD comparison only** — `status` behaves like git's `--ignore-submodules=dirty`. Six rows
   that match today (ST11–ST16) would diverge, SF1–SF10 would stop refusing, and the oversized
   gitfile hypothesis would not be met.

## Decision

**The user chose option 1.** `compareAndRefresh` answers a gitlink from the submodule's HEAD:
`unchanged` when it equals the entry id or cannot be resolved, `modified` when it differs, with
`worktreeMode` `160000`; a file or symlink at the path is `type-changed` with the stat-derived
mode. The HEAD comparison never refuses. `status` then runs the dirty check from a new internal
module, `src/application/commands/internal/submodule-state.ts`, over every non-absent,
non-skip-worktree, non-assume-valid gitlink whose ignore mode is `none` or `untracked`: a symlink
at the path refuses, `<path>/.git` is read with the dying reader (`GITFILE_TOO_LARGE`,
`NOT_A_REPOSITORY`, with the path git prints), nothing checked out yields no flags, and a
checked-out submodule's own status — run recursively, with refresh on — yields the tracked and
untracked flags. `all` hides the gitlink, `dirty` keeps only the HEAD comparison, `untracked`
drops the untracked flag. The precedence is `.git/config submodule.<name>.ignore`, then
`.gitmodules` (working-tree file, else the index blob), then `diff.ignoreSubmodules`, then `none`;
`<name>` is the `.gitmodules` section whose `path` is the entry's path.

## Consequences

- A gitlink is never refreshed: its stat data stays as recorded and an unchanged gitlink never
  makes `status`, `commit` or the sequencer write the superproject index (SX1–SX3), as git's
  `refresh_cache_ent` returns a matching gitlink without `fill_stat_cache_info`. The racy smudge
  already excludes gitlinks (ADR-960) and is unchanged.
- The child status refreshes and writes the submodule's index as git's child does (SX4), the
  "submodule cleanliness" consumer ADR-958 already names.
- `parseGitmodules` gains the `ignore` key. `.gitmodules` and the per-name `submodule.<name>.ignore`
  keys are read only when the index holds a stage-0 gitlink; `diff.ignoreSubmodules` is validated
  on every `status` run, as git parses it at config load — a bogus value dies in a repository with
  no submodule at all (design rows r1–r3, pinned after Part 8 refuted an earlier "pays nothing"
  wording of this bullet).
- `rm` reuses the same dirty check with the ignore mode forced to `none` (ADR-1066).
- The structured surface for the flags is ADR-1064; the symlink refusal's error is ADR-1069; a
  failing child status is ADR-1070; an invalid ignore value is ADR-1068.
- A `<path>/.git/HEAD` that is a FIFO hangs git itself, so that row has no twin; the tsgit row
  asserts that the call settles within a timeout.
