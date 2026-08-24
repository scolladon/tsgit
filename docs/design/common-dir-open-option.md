# Design — `commonDir` on `OpenRepositoryOptions`

Completing the explicit-layout-argument surface: after `gitDir` (git's
`--git-dir` / `GIT_DIR`), `workDir` (`--work-tree` / `GIT_WORK_TREE`) and
`ceilingDirs` (`GIT_CEILING_DIRECTORIES`), the one layout coordinate a caller
still cannot name is the **common dir** — git's `GIT_COMMON_DIR`.

## Context

### What exists today

The internal plumbing is already complete. `RepositoryLayout.commonDir`
(`src/ports/context.ts:52`) is public and deep-frozen on `repo.layout`;
`RepositoryLayoutInput.commonDir` (`src/repository.ts:211`) is its shim-facing
mirror; and **both** layout routes already resolve the on-disk `commondir`
**file** into it through one shared helper:

| route | site | call |
|---|---|---|
| discovery walk | `src/repository/find-layout.ts:214` (`layoutFor`) | `resolveCommonDir(probe, gitDir, pathPolicy)` then `sharedDirsValid(probe, commonDir, …)` |
| explicit `gitDir` | `src/repository/resolve-layout.ts:337` (`resolveExplicitOutcome`) | `resolveCommonDir(probe, gitDir, pathPolicy)`, **no** candidate validation |

Downstream, one accessor pair fans the value out to ~40 call sites —
`commonDirOf(layout)` / `commonGitDir(ctx)`
(`src/application/primitives/path-layout.ts:29,41`), both barrel-exported from
`src/application/primitives/index.ts:58` and reachable by users as
`@scolladon/tsgit/primitives`; `commonGitDir` is additionally bound on the
facade at `src/repository.ts:377`. They decide where objects, `packed-refs`,
`config`, shared refs and reflogs, `shallow`, `info/exclude`,
`info/attributes`, `hooks/`, the commit-graph, the midx and `worktrees/` are
read and written. `perWorktreeRefDir(ctx, name)` (`path-layout.ts:48`) splits
refs between `layout.gitDir` and the common dir using the pure predicate
`isPerWorktreeRef` (`src/domain/refs/per-worktree-ref.ts:29`).

`finishLayout` (`src/repository/resolve-layout.ts:250`) is the funnel: line 258
collapses `outcome.commonDir ?? outcome.gitDir` into one local, and that single
value feeds **both** the ownership-trust gate (line 262 →
`evaluateTrust(probe, outcome, commonDir, opts)`,
`src/repository/trust-verdict.ts:79`) and the repository-format read (line 267 →
`readRepositoryFormat(probe, gitDir, commonDir, pathPolicy)`,
`src/repository/read-repository-format.ts:471`, which reads `<commonDir>/config`).
Line 284 emits the field onto the layout, and `layoutRootsOf`
(`src/repository/layout-roots.ts:19`) folds it into the FS containment root set
consumed at `src/repository.ts:518` and `src/index.node.ts:80`.

### The gap

`OpenRepositoryOptions` (`src/repository.ts:84–192`) has `cwd`, `gitDir`,
`workDir`, `bare`, `ceilingDirs`, `algorithm`, `trust`, `trustedDirectories`,
`bareRepositories` — and **no `commonDir`**. The only way to open a repository
whose shared state lives elsewhere is to have an on-disk `commondir` file say
so. A caller who knows the split (a tool managing worktrees, a test harness, a
sandbox that materialises the two halves separately) cannot express it.

### What is NOT the gap

`commonGitDir` / `commonDirOf` are already public (shipped with the bare-repo
work) and are **not** redesigned here. The only export-surface change in scope
is a documentation nit: the `RepositoryLayout.commonDir` JSDoc
(`src/ports/context.ts:44–51`) says "both are exported" without saying **from
where**. It gains the `@scolladon/tsgit/primitives` pointer.

### Binding constraints

- **Prime directive** ([ADR-226](../adr/226-git-faithfulness-prime-directive.md)):
  match canonical git's observable data and on-disk state byte-for-byte. Every
  behaviour in §1 is measured against real `git`, never recalled — and §1f/§1g
  are precisely where recall would have been wrong.
- **Structured output** ([ADR-249](../adr/249-describe-structured-data-only.md)):
  the layout is data; git's fatal strings are pinned by reconstructing the
  *condition*, not the bytes of stderr.
- **Arguments, never environment.** `docs/understand/repository-layout.md`
  §"Deliberate divergences" states that `GIT_DIR`, `GIT_WORK_TREE`,
  `GIT_COMMON_DIR` and `GIT_CEILING_DIRECTORIES` are never read. That stays
  true: `commonDir` is an argument. What git's *env variable* does is the
  behavioural specification, not the input channel.
- **Argument-tier validation may be stricter than git's**
  ([ADR-657](../adr/657-ceiling-dirs-are-absolute-only-and-refused-otherwise.md)):
  a refusal on a typed argument is more informative than a silently dead one.
- Hexagonal dependency rule; branded types; no `any`; files < 800 lines;
  functions < 20 lines; kebab-case.

## Requirements

R1. `openRepository({ commonDir })` resolves a layout whose `commonDir`
coordinate is the caller's value, on **both** the discovery route and the
explicit-`gitDir` route, and on all three runtimes (node, memory, browser).

R2. The resolved value overrides any on-disk `<gitDir>/commondir` file (D3),
matching git's measured env precedence (§1a).

R3. Every consumer of the resolved common dir sees the override — objects,
`packed-refs`, shared refs and their reflogs, `config`, `shallow`,
`info/exclude`, `info/attributes`, `hooks/`, commit-graph, midx, `worktrees/` —
because they all route through `commonDirOf` / `commonGitDir` /
`perWorktreeRefDir`, which read the layout field. No call site is special-cased.

R4. Per-worktree state stays on `gitDir` under the override, exactly as it does
for a real linked worktree: `HEAD`, `index`, `logs/HEAD`, `config.worktree`,
`info/sparse-checkout`, the pseudo-refs, and `refs/bisect|worktree|rewritten/*`.
Pinned by §1e, whose 34-entry cross-checked subset classifies identically under
the override and under a real `commondir`-file split.

R5. The repository-format acceptance gate reads the **overridden**
`<commonDir>/config`: `core.repositoryformatversion`, `extensions.*`,
`extensions.objectFormat` (hash algorithm) and `extensions.refStorage` (ref
backend) all follow the override. Faithful — measured §1f row "config".

R6. On every route the ownership gate runs on, the predicate checks the
**overridden** common dir. It is already the third member of
`checkedPathsOf(repositoryPath, gitDir, commonDir)` (`trust-verdict.ts:63`);
overriding the value fed to `finishLayout` line 258 is sufficient, and no
exemption is granted for the fact that the caller named it — a caller-named
directory is still a directory whose `hooks/` this process will spawn. The
explicit-`gitDir` route is not one of those routes: `resolveTrustGate` sets
`gated = outcome.route !== 'EXPLICIT'` (`resolve-layout.ts:198`), matching git,
and this design does not change when the gate runs (§7 states the residual).

R7. The FS containment root set includes the overridden common dir.
`layoutRootsOf` already computes `[workDir, gitDir, commonDir ?? gitDir]`
minimised; the override widens the set to reach an unrelated subtree, and the
minimisation must keep all three roots in that shape (its doc comment already
anticipates it).

R8. `validateOptions` refuses an empty-string `commonDir` with
`INVALID_OPTION { option: 'commonDir', reason: 'must not be empty' }` — the
same shape `gitDir` and `workDir` already get (`validate-options.ts:64–72`).

R9. Existing repositories are byte-identical. With `commonDir` omitted, every
resolved path, every root set, every refusal and every reflog byte is unchanged.

R10. 100% line/branch/function/statement coverage on touched code inside the
coverage scope (`domain/`, `ports/`, `adapters/node/`, `adapters/memory/`,
`operators/` — `src/repository/` and `src/application/` are outside it);
mutation score within the app budget for every touched file (Stryker mutates all
of `src/`); every pinned row of §1 backed by an interop or unit assertion.

R11. `repo.layout.commonDir` reports the override, so
`git rev-parse --git-common-dir` remains reconstructible from the structured
layout by the caller.

## Design

### 1. Pinned matrix — canonical git **2.55.0**

All probes ran in a `mktemp -d` throwaway with isolated `HOME`,
`XDG_CONFIG_HOME`, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed from the
parent environment, and signing off. `$T` is the throwaway root. `--git-dir` /
`--git-common-dir` values are reproduced exactly as printed (git prints
relative forms unchanged — see §1b).

#### 1a. Precedence: `GIT_COMMON_DIR` vs the `commondir` file

Setup: `$T/main` a normal repo, `$T/wt` a linked worktree of it
(`$T/main/.git/worktrees/wt/commondir` = `../..\n`), `$T/alt` a valid copy of
`$T/main/.git`.

| cwd | env | `--git-dir` | `--git-common-dir` |
|---|---|---|---|
| `$T/wt` | — | `$T/main/.git/worktrees/wt` | `$T/main/.git` |
| `$T/wt` | `GIT_COMMON_DIR=$T/alt` | `$T/main/.git/worktrees/wt` | `$T/alt` |
| `$T/wt` | `GIT_DIR=$T/main/.git/worktrees/wt` `GIT_COMMON_DIR=$T/alt` | `$T/main/.git/worktrees/wt` | `$T/alt` |

**The environment wins over the file**, on both routes. (What "wins" means is
narrower than it looks — §1f.)

#### 1b. Relative-value resolution base

Explicit-`GIT_DIR` route (no discovery `chdir` to confuse the picture),
`$T/repo/alt-rel` a valid common dir:

| cwd | `GIT_COMMON_DIR` | result |
|---|---|---|
| `$T/repo` | `alt-rel` | `--git-common-dir` = `alt-rel` (accepted) |
| `$T/repo/sub` | `alt-rel` | `fatal: not a git repository: '$T/repo/.git'`, exit 128 |
| `$T/repo/sub` | `../alt-rel` | accepted, prints `../alt-rel` |
| `$T` | `repo/alt-rel` | accepted, prints `repo/alt-rel` |
| `$T` | `alt-rel` | `fatal: not a git repository: '$T/repo/.git'`, exit 128 |

**Base = the process cwd**, not the gitDir. Row 5 is the decisive one: relative
to the gitDir it would be `$T/repo/.git/alt-rel` (absent) — and relative to cwd
`$T/alt-rel` is also absent, so it fails; row 4 succeeds only because
`$T/repo/alt-rel` exists relative to **cwd**. git also does not normalise: the
value is echoed back verbatim, trailing slash included
(`GIT_COMMON_DIR=$T/r/.git/` → `--git-common-dir` prints `$T/r/.git/`).

On the **discovery** route the base is unstable in git — discovery validates
candidates from the original cwd, then `chdir`s to the discovered top level, so
a relative value can be validated against one directory and resolved against
another (measured from `$T/wt/sub`: `alt-rel` validated against `$T/wt/sub` but
reported as `../alt-rel`, i.e. `$T/wt/alt-rel`). That is a `chdir` artefact of
an env-string API; a typed argument has no reason to reproduce it (D2).

#### 1c. Route coverage

| repo shape | cwd | env | `--git-dir` | `--git-common-dir` |
|---|---|---|---|---|
| plain repo, discovery | `$T/plain` | — | `.git` | `.git` |
| plain repo, discovery | `$T/plain` | `GIT_COMMON_DIR=$T/plain-alt` | `.git` | `$T/plain-alt` |
| plain repo, discovery from subdir | `$T/plain/deep/deeper` | `GIT_COMMON_DIR=$T/plain-alt` | `$T/plain/.git` | `$T/plain-alt` |
| plain repo, explicit | `$T/plain` | `GIT_DIR=…` + `GIT_COMMON_DIR=…` | `$T/plain/.git` | `$T/plain-alt` |

Honoured on **both** routes, and a plain repository can be given a common dir it
never had.

#### 1d. Validity requirement and refusal shapes

The override participates in git's `is_git_directory` check. Requirement,
isolated by construction:

| `$T/cand` contains | verdict |
|---|---|
| nothing | refused |
| `objects/` only | refused |
| `refs/` only | refused |
| `objects/` + `refs/` | **accepted** (no `HEAD` needed in the common dir) |
| `objects/` + `refs/` + empty `HEAD` | accepted |
| symlink → a valid gitdir | accepted |
| a reftable-format gitdir (`git init --ref-format=reftable` still creates `objects/` + `refs/`) | accepted |

`<gitDir>/HEAD` must still exist — removing it refuses even with a perfect
common dir. So: **`HEAD` is validated at the gitDir; `objects/` + `refs/` at the
common dir.** That is exactly what `hasValidHead` + `sharedDirsValid`
(`find-layout.ts:209,215`) already implement.

Refusal shapes for an unusable value:

| condition | route | git stderr | exit |
|---|---|---|---|
| nonexistent dir | explicit `GIT_DIR` | `fatal: not a git repository: '<the GIT_DIR value>'` | 128 |
| file, not a dir | explicit `GIT_DIR` | `fatal: not a git repository: '<the GIT_DIR value>'` | 128 |
| existing dir lacking `objects`/`refs` | explicit `GIT_DIR` | `fatal: not a git repository: '<the GIT_DIR value>'` | 128 |
| empty string (`GIT_COMMON_DIR=`) | explicit `GIT_DIR` | `fatal: not a git repository: '<the GIT_DIR value>'` | 128 |
| any of the above | discovery | `fatal: not a git repository (or any of the parent directories): .git` | 128 |

Two things to carry: git **attributes the refusal to the gitDir**, never naming
the offending common dir; and an empty-string value is an *active* override
(the variable is set, merely to the empty string) that invalidates every candidate — it is not treated as
unset.

#### 1e. Per-worktree vs common split under the override

`git rev-parse --git-path <p>`, classified as `common` (resolves under the
common dir) or `per-worktree` (resolves under the gitDir), measured with
`GIT_DIR=$T/repo/.git GIT_COMMON_DIR=$T/alt`. A **34-entry subset** was measured
a second time from inside a **real** linked worktree (split from a `commondir`
file) and classified independently: `branches`, `common`, `remotes`, `rr-cache`,
`lost-found`, `svn`, `gc.pid`, `info/sparse-checkout`, `logs/refs/bisect`,
`logs/refs/worktree`, `logs/refs/rewritten`, `AUTO_MERGE`, `REBASE_HEAD`,
`MERGE_RR`, `MERGE_MODE`, `BISECT_EXPECTED_REV`, `next-index`, `QUILT_PATCHES`,
`modules`, `worktrees`, `objects`, `refs`, `config`, `config.worktree`,
`shallow`, `packed-refs`, `HEAD`, `index`, `logs`, `logs/HEAD`, `info`,
`info/exclude`, `info/attributes`, `hooks`.

**34/34 agree.** The override does not invent a split; it re-parameterises the
one git already has. The table below is the union of both runs.

| resolves to the **common dir** | resolves to the **gitDir** (per-worktree) |
|---|---|
| `objects`, `objects/pack`, `objects/info/alternates` | `HEAD`, `index`, `index.lock`, `ORIG_HEAD` |
| `refs`, `refs/heads`, `refs/heads/main`, `packed-refs` | `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `AUTO_MERGE` |
| `config`, `shallow`, `gc.pid` | `config.worktree`, `info/sparse-checkout` |
| `hooks`, `hooks/pre-commit` | `logs/HEAD`, `logs/refs/bisect`, `logs/refs/worktree`, `logs/refs/rewritten` |
| `info`, `info/exclude`, `info/attributes` | `refs/bisect/*`, `refs/worktree/*`, `refs/rewritten/*` |
| `logs`, `logs/refs/heads/main` | `BISECT_LOG`, `BISECT_START`, `BISECT_EXPECTED_REV` |
| `branches`, `remotes`, `rr-cache`, `lost-found`, `svn`, `common` | `rebase-merge`, `rebase-apply`, `sequencer`, `sequencer/todo` |
| `worktrees` | `COMMIT_EDITMSG`, `MERGE_MSG`, `SQUASH_MSG`, `MERGE_RR`, `MERGE_MODE` |
| | `FETCH_HEAD`, `modules`, `next-index`, `QUILT_PATCHES`, `gitdir`, `commondir` |

`info/sparse-checkout` per-worktree while the rest of `info/` is common, and
`logs/HEAD` per-worktree while the rest of `logs/` is common, are the two rows a
naive reading gets wrong. tsgit already gets both right.

#### 1f. **Which subsystems actually honour `GIT_COMMON_DIR`** (the surprise)

`--git-path` above says where git *reports* a path. Where git actually *reads
and writes* is not the same set. Three-way probe: a real linked worktree
`$T/lw` whose `commondir` file names `$T/m/.git`, opened with
`GIT_COMMON_DIR=$T/env3`.

| artefact | landed in | source of truth |
|---|---|---|
| loose object (`git hash-object -w`) | `$T/env3/objects` | **env** |
| local `config` write (`git config probe.three-way landed`) | `$T/env3/config` | **env** |
| `git branch three-way-probe` | `$T/m/.git/refs/heads/` | **the `commondir` file** |

Confirmed independently on a plain repo with `GIT_COMMON_DIR=$T/walt`
(`$T/walt` a copy of `$T/w/.git`):

| operation | gitdir `$T/w/.git` | common `$T/walt` |
|---|---|---|
| `git add` + `git commit` | objects unchanged (3) | objects 3 → 6 |
| ↳ `refs/heads/main` | **updated to the new commit** | left at the old commit |
| ↳ `logs/HEAD` | 1 → 2 lines | unchanged |
| ↳ `logs/refs/heads/main` | 1 → 2 lines | unchanged |
| `git branch new-branch` | `refs/heads/new-branch` created | not created |
| `git tag v1` | `refs/tags/v1` created | not created |
| `git pack-refs --all` | `packed-refs` created | not created |
| `git config --list --show-origin --local` | — | every key reads `file:$T/walt/config` |
| `shallow` placed only in the common dir | — | **honoured** (2 commits → 1) |
| `shallow` placed only in the gitdir | ignored | — |
| `info/exclude` placed only in the common dir | — | **honoured** |
| `info/exclude` placed only in the gitdir | ignored | — |
| `hooks/pre-commit` in both | not run | **run** |

Reads confirm the same asymmetry from the other side: a ref planted **only** in
the common dir is invisible to `for-each-ref` under the override, while a ref
planted **only** in the gitdir is listed by it.

Same on a **reftable** repository: `git branch rt-probe` under the override is
then visible with the override *removed*, so the new record went into the
gitdir's own stack, not the override's.

So, measured on git 2.55.0: **`GIT_COMMON_DIR` moves the object database,
`config`, `shallow`, `info/*` and `hooks/` — but not the ref store.** The ref
store derives its common dir from `<gitDir>/commondir` alone, which is why
`git rev-parse --git-path refs/heads/zz` reports `$T/env3/refs/heads/zz` while
`git branch` writes `$T/m/.git/refs/heads/…`. git's reported path and git's
actual write disagree under this variable.

This is the single most consequential row in the matrix, and it is a **decision**
(D1), not a fact to copy blindly: the brief's own test sketch ("ref updates land
in the overridden refs/packed-refs, proved against `GIT_COMMON_DIR=… git`")
cannot pass against real git as written. §6 rewrites that pin.

#### 1g. **The override suppresses `core.bare`** (the second surprise)

| repo | route | `core.bare` | env | `--is-bare-repository` | `--is-inside-work-tree` |
|---|---|---|---|---|---|
| plain | discovery | *(unset)* | — | `false` | `true` |
| plain | discovery | `true` (own config) | — | **`true`** | `false` |
| plain | discovery | `true` (either config) | `GIT_COMMON_DIR=$T/alt` | **`false`** | `true` |
| plain | explicit `GIT_DIR` | `true` | — | **`true`** | `false` |
| plain | explicit `GIT_DIR` | `true` (either config) | `GIT_COMMON_DIR=$T/alt` | **`false`** | `true` |
| plain | explicit `GIT_DIR` | `true` | `GIT_COMMON_DIR` **equal to** `GIT_DIR` | **`false`** | `true` |
| worktree of a bare repo | discovery | `true` (shared) | — | `false` | `true` |
| bare repo, **cwd-is-gitdir** | bare | `true` | — | `true` | `false` |
| bare repo, **cwd-is-gitdir** | bare | `true` | `GIT_COMMON_DIR=$T/balt` | `true` | `false` |
| bare repo, **cwd-is-gitdir** | bare | `true` | `GIT_COMMON_DIR` **equal to** cwd | `true` | `false` |
| bare repo, **cwd-is-gitdir** | bare | `false` | — | `false` | `false` |
| bare repo, **cwd-is-gitdir** | bare | `false` | `GIT_COMMON_DIR=$T/balt` | `false` | `false` |

Setting `GIT_COMMON_DIR` **at all** — even to a value identical to the gitDir —
makes git ignore `core.bare` and keep a work tree on the **discovery** and
**explicit-`GIT_DIR`** routes. It is the presence of the override, not a
difference between the two paths.

The **cwd-is-gitdir** route is the exception, and the last five rows isolate it:
the override changes nothing there — no work tree either way, and `bare` follows
`core.bare` alone. That is already tsgit's behaviour: `resolveWorkTree`'s
`BARE_DIR` case falls through to `{}` (no work tree) regardless, so the bypass
would be inert there even if applied.

Which work tree it keeps also matches tsgit's existing precedence rows exactly:
`--show-toplevel` was the **cwd** on the explicit route (`$T/elsewhere`, an
unrelated directory) and the **discovered top level** on the discovery route
(`$T/r`) — precisely what `resolveWorkTree`'s `EXPLICIT` and `DISCOVERED`
fall-through rows (`resolve-layout.ts:125–126`) already return once the
`core.bare` branch above them is bypassed.

tsgit encodes the equivalent rule as `isLinkedWorktreeAdmin`
(`resolve-layout.ts:72`): `outcome.route === 'DISCOVERED' && outcome.commonDir !== undefined`,
whose doc comment states "no measured row extends this bypass to an explicit
gitDir". **Row 5 above is that missing row.** Whether tsgit adopts it is D4;
whether a caller-supplied value equal to `gitDir` counts is D5.

#### 1h. `init` under the override produces an unopenable repository

`GIT_COMMON_DIR=$T/cd git init` in an empty `$T/fresh` exits **0** and prints
`Initialized empty Git repository in $T/fresh/.git/`, having written:

| location | contents |
|---|---|
| `$T/fresh/.git` | `HEAD`, `refs/heads`, `refs/tags` |
| `$T/cd` | `config`, `description`, `hooks/`, `info/`, `objects/` |

The common dir has `objects/` but no `refs/`; the gitdir has `refs/` but no
`objects/`. Every subsequent command fails — **with and without** the override:
`fatal: not a git repository (or any of the parent directories): .git`, exit
128. A nonexistent target directory is created and the outcome is identical.
`git clone` under the same override never reaches the question: it refused at
source resolution with `fatal: repository '$T/src' does not exist`, exit 128,
with `$T/src` present and valid.

git has no working "bootstrap into a split layout" behaviour to be faithful to.
This is the evidence behind D8.

#### 1i. Degenerate and cosmetic cases

| case | git |
|---|---|
| `GIT_COMMON_DIR` equal to `GIT_DIR` | accepted; both rev-parse forms report the same path; `core.bare` still suppressed (§1g) |
| trailing slash | preserved verbatim in `--git-common-dir` |
| symlink to a valid gitdir | accepted; reported as given (not resolved in the printed value) |
| `git worktree list` with an override whose target has no `worktrees/` | reports the **override** as the single main worktree and drops the real linked worktree |

### 2. Where the option enters

One public field, one validator, one internal options type, three shims — and
then the existing funnel does the rest.

```
OpenRepositoryOptions.commonDir            (src/repository.ts, after workDir @ L98)
  ├─ validateOptions                       (validate-options.ts: ValidatableOptions + validateCommonDir)
  └─ ExplicitLayoutOptions.commonDir       (resolve-layout.ts:21)
       ├─ node   : buildLayoutOptions      (index.node.ts:263)   → resolveNodeLayout → realpath @ L301
       ├─ memory : inline options literal  (index.default.ts:80-87)
       └─ browser: resolveFixedEntryLayout (fixed-entry-layout.ts:25 — signature change, D9)
             ↓
        resolveLayout (resolve-layout.ts:356)
             ├─ EXPLICIT : resolveExplicitOutcome — substitute for the file-derived value
             └─ DISCOVERED: findLayout / layoutFor — substitute BEFORE sharedDirsValid
             ↓
        finishLayout (resolve-layout.ts:250)
             ├─ L258 commonDir  →  resolveTrustGate → evaluateTrust     (R6)
             ├─ L258 commonDir  →  readRepositoryFormat(<commonDir>/config)  (R5)
             └─ L284 emit onto RepositoryLayoutInput.commonDir
             ↓
        layoutRootsOf → wrapFsValidator roots (repository.ts:518) + raw NodeFileSystem roots (index.node.ts:80)  (R7)
        commonDirOf / commonGitDir / perWorktreeRefDir → ~40 call sites  (R3, R4)
```

The insertion point is **the route functions, not `finishLayout`** (D7): the
discovery walk validates each candidate's shared dirs at the common dir
(`layoutFor` line 215), and only a substitution made *before* that check
reproduces §1d's "an unusable common dir invalidates the candidate". Both routes
then hand `finishLayout` an outcome that already carries the right value, and
every consumer downstream of line 258 is reached with **no further change**.

One coupling the substitution cannot carry on its own: under D5(a) the field is
omitted when the value equals `gitDir`, so `outcome.commonDir !== undefined` no
longer answers "did the caller supply one". If D4(a) is ratified,
`isLinkedWorktreeAdmin` needs that fact as a separate input — the smallest shape
is a `commonDirSupplied: true` marker carried beside the value (on the
`WalkOutcome`, or on `LayoutOverrides` alongside `bare`/`workDir`), read only by
`resolveWorktree` and never emitted onto the layout. If D4(b) is ratified,
nothing extra is needed.

### 3. Threading — the complete consumer list

| consumer | file:line | reached how | note |
|---|---|---|---|
| repository-format acceptance (`core.repositoryformatversion`, `extensions.*`) | `read-repository-format.ts:477` | `finishLayout:267` | the override changes which `config` gates the open (R5) |
| `objectFormat` (sha1/sha256) | `read-repository-format.ts:496–503` | same read | the override can change the repository's **hash width**; the declared value still meets `opts.algorithm` in `resolveAlgorithm` (`repository.ts:555`), so a contradicting pair keeps refusing with `OBJECT_FORMAT_CONFLICT` |
| `refStorage` (files/reftable) | `read-repository-format.ts:504–511` | same read | the override can change the **ref backend** |
| `core.bare` / `core.worktree` | `read-repository-format.ts:483–486` | same read | feeds `resolveWorkTree`; see D4 |
| ownership-trust predicate | `trust-verdict.ts:63,89` | `finishLayout:262` | 3rd member of the checked set (R6); **ungated on the EXPLICIT route** (`resolve-layout.ts:198`) |
| FS containment roots | `layout-roots.ts:23` → `repository.ts:518`, `index.node.ts:80` | layout field | R7; the security-critical widening (§7) |
| objects (loose read/write, packs, midx, commit-graph) | `object-resolver.ts:198`, `write-object.ts:38-39`, `has-object.ts:16`, `pack-registry.ts:507,523`, `resolve-oid-prefix.ts:38`, `enumerate-objects.ts:42`, `internal/loose-oid-cache.ts:43`, `internal/read-commit-graph.ts:185`, `fetch-pack.ts:170`, `fetch-missing.ts:58`, `pack-objects.ts:90` | `commonGitDir(ctx)` | R3 |
| shared refs + reflogs + `packed-refs` | `ref-store.ts:328,469,543,640,771`, `reftable-ref-store.ts:171,181,192`, `reftable-transaction.ts:1194-1200` | `commonGitDir` / `perWorktreeRefDir` | R3/R4 |
| `config` read + write | `config-read.ts:229`, `internal/config-scope.ts:59,84`, `update-config.ts:425,556` | `commonGitDir(ctx)` | R3 |
| `shallow` | `internal/shallow-set.ts:52`, `shallow-file.ts:49,88,102` | `commonGitDir(ctx)` | R3, §1f row |
| `info/exclude`, `info/attributes` | `internal/read-gitignore.ts:30`, `internal/read-gitattributes.ts:34` | `commonGitDir(ctx)` | R3, §1f rows |
| `hooks/` lookup | `run-hook.ts:36,38` | `commonDirOf(layout)` | R3, §1f row |
| `worktrees/` admin dirs | `worktree.ts:140,161,317,352`, `list-worktrees.ts:184` | `commonGitDir(ctx)` | R3 |
| derived worktree Context | `internal/worktree-context.ts:33,45` | writes `commonDir` on the child | unchanged; the child reads `commonGitDir(ctx)`, so it inherits the override — and `repo.worktree.add` under an override registers the new admin dir at `<override>/worktrees/<id>` and writes a `commondir` pointer back to the override |
| **presence-as-signal** | `list-worktrees.ts:106` (`if (ctx.layout.commonDir === undefined) return ctx.layout.bare;`) | layout field | D5 — an explicit value **equal to** `gitDir` would flip this branch unless normalised |
| **presence-as-signal** | `resolve-layout.ts:73` (`isLinkedWorktreeAdmin`) | outcome field | D4/D5 |

The two presence-as-signal sites are the only places where "the field is absent"
means something other than "it equals `gitDir`". They are why D5 exists.

### 4. Validation and refusal semantics

Three tiers, matching what the neighbouring options already do:

1. **`validateOptions`** — non-empty string, `INVALID_OPTION`
   (`{ option: 'commonDir', reason: 'must not be empty' }`). Not
   absolute-required: `gitDir` and `workDir` are not either, because relative
   values resolve against `cwd` (D2). This is where git's "empty string is an
   active, always-failing override" (§1d) becomes an informative refusal instead
   — the ADR-657 posture.
2. **Discovery route** — the substituted value goes through
   `sharedDirsValid(probe, commonDir, pathPolicy)` at `layoutFor:215` exactly as
   the file-derived value does. An unusable override therefore invalidates every
   candidate and the walk climbs past them, reproducing §1d's discovery row.
   Discovery then returns `undefined`, which the shims turn into the
   found-nothing bootstrap (D8) — so a read command throws `NOT_A_REPOSITORY`
   (git's condition) while `init`/`clone` would bootstrap. Whether that is
   acceptable is D6.
3. **Explicit-`gitDir` route** — stays lenient, as
   `resolveExplicitOutcome`'s doc comment already commits to: no candidate
   validation, refusals surface at first command through `assertRepository` and
   the primitives tier. This is an already-documented refusal-*shape* divergence
   (`docs/understand/repository-layout.md` §Deliberate divergences); the
   *condition* still matches git, only the moment and the message differ, per
   ADR-249.

`GITFILE_INVALID_FORMAT` is **not** reused: it names a malformed on-disk
pointer file, and an argument has no file to be malformed.

### 5. Canonicalisation

- **Node** realpaths the resolved `commonDir` already
  (`index.node.ts:301–302`), and the `canonical` flag folds it in (line 310).
  A caller-supplied value flows through the same call unchanged — necessary,
  because `NodeFileSystem` compares realpaths and an unresolved root spuriously
  denies (the macOS `/var` → `/private/var` class).
- **Memory / browser** stay lexical (`portablePosixPolicy`), the same
  sandboxed-adapter split `core.worktree` and `ceilingDirs` already follow.
- Relative values resolve through `resolveAgainst(cwd, value, pathPolicy)`
  (`resolve-layout.ts:85`) — the helper that exists precisely because
  `portablePosixPolicy.resolve` has no multi-arg "later absolute wins"
  semantics. Same call `gitDir` and `workDir` use.
- git preserves a trailing slash in its reported value (§1i); tsgit normalises,
  because `repo.layout` is data other paths are joined onto, not a display
  string. Documented as cosmetic-only under ADR-249.

### 6. Runtime shims

**Node** — `buildLayoutOptions` (`index.node.ts:258–270`) gains one spread; the
realpath pass and `layoutRootsOf` need no change.

**Memory** (`index.default.ts:80–87`) — one spread in the inline
`ExplicitLayoutOptions` literal, mirroring line 81's `gitDir`.

**Browser** — the browser never calls `resolveLayout`; it calls
`resolveFixedEntryLayout(fs, workDir, gitDir, bare?, explicitWorkDir?)`
(`fixed-entry-layout.ts:25`), which builds its own `WalkOutcome` at line 38 and
hard-wires `route: 'DISCOVERED'`. Two consequences: the parameter list is
already at its positional limit (D9), and a supplied `commonDir` that differs
from the entry **would** satisfy `isLinkedWorktreeAdmin` under today's
DISCOVERED-only rule, whatever D4 decides — so D4 and D9 must be answered
together.

**All three** are argument-only. No `EnvReader` is consulted; nothing sniffs
`GIT_COMMON_DIR`. `docs/understand/repository-layout.md`'s divergence paragraph
stays true as written and gains `commonDir` to the argument list.

### 7. Threat model

A caller-supplied `commonDir` is a **privilege-relevant argument**, in the same
class as `gitDir`. Naming it does three things at once:

1. **Widens the FS containment root set** (`layoutRootsOf` → `wrapFsValidator`
   + raw `NodeFileSystem`). Every path-taking FS call in the session may now
   reach that subtree. This is the same widening `gitDir` already grants, and it
   is bounded by the caller's own value — never by anything read off disk.
2. **Chooses which `config` is authoritative** — and therefore which
   `merge.<driver>.driver` shell commands, `core.excludesFile` reads,
   `core.worktree` (which can widen the root set *again*, up to `/`), hash
   algorithm and ref backend the repository runs with.
3. **Chooses which `hooks/` directory is spawned** with the caller's full
   environment (§1f: hook lookup follows the common dir, and the common hook
   wins even when a gitdir hook exists).

Mitigations, all pre-existing and all still reachable: the ownership predicate
checks the resolved common dir on non-explicit routes (R6); `hooks: false` and
`command: false` disable the two code-execution channels;
`trust`/`trustedDirectories` gate discovery.

The residual, stated explicitly: **on the explicit-`gitDir` route the ownership
gate is off** (`resolve-layout.ts:198`, matching git), so
`openRepository({ gitDir, commonDir })` against another user's directory is
accepted without an ownership check — exactly as `openRepository({ gitDir })`
already is. The option does not create this hole; it does add a second path
into it, and the JSDoc must say so with the same `WARNING:` framing `hooks` and
`unsafeRawAdapters` already use.

Non-goal: `commonDir` is **not** a sandbox. A caller that must not reach a
subtree must not be handed the ability to name it.

### 8. Public surface

- `OpenRepositoryOptions.commonDir?: string` — new public field, placed after
  `workDir` (`src/repository.ts:98`) so the three layout coordinates read
  together.
- `ExplicitLayoutOptions.commonDir?: string` (`@internal`, `resolve-layout.ts:21`).
- `ValidatableOptions.commonDir?: string` (module-private).
- `resolveFixedEntryLayout`'s signature (internal, one caller) — D9.
- **Doc nit (in scope):** `RepositoryLayout.commonDir`'s JSDoc
  (`src/ports/context.ts:44–51`) currently ends "…rather than reading this field
  directly — both are exported." It gains where from: importable as
  `import { commonGitDir, commonDirOf } from '@scolladon/tsgit/primitives'`,
  with `commonGitDir` also bound at `repo.primitives.commonGitDir`.

No new error code, no new command, no barrel change. Surface gates that still
apply: a new public field changes `reports/api.json`
(`npm run docs:json`, a **prepush** gate — regenerate in the same part), and the
docs pages listed in §9 gate `check:doc-coverage`/`docs-drift`.

### 9. Documentation touched

| page | change |
|---|---|
| `docs/understand/repository-layout.md` | `commonDir` in "The three routes" / "Reading the result"; the §1g bareness interaction as a new work-tree-precedence row; add `commonDir` to the arguments-not-environment paragraph under "Deliberate divergences" |
| `docs/get-started/node.md` | the `repo.layout` snippet and the explicit-layout example |
| `docs/get-started/memory.md`, `docs/get-started/browser.md` | option lists |
| `docs/use/primitives/internals.md` | `readRepositoryFormat` / `resolveLayout` entries: which config the override moves |
| `docs/understand/security.md` | §7's threat model line |

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | **Which git behaviour the argument models** — §1f measured that `GIT_COMMON_DIR` moves the ODB, `config`, `shallow`, `info/*` and `hooks/`, but **not** the ref store (which follows `<gitDir>/commondir` alone) | (a) **uniform** — the argument sets the layout's one `commonDir` coordinate and every consumer follows it, refs included (i.e. it behaves like the `commondir` *file*, which git honours uniformly); (b) **replicate the env split** — refs keep resolving against the file-derived common dir while objects/config follow the argument; (c) **refuse** `commonDir` when a `commondir` file is also present, so the two channels can never disagree | **(a)** | (b) means shipping an option that silently writes a commit's objects to one directory and its branch ref to another — git's own `--git-path` disagrees with git's own `git branch` under it, which is an internal inconsistency of an env-string API, not a contract worth porting. tsgit has one `commonDir` field and one accessor pair; splitting them re-creates the exact "objects invisible to the ref that names them" corruption [ADR-294](../adr/294-common-dir-layout-and-per-worktree-ref-rule.md) was written to prevent. (a) is also the behaviour of the *file*, which is the faithful, self-consistent half of git. Cost: the interop pin for ref placement must use a real linked worktree as the peer, not `GIT_COMMON_DIR=… git` (§6 test strategy) — this changes the brief's sketched test. (c) forbids the linked-worktree case, which is the most useful one. |
| D2 | **Relative-value resolution base** — git resolves against the **process cwd** (§1b), with a discovery-`chdir` artefact that makes validation and resolution disagree | (a) resolve against `cwd`, exactly like `gitDir`/`workDir` (`resolveAgainst(cwd, …)`); (b) absolute-only, refuse otherwise, like `ceilingDirs` (ADR-657); (c) resolve against the resolved `gitDir` | **(a)** | Matches git's measured base *and* the two sibling path options, so the three layout coordinates share one rule the JSDoc already states. (b) is defensible under ADR-657 but that precedent exists because `GIT_CEILING_DIRECTORIES` entries are *silently ignored* when relative — here relative values genuinely work in git, so refusing them would be strictly less capable. (c) is measurably wrong (§1b row 5). The `chdir` artefact is deliberately **not** reproduced: it is an accident of an env API, and a single stable base is the only sane contract for an argument. |
| D3 | **Precedence over an on-disk `commondir` file** | (a) the argument wins outright; (b) the file wins; (c) refuse when both are present and disagree | **(a)** | Pinned §1a: git's env beats the file. It is also the rule every other explicit layout argument already follows ("argument tier beats config tier", `finishLayout`'s own doc comment). (b) makes the option unusable in the one shape that most needs it — re-pointing a linked worktree at a relocated common dir. (c) turns a legitimate override into an error. |
| D4 | **Does a supplied `commonDir` suppress `core.bare`?** §1g: setting `GIT_COMMON_DIR` makes git ignore `core.bare` and keep a work tree, on **both** routes — the row `isLinkedWorktreeAdmin`'s doc comment says does not exist | (a) extend the bypass to `DISCOVERED` **and** `EXPLICIT`, matching §1g (the `BARE_DIR` route is measured unaffected, and is inert either way); (b) leave `isLinkedWorktreeAdmin` untouched — the argument never affects bareness; (c) extend on `DISCOVERED` only (the mechanical consequence of substituting into the outcome, with no code change at all) | **(a)** | It is measured on both of those routes, and the prime directive binds. It is also cheap and provably faithful: once the `core.bare` branch is bypassed, `resolveWorkTree`'s existing `EXPLICIT`→`cwd` and `DISCOVERED`→`origin` rows return exactly the work tree git's `--show-toplevel` reported (§1g). (c) is what falls out of doing nothing, which makes the bareness of an opened repository depend on whether the caller also passed `gitDir` — an invisible coupling nobody would predict. (b) is a knowing divergence with no upside. Implementation note: (a) cannot key on `outcome.commonDir !== undefined`, because D5 normalises the degenerate case away — it needs an explicit "the caller supplied one" flag (§2). Ratifying (a) also means updating `isLinkedWorktreeAdmin`'s doc comment, which currently asserts no such row exists. |
| D5 | **Degenerate `commonDir` equal to `gitDir`** — the codebase omits the field in that case (`find-layout.ts:221`, `resolve-layout.ts:341`), and two sites read absence as "not a linked worktree" (`list-worktrees.ts:106`, `isLinkedWorktreeAdmin`) | (a) normalise away — record nothing on the layout, but remember "supplied" separately for D4; (b) record it verbatim, changing `layout.commonDir` from absent to present for a normal repo; (c) refuse it with `INVALID_OPTION` as a caller mistake | **(a)** | R9 (existing repositories byte-identical) is only provable if the emitted layout for a normal repo is unchanged, and (b) silently flips `list-worktrees`' main-entry branch to the linked-worktree path for a repository that is not one. (c) is wrong on the measurement: git accepts the degenerate value and still applies §1g's bareness rule to it, so it is meaningful input, not a typo. (a) keeps the on-layout invariant ("present ⇒ differs from gitDir") intact while letting D4 see what the caller actually passed. |
| D6 | **Structural handling of an unusable value** (nonexistent / not a directory / missing `objects` or `refs`) | (a) route-appropriate: the discovery walk feeds the override to `sharedDirsValid` so candidates fail and the walk climbs (faithful to §1d), while the explicit route stays lenient as it already is for `gitDir`; (b) eager structural refusal on **both** routes with a dedicated code naming the common dir; (c) no structural check at all — first command fails with object/ref-level errors | **(a)** | (a) reproduces git's *condition* exactly on the route where git's condition is observable, and preserves the leniency that is the only reason `init`/`clone` can bootstrap on the explicit route. (b) is more informative but would need a bootstrap carve-out and would diverge from how the sibling `gitDir` argument already behaves, for a shape §1h shows git cannot bootstrap either. (c) discards a check the walk already performs for free. Accepted cost of (a), stated precisely: a typo'd `commonDir` on the discovery route makes discovery return `undefined`, so a read command throws `NOT_A_REPOSITORY` (git's condition, matched) but `init()`/`clone()` bootstrap a **new** repository at `{cwd}/.git` instead of refusing — the pre-existing found-nothing contract, now reachable by one more input. The JSDoc must say so. If that is judged too sharp an edge, (b) is the alternative that closes it, at the price of the bootstrap carve-out. |
| D7 | **Where the override is applied** | (a) in each route (`resolveExplicitOutcome` + `layoutFor`/`findLayout`), before candidate validation; (b) in `finishLayout`, as a `LayoutOverrides` field (one site, reaches trust + format read + emission); (c) in `resolveLayout`, rewriting the `WalkOutcome` between the route and `finishLayout` | **(a)** | Only (a) puts the value in front of `sharedDirsValid`, which D6(a) requires. (b) and (c) are each one line, but both let the walk validate the *file-derived* common dir and then swap in a different one afterwards — accepting a candidate on evidence that no longer applies. (a) costs one extra parameter on `findLayout` (which already carries an optional `ceilingDirs`) and on `layoutFor`, plus the substitution in `resolveExplicitOutcome`. |
| D8 | **The found-nothing bootstrap** (`syntheticFallbackLayout`, `resolve-layout.ts:215`) — discovery found no repository and `init`/`clone` will create one | (a) ignore `commonDir` on the bootstrap path, as it already ignores everything not in `{workDir, bare}`; (b) honour it, so `init` creates a split layout; (c) refuse the combination (`commonDir` + found-nothing) with `INVALID_OPTION` | **(a)** | §1h measured what git does here: `git init` under `GIT_COMMON_DIR` exits 0 and produces a repository **neither tool can reopen** (`refs/` in the gitdir, `objects/` in the common dir, both halves invalid). There is no faithful behaviour to copy, so (b) would be inventing one — and inventing a *silently broken* one. (a) matches the bootstrap's existing "reads nothing, trusts nothing" doctrine and leaves the door open for a designed `init`-into-a-split-layout surface later. (c) is more explicit but refuses a call that (a) can serve harmlessly (open, then `init` a normal repo at `cwd`), and it needs a new refusal condition to test and mutate for a case no caller has asked for. |
| D9 | **Browser shim plumbing** — `resolveFixedEntryLayout(fs, workDir, gitDir, bare?, explicitWorkDir?)` would take a 6th positional | (a) collapse the trailing positionals into one `overrides: { bare?, workDir?, commonDir? }` object; (b) add a 6th positional; (c) support `commonDir` on node + memory only, refuse it in the browser | **(a)** | Five positionals with three optional booleans/strings is already at the readability limit, and the object mirrors `LayoutOverrides`, which is what the parameters become downstream anyway. One internal caller (`index.browser.ts:70`) plus its unit tests. (b) makes the next option worse. (c) breaks the runtime-parity contract the brief names and would need a browser-only refusal code. |

## Test strategy

### Unit — `test/unit/repository/validate-options.test.ts` (extended)

`commonDir: ''` throws `INVALID_OPTION` asserting `.data.option === 'commonDir'`
**and** `.data.reason` (try/catch + direct `.data` assertions, not
`toThrow(Class)` — StringLiteral mutants survive type-only checks). `commonDir`
absent and a non-empty value both pass. The guard gets its own isolated `it`,
never shared with `gitDir`'s.

### Unit — `test/unit/repository/resolve-layout.test.ts` / `find-layout.test.ts` (extended)

`MemoryFileSystem` + `portablePosixPolicy` + the stub `LayoutProbe`:

| case | expectation |
|---|---|
| discovery + `commonDir` naming a valid dir | `layout.commonDir` = the override; the file-derived value is not used |
| discovery + `commonDir` naming a dir lacking `objects/` | candidate invalid, walk climbs (D6a) |
| discovery + `commonDir` naming a dir lacking `refs/` | same, as a **separate** test — `sharedDirsValid`'s two guards must be killed independently |
| explicit `gitDir` + `commonDir` naming a nonexistent dir | lenient: layout produced, refusal deferred |
| `commonDir` overriding a present `commondir` file (D3) | override wins |
| relative `commonDir` from a nested `cwd` (D2) | resolves against `cwd`, normalised |
| `commonDir` equal to `gitDir` (D5) | field omitted from the layout; D4's suppression still applies |
| `core.bare = true` + `commonDir`, `DISCOVERED` route (D4) | work tree = the discovered origin, `bare === false` |
| `core.bare = true` + `commonDir`, `EXPLICIT` route (D4) | work tree = `cwd`, `bare === false` — a **separate** test, since the two fall-through rows are distinct branches |
| `core.bare = true` + `commonDir`, `BARE_DIR` route (D4 scoping, §1g) | no work tree, `bare === true` — the override is inert here |
| `commonDir` absent (R9) | layout byte-identical to today's, asserted field-by-field |

### Unit — consumer conformance

- `layoutRootsOf` with an overridden `commonDir` in an unrelated subtree keeps
  all three roots; with `commonDir` under `workDir` it minimises (R7).
- `checkedPathsOf` order and dedup with the overridden value (R6).
- `readRepositoryFormat` reads `<override>/config` for
  `core.repositoryformatversion`, `extensions.objectFormat`,
  `extensions.refStorage` — one test per key, each asserting the *data*, so a
  sha1 gitdir + sha256 override resolves sha256 (R5).
- `perWorktreeRefDir` over the §1e split with an overridden layout — the
  existing table-driven test gains the override as a second fixture, proving the
  split is parameterised, not hard-coded.
- `list-worktrees`' main-entry derivation under an override (the D5
  presence-as-signal branch).

### Shim — `test/integration/node-shim.test.ts`, `test/unit/index.default.test.ts`, `test/unit/index.browser.test.ts`

Per runtime: open with `commonDir`, assert `repo.layout.commonDir`, and assert
the **raw adapter root set** contains it (the existing raw-adapter-root probe
pattern). Browser covers the D9 signature.

### Interop — `test/integration/common-dir-open-option-interop.test.ts` (new)

`@proves` docblock (`surface: openRepository`, `bucket: cross-tool-interop`,
`unique: caller-supplied common dir resolves and writes where canonical git's
split places it`, `interopSurface: layout`), `describe.skipIf(!GIT_AVAILABLE)`,
**one shared `beforeAll(fn, 60_000)` per scenario group**, all git through
`interop-helpers.ts` (`GIT_*` scrubbed, isolated `HOME`, `GIT_CONFIG_NOSYSTEM`,
signing off), tmpdirs `realpath`-resolved, and a **fresh `openRepository` after
every real-git write** — the per-`Context` loose-object fanout cache is
invalidated only by tsgit's own `writeObject`.

**The peer matters.** D1(a) means the ref-placement pin must compare against a
**real linked worktree** (whose split comes from a `commondir` file, which git
honours uniformly), *not* against `GIT_COMMON_DIR=… git` — §1f measured that
git's env override leaves refs in the gitdir, so the brief's sketched assertion
would fail against correct git. `GIT_COMMON_DIR` remains the peer for exactly
the surfaces git routes through it.

| # | scenario | peer | assertions |
|---|---|---|---|
| A | git-built linked worktree; tsgit opens the **worktree path** with an explicit `commonDir` naming the main `.git` | none needed | `layout.gitDir`/`commonDir` equal `git rev-parse --git-dir --git-common-dir` from the same cwd; `revParse('HEAD')`, `log`, `status` match |
| B | tsgit opens a **plain** repo with `commonDir` pointing at a second, valid gitdir; writes an object | `GIT_COMMON_DIR=… git hash-object -w` | tsgit's loose object lands under `<override>/objects` at the identical path and identical bytes; git with the same override reads it back (`git cat-file -p`) |
| C | tsgit `branch.create` / `tag.create` / `commit` / `packRefs` through the override | **real linked worktree** built by `git worktree add` (never `GIT_COMMON_DIR=… git` — §1f) | refs, reflogs and `packed-refs` land under `<commonDir>/refs`, `<commonDir>/logs/refs/**`, `<commonDir>/packed-refs`; `git -C main show-ref` sees them; `HEAD`, `index`, `logs/HEAD`, `ORIG_HEAD` land in `gitDir` and git agrees |
| D | `config.set` through the override | `GIT_COMMON_DIR=… git config --list --show-origin --local` | tsgit writes `<override>/config`; git reports the same origin file |
| E | `shallow`, `info/exclude`, `info/attributes`, hooks lookup | `GIT_COMMON_DIR=… git` (the surfaces git does route through the variable) | each artefact read/written at the override; a decoy copy in `gitDir` is **not** used, in both tools |
| F | acceptance gate + formats (R5) | `git rev-parse --show-object-format`, `--git-dir` exit codes | `core.repositoryformatversion = 99` in the override config refuses (git: `fatal: Expected git repo version <= 1, found 99`, exit 128); the same key in the gitdir config does **not** (git warns, exit 0); a sha256 override over a sha1 gitdir **resolves** sha256 in both tools — the assertion is the resolved format only, not that the mismatched pair is readable (git's own `log` there fails with `fatal: your current branch appears to be broken`) |
| G | bareness (D4, §1g) | `GIT_COMMON_DIR=… git rev-parse --is-bare-repository --is-inside-work-tree --show-toplevel` | with `core.bare = true` in either config and a `commonDir` supplied, both tools report not-bare / inside-work-tree on the **discovery** and **explicit** routes, with the same top level (discovered origin, resp. `cwd`); on the **cwd-is-gitdir** route both stay bare with no work tree |
| H | refusals (§1d) | `tryRunGitWithExit` | nonexistent / file-not-a-dir / `objects`-only / `refs`-only override: git exits 128 with the pinned condition; tsgit's discovery route finds nothing and its explicit route defers — asserted as the documented shape divergence, conditions co-pinned |
| I | the per-worktree/common split, reconstructed (R4) | `GIT_COMMON_DIR=… git rev-parse --git-path <p>` over the §1e entries | for every entry, the directory tsgit resolves equals git's reported one — §1e as test data, not prose |
| J | round-trip | — | tsgit opens with `commonDir`, writes a commit; `git -C <worktree>` (no override, real `commondir` file) reads the identical oid |

### Parity — `test/parity/`

A memory-adapter layout with an explicit `commonDir` wholly inside `rootDir`,
driven through the same read scenarios as node, proving the option is
adapter-independent. Parity is cross-adapter only and does **not** substitute
for the interop pins.

### Gates

Coverage per R10; app mutation budget on `resolve-layout.ts`,
`find-layout.ts`, `validate-options.ts`, `layout-roots.ts`,
`fixed-entry-layout.ts` and the three shims; `check:doc-coverage` and the
docs-drift bot for §9; `reports/api.json` regenerated (`npm run docs:json`) in
the same part as the new public field, since it is a **prepush** gate a
cached-green `validate` will not catch.

## Out of scope

- **Exporting `commonGitDir` / `commonDirOf`.** Public since the bare-repo work
  (`src/application/primitives/index.ts:58`, `src/repository.ts:377`). Only the
  JSDoc pointer changes (§8).
- **Reading `GIT_COMMON_DIR` (or any `GIT_*`) from the environment.** tsgit
  takes its layout from arguments; an env-driven layout is a separate surface
  with its own security posture, and `docs/understand/repository-layout.md`
  already records that as a deliberate divergence.
- **`init` / `clone` into a caller-specified split layout.** §1h measured that
  git itself produces an unopenable repository there; D8(a) ignores the option
  on the bootstrap path rather than inventing a shape. A designed split-init
  surface would be its own entry.
- **Replicating git's `--git-path`-reports-one-place / `git branch`-writes-another
  inconsistency** (§1f). D1(a) chooses the self-consistent half.
- **`git worktree list` reporting the override as the main worktree** (§1i last
  row) — a consequence of git's `worktrees/` enumeration following the override
  with no registry there. tsgit's `list-worktrees` derives the main path from
  the common dir the same way; the behaviour follows without a special case, and
  no additional refusal is designed for it.
- **Widening the ownership gate to the explicit route.** §7 states the residual;
  changing when the gate runs is ADR-territory of its own
  ([ADR-676](../adr/676-the-ownership-predicate-checks-the-superset.md),
  [ADR-699](../adr/699-the-checked-set-is-ordered-repository-path-first.md)).
- **`extensions.worktreeConfig` semantics** beyond the already-correct
  `<gitDir>/config.worktree` scope path, which §1e confirms is per-worktree.
