# Design — Ownership trust gate

> Brief: refuse to operate on a repository whose metadata the caller does not own, the way
> git's `safe.directory` does — because following someone else's repository metadata is
> code execution. Add an ownership predicate as an adapter capability, a caller-supplied
> trust configuration faithful in EFFECT to `safe.directory` while diverging in LOCATION,
> a `safe.bareRepository` equivalent, and place the gate so that no attacker-supplied
> config value acts before trust is established. Pin the whole matrix against canonical git.
> Status: draft → self-reviewed ×3 → awaiting the decision-candidate conversation

## Context

### What exists today

tsgit has **no ownership or trust gate of any kind**. `getuid` / `geteuid` /
`process.getuid` appear **zero times** in `src/` and `test/` (measured by exhaustive grep).
Every repository the discovery walk finds is operated on unconditionally.

The open sequence a gate has to fit into (node; memory and browser differ only in Stage 1):

| # | site | what it does |
|---|---|---|
| 1 | `src/index.node.ts:51` `openRepository` | `validateOptions`, then realpath `cwd` |
| 2 | `src/index.node.ts:245` → `src/repository/resolve-layout.ts:268` `resolveLayout` | Stage 1: `resolveExplicitOutcome` (`resolve-layout.ts:237`) or `findLayout` (`src/repository/find-layout.ts:78`) → a `WalkOutcome` naming `gitDir` / `commonDir?` / `origin?` / `route` |
| 3 | `src/repository/resolve-layout.ts:190` `finishLayout` | **line 198** `commonDir`; **line 199** `readRepositoryFormat(...)` — Stage 2; **line 201** `resolveWorkTree`; **line 212** `bare` |
| 4 | `src/index.node.ts:78` / `src/repository.ts:427` `layoutRootsOf` | containment-minimised FS root set |
| 5 | `src/index.node.ts:92` / `src/repository.ts:433` | `new NodeFileSystem(roots, …)` / `wrapFsValidator(fs, layoutRoots, …)` |
| 6 | `src/application/primitives/internal/repo-state.ts:89` `assertRepository` | first-command acceptance tier: `hasUsableHead` → `notARepository`, then `assertDiscoveryBooleansValid` |

Stage 2 (`src/repository/read-repository-format.ts:136`) is **the first point a planted
config acts**: it extracts `core.bare`, `core.worktree` and `extensions.worktreeConfig` from
`<commonDir>/config`, and `core.worktree` then feeds `resolveWorkTree` → `layout.workDir` →
`layoutRootsOf` → the FS validator's root set.

### The substrate already landed

- **`LayoutProbe`** (`src/ports/layout-probe.ts`, ADR-535) is the narrow port discovery runs
  on: `stat`, `readUtf8`, and an **optional** `readLink` (ADR-665). Its documented pattern
  for a capability only some adapters can answer is exactly what an ownership predicate
  needs: optional member, omitted by sandboxed adapters, behaviour degrades to the
  sandbox-appropriate default.
- **`FileStat` already carries ownership** — `src/ports/file-system.ts:8-9` declares
  `readonly uid: number; readonly gid: number;` and `mapStat`
  (`src/adapters/node/node-file-system.ts:363-364`) preserves both from
  `fs.stat(…, { bigint: true })`.
- **Both `LayoutProbe` implementations throw ownership away.**
  `src/repository/file-system-layout-probe.ts:15` and `src/index.node.ts:151` each project
  the stat down to `{ isDirectory, isFile, size }`.
- **Sandboxed adapters fabricate `uid: 0`** — `src/adapters/memory/memory-file-system.ts:472`
  and `src/adapters/browser/browser-file-system.ts:305` hardcode it. A predicate written as
  `stat.uid === processUid` would therefore declare **every** memory/browser repository
  foreign-owned for any non-root process. This is the single strongest argument against
  widening `LayoutProbe.stat` with a `uid` field (D1).
- **`syntheticFallbackLayout`** (`resolve-layout.ts:149-178`) already encodes the reasoning
  this gate generalises, verbatim: *"discovery judged that NO repository exists, so nothing
  on disk is trusted — in particular, a config inside a `.git` entry that failed validation
  is never read (… reading a rejected directory's config would hand a planted file control
  over bareness, the work tree, and thereby the containment root set)."*
- **`WalkOutcome.route`** (`find-layout.ts:21-37`) already distinguishes `DISCOVERED` /
  `BARE_DIR` / `EXPLICIT`, and `DISCOVERED` carries `origin` — between them, every term
  both gates key on (§1c, §1h) and the allowlist's key path (§5), all available before any
  config is read. `PathPolicy` already exposes `basename`
  (`src/adapters/node/path-policy.ts`, `src/repository/portable-posix-policy.ts:41`), the
  remaining term §1h needs.
- **Two-tier acceptance** — `assertRepository` (`repo-state.ts:89`) runs on every command
  including the `config` porcelain; `assertOperationalRepository` (`:223`) adds the
  narrower `[core]` tier. `init`/`clone` run neither, which is what lets them bootstrap.
- **Documented mitigations today** — `hooks: false` (`src/repository.ts:115-123`),
  `command: false` (`:124-134`), `ceilingDirs` (`:96-101`); recorded as the available
  posture in [bare-repo-custom-gitdir](bare-repo-custom-gitdir.md) §9, which this design
  extends rather than restates.

### Observed exposure (measured / derived, not assumed)

**1. Nothing stops an alien repository being opened.** No gate exists; the exposure is the
whole of §9.

**2. `core.worktree` collapses the containment root set, and the collapse is total.**
Derived mechanically from the shipped implementations (`layout-roots.ts:19-32` and
`isContainedIn`, `wrap-fs-validator.ts:188-194`), and measured live during the #277 review:

```
layoutRootsOf({ workDir: '/', gitDir: '/srv/r/.git', bare: false })
  candidates = ['/', '/srv/r/.git', '/srv/r/.git']
  deduped    = ['/', '/srv/r/.git']
  isContainedIn('/srv/r/.git', '/') → '/srv/r/.git'.startsWith('/') → true → dropped
  ⇒ ['/']
```

A single planted line, `core.worktree = /`, in a directory the caller merely walked into
turns the FS validator's allowlist into the whole filesystem. It is **faithful** — git
honours `core.worktree` on every discovery route (bare-repo design §1c) — and it is the
concrete reason this gate is feature-sized rather than a nicety.

**3. The metadata that decides code execution is all downstream of the gitdir discovery
picks.** `hooks/` lives in the discovered common dir and the node `HookRunner` spawns those
scripts inheriting the full `process.env` — stated on the option itself
(`src/repository.ts:119-122`: *"a wired runner spawns `.git/hooks/*` scripts that inherit
the full `process.env` of the calling process — including any secrets it holds"*).
`merge.<d>.driver` is a shell command (`:130-132`); `core.excludesFile` /
`core.attributesFile` are attacker-named file reads.

### Binding constraints

- **Prime directive** ([ADR-226](../adr/226-git-faithfulness-prime-directive.md)): every
  behaviour in §1 is pinned against **git 2.55.0** in a `mktemp -d` throwaway with `env -i`,
  isolated `HOME`, `XDG_CONFIG_HOME` under it, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*`
  scrubbed, `commit.gpgsign=false`, `init.defaultBranch=main`. Never recalled.
- **Structured output** ([ADR-249](../adr/249-describe-structured-data-only.md)): the
  refusal is data. The library emits no `fatal:` string; the interop test reconstructs
  git's stderr from the structured fields.
- **No environment reading.** tsgit takes its configuration from arguments. This is why the
  allowlist cannot be `safe.directory` in a global config file, and it is also why tsgit's
  explicit-`gitDir` exemption (§1c) is *safer* than git's: there is no `GIT_DIR` variable an
  attacker who controls the caller's environment can set.
- **The allowlist must not be readable from the repository's own config.** `readConfig`
  (`src/application/primitives/config-read.ts:168`) parses `<commonDir>/config` — the
  attacker-controlled file. Any trust value sourced from there lets the attacker allowlist
  themselves. Measured: git refuses exactly this (§1g).
- **Hexagonal dependency rule**: `repository → commands → primitives → domain`; ports hold
  interfaces only. Branded types, no `any`, functions < 20 lines, kebab-case files,
  no suppression directives.
- **Sibling design, same PR.** `docs/design/repository-format-acceptance-gate.md`
  (backlog 29.1 — the `core.repositoryformatversion` / `extensions.*` gate) lands **first**
  and shapes the acceptance tier's error/assert structure. It did not exist when this doc
  was written; §2 states the shared surface and the one ordering constraint (§1d) that
  binds the two together, and nothing here creates or edits that file.

## Requirements

R1. An ownership predicate exists as an **adapter capability**, not domain logic, and is
absent-by-omission on adapters that cannot answer it. Sandboxed adapters (memory, browser)
never report a foreign owner — and do so by omitting the capability, not by returning a
fabricated uid (the `uid: 0` trap above).

R2. On node/POSIX, a repository whose metadata is owned by a uid other than the process's
effective uid is **untrusted** unless the caller allowlists it. `uid === 0` on either side
is an ordinary value: root-owned metadata read by a root process is trusted; root-owned
metadata read as uid 501 is not.

R3. The trust verdict is computed **after** Stage 1 locates the gitDir and **before** the
Stage-2 config read takes effect — proven, not asserted, by §2's call-site trace: no
config-derived value is consumed earlier.

R4. An untrusted repository's own config **never participates in layout resolution**.
Stage 2 is skipped, so `core.bare` and `core.worktree` cannot widen the containment root
set, cannot fabricate a work tree, and cannot change the FS validator's allowlist — the
protection holds even before any command is issued.

R5. The refusal surfaces at the tier git's does. Measured (§1b): `init` still bootstraps in
an alien-owned directory, existing repository or fresh; config **writes** refuse and leave
the file byte-unchanged; config **reads** succeed and expose an **entirely empty repository
scope** — a planted local key is invisible and a malformed `core.bare` never refuses;
everything else refuses.

R5b. An untrusted repository's config is **never parsed** — not at open (Stage 2, R4) and
not by `readConfig` at command time. Every config-derived gate downstream therefore becomes
a no-op by construction rather than by an explicit precedence rule, which is what reproduces
both §1d ordering pins.

R6. The allowlist is **caller-supplied only**. No value read from any file inside the
repository — `<commonDir>/config`, `<gitDir>/config.worktree`, `include.path` targets —
can widen trust. Proven by a dedicated test, not by inspection.

R7. Allowlist matching reproduces git's measured verdicts on every §1e/§1f row that has an
argument-array analogue: exact match, trailing-slash insensitivity, the `*` wildcard, the
`/*` any-depth prefix, physical (realpath) normalisation on adapters that expose it,
case-sensitivity on this platform, and non-matching for a parent directory, a
`/*`-suffixed self-prefix, or a `**` suffix.

R8. Allowlist entries are the literal `'*'` or an absolute path; anything else — empty,
relative, `.`, `./` — is **refused** with `INVALID_OPTION` at `validateOptions`, following
[ADR-657](../adr/657-ceiling-dirs-are-absolute-only-and-refused-otherwise.md)'s precedent
for `ceilingDirs`, rather than silently warned-and-ignored as git's string surface does.

R9. `safe.bareRepository = explicit` is modelled on its **measured** predicate, not its
name: with it set, a repository whose gitdir was reached by the cwd-is-a-gitdir route under
a basename other than `.git` refuses, regardless of whether it is bare; every other shape —
an explicit `gitDir` argument, a `.git`-named gitdir walked into, and a `.git`-entry
discovery — proceeds, again regardless of bareness (§1h). Its refusal precedes the
ownership refusal, as measured.

R10. The explicit-`gitDir` route is exempt from both gates, matching git exactly (§1c) —
and the exemption is safe here for a reason git cannot claim: tsgit reads no environment,
so the path can only come from the caller's own argument.

R11. Public-surface additions are additive: `OpenRepositoryOptions` gains the trust fields,
`RepositoryLayout` gains the verdict flags, `RepositoryError` gains the new code(s). No
existing field changes type.

R12. Cost is bounded and stated: **one to three extra `stat` calls per `openRepository`**
(the gated paths are directories the walk does not otherwise stat), **zero** per command,
and zero on adapters that omit the capability. No hot path is touched.

R13. Sandboxed adapters (memory, browser) and the whole existing test fleet keep working
unchanged: with the capability omitted the verdict is *trusted*, and that is expressed in
exactly one place, not scattered across the three shims.

R14. 100% line/branch/function/statement coverage on touched code inside the coverage scope
(`domain/`, `ports/`, `adapters/node/`, `adapters/memory/`, `operators/`); app mutation
budget on every touched file; every pinned row in §1 that tsgit can express is backed by a
unit truth-table row, and every row both tools can express is backed by an interop
assertion.

## Design

### 1. Pinned matrix — canonical git 2.55.0

All probes as described in Binding constraints. `$T` is the throwaway root; macOS resolves
it through `/tmp → /private/tmp`, which is why the reported paths carry the `/private`
prefix. The alien-owner condition is forced with `GIT_TEST_ASSUME_DIFFERENT_OWNER=1`
(hereafter **ADO**) — **verified present and effective in 2.55.0** (§1j).

#### 1a. The refusal — exact bytes and exit code

`cd $T/normal && git log --oneline` under ADO: **exit 128, empty stdout**, and a four-line
stderr (420 bytes for this fixture's path length), hex-dumped and reproduced here verbatim
(`⏎` = `\n`, `→` = `\t`):

```
fatal: detected dubious ownership in repository at '<PATH>'⏎
To add an exception for this directory, call:⏎
⏎
→git config --global --add safe.directory <PATH>⏎
```

Four lines. `<PATH>` is single-quoted on line 1 and **unquoted** on line 4. The hint is a
literal `git config --global --add safe.directory` — the location half of the divergence
this design ratifies (§4). The message shape is identical on every route measured (§1c);
only `<PATH>` changes.

#### 1b. Which commands refuse, and which survive

`cwd = $T/normal` (a normal repo with one commit), ADO set:

| command | exit | first stderr line |
|---|---|---|
| `log --oneline` | 128 | dubious-ownership fatal |
| `status --porcelain` | 128 | same |
| `rev-parse --git-dir` / `--absolute-git-dir` / `--is-bare-repository` / `--show-toplevel` | 128 | same |
| `cat-file -t HEAD`, `for-each-ref`, `branch --list`, `ls-files`, `add a.txt` | 128 | same |
| `config --list` | **0** | — prints only the non-repository scopes; the repository scope is simply absent |
| `config core.bare` | **1** | — (key not found: the repository scope was never read) |
| `config --local --list` | 128 | `fatal: --local can only be used inside a git repository` — a **different** fatal: discovery never completed |
| `init` / `init .` (existing repo) | **0** | `Reinitialized existing Git repository in $T/normal/.git/` |
| `init` (fresh alien-owned directory) | **0** | creates `.git` normally |
| `version`, `help -a` | 0 | — |
| `ls-remote $T/normal` from outside | **0** | — the remote path is an explicit argument, hence the §1c exemption |
| `clone $T/normal <dest>` | 128 | dubious-ownership fatal naming **`$T/normal/.git`** — and no destination is created |
| `fetch <alien-remote>` from an alien local repo | 128 | fatal names the **local** repo |

The `init` rows are the bootstrap-leniency requirement (R5) in git's own behaviour, and they
are what pin the gate to the acceptance tier rather than to `openRepository` (§2).

The `config` rows deserve their own table, because they are not "the porcelain refuses more
gently" — **to a gentle-setup command an untrusted repository simply is not a repository,
and its config scope is empty**:

| probe, `cwd = $T/normal`, ADO set | result |
|---|---|
| `config --list` | exit 0; **only** the non-repository scopes appear |
| a distinctive key planted locally (`user.name = PlantedLocalValue`), then `config user.name` | **exit 1, no output** — the repository scope is invisible, not merely ranked lower |
| `config --get core.filemode` (a key `git init` always writes) | exit 1 |
| `config --local --list` | 128, `fatal: --local can only be used inside a git repository` |
| `config user.name Written` / `--add` / `--unset` (writes) | 128, `fatal: not in a git directory`; **the repository config file is byte-unchanged** |
| `core.bare = banana` planted **and** ADO ⇒ `config --list` | **exit 0** — the malformed value that refuses every command on a trusted repository is never even read |
| `core.bare = banana`, **no** ADO ⇒ `config --list` | 128, `fatal: bad boolean config value 'banana' for 'core.bare'` |
| `core.repositoryformatversion = 99`, no ADO ⇒ `config --list` | exit 0 with a *warning*; `config --local --list` ⇒ 128 |
| the same battery under `safe.bareRepository=explicit` in `$T/bare.git` | identical: reads exit 0 with an empty repository scope, writes refuse `not in a git directory` |

The last three rows are the ones that matter for §2's ordering: the empty scope is not a
cosmetic difference, it is *what makes* the ownership refusal appear to precede every
config-derived refusal. There is no explicit precedence rule to reproduce — the downstream
gates simply have nothing to read.

#### 1c. Which path the gate names, and the explicit-route exemption

One path is named per refusal, on every route: the **repository path** = the resolved work
tree when discovery produced one, else the gitDir.

| cwd / invocation | named path |
|---|---|
| `$T/normal` (normal repo) | `$T/normal` (the work tree) |
| `$T/normal/sub` (deep inside) | `$T/normal` |
| `$T/normal/.git` (cwd is the gitdir) | `$T/normal/.git` |
| `$T/bare.git` (`clone --bare`) | `$T/bare.git` |
| `$T/bare.git/refs` (inside the gitdir) | `$T/bare.git` |
| `$T/separate-work` (a `.git` **file** → `$T/separate-git`) | `$T/separate-work` — the work tree, **not** the real gitdir |
| `$T/separate-git` (the separate gitdir itself) | `$T/separate-git` |
| `$T/wt` (linked worktree of `$T/normal`) | `$T/wt` — **not** the common dir |
| `--git-dir=$T/normal/.git` from `$T/elsewhere` | **no refusal, exit 0** |
| `--git-dir=$T/bare.git` from `$T/elsewhere` | **no refusal, exit 0** |
| `--git-dir=normal/.git` (relative) from `$T` | **no refusal, exit 0** |
| `GIT_DIR=$T/normal/.git` (env) | **no refusal, exit 0** |
| `GIT_DIR` + `GIT_WORK_TREE` | **no refusal, exit 0** |
| `--work-tree=$T/normal` with **no** `--git-dir`, cwd `$T/normal` | 128 — discovery still ran |

**The explicit-gitDir route is entirely ungated.** That is the single most consequential row
in this matrix: it decides that tsgit's gate belongs on the discovery routes
(`DISCOVERED`, `BARE_DIR`) and never on `EXPLICIT`. A `--work-tree` argument alone does not
exempt, because discovery still locates the gitdir.

#### 1d. Gate position in the setup sequence — measured ordering

Two independent ordering pins, both decisive for §2:

| fixture at `$T/normal` | without ADO | with ADO |
|---|---|---|
| `core.bare = banana` appended to the repo config | `fatal: bad boolean config value 'banana' for 'core.bare'` (128) | **dubious-ownership fatal** (128) |
| `core.repositoryformatversion = 99` | `fatal: Expected git repo version <= 1, found 99` (128) | **dubious-ownership fatal** (128) |

The ownership refusal **shadows both** the layout-config refusal and the
repository-format refusal — so the check precedes the config read git would otherwise die
on. The second row is the interlock with backlog 29.1: whatever tier that gate lands in,
this one must precede it.

A third pin shows the ordering is not merely about *messages* but about *effect*:

| fixture | reported path under ADO |
|---|---|
| `core.worktree = $T/alt-tree` set in `$T/normal` | `$T/normal` — **not** `$T/alt-tree` |
| `core.worktree = /` set in `$T/normal` | `$T/normal` — **not** `/` |
| allowlist `$T/alt-tree` (the config-named work tree) | REFUSE |
| allowlist `$T/normal` (the discovery work tree) | ALLOW |

`core.worktree` does not move the gate's subject. git decides trust on the **discovery**
layout and only then honours the config — exactly the property that closes the root-set
collapse of Observed exposure #2.

And discovery failure still precedes everything: with no repository at all
(`$T/no-repo`) or an invalid `.git` directory (`$T/bogus/.git` empty), ADO changes nothing —
`fatal: not a git repository (or any of the parent directories): .git`, exit 128.

#### 1e. `safe.directory` value grammar

Repository at `$T/normal` (work tree `$T/normal`, gitdir `$T/normal/.git`), ADO set, value
supplied through `-c safe.directory=<v>` (proven equivalent to the global file in §1g):

| value | verdict | note |
|---|---|---|
| `$T/normal` (the work tree) | **ALLOW** | the exact repository path of §1c |
| `$T/normal/` (trailing slash) | ALLOW | trailing separator is insignificant |
| `$T/normal/.git` (the gitdir) | **REFUSE** | the allowlist keys on ONE path, and it is the work tree |
| `$T` (parent) | REFUSE | no implicit descent |
| `*` | ALLOW | all repositories |
| `$T/*` | **ALLOW** | see depth table below |
| `$T/nor*` | REFUSE | not an fnmatch — only a literal trailing `/*` is special |
| `$T/normal/*` | **REFUSE** | `/*` matches strictly *below* the prefix, never the prefix itself |
| `$T/normal/**` | REFUSE | `**` is not special |
| `$T//normal` | ALLOW | normalised |
| `$T/./normal` | ALLOW | normalised |
| `$T/elsewhere/../normal` (existing intermediate) | ALLOW | normalised physically |
| `$T/nope/../normal` (missing intermediate) | **REFUSE** | a value whose physical resolution cannot succeed does not match |
| `$T/link-normal` (symlink → `$T/normal`) | ALLOW | the **value** is realpath'd |
| `$T/normal` with cwd reached via `$T/link-normal` | ALLOW | the **repository path** is realpath'd |
| `/tmp/…/normal` (unresolved `/tmp` form of `$T/normal`) | ALLOW | both sides realpath'd before comparison |
| `/tmp/…/*` (unresolved prefix, `/*` form) | ALLOW | prefix realpath'd too |
| whole path upper-cased, or only the last segment (`$T/NORMAL`) | **REFUSE** | matching is **case-sensitive** on this platform, despite a case-insensitive APFS volume |
| `%(prefix)/nonsense` | REFUSE | no warning, no crash — the token is accepted and simply does not match |
| `` (empty string, single entry) | REFUSE | the reset semantic, §1f |
| `normal`, `sub`, `..`, `./` (relative) | **REFUSE**, preceded by `warning: safe.directory '<v>' not absolute` on stderr | |
| `.` from the repository root | **ALLOW**, no warning | the literal `.` alone normalises to cwd |
| `.` from `$T/normal/sub` | REFUSE, no warning | it normalised to `$T/normal/sub`, which is not the repository path |

The `.` row is a quirk of git's *string* surface: only the exact value `.` is normalised
against cwd; `./` and `..` are not. It has no analogue in an array argument whose entries
R8 requires to be absolute, and is recorded here so the absence is deliberate.

`/*` depth, repository at `$T/deep/a/b/repo`:

| value | verdict |
|---|---|
| `$T/deep/a/b/*` | ALLOW |
| `$T/deep/a/*` | ALLOW |
| `$T/deep/*` | ALLOW |
| `$T/*` | ALLOW |
| `$T/deep/a/b/repo/*` | REFUSE |

So a trailing `/*` means "**every path strictly below this prefix, at any depth**" — not
"immediate children" and not fnmatch.

**Which path the allowlist keys on**, across layout shapes (one entry, ADO set):

| shape | allowlisting the… | verdict |
|---|---|---|
| bare (`cd $T/bare.git`) | gitdir `$T/bare.git` | ALLOW |
| `.git`-file (`cd $T/separate-work`, gitdir `$T/separate-git`) | work tree `$T/separate-work` | **ALLOW** — and `rev-parse --absolute-git-dir` then returns `$T/separate-git` |
| same | real gitdir `$T/separate-git` | REFUSE |
| `cd $T/separate-git` directly | `$T/separate-git` | ALLOW |
| linked worktree (`cd $T/wt`) | worktree dir `$T/wt` | ALLOW |
| same | common dir `$T/normal` | REFUSE |
| same | admin dir `$T/normal/.git/worktrees/wt` | REFUSE |
| `cd $T/normal/.git` | gitdir `$T/normal/.git` | ALLOW |
| same | work tree `$T/normal` | REFUSE |

One key, one path: the §1c repository path. Note row 2's consequence — **allowlisting a
work tree admits a gitdir at a completely unrelated location**, because the `.git` file
pointer is resolved before the check. That is faithful, and it is a threat-model row (§9).

#### 1f. List semantics — accumulation and reset

Entries accumulate in scope-then-file order; a **valueless entry clears everything
accumulated so far**. Measured against the global config file:

| list (global file, in order) | verdict |
|---|---|
| `[<exact>]` | ALLOW |
| `[<exact>, ""]` | **REFUSE** |
| `[<exact>, "", <exact>]` | ALLOW |
| `["", <exact>]` | ALLOW |
| `["*", ""]` | **REFUSE** |
| `[<other>, <exact>]` | ALLOW |

Scope order is observable: with the global file holding `[<exact>]`, adding
`-c safe.directory=` on the command line **refuses** — the command scope is read after
global, and its reset clears the earlier entry.

An array argument *is* the final list, so the reset semantic has no representation and is
not modelled (§5, D5).

#### 1g. Config scope — where the allowlist may and may not come from

| scope | honoured |
|---|---|
| global (`$HOME/.gitconfig`) | **yes** |
| command (`-c safe.directory=…`) | **yes** — identical matching, and it can reset a global entry |
| system | same tier as global (not exercisable under `GIT_CONFIG_NOSYSTEM=1`) |
| **repository-local** (`git config --local safe.directory <exact>` in the repo itself) | **NO** — refuses anyway |
| repository-local `safe.bareRepository = explicit` | **NO** — ignored |

This is the corollary the design must reproduce exactly: **the untrusted repository cannot
allowlist itself**. git enforces it by restricting these keys to protected configuration;
tsgit enforces it by sourcing them only from `OpenRepositoryOptions` (§4, R6).

#### 1h. `safe.bareRepository` — and what actually triggers it

Values `all` (default) and `explicit`. Refusal, measured byte-for-byte — **one line, no
hint block**, exit 128:

```
fatal: cannot use bare repository '<GITDIR>' (safe.bareRepository is 'explicit')⏎
```

The obvious reading — "it refuses bare repositories" — is **measurably wrong**. Isolated
with fixtures that vary one factor at a time (no ownership problem, `explicit` set):

| gitdir | reached by | `core.bare` | `--is-bare-repository` | verdict |
|---|---|---|---|---|
| `$T/bare.git` (`clone --bare`) | cwd is the gitdir | `true` | `true` | **REFUSE** |
| `$T/bare.git/refs` | ancestor is the gitdir | `true` | `true` | **REFUSE** |
| `$T/no-bare-key.git` (key removed) | cwd is the gitdir | absent | `true` | **REFUSE** |
| `$T/nb3.git` (copy of the above) | cwd is the gitdir | **`false`** | **`false`** | **REFUSE** |
| `$T/wrapB/.git-other` (same bytes, renamed) | cwd is the gitdir | `false` | `false` | **REFUSE** |
| `$T/wrapC/.git` (**same bytes**, named `.git`) | cwd is the gitdir | `false` | `false` | **ALLOW** |
| `$T/wrapC/.git` after setting `core.bare = true` | cwd is the gitdir | `true` | `true` | **ALLOW** |
| `$T/normal/.git` | cwd is the gitdir | `false` | `false` | **ALLOW** |
| `$T/config-bare/.git` | a `.git` entry was found | `true` | `true` | **ALLOW** |
| `$T/normal/.git` via `--git-dir` from `$T/elsewhere` | explicit argument | — | — | ALLOW |
| `$T/bare.git` via `--git-dir` or `GIT_DIR` | explicit argument | `true` | `true` | ALLOW |

Rows 5 and 6 are the controlled experiment: `$T/wrapB/.git-other` and `$T/wrapC/.git` are
**byte-identical copies of the same directory**, differing only in name, and they land on
opposite verdicts. Rows 6 and 7 add that flipping `core.bare` changes nothing.

Further, `$T/wrapC/.git` and `$T/nb3.git` are **observationally identical** on every layout
query — `--git-dir` `.`, `--git-common-dir` `.`, `--is-bare-repository` `false`,
`--is-inside-git-dir` `true`, `--is-inside-work-tree` `false`, empty `--show-cdup` and
`--show-prefix`, and `--show-toplevel` / `status` both refusing with
`fatal: this operation must be run in a work tree` — and still disagree under `explicit`.

**The predicate is therefore: discovery reached the gitdir by the cwd-is-a-gitdir route
AND the gitdir's basename is not literally `.git`. Bareness plays no part.** In tsgit's
vocabulary, `outcome.route === 'BARE_DIR' && basename(outcome.gitDir) !== '.git'` — both
terms available from `WalkOutcome` (`find-layout.ts:21-37`) at the moment the gate runs, with
no config read and no Stage-3 work-tree resolution required. The option's *name* describes
git's intent (an "implicit" repository directory, as opposed to the conventional
`<worktree>/.git`), not its condition.

Which commands it stops, and ordering:

| case | result |
|---|---|
| `config --list` in `$T/bare.git` | ALLOW (exit 0) — same gentle-setup tier as §1b |
| `init --bare .` in `$T/bare.git` | ALLOW (exit 0, re-uses the existing repository) |
| bogus value (`banana`) | `fatal: unable to parse 'safe.barerepository' from command-line config`, 128 |
| repository-local `safe.bareRepository = explicit` | **ignored** (§1g) |
| ADO + `explicit`, `cd $T/bare.git` | **bareRepository** fatal — it precedes the ownership one |
| ADO + `safe.directory=*` + `explicit`, `cd $T/bare.git` | **bareRepository** fatal — `safe.directory` does not lift it |
| ADO + `explicit`, `cd $T/config-bare` (predicate does not apply) | dubious-ownership fatal |
| ADO + `safe.directory=*` + `explicit`, `cd $T/config-bare` | exit 0 |

The two gates are independent, and this one fires first.

#### 1i. Interaction with linked worktrees and remote verbs

- **Linked worktree** (`$T/wt` of `$T/normal`): the refusal names `$T/wt`; the allowlist
  keys on `$T/wt`; neither the common dir nor the admin dir admits it (§1e).
- **`.git` file / separate gitdir**: the pointer is resolved *before* the check, and the
  work tree is the key (§1e row 2).
- **`ls-remote <alien-local-path>`** succeeds (the remote is an explicit path argument),
  while **`clone <alien-local-path>`** refuses naming the source gitdir. tsgit has no
  local-path transport, so only the first has an analogue and it is a no-op.

#### 1j. The alien-owner fixture problem — what can and cannot be produced

Measured on this machine (uid 501, macOS 25.5, APFS):

| mechanism | available |
|---|---|
| `chown <dir> <other-uid>` as a non-root user | **no** — `Operation not permitted` |
| `sudo -n true` (password-less sudo) | **no** — `a password is required` |
| an existing repository owned by another uid | **none found** — `/usr/share`, `/Library`, `/usr/local`, `/System/Library` are root-owned but contain no reachable git repository; every `.git` under `/opt/homebrew` (including its taps and casks) is owned by uid 501 |
| root-owned world-writable directories (`/private/tmp`, `/var/tmp`) | present, but any directory or repository created inside them is owned by the creator, so they cannot host an alien-owned *repository* |
| `GIT_TEST_ASSUME_DIFFERENT_OWNER=1` | **yes** — present and effective in the released 2.55.0 binary; forces the ownership check to fail for the whole invocation |

Two consequences, both load-bearing:

1. **Which of the gitfile / work tree / gitdir git actually `stat`s is not measurable
   here.** ADO forces all of them to fail at once, so the only observables are (a) which
   single path is *named*, and (b) which single path the allowlist keys on — both fully
   pinned in §1c/§1e. The design records this as an explicit unmeasured residual and D8
   makes the choice a decision rather than a guess.
2. **The interop suite cannot manufacture an alien owner on both sides** without either a
   real `chown` (root, or a container) or a tsgit-side equivalent of ADO. §Test strategy
   specifies the skip predicate concretely and D9 surfaces the always-on alternative.

### 2. Where the gate sits — and the proof that nothing config-derived precedes it

The verdict is computed in **`finishLayout` (`resolve-layout.ts:190`), between line 198 and
line 199** — after `commonDir` is known, before `readRepositoryFormat` runs:

```
finishLayout(probe, outcome, pathPolicy, cwd, overrides, caps):
  commonDir := outcome.commonDir ?? outcome.gitDir            # line 198 today

  # ── NEW: both verdicts, from structure + caller arguments only ──────────
  gated := outcome.route !== 'EXPLICIT'                        # §1c — no walk, no gate
  implicitBare := gated
               && outcome.route === 'BARE_DIR'                 # §1h — bareness plays no part
               && pathPolicy.basename(outcome.gitDir) !== '.git'
               && bareRepositories === 'explicit'
  trusted := !gated || await isTrusted(probe, outcome, commonDir, trustOpts, pathPolicy)

  # ── Stage 2, now conditional ────────────────────────────────────────────
  fmt := trusted ? await readRepositoryFormat(probe, outcome.gitDir, commonDir, pathPolicy)
                 : EMPTY_FORMAT                                # { bare: undefined,
                                                               #   worktree: undefined,
                                                               #   worktreeConfig: false }
  … Stages 3 and 4 unchanged …
  return { …layout, ...(trusted ? {} : { untrusted: true }),
                    ...(implicitBare ? { implicitBare: true } : {}) }
```

Both verdicts are computed **above** the Stage-2 read and neither needs it: §1h's predicate
is purely structural, and §1d measures git deciding trust before any config participates.
That is what makes the conditional Stage 2 safe — nothing below it feeds back above it.

**Why exactly here.** Everything Stage 1 consumes is *structural*, never config:

| Stage-1 read | file | config? |
|---|---|---|
| `probe.stat(<dir>/.git)` | — | no |
| `layoutFromGitfile` / `resolvePointer` | `.git` (gitfile) | no — a path pointer, capped at `GITFILE_MAX_BYTES` |
| `layoutFor` → `hasValidHead` | `<gitDir>/HEAD` (content or link text) | no |
| `layoutFor` → `sharedDirsValid` | `<commonDir>/objects`, `<commonDir>/refs` | no |
| `resolveCommonDir` | `<gitDir>/commondir` | no — a path pointer |

The first config byte anywhere in the open sequence is `readRepositoryFormat`'s read of
`<commonDir>/config` at `resolve-layout.ts:199`. Placing the gate immediately above it is
therefore both necessary and sufficient, and it is the same point git chose (§1d).

Two attacker-controlled *pointers* are still resolved before the gate — the `.git` gitfile
and `commondir`. Both are path redirects, not behaviour: they choose *which* directory
the gate then judges, and the gate judges the resolved target. git does the same (§1e row 2
measures a work tree admitting a gitdir elsewhere). Recorded in §9, not closed here.

Skipping Stage 2 also skips the two refusals
[ADR-664](../adr/664-layout-config-refusals-surface-at-open-time.md) moved to open time
(`CONFIG_BAD_BOOLEAN_VALUE` for a malformed `core.bare`, `CONFIG_MISSING_VALUE` for a
valueless `core.worktree`). That is not a regression of ADR-664 but the faithful ordering:
§1d measures git's dubious-ownership fatal **shadowing** `bad boolean config value 'banana'`
on the same fixture. An untrusted repository is refused on trust, never on the contents of a
file the caller was told not to trust.

**Consequences of skipping Stage 2 when untrusted (R4).** No `core.worktree`, so
`resolveWorkTree` falls through to the structural rows: `origin` on the `DISCOVERED` route,
none on `BARE_DIR`. `layoutRootsOf` therefore sees only paths discovery itself produced —
the root-set collapse of Observed exposure #2 is structurally impossible, before any
command is issued and independently of whether the caller ever calls one. No `core.bare`
either, so `layout.bare` is the structural default (`bareCfg` unset is truthy —
`resolve-layout.ts:210-212`): `false` on `DISCOVERED`, `true` on `BARE_DIR`. Since every
command refuses, the only observable is `repo.layout` itself, which carries
`untrusted: true` alongside it — a caller reading the layout of an untrusted repository is
told so in the same object.

**Where the refusal is thrown, and how the orderings fall out.** `openRepository` itself must
resolve: §1b measures `git init` succeeding inside an alien-owned repository, and `init`
runs no acceptance gate. That leaves two behaviours to place, and §1b's config table shows
they are one mechanism, not two rules:

1. **The repository config scope reads as empty when `layout.untrusted`** — one guard in
   `readConfig` (`src/application/primitives/config-read.ts:168`), returning the empty parse
   rather than reading `<commonDir>/config`. This single change reproduces every measured
   config row: a planted local key is invisible, `core.bare = banana` never refuses,
   29.1's format gate never sees `repositoryformatversion = 99`. **No explicit precedence
   rule is needed** for §1d's two ordering pins — the downstream gates have nothing to read,
   which is exactly why git appears to check ownership "first". It is also the safer
   behaviour on its own terms: the attacker's file is not parsed at all.
2. **Operational verbs refuse**, with the two flags read synchronously off the frozen
   layout:

```
assertRepository(ctx):                       # config porcelain reaches here too
  hasUsableHead                          → NOT_A_REPOSITORY
  assertDiscoveryBooleansValid           → (no-op when untrusted: empty scope)
  [29.1's repository-format gate]        → (no-op when untrusted: empty scope)

<the trust refusal>:                         # placement is D11
  ctx.layout.implicitBare                → IMPLICIT_BARE_REPOSITORY   (§1h precedes ownership)
  ctx.layout.untrusted                   → DUBIOUS_OWNERSHIP
```

Both refusals are synchronous reads of frozen fields — no I/O, no per-command cost (R12) —
and `implicitBare` precedes `untrusted`, the one explicit ordering §1h measures between them.
**Where they are checked is D11**: putting them in `assertRepository` is simplest but makes
tsgit's `config` read verbs throw where git's return an empty list (§1b), so the faithful
placement is a tier the porcelain skips. The write side needs no separate rule: git refuses
config writes on an untrusted repository (`fatal: not in a git directory`, file untouched),
and tsgit's write verbs already run the operational tier.

### 3. The ownership predicate as a port capability

`LayoutProbe` gains one optional member, in ADR-665's shape:

```ts
/**
 * Whether `path` is owned by the caller. OPTIONAL: only an adapter over a
 * real multi-user filesystem can answer. Adapters that omit it declare that
 * foreign ownership cannot exist in their world (memory, browser, and any
 * platform whose owner model this adapter does not implement), and the trust
 * gate reads the omission as "trusted".
 */
readonly isOwnedByCaller?: (path: string) => Promise<boolean>;
```

Node wires it from the raw probe (`src/index.node.ts:146`), beside `readLink`:

```ts
isOwnedByCaller: async (p) => {
  const self = process.getuid?.();
  if (self === undefined) return true;          // no POSIX owner model here (D2)
  const s = await stat(p).catch(() => undefined);
  return s === undefined || s.uid === self;     // absent ⇒ nothing to distrust
},
```

Three details are deliberate and each earns a test row:

- **`s.uid === self`, never truthiness.** `uid` 0 is an ordinary value on both sides (R2).
- **Absence is trusted, not untrusted.** A path that does not exist cannot be foreign, and
  the lenient-resolution contract (`resolve-layout.ts:222-236`) requires `init`/`clone` to
  bootstrap into a directory that is not there yet.
- **`process.getuid?.()` returning `undefined` yields `true`.** That is the Windows branch
  and it is a divergence, not an accident (D2, §9).

`fileSystemLayoutProbe` (`file-system-layout-probe.ts:10`) does **not** gain the member: its
`FileSystem` sources are the sandboxed adapters, which fabricate `uid: 0`
(`memory-file-system.ts:472`, `browser-file-system.ts:305`). Deriving a predicate from that
value would declare every memory/browser repository foreign-owned for any non-root process —
the trap that makes "widen `LayoutProbe.stat` with `uid`" the wrong shape (D1). Omitting the
member is the single place R13's "trusted in a sandbox" lives.

### 4. Trust configuration — faithful in effect, divergent in location

git sources `safe.directory` and `safe.bareRepository` from **protected** configuration —
system, global, command line — and refuses them from the repository (§1g). tsgit's FS port
deliberately cannot reach global or system config; `readConfig` parses `<commonDir>/config`
only, which is precisely the attacker-controlled file. The faithful *effect* — a trust
decision the repository cannot influence — is therefore expressed as **caller arguments**:

```ts
/** Trust policy for repositories reached by discovery. Ignored on the explicit-`gitDir` route. */
readonly trust?: 'ownership' | 'always';
/** Absolute directories trusted regardless of ownership. The single entry `'*'` trusts every repository. */
readonly trustedDirectories?: ReadonlyArray<string>;
/**
 * git's `safe.bareRepository`. `'explicit'` refuses a repository whose gitdir was reached
 * by walking into it under a name other than `.git` (§1h) — an "implicit" repository
 * directory. An explicit `gitDir` argument is always accepted.
 */
readonly bareRepositories?: 'all' | 'explicit';
```

(Names, the exact enum, and whether a third `trust` value is added are D3/D4/D7/D9; the
*location* is not negotiable.)

`validateOptions` (`src/repository/validate-options.ts:33`) gains three validators beside
the existing `validateCeilingDirs`: `trust` and `bareRepositories` must be one of their
literals, and every `trustedDirectories` entry must be non-empty and either the literal
`'*'` or an absolute path (R8) — boundaries in isolated triples, per that file's stated
mutation-resistance directives.

This is the same divergence class as
[ADR-657](../adr/657-ceiling-dirs-are-absolute-only-and-refused-otherwise.md): git parses a
string it cannot validate, tsgit takes a typed argument it can. Its reasoning shape carries
over unchanged — the pinned *semantics* (what is trusted) are faithful; only the *surface*
(where the values come from, and that a bad entry refuses instead of warning) differs, and
the divergence cannot break a caller supplying faithful input.

Two properties the surface must have, both testable:

1. **No file inside the repository can widen trust** (R6). `trustedDirectories` is read from
   `OpenRepositoryOptions` and nowhere else; no `readConfig` call participates in the gate.
2. **The gate is inert on the explicit route** (R10, §1c). `opts.gitDir` given ⇒
   `route === 'EXPLICIT'` ⇒ no ownership evaluation, no bare-repository evaluation.

### 5. Allowlist matching

A pure domain function over the caller's array — no I/O, no `Context`:

```
isAllowlisted(repoPath: string, entries: ReadonlyArray<string>): boolean
  ⇔ entries.some(entry =>
        entry === '*'
     || stripTrailingSlash(entry) === stripTrailingSlash(repoPath)
     || (entry endsWith '/*' && isStrictlyBelow(repoPath, entry without the trailing '*')))
```

`repoPath` is the **discovery repository path**:

```
repoPath = outcome.route === 'DISCOVERED' ? outcome.origin : outcome.gitDir
```

not `layout.workDir ?? layout.gitDir` — `workDir` does not exist yet when the gate runs
(Stage 3 is below it), and §1d measures that git keys on the discovery work tree rather than
the `core.worktree` one anyway. The formula reproduces every §1c/§1e row: `$T/normal` and
`$T/normal/sub` both give `$T/normal` (the `origin` of the level holding `.git`);
`$T/separate-work` gives `$T/separate-work` and not its far-away gitdir `$T/separate-git`; `$T/wt` gives
`$T/wt` and not the common dir; `$T/bare.git`, `$T/bare.git/refs`, `$T/normal/.git` and
`$T/separate-git` all give the gitdir.

Entry canonicalisation follows ADR-537's established split: **realpath'd on node**
(so §1e's symlink and `/tmp`-vs-`/private/tmp` rows hold), lexical on sandboxed adapters,
which have no symlinks to resolve. Comparison is **case-sensitive** — measured (§1e), and
notably so on a case-insensitive volume.

Rows deliberately not modelled, each with its reason:

| git row | modelled? | why |
|---|---|---|
| relative entry ⇒ `warning: … not absolute`, no match | no — **refused** at `validateOptions` | R8, ADR-657 precedent |
| the literal `.` normalising to cwd | no | a string-surface quirk with no array analogue; R8 refuses it |
| empty-value reset | no | an array *is* the final list; there is no earlier scope to reset |
| `%(prefix)/…` interpolation | no | a git-installation-path token with no meaning in a library |
| `$T/nope/../normal` (realpath failure ⇒ literal compare) | no | R8 plus node's realpath fallback already yields the same verdict: no match |

**Property-test lens.** `isAllowlisted` is a compositional matcher (CLAUDE.md lens 2) and a
total function over a small algebraic grammar (lens 3): it reduces an array of rules to a
verdict, and must never throw. A `*.properties.test.ts` sibling **is** warranted — the
properties are listed in Test strategy.

### 6. Refusal semantics

Two new structured codes in `src/domain/repository/error.ts`, joining the union at line 4
and rendered by one `case` arm each in `extractDetail`
(`src/domain/error.ts:299-310`, using the existing `basename()` sanitisation idiom):

| code | payload | condition | git's fatal (reconstructed in the interop test) |
|---|---|---|---|
| `DUBIOUS_OWNERSHIP` | `{ path }` — the §5 discovery repository path | discovery route, capability present, a gated path not owned, not allowlisted | the 4-line block of §1a |
| `IMPLICIT_BARE_REPOSITORY` | `{ gitDir }` | `route === 'BARE_DIR' && basename(gitDir) !== '.git' && bareRepositories === 'explicit'` (§1h) | the 1-line fatal of §1h |

Distinct codes rather than one code with a `reason` discriminant: git has two conditions,
two messages and a measured ordering between them (§1h), and distinct codes kill the
`StringLiteral` mutants a shared code would survive. Payloads are asserted directly, never
via `toThrow(ErrorClass)`.

Per ADR-249 the library ships the code and the payload only. The hint line —
`git config --global --add safe.directory <path>` — is git's rendering of an action that
does not exist in tsgit (there is no global config to write); the interop test reconstructs
it from `data.path`, and the docs page states the tsgit-side equivalent
(`trustedDirectories: [path]`).

### 7. Bootstrap leniency and write/read symmetry

The write path must not regress, and §1b measures git's own answer:

| operation | git under ADO | tsgit |
|---|---|---|
| `init` into a fresh alien-owned directory | succeeds | succeeds — discovery finds nothing, `syntheticFallbackLayout` reads nothing from disk, `init` runs no acceptance gate |
| `init` into an existing alien-owned repository | succeeds (re-uses the existing repository) | succeeds — `init` never calls `assertRepository` |
| `clone` into a fresh directory | n/a (destination is created by the caller's uid) | unchanged |
| `clone` **from** an alien local path | refuses | n/a — tsgit has no local-path transport |
| a config **write** verb (`config user.name x`) | refuses, `fatal: not in a git directory`, file byte-unchanged | refuses; the write verbs run the operational tier |
| a config **read** verb | exit 0, repository scope empty, planted key invisible | empty repository scope (D11(a)) — the file is not parsed at all, which is a strict improvement on git's own posture |
| any other read/write command on an alien repository | refuses | refuses |

Read path and write path therefore agree on the same predicate and the same tier, and the
asymmetry git exhibits (`init` yes, everything else no) is reproduced by *where* the gate
lives rather than by a special case inside it.

### 8. The three shims, and containment

| shim | Stage 1 | capability | verdict |
|---|---|---|---|
| node (`src/index.node.ts`) | `findLayout` / `resolveExplicitOutcome` over `nodeLayoutProbe` | `isOwnedByCaller` wired (§3) | evaluated on POSIX; trusted on Windows (`process.getuid` absent) |
| memory (`src/index.default.ts:75`) | same, over `fileSystemLayoutProbe(fs)` | omitted | trusted |
| browser (`src/index.browser.ts:70` → `fixed-entry-layout.ts:39`) | `resolveFixedEntryLayout` → **the same `finishLayout`** | omitted | trusted |

All three converge on `finishLayout`, so the gate is written once and the "sandboxes are
trusted" rule is one `?.` in one function — R13 satisfied without a shim-level special case.

**Containment is strictly narrowed, never widened.** For an untrusted repository the root
set is computed from discovery-only paths (§2), which is a subset of what it is today. For a
trusted one nothing changes. `layoutRootsOf` and `wrapFsValidator` are untouched.

**`unsafeRawAdapters` does not bypass the gate.** That option opts out of the FS/transport
*validators* (`src/repository.ts:429-435`); the trust verdict is computed during layout
resolution, upstream of adapter composition, and is enforced by `assertRepository`. Opting
out of containment therefore makes the gate *more* load-bearing, not less — which is the
right direction, and worth one sentence in that option's JSDoc.

### 9. Threat model

This section extends [bare-repo-custom-gitdir](bare-repo-custom-gitdir.md) §9, which
recorded this exposure as deferred; it does not restate it.

**What the gate closes**

| asset | exposure before | closed by |
|---|---|---|
| `hooks/` in the discovered common dir, spawned by the node `HookRunner` with the caller's full `process.env` including secrets | arbitrary code execution on the first hook-firing command against any planted repository the walk reaches | no command runs on an untrusted repository — `assertRepository` refuses before any hook resolution |
| `merge.<d>.driver` — a shell command from the repository's own config | command execution through a merge on attacker-supplied content | the config file is **never parsed** — not at open (Stage 2 skipped, R4) and not at command time (R5b, D11(a)) — and no operational command runs |
| `core.excludesFile` / `core.attributesFile` — attacker-named file reads | reads outside the caller's intent, bounded only by the FS validator | same. git reaches the same *observable* (an empty repository scope, §1b); whether it declines to read the file or discards what it read is not observable from outside, and not-reading is the stricter of the two |
| **`core.worktree` widening the containment root set, up to `/`** | a single planted line collapses the FS validator's allowlist to `[/]` (Observed exposure #2), vacating the mitigation the row above depends on | **structurally impossible when untrusted**: Stage 2 is skipped, so `core.worktree` never reaches `resolveWorkTree` and the root set contains only paths discovery produced. This is the one row the gate closes *before* any command, not merely at refusal time |
| a repository directory planted inside a tree the caller clones (`node_modules/x/evil.git/`, an extracted archive), shadowing the real repository from any subdirectory | git added `safe.bareRepository` for exactly this; tsgit's `BARE_DIR` route made it reachable in #277 | `bareRepositories: 'explicit'` (§1h) — an opt-in the ownership gate does **not** subsume, because a repository planted inside your own clone **is owned by you** and so passes the ownership check. Its measured predicate (any gitdir basename other than `.git`) is precisely the "this was not put here by a normal checkout" heuristic |

**What the gate does NOT close**

| residual | why it stays |
|---|---|
| An attacker who can write inside a repository you **own** — a malicious clone you ran yourself, a shared checkout, a compromised dependency writing into `.git/` | the gate is an *ownership* gate, not a content gate. `hooks: false` + `command: false` remain the mitigations, and remain documented |
| Same-uid attackers (another process running as you) | outside any uid-based model |
| Callers passing `trust: 'always'`, `trustedDirectories: ['*']`, or a `/*` prefix that is too wide | the escape hatch is the feature; the option JSDoc must carry the same WARNING register as `hooks` / `command` / `unsafeRawAdapters` |
| The explicit-`gitDir` route (§1c, faithful) — a caller who forwards an attacker-chosen path as `opts.gitDir` | faithful to git, and materially safer here: tsgit reads no environment, so there is no `GIT_DIR` an attacker can inject; the path must come from the caller's own code |
| Pointer redirection resolved before the gate: an alien `.git` **file** or `commondir` chooses which directory is judged (§2, and §1e's measured row where a work tree admits a gitdir elsewhere) | faithful; the gate still judges the *resolved* target, so an alien target is caught. Only the case "alien pointer, owned target" slips through, and it slips through git too |
| **Windows** — `process.getuid` is absent, the capability returns `true`, every repository is trusted (D2) | git-for-windows uses a security-descriptor owner check this design has **not measured** (no Windows host available). The divergence is documented rather than guessed. It matters: CI runs the unit matrix on `windows-latest` |
| Sandboxed adapters (memory, browser) | no foreign ownership exists; OPFS content is same-origin caller-controlled |
| Group- or world-writable directories that you own | tsgit consults ownership only; permission bits are not part of the predicate |
| TOCTOU between the open-time check and later reads | the verdict is computed once per `openRepository`, as git computes it once per process. A repository whose owner changes mid-session is not re-judged |
| Which of gitfile / work tree / gitdir git itself `stat`s (§1j) | not measurable without root; D8 makes tsgit's choice explicit instead of inferring git's |

**What it costs**

- One to three extra `stat` calls per `openRepository` (D8 fixes the count); zero per
  command; zero when the capability is omitted (R12).
- Callers who legitimately operate on repositories owned by another user — CI containers
  with mismatched user ids, shared checkouts, network mounts — must pass `trustedDirectories`.
  This is exactly the friction `safe.directory` is famous for, and it is the price of the
  first four rows above.
- One new public option group, two new error codes, one new layout flag pair.

### 10. Public surface

- `OpenRepositoryOptions` gains the trust fields of §4, each with a WARNING-register JSDoc
  matching `hooks` / `command` / `unsafeRawAdapters`.
- `RepositoryLayout` / `RepositoryLayoutInput` gain `untrusted?: true` and
  `implicitBare?: true`, following the existing `workTreeConfigBogus?: true`
  present-only-when-true idiom (`src/repository.ts:161-162`). Additive; `repo.layout`
  (ADR-658) exposes them. Flags rather than a `route` field: `route` is a resolution-time
  discriminant with no meaning to a consumer, while these two are verdicts a consumer acts
  on, and the idiom for "a layout-level verdict the acceptance tier reads synchronously"
  is already established one line above them.
- `RepositoryError` gains `DUBIOUS_OWNERSHIP` and `IMPLICIT_BARE_REPOSITORY`, each with
  a factory beside the others and one arm in `extractDetail`.
- `LayoutProbe` gains an optional `isOwnedByCaller`; like the port itself (ADR-535) it stays
  out of the public barrel.
- Under D11(a), `readConfig` (`src/application/primitives/config-read.ts:168`) gains one
  layout-dependent early return, and the set of verbs that survive on an untrusted
  repository becomes a documented contract rather than an implementation detail — it must be
  enumerated on the `openRepository` docs page, not left to be inferred from which assert a
  command happens to call.
- `reports/api.json` regenerated and committed at pre-PR — a pre-push gate, and a
  cached-green `validate` can precede a red prepush.
- Docs: `docs/use/errors.md` (two codes), `docs/understand/security.md` (a
  `## Repository trust` section — the file's `## What tsgit does NOT do` closing section
  needs the residuals of §9), `docs/understand/repository-layout.md` and
  `docs/get-started/node.md` (the option group and the shared-repository recipe).

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | Shape of the ownership capability (§3) | (a) optional `LayoutProbe.isOwnedByCaller?: (path) => Promise<boolean>`; (b) widen `LayoutProbe.stat`'s return with `uid?: number` and compare in `resolve-layout.ts`; (c) a new `TrustProbe` port alongside `LayoutProbe` | **(a)** | (b) is measurably wrong here: the memory and browser adapters hardcode `uid: 0` (`memory-file-system.ts:472`, `browser-file-system.ts:305`), so a `uid`-comparing gate declares every sandboxed repository foreign-owned for any non-root process — the failure would be silent in production and invisible in a root-run container. It also pushes a platform ownership model into `src/repository/`, which is adapter concern. (c) doubles the plumbing through all three shims for one method. (a) is ADR-665's shape, already ratified for exactly this situation: an optional member whose omission is a meaningful, documented answer. |
| D2 | Windows (§3, §9) | (a) POSIX-only — the node shim wires the capability only when `process.getuid` exists; Windows repositories are trusted, recorded as a divergence in an ADR and in `docs/understand/security.md`; (b) implement a Windows owner check; (c) treat Windows as untrusted-unless-allowlisted | **(a)** | git-for-windows uses a file-security-descriptor owner check (`GetNamedSecurityInfo`-class), which this design **could not measure** — no Windows host was available, and the prime directive forbids designing it from memory. (b) additionally needs a native call tsgit's zero-dependency, browser-portable constraint rules out. (c) inverts the default on a platform where nothing can ever be allowlisted correctly, breaking every Windows caller and the `windows-latest` unit matrix. (a) is the honest posture: a gap that is *named*, not a behaviour that is *invented*. The ADR should state the gap explicitly so a future Windows-hosted measurement can close it. |
| D3 | Trust-option surface (§4) | (a) `trust?: 'ownership' \| 'always'` + `trustedDirectories?: ReadonlyArray<string>` as sibling top-level options; (b) one option `trust?: 'ownership' \| 'always' \| { allow: ReadonlyArray<string> }`; (c) name them after git — `safeDirectory?: ReadonlyArray<string>` | **(a)** | (b) makes the common case (default policy, one allowlist entry) require constructing a union arm, and makes "ownership policy" and "exceptions to it" inseparable in a way §1f shows git keeps separate. (c) imports a config-key name into an argument API and invites the reader to expect the *location* semantics too — the very thing this design diverges on; ADR-657 already set the precedent that tsgit names arguments after what they do. (a) keeps each option independent and reads correctly at the call site. Both fields live at the top level of `OpenRepositoryOptions`, not under `config`, so they sit beside `hooks` / `command` / `ceilingDirs` — the other trust-shaped knobs. |
| D4 | Default posture (§4, R2) | (a) gate ON by default (`trust` defaults to `'ownership'`), matching git; (b) OFF by default, opt-in via `trust: 'ownership'`; (c) ON on node, OFF elsewhere — which (a) already yields for free, since sandboxes omit the capability | **(a)** | This is the one choice with a real compatibility cost, and it is the user's to make. For (a): git's default is on, the prime directive binds, the current behaviour is a security hole rather than a feature, and (c) is a description of (a)'s behaviour rather than a distinct option. Against (a): a caller today operating on a container-mounted repository with a mismatched uid starts throwing on upgrade — the exact friction `safe.directory` is known for. (b) ships a security feature nobody turns on, and makes the library's default *less* safe than the `git` binary the same user already trusts. Note the blast radius is narrower than git's: the explicit-`gitDir` route is exempt (§1c), so callers who pass `gitDir` — the common programmatic shape — are unaffected. |
| D5 | Which allowlist grammar rows to model (§5) | (a) exact + trailing-slash-insensitive + `*` + `/*` any-depth prefix, absolute-only (refuse otherwise), realpath'd on node / lexical in sandboxes; (b) exact + `*` only; (c) full git grammar including the empty-value reset, the relative-value warning, and the `.`-normalises-to-cwd quirk | **(a)** | (b) drops `/*`, which §1e measures as the row that makes the feature usable for "trust everything under `/workspace`" — the CI case that is 90% of real `safe.directory` usage; without it every repository needs an entry. (c) transplants string-surface artefacts into an array: the reset semantic has nothing to reset (an array *is* the list), the relative-value warning contradicts ADR-657's ratified refusal, and `.`-vs-`./` is a normalisation accident of git's parser, not a semantic. (a) models every row with an array analogue and refuses the rest loudly. |
| D6 | Error taxonomy (§6) | (a) two new codes, `DUBIOUS_OWNERSHIP { path }` and `IMPLICIT_BARE_REPOSITORY { gitDir }`; (b) one code `REPOSITORY_UNTRUSTED { path, reason: 'ownership' \| 'implicit-bare' }`; (c) reuse `NOT_A_REPOSITORY { path }` | **(a)** | (c) is measurably wrong and dangerous: git emits a *different* fatal for the two situations (§1d's `$T/no-repo` row versus §1a), and collapsing them tells a caller "this is not a repository" about a repository that is perfectly valid and merely foreign — precisely the diagnosis they need to act on. (b) survives the `StringLiteral` mutants distinct codes kill, and erases a distinction §1h measures as having its own *ordering*. (a) follows the ADR-654 precedent (two work-tree refusal codes for two measured conditions). The second code's *name* is worth the user's attention: the condition is measured to be independent of bareness (§1h), so `IMPLICIT_BARE_REPOSITORY` echoes git's message rather than its predicate; `IMPLICIT_GIT_DIR` would describe the predicate but lose the tie to git's `cannot use bare repository` fatal. |
| D7 | Model `safe.bareRepository` now or defer (§1h) | (a) model it now, as `bareRepositories?: 'all' \| 'explicit'`; (b) defer to a follow-up; (c) implement the refusal permanently as `'all'`, i.e. a documented no-op | **(a)** | Three reachability arguments. First, #277 made the `BARE_DIR` route reachable through `openRepository` for the first time, which is exactly the exposure git added this knob for. Second, it is **not** subsumed by the ownership gate — a repository directory planted inside your own clone is owned by *you*, so ownership passes and only this gate stops it; §1h's measured predicate (any gitdir basename other than `.git`) is exactly the "not placed here by a normal checkout" signal. Third, it needs no ownership capability, so unlike everything else here it is **fully interop-testable against real git today**, on every platform, with no escape hatch and no skip — the cheapest faithful row in the feature. (b) leaves the one attack vector the ownership gate structurally cannot see. (c) is a config option that does nothing. |
| D8 | Which path(s) the predicate checks (§1j, §9) | (a) the discovery repository path only (§5) — exactly what §1c/§1e measure as named and keyed; (b) `gitDir`, `commonDir` and the discovery repository path; (c) `gitDir` and `commonDir` only — the metadata that decides code execution | **(b)** | Unmeasurable here (§1j: ADO forces every candidate path to fail at once), so it is a genuine decision rather than a pin. (a) is the minimal defensible choice but leaves the asset unguarded in the shape that matters most: a `.git` **gitfile** in a directory you own, pointing at a gitdir someone else owns — §1e measures git admitting exactly that pairing when the work tree is allowlisted — while the hooks and config that get executed live in the foreign gitdir. (c) guards the metadata but not the work tree, whose content commands read and write. (b) is the superset: it cannot admit anything (a) or (c) admits, and its only faithfulness risk is *over*-refusing a shape git might permit — a risk with no observable in the interop suite either, for the same reason it is unmeasurable. Cost is the R12 count: at most 3 `stat`s, deduplicated (a normal repo's `commonDir` equals its `gitDir` and its repository path is the parent of both, so it is 2). If the user prefers strict measured-only behaviour, (a) is coherent and the ADR should record the residual as accepted. |
| D9 | How the interop suite obtains an alien owner on **both** sides (§1j, Test strategy) | (a) real `chown` when the environment permits, `describe.skipIf` otherwise; the git-side `GIT_TEST_ASSUME_DIFFERENT_OWNER` used only to pin git's message/exit-code goldens; (b) ship `trust: 'allowlist'` — a public deny-by-default mode where ownership is ignored and only allowlisted directories are trusted — letting both sides be forced into the untrusted state and the suite run always-on; (c) an internal, non-barrel capability-injection seam on the node shim used only by tests | **(b), with (a) as the gated complement** | Measured: this machine cannot `chown` and has no password-less `sudo` (§1j), so (a) alone means the co-refusal rows **never run locally** and run in CI only if the job happens to have root — a suite that is green because it is empty, which the brief rightly calls worse than a skipped one. (b) is not a test hack: deny-by-default is a legitimate posture for an editor extension or CI runner that only ever opens user-approved paths, git ships the equivalent knob in its released binary, and it makes the entire §1e/§1f matching matrix an always-on, non-vacuous co-refusal against real git under ADO. (c) puts a test seam in production code with none of (b)'s user-facing value. Keeping (a) *as well*, gated on a concrete predicate, is what proves the uid comparison itself — the one thing (b) cannot prove. If the user rejects (b), the honest fallback is (a) alone plus an explicit note that the uid-read half is proven only in the unit tier. |
| D10 | What an untrusted repository's `repo.layout` exposes (§2) | (a) the structural layout plus `untrusted: true` — `core.bare` / `core.worktree` not applied; (b) `openRepository` throws, so no layout exists; (c) `repo.layout` throws or returns `undefined` when untrusted | **(a)** | (b) is measurably wrong: §1b pins `git init` succeeding inside an alien-owned repository, and tsgit's `init`/`clone` must bootstrap the same way — a throwing `openRepository` removes the only route to that. (c) turns a synchronous frozen-data read (ADR-658) into a partial function, and hides the one fact a caller debugging a refusal most needs. (a) is also the safe answer for the layout *values*: they are derived from discovery alone, so a caller who reads them is reading paths the attacker's config never touched, and `untrusted: true` sits in the same object saying so. |
| D11 | Which tier throws the two refusals, given that the `config` read verbs must not (§1b, §2) | (a) an untrusted repository reads as an **empty repository config scope** (one guard in `readConfig`) **and** the two refusals move to the operational tier the `config` read verbs skip; (b) both refusals in `assertRepository`, accepting that `repo.config.list()` throws where `git config --list` returns an empty list; (c) both in `assertRepository`, and repoint the `config` porcelain at a new trust-free assert | **(a)** | Measured, and not a nuance: under ADO a planted local `user.name` is **invisible** to `git config`, `core.bare = banana` stops refusing, and config **writes** refuse with the file byte-unchanged (§1b). (b) diverges on data ADR-249 says is binding — an empty list is a result, not a rendering — and it also *parses the attacker's config file* in order to then refuse, which is strictly worse security than not reading it. (c) reproduces the read behaviour but leaves the file parsed and adds a third assert whose only job is to be skipped. (a) is one guard that reproduces every measured row **and** dissolves both §1d ordering pins into a consequence rather than a rule to maintain: the downstream gates have nothing to read, so nothing has to be sequenced against them. Its cost is that `readConfig` gains a layout-dependent early return, and that the operational tier's exact membership (which verbs skip it) becomes load-bearing and must be enumerated in the docs page. |

## Test strategy

### Unit — the ownership predicate (`test/unit/index-node.test.ts` or a sibling)

`isOwnedByCaller` against a stubbed `stat`, each row isolated so no guard hides behind
another:

| case | expectation |
|---|---|
| `stat.uid === process uid` | `true` |
| `stat.uid !== process uid` | `false` |
| `stat.uid === 0`, process uid `0` | **`true`** — root reading root-owned metadata |
| `stat.uid === 0`, process uid `501` | **`false`** — the truthiness trap |
| `stat.uid === 501`, process uid `0` | `false` |
| `stat` rejects (absent path) | `true` — nothing to distrust; the `init`/`clone` bootstrap row |
| `process.getuid` absent (Windows shape) | `true`, and `stat` is **not called** — asserted through a counting stub |

### Unit — the allowlist matcher (`test/unit/domain/repository/allowlist.test.ts`)

The full §1e/§1f truth table with an array argument. Every row that has an analogue:
exact; trailing slash on the entry; trailing slash on the repository path; `*`; `$T/*`;
`$T/deep/a/*` at depth; `$T/normal/*` against `$T/normal` (must **not** match — the strictly-below
rule); `**` suffix (no match); parent directory (no match); case-flipped entry (no match);
empty array (no match — the lens-2 identity); an entry that is a prefix but not a path
boundary (`/srv/repo-evil` against entry `/srv/repo` — must not match, the classic
prefix-comparison bug `isContainedIn` guards against elsewhere).

### Property — `test/unit/domain/repository/allowlist.properties.test.ts`

Warranted under CLAUDE.md lenses 2 and 3; generators in a sibling `arbitraries.ts`, no
committed seeds.

- **Totality** (lens 3): `isAllowlisted(anyPath, anyEntries)` never throws over arbitrary
  printable-ASCII no-NUL paths and entry arrays — 100 runs.
- **Identity** (lens 2): the empty entry array always yields `false` — 200 runs.
- **Monotone extension** (lens 2): appending an entry never turns `true` into `false`; there
  is no negation in the array grammar (the reset semantic is explicitly not modelled, D5) —
  200 runs.
- **Wildcard absorption** (lens 2): an array containing `'*'` yields `true` for every path,
  whatever else it contains — 200 runs.
- **Prefix soundness** (lens 3): for arbitrary `p` and `q`, `isAllowlisted(p, [q + '/*'])`
  implies `p` starts with `q + '/'` **and** `p !== q` — 100 runs. This is the property that
  catches a naive `startsWith` regression, and its oracle is a string relation, not a copy
  of the production loop.

### Unit — the gate in `finishLayout` (`test/unit/repository/resolve-layout.test.ts`, extended)

A stub `LayoutProbe` carrying a controllable `isOwnedByCaller`, so the whole truth table
runs where CI cannot `chown`:

owned / alien × allowlisted (exact / `*` / `/*` / not) × `route` (`DISCOVERED` /
`BARE_DIR` / `EXPLICIT`) × gitdir basename (`.git` / other) × bare / non-bare ×
capability present / **omitted**, asserting for each cell: the `untrusted` flag, the
`implicitBare` flag, **whether `readRepositoryFormat` ran at all** (a counting stub — this is
the R4 assertion and the only place the "config never participates" guarantee is
mechanically enforced), and the resulting `layout.workDir` / `layout.bare`.

Dedicated rows, each triggering exactly one guard:

- `route === 'EXPLICIT'` with alien ownership and no allowlist ⇒ trusted, Stage 2 **ran**
  (R10, §1c).
- capability omitted with a foreign-looking fixture ⇒ trusted, Stage 2 ran (R13).
- untrusted + planted `core.worktree = /` ⇒ `layoutRootsOf(layout)` is **not** `['/']` —
  the Observed-exposure-#2 regression test, asserted on the root set itself.
- untrusted + planted `core.bare = banana` ⇒ resolves without throwing, because Stage 2
  never ran (the §1d ordering, expressed in tsgit's own terms — and the ADR-664 interaction
  of §2).
- `trust: 'always'` and `trustedDirectories: ['*']` each ⇒ trusted, tested separately so
  neither hides the other.
- The §1h basename pair as an isolated two-row test: identical layouts differing only in
  gitdir basename (`.git` vs `evil.git`) under `bareRepositories: 'explicit'` ⇒ only the
  second sets `implicitBare`. Plus `core.bare` flipped on both ⇒ **no change** to either
  verdict, which is the row that kills a bareness-conditioned mutant.
- The discovery-repository-path formula of §5, one row per §1c shape, asserting the `path`
  the refusal carries — including `$T/separate-work`-shaped gitfile discovery (origin, not the
  pointed-at gitdir) and linked-worktree discovery (worktree dir, not the common dir).

### Unit — the acceptance tier (`test/unit/application/primitives/internal/repo-state.test.ts`)

A Context whose layout carries (i) neither flag, (ii) `untrusted`, (iii) `implicitBare`,
(iv) **both** — asserting the payload (`path`, `gitDir`), never the class alone, and proving
the §1h ordering in case (iv) by asserting `IMPLICIT_BARE_REPOSITORY` specifically. Plus:

- a missing `HEAD` **and** `untrusted` ⇒ `NOT_A_REPOSITORY` (§1d's discovery-first row);
- `init` on an untrusted layout succeeding (R5, §7);
- **`readConfig` on an untrusted layout returns the empty parse and `<commonDir>/config` is
  not read at all** — a counting `fs` stub asserts zero reads. This is R5b, and it is the
  security half of D11, not merely its faithfulness half;
- `untrusted` **plus** a planted `core.bare = banana` ⇒ `assertDiscoveryBooleansValid` does
  **not** refuse (§1b's composite row);
- `untrusted` plus a planted local key ⇒ the config read verbs report it **absent** (§1b's
  planted-key row), while a config **write** verb refuses and the file is untouched;
- one test per representative operational command proving the refusal fires, and one per
  verb §1b measures as surviving (`init`, the config read verbs) proving it does not — the
  membership of that surviving set is load-bearing under D11(a) and belongs in the docs page
  rather than being left implicit.

### Interop — `test/integration/ownership-trust-gate-interop.test.ts` (new)

`@proves` docblock (`surface: openRepository`, `bucket: cross-tool-interop`,
`interopSurface: trust`), `describe.skipIf(!GIT_AVAILABLE)`, all git through
`interop-helpers.ts` (`GIT_*` scrubbed, isolated `HOME`, `GIT_CONFIG_NOSYSTEM`, signing
off), tmpdirs `realpath`-resolved, **one shared `beforeAll(fn, 60_000)` per scenario group**
(the hook-timeout class), and a fresh `openRepository` after any git-side write.

Three groups, with **concrete** availability predicates evaluated once in module scope:

```
GIT_ASSUME_DIFFERENT_OWNER =
  GIT_AVAILABLE && (in a throwaway `git init` repo, `git log` with
  GIT_TEST_ASSUME_DIFFERENT_OWNER=1 exits 128 AND stderr starts with
  'fatal: detected dubious ownership')          // guards a future git dropping the hatch

ALIEN_OWNER_AVAILABLE =
  await mkdtemp(...) then fs.chown(dir, processUid + 1, -1) resolves
  (EPERM or any other rejection ⇒ false)     // false on this machine, §1j
```

| group | gate | scenarios |
|---|---|---|
| **A — no escape hatch needed** | `skipIf(!GIT_AVAILABLE)` | the whole of §1h, co-refusing with `git -c safe.bareRepository=explicit`: refuse on `cd bare.git`, `cd bare.git/refs`, `cd nb3.git` (non-bare, other name) and `cd wrap/.git-other`; **must not** refuse on `cd wrap/.git` (byte-identical to `.git-other`), `cd normal/.git`, `cd config-bare` (bare via `core.bare`), or any explicit-`gitDir` invocation; and unchanged verdicts when `core.bare` is flipped on the `.git`-named and non-`.git`-named pair. Fully faithful, no forcing, every platform — and the byte-identical rename pair is what pins the predicate rather than a plausible reading of it. |
| **B — matching semantics** | `skipIf(!GIT_ASSUME_DIFFERENT_OWNER)`, plus D9's tsgit-side forcing mechanism being available | the §1e value grammar and the §1c named-path table, row by row: git forced alien with ADO and given `-c safe.directory=<v>`, tsgit forced alien per D9 and given `trustedDirectories: [<v>]`; assert the **verdicts agree** on every row, and that tsgit's reconstructed 4-line fatal (§1a, built from `data.path`) is byte-identical to git's stderr on the refusing rows. Also §1g: a `safe.directory` written into the repository's **own** config admits neither tool (R6). Also §1b's config rows: `git config --list` and `repo.config.list()` agree that the repository scope is empty, and a planted local key is invisible to both. |
| **C — the uid read itself** | `skipIf(!ALIEN_OWNER_AVAILABLE)` | `chown` a fixture repository to another uid, then: unmodified `git` refuses and unmodified `openRepository(...).log()` refuses with `DUBIOUS_OWNERSHIP { path }` naming the same path; allowlisting it admits both; `git init` and `repo.init()` both succeed on it (§7). This is the only group that proves the predicate reads a real uid, and it is expected to **skip** on developer machines and on any CI job without root. |

If D9 lands (a) rather than (b), group B loses its tsgit half; the honest shape is then a
git-side golden table asserted against the unit truth table of §5, with a comment naming the
gap. The design records this so the outcome is a decision, not a discovery.

### Parity — `test/parity/`

One assertion across the memory and browser drivers: a repository resolves and operates
normally with **no** trust option set and the capability omitted (R13) — the
capability-omitted-is-trusted path, adapter-independent by construction since all three
shims share `finishLayout`.

### Gates

Coverage per R14. App mutation budget on the new `domain/repository/` matcher, the touched
`repository/resolve-layout.ts`, `repository/validate-options.ts`, `ports/layout-probe.ts`
and `application/primitives/internal/repo-state.ts`. `test-pyramid-budgets.json` updated for
the new interop file; `check:write-surfaces` clean (`interopSurface: trust`);
`reports/api.json` regenerated and committed.

## Out of scope

- **The `core.repositoryformatversion` / `extensions.*` acceptance gate** — backlog 29.1,
  the sibling design landing first in the same PR. Shared surface: both refuse in
  `assertRepository`, and §1d measures the one ordering constraint between them (ownership
  shadows the format refusal, so the trust check precedes it). Nothing else is shared, and
  this design neither creates nor edits that doc.
- **Reading `safe.directory` / `safe.bareRepository` from any config file** — global and
  system are unreachable by the FS port by design, and repository-local is the attacker's
  file (§1g). The whole point of §4's divergence.
- **Environment-variable trust configuration** — no `GIT_TEST_ASSUME_DIFFERENT_OWNER`
  equivalent read from `process.env`, for the same no-environment rule that keeps
  `GIT_DIR` out (and which makes tsgit's explicit-route exemption safer than git's).
- **A Windows owner check** — D2; unmeasured, therefore undesigned. The ADR names the gap.
- **Content-based trust** — signature verification, hook allowlisting, a `hooks: 'prompt'`
  mode. The gate answers "who owns this", not "is this safe"; `hooks: false` and
  `command: false` remain the content-side mitigations and are unchanged.
- **Re-checking trust after open** — one verdict per `openRepository`, mirroring git's one
  per process. TOCTOU recorded in §9.
- **Permission-bit checks** (group- or world-writable directories you own) — not part of an
  ownership predicate, and not measured.
- **Local-path clone/fetch trust** — §1i measures git's asymmetry (`clone` from an alien
  local path refuses, `ls-remote` does not); tsgit has no local-path transport, so there is
  nothing to gate.
- **Any rendered output** — the refusals are data (ADR-249). git's 4-line fatal and its
  `git config --global --add safe.directory` hint are reconstructed inside the interop test,
  never emitted by the library.
