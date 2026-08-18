# Repository layout resolution

This page is the reference for how `openRepository` decides three things: **where the
git directory is**, **whether there is a working tree**, and **whether the repository
is bare**. Every rule here is pinned byte-for-byte against canonical git (2.55.0) by
the cross-tool interop suite.

## The three routes

git has three setup routes, and tsgit mirrors them exactly:

| Route | Entered when | tsgit equivalent |
|---|---|---|
| **explicit** | `--git-dir` given | `openRepository({ gitDir })` — discovery is skipped entirely |
| **discovered** | the walk found a `.git` entry (directory or pointer file) | `openRepository({ cwd })` inside a working tree |
| **bare** | the walk found that a directory *is itself* a git directory | `openRepository({ cwd })` inside `repo.git` (or inside a `.git`) |

The walk climbs from `cwd` toward the filesystem root. At every level it checks the
`.git` entry first, then whether the level itself qualifies as a git directory
(`HEAD` with valid content — a `refs/…` symbolic target or a full hex object id —
plus `objects/` and `refs/` at the common dir). A directory that qualifies can
legitimately shadow an enclosing repository — that is git's behaviour too.
`ceilingDirs` bounds the climb: the longest entry that is a *strict* ancestor of the
resolved `cwd` is never examined or passed.

## Work-tree precedence

Once the git directory is known, the working tree is decided by the first matching
row — each row wins over everything below it:

| # | Condition | Work tree |
|---|---|---|
| 1 | explicit `workDir` argument | that path, verbatim — it may not exist yet |
| 2 | `core.bare = true` (and no `workDir` argument) | **none**; if `core.worktree` is *also* set the configuration is bogus and work-tree commands refuse |
| 3 | `core.worktree` set, absolute | that path |
| 4 | `core.worktree` set, relative | resolved **physically against the git directory** — a missing or non-directory target refuses at open (`WORK_TREE_UNRESOLVABLE`) |
| 5 | explicit route, nothing above | **the cwd** |
| 6 | discovered route, nothing above | the directory holding the `.git` entry |
| 7 | bare route, nothing above | **none** |

Two rows surprise people, and both are measured git behaviour:

- **Row 5**: `openRepository({ gitDir: bareShaped })` from an unrelated directory
  defaults a working tree *at the cwd* when the config carries no `core.bare` —
  discovering the very same directory by `cwd` yields none. The route decides, not
  the directory's shape.
- **`core.worktree` is honoured on every route**, including plain discovery — not
  only with an explicit git dir.

`bare` is then derived, never assumed:

```
bare = (core.bare is not literally false, argument override included)
       AND (no work tree was resolved)
```

An absent `core.bare` counts as *not false* — that is how an emptied config in a
bare-shaped directory still reads as bare. The `bare` argument overrides `core.bare`
outright, in both directions.

## Reading the result

`repo.layout` (the same deep-frozen object as `repo.ctx.layout`) carries the
resolved `gitDir`, optional `commonDir` (linked worktrees), optional `workDir`
(absent = no working tree), `bare`, and `workTreeConfigBogus`. Every
`git rev-parse` layout query — `--git-dir`, `--git-common-dir`,
`--is-bare-repository`, `--show-toplevel`, `--show-prefix`, `--show-cdup`,
`--is-inside-work-tree`, `--is-inside-git-dir` — is reconstructible from these
fields plus your own cwd; tsgit ships the data, never a rendered form.

## Refusals

Work-tree-requiring commands refuse the way git does, as structured errors:

| Condition | Code |
|---|---|
| no working tree | `WORK_TREE_REQUIRED { operation }` |
| `core.bare` + `core.worktree` both set | `WORK_TREE_CONFIG_INVALID { gitDir }` |
| relative `core.worktree` that cannot be physically resolved | `WORK_TREE_UNRESOLVABLE { value, gitDir }` |
| `reset --mixed` in a bare repository | `BARE_REPOSITORY { operation }` — the one refusal git keys on bareness itself |

`describe --broken` reports `-broken` instead of refusing, bare `blame` blames HEAD,
and `grep`'s index/tree targets stay open — matching git's own carve-outs.

## Deliberate divergences

All small, all documented in the design record: sandboxed adapters (memory, browser)
resolve `core.worktree` lexically (no realpath exists there) and cannot see symlinked
`HEAD`s; `ceilingDirs` *refuses* non-absolute entries where git silently ignores
them; environment variables (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`,
`GIT_CEILING_DIRECTORIES`) are never read — every input is an explicit argument.
