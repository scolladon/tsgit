# Design — Bare repositories and explicit layout arguments

> Brief: make `openRepository` discover a bare repository (`cd repo.git && git log`),
> accept explicit `gitDir` / `workDir` / `bare` / `ceilingDirs` layout arguments, honour
> `core.bare` and `core.worktree` from the repository's own config, refuse work-tree
> commands the way git refuses them, expose the resolved layout as structured data, and
> pin the whole matrix against canonical git. No environment reading anywhere.
> Status: draft → self-reviewed ×3 → awaiting the decision-candidate conversation

## Context

### What exists today

`openRepository({ cwd })` resolves its physical layout through one shared discovery walk
(`src/repository/find-layout.ts`, landed with linked-worktree discovery). The walk climbs
from `cwd` looking **only for a `.git` entry**:

```ts
// src/repository/find-layout.ts:34-49
let current = pathPolicy.resolve(cwd);
while (true) {
  const candidate = pathPolicy.join(current, '.git');
  const stat = await probe.stat(candidate);
  if (stat?.isDirectory === true) { … }        // candidate: skip and climb if invalid
  else if (stat?.isFile === true) { … }        // commitment: resolve or throw
  const parent = pathPolicy.dirname(current);
  if (parent === current) return undefined;    // filesystem root
  current = parent;
}
```

It never asks whether `current` **is itself** a git directory, and `layoutFor` hardcodes
the answer to bareness:

```ts
// src/repository/find-layout.ts:120-128
return { workDir, gitDir, bare: false, ...(commonDir !== gitDir ? { commonDir } : {}) };
```

`OpenRepositoryOptions` (`src/repository.ts:76-118`) carries **no layout fields at all** —
only `cwd`, adapter overrides, `config`, `logger`, `progress`, `signal`, `hooks`,
`command`, `unsafeRawAdapters`. The internal `RepositoryLayoutInput`
(`src/repository.ts:127-138`) already has `workDir` / `gitDir` / `bare` / `commonDir?` /
`homeDir?`, and `RepositoryLayout` (`src/ports/context.ts:21-44`) mirrors it, but through
`openRepository` **`bare` is always `false`**: `find-layout.ts:123` and the node shim's
not-found fallback (`src/index.node.ts:180`) both hardcode it, the memory shim hardcodes
it (`src/index.default.ts:61`), and only the low-level `createNodeContext({ bare })`
(`src/adapters/node/node-adapter.ts:22,60`) and `createBrowserContext({ bare })`
(`src/adapters/browser/browser-adapter.ts:17,41`) — bypassing the facade entirely — can
set it true. The browser shim already threads a caller-supplied `bare` through
`resolveFixedEntryLayout` (`src/repository/fixed-entry-layout.ts:22`), whose doc comment
states the current contract outright: *"discovery never decides bare-ness."*

Bare-ness therefore has **two unreconciled sources of truth**:

| source | read where | consumed by |
|---|---|---|
| `core.bare` in `<commonDir>/config` | `isBare(ctx)`, `src/application/primitives/internal/repo-state.ts:209-212` | `assertNotBare(ctx, op)` → 28 call sites across 16 command modules |
| `ctx.layout.bare` | `src/ports/context.ts:35` | exactly 2 sites: `repo-state.ts:91` (root selection) and `list-worktrees.ts:75` (main-entry `bare` flag) |

`assertNotBare` throws `BARE_REPOSITORY { operation }`
(`src/domain/repository/error.ts:6,12-13`), whose rendered detail is already
*"operation requires a working tree"* (`src/domain/error.ts:301-302`) — the right idea,
wired to the wrong predicate (§1d proves `core.bare` and "has a work tree" are
independent).

### The substrate already landed

- **Discovery walk** — `findLayout` / `layoutFromGitfile` / `layoutFor` /
  `resolveCommonDir` / `isGitDirectory` over the narrow `LayoutProbe` port
  (`src/ports/layout-probe.ts`, ADR-535), adapted by
  `src/repository/file-system-layout-probe.ts`; node backs it with raw
  `node:fs/promises`. `isGitDirectory` already checks `HEAD` at the gitDir and
  `objects`/`refs` at the **commonDir** — exactly git's shape (§1b).
- **Path policy** — the walk is policy-parameterised (`PathPolicy`); production code uses
  the adapter's `nativePolicy`, sandboxed adapters `portablePosixPolicy`
  (`src/repository/portable-posix-policy.ts`).
- **Containment** — `layoutRootsOf(layout)` (`src/repository/layout-roots.ts`) computes
  the containment-minimised root set `[workDir, gitDir, commonDir]`; `wrapFsValidator`
  takes a root array (ADR-298); `NodeFileSystem` takes a realpath-gated root **set**
  (ADR-541).
- **Canonicalisation** — node realpaths `cwd`, `gitDir` and `commonDir`; sandboxed
  adapters stay lexical (ADR-537).
- **Config** — `readConfig(ctx)` (`src/application/primitives/config-read.ts:168`) parses
  `<commonDir>/config` **only** (never global/system — the FS port cannot reach them),
  memoised in a `WeakMap<Context, …>` single-flight cache (`config-read.ts:151-201`).
  `core.bare` is already parsed into `ParsedConfig` (`config-read.ts:39-41`) and the
  valueless form maps to `true` via `parseGitBoolean`
  (`src/application/primitives/internal/config-ini.ts:796-807`).
- **Two-tier config gates** — `assertDiscoveryBooleansValid` (`repo-state.ts:62-78`)
  refuses a malformed `core.bare` / `extensions.worktreeConfig` on **every** command
  including the `config` porcelain; `assertEagerConfigValid` (`repo-state.ts:160-193`,
  ADR-639) is the operational `[core]` gate.
- **Bare-aware plumbing already in place** — `readIndex` returns an empty index when the
  file is absent (`src/application/primitives/read-index.ts:20-24`), so a bare repo's
  missing `index` is already handled on the read side; `init`/`clone` already accept
  `bare?: boolean` and `bootstrapRepository` already writes `bare = true|false` into the
  new `[core]` (`src/application/commands/internal/bootstrap.ts:27-28`);
  `list-worktrees.ts:75` already emits the main entry's `bare` flag from `layout.bare`.

### Observed failure (measured, not assumed)

Run through `openRepository` from `src/index.node.ts` against fixtures built by real git
(`$T` = throwaway root; probe removed after measuring):

| call | result today | canonical git |
|---|---|---|
| `openRepository({ cwd: $T/bare.git })` | **resolves**, `layout = { workDir: $T/bare.git, gitDir: $T/bare.git/.git, bare: false }` | `--git-dir` = `.`, `--is-bare-repository` = `true` |
| …then `.revParse('HEAD')` / `.status()` | throws `NOT_A_REPOSITORY { path: $T/bare.git }` | `git log` works; `git status` refuses with a *different* refusal |
| `openRepository({ cwd: $T/bare.git/refs })` | **resolves**, `layout = { workDir: $T/bare.git/refs, gitDir: $T/bare.git/refs/.git, bare: false }` | `--git-dir` = `$T/bare.git` |
| `openRepository({ cwd: $T/src/.git })` | **resolves**, `layout = { workDir: $T/src, gitDir: $T/src/.git, bare: false }` | `--git-dir` = `.`, **no work tree** — `status` refuses |

Three distinct defects, all silent:

1. **Bare repo unopenable.** The walk finds no `.git`, the node shim falls back to
   `{ workDir: cwd, gitDir: cwd/.git }`, and every command fails late with
   `NOT_A_REPOSITORY` naming a path that *is* a perfectly good repository.
2. **Wrong repo from inside a gitdir.** From `bare.git/refs` git resolves the enclosing
   `bare.git`; tsgit fabricates `bare.git/refs/.git`.
3. **Fabricated work tree.** From `$T/src/.git` tsgit walks up, finds `$T/src/.git`, and
   reports `workDir = $T/src` — so `repo.status()` / `repo.add()` would operate on a
   working tree that **git refuses to provide**. This is the dangerous one: not a
   failure, a wrong answer.

Additionally, `init({ bare: true })` produces a repository that `openRepository` cannot
reopen at all — the write path and the read path are asymmetric today.

And a **fourth defect is already shipping**, reachable without any of the above, because
`isBare` reads `core.bare` from the **common** dir. Measured in a linked worktree of a bare
repo (`git worktree add` from `$T/bare.git`; probe removed after measuring):

| call | git | tsgit today |
|---|---|---|
| `rev-parse --is-bare-repository` from `$T/wt` | `false` | `layout.bare` = `false` ✓ |
| `config core.bare` from `$T/wt` | `true` (the common config) | same |
| `status --porcelain` | exit 0 | `repo.status()` — **OK** (ungated) |
| `add b.txt` | exit 0, staged | `repo.add(['b.txt'])` — **throws `BARE_REPOSITORY { operation: 'add' }`** |

A worktree that git stages into, tsgit refuses — and refuses *inconsistently*, since its
unguarded `status` succeeds on the very tree its `add` calls bare. This is §1d's formula
failing in production: `core.bare` is `true`, a work tree exists, so
`is_bare_repository()` is `false`. It is fixed by the same change, not by a separate one.

### Binding constraints

- **Prime directive** ([ADR-226](../adr/226-git-faithfulness-prime-directive.md)): match
  canonical git's observable data and on-disk state byte-for-byte. Every behaviour in §1
  is pinned against **git 2.55.0** in a `mktemp -d` throwaway with `env -i`, isolated
  `HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed, signing off — never recalled.
- **Structured output** ([ADR-249](../adr/249-describe-structured-data-only.md)): the
  layout and every refusal are **data**. No rendered message string, no
  relative-vs-absolute path formatting; the interop test reconstructs git's `rev-parse`
  lines and `fatal:` messages from the structured fields.
- **No environment reading.** tsgit takes its layout from **arguments only** — hexagonal,
  and the browser has no `process.env`. `GIT_DIR`/`GIT_WORK_TREE`/`GIT_CEILING_DIRECTORIES`
  as *variables* stay out of scope; their *argument equivalents* are what this design adds.
- **Hexagonal dependency rule**: `repository → commands → primitives → domain`;
  `src/repository/` may `import type` from `adapters/node/path-policy.js` only.
- Branded types, no `any`, files < 800 lines, functions < 20 lines, kebab-case,
  no suppression directives.

## Requirements

R1. `openRepository({ cwd })` where `cwd` **is** a git directory (bare or not) resolves
the same layout git resolves: `gitDir` equal to `git rev-parse --path-format=absolute
--git-dir`, `commonDir` equal to `--git-common-dir`.

R2. The cwd-is-a-gitdir check runs at **every level** of the walk, **after** the `.git`
check at that level — so `cd bare.git/refs` resolves `bare.git`, and a directory holding
both a valid `.git` subdirectory and its own `HEAD`/`objects`/`refs` resolves the `.git`
subdirectory (§1a).

R3. `layout.bare` equals `git rev-parse --is-bare-repository` in every shape of §1d —
including all five shapes where bareness and work-tree presence disagree.

R4. A repository with **no work tree** is representable: `layout` distinguishes "no work
tree" from "work tree at path P", and every work-tree-touching command refuses **exactly
when** git refuses, co-refusing on the same inputs (§1f). The "exactly" is bidirectional
and both halves are measured: commands that git refuses in a bare repo must refuse
(`status`, `stash list`, `grep <pat>`), and commands git permits must be permitted —
including in a **linked worktree of a bare repo**, where `repo.add()` throws today
(Context §Observed failure).

R4b. Commands git permits without a work tree keep working: `log`, `show`, `revList`,
`catFile`, `diff --cached`, `diff <tree> <tree>`, `grep --cached`, `grep <tree>`, `blame`,
`describe` (incl. `broken`), `reset --soft`, `archive`, `fsck`, `branch.*`, `tag.*`,
`notes.*`, `config.*`, `reflog`, `worktree.list`, `bundle.*`, `fetch`, `push`.

R5. `OpenRepositoryOptions` accepts `gitDir`, `workDir`, `bare` and `ceilingDirs`, with
git's exact precedence (§1c). No environment variable is read to obtain any of them.

R6. `core.bare` and `core.worktree` are honoured from the repository's **own** config
file only — never global, never system, never through `include.path` (§1e). Relative
`core.worktree` resolves against the gitDir (§1c row R1c-4), and the resolution is
physical on adapters that expose realpath.

R7. `core.bare` *and* `core.worktree` both set marks the work-tree configuration
**bogus**: no work tree, and work-tree commands refuse with a **distinct** structured
code from the plain no-work-tree refusal, matching git's two distinct fatal refusals (§1f).

R8. `ceilingDirs` bounds the discovery walk exactly as `GIT_CEILING_DIRECTORIES` does: a
ceiling that is a **strict ancestor** of the resolved cwd stops the walk **before** the
ceiling directory itself is examined; a ceiling equal to cwd, below cwd, or not absolute
is a no-op (§1h).

R9. The resolved layout is readable from an opened `Repository` as structured data, and
its fields reconstruct `git rev-parse --git-dir` / `--absolute-git-dir` /
`--git-common-dir` / `--is-bare-repository` / `--is-inside-git-dir` /
`--is-inside-work-tree` / `--show-toplevel` / `--show-prefix` / `--show-cdup` inside the
interop test (§7, §1g).

R10. Round-trip write/read symmetry: a repository created by tsgit's `init({ bare: true })`
or `clone({ bare: true })` is re-openable by `openRepository({ cwd })` **and** by real git,
and a repository created by `git init --bare` / `git clone --bare` is openable and
operable by tsgit. `fetch` and `push` against a bare repository work in both directions.

R11. Containment is preserved: with no work tree the root set collapses to
`[gitDir]` (or `[gitDir, commonDir]`); an explicit `workDir` outside `gitDir` adds exactly
that root and nothing between them.

R12. Existing repositories are byte-identical: for a normal repo opened by `cwd`, the
layout, the containment root set, every resolved path and every command's behaviour are
unchanged. The added per-level probing costs at most one extra `stat` per walk level on
the miss path (§2).

R13. Sandboxed adapters (memory, browser) express the same layouts within their root; a
`gitDir`/`workDir`/ceiling outside the sandbox fails cleanly under the `LayoutProbe`
absence/containment-denial contract, never by walking up.

R14. 100% line/branch/function/statement coverage on touched code inside the coverage
scope (`domain/`, `ports/`, `adapters/node/`, `adapters/memory/`, `operators/` —
`src/repository/` and `src/application/` are **outside** it); mutation score within the
app budget for every touched file; every pinned row in §1 backed by an interop assertion.

## Design

### 1. Pinned matrix — canonical git 2.55.0

All probes: `mktemp -d` throwaway, `env -i`, isolated `HOME`, `XDG_CONFIG_HOME` under it,
`GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed, `commit.gpgsign=false`,
`init.defaultBranch=main`. `$T` is the throwaway root. macOS resolves `$T` through
`/var → /private/var`, which is why `--absolute-git-dir` rows show the `/private` prefix
and `--git-dir` rows do not (§1g).

#### 1a. The walk — per level, and its ordering

Two checks happen at each directory `D`, **in this order**:

1. `D/.git` — a *file* is a commitment (resolve the pointer or hard-stop, ADR-533); a
   *directory* is a candidate (skip and climb if it fails validation, ADR-534).
2. `D` **itself** — if `is_git_directory(D)` (§1b), the git dir is `D` and there is **no
   work tree** from discovery.

Then climb to `dirname(D)`, stopping at the filesystem root or the ceiling (§1h).

| fixture | cwd | `git rev-parse --git-dir` |
|---|---|---|
| `$T/bare.git` (`clone --bare`) | `$T/bare.git` | `.` |
| same | `$T/bare.git/refs` | `$T/bare.git` (absolute — found one level up) |
| `$T/normal` (`git init`) | `$T/normal/.git` | `.` |
| `$T/both` holding **both** a valid `.git/` **and** its own `HEAD`+`objects/`+`refs/` | `$T/both` | `.git` — **the `.git` subdirectory wins** |
| `$T/n/nested` (a bare-shaped dir **inside** the work tree of `$T/n`) | `$T/n/nested` | `$T/n/nested` — **shadows the enclosing repository** |
| same | `$T/n/nested/x` | `$T/n/nested` |
| a valid gitdir placed under a name other than `.git` | its parent | `fatal: not a git repository …` — only the literal name `.git` is probed |

The nested rows matter: the new branch is not "a last-resort fallback", it participates at
every level and can legitimately shadow an ancestor repository. That is git's behaviour and
tsgit must reproduce it (see §9).

`commondir` has three measured shapes, on every route: a ZERO-BYTE file is a hard fatal
(`fatal: failed to read <dir>/commondir`) that never climbs; a NEWLINE-ONLY file strips to
empty and is accepted with the gitdir as its own common dir; any other content is a path
verbatim (whitespace included — `"   \n"` names a directory called `"   "`, which then
simply fails the shared-dir validation and the walk climbs). `HEAD` is validated BEFORE
the commondir parse on every walk and gitfile route, so a garbage-`HEAD` planted
directory never reaches the pointer parse there (the explicit-gitDir route resolves the
pointer before any validation — both tools refuse either way, with differing codes).

#### 1b. `is_git_directory(D)` — what makes a directory a git directory

`HEAD` is validated at `D`; `objects/` and `refs/` at `commonDir(D)` (so a linked
worktree's admin dir, which has no `objects/` of its own, still qualifies). Measured:

| fixture at `D` | git verdict |
|---|---|
| `HEAD` = `ref: refs/heads/main\n`, `objects/` dir, `refs/` dir | **git directory** |
| same but `HEAD` = `ref: refs/heads/main` (no newline) | git directory |
| same but `HEAD` = `ref:refs/heads/main\n` (no space) | git directory |
| same but `HEAD` = `ref:` + spaces + `refs/heads/main\n` | git directory |
| same but `HEAD` = `ref: refs/heads/../evil\n` | **git directory** — the refname is *not* format-checked |
| same but `HEAD` = 40 hex chars | git directory (detached) |
| same but `HEAD` = 64 hex chars | git directory (detached, SHA-256 width) |
| same but `HEAD` = 40 UPPERCASE (or mixed-case) hex chars | **git directory** — git's hex table accepts both cases (measured) |
| same but `HEAD` = valid leading id + ~70 KB of filler | **git directory** — git validates only the first 255 bytes and never consults the size (measured); a size gate would climb past a repository git resolves |
| same but `HEAD` = `ref: main\n` (one level) | **not** a git directory |
| same but `HEAD` = 40 non-hex chars | **not** a git directory |
| same but `HEAD` empty | **not** a git directory |
| same but `HEAD` is a **directory** | **not** a git directory |
| same but `HEAD` is a symlink whose target text starts `refs/` (target need not exist) | **git directory** |
| same but `HEAD` is a symlink to `/nowhere/else` | **not** a git directory |
| `objects` is a regular file | not a git directory |
| `refs` is a regular file | not a git directory |
| `objects/` missing | not a git directory |
| `refs/` missing | not a git directory |

Rule: `HEAD` is valid iff it is a symlink whose *link text* begins `refs/`, **or** its
LEADING characters parse as a full hex object id (git consumes the id and ignores the
remainder — `<40hex>garbage` and `<40hex>\r\n` are both git directories, measured), **or**
it begins `ref:` and, after ASCII whitespace only (C `isspace` — a no-break space does
NOT qualify, measured: git climbs past `ref:\u00A0refs/…`), the next token begins
`refs/`.

tsgit today implements a **narrower** predicate — `HEAD` exists and is a regular file via a
following `stat`, content never parsed (`find-layout.ts:162-174`, ADR-534). Two measured
deltas that this feature makes materially more important, because *any* directory is now a
candidate: (i) tsgit accepts `HEAD` = `"garbage"` where git climbs past, so a directory with
three innocuous entries named `HEAD`, `objects/`, `refs/` would shadow an enclosing
repository in tsgit but not in git; (ii) tsgit rejects a `HEAD` symlink whose target does
not exist, where git accepts (git checks the *link text*, never following it, which the
`LayoutProbe` port cannot express today). See D7.

Also pinned: `core.repositoryformatversion = 99` ⇒ `fatal: Expected git repo version <= 1,
found 99`, exit 128, on every command — the existing `assertDiscoveryBooleansValid` tier is
where a format-version gate would belong; it is **not** in scope here (see Out of scope).

#### 1c. Work-tree resolution — the three routes and their precedence

git has three setup routes. tsgit's equivalents are named in the right column.

| git route | entered when | tsgit equivalent |
|---|---|---|
| `setup_explicit_git_dir` | `GIT_DIR` / `--git-dir` given | `opts.gitDir` given |
| `setup_discovered_git_dir` | the walk found a `.git` entry | walk found `.git` (dir or gitfile) |
| `setup_bare_git_dir` | the walk found `is_git_directory(D)` | walk found cwd-is-gitdir (**new**) |

Precedence, identical in all three routes once a gitDir is known (each row wins over the
rows below it):

| # | condition | work tree |
|---|---|---|
| R1c-1 | explicit work tree argument (`--work-tree` / `opts.workDir`) | that path, **verbatim**; may not exist |
| R1c-2 | `core.bare` is true | **none** — and if `core.worktree` is also set, warn + mark the work-tree config **bogus** |
| R1c-3 | `core.worktree` set, absolute | that path |
| R1c-4 | `core.worktree` set, relative | resolved **against the gitDir**, physically |
| R1c-5 | *explicit-gitDir route only*: nothing above applies | **the cwd** |
| R1c-6 | *`.git`-found route*: nothing above applies | the directory containing the `.git` entry |
| R1c-7 | *cwd-is-gitdir route*: nothing above applies | **none** |

The measured rows behind each:

| cwd | invocation | fixture | `--is-bare-repository` | `--show-toplevel` | `git status` |
|---|---|---|---|---|---|
| `$T/elsewhere` | `--git-dir=$T/normal/.git` | `core.bare=false` | `false` | `$T/elsewhere` | ` D a.txt` (exit 0) |
| `$T/elsewhere` | `--git-dir=$T/bare4.git` | config file **emptied** (no `core.bare`) | `false` | `$T/elsewhere` | `D a.txt`, exit 0 |
| `$T/bare4.git` | *(discovery)* | same fixture | `true` | fatal 128 | fatal 128 |
| `$T/elsewhere` | `--git-dir=$T/bare.git` | `core.bare=true` | `true` | fatal 128 | fatal 128 |
| `$T/elsewhere` | `--git-dir=$T/bare.git --work-tree=$T/wt` | `core.bare=true` | **`false`** | `$T/wt` | `D  a.txt`, exit 0 |
| `$T/bare.git` | `--work-tree=$T/wt` (no `--git-dir`) | `core.bare=true` | `false` | `$T/wt` | `D  a.txt`, exit 0 |
| `$T/normal` | *(discovery)* | `core.worktree=$T/wt` | `false` | `$T/wt` | ` D a.txt`, exit 0 |
| `$T/normal/sub` | *(discovery)* | `core.worktree=$T/wt` | `false` | `$T/wt`, `--show-prefix` = `` (empty) | — |
| `$T/elsewhere` | `--git-dir=$T/normal/.git` | `core.worktree=$T/wt` | `false` | `$T/wt` | — |
| `$T/elsewhere` | `--git-dir=$T/normal/.git` | `core.worktree=../wt` | — | `fatal: cannot chdir to '../wt': No such file or directory` (128) | — |
| `$T/elsewhere` | `--git-dir=$T/normal/.git` | `core.worktree=../../wt2` | — | `$T/wt2` | — |
| `$T/nb.git` | *(discovery, cwd-is-gitdir)* | `core.bare` **removed**, `core.worktree=$T/wt` | `false` | `$T/wt` | `D  a.txt`, exit 0 |
| `$T/nb.git` | *(discovery, cwd-is-gitdir)* | `core.bare=false`, `core.worktree=$T/wt` | `false` | `$T/wt` | — |
| `$T/bare2.git` | *(discovery, cwd-is-gitdir)* | `core.bare=false`, no `core.worktree` | `false` | **fatal 128** | fatal 128 |
| `$T/separate` (`.git` file) | *(discovery)* | separate gitdir, default | `false` | `$T/separate` | — |
| `$T/separate` (`.git` file) | *(discovery)* | separate gitdir + `core.worktree=$T/wt` | `false` | `$T/wt` | ` D z.txt`, exit 0 |
| `$T/separate` (`.git` file) | *(discovery)* | separate gitdir + `core.bare=true` | **`true`** | fatal 128 | fatal 128 |
| `$T/normal2` | *(discovery, `.git` dir)* | `core.bare=true` | `true` | fatal 128 | fatal 128 |
| `$T/normal2/sub` | *(discovery, `.git` dir)* | `core.bare=true` | `true` | fatal 128 | — |
| `$T/elsewhere` | `--git-dir=$T/bare.git --work-tree=$T/nope` (missing dir) | — | — | `$T/nope`, **exit 0** | `fatal: this operation must be run in a work tree` (128) |
| `$T/elsewhere` | `--git-dir=$T/bare.git`, `core.worktree=$T/nope2` (missing) | `core.bare` removed | — | `$T/nope2`, exit 0 | fatal 128 |

Three rows are the load-bearing surprises:

- **`--git-dir=<bare4.git>` with no `core.bare` gives a work tree at cwd** while
  `cd bare4.git` on the *same fixture* gives none. Bareness is not a property of the
  directory shape; the **route** decides whether a work tree is defaulted at all.
- **`core.worktree` is honoured on every route**, including plain `.git`-directory
  discovery and `.git`-file (separate-git-dir / submodule / linked-worktree) discovery —
  not only with an explicit gitDir, contrary to the common folk rule.
- **An explicit work tree overrides `core.bare=true` silently** (no warning), whereas
  `core.worktree` + `core.bare` warns and produces *no* work tree.

Relative `core.worktree` resolution is **physical**: git `chdir`s to the gitDir, `chdir`s
to the relative value, then takes `getcwd()`. Two consequences pinned separately: the
failure message names the *relative* value (`cannot chdir to '../wt'`), and a symlinked
work tree resolves to its real path — `core.worktree = $T/wt-link` (a symlink to `$T/wt2`)
and `core.worktree = ../../wt-link` both yield `--show-toplevel` = `$T/wt2`.

`--show-toplevel` does **not** require the work tree to exist; `setup_work_tree` (what
work-tree commands call) does. That is the exit-0/exit-128 split in the last two rows.

Explicit-gitDir edges, pinned separately because they decide how lenient resolution may be:

| invocation | git |
|---|---|
| `--git-dir=$T/nope` (missing) + `log` | `fatal: not a git repository: '$T/nope'` (128) — note the quoted path and the **absence** of `(or any of the parent directories)`: a different message from the discovery failure |
| `--git-dir=$T/emptydir` (exists, empty) + `log` / `rev-parse --git-dir` / `--is-bare-repository` | same fatal |
| `--git-dir=$T/emptydir` + **`init`** | **succeeds** — `Initialized empty Git repository in $T/emptydir/` |
| `--git-dir=$T/plain-file` (a regular file) | `fatal: invalid gitfile format: $T/plain-file` — an explicit gitDir that is a *file* is read as a **gitfile pointer**, the same grammar the walk uses |
| `--work-tree=$T/n` with no `--git-dir` and no repository anywhere | `fatal: not a git repository (or any of the parent directories): .git` — a work tree alone never conjures a repository |

Row 3 is the one that constrains the design: layout resolution must be **lenient** (accept
a gitDir that is not yet a repository) and let the command tier refuse, because that is the
only way `init` can bootstrap into it. tsgit already works this way — `resolveNodeLayout`
falls back rather than throwing, and `clone.ts:72-84` documents the same reasoning — so the
explicit route inherits it rather than inventing it. Row 4 says the explicit route must
route a *file* through `layoutFromGitfile`, exactly like the walk's file branch
(`find-layout.ts:42-43`) and the browser's fixed entry (`fixed-entry-layout.ts:24-33`).

#### 1d. `is_bare_repository()` — the formula

```
is_bare = (core.bare is not literally false) AND (no work tree was resolved)
```

Every §1c row satisfies it. Five shapes where the two conjuncts disagree — and today's
`isBare(ctx)` (`core.bare ?? false`) gets **every one of them wrong**:

| # | shape | `core.bare` | work tree | `--is-bare-repository` | git's work-tree commands | today's `assertNotBare` |
|---|---|---|---|---|---|---|
| 1 | `cd bare2.git`, `core.bare=false` | `false` | none | **`false`** | **refuse** | allows ✗ |
| 2 | `cd normal/.git` (`core.bare=false`, written by `git init`) | `false` | none | `false` | **refuse** | allows ✗ |
| 3 | `--git-dir=bare.git --work-tree=$T/wt` | `true` | `$T/wt` | **`false`** | **work** | refuses ✗ |
| 4 | linked worktree of a bare repo (`cd $T/wt`) | `true` (common config) | `$T/wt` | **`false`** | work | refuses ✗ (**measured**, Context §Observed failure) |
| 5 | `cd bare4.git`, no `core.bare` key | absent | none | **`true`** | refuse | allows ✗ |

So "is bare" and "may I touch a work tree" are **different questions**, and every command
guarded by `assertNotBare` answers the wrong one in all five shapes — two by permitting
what git forbids (rows 1, 2, 5) and two by forbidding what git permits (rows 3, 4). Row 4
additionally settles the `worktree.list` main-entry `bare` flag deferred by the
linked-worktree design: from inside the linked worktree,
`git worktree list --porcelain` prints the main entry `$T/bare.git` with a `bare` line
while the linked entry has none.

#### 1e. Where `core.bare` / `core.worktree` are read from

| source | honoured for layout? |
|---|---|
| `<commonDir>/config` (repo-local; `<gitDir>/config` for a normal repo) | **yes** |
| `<gitDir>/config.worktree` (per-worktree) with `extensions.worktreeConfig=true` + `repositoryformatversion=1` | **yes** (both keys) |
| `~/.gitconfig` (global) | **no** — global `core.bare=true` leaves a normal repo non-bare; global `core.worktree` is ignored |
| `/etc/gitconfig` (system) | not applicable under `GIT_CONFIG_NOSYSTEM=1`; same tier as global |
| `include.path` from the repo config | **no** — an included `core.worktree` is not honoured for the layout |

git reads exactly `<gitDir>/config` (plus `config.worktree` when the extension is on),
with the **include machinery disabled**, and picks out only
`core.repositoryformatversion`, `core.bare`, `core.worktree` and `extensions.*`. It does
this **after** locating the gitDir and **before** deciding the work tree.

Value-grammar refusals, pinned:

| config | git |
|---|---|
| `bare = banana` | `fatal: bad boolean config value 'banana' for 'core.bare'`, exit 128, on **every** command including `log` |
| `bare` (valueless) | `true` — the repo is bare |
| `worktree` (valueless) | `error: missing value for 'core.worktree'` + `fatal: bad config line 4 in file <path>`, exit 128 |

tsgit already matches the first two: `assertDiscoveryBooleansValid` refuses a malformed
`core.bare` on every command (`repo-state.ts:62-78`, pinned by
`test/integration/config-boolean-interop.test.ts` X11/X12/X14), and `parseGitBoolean(null)`
is `true` (pinned by `config-interop.test.ts:762-796`). `core.worktree` is a *new*
string-typed key and joins the valueless-refusal family (`CONFIG_MISSING_VALUE`,
`src/domain/commands/error.ts:548-549`) — but at the **discovery** tier, not the
operational `[core]` tier, since it refuses `log` too.

#### 1f. Work-tree-requiring commands — the refusal matrix

Measured in `$T/bare.git` (a `clone --bare`, `core.bare=true`) and, for the divergent rows,
in `$T/normal/.git` (a worktree-less **non-bare** gitdir). Message `WT` =
`fatal: this operation must be run in a work tree`; all refusals exit 128 unless noted.

| command | in a bare repo | in a worktree-less non-bare repo |
|---|---|---|
| `status`, `status --porcelain` | `WT` | `WT` |
| `add .` | `WT` | `WT` |
| `checkout <branch>`, `checkout -- .`, `switch`, `restore` | `WT` | `WT` |
| `commit -m x` | `WT` | `WT` |
| `stash`, `stash push`, `stash list`, `stash pop`, `stash show` | `WT` | `WT` |
| `merge <ref>` | `WT` | `WT` |
| `reset --hard` | `WT` | `WT` |
| `reset --mixed` | `fatal: mixed reset is not allowed in a bare repository` | **exit 0** |
| `reset --soft` | exit 0 | exit 0 |
| `rm`, `mv` | `WT` | `WT` |
| `clean -n`, `clean -nd` | `WT` | — |
| `grep <pat>` | `WT` | `WT` |
| `grep --cached <pat>` | exit 1 (empty index, no match) | exit 0, `a.txt:hi` |
| `grep <pat> HEAD` | exit 0 | — |
| `cherry-pick`, `revert`, `rebase`, `pull` | `WT` | — |
| `sparse-checkout list` | `WT` | — |
| `update-index --refresh`, `checkout-index -a` | `WT` | — |
| `diff` (worktree), `diff HEAD` | `WT` | `WT` |
| `diff --cached`, `diff <tree> <tree>` | exit 0 | exit 0 |
| `describe` | exit 0 (`v1`) | exit 0 |
| `describe --dirty` | `WT` | `WT` |
| `describe --broken` | **exit 0**, stdout `v1-broken`, the `WT` fatal on stderr from the spawned diff | — |
| `blame <path>` | **exit 0** — blames HEAD; a missing path gives `fatal: no such path <p> in HEAD` | **`WT`** |
| `submodule status` / `init` / `sync` / `deinit` | `fatal: … git-submodule cannot be used without a working tree.`, **exit 1** | — |
| `log`, `show`, `rev-list`, `cat-file`, `ls-tree`, `for-each-ref`, `archive`, `fsck`, `gc`, `notes`, `tag`, `branch`, `config`, `reflog`, `shortlog`, `name-rev`, `range-diff`, `read-tree`, `write-tree`, `symbolic-ref`, `ls-files`, `worktree list` / `prune`, `bisect start` | exit 0 | exit 0 |
| `rev-parse --show-toplevel` | `WT` | `WT` |
| `rev-parse --is-inside-work-tree` | `false`, exit 0 | `false`, exit 0 |

With **both** `core.bare` and `core.worktree` set, the refusal changes shape:

| query | git |
|---|---|
| any command (stderr, once) | `warning: core.bare and core.worktree do not make sense` |
| `status` | `fatal: unable to set up work tree using invalid config`, 128 |
| `rev-parse --show-toplevel` | `fatal: this operation must be run in a work tree`, 128 |
| `rev-parse --is-bare-repository` | `true`, exit 0 |

So the gate is: **bogus work-tree config** → one refusal; **no work tree** → another;
otherwise proceed. `reset --mixed` and `blame` are the two commands keyed on
`is_bare_repository()` rather than work-tree presence — which is exactly why §1d's
distinction has to be modelled and cannot be collapsed.

#### 1g. `rev-parse` layout queries

`(empty)` = the query printed an empty line, exit 0. `—` = not measured in this pass.

| cwd / invocation | `--git-dir` | `--absolute-git-dir` | `--git-common-dir` | `--is-inside-git-dir` | `--is-inside-work-tree` | `--show-cdup` | `--show-prefix` |
|---|---|---|---|---|---|---|---|
| `$T/normal` | `.git` | `/private…/normal/.git` | `.git` | `false` | `true` | (empty) | (empty) |
| `$T/normal/sub/deep` | `/private…/normal/.git` | same | `../../.git` | `false` | `true` | `../../` | `sub/deep/` |
| `$T/normal/.git` | `.` | `/private…/normal/.git` | `.` | `true` | `false` | (empty) | (empty) |
| `$T/bare.git` | `.` | `/private…/bare.git` | `.` | `true` | `false` | (empty) | (empty) |
| `$T/bare.git/refs` | `/private…/bare.git` | same | `/private…/bare.git` | `true` | `false` | (empty) | (empty) |
| `--git-dir=$T/bare.git` from `$T/elsewhere` | `/var…/bare.git` (**as given, unresolved**) | `/private…/bare.git` | `/var…/bare.git` | `false` | `false` | (empty) | (empty) |
| `--git-dir=bare.git` (relative) from `$T` | `bare.git` (**verbatim**) | `/private…/bare.git` | `bare.git` | `false` | `false` | (empty) | (empty) |
| `--git-dir=$T/normal/.git` from `$T/elsewhere` | as given | resolved | as given | `false` | `true` | (empty) | (empty) |
| `--git-dir=$T/bare.git --work-tree=$T/wt` from `$T/elsewhere` | as given | resolved | as given | `false` | `false` | `/private…/wt` (absolute!) | (empty) |
| same, cwd `$T/wt` | as given | resolved | as given | `false` | `true` | (empty) | (empty) |
| same, cwd `$T/wt/s` | resolved | resolved | resolved | `false` | `true` | `../` | `s/` |
| `$T/bare-wt` (linked worktree of the bare repo) | `/private…/bare.git/worktrees/bare-wt` | same | `/private…/bare.git` | — | — | — | — |
| `$T/bare.git/worktrees/bare-wt` (its admin dir) | `.` | — | `/private…/bare.git` | — | — | — | — |

The last two rows were measured for the `--git-dir` / `--git-common-dir` /
`--is-bare-repository` triple only (`false` and `true` respectively); their cwd-relative
queries are left unmeasured because scenario N pins them against live git rather than
against this table.

`--git-dir` prints the **stored string**, not a canonical path: `.` when the gitdir is the
cwd, `.git` when it is `cwd/.git`, the caller's literal argument when explicit, an absolute
resolved path otherwise. `--git-common-dir` is *made relative against cwd against cwd* when it can be
(`../../.git`). Both are **display concerns** — per ADR-249 tsgit ships resolved absolute
paths and the interop test compares against
`git rev-parse --path-format=absolute --git-dir --git-common-dir`, which is unambiguous in
every row above, then reconstructs the relative forms from `layout` + `ctx.cwd`.

`--is-inside-git-dir` and `--is-inside-work-tree` are **cwd-relative**, not layout
properties: with an explicit gitDir and cwd outside it, `--is-inside-git-dir` is `false`
even though the gitdir is the same directory the third row calls `true`. Both are derivable
from `ctx.cwd` + the layout, so they belong in the reconstruction, not in stored state.

#### 1h. Ceiling directories

cwd `$T/normal/deep/deeper`; the repo is `$T/normal`. An oracle distinguishes "walk
reached the repo" from "walk stopped" without ambiguity.

| `GIT_CEILING_DIRECTORIES` | repo found? |
|---|---|
| unset | yes |
| `$T` (above the repo) | yes |
| `$T/normal` (the repo root itself) | **no** — the ceiling directory is never examined |
| `$T/normal/deep` (intermediate) | **no** |
| `$T/normal/deep/deeper` (== cwd) | **yes** — a ceiling equal to cwd is a no-op |
| `$T/normal/` (trailing slash) | no — same as without |
| `/nope:$T/normal` (colon list) | no — every entry counts |
| `normal` (relative) | yes — non-absolute entries are ignored |
| ceiling below cwd | yes — irrelevant entries are ignored |
| cwd == repo root, ceiling == repo root | **yes** — still a no-op (strict-ancestor rule) |

Symlink handling, cwd `$T/link/deep` where `$T/link → $T/real` and the repo is `$T/real`:

| ceiling | repo found? |
|---|---|
| `$T/link` | **no** — the entry is realpath'd, then matched |
| `$T/real` | **no** — cwd is compared physically |
| `:$T/link` (leading empty entry disables symlink resolution) | **yes** — the literal `$T/link` is not an ancestor of the physical cwd |

Rule: take the **longest ceiling entry that is a strict ancestor of the resolved cwd**; the
walk never examines that directory or anything above it. Entries are absolute-only and
realpath'd by default. The `:`-prefix toggle and the colon splitting are **env-string
parsing artefacts** with no representation in an array argument (see D5).

#### 1i. `init --bare` / `clone --bare` on-disk shape

| artefact | `git init` | `git init --bare` | `git clone --bare` |
|---|---|---|---|
| `[core] bare` | `false` | `true` | `true` |
| `[core] logallrefupdates` | `true` | absent | absent |
| `[core] repositoryformatversion` | `0` | `0` | `0` |
| entries at the gitdir | under `<workDir>/.git` | `HEAD config description hooks info objects refs` | plus `packed-refs` |
| `HEAD` | `ref: refs/heads/<default>` | same | `ref: refs/heads/<source HEAD>` |
| refs after clone | — | — | all in `packed-refs` (`refs/heads/*` **and** `refs/tags/*`); `refs/` dirs empty |
| `[remote "origin"]` | — | — | `url` only, **no `fetch` refspec** |
| `index` | present after first add | **absent** | absent |

`git init --separate-git-dir` writes `bare = false` into the external gitdir — which is why
a `.git`-file repo is non-bare by default (§1c) and becomes bare only if someone sets
`core.bare=true` there.

Server-side, pinned end to end: `git fetch` from and `git push` into a bare repo both
succeed; `pre-receive` / `post-update` hooks in `<bare>/hooks` fire with `PWD=<bare.git>`
and `GIT_DIR=.`; `git clone <bare>` produces a **non-bare** clone.

### 2. Layout resolution flow

One algorithm, structural first, config second — the ordering is git's and is what makes
§1c's route distinction expressible.

```
resolveLayout(probe, opts, cwd, policy, readRepoFormat) -> ResolvedLayout
  # ── Stage 1: locate the gitDir (structure only, no config) ───────────────
  if opts.gitDir is given:
    # NB: branch on isAbsolute — an absolute value is used verbatim. A literal
    # resolve(join(cwd, value)) nests absolute values under cwd on the portable
    # policy, whose join has no later-absolute-wins semantics (implementation-
    # verified; the node policy's multi-arg resolve masks the bug).
    entry   := policy.resolve(policy.join(cwd, opts.gitDir))       # relative → against cwd
    gitDir  := probe.stat(entry) is a file                         # §1c explicit-edge row 4
                 ? resolvePointer(probe, entry, dirname(entry), policy)   # gitfile grammar
                 : entry                                            # LENIENT: may not exist
    route   := EXPLICIT
    origin  := undefined
  else:
    (gitDir, route, origin) := walk(probe, cwd, policy, ceiling)   # §1a
    # route ∈ { DISCOVERED (a .git entry), BARE_DIR (cwd itself) }
    # origin = the directory holding the .git entry, for route = DISCOVERED
  commonDir := resolveCommonDir(probe, gitDir, policy)             # unchanged
  # NOTE: the EXPLICIT route does NOT validate `gitDir` here (§1c explicit-edge row 3).
  # `assertRepository` refuses at first command; `init`/`clone` bootstrap into it.
  # The walk routes keep today's semantics (skip-and-climb / hard-stop, ADR-533/534).

  # ── Stage 2: read the repository format keys from THIS gitDir ────────────
  fmt := readRepoFormat(probe, commonDir)      # <commonDir>/config, no includes,
                                               # + config.worktree when the extension is on
                                               # keys: core.bare, core.worktree, extensions.*
  if fmt.bare is a malformed boolean:      → CONFIG_BAD_BOOLEAN_VALUE   (§1e)
  if fmt.worktree is present-but-valueless: → CONFIG_MISSING_VALUE      (§1e)

  # ── Stage 3: decide the work tree (§1c precedence) ───────────────────────
  bogusWorkTreeConfig := false
  bareCfg := opts.bare ?? fmt.bare       # D11(a): the argument tier wins outright
  if opts.workDir is given:
    workDir := policy.resolve(policy.join(cwd, opts.workDir))      # R1c-1
                                          # need not exist: git's --show-toplevel prints a
                                          # missing work tree; only setup_work_tree refuses
  else if bareCfg is true:                                         # R1c-2
    workDir := none
    if fmt.worktree is present: bogusWorkTreeConfig := true
  else if fmt.worktree is present:                                 # R1c-3 / R1c-4
    workDir := policy.isAbsolute(fmt.worktree)
                 ? policy.resolve(fmt.worktree)
                 : canonicalise(policy.resolve(policy.join(gitDir, fmt.worktree)))
  else if route = EXPLICIT:      workDir := cwd                    # R1c-5
  else if route = DISCOVERED:    workDir := origin                 # R1c-6
  else:                          workDir := none                   # R1c-7 (BARE_DIR)

  # ── Stage 4: the derived answer ──────────────────────────────────────────
  # `bareCfg` unset (neither opts.bare nor core.bare) is TRUTHY here — git's
  # is_bare_repository_cfg defaults to -1, not 0 (pinned: §1d row 5).
  bare := bareCfg !== false  AND  workDir is none                  # §1d
  return { gitDir, commonDir?, workDir?, bare, bogusWorkTreeConfig, homeDir? }
       # homeDir is threaded through from the shim unchanged (os.homedir() on node,
       # absent on browser) — this feature does not touch it.
```

`walk` is today's loop with one addition per level, ordered so the common path costs
nothing extra:

```
walk(probe, cwd, policy, ceiling):
  current := policy.resolve(cwd)
  ceilStop := longestStrictAncestor(ceiling, current)      # §1h; undefined when none
  loop:
    if current === ceilStop: return NOT_FOUND
    candidate := policy.join(current, '.git')
    st := probe.stat(candidate)
    if st is directory: if layoutFor(...) defined → (that gitDir, DISCOVERED, current)
    else if st is file: → gitfile branch (hard stop or DISCOVERED)   # unchanged
    #  ── new: is `current` itself a git directory? ──
    if probe.stat(join(current,'HEAD')) is a file:                    # cheap gate first
      if isGitDirectory(probe, current, resolveCommonDir(current)):
        return (current, BARE_DIR, undefined)
    parent := policy.dirname(current)
    if parent === current: return NOT_FOUND
    current := parent
```

**Cost (R12).** A level with no `.git` costs 1 `stat` today. It costs **2** after this
change (`.git`, then `HEAD`), and only a level that actually holds a `HEAD` **file** goes
on to `commondir` + `objects` + `refs`. A level that *does* hold a valid `.git`
short-circuits before the new probe and is unchanged. Walk depth is bounded by the path
depth (and by `ceilingDirs` when supplied), so the worst case is one extra `stat` per
ancestor directory — the same asymmetry git pays. Ordering the cheap `HEAD` gate ahead of
the full predicate is what keeps R12 true; inlining `isGitDirectory` directly would cost
three extra `stat`s per level on every walk.

**Ceiling stop.** `longestStrictAncestor` compares through the same `PathPolicy` the walk
uses (drive-letter / UNC aware, ADR-495) and requires a **strict** ancestor: equality is a
no-op (§1h). It is computed once, before the loop, not per level. Because it is strict, it
can never equal the initial `current`, so **cwd is always examined** — the `current ===
ceilStop` test at the loop head can only fire on a later iteration. That is what makes the
"ceiling == cwd" and "ceiling == cwd == repo root" rows of §1h no-ops rather than refusals.

### 3. Layout shape — work-tree presence vs bareness

`RepositoryLayout` (`src/ports/context.ts:21-44`) and `RepositoryLayoutInput`
(`src/repository.ts:127-138`) must express three states, because §1d proves they are three:

| state | `workDir` | `bare` |
|---|---|---|
| ordinary repository | present | `false` |
| bare repository | absent | `true` |
| worktree-less but not bare (`core.bare=false` + cwd-is-gitdir; `cd normal/.git`) | absent | `false` |
| bare-flagged with an explicit work tree (`--git-dir=bare.git --work-tree=…`) | present | `false` |

`workDir` is therefore `string | undefined`, and `bare` remains a `boolean` computed by
§1d's formula — not a synonym for "no work tree" (D1). One further field is needed to keep
§1f's two distinct refusals apart:

```ts
export interface RepositoryLayout {
  /** Absolute path to the working tree. Absent when the repository has none
   *  (bare, or a git dir opened without one) — git's `get_git_work_tree() == NULL`. */
  readonly workDir?: string;
  readonly gitDir: string;
  readonly commonDir?: string;
  /** git's `is_bare_repository()`: core.bare is not false AND there is no work tree. */
  readonly bare: boolean;
  /** `core.bare` and `core.worktree` are both set — git's `work_tree_config_is_bogus`.
   *  Work-tree commands refuse with a distinct code (§6). */
  readonly workTreeConfigBogus?: boolean;
  readonly homeDir?: string;
}
```

Ripple, from the measured inventory:

- `layoutRootsOf` (`src/repository/layout-roots.ts:20`) drops the `workDir` candidate when
  absent; a bare repo's root set collapses to `[gitDir]`, a bare linked-worktree host to
  `[gitDir, commonDir]` (R11).
- `Context.cwd` default (`src/ports/context.ts:179`, `cwd: parts.cwd ?? parts.layout.workDir`)
  falls back to `gitDir` when there is no work tree — matching git, whose `--show-prefix`
  is empty and whose `--is-inside-git-dir` is `true` in exactly that shape.
- `assertRepository`'s root selection (`repo-state.ts:91`,
  `ctx.layout.bare ? gitDir : workDir`) becomes `workDir ?? gitDir` — provably identical
  today (where `bare` is always `false` and `workDir` always present) and correct for the
  worktree-less-non-bare row that `bare` alone gets wrong.
- `notARepository(ctx.layout.workDir as FilePath)` (`repo-state.ts:88`) names `workDir ??
  gitDir`.
- `getRepoRoot` (`src/application/primitives/path-layout.ts:16`) returns
  `workDir ?? gitDir`, matching `assertRepository`.
- Every remaining `layout.workDir` read is inside a work-tree-touching code path and is
  reached only after the §6 gate has proved a work tree exists; the gate **returns** the
  work tree, so those sites take it as a value and the compiler enforces the audit rather
  than a reviewer. The reads cluster behind a small number of choke points —
  `repoPath` in `src/application/commands/internal/working-tree.ts:20`,
  `apply-sparse-checkout.ts:199`, `materialize-tree.ts:248`, `walk-working-tree.ts:204,210`,
  `compare-working-tree-entry.ts:138`, `write-working-tree-file.ts:79,103,150,168,172`,
  `snapshot/workdir-entry.ts:77`, `symlinked-leading-path.ts:56,100`,
  `find-would-overwrite.ts:78`, `internal/read-gitignore.ts:20`,
  `internal/read-gitattributes.ts:26`, `internal/submodule-context.ts:17` — plus the
  per-command reads listed in `add.ts`, `blame.ts`, `grep.ts`, `mv.ts`, `stash.ts`,
  `status.ts` and `submodule.ts`. The three *spawn-cwd* uses
  (`apply-textconv.ts:33`, `sign-payload.ts:74,98`, `run-hook.ts:73`) and the hooks-dir join
  (`run-hook.ts:43`) are **not** work-tree reads: they need a working directory for a child
  process, and fall back to `gitDir` when there is no work tree — matching git, whose bare
  hooks run with `PWD=<bare.git>` (§1i).
- Child Contexts that hardcode `bare: false`
  (`internal/worktree-context.ts:45`, `internal/submodule-context.ts:24`) keep it: a linked
  worktree and a submodule working directory both *have* work trees, and §1d row 4 confirms
  a linked worktree of a bare repo is not bare.

### 4. Option surface

```ts
export interface OpenRepositoryOptions {
  readonly cwd?: string;
  /** Explicit git directory — the argument equivalent of git's `--git-dir`.
   *  Relative values resolve against `cwd`. Supplying it skips discovery entirely. */
  readonly gitDir?: string;
  /** Explicit working tree — the argument equivalent of git's `--work-tree`.
   *  Relative values resolve against `cwd`. Overrides `core.bare` and `core.worktree`. */
  readonly workDir?: string;
  /** Force bareness. `true` behaves as `core.bare = true`; `false` as `core.bare = false`.
   *  Omit to take the answer from config + layout (§1d). */
  readonly bare?: boolean;
  /** Absolute directories bounding the discovery walk — the argument equivalent of
   *  `GIT_CEILING_DIRECTORIES`. Ignored when `gitDir` is supplied (no walk happens). */
  readonly ceilingDirs?: ReadonlyArray<string>;
  // … existing fields unchanged
}
```

Validation joins `src/repository/validate-options.ts` in its established style — one
`validateX` per field, each an isolated `if`, all raising `INVALID_OPTION { option, reason }`
(`src/domain/commands/error.ts:450-451`), boundaries tested in isolated triples:

| field | rule | `reason` |
|---|---|---|
| `gitDir` | non-empty string | `must not be empty` |
| `workDir` | non-empty string | `must not be empty` |
| `ceilingDirs` | every entry absolute | `entries must be absolute paths` |
| `ceilingDirs` | every entry non-empty | `entries must not be empty` |

`gitDir` / `workDir` are deliberately **not** required to be absolute (git accepts
`--git-dir=bare.git`, §1g) — they resolve against `cwd`, which `validateOptions` already
requires to be absolute (`validate-options.ts:30-32`). `ceilingDirs` **is** absolute-only,
because git ignores non-absolute entries silently and a silently-ignored argument is worse
than a refusal (D5).

`ValidatableOptions` (`validate-options.ts:9-12`) gains the four fields; it stays a
structural subset of `OpenRepositoryOptions`.

**Browser coherence.** `OpenBrowserRepositoryOptions` (`src/index.browser.ts:36`) already
has `bare?: boolean`; it gains `gitDir?` / `workDir?` with the same meaning, threaded
through `resolveFixedEntryLayout`, whose signature changes from a positional
`bare: boolean` to the resolved-layout shape so both shims share one Stage 3.
`ceilingDirs` lives on the core `OpenRepositoryOptions` and is validated there, but the
browser never walks (ADR-538) so it has no effect on that runtime; it is **not** added to
`OpenBrowserRepositoryOptions`, which is a distinct interface — the browser shim strips its
own fields and forwards the rest (`index.browser.ts:72-77`), so an unused core field costs
nothing and an option that silently does nothing is never surfaced to browser callers.

### 5. Config read at open time — ordering and scope

Today **no** `.git/config` is read during `openRepository`: `src/repository.ts` never
mentions `readConfig`, and the first read happens lazily inside the first command through
`assertRepository → assertDiscoveryBooleansValid → readConfigEntry`, memoised per Context
(`config-read.ts:151-201`). Stage 2 of §2 needs `core.bare` / `core.worktree` **before the
Context exists**, so the read cannot go through `readConfig(ctx)`.

The faithful ordering is git's and is non-negotiable:

1. locate the gitDir **structurally** — no config read at all;
2. read the repository-format keys from **that** gitDir;
3. decide the work tree;
4. build the Context.

Scope of the Stage-2 read, exactly (§1e): `<commonDir>/config`, plus
`<gitDir>/config.worktree` when `extensions.worktreeConfig` is true (D10); **no** global,
**no** system, **no** `include.path` expansion; only `core.bare`, `core.worktree` and
`extensions.*` are extracted. Everything else in the file is ignored at this stage and is
validated later by the existing two-tier gates on first command
(`assertDiscoveryBooleansValid` / `assertEagerConfigValid`).

Mechanically: a new `readRepositoryFormat(probe, commonDir, policy)` in
`src/repository/` reads the file through the same `LayoutProbe.readUtf8` the walk already
uses (size-capped like the gitfile reads) and tokenises it with the **existing**
`tokenizeConfig` / `parseIniSectionsFromTokens` from
`src/application/primitives/internal/config-ini.ts` — reusing the char-wise parser rather
than growing a second config grammar. It returns
`{ bare: boolean | 'malformed' | undefined, worktree: string | null | undefined, worktreeConfig: boolean }`
and the caller maps `'malformed'` → `configBadBooleanValue` and `null` (valueless) →
`configMissingValue`, so §1e's two refusals fire at open time as git's do.

**When the Stage-2 refusals surface** is a real behavioural choice, not an implementation
detail (D12). git has no "open" step: setup and command are one invocation, so
`bad boolean config value 'banana' for 'core.bare'` is observed on *every* command. tsgit
splits that into `openRepository` + a later call. Today the refusal fires on the first
command (`assertDiscoveryBooleansValid`), pinned by `config-boolean-interop.test.ts`
X11/X12/X14. Moving it to open time is arguably the closer mapping (Stage 2 *is* git's
setup) but changes when existing callers see it and rewrites the shape of three pinned
tests. Either way the ordering X12 pins — `core.bare` named before `core.sparseCheckout` —
is preserved, because open time precedes first command.

Two further consistency consequences worth stating because reviewers will ask:

- **The Stage-2 read is not cached into the Context's config cache.** It is a different
  file-read at a different time with a different key subset; sharing state would couple
  `openRepository`'s failure modes to the command-tier cache. The duplicate read is one
  `readUtf8` of a file that is almost always < 1 KiB, once per `openRepository`.
- **`isBare(ctx)` (`repo-state.ts:209-212`) is deleted, not re-pointed.** With `layout.bare`
  correct at open time, a second config-derived answer that can disagree with it is the very
  defect §1d describes. Its only consumer is `assertNotBare`, which §6 replaces.

The dependency rule holds: `src/repository/` importing from
`application/primitives/internal/` would invert the layering, so the pure tokenising half
of `config-ini.ts` — `tokenizeConfig`, `parseIniSectionsFromTokens`, `parseGitBoolean` and
the token types they share — moves to `src/domain/config/`, and both tiers import it from
there. The move is cheap and independently justified: the file is **807 lines** (already
over the 800-line budget), its only non-local import is
`domain/commands/error.js` (`config-ini.ts:11`) so it has **no application-tier dependency
to break**, and it has exactly **three** importers (`config-read.ts`, `update-config.ts`,
and itself). A pure relocation, no behaviour change (D3 covers leaving it in place, and
hand-rolling a second mini-parser).

### 6. Refusal semantics — the work-tree gate

git's per-command gate is `setup_work_tree()`, which refuses in two shapes (§1f):

| condition | git | tsgit |
|---|---|---|
| `core.bare` and `core.worktree` both set | `fatal: unable to set up work tree using invalid config` (128) | `WORK_TREE_CONFIG_INVALID { gitDir }` |
| no work tree resolved | `fatal: this operation must be run in a work tree` (128) | `WORK_TREE_REQUIRED { operation }` |
| `reset --mixed` while `is_bare_repository()` | `fatal: mixed reset is not allowed in a bare repository` (128) | `BARE_REPOSITORY { operation: 'reset --mixed' }` |
| relative `core.worktree` whose physical resolution fails — target missing OR a non-directory (git cannot `chdir` into a file; both measured) | `fatal: cannot chdir to '<value>': …` (128), at setup, on every command | `WORK_TREE_UNRESOLVABLE { value, gitDir }` at `openRepository` on adapters with realpath; lexical (accepting) on sandboxed adapters, the established canonicalisation split |
| `submodule <verb>` with no work tree | `fatal: … cannot be used without a working tree.` (**exit 1**) | `WORK_TREE_REQUIRED { operation }` — the differing exit code is git's shell-wrapper artefact, not a distinct condition |

Per ADR-249 the **conditions and their discriminants** are what must match; the message
bytes are reconstructed in the interop test.

The gate is one helper replacing `assertNotBare`, and it **narrows the type** so the
compiler enforces the audit:

```ts
// src/application/primitives/internal/repo-state.ts
/** git's `setup_work_tree()`: refuse when the work-tree config is bogus, then when
 *  there is no work tree. Returns the work tree so callers stop reading it unguarded. */
export const requireWorkTree = (ctx: Context, operation: string): string => {
  if (ctx.layout.workTreeConfigBogus === true) throw workTreeConfigInvalid(ctx.layout.gitDir);
  const workDir = ctx.layout.workDir;
  if (workDir === undefined) throw workTreeRequired(operation);
  return workDir;
};
```

It is **synchronous** — the layout is already resolved, so unlike `assertNotBare` it costs
no config read and can be called without an `await`. It keeps `assertNotBare`'s **position**
in each command (after `assertOperationalRepository`), so the refusal precedence between a
malformed `[core]` entry and a missing work tree is unchanged: config validity still refuses
first, matching git, where `check_repository_format_gently` runs during setup and
`setup_work_tree()` runs after it.

The sweep, from the measured inventory. `→` = the call replaces `assertNotBare`; `+` = a
gate that does not exist today and is a measured divergence being closed.

| module | today | after |
|---|---|---|
| `add.ts:98` | `assertNotBare(ctx,'add')` | → `requireWorkTree` |
| `checkout.ts:310` | `assertNotBare` | → |
| `commit.ts:100` | `assertNotBare` | → |
| `mv.ts:99`, `rm.ts:69` | `assertNotBare` | → |
| `merge.ts:164`, `abort-merge.ts:33`, `continue-merge.ts:35` | `assertNotBare` | → |
| `cherry-pick.ts:431,536,589,623` | `assertNotBare` | → |
| `revert.ts:415,494,540,566` | `assertNotBare` | → |
| `rebase.ts:453,528,569,595` | `assertNotBare` | → |
| `pull.ts:96` | `assertNotBare` | → |
| `sparse-checkout.ts:71` | `assertNotBare` | → |
| `stash.ts:196,297,429` (push / drop / apply) | `assertNotBare` | → |
| `stash.ts:282` (`stashList`), `stash.ts:483` (`stashPop`) | **ungated** | **+** — git refuses `stash list` and `stash pop` (§1f) |
| `submodule.ts:634,757` (add / update) | `assertNotBare` | → |
| `submodule.ts` list / init / sync / deinit | **ungated**, read `.gitmodules` from `workDir` (`:522`) | **+** |
| `status.ts` | **ungated** | **+** |
| `grep.ts` | **ungated** | **+ conditional** — only when the target is the working tree (`opts.target` absent); `'index'` and tree targets stay open |
| `blame.ts` | **ungated** | **+ conditional** — only when `opts.worktree === true` **and** the repo is not bare; in a bare repo git blames HEAD instead of refusing (§1f) |
| `describe.ts` | **ungated** | **+ conditional** — `dirty` refuses; `broken` does **not** refuse (git returns `<desc>-broken`), so `broken` maps to `broken: true` in the result without a work tree |
| `reset.ts:64` | `assertNotBare` only for `mode: 'hard'` | `'hard'` → `requireWorkTree`; **+** `'mixed'` → `bareRepository('reset --mixed')` when `layout.bare`; `'soft'` ungated |
| `diff.ts` | **ungated** | **+ conditional** — only the working-tree-comparing shapes; `--cached` and tree↔tree stay open |
| `clone.ts:83` | reads `layout.workDir` for the not-empty check | `workDir ?? gitDir` — a bare clone's target *is* the gitDir |

`reset --mixed` is the one concrete **index-write** gap: `reset` acquires the index lock for
`'mixed'` (`reset.ts:101-102,126`) and would create `<bare-gitdir>/index`, which git never
does. The new gate closes it.

New codes live in `src/domain/repository/error.ts` beside `BARE_REPOSITORY`, each carrying
data so tests assert payloads rather than the class (mutation-resistance, CLAUDE.md), with
an `extractDetail` arm in `src/domain/error.ts`:

```ts
export type RepositoryError =
  | { readonly code: 'NOT_A_REPOSITORY';         readonly path: FilePath }
  | { readonly code: 'BARE_REPOSITORY';          readonly operation: string }
  | { readonly code: 'WORK_TREE_REQUIRED';       readonly operation: string }   // new
  | { readonly code: 'WORK_TREE_CONFIG_INVALID'; readonly gitDir: string }      // new
  | { readonly code: 'ALREADY_INITIALIZED';      readonly path: FilePath };
```

`BARE_REPOSITORY` is **kept**, narrowed to its one faithful use (`reset --mixed`), rather
than deleted — deleting a published error code is a breaking change for callers already
catching it, and §1f proves there is a real condition that needs it (D2).

### 7. Layout read surface

`repo.ctx.layout` is already public (`src/repository.ts:311`, the facade's only readonly
data field; `RepositoryLayout` is re-exported from `ports/index.ts`) and the
linked-worktree interop test already asserts against it. The delta this feature owes is
**not a new source of truth** but a first-class, documented accessor plus the fields that
make git's `rev-parse` layout queries reconstructible:

```ts
export interface Repository {
  // …
  /** The resolved physical layout. Same object as `ctx.layout`; surfaced directly so
   *  callers do not reach through `ctx`. */
  readonly layout: RepositoryLayout;
}
```

The reconstruction table — what a caller (and the interop test) computes from
`repo.layout` + `repo.ctx.cwd`, never from a library-rendered string (ADR-249):

| git query | reconstructed from |
|---|---|
| `--path-format=absolute --git-dir` | `layout.gitDir` — asserted **directly**, the unambiguous oracle |
| `--path-format=absolute --git-common-dir` | `layout.commonDir ?? layout.gitDir` |
| `--absolute-git-dir` | `layout.gitDir` (already realpath'd on node, ADR-537) |
| `--git-dir` (display form) | `.` when `cwd === gitDir`; `.git` when `gitDir === cwd + '/.git'`; the caller's `opts.gitDir` verbatim when supplied; else `gitDir` |
| `--is-bare-repository` | `layout.bare` |
| `--show-toplevel` | `layout.workDir`, refusing with `WORK_TREE_REQUIRED` when absent |
| `--is-inside-work-tree` | `layout.workDir !== undefined && cwd is inside it` |
| `--is-inside-git-dir` | `cwd is inside layout.gitDir` |
| `--show-prefix` | `cwd` relative to `layout.workDir`, `''` when outside or absent |
| `--show-cdup` | inverse of `--show-prefix`; `layout.workDir` itself when cwd is outside it |

`--show-toplevel`'s refusal is the **caller's**: the library exposes
`workDir === undefined` and the caller (or the interop test) reconstructs git's
`fatal: this operation must be run in a work tree`. Reading the layout never throws.

`layout` is the **same object** as `ctx.layout`, not a copy — one source of truth. It is
attached beside `ctx` at `src/repository.ts:759`. `Object.freeze(ctx)`
(`src/repository.ts:452`) is **shallow**, so it does not currently freeze the layout;
exposing the layout as a first-class field is the moment to run it through the existing
`deepFreeze` (`src/repository/deep-freeze.ts`, already used for `opts.config` at
`repository.ts:415`) so a caller cannot mutate the object every primitive reads.

`revParse` is deliberately left alone: its signature is
`(ctx, expression: string) => Promise<ObjectId>` (`src/application/commands/rev-parse.ts:32-36`)
— a revision resolver with no options type and no structural queries. Bolting layout
queries onto it would force a union return type on every caller of a hot, single-purpose
function, to expose data the layout field already carries (D6).

### 8. Containment, canonicalisation, and the shims

**Containment (R11).** `layoutRootsOf` (`src/repository/layout-roots.ts:20`) builds its
candidate list from `[workDir, gitDir, commonDir ?? gitDir]`; with `workDir` absent the
list starts at `gitDir` and minimisation is unchanged. Consequences:

- bare repo: `[gitDir]` — one root, one prefix comparison per FS call, no regression;
- explicit `workDir` outside `gitDir`: `[workDir, gitDir]` — exactly the two subtrees, never
  their common ancestor (the ADR-541 rule; a common-ancestor rooting of `--git-dir=/srv/r.git
  --work-tree=/home/u/w` would admit `/`);
- normal repo: `[workDir]` — bit-identical to today (R12).

`makeWorktreeFs` (`src/index.node.ts:111`,
`new NodeFileSystem([layout.workDir, ...worktreePaths], nativePolicy)`) drops the absent
`workDir` from its root list the same way.

**Canonicalisation (ADR-537).** The node shim realpaths `cwd`, `gitDir` and `commonDir`
today; it additionally realpaths a resolved `workDir` — required, not cosmetic, because git
resolves `core.worktree` **physically** (§1c) and `NodeFileSystem` compares realpaths, so a
lexical `workDir` under a symlinked ancestor yields a spurious `PERMISSION_DENIED` (the
macOS `/var → /private/var` case the interop helpers already work around). An **explicit**
`opts.workDir` is resolved but its canonicalisation follows the same node/sandboxed split as
every other layout path. Sandboxed adapters stay lexical. `ceilingDirs` entries are
realpath'd on node and resolved lexically elsewhere, matching git's default (§1h) — the
`:`-prefix opt-out has no argument representation (D5).

**Node.** `resolveNodeLayout` (`src/index.node.ts:175-192`) gains Stage 1's explicit-gitDir
short-circuit, Stage 2's format read, and Stage 3. Its not-found fallback
(`{ workDir: cwd, gitDir: cwd + '/.git', bare: false }`, `:180`) is **kept** — it is what
lets `repo.init()` / `repo.clone()` bootstrap into an empty directory — but is now reached
only when neither a `.git` entry nor a cwd-is-gitdir was found, which is exactly git's
`fatal: not a git repository` case. It stays non-bare with a work tree, because a fresh
`init()` in an empty directory is a non-bare repository.

**Memory.** `src/index.default.ts:58-62` runs the same shared resolution. Layouts must stay
inside `rootDir`; a `gitDir` / `workDir` / ceiling outside it reads as "absent" through the
`LayoutProbe` contract (ADR-535), so resolution fails cleanly rather than escaping (R13).

**Browser.** No walk (ADR-538). `resolveFixedEntryLayout`
(`src/repository/fixed-entry-layout.ts`) keeps resolving the fixed `/{gitDirName}` entry,
then runs the **same Stage 2 + Stage 3** so `core.bare` / `core.worktree` behave
identically. `ROOT_WORK_DIR = '/'` means a browser bare repo has `gitDir === '/'`; the
`joinPath` helper already special-cases the trailing slash
(`src/application/primitives/internal/join-working-tree-path.ts:7`).

**init / clone round-trip (R10).** `bootstrapRepository`
(`src/application/commands/internal/bootstrap.ts:40-66`) already writes the right bytes
(`bare = true`, §1i) but writes them at `ctx.layout.gitDir`, and `init`'s own doc comment
says the caller must have built a Context whose `gitDir === workDir` — which
`openRepository` could not do. With `opts.gitDir` (or the discovery of an already-bare
directory) that Context is now constructible, and `init({ bare: true })` in an empty
directory opened as `openRepository({ cwd: d, gitDir: d, bare: true })` produces a layout
real git reads back — and §1c's explicit-edge row 3 confirms git is equally lenient there
(`git --git-dir=<empty dir> init` succeeds while `git --git-dir=<empty dir> log` refuses).
Whether `init({ bare: true })` should *also* relocate its own gitDir when the layout says
otherwise is D10.

### 9. Threat model

The new discovery branch changes what a directory tree can make `openRepository` do, so it
gets an explicit pass.

**What changes.** Before: only a `.git` entry could name a repository. After: **any**
directory holding `HEAD` + `objects/` + `refs/` is a repository, at every level of the walk,
and (pinned, §1a) it **shadows a real repository above it**. A tree the user extracted from
an archive, a `node_modules` entry, a shared network mount, or a colleague's tarball can
therefore become the repository tsgit opens.

**What an attacker gains from that.**

| asset | exposure | mitigation in this design |
|---|---|---|
| `hooks/` scripts | the biggest one: hooks live in the *discovered* common dir, and the node `HookRunner` spawns them inheriting the full `process.env`. A planted gitdir is arbitrary code execution on the next hook-firing command. | Pre-existing and unchanged in kind (a planted `.git/` directory or `.git` gitfile already did this — the linked-worktree design records it). What is new is the *shape* of the bait. `openRepository({ hooks: false })` remains the documented mitigation, already warned about on `OpenRepositoryOptions.hooks` (`src/repository.ts:94-99`). |
| `config` — `merge.<d>.driver`, `core.excludesFile`, `core.attributesFile` | shell commands and file reads taken from the attacker's config | `command: false` (`src/repository.ts:102-110`) disables external drivers; the FS validator confines reads to the layout roots |
| `core.worktree` | **new**: config from the discovered gitdir now names a *directory outside the gitdir*, which is then added to the containment root set — an attacker-chosen widening | Bounded, not eliminated: the widening is to exactly one named directory — which MAY be an ancestor, up to `/` (a planted `core.worktree = /` collapses the minimised root set to `[/]` and so vacates the FS-validator mitigation listed one row up; measured, and faithful — git honours it). It is what git does; a tighter clamp would be a divergence needing its own ADR. The gate that *should* stop this is ownership-based, i.e. `safe.directory` — deferred, and this design does not narrow the gap. |
| planted special files (FIFO / device / directory named `config`, `commondir`, `HEAD`) | a FIFO stats at size 0, defeating a size cap, and a read on it blocks forever — denial of the whole discovery from any walk-path directory | every layout-time read is gated on `stat.isFile` before `readUtf8`; non-regular entries are treated as absent, never read |
| unbounded walk | a deep hostile tree makes discovery `stat` its way to `/` | `ceilingDirs` is the caller-side bound and is the reason it is in scope here rather than deferred with the env variables. It costs 2 `stat`s per level (§2), so the walk is I/O-bounded, not compute-bounded; there is no amplification. |
| oversized planted files | a huge `.git` gitfile or `commondir` | pointer files stay capped at 64 KiB; the Stage-2 CONFIG read is deliberately uncapped (git reads a repository config unbounded — a large legitimate config must open; measured) with the non-regular-file guard as its hostile-input gate |

**Interaction with the deferred `safe.directory` gate.** git grew `safe.directory` for
precisely this class: *following someone else's repository metadata is code execution*. tsgit
has no ownership gate, and this feature widens the set of directories that qualify as
metadata. The honest posture, recorded rather than hidden: the mechanism here is
git-faithful, `hooks: false` + `command: false` is the available mitigation today, and an
ownership/trust gate is a separate surface with its own design. Callers who open
attacker-influenced trees should pass `ceilingDirs` to bound the walk **and** disable hooks.

**What this design does not weaken.** Explicit `gitDir` / `workDir` are caller-supplied
arguments, not environment — an attacker who can set the caller's env gains nothing here
(this is the concrete security benefit of the no-env rule). Containment never widens to a
common ancestor (§8). The `LayoutProbe`'s absence/containment-denial contract still
terminates the walk at a sandbox boundary rather than throwing (R13). And the *narrowing*
alternative in D7 — adopting git's full `validate_headref` — strictly shrinks the set of
directories that qualify as bait.

### 10. Public surface

- `OpenRepositoryOptions` gains four documented optional fields (§4); `RepositoryLayout`
  gains `workTreeConfigBogus?` and turns `workDir` optional (§3); `Repository` gains
  `readonly layout` (§7); `RepositoryError` gains two codes (§6). All are additive except
  `workDir` becoming optional, which is a **type-level breaking change** for callers reading
  `repo.ctx.layout.workDir` as a `string` — called out in the docs page and the release
  notes; it is the change that makes the bug uncatchable-by-hand into a compiler error.
- `readRepositoryFormat` and the relocated config tokeniser stay internal (not added to any
  barrel), like `LayoutProbe` (ADR-535).
- `reports/api.json` must be regenerated and committed — a pre-push gate, and a cached-green
  `validate` can precede a red prepush.
- Docs: `docs/get-started/node.md` (bare + custom gitdir recipes),
  `docs/reference/` `openRepository` page (the four options + the precedence table of §1c),
  and the error-code reference for the two new codes.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | How the layout represents "no work tree" (§3) | (a) `workDir?: string` optional, `bare` stays the §1d formula; (b) keep `workDir: string` always populated (gitDir when absent) and gate on `bare` or a new `hasWorkTree` boolean; (c) a discriminated union on a `kind` tag, one arm carrying `workDir` and one without | **(a)** | §3 enumerates four layout states, so (c)'s two-arm union cannot express "worktree-less but not bare" or "bare-flagged with an explicit work tree" without a third and fourth arm — at which point it is (a) with ceremony, and it churns every `ctx.layout.gitDir` read too. (b) is the footgun this design exists to remove: a `string` that must not be read is exactly what produces today's fabricated work tree, and the compiler cannot help. (a) turns every `layout.workDir` read into a type error that the §6 gate resolves by handing back the value, so the audit is mechanical rather than a reviewer's checklist. Cost: one type-level breaking change, called out in §10. |
| D2 | Error taxonomy for the work-tree gate (§6) | (a) two new codes `WORK_TREE_REQUIRED { operation }` + `WORK_TREE_CONFIG_INVALID { gitDir }`, keeping `BARE_REPOSITORY` for `reset --mixed`; (b) reuse `BARE_REPOSITORY` for everything (its detail already reads "requires a working tree"); (c) one new code carrying a `reason` discriminant of `'no-work-tree'` or `'bogus-config'` | **(a)** | git has three distinct fatal refusals on three distinct conditions (§1f) and tsgit's job is to make the conditions distinguishable. (b) collapses them and is measurably wrong: `reset --mixed` refuses on `is_bare_repository()` while `reset --hard` refuses on work-tree absence, and §1d shows those disagree. (c) survives `StringLiteral` mutants that distinct codes kill, and erases the difference between "this repo has no work tree" (normal) and "this config is self-contradictory" (a caller bug). Keeping `BARE_REPOSITORY` avoids removing a published code. |
| D3 | Where the Stage-2 config tokeniser lives (§5) | (a) relocate the pure tokeniser (`tokenizeConfig` / `parseIniSectionsFromTokens`) to `src/domain/config/`, imported by both `src/repository/` and the primitives tier; (b) leave it in `application/primitives/internal/` and let `src/repository/` import it; (c) hand-roll a minimal three-key parser inside `src/repository/` | **(a)** | (b) inverts the dependency rule (`repository → … → domain`, never `repository → application`) — the exact violation `find-layout.ts` was careful to avoid. (c) means two config grammars, and §1e's refusals (`bare = banana`, valueless `worktree`) then have to agree between them by inspection rather than by construction; the char-wise parser cost a whole design to get right. The functions are already pure (string in, tokens out, no `Context`), so (a) is a relocation with no behaviour change. |
| D4 | Scope of the work-tree gate sweep (§6) | (a) full sweep — repoint all 28 `assertNotBare` sites **and** add the 9 missing-or-conditional gate rows, in this PR; (b) repoint the existing 28 only, leave the ungated commands as-is; (c) gate at the facade (refuse every work-tree-touching command centrally on a static list) | **(a)** | (b) ships a library whose `status` and `stash list` operate on a work tree git says does not exist — the fabricated-work-tree defect, merely relocated; it also leaves the measured linked-worktree-of-bare inconsistency half-fixed (`add` corrected, `status` still ungated). (c) cannot express the conditional rows (`grep --cached`, `blame` in a bare repo, `describe --broken`, `reset --soft`, `diff --cached`), each of which is measured to *work* in git; a static list would refuse them all. The per-command gate is a one-line synchronous call at sites that already have a guard line. |
| D5 | `ceilingDirs` semantics (§1h, §8) | (a) `ReadonlyArray<string>`, absolute-only (refuse otherwise), realpath'd on node / lexical elsewhere, strict-ancestor rule; (b) same but silently ignore non-absolute entries, as git does; (c) accept a colon-joined string and replicate the `:`-prefix symlink toggle | **(a)** | (b) matches git byte-for-byte but only because git is parsing a *string* it cannot validate; an array argument can, and a silently-ignored argument is a bug report waiting to happen — a refusal at `validateOptions` is strictly more informative and cannot break a faithful caller. (c) imports env-string artefacts (colon splitting, the empty-entry symlink toggle) into an API that has no environment; per-entry control, if ever wanted, belongs in a richer entry type, not in punctuation. |
| D6 | Shape of the layout read surface (§7) | (a) `readonly layout: RepositoryLayout` on the facade (same frozen object as `ctx.layout`); (b) extend `revParse` with structural queries returning a union; (c) both | **(a)** | `revParse` is `(ctx, expression: string) => Promise<ObjectId>` with no options type — (b) forces a union return on every existing caller of a hot single-purpose resolver to expose data that is already synchronously available, and re-introduces the display-form question (`.` vs `.git` vs absolute) that ADR-249 says the caller owns. (c) is (b)'s cost with (a)'s benefit already paid. (a) also makes the reconstruction table testable without a Promise, and `ctx.layout` already carries the data so there is no second source of truth. |
| D7 | `is_git_directory`'s `HEAD` predicate now that any directory is a candidate (§1b) | (a) parse `HEAD`'s **content** — hex oid of either width, or `ref:` + a token beginning `refs/` — keeping today's following-`stat` for the symlink case; (b) keep today's narrowed "HEAD is a regular file" check (ADR-534); (c) full `validate_headref`, adding `readLink` to the `LayoutProbe` port so a symlink's *link text* is checked without following it | **(a)** | Refines ADR-534, whose reasoning ("a malformed HEAD is rejected later by the primitives tier") held when the `.git` *name* was required — the bait had to be deliberate. Now a directory holding three entries named `HEAD`, `objects`, `refs` shadows an enclosing repository (§1a), so (b) is both a faithfulness gap and a threat-model widening (§9). (a) is a pure parse needing no ref store, closes the security-relevant half (`HEAD` = `"garbage"` no longer qualifies), and gets the SHA-256 width for free (§1b 64-hex row) — the hash-width genericity check for this feature. It leaves **one** measured delta: a `HEAD` symlink whose target does not yet exist is accepted by git and rejected by tsgit, which (c) would close at the cost of widening `LayoutProbe` (ADR-535 deliberately kept it to `stat` + `readUtf8`) for a shape no git tool creates. Cost of (a) on the walk: on a level that holds a `HEAD` file the probe reads it instead of only stat'ing it — bounded by the existing 64 KiB cap, and unreached on levels without one. |
| D8 | Relative `core.worktree` resolution (§1c) | (a) physical — resolve against the gitDir, then canonicalise (realpath on node, lexical elsewhere), matching git's chdir/getcwd; (b) lexical `resolve(join(gitDir, value))` everywhere; (c) resolve against `cwd` | **(a)** | (c) is measurably wrong: `core.worktree = ../wt` with gitDir `$T/normal/.git` fails in git (`cannot chdir to '../wt'`) precisely because `$T/wt` — the cwd-relative answer — is *not* what git computes. (b) diverges on symlinked work trees (`core.worktree = ../../wt-link` yields the realpath `$T/wt2`) and reintroduces the ADR-537 mismatch where the adapter compares realpaths. (a) is ADR-537's established split applied to one more path. |
| D9 | Which config file(s) Stage 2 reads (§1e, §5) | (a) `<commonDir>/config` only; (b) `<commonDir>/config` **plus** `<gitDir>/config.worktree` when `extensions.worktreeConfig` is true; (c) reuse the command-tier `readConfig` pipeline once a provisional Context exists | **(b)** | Measured: with the extension on, git honours **both** `core.worktree` and `core.bare` from `config.worktree`, so (a) is a real divergence for a repo `git worktree` itself can produce. (b) costs one conditional second read of a file that usually does not exist. (c) is circular — the Context needs the layout the read is supposed to produce — and would couple `openRepository`'s failure modes to the per-Context config cache. Note (b) does **not** pull in the rest of `extensions.worktreeConfig` semantics (Out of scope). |
| D10 | Whether `init`/`clone` with `bare: true` relocate their own gitDir (§8, R10) | (a) no — they keep writing at `ctx.layout.gitDir`; the caller opens with `gitDir`/`bare` to get a bare-shaped Context (today's contract, now reachable); (b) yes — `init({ bare: true })` writes at `workDir` and returns a layout with `gitDir === workDir`; (c) refuse `init({ bare: true })` when the Context's layout is not already bare | **(a)** | (b) makes a command silently rewrite the layout its Context was built with, which is the one thing every other command is forbidden to do, and leaves `repo.layout` stale on the handle that just ran it. (a) keeps the layout decision in exactly one place (`openRepository`) and already produces byte-identical output to `git init --bare` (§1i) once the Context is constructible. (c) is a refusal for a shape that (a) makes legal and useful — `init({bare:true})` into a fresh directory opened non-bare is how you bootstrap before anything exists. |
| D11 | `opts.bare`'s relationship to `core.bare` (§2 Stage 3, §4) | (a) `opts.bare` overrides `core.bare` entirely (`true` ⇒ no default work tree, `false` ⇒ config value ignored); (b) `opts.bare` is a floor — `true` forces bare, `false` defers to `core.bare`; (c) refuse `opts.bare` together with a conflicting `core.bare` | **(a)** | git has no `--bare` setup flag to copy, so this is genuinely undetermined by the pin and the user must choose. (a) reads as "the argument tier wins over the config tier", which is the precedence every other row of §1c already follows (`opts.workDir` beats `core.worktree` and `core.bare`), and matches the browser shim's existing caller-supplied `bare`. (b) makes `bare: false` a no-op, which is an option that silently does nothing. (c) turns a caller override into an error and gives no way to open a `core.bare=true` repo non-barely without also passing `workDir`. |
| D12 | When the Stage-2 config refusals surface (§5, §1e) | (a) at `openRepository` — Stage 2 refuses a malformed `core.bare` / valueless `core.worktree` immediately; (b) at first command — Stage 2 treats a malformed value as absent for layout purposes and the existing `assertDiscoveryBooleansValid` refuses, preserving today's timing; (c) at open for `core.worktree` (which Stage 3 genuinely needs) and at first command for `core.bare` | **(a)** | git's setup and command are one invocation, and Stage 2 *is* git's setup — every observable git behaviour puts the refusal ahead of the command's work. (b) means the layout is silently resolved from a value the library is about to call invalid: with `core.bare = banana` a repo would resolve non-bare, hand out a work tree, and only then refuse — briefly reproducing the fabricated-work-tree defect this design removes. (c) splits one git rule across two tiers by value type. Cost of (a), stated so it is not a surprise: `config-boolean-interop.test.ts` X11/X12/X14 move their assertion from the command call to the `openRepository` call; the *codes and payloads they assert are unchanged*, and X12's ordering guarantee survives because open precedes first command. |

## Test strategy

### Unit — `test/unit/repository/find-layout.test.ts` (extended)

`MemoryFileSystem` + `portablePosixPolicy` and a stub `LayoutProbe`. Every §1a row, plus:

| case | expectation |
|---|---|
| cwd is a valid gitdir (HEAD + objects + refs) | `gitDir === cwd`, route `BARE_DIR`, no `workDir` |
| cwd is a valid gitdir **and** holds a valid `.git/` | the `.git` directory wins (§1a) |
| a valid gitdir one level up from cwd | resolves to the ancestor |
| a bare-shaped dir nested inside a work tree | shadows the enclosing repo |
| cwd has an invalid `.git/` and is itself a valid gitdir | the `.git` branch skips, the cwd branch resolves |
| a level with no `HEAD` | exactly one extra `stat` (the miss path, R12) — asserted through a counting probe |
| ceiling == strict ancestor / == cwd / below cwd / non-absolute | §1h rows |
| walk reaches the root with a ceiling set | `undefined` |

`HEAD` validation (D7-dependent) gets its own table with every §1b row, guards tested in
isolation: symlink-text branch, hex branch, `ref:` branch, and each rejection separately.

### Property — `test/unit/domain/config/head-ref.properties.test.ts`

If D7 lands (a), `parseHeadRef` is a total function over an algebraic grammar (lens 3) and
a matcher (lens 2):

- totality: never throws on arbitrary printable-ASCII content ≤ 4 KiB — 100 runs;
- `parseHeadRef('ref: ' + refname)` is valid for arbitrary refnames beginning `refs/` —
  200 runs;
- `parseHeadRef(hex(n))` is valid iff `n ∈ {40, 64}` — 200 runs, the hash-width lens.

Generators in the sibling `arbitraries.ts`; no committed seeds.

### Unit — layout resolution and options

- `test/unit/repository/resolve-layout.test.ts` (new): every §1c precedence row as an
  isolated case, each guard triggered independently (`opts.workDir` alone; `core.bare` alone;
  both `core.bare` and `core.worktree`; `core.worktree` alone absolute; relative; neither, on
  each of the three routes). The §1d formula gets its own four-row truth table. Plus the
  explicit-gitDir edges: a missing gitDir and an empty-directory gitDir both **resolve**
  (leniency, so `init` can bootstrap) while `assertRepository` on the resulting Context
  refuses; a gitDir naming a *file* resolves through the gitfile grammar and inherits its
  refusals; `opts.workDir` with no `gitDir` and no repository still returns the not-found
  fallback.
- `test/unit/repository/validate-options.test.ts` (extended): the four new validators,
  boundaries in isolated triples per the file's stated mutation-resistance directives.
- `test/unit/repository/layout-roots.test.ts` (extended): absent `workDir` ⇒ `[gitDir]`;
  explicit `workDir` disjoint from `gitDir` ⇒ both, never their ancestor.
- `test/unit/repository/read-repository-format.test.ts` (new): the §1e scope table
  (local honoured; `config.worktree` honoured under the extension; `include.path` **not**
  followed), the two value-grammar refusals, absent file ⇒ empty result, oversized file ⇒
  capped.

### Unit — the work-tree gate

`requireWorkTree` with a Context whose layout has (i) a work tree, (ii) none, (iii) none +
`workTreeConfigBogus` — asserting the returned path and each error's **payload**
(`operation`, `gitDir`), never the class alone. Then one test per swept command module
proving the gate fires, and one per **conditional** row proving it does **not** fire on the
open shape (`grep({ target: 'index' })`, `blame` without `worktree`, `blame` in a bare repo,
`describe({ broken: true })`, `reset({ mode: 'soft' })`, `reset({ mode: 'mixed' })` in a bare
repo → `BARE_REPOSITORY`, `diff({ cached: true })`).

### Integration — `test/integration/node-shim.test.ts` (extended)

Open a `git init --bare` directory by `cwd`; assert `repo.layout` and that the raw adapter
root set is `[gitDir]`. Open with explicit `gitDir` + `workDir` in disjoint subtrees; assert
both roots present and that a path between them is refused.

### Interop — `test/integration/bare-repo-custom-gitdir-interop.test.ts` (new)

`@proves` docblock (`surface: openRepository`, `bucket: cross-tool-interop`,
`interopSurface: layout`), `describe.skipIf(!GIT_AVAILABLE)`, one shared
`beforeAll(fn, 60_000)` per scenario group (the hook-timeout class), all git through
`interop-helpers.ts` (`GIT_*` scrubbed, isolated `HOME`, `GIT_CONFIG_NOSYSTEM`, signing
off), tmpdirs `realpath`-resolved, and a **fresh `openRepository` after any git-side write**
(the per-Context loose-object fanout cache is only invalidated by tsgit's own `writeObject`).
The layout oracle is `git rev-parse --path-format=absolute --git-dir --git-common-dir` plus
`--is-bare-repository`; the display forms of §1g are reconstructed in the test.

Two fixture hazards this suite must respect. **(1) Racy-clean is second-resolution.** Any
scenario that pins stat-clean vs stat-dirty status output (E, F) must let the mtime settle
more than one second after the last write before asserting, or the comparison reads
whichever side happened to lose the race — git's racy-clean guard has `USE_NSEC` off.
**(2) The interop helper sets `GIT_CEILING_DIRECTORIES = os.tmpdir()`**
(`interop-helpers.ts:59`), and §1h's strict-ancestor rule means a fixture placed *directly
at* `os.tmpdir()` would be excluded from git's own walk while tsgit (given no
`ceilingDirs`) would find it. Every fixture therefore lives at least one level below
`os.tmpdir()` — which `mkdtemp` already guarantees — and scenario L passes its ceilings to
**both** tools explicitly rather than relying on the ambient one.

| # | scenario | assertions |
|---|---|---|
| A | `git clone --bare`, tsgit opens by `cwd` | `layout.gitDir`/`commonDir`/`bare` match git; `log`, `revParse`, `catFile`, `branch.list`, `tag.list` agree with git |
| B | cwd = `<bare>/refs` (a sub-directory of the gitdir) | resolves the enclosing bare repo, same pair as A — the measured wrong-repo defect |
| C | cwd = `<normal>/.git` | `bare === false`, **no** `workDir`; `status`/`add` refuse while git prints `WT`; `log` works in both |
| D | explicit `gitDir` from an unrelated cwd, no `workDir` | work tree defaults to **cwd** (§1c R1c-5); `status` output matches `git --git-dir=… status --porcelain` |
| E | explicit `gitDir` + `workDir` against a bare repo | `bare === false`, `status` matches git's `D  a.txt` |
| F | `core.worktree` — absolute, relative, through a symlink, on each of the three routes | `layout.workDir` matches `git rev-parse --show-toplevel`; the relative-failure row co-refuses |
| G | `core.bare` + `core.worktree` together | tsgit throws `WORK_TREE_CONFIG_INVALID`; `tryRunGitWithExit` shows git's exit 128 and the `unable to set up work tree using invalid config` line; both still answer `--is-bare-repository` = `true` |
| H | the §1f refusal matrix, twinned | for every row: tsgit's code/`data` vs git's exit code and first stderr line, including the rows that must **not** refuse (`log`, `diff --cached`, `ls-files`, `grep --cached`, `blame`, `describe`, `reset --soft`, `archive`, `worktree list`) |
| I | `reset --mixed` in a bare repo | tsgit `BARE_REPOSITORY { operation: 'reset --mixed' }`; git exit 128 with the mixed-reset line; **and** `<bare>/index` is not created by either |
| J | round-trip write→read | tsgit `init({ bare: true })` / `clone({ bare: true })` → `git rev-parse --is-bare-repository` = `true`, `git log` reads it, config bytes match §1i; then `openRepository({ cwd })` reopens it |
| K | round-trip read→write | `git init --bare` → tsgit `fetch` into it and `push` into it; `git log` on the bare side sees the pushed commits; `git clone <bare>` of a tsgit-written bare repo produces a working clone |
| L | `ceilingDirs` | the §1h rows, each twinned against `GIT_CEILING_DIRECTORIES`, including the strict-ancestor no-op and the symlinked-ceiling row |
| M | `rev-parse` reconstruction | for each §1g cwd, reconstruct `--git-dir`, `--git-common-dir`, `--is-bare-repository`, `--is-inside-git-dir`, `--is-inside-work-tree`, `--show-toplevel`, `--show-prefix`, `--show-cdup` from `repo.layout` + `repo.ctx.cwd` and compare byte-for-byte |
| N | linked worktree of a bare repo | from inside it: `bare === false`, `gitDir` = `<bare>/worktrees/<n>`, `commonDir` = `<bare>`; `worktree.list` marks the **main** entry `bare: true`, matching `git worktree list --porcelain` |
| O | `config.worktree` under `extensions.worktreeConfig` (D9) | `core.worktree` and `core.bare` from `config.worktree` are honoured, matching git |
| P | value-grammar refusals | `core.bare = banana` and valueless `core.worktree`: co-refusal with git, tsgit naming the key in `data`; the tsgit side asserts at the D12-chosen moment |
| Q | explicit-gitDir edges | missing gitDir / empty-dir gitDir: tsgit resolves but `log` refuses while `init` **succeeds**, matching git's three rows; gitDir naming a regular file co-refuses with `invalid gitfile format`; `workDir` alone with no repository co-refuses |

Scenario H is the one that must be exhaustive: it is the only place the §1f matrix is
mechanically enforced rather than asserted by hand.

### Parity — `test/parity/`

The parity harness cannot express a bare layout without cross-driver surgery (measured
during planning: every dist-bundle driver seeds a fixed non-bare scenario shape), so the
cross-adapter proof is discharged in the unit tier instead: the bare layout wholly inside
`rootDir` is pinned by the `find-layout` / `resolve-layout` unit suites driving
`MemoryFileSystem` through the shared probe (route `BARE_DIR`), and the browser-shim unit
suite pins the fixed-entry bare resolution — same read assertions, adapter-independent by
construction since all three shims share `resolveLayout`/`finishLayout`. A parity-tier
scenario remains open as a possible follow-up if the harness ever grows per-scenario
layout shapes.

### Gates

Coverage per R14; app mutation budget on `repository/find-layout.ts`, the new
`resolve-layout` / `read-repository-format` modules, the relocated `domain/config`
tokeniser, `repository/validate-options.ts`, `repository/layout-roots.ts` and every touched
command; `test-pyramid-budgets.json` updated for the new interop file;
`check:write-surfaces` clean — the new file's `interopSurface: layout` key is what the audit
matches `@writes`-tagged modules against; `reports/api.json` regenerated (§10).

## Out of scope

- **Environment-variable layout overrides** — `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_COMMON_DIR`, `GIT_CEILING_DIRECTORIES` as *variables*. tsgit takes its layout from
  arguments; env-driven layout is a separate surface with its own security posture (and
  §9 shows the no-env rule is itself a mitigation). This design supersedes the
  bare-repo/`core.bare`/`core.worktree` half of
  [linked-worktree-discovery](linked-worktree-discovery.md)'s deferral and keeps the env half.
- **`safe.directory`-style ownership/trust gate** — §9 records the exposure this feature
  widens and the mitigation available today. The gate is a separate design; deliberately
  not smuggled in here, where it would be untestable against a git behaviour this design
  does not otherwise touch.
- **`extensions.worktreeConfig` semantics beyond the two layout keys** — D9 reads
  `core.bare` / `core.worktree` from `config.worktree` because git's layout setup does;
  per-worktree scoping of every *other* config key stays as the linked-worktree design
  left it (`internal/config-scope.ts:77`).
- **`core.repositoryformatversion` / `extensions.*` refusal** — pinned in §1b
  (`fatal: Expected git repo version <= 1, found 99`) but not implemented: it is a
  repository-acceptance gate orthogonal to layout, belonging with
  `assertDiscoveryBooleansValid`, and folding it in here would widen the blast radius to
  every existing repository fixture.
- **`git worktree` verbs against a bare main repo beyond what already works** — §1d row 4
  and scenario N fix the `bare` flag on the main entry (the linked-worktree design's last
  deferred bullet); `worktree lock`/`unlock`/`prune` stay deferred by
  [ADR-297](../adr/297-worktree-lock-read-only-verbs-deferred.md).
- **`clone --bare` / `--mirror` ref layout** — a bare clone's ref-writer policy is still
  the non-bare one (`clone.ts:219-253`); §1i pins git's actual shape (everything in
  `packed-refs`, no `fetch` refspec) but converging on it is the pre-existing
  `phase-12-1` deferral, not this feature. R10's round-trip proves the layout is
  *openable and operable* by both tools, which is what this design owes.
- **Linked-worktree discovery from inside an admin dir** (`cd .git/worktrees/<n>`) —
  §1g pins git's answer and §1a's algorithm produces it for free, but it is asserted only
  in scenario N's read direction; the write-surface implications are already covered by
  the linked-worktree sweep.
- **Any rendered output** — the layout, the refusals and every `rev-parse` display form
  are data (ADR-249); reconstruction lives in the interop test, never in the library.
- **Cross-volume (Windows multi-drive) `gitDir`/`workDir` pairs** — the documented
  ADR-495 limitation; §8's root set fails closed there rather than widening.
- **Refusal-shape residuals — CLOSED in this change** (were deferred, pulled back in at
  the user's direction): a RELATIVE `commondir` pointer with a missing INTERMEDIATE
  component now refuses hard on every route (git's `fatal: Invalid path`; an absolute
  pointer keeps the lexical resolution — its parent may lie outside a sandboxed
  adapter's containment root, where absence and denial are indistinguishable); a
  present-but-malformed gitdir now refuses `NOT_A_REPOSITORY` at the first command
  (`assertRepository` validates `HEAD` content, not just presence — `init` still
  bootstraps, it never runs the gate); and a `HEAD` symlink is judged by its LINK TEXT
  on adapters exposing the new optional `LayoutProbe.readLink` (node), dangling targets
  included — closing ADR-659's residual there and narrowing the divergence to sandboxed
  adapters, which cannot express symlinked `HEAD`s at all. The walk's miss-level cost
  becomes one extra `stat` plus, on `readLink`-capable adapters, one `readlink`.
