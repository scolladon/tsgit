# Repository layout resolution

This page is the reference for how `openRepository` decides three things: **where the
git directory is**, **whether there is a working tree**, and **whether the repository
is bare**. Every rule here is pinned against canonical git (2.55.0) by the cross-tool
interop suite — tsgit ships the resolved data; the pins compare conditions and values,
not rendered output.

## The three routes

git has three setup routes, and tsgit mirrors them exactly:

| Route | Entered when | tsgit equivalent |
|---|---|---|
| **explicit** | `--git-dir` given | `openRepository({ gitDir })` — discovery is skipped entirely |
| **discovered** | the walk found a `.git` entry (directory or pointer file) | `openRepository({ cwd })` inside a working tree |
| **bare** | the walk found that a directory *is itself* a git directory | `openRepository({ cwd })` inside `repo.git` (or inside a `.git`) |

The walk climbs from `cwd` toward the filesystem root. At every level it checks the
`.git` entry first, then whether the level itself qualifies as a git directory: a
usable `HEAD` — a symlink is judged by its link text (`refs/…` qualifies even when
dangling, on adapters with symlinks), a regular file by its content (`ref:` + a
`refs/…` target, or a leading 40-hex object id of either case, trailing bytes
ignored) — plus `objects/` and `refs/` at the common dir. A directory that qualifies can
legitimately shadow an enclosing repository — that is git's behaviour too.
`ceilingDirs` bounds the climb: the longest entry that is a *strict* ancestor of the
resolved `cwd` is never examined or passed.

A `commonDir` argument — the argument equivalent of git's `GIT_COMMON_DIR` — is
honoured on all three routes: it replaces the file-derived common dir (the
`commondir` pointer's own resolution) wherever a route would otherwise apply one,
rather than adding a second candidate to validate. On the discovery route it feeds
into the same `objects/` + `refs/` check described above, so a candidate naming an
unusable override still fails and the walk keeps climbing past it; the explicit
route stays lenient, exactly as it already is for `gitDir` — an unusable override
still produces a layout, refusing only later, at first command.

## Work-tree precedence

Once the git directory is known, the working tree is decided by the first matching
row — each row wins over everything below it:

| # | Condition | Work tree |
|---|---|---|
| 1 | explicit `workDir` argument | that path (relative values resolve against `cwd`) — it may not exist yet |
| 2 | `commonDir` supplied, explicit or discovered route | row 3 (`core.bare = true`) is skipped — falls through to rows 4–7 as though `core.bare` were unset; the bare route (cwd-is-gitdir) is unaffected, row 8 still applies there unchanged |
| 3 | `core.bare = true` (no `workDir` argument, row 2 not in effect) | **none**; if `core.worktree` is *also* set the configuration is bogus and work-tree commands refuse |
| 4 | `core.worktree` set, absolute | that path |
| 5 | `core.worktree` set, relative | resolved **physically against the git directory** — a missing or non-directory target refuses at open (`WORK_TREE_UNRESOLVABLE`) |
| 6 | explicit route, nothing above | **the cwd** |
| 7 | discovered route, nothing above | the directory holding the `.git` entry |
| 8 | bare route, nothing above | **none** |

Three rows surprise people, and all three are measured git behaviour:

- **Row 2**: setting `commonDir` **at all** — even to a value equal to `gitDir` —
  makes a bare-configured repository keep a work tree, on both the explicit and
  discovered routes; the cwd-is-gitdir route is unaffected because its own row
  (8) never looks at a work tree in the first place. Which work tree it then
  keeps is exactly what rows 6/7 already return once row 3 is bypassed.
- **Row 6**: `openRepository({ gitDir: bareShaped })` from an unrelated directory
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
resolved `gitDir`, optional `commonDir` — present for a linked worktree, or when
the caller supplied a `commonDir` override, and always omitted when the resolved
value equals `gitDir` (a caller-supplied value equal to `gitDir` normalises away
the same as an absent one) — optional `workDir`
(absent = no working tree), `bare`, `workTreeConfigBogus`, optional `untrusted`
and `implicitBare` (present only when `true` — the ownership-trust gate's
verdict, see Refusals below), optional `foreignPath` (the first checked path
the ownership predicate reported unowned, present only when one was found),
optional `formatRefusal` — the repository-acceptance verdict
(`core.repositoryformatversion` / `extensions.*`), absent when the repository is
accepted; see Refusals for how it is enforced — and optional `objectFormat`,
the repository's declared `extensions.objectFormat` (`'sha1' | 'sha256'`),
absent meaning sha1 (git's own default when the key is unset). A linked
worktree's `objectFormat` is always the common dir's value — the admin dir
holds no format-bearing config of its own, so no worktree-specific read
exists. Every `git rev-parse` layout query —
`--git-dir`, `--git-common-dir`, `--is-bare-repository`, `--show-toplevel`,
`--show-prefix`, `--show-cdup`, `--is-inside-work-tree`, `--is-inside-git-dir` — is
reconstructible from these fields plus your own cwd; tsgit ships the data, never a
rendered form.

A layout carrying `untrusted` or `implicitBare` must be read as **structural**:
it holds only what discovery produced before any config was read. `bare` is
the structural default computed from directory shape alone — no `core.bare`
or `core.worktree` value participated, because a refused repository's config
is never parsed. See [Repository trust](security.md#repository-trust) for
what that closes.

## Refusals

Work-tree-requiring commands refuse the way git does, as structured errors:

| Condition | Code |
|---|---|
| no working tree | `WORK_TREE_REQUIRED { operation }` |
| `core.bare` + `core.worktree` both set | `WORK_TREE_CONFIG_INVALID { gitDir }` |
| relative `core.worktree` that cannot be physically resolved | `WORK_TREE_UNRESOLVABLE { value, gitDir }` |
| `reset --mixed` in a bare repository | `BARE_REPOSITORY { operation }` — the one refusal git keys on bareness itself |
| present-but-malformed git directory (garbage `HEAD`) | `NOT_A_REPOSITORY { path }`, at the first command |
| unusable `commondir` pointer (zero-byte, or a relative path with a missing intermediate component) | `GITFILE_INVALID_FORMAT { path }`, at open |
| repository metadata not owned by the caller (`trust: 'ownership'`, the default) | `DUBIOUS_OWNERSHIP { path, foreignPath? }` — see [errors](../use/errors.md#repository-state) |
| gitdir reached by the cwd-is-a-gitdir route under a name other than `.git` (`bareRepositories: 'explicit'`) | `IMPLICIT_BARE_REPOSITORY { gitDir }` — see [errors](../use/errors.md#repository-state) |

`describe --broken` reports `-broken` instead of refusing, bare `blame` blames HEAD,
and `grep`'s index/tree targets stay open — matching git's own carve-outs.

### The repository-acceptance tiers

`formatRefusal` above is *carried*, not enforced, until a command actually asks for
it. Every command sits on one of three chained tiers, each a strict superset of the
gate before it:

| Tier | Adds on top of the previous tier | Verbs on this tier |
|---|---|---|
| `assertRepository` | a usable HEAD, then the discovery-tier boolean gate (`core.bare`, `extensions.worktreeConfig`) | the four surviving `config` read verbs — `config <key>`, `config --get-all`, `config --get-regexp`, `config --list` |
| `assertAcceptedRepository` | the format-acceptance verdict (`REPOSITORY_FORMAT_VERSION_UNSUPPORTED` / `REPOSITORY_EXTENSIONS_UNSUPPORTED`) | every `remote` verb and every `config` write verb |
| `assertOperationalRepository` | eager `[core]` validation | every other command |

The four survivors are an enumerated, measured set — never inferred from "read-only".
`remote` is NOT among them: canonical git refuses `remote`, `remote -v`,
`remote get-url` and `remote show -n` on a rejected repository exactly as it refuses
the writers, so every `remote` verb sits on `assertAcceptedRepository` too. Ordering
is fixed within a rejected repository: the discovery-tier boolean gate always wins
over the format verdict (a repository failing both `core.bare` and
`core.repositoryformatversion` reports the boolean refusal), and the format verdict
always wins over eager `[core]` validation.

## Deliberate divergences

All small, all documented in the design record: sandboxed adapters (memory, browser)
resolve `core.worktree` lexically (no realpath exists there); OPFS has no symlinks, so
the browser keeps the content-only `HEAD` check; an ABSOLUTE `commondir` pointer skips
the missing-intermediate refusal (its parent may be outside a sandbox's containment
root — a relative pointer gets the full stepwise check); `ceilingDirs` *refuses*
non-absolute entries where git silently ignores them; and environment variables
(`GIT_DIR`, `GIT_WORK_TREE`, `GIT_COMMON_DIR`, `GIT_CEILING_DIRECTORIES`) are never
read — every input is an explicit argument. `commonDir` is one such argument: it
mirrors `GIT_COMMON_DIR`'s *value*, never its wiring — the variable stays on the
never-read list above. Two further divergences from that variable are deliberate:
git's `GIT_COMMON_DIR` moves the object database, `config`, `shallow`, `info/*` and
`hooks/`, but the ref store still follows the gitDir's own `commondir` file — tsgit's
`commonDir` applies **uniformly**, ref store included, matching the `commondir`
*file*'s own behaviour rather than the environment variable's internal split; and a
relative value is **normalised** against `cwd` where git echoes the value back
verbatim, trailing slash included. Trust configuration follows the
same rule: it comes from `openRepository` arguments only, never from any
config file — global and system config are unreachable by the FS port by
design, and repository-local config is the attacker's own file, so a
repository cannot allowlist itself into being trusted. A non-absolute
`trustedDirectories` entry is **refused** where git's `safe.directory`
silently warns and ignores it. The ownership check itself is **POSIX-only**.
