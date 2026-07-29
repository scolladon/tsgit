# Design — Linked-worktree discovery: open a repository whose `.git` is a gitdir pointer file

> Brief: `openRepository({ cwd })` inside a linked worktree throws `NOT_A_DIRECTORY` because discovery assumes `.git` is a directory. Resolve the `gitdir:` pointer file and the admin dir's `commondir`, split per-worktree from shared paths, and make every command faithful from inside a linked worktree.
> Status: draft → self-reviewed ×3 → accepted

## Context

### What exists today

Discovery is a **walk-up for a `.git` directory**, implemented twice:

- `src/index.node.ts` `discoverLayout` (L112–126) — the only one wired into
  production. Uses raw `node:fs/promises` deliberately: it must run *before* the
  bounded `NodeFileSystem` is constructed, because the bounded adapter would
  reject any path outside its root and the walk needs to climb above `cwd`.
- `src/repository/find-layout.ts` `findLayout` — the same algorithm over the
  `FileSystem` port + a `PathPolicy`. **Imported by nothing in `src/`**; its only
  consumer is `test/unit/repository/find-layout.test.ts`.

Both return `{ workDir, gitDir, bare: false }` and both gate on
`stat(candidate).isDirectory`. `test/unit/repository/find-layout.test.ts:84–103`
pins the current behaviour explicitly: *"Given a `.git` that exists but is a file
(not a directory — gitlink) … Then it does NOT return that layout (skips the
file)"*. The browser and memory shims do not discover at all — they hardcode
`{ workDir: '/', gitDir: '/<gitDirName>' }` and `{ workDir: '/repo', gitDir:
'/repo/.git' }` respectively.

### The substrate already landed

[ADR-294](../adr/294-common-dir-layout-and-per-worktree-ref-rule.md) added
`RepositoryLayout.commonDir?: string` plus two resolvers in
`src/application/primitives/path-layout.ts`:

```ts
export const commonGitDir = (ctx: Context): string => ctx.layout.commonDir ?? ctx.layout.gitDir;
export const perWorktreeRefDir = (ctx: Context, name: RefName): string =>
  isPerWorktreeRef(name) ? ctx.layout.gitDir : commonGitDir(ctx);
```

`isPerWorktreeRef` (`src/domain/refs/per-worktree-ref.ts`) ports git's
`is_per_worktree_ref` + pseudoref set. ADR-294 threaded `commonGitDir` through
the **read** layer only (objects, packed-refs, config read, `info/exclude`,
`info/attributes`, commit-graph, ref-store lookup, loose-oid cache) — because the
only consumer at the time was the *child* Context that `worktree add` /
`worktree remove` build internally, which is read-mostly.

[ADR-296](../adr/296-worktree-verbs-from-main-context-discovery-deferred.md)
explicitly deferred this feature and named it: *"`openRepository(<linked-worktree-path>)`
discovers the `.git` gitfile → admin dir → `commondir` at construction time."*
[ADR-298](../adr/298-worktree-fs-containment-escape.md) generalised
`wrapFsValidator` to accept an **array** of containment roots and added
`RuntimeFallback.makeWorktreeFs` — the machinery this design reuses.
[ADR-495](../adr/495-common-ancestor-cross-platform-path-model.md) made
`commonAncestor(paths, policy)` drive-letter/separator aware.

The writer side of the pointer files already exists in
`src/domain/worktree/admin-files.ts`: `WORKTREE_COMMONDIR = '../..'`,
`worktreeGitfile(absAdminDir) => 'gitdir: ' + absAdminDir`,
`worktreeGitdirPointer(absWorktreePath) => absWorktreePath + '/.git'`. tsgit
*writes* these (`worktree.ts` L163–169, each with a trailing `\n`) and cannot
read them back. There is **no parser**.

### Observed failure (measured, not assumed)

A throwaway integration probe on this branch (`openRepository` against a
git-built layout, tmpdir realpath-resolved, `GIT_*` scrubbed):

| cwd | tsgit result | git truth |
|---|---|---|
| linked worktree `wt/` | **throws** `TsgitError NOT_A_DIRECTORY`, `data.path = <wt>/.git/HEAD` | `HEAD = c3da967…` |
| submodule workdir `main/sub/` | **silently opens the superproject** — `getRepoRoot() = <main>`, `revParse('HEAD') = 3770d9a…` | `--git-dir = <main>/.git/modules/sub`, `HEAD = 25761b9…` |
| main worktree `main/` | correct | correct |

Two distinct symptoms from one root cause. The worktree case is loud; the
**submodule case is silent and wrong** — the walk-up skips the `.git` *file* and
finds the superproject's `.git` *directory* one level up. A consumer running
`openRepository` in a submodule working directory today gets the wrong
repository with no error.

### Binding constraints

- **Prime directive** ([ADR-226](../adr/226-git-faithfulness-prime-directive.md)):
  match canonical git's observable data and on-disk state byte-for-byte. Every
  behaviour below is pinned against real `git` (§1), never recalled.
- **Structured output** ([ADR-249](../adr/249-describe-structured-data-only.md)):
  no rendered strings; the layout is data.
- **Hexagonal dependency rule**: `repository → commands → primitives → domain`;
  `src/repository/` may `import type` from `adapters/node/path-policy.js` only
  (the precedent set by `find-layout.ts` and `common-ancestor.ts`).
- Branded types, no `any`, files < 800 lines, functions < 20 lines, kebab-case.

## Requirements

R1. `openRepository({ cwd })` anywhere inside a linked worktree (its root or any
sub-directory) returns a Repository whose `ctx.layout.gitDir` and
`ctx.layout.commonDir` equal, byte-for-byte, `git rev-parse --git-dir` and
`git rev-parse --git-common-dir` run from the same cwd.

R2. `openRepository({ cwd })` inside a **submodule working directory** opens the
submodule (relative `gitdir:` pointer, no `commondir` ⇒ `commonDir === gitDir`),
never the superproject.

R3. `openRepository({ cwd })` inside a `git init --separate-git-dir` working tree
resolves to the external gitdir with `commonDir === gitDir`.

R4. Read commands (`revParse`, `log`, `status`, `diff`, `show`, `branch.list`,
`tag.list`, `worktree.list`, `reflog`) return the same data as canonical git when
run from a linked worktree — including when the shared refs are **packed** and a
**commit-graph** is present, both of which live in the common dir.

R5. Write commands run from a linked worktree place every byte where git places
it: objects, `refs/heads|tags|remotes|stash`, their reflogs, `config`, `shallow`
in the **common dir**; `HEAD`, `index`, `ORIG_HEAD`, `MERGE_HEAD`,
`CHERRY_PICK_HEAD`, `REVERT_HEAD`, `REBASE_HEAD`, `FETCH_HEAD`, `sequencer/`,
`rebase-merge/`, `COMMIT_EDITMSG`, `logs/HEAD`, `refs/bisect|worktree|rewritten/*`,
`info/sparse-checkout`, `modules/` in the **worktree's own gitdir**.

R6. A malformed, path-less, or dangling `.git` **file** fails discovery with a
structured `TsgitError` and does **not** walk up to an enclosing repository.

R7. Existing repositories are byte-identical: for a normal repo and a main
worktree, `layout.commonDir` is **absent**, the containment root set collapses to
`[workDir]`, and every resolved path is unchanged.

R8. Filesystem containment is preserved: the adapter is widened to the
containment-minimised set of `{ workDir, gitDir, commonDir }` (ADR-298's
multi-root validator), never to the whole filesystem.

R9. Discovery has one implementation shared by every runtime shim that runs it —
no second copy.

R10. `worktree.list` from inside a linked worktree reports the main worktree
first, with the main worktree's own path (derived from the common dir), matching
`git worktree list --porcelain`.

R11. Sandboxed adapters (memory, browser) resolve pointers that stay inside their
root; a pointer escaping the sandbox fails discovery cleanly (a hard stop, never
a walk-up) under the probe's absence/containment-denial contract (§2).

R12. 100% line/branch/function/statement coverage on touched code inside the
coverage scope (`domain/`, `ports/`, `adapters/node/`, `adapters/memory/`,
`operators/` — `src/repository/` and `src/application/` are **outside** it);
mutation score within the app budget for every touched file, since Stryker
mutates all of `src/`; every pinned row in §1 backed by an interop assertion.

## Design

### 1. Pinned matrix — canonical git 2.55.0

All probes run in a `mktemp -d` throwaway with isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, every `GIT_*` scrubbed, signing off. `$T` is the
throwaway root.

#### 1a. On-disk shape produced by `git worktree add ../wt HEAD~1`

| file | exact bytes |
|---|---|
| `$T/wt/.git` | `gitdir: $T/main/.git/worktrees/wt\n` (absolute) |
| `$T/main/.git/worktrees/wt/commondir` | `../..\n` |
| `$T/main/.git/worktrees/wt/gitdir` | `$T/wt/.git\n` |
| admin dir contents | `commondir`, `gitdir`, `HEAD`, `index`, `logs/HEAD`, `ORIG_HEAD`, `refs` |

Identical to what `src/domain/worktree/admin-files.ts` already writes.

#### 1b. `git rev-parse` pairs

| cwd | `--git-dir` | `--git-common-dir` | `--show-toplevel` |
|---|---|---|---|
| `$T/wt` | `$T/main/.git/worktrees/wt` | `$T/main/.git` | `$T/wt` |
| `$T/wt/sub/dir` | `$T/main/.git/worktrees/wt` | `$T/main/.git` | `$T/wt` |
| `$T/main` | `.git` (relative) | `.git` | `$T/main` |
| `$T/separate` (separate-git-dir) | `$T/separate-dir` | `$T/separate-dir` | `$T/separate` |
| `$T/bare-wt` (worktree of a bare repo) | `$T/bare.git/worktrees/bare-wt` | `$T/bare.git` | `$T/bare-wt` |

#### 1c. Per-worktree vs shared split — `git rev-parse --git-path <p>` from `$T/wt`

This is the **authoritative** split. `A` = `$T/main/.git/worktrees/wt` (the
worktree's own gitdir), `C` = `$T/main/.git` (the common dir).

| resolves to `A` (per-worktree) | resolves to `C` (shared) |
|---|---|
| `HEAD`, `index`, `index.lock`, `ORIG_HEAD` | `objects`, `objects/pack`, `objects/info/commit-graph` |
| `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD` | `packed-refs`, `config`, `shallow` |
| `BISECT_HEAD`, `REBASE_HEAD`, `FETCH_HEAD`, `AUTO_MERGE` | `refs/heads/main`, `refs/tags/*`, `refs/remotes/*`, `refs/stash` |
| `COMMIT_EDITMSG`, `MERGE_MSG`, `SQUASH_MSG` | `logs/refs/heads/main` (and all `logs/refs/**`) |
| `rebase-merge`, `rebase-apply`, `sequencer` | `info/exclude`, `info/attributes` |
| `BISECT_LOG`, `BISECT_START`, `logs/HEAD` | `hooks/pre-commit` |
| `refs/bisect/*`, `refs/worktree/*`, `refs/rewritten/*` | `worktrees` |
| `config.worktree`, `info/sparse-checkout` | |
| `modules` (submodule gitdirs), `description` | |

Two rows contradict a naive "`info/` and `logs/` are shared" reading and are
therefore load-bearing: **`info/sparse-checkout` is per-worktree** while the rest
of `info/` is shared, and **`logs/HEAD` is per-worktree** while the rest of
`logs/` is shared. tsgit already gets both right.

`modules` being per-worktree is confirmed end-to-end: `git submodule add` run
from `$T/packed-wt` created `$T/packed/.git/worktrees/packed-wt/modules/sub` (not
`$T/packed/.git/modules/sub`) and wrote the relative gitfile
`gitdir: ../../packed/.git/worktrees/packed-wt/modules/sub`.

#### 1d. Where writes from inside a linked worktree land (end-to-end confirmation)

`git commit`, `git branch`, `git config --local`, `git stash` run from `$T/packed-wt`:

| artefact | landed in |
|---|---|
| new loose objects | `$T/packed/.git/objects` (`$T/packed/.git/worktrees/packed-wt/objects` never created) |
| `refs/heads/feature`, `refs/heads/wt-made-branch`, `refs/stash` | `$T/packed/.git/refs/…` |
| `logs/refs/heads/feature` | `$T/packed/.git/logs/…` |
| `config` key | `$T/packed/.git/config` (no admin `config`) |
| `logs/HEAD` | `$T/packed/.git/worktrees/packed-wt/logs/HEAD` |

#### 1e. Gitfile grammar (`<worktree>/.git`)

| input | git verdict |
|---|---|
| `gitdir: <abs>\n` | resolves to `<abs>` |
| `gitdir: ../main/.git/worktrees/wt\n` | resolves **relative to the directory containing the `.git` file** |
| `gitdir: <abs>` (no trailing newline) | resolves |
| `gitdir: <path>  \r\n` (trailing spaces) | parses; the path **keeps the spaces**, so the target is missing → `fatal: not a git repository` (only `\n`/`\r` are stripped) |
| `  gitdir: <path>\n` (leading whitespace) | `fatal: invalid gitfile format: <file>`, exit 128 |
| `gitdir:<path>\n` (no space) | `fatal: invalid gitfile format: <file>`, exit 128 |
| `gitdir: \n` (empty path) | `fatal: no path in gitfile: <file>`, exit 128 |
| `hello world\n` (arbitrary file named `.git`) | `fatal: invalid gitfile format: <file>`, exit 128 |
| `gitdir: <path>\nextra junk\n` | parses; the whole remainder (embedded newline included) is the path → target missing. git does **not** split at the first newline |
| `gitdir: /nonexistent\n` | `fatal: not a git repository`, exit 128 |
| `gitdir: <existing non-git dir>\n` | `fatal: not a git repository`, exit 128 |

Rule: require the exact 8-byte prefix `gitdir: `; strip trailing `\n`/`\r`
characters only; the remainder (length ≥ 1) is the path verbatim.

#### 1f. Commondir grammar (`<gitdir>/commondir`)

| input | git verdict |
|---|---|
| `../..\n` | resolved **relative to the gitdir** |
| `../..` (no trailing newline) | same |
| `<abs>\n` | used as-is |
| `../..  \n` (trailing spaces) | parses; spaces kept → resolved dir missing → fatal |
| `\n` / empty file | fatal (`invalid value` / `failed to read`) |
| **file absent** | `commonDir := gitDir` — and the dir is then only a valid repository if it holds `objects/` + `refs/` itself |

The last row is what makes a submodule gitdir (`.git/modules/<name>`) and a
`--separate-git-dir` gitdir valid, and what makes an admin dir with a deleted
`commondir` **invalid**: with `commondir` removed from
`$T/main/.git/worktrees/wt`, every command failed with `fatal: not a git
repository` because `<gitdir>/objects` does not exist.

#### 1g. Discovery-stop semantics (the asymmetry)

Measured inside `$T/outer` (a real repository) with a broken `$T/outer/inner/.git`:

| `inner/.git` | git behaviour |
|---|---|
| file, malformed | **hard stop**: `fatal: invalid gitfile format`, exit 128 — does **not** fall back to `$T/outer` |
| file, dangling target | **hard stop**: `fatal: not a git repository`, exit 128 |
| directory, missing `objects`/`refs` | **skipped**: walk continues, `--git-dir = $T/outer/.git`, `--show-toplevel = $T/outer` |

A `.git` *file* is a commitment; a `.git` *directory* is a candidate.

#### 1h. Main-worktree derivation

`git worktree list --porcelain` from `$T/packed-wt` lists `$T/packed` first, from `$T/separate-wt`
lists `$T/separate-dir` first, from `$T/bare-wt` lists `$T/bare.git` + `bare`. Rule:
main worktree path = the common dir with a trailing `/.git` stripped (no strip ⇒
the gitdir path itself, e.g. `bare.git`, `separate-dir`).

#### 1i. Hook environment from a linked worktree

A `post-commit` hook placed in the **common** `hooks/` dir fired on a commit made
in `$T/wt`, with `GIT_DIR=$T/main/.git/worktrees/wt` (the per-worktree gitdir),
`GIT_COMMON_DIR` unset, `PWD=$T/wt`. So: hook **lookup** is shared, hook
**`GIT_DIR`** is per-worktree — `run-hook.ts` L73 is already correct, L35/L37 are
not.

#### 1j. Worktree verbs run from inside a linked worktree

`git worktree remove .` executed **inside** the worktree it removes **succeeds**
(exit 0, no output; the cwd is simply gone afterwards). `git worktree add` from
inside a linked worktree places the new admin dir under the **common** dir
(`$T/packed/.git/worktrees/packed-wt2`) with the usual `commondir: ../..` (§1a). So the
existing verbs need **no new refusal** once discovery lands — they already route
through `commonGitDir(ctx)` (`worktree.ts` L147, L162, L307, L342).

### 2. Discovery flow

One algorithm, one implementation, expressed over a narrow probe surface so it
can run before any bounded adapter exists:

```
findLayout(probe, cwd, policy) -> RepositoryLayoutInput | undefined
  current := policy.resolve(cwd)
  loop:
    candidate := policy.join(current, '.git')
    st := probe.stat(candidate)            // follows symlinks; undefined when absent
    if st is directory:
      layout := layoutFor(probe, current, candidate, policy)
      if layout defined: return layout      // §1g: a directory is a candidate
    else if st is file:
      gitDir := resolvePointer(probe, candidate, current, policy)   // throws (§1g hard stop)
      layout := layoutFor(probe, current, gitDir, policy)
      if layout undefined: throw notARepository(current)
      return layout                         // §1g: a file is a commitment
    parent := policy.dirname(current)
    if parent === current: return undefined  // filesystem root
    current := parent

resolvePointer(probe, gitfilePath, baseDir, policy):
  raw := probe.readUtf8(gitfilePath)
  parsed := parseGitfilePointer(raw)                    // pure, §1e
  if parsed.kind === 'invalid-format': throw invalidGitfileFormat(gitfilePath)
  if parsed.kind === 'no-path':        throw gitfileNoPath(gitfilePath)
  return policy.isAbsolute(parsed.path)
    ? policy.resolve(parsed.path)
    : policy.resolve(policy.join(baseDir, parsed.path))

layoutFor(probe, workDir, gitDir, policy):
  commonDir := resolveCommonDir(probe, gitDir, policy)  // §1f
  if not isGitDirectory(probe, gitDir, commonDir): return undefined
  return { workDir, gitDir, bare: false, ...(commonDir !== gitDir ? { commonDir } : {}) }

resolveCommonDir(probe, gitDir, policy):
  p := policy.join(gitDir, 'commondir')
  raw := probe.readUtf8(p) or return gitDir              // absent ⇒ gitDir
  value := parseCommondir(raw)                           // pure, §1f
  if value.kind === 'empty': throw gitfileInvalidFormat(p)
  return policy.isAbsolute(value.path)
    ? policy.resolve(value.path)
    : policy.resolve(policy.join(gitDir, value.path))

isGitDirectory(probe, gitDir, commonDir):                 // git's is_git_directory
  probe.stat(gitDir + '/HEAD') is defined
  && probe.stat(commonDir + '/objects')?.isDirectory
  && probe.stat(commonDir + '/refs')?.isDirectory
```

`commonDir` is **omitted** when it equals `gitDir` — `exactOptionalPropertyTypes`
forbids `{ commonDir: undefined }`, and omission is what makes R7 mechanical
(`commonGitDir(ctx)` already falls back to `gitDir`).

Two properties of the pseudo-code are decision-dependent and must not be read as
settled: the `isGitDirectory` gate on the **directory** branch is D3, and the
hard `throw` on the **file** branch is D2.

`isGitDirectory` is a deliberate narrowing of git's version: git additionally
**parses** `HEAD`'s content, tsgit checks only that `HEAD` exists. Ref parsing
lives in the primitives tier and is unavailable at discovery time; the observable
gap is a `.git` directory holding a *malformed* `HEAD`, which tsgit accepts here
and `assertRepository` / `ref-store` then reject with their own structured error
rather than by silently walking up.

Module placement:

| module | contents | tier |
|---|---|---|
| `src/domain/worktree/gitfile.ts` | `parseGitfilePointer(content)` + `parseCommondir(content)` — pure grammar, no path algebra, discriminated-union results | domain |
| `src/repository/find-layout.ts` | `findLayout(probe, cwd, policy)` — the walk, path algebra, `isGitDirectory` | repository |
| `src/repository/file-system-layout-probe.ts` | `fileSystemLayoutProbe(fs: FileSystem): LayoutProbe` — adapts any `FileSystem` port; used by the memory/browser shims and by the unit tests | repository |
| `src/ports/layout-probe.ts` | `LayoutProbe { stat(path): Promise<{ isDirectory: boolean; isFile: boolean } \| undefined>; readUtf8(path): Promise<string \| undefined> }` | ports |

`LayoutProbe` contract: `undefined` means **the path is absent**. Any other I/O
failure propagates — nothing is swallowed. The one exception is inherited from
today's `find-layout.ts` and stays: a path-confined adapter (`MemoryFileSystem`
rejects outside `rootDir` with `PERMISSION_DENIED`) reports "absent" for a
candidate it cannot reach, which is what lets the walk terminate at the sandbox
boundary instead of exploding (R11). `fileSystemLayoutProbe` is where that
narrowing is implemented and tested, once.

`parseGitfilePointer` is the round-trip partner of the existing
`worktreeGitfile` — property-test lens 1 applies (§Test strategy).

Two behaviours are **deliberately unchanged** and must not be "fixed" during
implementation: discovery never sets `bare: true` (the caller supplies `bare`
explicitly — see Out of scope), and a `cwd` that does not yet exist still walks
up from its resolved form, so `openRepository` + `init`/`clone` on a
not-yet-created directory keeps working exactly as today (`index.node.ts` L52).

### 3. Layout shape, containment, and the shims

**`RepositoryLayoutInput`** (`src/repository.ts` L127–132) gains
`readonly commonDir?: string;`, mirroring `RepositoryLayout` (`ports/context.ts`
L33). `RuntimeFallback.layout` is typed as `RepositoryLayoutInput`, so the field
flows to `Context.layout` untouched.

**`src/repository.ts` L403** — today:

```ts
// The facade opens a main/normal repo (linked-worktree discovery is deferred,
// ADR-296), so its common dir is the gitDir.
const commonDir = fallback.layout.gitDir;
```

becomes `fallback.layout.commonDir ?? fallback.layout.gitDir` (comment retired).

**Containment (L383–394)** — the single-root wrap
`wrapFsValidator(detected.fs, fallback.layout.workDir, …)` becomes a multi-root
wrap over `layoutRoots = [workDir, gitDir, commonDir]`. ADR-298 already
generalised `wrapFsValidator` to `roots: string | ReadonlyArray<string>` with
"contained in **any** root".

`layoutRoots` is **minimised by containment** before it is handed over — any root
already contained in another is dropped. This is not cosmetic: `guard()` runs on
every path-taking FS call (a hot path), and for a normal repo the three entries
are `[/r, /r/.git, /r/.git]`, which would otherwise cost two extra prefix
comparisons per call forever. After minimisation a normal repo passes exactly
`[workDir]` and the guard is bit-identical to today (R7); a linked worktree
passes `[workDir, commonDir]` (the admin `gitDir` lives under `commonDir`), or
all three when a hand-written absolute `commondir` puts them in unrelated
subtrees.

The same `layoutRoots` is appended to the facade's `worktreeFs` roots
(`repository.ts` L406, today `[...paths, commonDir]`), so a worktree child
Context reaches the admin dir even in that unrelated-subtree case.

**`src/index.node.ts`** — the primary adapter root generalises to a **root
set** (ADR-541, revised during review from an earlier common-ancestor rooting):

```ts
const fs = new NodeFileSystem(layout.workDir);                                  // L62
```

becomes `new NodeFileSystem(layoutRootsOf(layout), nativePolicy)`. The adapter's
realpath containment is the ONLY symlink-aware gate — the facade's multi-root
validator above it is purely lexical — so the raw adapter must be confined to
exactly the layout roots, never their common ancestor (which would admit
everything between them, and for a cross-top-level layout degrades to the whole
filesystem). The first root stays the primary (relative-path base). A root that
does not yet exist contributes no canonical prefix and is re-probed until it
exists (`worktree add` probes its own not-yet-created target through this
adapter). For a normal repo the set collapses to `[workDir]` — unchanged.
`makeWorktreeFs` (L89–93) passes its full root list the same way.

Cross-volume worktrees on Windows remain the documented ADR-495 limitation
(the cross-volume root admits nothing after native resolution, so the operation
fails closed with `PATHSPEC_OUTSIDE_REPO` rather than silently reading the
wrong tree).

`discoverLayout` (L112–126) is deleted; the shim calls the shared `findLayout`
with a `LayoutProbe` backed by raw `node:fs/promises` (preserving the "before the
bounded FS" property that its comment already documents).

### 4. Per-worktree vs shared conformance — the write surface

ADR-294 threaded the read layer. With a Context whose `commonDir !== gitDir` now
reachable through the public facade, every remaining `ctx.layout.gitDir` site
becomes observable. Audited against §1c/§1d; `⇒ C` = must become
`commonGitDir(ctx)`, `⇒ P` = must become `perWorktreeRefDir(ctx, name)`.

| site | current expression | verdict |
|---|---|---|
| `primitives/write-object.ts:38,39` | `objectsDir(ctx.layout.gitDir, prefix)`, `looseObjectPath(ctx.layout.gitDir, computed)` | ⇒ C |
| `primitives/fetch-pack.ts:515` | `` `${ctx.layout.gitDir}/objects/pack` `` | ⇒ C (via `packsDir`) |
| `commands/fetch-missing.ts:56` | `looseObjectPath(ctx.layout.gitDir, id)` | ⇒ C |
| `primitives/update-config.ts:425,556` | `` `${ctx.layout.gitDir}/config` `` | ⇒ C — reads already use `commonGitDir` (`config-read.ts:157`), and `repo.config.*` writes already route through `resolveScopePath` (`config-scope.ts:72`, common). These two writers are the stale path used by `remote.{add,remove,rename,setUrl}`, `clone` and `submodule` |
| `primitives/shallow-file.ts:32,33` | `shallow`, `shallow.lock` | ⇒ C |
| `primitives/run-hook.ts:35,37` | hooks dir fallback | ⇒ C (L73 `GIT_DIR:` stays `gitDir` — §1i) |
| `commands/branch.ts:65` | `` `${ctx.layout.gitDir}/refs/heads` `` | ⇒ C |
| `commands/branch.ts:131` | `` `${ctx.layout.gitDir}/${name}` `` | ⇒ P |
| `commands/tag.ts:67,208` | `refs/tags` dir, ref probe | ⇒ C, ⇒ P |
| `commands/checkout.ts:91` | `` `${ctx.layout.gitDir}/${branchRef}` `` | ⇒ P (L134 `HEAD` write stays) |
| `commands/fetch.ts:297` | `` `${ctx.layout.gitDir}/${dir}` `` over `['refs/remotes/<remote>', 'refs/tags']` | ⇒ C |
| `commands/fetch.ts:384` | `` `${ctx.layout.gitDir}/${name}` `` (`readExistingRef`) | ⇒ P (`FETCH_HEAD` is per-worktree, `refs/remotes/*` shared) |
| `commands/fetch.ts:405` | `` `${ctx.layout.gitDir}/refs/remotes/${remoteName}` `` (`prune`) | ⇒ C |
| `primitives/enumerate-refs.ts:27` | `` `${ctx.layout.gitDir}/refs` `` | walk **both** `<commonDir>/refs` and `<gitDir>/refs`, deduped (the latter holds `refs/bisect|worktree|rewritten`); L14 `HEAD` stays |
| `primitives/stash-ref.ts:52` | `looseRefPath(ctx.layout.gitDir, STASH_REF)` | ⇒ C |
| `primitives/update-ref.ts:26` | `looseRefPath(ctx.layout.gitDir, name)` | ⇒ P (`ref-store.writeLoose`/`removeLoose` already use `perWorktreeRefDir`; only this direct path is stale) |
| `primitives/write-symbolic-ref.ts:35` | `looseRefPath(ctx.layout.gitDir, validatedName)` | ⇒ P |
| `primitives/reflog-store.ts:55` | `logsDir(ctx.layout.gitDir)` (`listReflogs`) | union of `logsDir(gitDir)` + `logsDir(commonDir)`, deduped when equal |
| `primitives/list-worktrees.ts:59` | `ctx.layout.workDir` as the main entry's path | derive from `commonDir` (§1h); `main` flag follows |
| `repository.ts:403` | `const commonDir = fallback.layout.gitDir` | `commonDir ?? gitDir`; `layoutRoots` feeds both the facade validator (L388–392) and `worktreeFs` (L406) |
| `index.node.ts:62` | `new NodeFileSystem(layout.workDir)` | root SET `layoutRootsOf(layout)` (§3, ADR-541); L89–93 `makeWorktreeFs` passes its root list the same way |

Already correct, **no change** (each pinned per-worktree in §1c): `read-index.ts:21`,
`internal/index-lock.ts:48,49`, `caching-index-resolver.ts:142`,
`read-sparse-checkout.ts:34`, `write-sparse-checkout.ts:21,22`,
`internal/repo-state.ts:46,120,172`, `internal/merge-state.ts:19–21`,
`internal/cherry-pick-state.ts:12`, `internal/revert-state.ts:17`,
`internal/rebase-state.ts:96,98`, `internal/sequencer-state.ts:40`,
`internal/commit-hooks.ts:39`, `snapshot/snapshot-factory.ts:87` (pseudo-refs
only), `apply-textconv.ts:28,34`, `sign-payload.ts:75,92,99`,
`commands/submodule.ts:313` + `internal/submodule-context.ts:16,50` (`modules/`
is per-worktree — pinned in §1c), `checkout.ts:134`, `commit.ts:233`,
`walk-submodules.ts:49,76`.

`clone.ts` and `init.ts`/`internal/bootstrap.ts` keep `gitDir`: both create a
fresh repository where `commonDir === gitDir`. Called against an already-open
linked-worktree Context, `init.ts:29` finds `<adminDir>/HEAD` and throws
`alreadyInitialized` — git likewise reports a re-initialisation rather than
building a nested repo. No change, documented here so the audit is complete.

### 5. Error semantics

git's messages are stdout/stderr rendering; per ADR-249 tsgit ships structured
data and the interop test reconstructs git's line. The refusal **conditions** and
exit-equivalence are what must match.

| condition | git | tsgit |
|---|---|---|
| `.git` file lacks the `gitdir: ` prefix | `fatal: invalid gitfile format: <file>` (128) | `GITFILE_INVALID_FORMAT { path }` |
| `.git` file has the prefix but no path | `fatal: no path in gitfile: <file>` (128) | `GITFILE_NO_PATH { path }` |
| `commondir` present but empty after CR/LF strip | fatal | `GITFILE_INVALID_FORMAT { path }` (the `commondir` path) |
| pointer target missing / not a git dir | `fatal: not a git repository` (128) | existing `NOT_A_REPOSITORY { path }` (the *worktree* path — the thing the caller named) |
| `.git` directory that is not a valid git dir | skipped, walk continues | skipped, walk continues *(D3-dependent)* |
| nothing found up to the root | `fatal: not a git repository` | `undefined` ⇒ facade's existing init/clone fallback (unchanged) |

New codes live in `src/domain/worktree/error.ts` next to the existing
`WorktreeError` union, and are added to the exhaustive `switch` in
`src/domain/error.ts`. Both carry `path` so tests assert data, not just the class
(mutation-resistant per CLAUDE.md), and each guard gets its own isolated test.

### 6. Path canonicalisation

- Every resolved path is **normalised** (no `.`/`..`/empty segments) before it
  reaches any FS call. `wrapFsValidator`'s `hasDotDotSegment` rejects `..`
  outright, so `gitdir: ../main/.git/worktrees/wt` **must** be collapsed at
  resolution time or every subsequent read fails. `policy.resolve` does this and
  is drive-letter/UNC aware (ADR-495).
- git additionally passes the common dir through `real_path`. The node adapter
  confines by realpath and `index.node.ts` already realpaths `cwd` (L52), so the
  node shim realpaths `gitDir` and `commonDir` too; sandboxed adapters (no
  realpath) stay lexical. Without this, a symlinked main repo yields a
  `commonAncestor` computed on unresolved paths while `NodeFileSystem` compares
  resolved ones — a spurious `PERMISSION_DENIED`.
- `stat` (not `lstat`) is used for the `.git` probe, so a `.git` symlink to a
  real gitdir behaves as a directory, matching git.

### 7. Adapter implications

**Node.** As §3. The `LayoutProbe` is backed by raw `node:fs/promises`; nothing
is ever read through it beyond `<dir>/.git`, `<gitdir>/commondir` and three
existence checks.

**Memory.** `index.default.ts` hardcodes `{ workDir: '/repo', gitDir: '/repo/.git' }`
and never discovers. Running the shared `findLayout` there lets parity fixtures
seed a worktree-shaped tree and open it — the layout must stay **inside**
`rootDir` (`/repo`), so a memory-adapter worktree lives at e.g. `/repo/wt` with
its admin dir at `/repo/.git/worktrees/wt`. A pointer resolving outside `/repo`
reads as "absent" through the `LayoutProbe` contract (§2, ADR-535), so
discovery hard-stops with `NOT_A_REPOSITORY` naming the worktree dir — never a
walk-up. Post-open operations through the bounded adapter surface its own
`PERMISSION_DENIED` as before; the two layers answer at different times by
design.

**Browser.** OPFS is rooted at `/` with `ROOT_WORK_DIR = '/'`; a walk-up is
meaningless (`dirname('/') === '/'` terminates immediately) and `gitDirName` is
configurable. The browser shim therefore does **not** walk: it resolves
`/{gitDirName}` and, when that entry is a *file*, applies the same pointer +
`commondir` resolution. `worktreeFs` is absent there (ADR-298), so worktrees stay
under the OPFS root.

### 8. Public surface

`RepositoryLayout.commonDir` is already public and documented (`ports/index.ts`
re-exports `RepositoryLayout`). `RepositoryLayoutInput` (`@internal`) gains the
same optional field. `LayoutProbe` stays **internal** — imported directly by
`find-layout.ts` and the three shims, not added to the `ports/index.ts` barrel —
so it does not enlarge the published type surface; knip is satisfied because the
export is consumed inside `src/`.

Any resulting `reports/api.json` delta must be regenerated and committed
(`check:doc-typedoc` is a pre-push gate, and a cached-green `validate` can still
precede a red prepush — regenerate before pushing).

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | Scope of the per-worktree/shared conformance sweep (§4) | (a) full sweep — discovery **plus** every ⇒C/⇒P site, in this PR; (b) discovery + read surface only, and refuse mutating commands when `commonDir !== gitDir`; (c) discovery only, document the write divergence | **(a)** | A partial split is a silent-corruption trap, not a partial feature: `repo.commit()` from a worktree would write objects into `<admin>/objects/` that no git and no other worktree can see. (b) ships a library that can read but not work in the environment the brief targets, **and** a blanket "refuse when `commonDir !== gitDir`" would break `worktree add`'s own materialise step, which legitimately writes the index and working tree through exactly such a child Context. The sweep is ~20 one-line call-site changes over helpers that already exist. |
| D2 | Discovery-stop semantics for an unusable `.git` **file** (§1g) | (a) hard stop with a structured error, never walk up; (b) skip and continue the walk (today's behaviour for non-directories); (c) hard stop only on a dangling target, skip on a format error | **(a)** | Pinned: git hard-stops on both, even with a valid repository one level up. (b) is exactly the bug that silently opens the superproject from a submodule dir. (c) splits one git rule into two for no gain. |
| D3 | Validate candidate git dirs with git's `is_git_directory` (§2) | (a) apply to **both** branches (file and directory); (b) apply to the file branch only; (c) no validation (today) | **(a)** | Pinned §1g row 3: git skips an invalid `.git` *directory* and keeps walking; tsgit accepts it and opens a broken repo. (a) closes that divergence with the same predicate the file branch needs anyway. Cost: two extra `stat`s, only on the one level that actually has a `.git`. Note it changes `find-layout.test.ts:13–27`, whose fixture is a bare `mkdir /repo/.git`. |
| D4 | How the one discovery implementation reaches the filesystem (R9) | (a) `findLayout(fs: FileSystem, …)`, node shim builds a temporary root-rooted `NodeFileSystem` for discovery; (b) new narrow `LayoutProbe` port (`stat` + `readUtf8`), each shim supplies it; (c) keep the two copies and port the logic twice | **(b)** | (a) constructs a `/`-rooted adapter — a real, if brief, containment widening for a code path that needs three methods. (b) keeps the trusted surface minimal and preserves the "runs before the bounded FS exists" property the shim comment already documents. (c) is the status quo that let the two copies drift. |
| D5 | Where the pointer/`commondir` grammar lives (§2) | (a) pure parsers in `src/domain/worktree/gitfile.ts`, path algebra + I/O in `src/repository/find-layout.ts`; (b) everything in `src/repository/find-layout.ts`; (c) a new `application/primitives/` module | **(a)** | Puts the parser beside its existing serializer (`admin-files.ts`), which is what makes the round-trip property test possible, and keeps `repository/` free of byte-grammar. (c) violates the dependency rule — discovery runs before any `Context` exists. |
| D6 | Canonicalisation of the resolved `gitDir`/`commonDir` (§6) | (a) `realpath` on adapters that expose it (node), lexical `resolve` elsewhere; (b) always lexical; (c) always `realpath` | **(a)** | git `real_path`s the common dir, and `NodeFileSystem` compares realpaths — (b) breaks symlinked repos (the macOS `/var`→`/private/var` case the existing interop tests already work around). (c) cannot work on memory/browser, which have no realpath. |
| D7 | Which shims run discovery (§7, R11) | (a) all three (node, memory, browser) run the same walk; (b) node + memory walk; browser resolves its fixed `/{gitDirName}` entry (pointer-aware, no walk); (c) node only | **(b)** | A walk-up in OPFS terminates at `/` on the first iteration — running it is dead code with a live cost. Memory needs real discovery so cross-adapter parity can cover the layout. (c) leaves the memory adapter unable to express the layout at all, so parity coverage would be node-only. |
| D8 | Error taxonomy for gitfile/`commondir` failures (§5) | (a) one code with a `reason: 'format' \| 'no-path'` discriminant; (b) two codes, `GITFILE_INVALID_FORMAT` and `GITFILE_NO_PATH`; (c) reuse `NOT_A_REPOSITORY` for everything | **(b)** | Mirrors git's two distinct refusals, and distinct codes kill `StringLiteral` mutants that a shared code with a string field survives. (c) erases the difference between "this file is not a gitfile" and "this gitfile points nowhere" — the first is a caller bug, the second is a stale worktree. |
| D9 | `worktree.list` main-entry path (§1h, R10) | (a) always derive from `commonDir` (strip a trailing `/.git`); (b) keep `ctx.layout.workDir` (today); (c) derive from `commonDir` only when `commonDir !== gitDir` | **(a)** | (a) is a provable no-op for every existing case — normal repo `/r/.git` → `/r` = `workDir`; bare `/x/bare.git` has no `/.git` suffix → unchanged — and is the only option that reports the *main* worktree when opened from a linked one. (c) is behaviourally identical to (a) with an extra branch to test and mutate. |

## Test strategy

### Unit — `test/unit/domain/worktree/gitfile.test.ts`

Every row of §1e and §1f as an example test, asserting the discriminated-union
variant **and** its payload: prefix present/absent, leading whitespace, missing
space, empty path, trailing `\r\n`, trailing spaces preserved, embedded newline
preserved in the path, no-trailing-newline. Guard clauses tested in isolation
(prefix check and length check separately) per CLAUDE.md.

### Property — `test/unit/domain/worktree/gitfile.properties.test.ts`

Lens 1 (round-trip pair) and lens 3 (total function over a grammar) both fire:

- `parseGitfilePointer(worktreeGitfile(p) + '\n') ≡ { kind: 'ok', path: p }` for
  arbitrary non-empty paths free of `\r`/`\n` — 200 runs.
- `parseCommondir(v + '\n') ≡ { kind: 'ok', path: v }` on the same family — 200 runs.
- Totality: `parseGitfilePointer` returns a variant (never throws) for arbitrary
  printable-ASCII content — 100 runs.

Generators in a shared `arbitraries.ts` beside them; no committed seeds.

### Unit — `test/unit/repository/find-layout.test.ts` (extended)

`MemoryFileSystem` + `posixPolicy`, plus a stub `LayoutProbe`:

| case | expectation |
|---|---|
| `.git` directory with `objects`+`refs`+`HEAD` | `{ workDir, gitDir }`, no `commonDir` |
| `.git` directory missing `objects` | skipped, walk continues (D3) |
| `.git` file, absolute pointer, admin dir with `commondir: ../..` | `commonDir` set, `gitDir` = admin dir |
| `.git` file, **relative** pointer | resolved against the directory holding the file, normalised (no `..` survives) |
| `.git` file, no `commondir` in target (submodule / separate-git-dir) | `commonDir` omitted |
| `.git` file, `commondir` absolute | used verbatim |
| `.git` file, malformed / no-path / dangling, **with a valid repo one level up** | throws; the outer repo is **not** returned (D2) |
| `.git` file, target exists but lacks `objects`/`refs` | `NOT_A_REPOSITORY` |
| walk from a sub-directory of a worktree | same layout as from its root |
| nothing found up to root | `undefined` |

Existing tests at L13–27 and L84–103 are updated (not deleted): the first gains
`objects`/`refs`/`HEAD`, the second inverts from "skips the file" to "resolves the
pointer". The throwing-adapter test at L62–82 moves to a new
`test/unit/repository/file-system-layout-probe.test.ts`, where the
absent-vs-`PERMISSION_DENIED` narrowing now lives — it is relocated, never
dropped.

### Unit — split conformance

For each §4 ⇒C/⇒P site, a test with a `commonDir`-bearing Context (built via
`deriveWorktreeContext`, which already produces exactly that shape) asserting the
path the site touches. Plus `list-worktrees` main-entry derivation (normal, bare,
separate-git-dir shapes) and `enumerateRefs` / `listReflogs` union + dedup when
`gitDir === commonDir`.

### Integration — `test/integration/node-shim.test.ts` (extended)

Open at a worktree created by tsgit's own `repo.worktree.add`; assert
`ctx.layout.{workDir,gitDir,commonDir}` and that the raw adapter root is the
common ancestor (the existing raw-adapter-root probe pattern from ADR-495).

### Interop — `test/integration/linked-worktree-discovery-interop.test.ts` (new)

`@proves` docblock (`surface: openRepository`, `bucket: cross-tool-interop`,
`interopSurface: worktree`), `describe.skipIf(!GIT_AVAILABLE)`, one shared
`beforeAll(fn, 60_000)` fixture per scenario group (hook-timeout class), all git
through `interop-helpers.ts` (`GIT_*` scrubbed, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM`, signing off), tmpdirs `realpath`-resolved, and a **fresh
`openRepository` after any git-side write** (the per-Context loose-object fanout
cache is only invalidated by tsgit's own `writeObject`).

| # | scenario | assertions |
|---|---|---|
| A | git-built worktree, tsgit reads | `layout.gitDir`/`commonDir` == `git rev-parse --git-dir --git-common-dir`; `revParse('HEAD')`, `log` oids, `status`, `diff` vs git from the same cwd |
| B | packed-refs + commit-graph (`git pack-refs --all`, `git commit-graph write --reachable`, `git repack -adq`), worktree on a packed branch | branch/tag resolve from the common `packed-refs`; walk results match `git rev-list`; `<admin>/objects` never exists |
| C | writes from the worktree Context — `commit`, `branch.create`, `tag.create`, `config.set`, `stash.push` | new objects/refs/reflogs/config land in the **common** dir and not the admin dir (§1d); `HEAD`, `index`, `ORIG_HEAD` land in the admin dir; git reads the result (`git -C wt log`, `git -C main show-ref`, `git -C wt status`) |
| D | cwd is `<wt>/sub/dir` | same pair as A |
| E | submodule working directory (relative pointer, no `commondir`) | `revParse('HEAD')` == `git -C main/sub rev-parse HEAD`, **not** the superproject's — the silent-wrong-repo regression |
| F | `git init --separate-git-dir` | `commonDir === gitDir`; HEAD matches |
| G | refusals, co-pinned | malformed / no-path / dangling `.git` file: tsgit throws the structured code **and** `tryRunGitWithExit` shows exit 128; neither tool falls back to the enclosing repo |
| H | round-trip | `repo.worktree.add` then `openRepository` at the created path; git and tsgit agree on `--git-dir`/`--git-common-dir` |
| I | `worktree.list` from inside a linked worktree | entries match `git worktree list --porcelain`: main first, main path derived from the common dir |

### Parity — `test/parity/`

A memory-adapter worktree layout wholly inside `rootDir` (`/repo/wt` +
`/repo/.git/worktrees/wt`) driven through the same read scenarios as the node
adapter, proving the split is adapter-independent. Parity is cross-adapter only —
it does not substitute for the interop assertions above.

### Gates

Coverage per R12; app mutation budget on `domain/worktree/gitfile.ts`,
`repository/find-layout.ts`, `repository/file-system-layout-probe.ts` and every
touched primitive; `test-pyramid-budgets.json` updated for the new interop file;
`check:write-surfaces` stays clean — the new file's `interopSurface: worktree`
key is what the audit matches `@writes`-tagged modules against, so any module
whose `@writes` surface changes must keep a named interop proof;
`reports/api.json` regenerated (§8).

## Out of scope

- `worktree lock` / `unlock` / `prune` verbs — still deferred by
  [ADR-297](../adr/297-worktree-lock-read-only-verbs-deferred.md).
- `GIT_DIR` / `GIT_WORK_TREE` / `GIT_COMMON_DIR` / `GIT_CEILING_DIRECTORIES`
  environment overrides — tsgit takes its layout from arguments, and adding an
  env-driven layout is a separate surface with its own security posture.
- `core.worktree` / `core.bare` config-driven layout overrides and bare-repo
  discovery (`cd bare.git && …`): today the caller supplies `bare` explicitly, and
  changing that is orthogonal to the pointer-file gap.
- `extensions.worktreeConfig` semantics beyond the already-correct
  `config.worktree` scope path (`internal/config-scope.ts:77`).
- Cross-volume (Windows multi-drive) worktrees — the documented ADR-495
  limitation; this design fails closed there rather than widening it.
- Sparse-checkout inheritance on `worktree add` — deferred with ADR-296/297.
- Any rendered output: the layout is data (ADR-249); reconstructing git's
  `rev-parse` lines happens inside the interop test, never in the library.
- An ownership/trust gate on discovered layouts (git's `safe.directory`):
  following `.git` pointer files inherits git's ownership-check requirement —
  a planted gitfile can point hook lookup (`hooks/` in the attacker-chosen
  common dir) at attacker-controlled scripts, which is why git grew
  `safe.directory`. tsgit has no equivalent gate yet; the mechanism here is
  git-faithful, and the gate is a separate surface with its own design.
- `worktree.list`'s `bare` flag for the main entry when opened FROM a linked
  worktree of a bare repo: deriving it needs `core.bare` from the common
  config, which the first bullet's config-driven-layout exclusion already
  covers. The main entry's *path* is derived correctly in every shape
  (ADR-540); only the flag stays layout-driven.
