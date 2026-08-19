# Design — Ownership trust gate

> Brief: refuse to operate on a repository whose metadata the caller does not own, the way
> git's `safe.directory` does — because following someone else's repository metadata is
> code execution. Add an ownership predicate as an adapter capability, a caller-supplied
> trust configuration faithful in EFFECT to `safe.directory` while diverging in LOCATION,
> a `safe.bareRepository` equivalent, and place the gate so that no attacker-supplied
> config value acts before trust is established. Pin the whole matrix against canonical git.
> Status: **accepted** — all eleven load-bearing choices are settled in ADRs 669–679
> (§Decisions) and folded into §§2–10 as the design. §1's pinned matrix is unchanged
> evidence, extended with the rows this revision measured.

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
  widening `LayoutProbe.stat` with a `uid` field (ADR-669).
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
  Exactly two commands sit on the bare tier today — `config` (nine call sites) and `remote`
  (six) — and §1b measures git sparing only four of those fifteen. That gap is the subject
  of DN-1.
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
- **Three sibling designs, same PR.** `docs/design/repository-format-acceptance-gate.md`
  (the `core.repositoryformatversion` / `extensions.*` gate) lands **first**;
  [ADR-666](../adr/666-repository-format-refusals-keep-gits-config-porcelain-tier.md) puts
  its refusals on the **same tier** this design builds for the ownership refusal
  ([ADR-679](../adr/679-an-untrusted-repository-reads-as-an-empty-config-scope.md)), so the
  two gates share one mechanism rather than each maintaining its own (§2).
  `docs/design/sha256-object-format.md` and `docs/design/reftable-ref-storage.md` are the
  two subsystems [ADR-667](../adr/667-tsgit-accepts-every-extension-git-knows.md) pulled
  into this PR when it ratified accepting every `extensions.*` git knows. All three are
  designed separately; this design neither creates nor edits any of them, and nothing in
  the trust gate depends on their content.

## Requirements

R1. An ownership predicate exists as an **adapter capability**, not domain logic, and is
absent-by-omission on adapters that cannot answer it
([ADR-669](../adr/669-ownership-is-an-optional-layout-probe-capability.md)). Sandboxed
adapters (memory, browser) never report a foreign owner — and do so by omitting the
capability, not by returning a fabricated uid (the `uid: 0` trap above). Windows omits it
too, which is a named gap rather than an invented behaviour
([ADR-670](../adr/670-the-ownership-gate-is-posix-only.md)).

R2. On node/POSIX, a repository whose metadata is owned by a uid other than the process's
effective uid is **untrusted** unless the caller allowlists it, and the gate is **on by
default** ([ADR-672](../adr/672-the-ownership-gate-is-on-by-default.md)). `uid === 0` on
either side is an ordinary value: root-owned metadata read by a root process is trusted;
root-owned metadata read as uid 501 is not.

R2b. "The repository's metadata" is the **deduplicated union** of `gitDir`, `commonDir` and
the discovery repository path — every one of them must be owned
([ADR-676](../adr/676-the-ownership-predicate-checks-the-superset.md)). The refusal still
names, and the allowlist still keys on, the single repository path git names (§1c/§1e); the
widening applies to what is *checked*, never to what is *named* or *matched* (§3).

R3. The trust verdict is computed **after** Stage 1 locates the gitDir and **before** the
Stage-2 config read takes effect — proven, not asserted, by §2's call-site trace: no
config-derived value is consumed earlier.

R4. A **refused** repository's own config never participates in layout resolution — refused
on ownership *or* on the implicit-gitdir predicate, since §1h measures both producing the
same empty-scope posture. Stage 2 is skipped, so `core.bare` and `core.worktree` cannot widen
the containment root set, cannot fabricate a work tree, and cannot change the FS validator's
allowlist — the protection holds even before any command is issued.

R5. The refusal surfaces at the tier git's does
([ADR-679](../adr/679-an-untrusted-repository-reads-as-an-empty-config-scope.md)). Measured
(§1b): `init` still bootstraps in an alien-owned directory, existing repository or fresh;
config **writes** refuse and leave the file byte-unchanged; config **reads** succeed and
expose an **entirely empty repository scope** — a planted local key is invisible and a
malformed `core.bare` never refuses; everything else refuses, **`remote` included, in every
form, read and write alike** (measured). The surviving set is therefore exactly `init` plus
the config **read** verbs, and that set is a documented contract (R15), not an accident of
which assert a command happens to call.

R5b. A refused repository's config is **never parsed** — not at open (Stage 2, R4) and not by
`readConfig` at command time, whichever of the two verdicts refused it. Every config-derived
gate downstream therefore becomes a no-op by construction rather than by an explicit
precedence rule, which is what reproduces both §1d ordering pins and what keeps
`merge.<d>.driver`, `core.excludesFile` and `core.attributesFile` unread.

R6. The allowlist is **caller-supplied only**. No value read from any file inside the
repository — `<commonDir>/config`, `<gitDir>/config.worktree`, `include.path` targets —
can widen trust. Proven by a dedicated test, not by inspection.

R7. Allowlist matching reproduces git's measured verdicts on every §1e/§1f row that has an
argument-array analogue
([ADR-673](../adr/673-the-allowlist-models-gits-grammar-minus-its-string-surface.md)): exact
match, trailing-slash insensitivity, the `*` wildcard, the `/*` any-depth prefix, physical
(realpath) normalisation on adapters that expose it, case-sensitivity on this platform, and
non-matching for a parent directory, a `/*`-suffixed self-prefix, or a `**` suffix. The three
string-surface artefacts — the valueless-entry reset, the relative-value *warning*, and `.`
normalising against cwd — are deliberately not modelled (§5).

R8. Allowlist entries are the literal `'*'` or an absolute path; anything else — empty,
relative, `.`, `./` — is **refused** with `INVALID_OPTION` at `validateOptions`, following
[ADR-657](../adr/657-ceiling-dirs-are-absolute-only-and-refused-otherwise.md)'s precedent
for `ceilingDirs`, rather than silently warned-and-ignored as git's string surface does
(ADR-673).

R9. `safe.bareRepository = explicit` is modelled **now**, as `bareRepositories`
([ADR-675](../adr/675-safe-bare-repository-is-modelled-now.md)), on its **measured**
predicate, not its
name: with it set, a repository whose gitdir was reached by the cwd-is-a-gitdir route under
a basename other than `.git` refuses, regardless of whether it is bare; every other shape —
an explicit `gitDir` argument, a `.git`-named gitdir walked into, and a `.git`-entry
discovery — proceeds, again regardless of bareness (§1h). Its refusal precedes the
ownership refusal, as measured.

R10. The explicit-`gitDir` route is exempt from both gates, matching git exactly (§1c) —
and the exemption is safe here for a reason git cannot claim: tsgit reads no environment,
so the path can only come from the caller's own argument.

R11. Public-surface additions are additive: `OpenRepositoryOptions` gains exactly three
trust fields, `RepositoryLayout` gains two verdict flags, `RepositoryError` gains two codes
(§10). No existing field changes type, and nothing is added for the test harness'
convenience ([ADR-677](../adr/677-no-deny-by-default-trust-mode.md)).

R12. Cost is bounded and stated: **one to three extra `stat` calls per `openRepository`**
— one per distinct path in R2b's deduplicated union, and the union collapses by shape
(§3) — **zero** per command, zero on adapters that omit the capability, and zero when the
allowlist or `trust: 'always'` short-circuits ahead of it. No hot path is touched.

R13. Sandboxed adapters (memory, browser) and the whole existing test fleet keep working
unchanged: with the capability omitted the verdict is *trusted*, and that is expressed in
exactly one place, not scattered across the three shims.

R14. 100% line/branch/function/statement coverage on touched code inside the coverage scope
(`domain/`, `ports/`, `adapters/node/`, `adapters/memory/`, `operators/`); app mutation
budget on every touched file; every pinned row in §1 that tsgit can express is backed by a
unit truth-table row, and every row both tools can express **without a tsgit-side alien
owner** is backed by an interop assertion. Rows that need one are gated on the stated skip
predicate of Test strategy and never run vacuously (ADR-677).

R15. The set of verbs that survive on an untrusted repository is a **documented contract**
— enumerated on the `openRepository` docs page, asserted verb-by-verb in the unit tier, and
identical to the set the sibling format gate publishes, because ADR-666 and ADR-679 put both
gates on one tier. Membership is load-bearing: a verb silently moving between tiers is a
faithfulness regression with no other alarm.

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
| `show-ref`, `symbolic-ref HEAD`, `notes list`, `stash list`, `worktree list`, `submodule status`, `describe`, `check-ignore -q a.txt`, `count-objects` | 128 | same |
| `remote`, `remote -v`, `remote get-url origin`, `remote show -n origin` | **128** | same — **every `remote` read verb refuses**; `remote` is *not* a surviving gentle-setup verb |
| `remote add …`, `remote rename …`, `remote set-url …` | 128 | same, and the repository config file is byte-unchanged (sha compared before/after) |
| `var GIT_AUTHOR_IDENT` | **0** | — consults no repository scope |
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
| `config --get-all remote.origin.url` / `config --get-regexp ^remote` with two remotes configured | exit 1, no output — the whole scope, not just single-key lookup, is gone |
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

**The surviving set, measured well enough to publish (R15).** Only `init`, the config
**read** verbs and `var` exit 0 under ADO; every other repository-needing verb refuses with
the §1a fatal. `remote` is the row worth stating loudly, because the shared-tier decision
(ADR-666 with ADR-679) invites the opposite guess: `remote`, `remote -v`,
`remote get-url origin` and `remote show -n origin` all exit **128** under ADO, and the same
battery exits **128** on a `repositoryformatversion = 99` repository with no ownership
problem at all. The two gates *do* drop the repository config scope identically —
`config --list` prints exactly the same non-repository keys in both cases, verified
side-by-side — but neither of them spares `remote`. ADR-666's decision text names "the
`config` and `remote` read verbs" as the surviving pair; the measurement says `config` only,
on both gates. tsgit's `remote` porcelain therefore runs the operational tier alongside
every other command, and §10 publishes the set accordingly.

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
on. Neither shadowing is reproduced as a precedence *rule*: under
[ADR-679](../adr/679-an-untrusted-repository-reads-as-an-empty-config-scope.md) an untrusted
repository's config scope reads empty, so the layout-config gate and the sibling
repository-format gate both find nothing to refuse on (§2). The second row is the interlock
with the sibling design, and one shared mechanism satisfies it — neither gate maintains an
ordering against the other.

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
not modelled (§5,
[ADR-673](../adr/673-the-allowlist-models-gits-grammar-minus-its-string-surface.md)).

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
| `config --list` in `$T/bare.git` | ALLOW (exit 0) — and the repository scope is **empty**: with `user.name = PlantedLocalValue` written locally beforehand, the value is absent from the listing |
| `config user.name` (same fixture, same planted key) | **exit 1, no output** — invisible, exactly as under ADO (§1b) |
| `config --local --list` | 128, `fatal: --local can only be used inside a git repository` — the same *different* fatal as §1b |
| `config user.name Written` (a write) | 128, `fatal: not in a git directory`; the planted value is unchanged afterwards |
| `remote -v` | 128, the bareRepository fatal — `remote` is no more spared here than under ADO |
| `init --bare .` in `$T/bare.git` | ALLOW (exit 0, re-uses the existing repository) |
| bogus value (`banana`) | `fatal: unable to parse 'safe.barerepository' from command-line config`, 128 |
| repository-local `safe.bareRepository = explicit` | **ignored** (§1g) |
| ADO + `explicit`, `cd $T/bare.git` | **bareRepository** fatal — it precedes the ownership one |
| ADO + `safe.directory=*` + `explicit`, `cd $T/bare.git` | **bareRepository** fatal — `safe.directory` does not lift it |
| ADO + `explicit`, `cd $T/config-bare` (predicate does not apply) | dubious-ownership fatal |
| ADO + `safe.directory=*` + `explicit`, `cd $T/config-bare` | exit 0 |

The two gates are independent, and this one fires first.

**And the two gates share one posture, measured rather than assumed.** The five config rows
above are byte-for-byte the behaviour §1b measures under ADO: empty repository scope, planted
key invisible, `--local --list` refusing with its own fatal, writes refusing with
`not in a git directory` and leaving the file untouched. So the mechanism
[ADR-679](../adr/679-an-untrusted-repository-reads-as-an-empty-config-scope.md) ratifies for
ownership is the *same* mechanism this refusal needs — which has two consequences the design
takes up in §2: the `readConfig` guard keys on **either** verdict, not on `untrusted` alone,
and the whole empty-scope contract becomes provable against real git **with no alien owner
at all** (Test strategy, group A).

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

Two consequences, both load-bearing, and both settled rather than open:

1. **Which of the gitfile / work tree / gitdir git actually `stat`s is not measurable
   here.** ADO forces all of them to fail at once, so the only observables are (a) which
   single path is *named*, and (b) which single path the allowlist keys on — both fully
   pinned in §1c/§1e.
   [ADR-676](../adr/676-the-ownership-predicate-checks-the-superset.md) converts that
   unmeasurable into a deliberate choice: check the superset, accept the over-refusal risk,
   record it (§9) — rather than infer git's choice from a measurement that cannot exist.
2. **The interop suite cannot manufacture an alien owner on both sides.** It would need a
   real `chown` — root, or a container — because
   [ADR-677](../adr/677-no-deny-by-default-trust-mode.md) declines to add a tsgit-side
   equivalent of ADO. **This table is the justification for the skip predicate**: the rows
   above are exactly why `ALIEN_OWNER_AVAILABLE` is false on this machine and on any CI job
   without root, and why the co-refusal group must *announce* its skip rather than quietly
   pass. The full ownership truth table consequently lives in the unit tier over the ADR-669
   capability stub, and the uid comparison itself is proven only where a real alien owner
   exists — an accepted residual, stated in Test strategy and again in §9.

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
  accepted := trusted && !implicitBare                         # §1h: same posture, measured

  # ── Stage 2, now conditional ────────────────────────────────────────────
  fmt := accepted ? await readRepositoryFormat(probe, outcome.gitDir, commonDir, pathPolicy)
                  : EMPTY_FORMAT                               # { bare: undefined,
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

**Consequences of skipping Stage 2 when a repository is refused (R4).** The same reasoning
covers both verdicts. Applying an `implicitBare` repository's `core.worktree` while
`repo.config.list()` reports its scope empty would be an internal contradiction, and the
security argument is identical: a planted `evil.git` inside your own clone is owned by you,
so only this gate stops it, and its `core.worktree = /` must not reach `layoutRootsOf` on
the way to being refused. No `core.worktree`, so
`resolveWorkTree` falls through to the structural rows: `origin` on the `DISCOVERED` route,
none on `BARE_DIR`. `layoutRootsOf` therefore sees only paths discovery itself produced —
the root-set collapse of Observed exposure #2 is structurally impossible, before any
command is issued and independently of whether the caller ever calls one. No `core.bare`
either, so `layout.bare` is the structural default (`bareCfg` unset is truthy —
`resolve-layout.ts:210-212`): `false` on `DISCOVERED`, `true` on `BARE_DIR`. Since every
command refuses, the only observable is `repo.layout` itself, which carries `untrusted: true`
(or `implicitBare: true`) alongside it — a caller reading the layout of a refused repository
is told why in the same object (ADR-678).

**Where the refusal is thrown, and how the orderings fall out.** `openRepository` itself must
resolve: §1b measures `git init` succeeding inside an alien-owned repository, and `init`
runs no acceptance gate. That leaves two behaviours to place, and
[ADR-679](../adr/679-an-untrusted-repository-reads-as-an-empty-config-scope.md) ratifies
them as one mechanism, not two rules:

1. **The repository config scope reads as empty when the layout carries either verdict** —
   `layout.untrusted` **or** `layout.implicitBare`, which §1h measures as producing the same
   five config rows as ADO does. One guard in `readConfig`
   (`src/application/primitives/config-read.ts:168`) returns the empty parse rather than
   reading `<commonDir>/config`. This single change reproduces every measured
   config row: a planted local key is invisible, `core.bare = banana` never refuses, the
   sibling format gate never sees `repositoryformatversion = 99`. **No explicit precedence
   rule is needed** for §1d's two ordering pins — the downstream gates have nothing to read,
   which is exactly why git appears to check ownership "first". It is also the safer
   behaviour on its own terms: the attacker's file is not parsed at all.
2. **Every verb outside the measured surviving set refuses**, with the two flags read
   synchronously off the frozen layout:

```
assertRepository(ctx):                       # the gated default (DN-1(a))
  hasUsableHead                          → NOT_A_REPOSITORY   (§1d: discovery failure first)
  ctx.layout.implicitBare                → IMPLICIT_BARE_REPOSITORY   (§1h precedes ownership)
  ctx.layout.untrusted                   → DUBIOUS_OWNERSHIP
  [the sibling repository-format gate]   → (ADR-666 puts it on this same tier; a no-op when
                                            refused, because the scope is already empty)
  assertDiscoveryBooleansValid           → (no-op when refused: the scope is empty)

assertRepositoryForConfigRead(ctx):          # the four measured survivors opt out
  hasUsableHead                          → NOT_A_REPOSITORY
  assertDiscoveryBooleansValid           → (no-op when refused: the scope is empty)
```

Four orderings, each measured rather than chosen. Discovery failure comes first: §1d pins
`fatal: not a git repository` surviving ADO unchanged, so a missing or unusable `HEAD` still
reports `NOT_A_REPOSITORY` on an untrusted layout. `implicitBare` precedes `untrusted`, the
one explicit ordering §1h measures between the two. Both precede everything config-derived —
the sibling format gate, `assertDiscoveryBooleansValid`, and `assertEagerConfigValid`'s
`[core]` validation one tier up — which needs no rule, because by then the scope is empty.
And both refusals are synchronous reads of frozen fields: no I/O, no per-command cost (R12).

**The surviving set is narrower than tsgit's existing bare tier, and that gap is the one
thing this section cannot settle from an ADR.** Measured (§1b), exactly four verbs survive:
`repo.config.get`, `.getAll`, `.getRegexp` and `.list`, each returning an empty repository
scope. tsgit today puts fifteen call sites on the bare `assertRepository` — all nine
`config` verbs (`src/application/commands/config.ts:47…269`) and all six `remote` verbs
(`src/application/commands/remote.ts:118…329`) — so wiring the refusals into
`assertOperationalRepository` as it stands would leave **five config writers and every
`remote` verb surviving on an untrusted repository**, which is both unfaithful and, for the
writers, a hole: `repo.config.set()` would write into the attacker's config file where git
refuses with the file byte-unchanged. Attaching the refusals therefore requires repointing
call sites, and the shape of that repointing is a live decision — **DN-1** in §Decisions.
The rest of this document assumes DN-1's recommendation: the acceptance refusals live in
`assertRepository`, so every verb is gated by default, and the four measured survivors are
the ones that opt out under an explicitly-named assert. On that shape `remote` and the five
config writers need no edit at all — they already call `assertRepository` — and the write
side needs no separate rule.

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
  if (self === undefined) return true;          // no POSIX owner model here (ADR-670)
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
  and it is a divergence, not an accident
  ([ADR-670](../adr/670-the-ownership-gate-is-posix-only.md), §9).

`fileSystemLayoutProbe` (`file-system-layout-probe.ts:10`) does **not** gain the member: its
`FileSystem` sources are the sandboxed adapters, which fabricate `uid: 0`
(`memory-file-system.ts:472`, `browser-file-system.ts:305`). Deriving a predicate from that
value would declare every memory/browser repository foreign-owned for any non-root process —
the trap that makes "widen `LayoutProbe.stat` with `uid`" the wrong shape
([ADR-669](../adr/669-ownership-is-an-optional-layout-probe-capability.md)). Omitting the
member is the single place R13's "trusted in a sandbox" lives, and ADR-669 makes the omission
a documented answer — *trusted* — rather than an unhandled case.

**Composing the verdict — which paths are checked.** The capability answers about one path;
the gate asks about a set:

```
isTrusted(probe, outcome, commonDir, trustOpts, pathPolicy):
  if trustOpts.trust === 'always'                  → true
  repoPath := outcome.route === 'DISCOVERED' ? outcome.origin : outcome.gitDir    # §5
  # repoPath and the entries are canonicalised per §5 (realpath on node, lexical in sandboxes)
  if isAllowlisted(repoPath, trustOpts.trustedDirectories)
                                                   → true    # keys on ONE path (§1e)
  if probe.isOwnedByCaller === undefined           → true    # capability omitted (ADR-669)
  checked := dedupe([outcome.gitDir, commonDir, repoPath])   # the ADR-676 superset
  → every path in `checked` is owned
```

Three properties, each measured or ratified, and each easy to blur together:

- **What is *checked* is a set; what is *named* and what is *matched* stay one path.**
  [ADR-676](../adr/676-the-ownership-predicate-checks-the-superset.md) widens the ownership
  question only. `DUBIOUS_OWNERSHIP` still carries the single §1c repository path, and
  `trustedDirectories` still keys on that same one path — both measured, neither changed by
  the widening.
- **The allowlist short-circuits the ownership check entirely**, which is why widening cannot
  break a measured row. §1e row 2 pins it: with the work tree allowlisted, git admits a
  `.git` file pointing at a gitdir elsewhere *under ADO* — that is, with every candidate path
  forced alien. The superset therefore only ever changes the case where **nothing matched the
  allowlist**, which is
  precisely where ADR-676's accepted over-refusal risk lives (§9).
- **The dedup arithmetic is what bounds R12's cost**, and it collapses by layout shape:

| shape | `gitDir` | `commonDir` | repository path | distinct ⇒ `stat`s |
|---|---|---|---|---|
| bare, `BARE_DIR` (`$T/bare.git`) | `$T/bare.git` | = `gitDir` | = `gitDir` | **1** |
| normal discovered (`$T/normal`) | `$T/normal/.git` | = `gitDir` | `$T/normal` | **2** |
| `.git` file → separate gitdir | `$T/separate-git` | = `gitDir` | `$T/separate-work` | **2** |
| linked worktree (`$T/wt`) | `$T/normal/.git/worktrees/wt` | `$T/normal/.git` | `$T/wt` | **3** |
| explicit `gitDir` | — | — | — | **0** — the route is ungated (§1c) |

At most three, two in the common case, one for a bare repository, zero on the explicit
route — and zero again whenever `trust: 'always'` or the allowlist answers first.

### 4. Trust configuration — faithful in effect, divergent in location

git sources `safe.directory` and `safe.bareRepository` from **protected** configuration —
system, global, command line — and refuses them from the repository (§1g). tsgit's FS port
deliberately cannot reach global or system config; `readConfig` parses `<commonDir>/config`
only, which is precisely the attacker-controlled file. The faithful *effect* — a trust
decision the repository cannot influence — is therefore expressed as **caller arguments**:

```ts
/**
 * Trust policy for repositories reached by discovery. Defaults to `'ownership'`.
 * Ignored on the explicit-`gitDir` route, which is never gated.
 */
readonly trust?: 'ownership' | 'always';
/** Absolute directories trusted regardless of ownership. The single entry `'*'` trusts every repository. */
readonly trustedDirectories?: ReadonlyArray<string>;
/**
 * git's `safe.bareRepository`. `'explicit'` refuses a repository whose gitdir was reached
 * by walking into it under a name other than `.git` (§1h) — an "implicit" repository
 * directory. Defaults to `'all'`. An explicit `gitDir` argument is always accepted.
 */
readonly bareRepositories?: 'all' | 'explicit';
```

That is the **whole** trust surface — three optional fields, no fourth
([ADR-671](../adr/671-trust-options-are-named-for-what-they-do.md),
[ADR-675](../adr/675-safe-bare-repository-is-modelled-now.md)). Each is named for what it
does rather than after git's config key, and each sits at the top level of
`OpenRepositoryOptions` beside `hooks`, `command` and `ceilingDirs` — the other trust-shaped
knobs — never under `config`.

Two defaults carry weight. `trust` defaults to `'ownership'`, so **the gate is on**
([ADR-672](../adr/672-the-ownership-gate-is-on-by-default.md)): the library must not be less
safe by default than the `git` binary the same user already trusts on the same machine, and
the blast radius is measurably narrower than git's because the explicit-`gitDir` route — the
common programmatic shape — is ungated (§1c). It is nonetheless a breaking behavioural change
for discovery-route callers on foreign-owned repositories, and belongs in the release notes,
not only in the docs page. `bareRepositories` defaults to `'all'`, matching git, so nothing
changes for existing callers there.

**No deny-by-default mode ships.** A third `trust` value that ignored ownership and trusted
only allowlisted directories was considered and rejected
([ADR-677](../adr/677-no-deny-by-default-trust-mode.md)): its immediate motivation was making
the interop suite always-on, and a public API mode is not the place to solve a test-harness
problem. Test strategy carries the consequence.

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

The grammar is ADR-673's: every measured row with an array analogue, and none of the three
string-surface artefacts (the table at the end of this section names each absence and why).

`repoPath` is the **discovery repository path** — one path, not the ADR-676 checked set:

```
repoPath = outcome.route === 'DISCOVERED' ? outcome.origin : outcome.gitDir
```

This is the asymmetry §3 spells out and the one place it is easiest to get wrong: the
ownership predicate runs over `dedupe([gitDir, commonDir, repoPath])`, while the allowlist
matches `repoPath` alone. Widening the matcher to the same set would silently break §1e's
measured rows — allowlisting `$T/normal/.git` must **refuse** and allowlisting the common dir
of a linked worktree must **refuse** — so the two must not be unified for symmetry's sake.

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

Distinct codes rather than one code with a `reason` discriminant
([ADR-674](../adr/674-two-trust-refusal-codes.md)): git has two conditions, two messages and
a measured ordering between them (§1h), and distinct codes kill the `StringLiteral` mutants
a shared code would survive. It follows the ADR-654 precedent — two work-tree refusal codes
for two measured conditions. Payloads are asserted directly, never via
`toThrow(ErrorClass)`.

**The second code's name is deliberately imprecise, and that carries an obligation.**
ADR-674 ratifies `IMPLICIT_BARE_REPOSITORY` because it follows git's
`cannot use bare repository` fatal, keeping the tie between the tsgit code and the line a
user will search for; `IMPLICIT_GIT_DIR` would describe the predicate accurately and break
that tie. The measured predicate has **nothing to do with bareness** — two byte-identical
copies of one gitdir land on opposite verdicts on basename alone, and flipping `core.bare`
changes neither verdict (§1h). Because the name is known to mislead, ADR-674 requires the
predicate to be stated exactly wherever the code appears: in the code's JSDoc, in its row in
`docs/use/errors.md`, and here.

> `IMPLICIT_BARE_REPOSITORY` fires when discovery reached the gitdir by the cwd-is-a-gitdir
> route **and** the gitdir's basename is not literally `.git`, with
> `bareRepositories: 'explicit'` set. Whether the repository is bare — by `core.bare`, or by
> what `--is-bare-repository` would report — plays no part in the condition.

Nothing downstream may infer bareness from the name: not a caller branching on the code, not
a docs sentence, not a test title. A test named "Then it refuses a bare repository" would be
describing behaviour the design measured as absent.

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
| a config **write** verb (`config user.name x`) | refuses, `fatal: not in a git directory`, file byte-unchanged | refuses — `repo.config.set` / `.unset` / `.unsetAll` / `.renameSection` / `.removeSection` are gated, which under DN-1's recommendation needs no edit because they already call `assertRepository` |
| a config **read** verb | exit 0, repository scope empty, planted key invisible | empty repository scope (ADR-679) — the file is not parsed at all, which is a strict improvement on git's own posture |
| a `remote` verb, read or write | refuses, 128, config file byte-unchanged (measured, §1b) | refuses — `repo.remote.*` is gated like any other command; it is **not** a surviving gentle-setup verb |
| any other read/write command on an alien repository | refuses | refuses |

Read path and write path therefore agree on the same predicate and the same tier, and the
asymmetry git exhibits (`init` yes, the four config readers with an empty scope, everything
else no) is reproduced by *where* the gate lives rather than by a special case inside it.
The write side is the row worth re-reading: an ungated `repo.config.set()` on an untrusted
repository would not merely diverge, it would **write into the attacker's config file** — the
concrete reason §2 treats the surviving-set membership as load-bearing rather than tidy-up.

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
resolution, upstream of adapter composition, and is enforced by the acceptance tier. Opting
out of containment therefore makes the gate *more* load-bearing, not less — which is the
right direction, and worth one sentence in that option's JSDoc.

### 9. Threat model

This section extends [bare-repo-custom-gitdir](bare-repo-custom-gitdir.md) §9, which
recorded this exposure as deferred; it does not restate it.

**What the gate closes**

| asset | exposure before | closed by |
|---|---|---|
| `hooks/` in the discovered common dir, spawned by the node `HookRunner` with the caller's full `process.env` including secrets | arbitrary code execution on the first hook-firing command against any planted repository the walk reaches | no command runs on an untrusted repository — the acceptance tier refuses before any hook resolution |
| `merge.<d>.driver` — a shell command from the repository's own config | command execution through a merge on attacker-supplied content | the config file is **never parsed** — not at open (Stage 2 skipped, R4) and not at command time (R5b, ADR-679) — and no operational command runs |
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
| **Windows** — `process.getuid` is absent, the capability is omitted, every repository is trusted ([ADR-670](../adr/670-the-ownership-gate-is-posix-only.md)) | git-for-windows uses a security-descriptor owner check this design has **not measured** (no Windows host available). The divergence is documented rather than guessed, and ADR-672's on-by-default makes it a user-visible inconsistency across platforms. It matters: CI runs the unit matrix on `windows-latest`, where the omitted-capability path is what gets exercised. Closing it needs a measurement first, not a design |
| Sandboxed adapters (memory, browser) | no foreign ownership exists; OPFS content is same-origin caller-controlled |
| Group- or world-writable directories that you own | tsgit consults ownership only; permission bits are not part of the predicate |
| TOCTOU between the open-time check and later reads | the verdict is computed once per `openRepository`, as git computes it once per process. A repository whose owner changes mid-session is not re-judged |
| Which of gitfile / work tree / gitdir git itself `stat`s (§1j) | not measurable without root. [ADR-676](../adr/676-the-ownership-predicate-checks-the-superset.md) makes tsgit's choice explicit — check the superset — instead of inferring git's |
| **Over-refusal**: tsgit may refuse a shape git permits — repository path owned, `gitDir` or `commonDir` alien, nothing allowlisted (ADR-676) | accepted deliberately, in the direction of over-refusing rather than under-refusing. It has **no observable in the interop suite**, for the same reason it was unmeasurable in the first place (§1j), so no test can catch a regression here — only this row and the ADR record it. The escape hatch is `trustedDirectories`, which short-circuits the whole set (§3) |
| **The uid comparison itself is proven only where a real alien owner exists** ([ADR-677](../adr/677-no-deny-by-default-trust-mode.md)) | the ownership *semantics* are proven exhaustively in the unit tier over the ADR-669 capability stub, but a stub cannot prove that the node adapter reads a real `stat.uid` and compares it to a real process uid. That half runs only where `chown` to another uid succeeds — not on this machine, not on a CI job without root (§1j). ADR-677 accepts the residual rather than adding a public API mode to dissolve it; Test strategy makes the skip loud so a green suite is never mistaken for a covered one |

**What it costs**

- One to three extra `stat` calls per `openRepository` — ADR-676 fixes the set and §3's
  table fixes the count by shape; zero per command; zero when the capability is omitted, and
  zero again when the allowlist or `trust: 'always'` answers first (R12).
- Callers who legitimately operate on repositories owned by another user — CI containers
  with mismatched user ids, shared checkouts, network mounts — must pass `trustedDirectories`.
  This is exactly the friction `safe.directory` is famous for, and it is the price of the
  first four rows above.
- One new public option group, two new error codes, one new layout flag pair.

### 10. Public surface

**Three options**, all on `OpenRepositoryOptions` at the top level (ADR-671), each with a
WARNING-register JSDoc matching `hooks` / `command` / `unsafeRawAdapters`:

| option | type | default | effect |
|---|---|---|---|
| `trust` | `'ownership' \| 'always'` | **`'ownership'`** (ADR-672) | `'always'` disables the ownership predicate on the discovery routes; it never affects `bareRepositories` |
| `trustedDirectories` | `ReadonlyArray<string>` | `[]` | absolute paths or the literal `'*'` (ADR-673); a match short-circuits the ownership check (§3) and does **not** lift the `bareRepositories` refusal (§1h) |
| `bareRepositories` | `'all' \| 'explicit'` | **`'all'`** (ADR-675) | `'explicit'` refuses the implicit-gitdir shape of §6's boxed predicate |

**Two error codes** on `RepositoryError`, each with a factory beside the others and one arm
in `extractDetail` (ADR-674): `DUBIOUS_OWNERSHIP { path }` and
`IMPLICIT_BARE_REPOSITORY { gitDir }`. The second carries §6's predicate verbatim in its
JSDoc, because its name does not describe it.

**Two layout flags** on `RepositoryLayout` / `RepositoryLayoutInput` (ADR-678):
`untrusted?: true` and `implicitBare?: true`, following the existing
`workTreeConfigBogus?: true` present-only-when-true idiom (`src/repository.ts:161-162`).
Additive; `repo.layout` (ADR-658) exposes them. Flags rather than a `route` field: `route` is
a resolution-time discriminant with no meaning to a consumer, while these two are verdicts a
consumer acts on, and the idiom for "a layout-level verdict the acceptance tier reads
synchronously" is already established one line above them. An untrusted layout carries only
what discovery produced — no `core.bare`, no `core.worktree` — so a caller reading it reads
paths the attacker's config never touched.

**The surviving-verb contract (R15).** On an untrusted repository, exactly these succeed:

| surface | behaviour on an untrusted repository |
|---|---|
| `openRepository` | resolves; `repo.layout.untrusted === true` |
| `init`, `clone` | bootstrap normally — they run no acceptance tier (§7) |
| `repo.config.get`, `.getAll`, `.getRegexp`, `.list` | succeed with an **empty repository scope**; a planted local key reports absent |
| everything else — including all five `repo.config` write verbs and all six `repo.remote` verbs | refuses with `IMPLICIT_BARE_REPOSITORY`, else `DUBIOUS_OWNERSHIP` |

That table is the contract, not a summary of one: it goes on the `openRepository` docs page
verbatim, and the unit tier asserts it verb by verb. It is also identical to the set the
sibling format gate publishes, because ADR-666 and ADR-679 put both gates on one tier.

Supporting changes:

- `LayoutProbe` gains an optional `isOwnedByCaller` (ADR-669); like the port itself
  (ADR-535) it stays out of the public barrel.
- `readConfig` (`src/application/primitives/config-read.ts:168`) gains one layout-dependent
  early return (ADR-679); its memoisation is unchanged.
- Call sites move per DN-1's resolution; under the recommendation that is the four config
  **read** verbs opting out, and nothing else.
- `reports/api.json` regenerated and committed at pre-PR — a pre-push gate, and a
  cached-green `validate` can precede a red prepush.
- Docs: `docs/use/errors.md` (two codes, the second carrying §6's predicate),
  `docs/understand/security.md` (a `## Repository trust` section — the file's
  `## What tsgit does NOT do` closing section needs the residuals of §9, ADR-670's Windows
  gap among them), `docs/understand/repository-layout.md` and `docs/get-started/node.md`
  (the option table, the surviving-verb table, and the shared-repository recipe). ADR-672's
  default-on is a breaking behavioural change and belongs in the release notes too.

## Decisions (settled — ADRs 669–679)

All eleven decision candidates are resolved. "ratified" = the user made the call;
"adopted-as-recommended" = the designer's recommendation stood with no user judgment needed.
**One landed against the recommendation** (D9), and that row says so, because a design that
hides where it was overruled is a design nobody can audit.

| # | Choice | Settled choice | vs recommendation | ADR | What changed in this doc |
|---|---|---|---|---|---|
| D1 | Shape of the ownership capability | Optional `LayoutProbe.isOwnedByCaller?: (path) => Promise<boolean>`; **omission means trusted** | as recommended | [669](../adr/669-ownership-is-an-optional-layout-probe-capability.md) | §3 states omission-as-a-documented-answer rather than arguing for it; the `uid: 0` trap stops being a rejected-alternative argument and becomes the reason the sandbox shims wire nothing. R1 cites the ADR |
| D2 | Windows | POSIX-only — wired only where `process.getuid` exists; Windows is trusted and the gap is **named** | as recommended | [670](../adr/670-the-ownership-gate-is-posix-only.md) | §3's third bullet and §9's Windows residual now state the closing condition (a Windows-hosted measurement of git-for-windows' owner predicate) rather than the option space. R1 carries it |
| D3 | Trust-option surface | `trust` + `trustedDirectories` as sibling top-level options, named for what they do | as recommended | [671](../adr/671-trust-options-are-named-for-what-they-do.md) | §4 lost its "names are still open" parenthetical and now presents the surface as final; §10 tabulates it |
| D4 | Default posture | **ON by default** — `trust` defaults to `'ownership'` | **ratified** by the user | [672](../adr/672-the-ownership-gate-is-on-by-default.md) | §4 states the default, the narrower-than-git blast radius, and the release-note obligation for a breaking behavioural change. R2 carries it |
| D5 | Allowlist grammar | Exact + trailing-slash-insensitive + `*` + `/*` any-depth prefix, absolute-only, realpath'd on node / lexical in sandboxes | as recommended | [673](../adr/673-the-allowlist-models-gits-grammar-minus-its-string-surface.md) | §5 opens by naming the grammar as ADR-673's; R7 names the three string-surface artefacts that are deliberately absent, inline, so the absence reads as a decision |
| D6 | Error taxonomy | Two codes; the second **named `IMPLICIT_BARE_REPOSITORY`** despite the predicate having nothing to do with bareness | **ratified** by the user | [674](../adr/674-two-trust-refusal-codes.md) | §6 gains the boxed predicate statement and the three-place obligation (JSDoc, `docs/use/errors.md`, here) the ADR attaches to keeping git's name. §10 repeats the obligation on the code row |
| D7 | `safe.bareRepository` | Model it **now**, as `bareRepositories?: 'all' \| 'explicit'` | **ratified** by the user | [675](../adr/675-safe-bare-repository-is-modelled-now.md) | R9, §4 and §10 state it as shipping surface; Test strategy promotes it to the **anchor** of the interop suite, since it is the one part provable end-to-end against real git |
| D8 | Which path(s) the predicate checks | The **superset**: deduplicated union of `gitDir`, `commonDir` and the discovery repository path | as recommended | [676](../adr/676-the-ownership-predicate-checks-the-superset.md) | The largest structural addition. §3 gains the `isTrusted` composition, the allowlist short-circuit, and the dedup arithmetic table (1/2/3 `stat`s by shape); §5 spells out the check-set / named-path / allowlist-key asymmetry; R2b is new; §9 gains the over-refusal residual; R12's count is now derived rather than asserted |
| D9 | How the interop suite obtains an alien owner on both sides | **No deny-by-default `trust` mode.** Skip-predicate-gated co-refusal; `GIT_TEST_ASSUME_DIFFERENT_OWNER` still pins git's own bytes; the ownership truth table moves to the unit tier over the ADR-669 stub | **against** the recommendation of shipping `trust: 'allowlist'` | [677](../adr/677-no-deny-by-default-trust-mode.md) | Test strategy is rebuilt: the unit tier carries the full truth table, the interop groups are re-cut into always-on and gated halves, and the skip predicate is written out with what it probes, what makes it skip and what it logs. §4 states that no third `trust` value ships; §9 gains the uid-coverage residual; §1j consequence 2 becomes the justification for the predicate rather than a pointer to an open question |
| D10 | What an untrusted `repo.layout` exposes | Structural layout plus `untrusted: true`; `core.bare` / `core.worktree` not applied | as recommended | [678](../adr/678-an-untrusted-repository-still-exposes-its-structural-layout.md) | §10 states both flags and the discovery-only content as the ratified contract; §2's consequences paragraph is unchanged because this is what it already described |
| D11 | Which tier throws | An untrusted repository reads as an **empty config scope**, and the refusals sit on a tier the config read verbs skip | as recommended, and reinforced by the user's ADR-666 choice for the sibling gate | [679](../adr/679-an-untrusted-repository-reads-as-an-empty-config-scope.md) | §2's two ordering pins are restated as a *consequence* of the shared mechanism, and §1d's interlock sentence with them; the sibling format gate now shares this tier rather than sequencing against it. Resolving it is also what surfaced **DN-1** below |

### New and unsettled — surfaced by this revision

Two load-bearing choices no ADR covers. Both are consequences of ratified decisions rather
than reopenings of them.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DN-1 | **Where the acceptance refusals attach**, now that the measured surviving set (four config read verbs) is narrower than tsgit's existing bare-`assertRepository` membership (fifteen call sites: nine `config`, six `remote`) | (a) **Invert the default** — the refusals go into `assertRepository`, and the four measured survivors move to an explicitly-named opt-out assert (`assertRepositoryForConfigRead`-shaped); **4** call sites change; (b) **a third tier** — `assertAcceptedRepository` = `assertRepository` + the refusals; the five config writers and six `remote` sites repoint to it, the four readers keep the bare one, `assertOperationalRepository` composes on top; **11** call sites change; (c) **move the offenders to `assertOperationalRepository`** — the same 11 sites, which then additionally gain `assertEagerConfigValid`'s `[core]` validation | **(a)** | This is not tidy-up: measured (§1b), every `remote` verb and every config **write** verb refuses under ADO, yet all fifteen sit on the tier ADR-679 keeps ungated. Left as-is, `repo.config.set()` would **write into the attacker's config file** where git refuses with the file byte-unchanged. (c) is the smallest conceptual change but silently alters `[core]` validation for `remote` and the config writers — behaviour outside this feature and unmeasured, so it would be a divergence adopted by accident. (b) is exactly the "third assert whose only job is to be skipped" shape ADR-679 already declined, and it leaves the *unsafe* default in place: a command added next year that calls `assertRepository` survives on an untrusted repository and nothing complains. (a) inverts that — a new verb is gated unless its author writes the opt-out name, and writing it is a statement they have checked the measurement. It is also the smallest diff, and it puts the exception exactly where the evidence is: on the four verbs git is measured to spare. Whatever lands binds the sibling format design identically (ADR-666 shares the tier), so it should be decided once for both docs |
| DN-2 | **Whether `DUBIOUS_OWNERSHIP` surfaces which path failed**, now that ADR-676 checks a set but names one path | (a) payload stays `{ path }` — exactly the path git names, nothing more; (b) payload gains an optional `foreignPath` naming the member of §3's checked set that failed, while `path` keeps naming the repository path; (c) `path` names the failing path instead | **(b)** | ADR-676 makes it routine for the refusal to name a directory the caller **owns** — repository path owned, `gitDir` alien — and `{ path }` alone then points at the one path that is fine, with no way for the caller to learn which path to fix or allowlist. That is a diagnostic regression created by the combination of two ratified decisions, which is why no ADR covers it. (c) is measurably wrong: it breaks §1c/§1e's named-path rows and the interop reconstruction of git's four-line fatal. (b) is additive and interop-neutral — the reconstruction reads `path` alone, so not one interop row changes — and it is structured data, not rendering (ADR-249). Cost is one optional field, one `api.json` regeneration, one `docs/use/errors.md` row. If the user prefers the strictly-measured payload, (a) is coherent, but then the diagnostic gap should be stated in `docs/use/errors.md` so a caller reading a refusal about a directory they own is not left guessing |

## Test strategy

[ADR-677](../adr/677-no-deny-by-default-trust-mode.md) fixes the division of labour, and it
is not the usual one. Because no deny-by-default mode ships, **the ownership semantics are
proven in the unit tier** over the ADR-669 capability stub, not against real git. The interop
tier proves the two halves that need no tsgit-side alien owner: ADR-675's `bareRepositories`
matrix, which needs none at all, and git's own refusal bytes and exit codes under
`GIT_TEST_ASSUME_DIFFERENT_OWNER`. The one thing neither reaches — that the node adapter reads
a real `stat.uid` and compares it to a real process uid — runs only where the environment can
produce a real alien owner, behind the predicate stated below.

Three rules follow, and they are the point of this section: the unit truth table must be
**exhaustive**, because nothing downstream re-proves it; the gated group must **announce** its
skip, because a vacuously green test is worse than a visibly absent one; and no ungated group
may quietly depend on the gated one for its meaning.

### Unit — the ownership predicate (`test/unit/index-node.test.ts` or a sibling)

`isOwnedByCaller` against a stubbed `stat`, each row isolated so no guard hides behind
another. This proves the adapter-level predicate in isolation; the gate's *composition* over
it is the `finishLayout` table below.

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
  is no negation in the array grammar (the reset semantic is explicitly not modelled,
  ADR-673) — 200 runs.
- **Wildcard absorption** (lens 2): an array containing `'*'` yields `true` for every path,
  whatever else it contains — 200 runs.
- **Prefix soundness** (lens 3): for arbitrary `p` and `q`, `isAllowlisted(p, [q + '/*'])`
  implies `p` starts with `q + '/'` **and** `p !== q` — 100 runs. This is the property that
  catches a naive `startsWith` regression, and its oracle is a string relation, not a copy
  of the production loop.

### Unit — the gate in `finishLayout` (`test/unit/repository/resolve-layout.test.ts`, extended)

**This is the home of the full ownership truth table (ADR-677), and it is load-bearing in a
way the other unit sections are not: no interop row re-proves any of it.** A stub
`LayoutProbe` carrying a controllable, per-path `isOwnedByCaller` makes every cell reachable
where CI cannot `chown`:

owned / alien × allowlisted (exact / trailing-slash / `*` / `/*` / not) × `route`
(`DISCOVERED` / `BARE_DIR` / `EXPLICIT`) × gitdir basename (`.git` / other) × bare /
non-bare × capability present / **omitted**, asserting for each cell: the `untrusted` flag,
the `implicitBare` flag, **whether `readRepositoryFormat` ran at all** (a counting stub —
this is the R4 assertion and the only place the "config never participates" guarantee is
mechanically enforced), and the resulting `layout.workDir` / `layout.bare`.

The stub answers **per path**, not per repository, which is what makes ADR-676's checked set
testable. A recording stub captures the exact argument list, so each of these is a row:

- **alien `gitDir`, owned repository path, nothing allowlisted** ⇒ untrusted. This is the
  shape ADR-676 exists for, and the one a single-path predicate would admit.
- **alien `commonDir`, owned `gitDir` and repository path** (the linked-worktree shape) ⇒
  untrusted.
- **owned everywhere** ⇒ trusted, with the recorded argument list asserted against §3's
  dedup table: **1** query for `BARE_DIR`, **2** for a normal discovery and for the gitfile
  shape, **3** for a linked worktree. Asserting the count, not just the verdict, is what
  keeps R12's cost claim honest and kills an "un-deduplicated set" mutant.
- **allowlisted repository path with every path alien** ⇒ trusted **and the capability is
  never called** — the short-circuit of §3, asserted through the same recording stub. This
  is also the row that preserves §1e row 2 (a work tree admitting a foreign gitdir).
- **`trust: 'always'` with every path alien** ⇒ trusted, capability never called.

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
- `implicitBare` with **owned** metadata and no allowlist ⇒ `untrusted` is **absent**, and
  Stage 2 still did **not** run — the `accepted := trusted && !implicitBare` conjunction of
  §2, which a mutant reducing it to `trusted` alone would otherwise survive. Paired with a
  planted `core.worktree = /` on the same fixture, asserting the root set again.
- The discovery-repository-path formula of §5, one row per §1c shape, asserting the `path`
  the refusal carries — including `$T/separate-work`-shaped gitfile discovery (origin, not the
  pointed-at gitdir) and linked-worktree discovery (worktree dir, not the common dir).

### Unit — the acceptance tier (`test/unit/application/primitives/internal/repo-state.test.ts`)

A Context whose layout carries (i) neither flag, (ii) `untrusted`, (iii) `implicitBare`,
(iv) **both** — asserting the payload (`path`, `gitDir`), never the class alone, and proving
the §1h ordering in case (iv) by asserting `IMPLICIT_BARE_REPOSITORY` specifically. Plus:

- a missing `HEAD` **and** `untrusted` ⇒ `NOT_A_REPOSITORY` (§1d's discovery-first row);
- `init` on an untrusted layout succeeding (R5, §7);
- **`readConfig` on a refused layout returns the empty parse and `<commonDir>/config` is not
  read at all** — a counting `fs` stub asserts zero reads. This is R5b, and it is the
  security half of ADR-679, not merely its faithfulness half. Two rows, `untrusted` and
  `implicitBare` **separately**, because §1h measures both and one guard covering both is
  exactly the shape where a single test hides a missing disjunct;
- `untrusted` **plus** a planted `core.bare = banana` ⇒ `assertDiscoveryBooleansValid` does
  **not** refuse (§1b's composite row);
- `untrusted` plus a planted local key ⇒ the config read verbs report it **absent** (§1b's
  planted-key row), while a config **write** verb refuses and the file is untouched.

**The surviving-verb contract, asserted verb by verb (R15).** §10's table is a contract, so
it is tested as one rather than sampled: the four survivors — `repo.config.get`, `.getAll`,
`.getRegexp`, `.list` — each succeed with an empty repository scope, and every non-survivor
refuses. The five config **writers** and all six `repo.remote` verbs get their own explicit
rows, because they are the ones tsgit currently leaves on the ungated tier (§2, DN-1) and a
regression there is silent: the writers would write into the attacker's file, and `remote`
would answer from it. A representative operational command (`log`) covers the rest.
Whichever way DN-1 resolves, these rows are unchanged — they assert behaviour, not tier
membership, which is exactly why the contract belongs in the docs page and the test rather
than in the shape of the call graph.

### Interop — `test/integration/ownership-trust-gate-interop.test.ts` (new)

`@proves` docblock (`surface: openRepository`, `bucket: cross-tool-interop`,
`interopSurface: trust`), `describe.skipIf(!GIT_AVAILABLE)`, all git through
`interop-helpers.ts` (`GIT_*` scrubbed, isolated `HOME`, `GIT_CONFIG_NOSYSTEM`, signing
off), tmpdirs `realpath`-resolved, **one shared `beforeAll(fn, 60_000)` per scenario group**
(the hook-timeout class), and a fresh `openRepository` after any git-side write.

Three groups. **Two are always-on**, and between them they carry more than ADR-677 assumed:
§1h's measurement that the `bareRepositories` refusal produces the *same* empty-config-scope
posture as the ownership one means the whole ADR-679 mechanism can be co-refused against real
git with no alien owner anywhere. The third group is gated, and its gate is written out in
full below, because under ADR-677 it is not a convenience — it is the suite's honesty
mechanism.

**The predicates, evaluated once in module scope, before any `describe`:**

```
GIT_ASSUME_DIFFERENT_OWNER =
  GIT_AVAILABLE && (in a throwaway `git init` repo, `git log` with
  GIT_TEST_ASSUME_DIFFERENT_OWNER=1 exits 128 AND stderr starts with
  'fatal: detected dubious ownership')          // guards a future git dropping the hatch

ALIEN_OWNER_AVAILABLE =
  probe:  mkdtemp() → fs.chown(dir, <any uid ≠ process.getuid()>, -1)
                    → fs.stat(dir) → rm -rf
  true  ⇔ the chown RESOLVES *and* the re-stat reports stat.uid !== process.getuid()
  false ⇔ process.getuid is undefined                    (Windows, ADR-670)
        ∨ the chown rejects                              (EPERM — this machine, and any
                                                          non-root POSIX job, §1j)
        ∨ the chown resolves but the re-stat still
          reports the caller's uid                       (a mount that accepts chown as a
                                                          no-op)
```

The re-stat is not defensive padding. Without it, a filesystem that silently ignores `chown`
would run group C against a fixture the caller still owns, and every assertion in it would
pass — for the wrong reason. That is precisely the vacuous green ADR-677 refuses, so the
verdict is taken from what `stat` reports, never from the absence of a rejection.

**What it logs when it skips.** A `false` verdict emits exactly one `console.warn` at module
scope, before the suite runs:

```
[ownership-trust-gate-interop] group C SKIPPED — no alien-owned fixture is creatable here
  (reason: <EPERM from chown | process.getuid unavailable | chown was a no-op>).
  NOT covered by this run: that the node adapter compares a real stat.uid to a real
  process uid. Its semantics ARE covered by the unit truth table in
  test/unit/repository/resolve-layout.test.ts.
```

Naming the reason, the uncovered claim, and where the claim *is* covered is what stops a
reader treating the skip as "nothing to see here". `describe.skipIf` keeps the group visible
in the reporter as *skipped* rather than absent, and the group title repeats the condition so
the CI log carries it even when the warning scrolls away.

| group | gate | scenarios |
|---|---|---|
| **A — the anchor: `bareRepositories`, both sides, always on** | `skipIf(!GIT_AVAILABLE)` | ADR-675 makes this the one part of the feature provable end-to-end against real git, on every platform, with no forcing and no escape hatch — so it carries the suite. **The predicate**, co-refusing with `git -c safe.bareRepository=explicit`: refuse on `cd bare.git`, `cd bare.git/refs`, `cd nb3.git` (non-bare, other name) and `cd wrap/.git-other`; **must not** refuse on `cd wrap/.git` (byte-identical to `.git-other`), `cd normal/.git`, `cd config-bare` (bare via `core.bare`), or any explicit-`gitDir` invocation; unchanged verdicts when `core.bare` is flipped on the `.git`-named and non-`.git`-named pair — the byte-identical rename pair is what pins the predicate rather than a plausible reading of it. **And the whole ADR-679 mechanism**, on the same fixtures, because §1h measures this refusal producing the identical empty-scope posture: with `user.name` planted locally, `git config user.name` and `repo.config.get` both report it absent; `git config --list` and `repo.config.list()` both omit the repository scope; a write refuses on both sides and leaves the value byte-unchanged; `remote` refuses on both sides. This is the group that makes the empty-config-scope contract a co-truth rather than a tsgit-side assertion. |
| **B — git's own bytes, always on wherever the hatch exists** | `skipIf(!GIT_ASSUME_DIFFERENT_OWNER)` | Everything about git's side that needs no tsgit-side alien owner. The §1a refusal: exit 128, empty stdout, the four-line stderr byte-for-byte, single-quoted path on line 1 and unquoted on line 4 — asserted against tsgit's reconstruction of the same bytes from a synthesised `DUBIOUS_OWNERSHIP { path }`, which is how ADR-249 keeps the rendering out of the library and still pinned. The §1c named-path table, one row per route. The §1e value grammar as a **git-side golden table**, each row asserted against `isAllowlisted`'s verdict on the same inputs (§5), so the matcher and git agree row-for-row by construction rather than by eyeball. §1h's ordering rows (the bareRepository fatal precedes the ownership one; `safe.directory=*` does not lift it). §1g: a `safe.directory` written into the repository's **own** config admits neither tool (R6). What this group cannot do is refuse on tsgit's side for an ownership reason — that is group C, and no assertion here may be phrased as though it had. |
| **C — the uid read itself, gated** | `skipIf(!ALIEN_OWNER_AVAILABLE)` | `chown` a fixture repository to another uid, then: unmodified `git` refuses and unmodified `openRepository(…).log()` refuses with `DUBIOUS_OWNERSHIP { path }` naming the same path; `trustedDirectories: [path]` admits both; `git init` and `repo.init()` both succeed on it (§7); and the ADR-676 superset row — `chown` the gitdir alone, leave the work tree owned, and assert tsgit refuses (git's verdict here is *not* asserted, since ADR-676 accepted that it may differ and §9 records it). This is the only group that proves the predicate reads a real uid. It is **expected to skip** on developer machines and on any CI job without root, and the warning above is what makes that expectation visible rather than silent. |

The shape of this suite is a direct consequence of ADR-677, and the doc states the residual
plainly rather than letting a green run imply otherwise: **groups A and B prove everything
except the uid comparison; the uid comparison is proven in the unit tier by construction and
against a real alien owner only where one can exist.** No assertion in A or B may be worded
so that a reader takes it for coverage of C.

### Parity — `test/parity/`

One assertion across the memory and browser drivers: a repository resolves and operates
normally with **no** trust option set and the capability omitted (R13) — the
capability-omitted-is-trusted path, adapter-independent by construction since all three
shims share `finishLayout`.

### Gates

Coverage per R14. App mutation budget on the new `domain/repository/` matcher, the touched
`repository/resolve-layout.ts`, `repository/validate-options.ts`, `ports/layout-probe.ts`,
`application/primitives/config-read.ts`, `application/primitives/internal/repo-state.ts`,
and whichever command files DN-1 repoints (under its recommendation, `commands/config.ts`
only). `test-pyramid-budgets.json` updated for the new interop file;
`check:write-surfaces` clean (`interopSurface: trust`); `reports/api.json` regenerated and
committed.

## Out of scope

- **The `core.repositoryformatversion` / `extensions.*` acceptance gate** —
  `docs/design/repository-format-acceptance-gate.md`, in this PR but separately designed.
  Shared surface: ADR-666 puts its refusals on the tier ADR-679 builds here, so the two gates
  express one rule and §1d's ordering pin is satisfied by that shared mechanism rather than
  by either gate sequencing against the other. **DN-1 binds both** and should be resolved
  once. Nothing else is shared, and this design neither creates nor edits that doc.
- **SHA-256 object format** (`docs/design/sha256-object-format.md`) and **reftable ref
  storage** (`docs/design/reftable-ref-storage.md`) — in this PR but separately designed, and
  new: ADR-667 pulled them in when it ratified accepting every `extensions.*` git knows,
  rather than accepting names tsgit would then misread. Neither interacts with the trust
  gate: both sit at the point of use, downstream of acceptance, and an untrusted repository
  never reaches them.
- **Reading `safe.directory` / `safe.bareRepository` from any config file** — global and
  system are unreachable by the FS port by design, and repository-local is the attacker's
  file (§1g). The whole point of §4's divergence.
- **Environment-variable trust configuration** — no `GIT_TEST_ASSUME_DIFFERENT_OWNER`
  equivalent read from `process.env`, for the same no-environment rule that keeps
  `GIT_DIR` out (and which makes tsgit's explicit-route exemption safer than git's).
- **A Windows owner check** — [ADR-670](../adr/670-the-ownership-gate-is-posix-only.md);
  unmeasured, therefore undesigned. Closing it needs a Windows-hosted measurement of
  git-for-windows' refusal bytes and owner predicate first, not a design.
- **A deny-by-default `trust` mode** — [ADR-677](../adr/677-no-deny-by-default-trust-mode.md)
  rejected `trust: 'allowlist'`. The public surface is the three options of §4 and nothing
  added for the test harness; the consequence is the gated interop group of Test strategy and
  the residual in §9.
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
