# Design — Repository-format acceptance gate

> Brief: refuse a repository whose `core.repositoryformatversion` exceeds 1, and — at
> version 1 — whose `extensions.*` carry a key tsgit does not understand, the way canonical
> git refuses them: on every command, with the version/extension set surfaced as structured
> data. tsgit today opens a version-99 repository, and reports a SHA-256 repository as
> corrupt rather than unsupported.
> Status: draft → self-reviewed ×3 → awaiting the decision-candidate conversation

## Context

### What exists today

Layout resolution runs in stages (`src/repository/resolve-layout.ts`). **Stage 2** reads the
repository-format keys from the gitDir's own config *before* a work tree is decided and
before a `Context` exists:

```ts
// src/repository/resolve-layout.ts:198-199 (finishLayout)
const commonDir = outcome.commonDir ?? outcome.gitDir;
const fmt = await readRepositoryFormat(probe, outcome.gitDir, commonDir, pathPolicy);
```

`readRepositoryFormat` (`src/repository/read-repository-format.ts`, 168 lines) tokenises
`<commonDir>/config` once and extracts exactly three keys:

```ts
interface RepositoryFormat {
  readonly bare: boolean | undefined;
  readonly worktree: string | undefined;
  readonly worktreeConfig: boolean;   // extensions.worktreeConfig
}
```

It already owns the machinery this feature needs: `scanConfigFile` (absent/non-regular ⇒
`undefined`, deliberately lenient so `init`/`clone` can bootstrap), `lastTopLevelEntry`
(last-wins, case-insensitive on section and key, 1-based `line`), `pickScoped`
(`<gitDir>/config.worktree` beats `<commonDir>/config` when `extensions.worktreeConfig` is
true), and it already **throws at open time** — `configBadBooleanValue` for a malformed
`core.bare`, `configMissingValue` for a valueless `core.worktree` ([ADR-664]).

The other candidate home is the **every-command tier**
(`src/application/primitives/internal/repo-state.ts`):

```ts
// repo-state.ts:89-96
export const assertRepository = async (ctx: Context): Promise<FilePath> => {
  if (!(await hasUsableHead(ctx))) throw notARepository(…);
  await assertDiscoveryBooleansValid(ctx);      // core.bare, extensions.worktreeConfig
  return (ctx.layout.workDir ?? ctx.layout.gitDir) as FilePath;
};
```

`assertRepository` is taken by `config.ts` (9 sites) and `remote.ts` (6 sites); every other
command takes `assertOperationalRepository`, which adds the `[core]` gate the `config`
porcelain deliberately skips ([ADR-639]). That two-tier split is why "which tier?" is a real
question here and not a formality — §1f measures a **third** tier that neither of them is.

The integer grammar is already in the domain: `parseGitInt`
(`src/domain/config/config-ini.ts:750`) implements git's `strtoimax` base-0 grammar —
decimal, `0x` hex, leading-`0` octal, one optional sign, a single `k`/`m`/`g` unit ×1024ⁿ,
int64 bounds — returning `{ ok: true, value }` or `{ ok: false, reason: 'invalid unit' |
'out of range' }`. §1a shows it matches git 2.55.0 on **every** measured version literal,
so the version's value grammar needs no new code and no new error code
(`CONFIG_BAD_NUMERIC_VALUE` already carries `{ key, source, value, reason }`).

### Observed failure (measured, not assumed)

Driven through `openRepository` from `src/index.node.ts` against fixtures built by real git
(throwaway root, probe removed after measuring):

| fixture | canonical git | tsgit today |
|---|---|---|
| `core.repositoryformatversion = 99` | `fatal: Expected git repo version <= 1, found 99` (128) | **opens**, `log` returns the commit |
| v1 + `extensions.bogus = 1` | `fatal: unknown repository extension found:<LF><TAB>bogus<LF>` (128) | **opens**, `log` returns the commit |
| v0 + `extensions.objectFormat = sha256` | `fatal: repo version is 0, but v1-only extension found:<LF><TAB>objectFormat<LF>` (128) | **opens**, `log` returns the commit |
| `core.repositoryformatversion = abc` | `fatal: bad numeric config value 'abc' for 'core.repositoryformatversion' in file .git/config: invalid unit` (128) | **opens**, `log` returns the commit |
| a real `git init --object-format=sha256` repo (v1 + `extensions.objectFormat = sha256`) | works — git reads 64-hex ids | **opens**, then throws `OBJECT_HASH_MISMATCH` on the first object read |

The last row is the dangerous one and the reason this is a gate rather than a nicety: tsgit
does not refuse an unsupported object format, it *misreads* one and reports the result as
**data corruption**. A caller cannot distinguish "this repository is fine, your library
cannot read it" from "this repository is damaged".

### Binding constraints

- **Prime directive** ([ADR-226]): match canonical git's observable data and on-disk state.
  Every row in §1 is pinned against **git 2.55.0** in a `mktemp -d` throwaway with `env -i`,
  isolated `HOME`, `XDG_CONFIG_HOME` under it, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*`
  scrubbed, signing off — never recalled.
- **Structured output** ([ADR-249]): the refusal is **data** — the parsed version number and
  the offending extension names. No rendered `fatal:` line, no `warning:` line, no
  singular/plural selection (derivable from the list length); the interop test reconstructs
  git's bytes from the fields.
- Existing decisions this must not contradict: [ADR-639] (the eager `[core]` tier the config
  porcelain skips), [ADR-661] (the layout read includes `config.worktree`), [ADR-664]
  (layout-config refusals surface at open time).
- Branded types, no `any`, functions < 20 lines, no suppression directives, 100 % coverage on
  touched code inside the coverage scope (`src/repository/` and `src/application/` are
  outside it; `src/domain/` is inside).

## Requirements

**R1.** A repository whose effective `core.repositoryformatversion` is > 1 is refused, with
the **parsed integer** carried as structured data. Values ≤ 1 — including negatives — are
accepted, as is an absent key and an absent config file (§1a).

**R2.** The version's value grammar is git's: `parseGitInt`'s verdict decides, and a value it
rejects raises `CONFIG_BAD_NUMERIC_VALUE` with git's own `reason`, not the new code (§1a).

**R3.** At version 1, an `extensions.*` entry whose qualified name is outside the accepted
set is refused, carrying **every** offending name in config-file order (§1b, §1c).

**R4.** At version 0, unknown extension names are **ignored**, and the five names git treats
as v1-only are refused with a distinct condition. With the version key **absent** (or
negative), *neither* extension arm fires — absent is a third state, never folded into `0`
(§1c).

**R5.** The refusal fires on every route — discovery (`.git` dir, `.git` file,
cwd-is-gitdir), explicit `gitDir`, the fixed-entry browser shim, and from inside a linked
worktree via the common config (§1f).

**R6.** The format keys are read from `<commonDir>/config` **only**. A
`core.repositoryformatversion` or `extensions.*` planted in `<gitDir>/config.worktree` is
inert, even when `extensions.worktreeConfig` is on (§1e).

**R7.** `extensions.worktreeConfig` keeps being honoured at version 0 — today's
version-unconditional gate is faithful and must not gain a version condition (§1e).

**R8.** Refusal precedence matches git's: structure → config syntax and per-line value
grammar → version → v1-only-at-v0 → unknown-at-v1 (§1d).

**R9.** Discovery does not climb past an unacceptable repository to an enclosing acceptable
one (§1f).

**R10.** Bootstrap leniency is preserved for an **absent** config and withdrawn for a
present-but-unacceptable one: `init` against an existing v99 repository refuses (§1g).

**R11.** Write/read symmetry: everything tsgit writes stays re-openable by tsgit and by git —
`bootstrapRepository` writes `repositoryformatversion = 0` and no `[extensions]`, so no
tsgit-created repository can trip its own gate.

**R12.** Every pinned row in §1 is backed by an interop assertion that reconstructs git's
exact stderr bytes and exit code from the structured fields.

## Design

### 1. Pinned matrix — canonical git 2.55.0

Probe conditions as stated in Binding constraints. `$T` is the throwaway root; the fixture is
a one-commit repository unless noted. `git log --oneline` and `git status --porcelain` were
measured together on every §1a row and never disagreed, so only one column is shown.

#### 1a. `core.repositoryformatversion` — value grammar and acceptance

| value | parsed | exit | stderr |
|---|---|---|---|
| `0` | 0 | 0 | — |
| `1` | 1 | 0 | — |
| `-1` | -1 | **0** | — (the test is `> 1`, not membership in `{0,1}`) |
| `+1` | 1 | 0 | — |
| `1` with surrounding spaces | 1 | 0 | — |
| `0x1` | 1 | 0 | — (base-0: hex) |
| `2` | 2 | 128 | `fatal: Expected git repo version <= 1, found 2` |
| `3` | 3 | 128 | `… found 3` |
| `99` | 99 | 128 | `… found 99` |
| `0777` | 511 | 128 | `… found 511` (base-0: octal) |
| `1k` | 1024 | 128 | `… found 1024` — the **parsed** integer, never the literal |
| `abc` | — | 128 | `fatal: bad numeric config value 'abc' for 'core.repositoryformatversion' in file .git/config: invalid unit` |
| the empty string | — | 128 | `… value '' … : invalid unit` |
| `1.0` | — | 128 | `… value '1.0' … : invalid unit` |
| `08` | — | 128 | `… value '08' … : invalid unit` (octal run stops at `0`; `8` is not a unit) |
| valueless (no `=`) | — | 128 | `… value '' … : invalid unit` |
| `9223372036854775808` | — | 128 | `… : out of range` |
| `-9223372036854775809` | — | 128 | `… : out of range` |
| `999999999999999999999999999999` | — | 128 | `… : out of range` |

Exact bytes, `od`-verified: `fatal: Expected git repo version <= 1, found 99\n`.

Every row above is reproduced by the existing `parseGitInt` — including `0777` → 511,
`08` → `invalid unit`, and both `out of range` bounds. Resolution and duplicates:

| config | verdict |
|---|---|
| `= 0`, then `= 99`, then `= 0` | **accepted** — the effective value is **last-wins** |
| `= 0`, then `= 0`, then `= 99` | refused (99) |
| `= abc` on an early line, then `= 0` later | refused, `bad numeric … 'abc'` — a parse failure fires **per line**, and is not rescued by a later valid line |
| `= 0` first, then `= abc` | refused, `bad numeric … 'abc'` |
| `[CoRe]` / `RePoSiToRyFoRmAtVeRsIoN = 99` | refused — section and key are case-insensitive |
| `[core "x"] repositoryformatversion = 99` | **accepted (ignored)** — a subsectioned `core` is not `[core]` |
| an `[extensions]` block placed **before** `[core]` | no effect on either check |
| the key **absent** entirely | accepted |
| the whole `.git/config` file **absent** | accepted |

So the version has two distinct resolution models on one key, and both must be reproduced:
**any** malformed occurrence refuses (streaming), while the accepted/refused decision uses
the **last** well-formed occurrence. This is the `core.maxTreeDepth` split
(`repo-state.ts:160-180`) with the halves swapped, and it is why the version cannot be folded
into the existing line-ordered `pickLowerLine` reduction.

#### 1b. The extension registry git 2.55.0 knows

Probed by planting `[extensions] <name> = <value>` at version 1 and reading the verdict.
Nine names are accepted; **every** other name probed (`reftable`, `sparseIndex`,
`commitGraph`, `midx`, `objectFormatV2`, `fsmonitor`, `promisor`, `grafts`, `bogus`,
`alsoBogus`, `zzz`, `aaa`, `mmm`) was rejected as unknown.

| extension | at v1 | at v0 | value grammar | tsgit today |
|---|---|---|---|---|
| `noop` | accepted | accepted (ignored) | value never parsed — `noop = banana` is accepted | nothing to do |
| `noop-v1` | accepted | **v1-only refusal** | value never parsed | nothing to do |
| `worktreeConfig` | accepted | accepted **and honoured** | boolean; `banana` ⇒ `fatal: bad boolean config value 'banana' for 'extensions.worktreeconfig'`; valueless ⇒ true | **implemented** (`readRepositoryFormat`) |
| `preciousObjects` | accepted | accepted (ignored) | boolean; same refusals | **not implemented** — no reference anywhere in `src/` |
| `partialClone` | accepted | accepted (ignored) | string; valueless ⇒ `error: missing value for 'extensions.partialclone'` + `fatal: bad config line N in file <F>` | **implemented** — promisor plumbing in `fetch-pack.ts`, `read-object.ts`, `has-object.ts`, `clone.ts` |
| `relativeWorktrees` | accepted | **v1-only refusal** | boolean; same refusals | **not implemented** |
| `objectFormat` | accepted | **v1-only refusal** | enum `sha1`/`sha256`; anything else ⇒ `error: invalid value for 'extensions.objectFormat': '<v>'` (key lower-cased in the real bytes) + `fatal: bad config line N in file <F>` | **not implemented** — misread as SHA-1 (Context) |
| `compatObjectFormat` | accepted | **v1-only refusal** | enum; `sha1` on this build ⇒ `fatal: compatibility hash algorithm support requires Rust` | **not implemented** |
| `refStorage` | accepted | **v1-only refusal** | enum `files`/`reftable`; else the same `invalid value` pair | **not implemented** — no `reftable` reference in `src/` |

#### 1c. The extension refusals — exact shapes, and the version that selects them

`<LF>` and `<TAB>` stand for the literal bytes. Extension names are shown with their
config-file spelling; git emits them **lower-cased** (the rule stated below the table).

| condition | stderr | exit |
|---|---|---|
| v1, one unknown | `fatal: unknown repository extension found:<LF><TAB>bogus<LF>` (`od`-verified) | 128 |
| v1, two unknown (`bogus`, `alsoBogus`) | `fatal: unknown repository extensions found:<LF><TAB>bogus<LF><TAB>alsoBogus<LF>` | 128 |
| v1, three unknown (`zzz`, `aaa`, `mmm` in that file order) | `…extensions found:<LF><TAB>zzz<LF><TAB>aaa<LF><TAB>mmm<LF>` — **config-file order**, not sorted | 128 |
| v1, the same unknown name twice | listed **twice** — `<TAB>bogus<LF><TAB>bogus<LF>` | 128 |
| v1, unknown **valueless** (`bogus` with no `=`) | same single-name refusal — the value is never consulted | 128 |
| v1, `[extensions "X"] bogus = 1` | `…extension found:<LF><TAB>X.bogus<LF>` — **subsection case preserved**, key lower-cased | 128 |
| v1, `[extensions ""] bogus = 1` | `…extension found:<LF><TAB>.bogus<LF>` | 128 |
| v1, `[extensions "x"] worktreeConfig = true` | `…extension found:<LF><TAB>x.worktreeConfig<LF>` — a subsectioned known name is **not** known | 128 |
| v0, one v1-only (`objectFormat`) | `fatal: repo version is 0, but v1-only extension found:<LF><TAB>objectFormat<LF>` | 128 |
| v0, two v1-only (`objectFormat`, `refStorage`) | `fatal: repo version is 0, but v1-only extensions found:<LF><TAB>objectFormat<LF><TAB>refStorage<LF>` | 128 |
| v0, unknown names (any, including subsectioned) | **silently ignored**, exit 0 | 0 |
| v0, v1-only **and** unknown together | the v1-only refusal; the unknown name is ignored | 128 |

**An absent version is a third state, not `0`** — and it changes which extension arm fires.
Measured, with the extension planted and the version varied:

| version | + `extensions.objectFormat = sha1` (v1-only) | + `extensions.bogus = 1` (unknown) |
|---|---|---|
| key absent | **accepted** | **accepted** |
| `-5` | **accepted** | — |
| `-1` | **accepted** | **accepted** |
| `0` | refused (v1-only) | accepted (ignored) |
| `1` | accepted | refused (unknown) |
| `2` / `99` | refused (version) | refused (version) |

So the three predicates are literal and independent, and none of them may be reached by
folding "absent" into `0`:

```
refuse VERSION   when version > 1
refuse UNKNOWN   when version >= 1  and unknown names are present     (⇒ version === 1, VERSION having already refused)
refuse V1_ONLY   when version === 0 and v1-only names are present
```

Reported names are the **lower-cased key** with the **subsection preserved verbatim**,
joined by `.` — the same convention `CONFIG_BAD_BOOLEAN_VALUE` already documents for its
`key` field. Singular/plural is derivable from the list length, so it is a rendering
concern, not a payload one ([ADR-249]).

#### 1d. Refusal precedence

One fixture per row; the winning refusal is the only one printed.

| fixture | wins |
|---|---|
| v99, `HEAD` removed | `fatal: not a git repository (or any of the parent directories): .git` |
| v99 + a syntactically broken line (`[broken`) | `fatal: bad config line 8 in file .git/config` |
| v99 + `core.bare = banana` | `fatal: bad boolean config value 'banana' for 'core.bare'` |
| v99 + valueless `core.worktree` | `error: missing value for 'core.worktree'` + `fatal: bad config line 9 in file .git/config` |
| v1 + `extensions.preciousObjects = banana` + `extensions.bogus = 1` | `fatal: bad boolean config value 'banana' for 'extensions.preciousObjects'` (git lower-cases the key) |
| v99 + `extensions.bogus = 1` | `fatal: Expected git repo version <= 1, found 99` |
| v99 + `extensions.objectFormat = sha1` | `fatal: Expected git repo version <= 1, found 99` |
| v0 + `extensions.objectFormat = sha1` + `extensions.bogus = 1` | `fatal: repo version is 0, but v1-only extension found:` |

The chain, in order: **(1)** is-this-a-repository (`HEAD`) → **(2)** config syntax and
per-line value grammar (bad numeric version, bad boolean, missing value) → **(3)** version
> 1 → **(4)** v0 + v1-only extension → **(5)** v1 + unknown extension. Steps 4 and 5 are
mutually exclusive by version, so the new gate is one two-armed check placed after step 3.

#### 1e. Which file carries the format

| file | carries version / `extensions.*`? |
|---|---|
| `<commonDir>/config` | **yes** |
| `<gitDir>/config.worktree`, with `extensions.worktreeConfig = true` at v1 | **no** — a `repositoryformatversion = 99` there is ignored (exit 0); so is an `extensions.bogus = 1`; so is an `extensions.objectFormat = sha1` |
| global / system | out of reach through the FS port; unchanged |

This is an **asymmetry against the keys already read**: `core.bare` and `core.worktree` *are*
scoped (`config.worktree` wins, [ADR-661]); the format keys are *not*. `pickScoped` must
therefore not be applied to them, and the extension enumeration must run over the
`<commonDir>/config` token stream alone.

Separately measured, and it settles an open question about existing code: at **version 0**,
`extensions.worktreeConfig = true` is honoured — a `core.bare = true` planted in
`config.worktree` flips `rev-parse --is-bare-repository` to `true`, and a `core.worktree`
planted there sets `--show-toplevel`. Both behave identically at v1. tsgit's current
version-unconditional gate is faithful; adding a version condition would be a regression.

#### 1f. Which tier refuses — the config-porcelain question

Fixture: a v99 repository. Every command that needs a repository dies; the `config`
porcelain does **not** die — it demotes the repository to *absent* and carries on.

| invocation | exit | stderr |
|---|---|---|
| `log`, `status`, `rev-parse HEAD`, `cat-file -t HEAD`, `for-each-ref`, `worktree list`, `fsck`, `gc` | 128 | `fatal: Expected git repo version <= 1, found 99` |
| `rev-parse --git-dir` / `--absolute-git-dir` / `--git-common-dir` / `--is-bare-repository` / `--is-inside-work-tree` / `--show-toplevel` | 128 | same fatal |
| `config --list` | **0** | `warning: Expected …` + `warning: ignoring git dir '.git': Expected …`; output holds **only** the command-line/global scope — the repository config is dropped |
| `config --list --show-origin` | 0 | same warnings; only `command line:` origins |
| `config core.bare`, `config core.repositoryformatversion`, `config --get-regexp extensions` | **1** | `warning: Expected …` — the key is "not found" because the repo scope is gone |
| `config --local --list` | 128 | `warning: …` + `fatal: --local can only be used inside a git repository` |
| `config core.someKey someValue` (write), `config --unset core.foo` | 128 | `warning: …` + `fatal: not in a git directory` |
| `rev-parse --resolve-git-dir .git` | 0 | — (a pure path query; no repository setup) |

Same shape for **v1 + unknown extension**: `config --list` exits 0 with the two warnings,
`config core.bare` exits 1, everything else is the `unknown repository extension` fatal.

Contrast with the gate tsgit already implements — `core.bare = banana`:

| invocation | exit | stderr |
|---|---|---|
| `config --list`, `config core.bare`, `rev-parse --git-dir`, `status`, `log` | **128** | `fatal: bad boolean config value 'banana' for 'core.bare'` |

**The format gate is therefore a strictly wider-surviving tier than
`assertDiscoveryBooleansValid`.** The bad-boolean gate kills the config porcelain; the format
gate demotes the repository *for* the config porcelain and kills everything else. Neither
existing tier reproduces this exactly, which is what makes placement a decision (D1) rather
than a lookup.

This **supersedes a carried-forward assumption**: `design/bare-repo-custom-gitdir.md` §1b
says parenthetically that "the existing `assertDiscoveryBooleansValid` tier is where a
format-version gate would belong", and the backlog entry repeats it. That was an inference
from the version refusal firing on `log`, never a measurement of the porcelain row — and the
rows above show the two gates on different tiers. D1 therefore lands on evidence, not on that
sentence.

Reach is otherwise total, and measured:

| route | verdict |
|---|---|
| from a **subdirectory** of the v99 repo | same fatal |
| explicit `--git-dir=$T/v99/.git` with cwd elsewhere | same fatal |
| **cwd-is-gitdir** route into a bare-shaped v99 gitdir | same fatal |
| from a **linked worktree** whose common config is v99 | same fatal (and the main checkout too) |
| a v99 repo nested inside a good outer repo, cwd = inner | same fatal — discovery **does not climb past** it |
| a v1 + unknown-extension repo nested likewise | `unknown repository extension found` — likewise no climb-past |

#### 1g. Bootstrap boundary — `init` / `clone`

| operation | verdict |
|---|---|
| `git init` (re-init) inside an existing v99 repository | `fatal: Expected git repo version <= 1, found 99`, exit 128; the config is left untouched |
| `git init --bare` inside an existing v99 **bare** gitdir | same fatal, exit 128; config untouched |
| `git clone <v99 repo> <new>` | the source side dies: `fatal: Expected git repo version <= 1, found 99`, then `fatal: Could not read from remote repository.` |
| `git clone <good> <dir that already holds a v99 `.git/config`>` | `fatal: destination path '<…>' already exists and is not an empty directory.` — the emptiness check fires first; the destination's config is never read |
| `git clone <good> <empty dir>` (control) | succeeds |
| `git init --object-format=sha256 <new>` | writes an `[extensions]` block naming `objectFormat` (lower-cased) **before** `[core]`, with `repositoryformatversion = 1` |

So the leniency `scanConfigFile` implements is for an **absent** config, not for a
present-but-unacceptable one — and git refuses rather than rewriting. tsgit's `clone` already
carries a documented divergence in this family (`clone.ts:72-84`: git never reads the
destination's config, tsgit's open-time layout read does), accepted under [ADR-664]; the
format gate at open time would join that existing divergence class rather than open a new
one, but it does add members — see D1.

One further precedence edge belongs to the same class. §1d's first row (v99 with `HEAD`
removed ⇒ `not a git repository`) is satisfied *structurally* on tsgit's discovery routes: the
walk's `.git`-directory branch validates the candidate and skips it, and
`syntheticFallbackLayout` then never reads a rejected directory's config at all
(`resolve-layout.ts:149-159`). On the **explicit-`gitDir`** route, resolution is deliberately
lenient (`resolve-layout.ts:222-236`) and Stage 2 *does* read the config of a
not-yet-repository — so `gitDir` naming a v99 directory without a `HEAD` would raise the
format code where git raises `not a git repository: '<path>'`. That is the
already-documented explicit-route refusal-shape divergence, confined to a directory the
caller named itself; it is not new here, but it is a member the interop suite should pin
rather than discover.

### 2. What the read must produce

The read change is fixed regardless of where the refusal is raised, because the version and
`extensions.worktreeConfig` come from one scan of one file:

- **Version** — `lastTopLevelEntry(tokens, 'core', 'repositoryformatversion')` gives the
  last-wins entry, but §1a also needs *any* malformed occurrence to refuse. That needs a
  second, streaming pass over the same `[core]` entries: run `parseGitInt` on each occurrence
  in file order, refuse on the first `ok: false`, and keep the last `ok: true` value. When
  the key is absent the result is **`undefined`**, a third state distinct from `0` (§1c) —
  modelling it as a `-1` sentinel happens to reproduce every measured row but re-creates
  exactly the numeric-comparison trap §6 warns about, so `number | undefined` with the three
  literal predicates is the shape.
- **Extensions** — the acceptance check needs **every** entry under an `[extensions]` header,
  *including subsectioned ones* (§1c), in file order, as `subsection ? \`${subsection}.${key.toLowerCase()}\` : key.toLowerCase()`.
  `lastTopLevelEntry` cannot do this: it skips subsections (`currentSubsection !== undefined`
  ⇒ `continue`) and matches one key. A sibling enumerator over the same `ConfigToken[]` is
  the addition — `ConfigToken`'s `header` variant already carries `section` and
  `subsection`, and its `entry` variant carries `key` and `startLine`.
- **Scoping** — neither key goes through `pickScoped` (§1e). `extensions.worktreeConfig`
  keeps its current version-unconditional read (§1e, R7).

Whether the resulting verdict is *thrown* here or carried to a later tier is D1. If it is
carried, no new public `RepositoryLayout` field is needed: the later tier can re-derive it
from the memoised `readConfig(ctx)` cache, which parses `<commonDir>/config` only — exactly
the scope §1e requires — the same way `assertDiscoveryBooleansValid` re-derives `core.bare`
through `findFirstInvalidBoolean(ctx, …)`. That keeps the public layout surface
([ADR-658]) unchanged under every candidate, at the cost of a second enumeration site.

### 3. The accepted set

The nine names of §1b sort into three groups for tsgit, on evidence rather than taste:

- **Implemented** — `worktreeConfig` (consumed by `readRepositoryFormat`), `partialClone`
  (promisor plumbing exists across four modules).
- **Inert** — `noop`, `noop-v1`. They assert nothing about on-disk layout; accepting them
  cannot cause a misread.
- **Changes what tsgit reads or writes, unimplemented** — `objectFormat` and
  `compatObjectFormat` (object-id algorithm and width), `refStorage` (reftable; tsgit reads
  loose refs + `packed-refs` only, so a reftable repository looks *ref-less* rather than
  unsupported), `preciousObjects` (an on-disk promise that objects are never deleted, which
  tsgit's prune/gc paths would break), `relativeWorktrees` (relative gitdir pointers).

`noop-v1`, `objectFormat`, `compatObjectFormat`, `refStorage` and `relativeWorktrees` are the
five git itself treats as v1-only (§1b), so at v0 they are refused by git regardless of what
tsgit implements — that arm is pure faithfulness and is not a choice. The choice is the v1
arm: which of the nine tsgit accepts. See D2.

### 4. Error shape

git renders four refusals across this surface; one of them — `bad numeric config value …` —
is already `CONFIG_BAD_NUMERIC_VALUE` with a matching `reason` enum (§1a), needing no new
code and no new rendering. The remaining three are the three predicates of §1c: version,
unknown-at-v1, v1-only-at-v0. The new code(s) carry, per [ADR-249],
only fields: the **parsed** version integer (never the literal — `1k` reconstructs as
`found 1024`) and the ordered list of offending qualified names. Shape is D3.

Rendering in `src/domain/error.ts` follows the house convention for list-bearing codes —
`WORKING_TREE_DIRTY` renders a count, not the list — so the detail string names the version
and the count plus the first offender, while the **payload** carries every name. That keeps
the rendered detail bounded even though the names are config-supplied text.

### 5. Threat model

The repository config is attacker-influenceable whenever a repository arrives from an
untrusted source (a clone, a shared checkout, a submodule, a received bundle). The gate reads
no new file, opens no new path, and grants no new capability — `<commonDir>/config` is
already read at Stage 2 — so it introduces no new trust surface. What it changes:

- **Closes a silent-misread hole.** Today a SHA-256 repository is read as SHA-1 and reported
  as `OBJECT_HASH_MISMATCH` (Context). Anywhere a stored oid were trusted without
  re-verification, two hash spaces would be mixed under one 40-hex assumption. Refusing at
  the gate makes the unsupported case explicit and unreachable.
- **Closes a silent-ref-loss hole.** A `refStorage = reftable` repository presents as
  ref-less to tsgit's loose+`packed-refs` reader. Any write path that reconciles against
  "the refs that exist" would be operating on an empty view of a populated repository.
- **Respects an explicit on-disk contract.** `preciousObjects` is a repository declaring that
  its objects must never be deleted; tsgit's prune/gc has no knowledge of it.
- **Config-supplied strings are data only.** The extension names in the payload are never
  interpolated into a path, never used to select a code path, and never used unbounded in a
  rendered string (§4). The enumeration runs over an already-tokenised file;
  `scanConfigFile`'s deliberate absence of a size cap is unchanged and still bounded by the
  fact that a regular file always terminates.
- **Reach that cannot be side-stepped is the security property**, and it is placement-sensitive: a single
  Stage-2 chokepoint satisfies R5 structurally, whereas a command-tier gate satisfies it only
  if every command reaches it. `assertRepository` is reached by `config.ts` and `remote.ts`
  directly and by every other command through `assertOperationalRepository`, so both are
  total today — but the command-tier option makes R5 an invariant to maintain rather than one
  to derive. D1 weighs this.

### 6. Genericity and symmetry checks

**Version genericity.** The comparison is `version > MAX_REPOSITORY_FORMAT_VERSION` with the
ceiling as a named constant (= 1), never membership in `{0, 1}` — §1a's `-1` row proves a
membership test would refuse where git accepts, and a named ceiling makes a future v2 a
one-line change. The v1-only arm keys on `version === 0` **exactly**, matching git's own
message text ("repo version is 0"): §1c measures `-1`, `-5` and *absent* all accepting a
v1-only extension, so any relaxation to `version <= 0` — or any collapse of "absent" into
`0` — refuses three shapes git accepts.

**Width genericity.** Object-id width is exactly what `objectFormat` controls, and refusing
it is this design's answer; the gate itself hard-codes no width. `parseGitInt` is int64, so
no version literal git accepts can overflow tsgit's parse.

**Write-path / read-path symmetry.** `bootstrapRepository` writes
`repositoryformatversion = 0` and no `[extensions]` section, so nothing tsgit creates can
trip its own gate (R11) — an interop row asserts this in both directions
(tsgit-created → git-openable, git-created v0/v1 → tsgit-openable). The read side gains the
gate; the write side gains nothing, and that asymmetry is deliberate: tsgit has no reason to
emit a v1 repository until it implements an extension that requires one.

**Read-path/read-path symmetry.** The one real trap is §1e: the two key families read from
the same Stage-2 scan have *different* scoping rules. A shared `pickScoped` call over all
four keys would be the natural refactor and would be **wrong**.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | **Where the refusal is raised.** git's format gate is a third tier (§1f): every repository-needing command dies, while the `config` porcelain demotes the repository to absent and survives with exit 0/1. Neither existing tier is it. | **(a) Open time**, in `readRepositoryFormat` — `openRepository` itself throws, consistent with [ADR-664] and with `core.bare`/`core.worktree`. **(b) First command**, a new check in `assertRepository` beside `assertDiscoveryBooleansValid`, over the memoised `readConfig(ctx)`. **(c) Split** — `assertOperationalRepository` refuses; the `config` porcelain and `remote` survive with the repo scope dropped, reproducing §1f exactly. | **(a) open time** | (a) is the only option that satisfies R5 *structurally* — one chokepoint on every route, nothing to keep total (§5). It also matches §1g's `init` refusal for free and joins an already-accepted divergence class ([ADR-664]) rather than opening a new one. Its cost is one measured divergence: tsgit's `config` porcelain refuses where git's survives — but tsgit has no global/system scope, so git's surviving `config --list` returns an *empty* list and `config <key>` exits 1; the information loss is nil and the refusal is strictly more informative. (b) is the same divergence one call later, plus a second enumeration site, plus R5 as a maintained invariant. (c) is byte-faithful on the porcelain row but doubles the surface for the smallest observable gain, and the sibling trust gate would have to replicate the split. |
| D2 | **The accepted-extensions set at v1.** §1b names all nine git 2.55.0 knows; §3 groups them by what tsgit actually implements. | **(a) Strict allowlist of what tsgit implements** — accept `worktreeConfig`, `partialClone`, `noop`, `noop-v1`; refuse the other five. **(b) Mirror git's known set** — accept all nine; refuse only names git itself does not know. **(c) Allowlist + explicit refuse-list** — same accepted set as (a), but the five refusals carry a distinct "known to git, unimplemented here" condition separate from "unknown to anyone". | **(a) strict allowlist** | (a) is the only option that makes the Context row impossible: (b) accepts `objectFormat = sha256` and preserves today's silent misread, which is the defect this design exists to close. (c) is (a) plus a third condition and a third message shape to reconstruct, for a distinction the caller can already draw from the name in the payload. (a)'s cost is that tsgit refuses five extensions git happily opens (`objectFormat`, `compatObjectFormat`, `refStorage`, `preciousObjects`, `relativeWorktrees`) — a deliberate, ADR-worthy divergence from the prime directive, justified by §5 and narrowed to exactly the extensions that change data tsgit reads or contracts tsgit would break. The accepted set is a **capability statement**, not a fixed list: a name moves from the refuse-list to the accept-list the day tsgit implements it. |
| D3 | **Error-code shape.** §1c has two conditions (unknown-at-v1, v1-only-at-v0) plus §1a's version condition; the bad-numeric case reuses `CONFIG_BAD_NUMERIC_VALUE`. | **(a) One code**, `REPOSITORY_FORMAT_UNSUPPORTED { version: number; extensions: ReadonlyArray<string> }`, with an empty `extensions` meaning the version arm. **(b) Two codes** — `REPOSITORY_FORMAT_VERSION_UNSUPPORTED { version }` and `REPOSITORY_EXTENSIONS_UNSUPPORTED { version, extensions }`, where `version` (0 vs 1) selects which of the two extension messages the interop test reconstructs. **(c) Three codes**, one per git message. | **(b) two codes** | (b) makes every payload total and every reconstruction branch-free on a sentinel: no "empty array means the other case" convention (an (a) smell the house style calls primitive obsession), and no third code for what is one condition rendered two ways by a field the payload already carries (the (c) cost). It also matches the precedent set by [ADR-654] — two work-tree refusal codes, split because git renders two distinct `fatal:` lines for two distinct conditions, not for two renderings of one. Under (b) a caller switches on "the version is too new" vs "an extension is unsupported", which is exactly the branch a caller acts on. |

## Test strategy

**Unit** — under D1(a), extend `test/unit/repository/read-repository-format.test.ts` (the file
already covers absence, `core.bare`, `core.worktree`, `config.worktree` scoping and both
existing throws, with `MemoryFileSystem` + `posixPolicy` + `fileSystemLayoutProbe`, and uses
try/catch + direct `.data` assertions for every refusal — the mutation-resistant pattern
CLAUDE.md mandates). New Given/When/Then groups, one per §1 family:

- every §1a version literal — accepted rows assert the parsed value, refused rows assert
  `{ code, version }`, grammar rows assert `{ code: 'CONFIG_BAD_NUMERIC_VALUE', key: 'core.repositoryformatversion', source, value, reason }` with `reason` isolated per arm;
- the four §1a resolution rows (last-wins accepted, last-wins refused, early-malformed,
  late-malformed) — each as its own test, since they are separate guards;
- case-insensitivity of `[core]`/key, and the `[core "x"]` no-op;
- each of the nine extensions × {absent, v0, v1} as an `it.each` sweep over a table whose
  oracle shape is uniform (accept / v1-only-refuse / unknown-refuse), plus an unknown name in
  the same three states — the absent column is what stops `0` and "absent" being collapsed;
- the §1c list shapes: singular, plural, file order, duplicates, valueless, subsectioned
  (`X.bogus`, `.bogus`, `x.worktreeconfig`);
- §1e: version and extensions planted in `config.worktree` are inert, while
  `core.bare`/`core.worktree` there still win — one test each, so the asymmetry is pinned
  from both sides;
- §1e/R7: `extensions.worktreeConfig` honoured at v0;
- §1d ordering: `core.bare = banana` beats the version; the version beats both extension arms.

Under D1(b)/(c) the same table lands against `repo-state.ts`'s new assert (its existing tests
live under `test/unit/application/primitives/internal/`), plus tests for the new
`config-read.ts` enumerator; the `readRepositoryFormat` tests still gain the enumeration rows.

**Interop** — new `test/integration/repository-format-acceptance-interop.test.ts`, following
`config-boolean-interop.test.ts`: fixtures written with raw `writeFile` (git's CLI cannot emit
a valueless entry, and file-line order is load-bearing in §1a/§1c), driving tsgit through the
`openRepository` facade and git through `interop-helpers.ts`
(`GIT_AVAILABLE`, `runGit`, `runGitEnv`, `tryRunGitWithExit`). **One shared `beforeAll(fn, 60_000)`**
builds the single one-commit source repository; each row copies it — the default 10 s hook
timeout fails under full-validate concurrency. Twin rows (git verdict, tsgit verdict, then
git's exact stderr bytes reconstructed from tsgit's structured fields):

1. v0 accepted; v1 with no extensions accepted; v1 + `worktreeConfig` accepted.
2. v2 / v99 / `1k` refused — the `1k` row is the one that proves the payload carries the
   **parsed** integer (`found 1024`).
3. `-1` and `0x1` accepted, and `-1` / absent-key both accepting a v1-only extension — the
   rows a membership test, or an absent-⇒-`0` default, would fail.
4. `abc` and an out-of-range literal → `CONFIG_BAD_NUMERIC_VALUE`, reconstructing git's
   single-line `bad numeric …: <reason>`.
5. v1 + one unknown; v1 + three unknown in file order; v1 + a subsectioned unknown — each
   reconstructing the singular/plural header and the `\t`-indented, lower-cased name lines.
6. v0 + `objectFormat` (v1-only refusal) and v0 + unknown (accepted) — the pair that proves
   the version-conditioned split.
7. A real `git init --object-format=sha256` repository: git operates it, tsgit refuses with
   the extension code — replacing today's `OBJECT_HASH_MISMATCH`.
8. Route coverage (R5): subdirectory, explicit `gitDir`, cwd-is-gitdir bare, linked worktree
   via the common config, and the nested-inside-a-good-repo no-climb-past row.
9. Bootstrap (R10/R11): `init` against an existing v99 repository refuses in both tools;
   a tsgit-created repository is v0 with no `[extensions]` and opens in git.
10. **Porcelain co-truth** (§1f): git's `config --list` exit 0 / `config core.bare` exit 1 /
    `config --local --list` exit 128, against tsgit's chosen behaviour under D1 — recorded as
    a co-truth row when they agree and as an explicitly asserted, commented divergence when
    they do not, so the choice is pinned rather than implicit.

**Property tests** — applying CLAUDE.md's four lenses honestly, **no `*.properties.test.ts`
sibling is warranted for the gate itself**: the version parse delegates entirely to
`parseGitInt`, which already carries its own coverage (lens 1/3 belong there, not here); the
acceptance predicate is a lookup against a closed nine-element registry, which the "small
enum ⇒ parameterised sweep" exclusion covers and whose only oracle would be the registry
itself (the lens-4 tautology exclusion). The one honest candidate is the **extension
enumerator** — a counting/order invariant (lens 4: *N* `[extensions]` entries in a generated
config ⇒ *N* reported names, in the same order, subsection-qualified). If the enumerator
lands as a standalone `ConfigToken[] → ReadonlyArray<string>` function it earns a small
sibling asserting that invariant over arbitrary `[extensions]` blocks; if it lands inlined in
`readRepositoryFormat`, the `it.each` sweep above covers it and no sibling is added.

**Public-surface gates** — a new error code touches: the union member + factory
(`src/domain/repository/error.ts`, next to `NOT_A_REPOSITORY` / `WORK_TREE_CONFIG_INVALID`),
the rendered detail in `src/domain/error.ts`, a row per code in `docs/use/errors.md` →
*Repository state* (Code / Payload / Raised when, matching the depth of the neighbouring
`WORK_TREE_CONFIG_INVALID` and `CONFIG_BAD_BOOLEAN_VALUE` rows), and a regenerated
`reports/api.json` committed at pre-PR. `src/domain/repository/` is inside the coverage scope,
so the new factory and its rendering arm need 100 % line/branch coverage and a zero-survivor
mutation result.

## Out of scope

- **The ownership/trust (`safe.directory`) gate** — a sibling design landing in the same PR,
  deliberately not designed or probed here. The only shared surface: both gates sit at the
  same acceptance tier, so whichever placement D1 picks and whichever error/assert structure
  D3 picks is the structure the trust gate extends.
- **Implementing any refused extension** — SHA-256 / `objectFormat`, `compatObjectFormat`,
  reftable / `refStorage`, `preciousObjects` semantics, `relativeWorktrees`. The gate refuses
  them; implementing any one of them is separate work that removes a name from the refuse
  list (§3, D2).
- **Writing a v1 repository** — no `init --object-format` equivalent, no `[extensions]`
  emission. The write path is unchanged (R11). One adjacent write-path gap was measured and
  is deliberately left alone: `git clone --filter=blob:none` writes
  `repositoryformatversion = 1` with **no** `[extensions]` section (the filter lives in
  `[remote "origin"] promisor` / `partialclonefilter`), while tsgit's `bootstrapRepository`
  writes `0` for every clone. Both are accepted by both tools — a v1 repository with no
  extensions is accepted (§1a) and a promisor remote at v0 is accepted (§1b) — so this gate
  neither creates nor closes the gap, and closing it is separate work.
- **Rendering git's `warning:` lines** — §1f's two warnings are display, and the library emits
  no display string ([ADR-249]).
- **Global / system config scope** — already unreachable through the FS port; the format is
  repo-local in git too (§1e).
- **`extensions.*` value-grammar refusals for accepted extensions** beyond what already
  exists — `extensions.worktreeConfig = banana` is already the discovery-boolean gate's job
  (`repo-state.ts:63`), and `extensions.preciousObjects` / `relativeWorktrees` /
  `partialClone` value refusals (§1b) are only reachable once D2 accepts those names.

[ADR-226]: ../adr/226-git-faithfulness-prime-directive.md
[ADR-249]: ../adr/249-describe-structured-data-only.md
[ADR-639]: ../adr/639-ungated-commands-join-the-eager-config-gate.md
[ADR-654]: ../adr/654-two-work-tree-refusal-codes.md
[ADR-658]: ../adr/658-layout-read-surface-is-a-facade-field.md
[ADR-661]: ../adr/661-layout-config-read-includes-config-worktree.md
[ADR-664]: ../adr/664-layout-config-refusals-surface-at-open-time.md
