# Design — Repository-format acceptance gate

> Brief: refuse a repository whose `core.repositoryformatversion` exceeds 1, and — at
> version 1 — whose `extensions.*` carry a key **git itself** does not understand, the way
> canonical git refuses them: on the tier git refuses them, with the version/extension set
> surfaced as structured data. Every extension git knows is accepted, and tsgit backs each
> accepted name rather than misreading it. tsgit today opens a version-99 repository, reports
> a SHA-256 repository as corrupt rather than unsupported, and opens a `compatObjectFormat`
> repository git refuses outright.
> Status: ratified — [ADR-666] (the tier split), [ADR-667] (the accepted set), [ADR-668] (the
> two gate codes), [ADR-682] (the third tier the refusals attach to, and the mechanical guard
> that makes it safe), [ADR-685] (the one point-of-use code); paired with [ADR-679] (the shared
> dropped-scope rule). Every candidate this design raised is settled. One new candidate — DN-3,
> the guard's granularity — is open.

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

The command tier is, today, two asserts in
`src/application/primitives/internal/repo-state.ts`:

```ts
// repo-state.ts:89-96
export const assertRepository = async (ctx: Context): Promise<FilePath> => {
  if (!(await hasUsableHead(ctx))) throw notARepository(…);
  await assertDiscoveryBooleansValid(ctx);      // core.bare, extensions.worktreeConfig
  return (ctx.layout.workDir ?? ctx.layout.gitDir) as FilePath;
};

export const assertOperationalRepository = async (ctx: Context): Promise<FilePath> => {
  const root = await assertRepository(ctx);
  await assertEagerConfigValid(ctx);            // the [core] gate the config porcelain skips
  return root;
};
```

`assertRepository` is taken by fifteen call sites — all nine `config` verbs (`config.ts`) and
all six `remote` verbs (`remote.ts`); every other command takes `assertOperationalRepository`
(45 modules, [ADR-639]). §1f measures that **neither** of those two memberships is the
acceptance tier's: the surviving set is exactly four, narrower than both. [ADR-682] resolves
that mismatch by adding a **third** tier between them, so the shape this design targets is:

```
assertRepository            = HEAD usable + discovery booleans     <- 4 surviving config reads
assertAcceptedRepository    = assertRepository + acceptance gates   <- 11 movers
assertOperationalRepository = assertAcceptedRepository + eager [core] <- 45 operational modules
```

Two import routes reach the assert today and both matter to §2's guard: `remote.ts` imports it
straight from `src/application/primitives/internal/repo-state.js`, while `config.ts` imports it
through the deprecated re-export shim `src/application/commands/internal/repo-state.ts`.

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
| a real `git init --object-format=sha256` repo | works — git reads 64-hex ids | **opens**, then throws `OBJECT_HASH_MISMATCH` on the first object read |
| a real `git init --ref-format=reftable` repo | works — `log`, `for-each-ref` operate | **opens**; `branch.list`, `status` and `tag.create` throw `INVALID_REF { reason: 'ref name component must not start with .' }`, `log` throws `OBJECT_NOT_FOUND { id: 'HEAD' }` |
| v1 + `extensions.compatObjectFormat = sha1` | **refuses every command**, `config --list` and `rev-parse --git-dir` included: `fatal: compatibility hash algorithm support requires Rust` (128) | **opens**, `status` reports a clean tree |
| a `git worktree add --relative-paths` worktree set | `worktree list` resolves the relative pointers; the whole tree survives relocation | **opens** both sides and `status` is correct, but `worktree.list`, `.move` and `.remove` throw `PATHSPEC_OUTSIDE_REPO { path: '../../../../wt/.git' }` |

Three of these rows are the reason this is a gate rather than a nicety, and they fail in the
same way: **unsupported is reported as corrupt**. A SHA-256 repository surfaces as
`OBJECT_HASH_MISMATCH`; a reftable repository surfaces as `INVALID_REF` on git's own
`refs/heads/.invalid` HEAD stub; a relative-paths worktree set surfaces as
`PATHSPEC_OUTSIDE_REPO`. A caller cannot distinguish "this repository is fine, your library
cannot read it" from "this repository is damaged". The last row of the table is the mirror
defect: tsgit *operates* a repository git refuses outright.

### Binding constraints

- **Prime directive** ([ADR-226]): match canonical git's observable data and on-disk state.
  Every row in §1 is pinned against **git 2.55.0** in a `mktemp -d` throwaway with `env -i`,
  isolated `HOME`, `XDG_CONFIG_HOME` under it, `GIT_CONFIG_NOSYSTEM=1`, every `GIT_*`
  scrubbed, signing off — never recalled.
- **Structured output** ([ADR-249]): the refusal is **data** — the parsed version number and
  the offending extension names. No rendered `fatal:` line, no `warning:` line, no
  singular/plural selection (derivable from the list length); the interop test reconstructs
  git's bytes from the fields.
- **The acceptance tier** ([ADR-666], attached by [ADR-682], paired with [ADR-679]): a
  repository the acceptance tier rejects has no readable config scope, and gentle-setup verbs
  survive on the scopes that remain. The format gate and the ownership gate express **one
  rule** on **one tier** — `assertAcceptedRepository`, carrying all four acceptance refusals
  (format version, unsupported extension, dubious ownership, implicit bare repository).
- **The guard is part of this change** ([ADR-682]): the third tier fails *open*, so the
  weaker `assertRepository` is fenced mechanically by an allowlist check, not by convention.
  A guard described but not specified is not a guard; §2a specifies it.
- **No divergence at the gate** ([ADR-667]): every extension git knows is accepted. Where
  tsgit cannot yet act on an accepted extension it refuses *precisely, at the point of use* —
  never by silently reading the repository wrong, and never by refusing to open a repository
  git opens.
- Existing decisions this must not contradict: [ADR-639] (the eager `[core]` tier the config
  porcelain skips), [ADR-658] (the layout read surface is a facade field), [ADR-661] (the
  layout read includes `config.worktree`), [ADR-664] (layout-config refusals surface at open
  time), [ADR-678] (an untrusted repository still exposes its structural layout), [ADR-682]
  (the third tier and its guard), [ADR-685] (the one generic point-of-use code), [ADR-696]
  (extension **enum-value** refusals reuse the config error family, not this gate's codes).
- The scope that backs the accepted extensions is now ratified in full, and it is **larger
  than "designed separately"**: `objectFormat` is implemented to full write parity including
  `init --object-format` ([ADR-681]), `refStorage` is a complete read + write + compaction
  reftable backend on all three adapters ([ADR-680]), and bundle v3 ships with the
  `@object-format` capability ([ADR-683]). Those subsystems are specified in
  `docs/design/sha256-object-format.md` and `docs/design/reftable-ref-storage.md`; this design
  references them and designs neither. What that expansion changes here is §3 and §5: of git's
  nine extensions, exactly **one** is accepted-but-unbacked.
- Branded types, no `any`, functions < 20 lines, no suppression directives, 100 % coverage on
  touched code inside the coverage scope (`src/repository/` and `src/application/` are
  outside it; `src/domain/` is inside).

## Requirements

**R1.** A repository whose effective `core.repositoryformatversion` is > 1 is refused, with
the **parsed integer** carried as structured data. Values ≤ 1 — including negatives — are
accepted, as is an absent key and an absent config file (§1a).

**R2.** The version's value grammar is git's: `parseGitInt`'s verdict decides, and a value it
rejects raises `CONFIG_BAD_NUMERIC_VALUE` with git's own `reason`, not a format code (§1a).

**R3.** At version 1, an `extensions.*` entry whose qualified name is outside **git's own
registry** is refused, carrying **every** offending name in config-file order (§1b, §1c).
tsgit refuses no name git accepts ([ADR-667]).

**R4.** At version 0, unknown extension names are **ignored**, and the five names git treats
as v1-only are refused with a distinct condition. With the version key **absent** (or
negative), *neither* extension arm fires — absent is a third state, never folded into `0`
(§1c).

**R5.** The refusal fires for every verb outside the surviving set, on every route —
discovery (`.git` dir, `.git` file, cwd-is-gitdir), explicit `gitDir`, the fixed-entry
browser shim, and from inside a linked worktree via the common config (§1f).

**R6.** The surviving set is the four `config` **read** verbs — `get`, `getAll`, `getRegexp`,
`list` — and nothing else. They survive with the repository config scope dropped; an
explicitly-named `local`/`worktree` scope refuses; every `config` **write** verb and every
`remote` verb refuses (§1f).

**R7.** The format keys are read from `<commonDir>/config` **only**. A
`core.repositoryformatversion` or `extensions.*` planted in `<gitDir>/config.worktree` is
inert, even when `extensions.worktreeConfig` is on (§1e).

**R8.** `extensions.worktreeConfig` keeps being honoured at version 0 — today's
version-unconditional gate is faithful and must not gain a version condition (§1e).

**R9.** Refusal precedence matches git's, measured on **both** tiers: structure → config
syntax and per-line value grammar → layout/discovery value gates (`core.bare`,
`core.worktree`, `extensions.worktreeConfig`) → the format verdict → `compatObjectFormat`'s
universal refusal → the eager `[core]` gate (§1d). Each condition carries its own tier; the
tier does not follow from the position.

**R10.** Discovery does not climb past an unacceptable repository to an enclosing acceptable
one (§1f).

**R11.** Bootstrap leniency is preserved for an **absent** config and withdrawn for a
present-but-unacceptable one: `init` against an existing v99 repository refuses and leaves
the config byte-unchanged (§1g).

**R12.** Write/read symmetry: everything tsgit writes stays re-openable by tsgit and by git —
`bootstrapRepository` writes `repositoryformatversion = 0` and no `[extensions]`, so no
tsgit-created repository can trip its own gate.

**R13.** Every accepted extension is **backed**: implemented (in this design or a sibling
one in this PR), inert, honoured by construction, or refused precisely at the point of use.
After the ratified scope expansion exactly one of the nine — `compatObjectFormat` — takes the
last arm, and git refuses it too. No accepted name may leave tsgit reading the repository
wrong (§3).

**R14.** Every pinned row in §1 is backed by an interop assertion that reconstructs git's
exact stderr bytes and exit code from the structured fields, and every §1f porcelain row is
asserted as **co-truth** (both tools agreeing), not as a divergence.

**R15.** The acceptance-free tier is reachable only on purpose. Bare `assertRepository` is
callable from an explicit allowlist of exactly the four surviving verbs (plus the tier chain's
own link), enforced **mechanically** as a blocking check in `validate` — not by convention, and
not by review ([ADR-682], §2a). Adding a fifth requires an allowlist edit whose stated reason
names a pinned interop row.

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
`alsoBogus`, `zzz`, `aaa`, `mmm`) was rejected as unknown. These nine are exactly the names
tsgit accepts too ([ADR-667]). The "tsgit today" column is the **pre-change** measurement —
the gap §3 closes — and it is preserved verbatim as the evidence base; §3 records what each
name is backed by after the ratified scope expansion.

| extension | at v1 | at v0 | value grammar | tsgit today |
|---|---|---|---|---|
| `noop` | accepted | accepted (ignored) | value never parsed — `noop = banana` is accepted | nothing to do |
| `noop-v1` | accepted | **v1-only refusal** | value never parsed | nothing to do |
| `worktreeConfig` | accepted | accepted **and honoured** | boolean; `banana` ⇒ `fatal: bad boolean config value 'banana' for 'extensions.worktreeconfig'`; valueless ⇒ true | **implemented** (`readRepositoryFormat`) |
| `preciousObjects` | accepted | accepted (ignored) | boolean; same refusals | **honoured by construction** — §3 |
| `partialClone` | accepted | accepted (ignored) | string; valueless ⇒ `error: missing value for 'extensions.partialclone'` + `fatal: bad config line N in file <F>` | **implemented** — promisor plumbing in `fetch-pack.ts`, `read-object.ts`, `has-object.ts`, `clone.ts` |
| `relativeWorktrees` | accepted | **v1-only refusal** | boolean; same refusals | **partially read** — see §1h |
| `objectFormat` | accepted | **v1-only refusal** | enum `sha1`/`sha256`; anything else ⇒ `error: invalid value for 'extensions.objectFormat': '<v>'` (key lower-cased in the real bytes) + `fatal: bad config line N in file <F>` | misread as SHA-1 (Context) — backed by the sibling SHA-256 design |
| `compatObjectFormat` | accepted **by the format gate**, then refused on **every** command — see §1i | **v1-only refusal** | enum; any value on this build ⇒ `fatal: compatibility hash algorithm support requires Rust` | **opens and operates** where git refuses — §1i |
| `refStorage` | accepted | **v1-only refusal** | enum `files`/`reftable`; else the same `invalid value` pair | misdiagnosed (Context) — backed by the sibling reftable design |

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

**"Accepted" at an absent version means accepted *and inert*, not accepted and honoured.**
Measured separately, because the distinction decides whether the unbacked-extension refusal owes
an absent-version arm: take a real `git init --object-format=sha256` repository with one commit
(64-hex oid), then delete only the `repositoryformatversion` line from its config, leaving
`[extensions] objectformat = sha256` in place. git falls back to SHA-1 and **can no longer read
its own repository**:

| command | result |
|---|---|
| `rev-parse HEAD` | `fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree`, exit 128 |
| `log --oneline` | `fatal: your current branch appears to be broken`, exit 128 |
| `cat-file -t HEAD` | `fatal: Not a valid object name HEAD`, exit 128 |

So an extension is only *honoured* at version 1 — `extensions.worktreeConfig` excepted, which
§1e measures as honoured at v0 too. A repository declaring `objectFormat` without version 1 is
unreadable to git itself, so tsgit reading it as SHA-1 and failing to resolve is **faithful**,
not a silent misread. The unbacked-extension refusal therefore correctly keys on
`version === 1` alone and owes no absent-version arm.

So the three predicates are literal and independent, and none of them may be reached by
folding "absent" into `0`:

```
refuse VERSION   when version > 1
refuse UNKNOWN   when version >= 1  and unknown names are present     (⇒ version === 1, VERSION having already refused)
refuse V1_ONLY   when version === 0 and v1-only names are present
```

Under [ADR-667] the UNKNOWN predicate is now **purely faithful**: "unknown" means unknown to
git 2.55.0, so the arm fires only for names git itself rejects. The predicate text is
unchanged; what changed is that its name set is git's registry rather than a tsgit allowlist.

Reported names are the **lower-cased key** with the **subsection preserved verbatim**,
joined by `.` — the same convention `CONFIG_BAD_BOOLEAN_VALUE` already documents for its
`key` field. Singular/plural is derivable from the list length, so it is a rendering
concern, not a payload one ([ADR-249]).

#### 1d. Refusal precedence, on both tiers

One fixture per row, each config file written whole so the section a line lands in is
unambiguous. The `config --list` column is what the tier split (§1f) makes load-bearing:
a refusal that fires there fires on **every** tier; one that does not is operational-only.

| fixture | `log` | `config --list` |
|---|---|---|
| v99, `HEAD` removed | `fatal: not a git repository (or any of the parent directories): .git` | same |
| v99 + a syntactically broken line | `fatal: bad config line 5 in file .git/config` (128) | **128**, same line |
| v99 + `core.bare = banana` | `fatal: bad boolean config value 'banana' for 'core.bare'` (128) | **128**, same line |
| v99 + valueless `core.worktree` | `error: missing value for 'core.worktree'` + `fatal: bad config line N` | 128, same |
| v99 + `extensions.worktreeConfig = banana` | `fatal: bad boolean config value 'banana' for 'extensions.worktreeconfig'` (128) | **128**, same line |
| v1 + `extensions.worktreeConfig = banana` + `extensions.bogus = 1` | the same bad-boolean fatal (128) | **128**, same line |
| v99 + `extensions.bogus = 1` | `fatal: Expected git repo version <= 1, found 99` | **0**, two `warning:` lines |
| v99 + `extensions.objectFormat = sha1` | `fatal: Expected git repo version <= 1, found 99` | 0, two warnings |
| v99 + `core.sparseCheckout = banana` | `fatal: Expected git repo version <= 1, found 99` — the **version wins** | **0**, two warnings |
| v99 + `core.maxTreeDepth = abc` | `fatal: Expected git repo version <= 1, found 99` | 0, two warnings |
| v99 + valueless `core.excludesFile` | `fatal: Expected git repo version <= 1, found 99` | 0, two warnings |
| v0 + `core.sparseCheckout = banana` (control) | `fatal: bad boolean config value 'banana' for 'core.sparsecheckout'` | **0** — the eager gate never fires on the porcelain |
| v0 + `extensions.objectFormat = sha1` + `extensions.bogus = 1` | `fatal: repo version is 0, but v1-only extension found:` | 0, two warnings |
| v1 + `extensions.compatObjectFormat = sha1` | `fatal: compatibility hash algorithm support requires Rust` | **128**, same line (§1i) |
| v1 + `compatObjectFormat` + `core.bare = banana` | the bad-boolean fatal | 128, same |
| v1 + `compatObjectFormat` + `extensions.worktreeConfig = banana` | the bad-boolean fatal | 128, same |
| v1 + `compatObjectFormat` + `extensions.bogus = 1` | `fatal: unknown repository extension found:<LF><TAB>bogus<LF>` — the **format verdict wins** | **0**, two warnings |
| v99 + `compatObjectFormat` | `fatal: Expected git repo version <= 1, found 99` — the **version wins** | **0**, two warnings |
| v1 + `compatObjectFormat` + `core.sparseCheckout = banana` | `fatal: compatibility hash algorithm support requires Rust` — the compat refusal **wins** | 128, same |

The chain, in order:

1. **is-this-a-repository** (`HEAD`)
2. **config syntax and per-line value grammar** — `bad config line N`, `bad numeric config
   value` on the version, `missing value for 'extensions.<name>'`. **Every tier.**
3. **the layout/discovery value gates** — `core.bare`, `core.worktree`,
   `extensions.worktreeConfig`. **Every tier**, the `config` porcelain included.
4. **the repository-format verdict** — version > 1 / v1-only-at-v0 / unknown-at-v1.
   The two extension arms are mutually exclusive by version, so this is one two-armed check.
   **Operational tier**; the four `config` read verbs survive with the repository scope
   dropped.
5. **`compatObjectFormat`'s universal refusal** — only on a repository step 4 has already
   **accepted** (§1i). **Every tier.**
6. **the eager `[core]` gate** — `core.sparseCheckout`, `core.maxTreeDepth`, a valueless
   `core.excludesFile`, … **Operational tier only**, and it loses to both step 4 and step 5.

The tier is a property of each **condition**, not of its position: step 5 kills the config
porcelain while the step 4 that precedes it does not. Any implementation that tried to split
the chain at a single "open time versus command time" line would get step 5 wrong. Steps 1–3
and 6 already exist in tsgit, in that order; step 4 is the new gate (§2) and step 5 is the
one point-of-use refusal (§3).

#### 1e. Which file carries the format

| file | carries version / `extensions.*`? |
|---|---|
| `<commonDir>/config` | **yes** |
| `<gitDir>/config.worktree`, with `extensions.worktreeConfig = true` at v1 | **no** — a `repositoryformatversion = 99` there is ignored (exit 0); so is an `extensions.bogus = 1`; so is an `extensions.objectFormat = sha1` |
| global / system | out of reach for the format keys; git reads the format repo-locally |

This is an **asymmetry against the keys already read**: `core.bare` and `core.worktree` *are*
scoped (`config.worktree` wins, [ADR-661]); the format keys are *not*. `pickScoped` must
therefore not be applied to them, and the extension enumeration must run over the
`<commonDir>/config` token stream alone.

Separately measured, and it settles an open question about existing code: at **version 0**,
`extensions.worktreeConfig = true` is honoured — a `core.bare = true` planted in
`config.worktree` flips `rev-parse --is-bare-repository` to `true`, and a `core.worktree`
planted there sets `--show-toplevel`. Both behave identically at v1. tsgit's current
version-unconditional gate is faithful; adding a version condition would be a regression.

#### 1f. The acceptance tier — which verbs survive

Fixtures: a v99 repository, and a v1 + `extensions.bogus = 1` repository, each with an
`origin` remote configured. Every command that needs a repository dies; the `config` **read**
porcelain does not — it demotes the repository to *absent* and carries on.

| invocation | exit | stderr |
|---|---|---|
| `log`, `status`, `rev-parse HEAD`, `cat-file -t HEAD`, `for-each-ref`, `worktree list`, `fsck`, `gc` | 128 | `fatal: Expected git repo version <= 1, found 99` |
| `rev-parse --git-dir` / `--absolute-git-dir` / `--git-common-dir` / `--is-bare-repository` / `--is-inside-work-tree` / `--show-toplevel` | 128 | same fatal |
| **`remote -v`**, **`remote get-url origin`**, **`remote add up <url>`** | **128** | same fatal |
| `config --list` | **0** | `warning: Expected …` + `warning: ignoring git dir '.git': Expected …`; output holds **only** the command-line/global scope — the repository config is dropped |
| `config --list --show-origin` | 0 | same warnings; only non-repository origins |
| `config core.bare`, `config core.repositoryformatversion`, `config remote.origin.url`, `config --get-regexp extensions` | **1** | `warning: Expected …` — the key is "not found" because the repo scope is gone |
| `config --local --list` | 128 | `warning: …` + `fatal: --local can only be used inside a git repository` |
| `config core.someKey someValue` (write), `config --unset core.foo` | 128 | `warning: …` + `fatal: not in a git directory` |
| `rev-parse --resolve-git-dir .git` | 0 | — (a pure path query; no repository setup) |

The v1 + unknown-extension fixture reproduces every row with `unknown repository extension
found:<LF><TAB>bogus<LF>` substituted for the version fatal, warnings included.

**The surviving set is exactly four verbs: `config --get`, `--get-all`, `--get-regexp`,
`--list`** (`--list --show-origin` included), each returning an empty repository scope. Not
`remote` — measured, `remote`, `remote -v`, `remote get-url`, `remote show -n` and every
`remote` writer die with the same fatal. Not the `config` writers — they die too, leaving the
repository config file byte-unchanged.

This **corrects a reading of these same rows** that survived into [ADR-666]'s decision text,
which describes "the `config` and `remote` read verbs" as surviving. The `config --list`
row was measured; the `remote` row was not, and it does not behave the same way. [ADR-666]'s
own first consequence anticipates exactly this — the membership "must be enumerated on the
`openRepository` docs page, not inferred from which assert a command happens to call" — and
this is that enumeration. The ownership gate was probed side by side against the same
fixtures (`GIT_TEST_ASSUME_DIFFERENT_OWNER` for trust, `repositoryformatversion = 99` here)
and the two surviving sets are **identical**, which is what let one tier serve both gates and
why the attachment question was decided once for both — [ADR-682], which turns this four-verb
measurement into `assertRepository`'s membership and everything else into
`assertAcceptedRepository`'s.

Contrast with the gate tsgit already implements — `core.bare = banana`:

| invocation | exit | stderr |
|---|---|---|
| `config --list`, `config core.bare`, `rev-parse --git-dir`, `status`, `log` | **128** | `fatal: bad boolean config value 'banana' for 'core.bare'` |

So the format gate is a strictly wider-surviving tier than `assertDiscoveryBooleansValid`:
the bad-boolean gate kills the config porcelain; the format gate demotes the repository *for*
the config read verbs and kills everything else. That is why the acceptance tier is its own
membership rather than either of tsgit's two.

This **supersedes a carried-forward assumption**: `design/bare-repo-custom-gitdir.md` §1b
says parenthetically that "the existing `assertDiscoveryBooleansValid` tier is where a
format-version gate would belong", and the backlog entry repeats it. That was an inference
from the version refusal firing on `log`, never a measurement of the porcelain row.

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
| `git init` (re-init) inside an existing v1 + `extensions.bogus` repository | `fatal: unknown repository extension found:<LF><TAB>bogus<LF>`, exit 128; config untouched |
| `git init --bare` inside an existing v99 **bare** gitdir | same version fatal, exit 128; config untouched |
| `git clone <v99 repo> <new>` | the source side dies: `fatal: Expected git repo version <= 1, found 99`, then `fatal: Could not read from remote repository.` |
| `git clone <good> <dir that already holds a v99 .git/config>` | `fatal: destination path '<…>' already exists and is not an empty directory.` — the emptiness check fires first; the destination's config is never read |
| `git clone <good> <empty dir>` (control) | succeeds |
| `git init --object-format=sha256 <new>` | writes an `[extensions]` block naming `objectFormat` (lower-cased) **before** `[core]`, with `repositoryformatversion = 1` |
| `git init --ref-format=reftable <new>` | writes `[extensions] refstorage = reftable` **before** `[core]`, `repositoryformatversion = 1`, an empty `refs/heads/`, a `reftable/` directory, and `HEAD` holding the stub `ref: refs/heads/.invalid` |

**How the `init` refusal is reached under the ratified tier.** `init` runs no acceptance
gate — it is not a repository-needing verb, and neither gate can be attached to it (the
ownership design records the same for `git init` in an alien-owned repository). tsgit reaches
the same observable by a different route it already has: `init` (`src/application/commands/
init.ts`) throws `ALREADY_INITIALIZED` whenever `<gitDir>/HEAD` exists, which is true of
every fixture in the two `init` rows above. **Both tools refuse and both leave the config
byte-unchanged**, which is the whole of R11's substance; only the refusal *code* differs, and
that difference is a pre-existing consequence of tsgit having no re-init at all, not
something this gate introduces. The interop row therefore asserts the refusal and the
byte-unchanged config, not a code match.

The leniency `scanConfigFile` implements is for an **absent** config, not for a
present-but-unacceptable one — and git refuses rather than rewriting.

One further precedence edge belongs to the same class, and the ratified tier **shrinks** it.
§1d's first row (v99 with `HEAD` removed ⇒ `not a git repository`) is satisfied
*structurally* on tsgit's discovery routes: the walk's `.git`-directory branch validates the
candidate and skips it, and `syntheticFallbackLayout` then never reads a rejected directory's
config at all (`resolve-layout.ts:149-159`). On the **explicit-`gitDir`** route, resolution
is deliberately lenient (`resolve-layout.ts:222-236`) and Stage 2 *does* read the config of a
not-yet-repository. Because the format verdict is now **carried rather than thrown** (§2),
that read raises nothing: `hasUsableHead` refuses first with `NOT_A_REPOSITORY`, exactly as
git does. Keeping the refusal off open time therefore removes a member from [ADR-664]'s
documented divergence class rather than adding members to it — including for `clone` into a
destination that already holds an unacceptable config (`clone.ts:72-84`).

#### 1h. `relativeWorktrees` — the owed measurement

[ADR-667] accepts this name and names the measurement as owed. Fixture: `git init main`, one
commit, then `git worktree add --relative-paths ../wt -b wtb`.

**What git writes.** The flag is what turns the extension on — there is no manual step:

| artefact | absolute default | with `--relative-paths` |
|---|---|---|
| `.git/config` | `repositoryformatversion = 0`, no `[extensions]` | `repositoryformatversion = 1` **and** `[extensions] relativeWorktrees = true` |
| `.git/worktrees/wt/gitdir` | `/abs/…/wt/.git` | `../../../../wt/.git` |
| `<worktree>/.git` | `gitdir: /abs/…/main/.git/worktrees/wt` | `gitdir: ../main/.git/worktrees/wt` |
| `.git/worktrees/wt/commondir` | `../..` | `../..` (already relative in both) |

Relocating the whole tree keeps a relative set working (`worktree list` and `status` both
succeed after `mv`); the absolute set reports the worktree `prunable` and `git status` inside
it dies with `fatal: not a git repository: (null)`. Surviving relocation is the extension's
entire semantic content.

**The extension gates the writer, not the reader.** Measured on a repository with the
extension *off* and a relative pointer planted by hand in both files: `git worktree list`
exits 0 with both paths resolved, and `git status` inside the worktree exits 0. Turning the
extension on changes nothing. Conversely, a plain `git worktree add` on a repository that
*has* the extension writes **absolute** pointers, and `git worktree move` **converts a
relative pointer to absolute**. So git's reader resolves relative pointers unconditionally,
and nothing on the write side is conditional on the extension either.

**What tsgit does today** (same fixture, driven through `openRepository`):

| operation | verdict |
|---|---|
| open the main checkout | correct layout |
| open the linked worktree (relative `gitdir:` in its `.git` file) | correct layout — `resolvePointer` (`src/repository/find-layout.ts`) already resolves a relative pointer against the gitfile's directory |
| open a **subdirectory** of the linked worktree | correct layout |
| `status` inside the linked worktree | correct — branch `refs/heads/wtb`, clean |
| `log` on the main checkout | correct |
| **`worktree.list`** (from either side) | **throws** `PATHSPEC_OUTSIDE_REPO { path: '../../../../wt/.git' }` |
| **`worktree.move`**, **`worktree.remove`** | same throw — both resolve the entry through the same list |
| `worktree.add` on a repository carrying the extension | succeeds, writing **absolute** pointers — which is what git's plain `worktree add` does too |

So the answer to the owed question is: **it errors loudly, on three verbs, with a misleading
code** — not a silent misread, and not a refusal to open. The failing site is one line:
`linkedEntry` (`src/application/primitives/list-worktrees.ts`) reads `<admin>/gitdir` and
consumes the string **unresolved**, both as the reported `path` and as the argument to the
worktree-scoped `exists` probe that decides `prunable`. §3 states the fix.

#### 1i. `compatObjectFormat` — the point of use is universal, but only once accepted

[ADR-667] accepts this name on the grounds that git refuses it on this build, so there is no
read behaviour to be faithful to. Two things are load-bearing and both are measured: the
refusal's **precondition** (which version states reach it) and its **tier**.

| config | `log` | `config --list` |
|---|---|---|
| version **absent** + `compatObjectFormat = sha1` | **0 — works** | **0**, no warning |
| `= -1` + `compatObjectFormat = sha1` | **0 — works** | **0**, no warning |
| `= 0` + `compatObjectFormat = sha1` | 128, `fatal: repo version is 0, but v1-only extension found:<LF><TAB>compatobjectformat<LF>` | **0**, two warnings |
| `= 0` + `compatObjectFormat` + `refStorage = files` | 128, `…v1-only extensions found:<LF><TAB>compatobjectformat<LF><TAB>refstorage<LF>` | 0, two warnings |
| **`= 1`** + `compatObjectFormat = sha1` | 128, `fatal: compatibility hash algorithm support requires Rust` | **128**, same line |
| `= 1` + `compatObjectFormat = sha256` | 128, same `requires Rust` line | 128, same |
| `= 2` / `= 99` + `compatObjectFormat = sha1` | 128, `fatal: Expected git repo version <= 1, found <n>` | 0, two warnings |
| `= 1` + `[extensions "x"] compatObjectFormat = sha1` | 128, `fatal: unknown repository extension found:<LF><TAB>x.compatobjectformat<LF>` | 0, two warnings |
| `= 1` + valueless `compatObjectFormat` | 128, `error: missing value for 'extensions.compatobjectformat'` + `fatal: bad config line N in file .git/config` | **128**, same pair |

`rev-parse --git-dir`, `config core.bare` and `status` were measured alongside `log` on the
`= 1` rows and all exit 128 with the same line — the refusal reaches even a pure setup query.

So the refusal's predicate is narrow and the tier is wide:

```
refuse COMPAT   when the format verdict ACCEPTED the repository
                and version === 1
                and a top-level `compatobjectformat` entry is present with a value
```

Every other version state is answered by an earlier step: absent and negative accept
outright, `0` takes the v1-only arm, `> 1` takes the version arm, a subsectioned spelling is
an unknown name, and a valueless one is a config-syntax error. §1d pins the ordering directly
on that reading: `core.bare = banana`, `extensions.worktreeConfig = banana` and an unknown
sibling extension all **beat** the compat refusal, while `core.sparseCheckout = banana`
**loses** to it. The value is never consulted beyond being present — `sha1` and `sha256`
refuse identically.

This is the shape [ADR-667] describes: **accepted at the gate, refused at the point of use**.
What the measurement adds is that the point of use is *every* use, the `config` porcelain
included — so it is the one condition in the chain that sits after the format verdict yet
refuses on a wider tier than it. tsgit today opens such a repository and runs `status` on it
successfully, which is the mirror of the misread defects: operating a repository git refuses.

### 2. What the read must produce, and where the verdict is consumed

The read change is fixed regardless of tier, because the version and
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
  keeps its current version-unconditional read (§1e, R8).

**The verdict is carried, not thrown.** `readRepositoryFormat` keeps throwing its two
layout-config refusals at open ([ADR-664], §1d step 3), gains one more open-time throw for
§1d step 5 (below), and adds one non-throwing output for step 4:

```ts
type RepositoryFormatRefusal =
  | { readonly kind: 'version'; readonly version: number }
  | { readonly kind: 'extensions'; readonly version: number; readonly extensions: ReadonlyArray<string> };
```

Absent ⇒ accepted. The two variants map one-to-one onto [ADR-668]'s two codes, so no consumer
re-derives which arm fired and no empty-array sentinel exists. It reaches the command tier as
**one frozen field on `RepositoryLayout`**, beside the ownership gate's `untrusted`
([ADR-658] — the layout read surface is the facade field both gates extend).

The one point-of-use refusal (§1d step 5, §1i) is computed in the **same** place and thrown
rather than carried, because it kills the config porcelain too. Its predicate reads the
verdict: it fires only when the verdict is *accepted*, the version is exactly 1, and a
top-level `compatobjectformat` entry is present with a value. Both outputs therefore come out
of one function in one pass, and the ordering between them is expressed as data dependency
rather than as a rule to remember.

Re-deriving the verdict at the command tier from the memoised `readConfig(ctx)` was the
alternative, and the tier change rules it out on two counts. First, **circularity**: one of
the verdict's consumers is the config scope reader itself (below), and it reads the same
repository config file, so a verdict derived from a config read cannot gate that read.
Second, **cost and totality**: a frozen field is a
synchronous read with no I/O on every command, and it is total on every route by
construction, whereas a re-derivation is an invariant to maintain at each site.

Two consumers, and they are deliberately at different depths. [ADR-682] settles which assert
carries the acceptance refusals: a **third** tier named for what it asserts, with
`assertRepository` keeping its current meaning and `assertOperationalRepository` chaining
through the new one.

```
assertRepository(ctx)                        # the four surviving config read verbs
  hasUsableHead                    → NOT_A_REPOSITORY
  assertDiscoveryBooleansValid     → CONFIG_BAD_BOOLEAN_VALUE      (§1d step 3, real config content)

assertAcceptedRepository(ctx)                # every other verb, incl. remote and the config writers
  assertRepository
  ctx.layout.implicitBare          → IMPLICIT_BARE_REPOSITORY      (the ownership design's §1h)
  ctx.layout.untrusted             → DUBIOUS_OWNERSHIP             (ADR-679, ADR-684)
  ctx.layout.formatRefusal         → REPOSITORY_FORMAT_VERSION_UNSUPPORTED
                                   | REPOSITORY_EXTENSIONS_UNSUPPORTED   (§1d step 4)

assertOperationalRepository(ctx)
  assertAcceptedRepository
  assertEagerConfigValid           → the [core] gate               (§1d step 6)
```

The ordering inside those boxes is measured and settled. The ordering of the three refusals
*within* `assertAcceptedRepository` is inherited rather than decided here: the format arm is
this design's (§1d step 4), and `implicitBare`/`untrusted` are the ownership design's, whose
own §1 pins their relative order. The dropped-scope discussion below states the one
structural consequence the two gates already have on each other.

**The call sites that move**, verified with `find_referencing_symbols` against
`assertRepository` rather than inferred:

| module | stays on `assertRepository` | moves to `assertAcceptedRepository` |
|---|---|---|
| `src/application/commands/config.ts` | `configGet` (`:47`), `configGetAll` (`:67`), `configGetRegexp` (`:94`), `configList` (`:123`) | `configSet` (`:153`), `configUnset` (`:182`), `configUnsetAll` (`:217`), `configRenameSection` (`:244`), `configRemoveSection` (`:269`) |
| `src/application/commands/remote.ts` | — | `remoteList` (`:118`), `remoteAdd` (`:133`), `remoteRemove` (`:173`), `remoteRename` (`:236`), `remoteSetUrl` (`:306`), `remoteShow` (`:329`) |
| `src/application/primitives/internal/repo-state.ts` | — | `assertOperationalRepository` (`:223`) re-points its inner call |

Line numbers are the `await assertRepository(ctx);` statements at this design's baseline.
`config.ts` ends up needing **both** asserts,
so it imports both directly from `../primitives/internal/repo-state.js` and stops routing this
symbol through the deprecated `commands/internal/repo-state.ts` shim; the shim itself is left
alone (other symbols still flow through it) and, being a re-export rather than a call, is not
a guard subject.

Eleven sites move, four stay, and the split is now visible in the two command modules rather
than implied by which assert a verb happened to inherit.

**The dropped config scope.** The four survivors must see an empty repository scope (§1f).
The check belongs in `config-scoped-read.ts`'s per-scope reader: when
`ctx.layout.formatRefusal !== undefined`, the `local` and `worktree` scopes contribute
nothing to a merged read, and an **explicitly-named** `local`/`worktree` scope refuses with
the existing `CONFIG_SCOPE_NOT_AVAILABLE { scope, reason }` — one new `reason` literal,
shared with the ownership gate, reproducing `fatal: --local can only be used inside a git
repository`.

It must **not** be a blanket early return in `readConfig` (`config-read.ts:169`), and this is
where the two gates' shared rule needs one honest distinction. [ADR-679] puts the ownership
check there, and correctly: an untrusted repository's config file is never parsed at all, so
`assertDiscoveryBooleansValid` finds nothing and `core.bare = banana` measurably stops
refusing. The format verdict is **derived from that very file**, and §1d measures the
opposite outcome for it — on a v99 repository `core.bare = banana` and
`extensions.worktreeConfig = banana` still refuse `config --list` with exit 128. So:

> One rule — *a repository the acceptance tier rejects has no readable config scope* —
> expressed at the earliest point each verdict permits. Ownership: before the file is read.
> Format: after it is read and after the gates that read it have run.

Both gates reach the same observable, and the ordering between them is a consequence rather
than a rule: when the layout is untrusted, Stage 2 never runs ([ADR-678]), so `formatRefusal`
is structurally absent **and the step-5 throw never fires either** — both outputs come from
the scan that was skipped. Ownership shadowing the whole of this design is therefore something
neither gate has to sequence against the other.

#### 2a. The allowlist guard — the mitigation [ADR-682] requires

The third tier **fails open**: a future command that reaches for `assertRepository` — the most
natural-sounding name of the three — would silently operate on a rejected or untrusted
repository. [ADR-682] makes the guard part of this change, not a follow-up, and names it as
the precondition for the three-tier shape being safe to ship. Specification:

**Where it lives.** A new audit in the existing allowlist-audit family — the mechanism
`check:write-surfaces` and `check:browser-surface` already use — rather than a new mechanism:

| artefact | path |
|---|---|
| the audit | `tooling/audit-assert-tier.ts` |
| the allowlist | `tooling/audit-assert-tier.allowlist.json` |
| the wireit target | `check:assert-tier`, listed in `validate`'s dependencies beside `check:write-surfaces` |
| its own test | `tooling/test/unit/audit-assert-tier.test.ts` |

`check:architecture` (dependency-cruiser over `src/`) was the first candidate and is
**structurally insufficient**: dependency-cruiser rules are module-granular, and the four
survivors and five writers share one module (`src/application/commands/config.ts`), so no
`from`/`to` path rule can separate them. Making it work would require splitting that module —
a **published subpath** (`./commands/config`) — which is DN-3's alternative (c), not this
design's default. The wireit `files` list mirrors the sibling audits: `src/**/*.ts`,
`tooling/audit-assert-tier.ts`, `tooling/audit-assert-tier.allowlist.json`, plus
`tooling/audit-assert-tier/**/*.ts` if the audit splits into helpers the way
`audit-write-surfaces` does. It declares no `output`, like `check:architecture` — it is a
verdict, not a report.

**What it asserts.** Over `src/**/*.ts` only (tests, tooling and docs are out of its scan),
using the TypeScript compiler API — already a tooling dependency, used by
`tooling/dts-value-exports.ts` and `tooling/truthful-dts.ts`:

1. Resolve, per module, the **local binding** of the primitives module's `assertRepository`
   export — reached directly or through any re-export barrel, and under any local alias
   (`import { assertRepository as gentle }`). Binding resolution, not import-path matching, is
   what makes the deprecated shim and a future alias both harmless.
2. Collect every `CallExpression` on that binding, and attribute each to its **enclosing
   exported declaration** — the nearest ancestor `VariableStatement`/`FunctionDeclaration`
   carrying an `export` modifier — yielding a `{ module, verb, line }` triple.
3. Fail on any triple whose `{ module, verb }` is not in the allowlist (**an unguarded
   caller**), and fail on any allowlist entry with no matching triple (**a stale entry** — the
   `allowlistRot` / "remove the stale entry" posture both sibling audits already take).
4. Fail on a call site it cannot attribute to an exported declaration, rather than skipping
   it: an unattributable call is the exact shape a bypass would take.

**The allowlist**, shipped with exactly five entries — the four measured survivors plus the
one internal chain link:

```json
{
  "callers": [
    { "module": "src/application/commands/config.ts", "verb": "configGet",
      "reason": "git's `config --get` exits 1 (not-found), not 128, on a rejected repository; pinned by the tier co-truth sweep." },
    { "module": "src/application/commands/config.ts", "verb": "configGetAll",
      "reason": "same porcelain row as configGet; pinned by the tier co-truth sweep." },
    { "module": "src/application/commands/config.ts", "verb": "configGetRegexp",
      "reason": "git's `config --get-regexp` exits 1 on a rejected repository; pinned by the tier co-truth sweep." },
    { "module": "src/application/commands/config.ts", "verb": "configList",
      "reason": "git's `config --list` exits 0 with the repository scope dropped; pinned by the tier co-truth sweep." },
    { "module": "src/application/primitives/internal/repo-state.ts", "verb": "assertAcceptedRepository",
      "reason": "the tier chain itself — assertAcceptedRepository is defined as assertRepository plus the acceptance gates." }
  ]
}
```

`reason` is a required non-empty string, validated by the loader the way
`audit-write-surfaces`'s loader validates its entries; a malformed allowlist is an audit
failure, not a silent empty set.

**What it says when it fails.** One line per finding, then a non-zero exit — blocking from day
one, with no warn-only phase, because [ADR-682] names the guard as the precondition for the
tier being safe:

```
audit-assert-tier: src/application/commands/stash.ts:41 `stashList` calls bare
  `assertRepository`. That tier skips the acceptance gates (repository format, unsupported
  extension, dubious ownership, implicit bare) — a rejected or untrusted repository would be
  operated on. Use `assertAcceptedRepository` (or `assertOperationalRepository`), or, if
  canonical git really does let this verb survive a rejected repository, add it to
  tooling/audit-assert-tier.allowlist.json with the measurement that proves it.
```

and for the stale arm:

```
audit-assert-tier: allowlist entry `src/application/commands/config.ts` / `configReadAll`
  matches no call site. Remove the stale entry or restore the caller.
```

**How a legitimate fifth verb is added.** Three deliberate, reviewable steps, in order: pin
the survival against real git (a §1f-shaped row: the verb exits 0 on a v99 fixture *and* on a
v1-unknown-extension fixture, in both tools); add the interop row to the tier co-truth sweep
(Test strategy, row 8); then add the `{ module, verb, reason }` entry whose `reason` names
that row. The allowlist edit is the visible act; the interop row is what stops the reason
being a claim. Editing source alone cannot widen the surviving set — which is the whole
difference between this and a convention.

**Deliberately not guarded.** `assertAcceptedRepository` itself has no allowlist. A verb that
takes it instead of `assertOperationalRepository` misses only the eager `[core]` gate, which
§1d measures as a *different* tier with no attacker-relevant content, and which [ADR-639]
already governs. Widening the guard there would fence a boundary no measurement makes
load-bearing.

### 3. The accepted set — how tsgit backs each of git's nine

[ADR-667] settles *what* is accepted: all nine names of §1b, and nothing else. There is no
allowlist and no divergence at the gate. What remains is a statement of **how each accepted
name is backed**, because acceptance without backing is the misread this design exists to
close (R13).

The scope expansion ratified across [ADR-680], [ADR-681], [ADR-683] and [ADR-685] settles this
table down to one plain sentence: **of git's nine extensions, eight are backed and exactly one
— `compatObjectFormat` — is accepted-but-unbacked, and git itself refuses that one on this
build.** So the accepted set is not a promissory note anywhere except at the single name where
git makes the same refusal.

| extension | how tsgit backs it |
|---|---|
| `worktreeConfig` | **Implemented.** `readRepositoryFormat` honours it at every version (§1e). |
| `partialClone` | **Implemented.** Promisor plumbing across `fetch-pack.ts`, `read-object.ts`, `has-object.ts`, `clone.ts`. |
| `noop`, `noop-v1` | **Inert.** They assert nothing about on-disk layout; git never parses their value. Accepting them cannot cause a misread. |
| `preciousObjects` | **Honoured by construction** — see below. |
| `relativeWorktrees` | **Backed by one pointer resolution** — see below (§1h). |
| `objectFormat` | **Implemented** ([ADR-681]): read, write and create, full write parity including `init --object-format` and bundle v3 ([ADR-683]). Specified in `docs/design/sha256-object-format.md`; not designed here. |
| `refStorage` | **Implemented** ([ADR-680]): a complete reftable backend — stack parsing, tombstones, symbolic refs, peeled tags, reflogs, the `tables.list` lock protocol, writing and compaction — on all three adapters. Specified in `docs/design/reftable-ref-storage.md`; not designed here. |
| `compatObjectFormat` | **The one unbacked name.** Refused at the point of use with `REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }` ([ADR-685]), which §1i measures to be *every* use — see below. |

**`preciousObjects` — honoured by construction.** The extension is an on-disk promise that
objects are never deleted; git enforces it by refusing `gc`, `repack` and `prune`. tsgit has
no such command. Verified against the full `src/application/commands/` surface:
there is no `gc`, no `prune`, no `repack`, and no `prune-packed` among the 50 command modules.
Verified again one level
down, against every `fs.rm` / `fs.rmRecursive` call site in `src/`: the removals are lock
files, temp files (merge-driver, textconv, signing), sequencer and merge/rebase/revert state
directories, loose **refs** and reflog files, working-tree files, a removed worktree's own
directory and admin dir, and a deinit'd submodule's working-tree contents — which the code
comment and the measured behaviour both confirm leave `.git/modules/<name>` intact. The only
sites that recursively remove a gitDir are `bootstrap.ts` and `clone.ts`, and each rolls back
a gitDir tsgit created moments earlier in the same call; neither can reach a pre-existing
repository's object store. So the promise holds today, and the reason it holds is structural:
tsgit has no object-deleting verb to gate. If one is ever added, it inherits the obligation.

**`relativeWorktrees` — one pointer resolution.** §1h measures the whole gap: `linkedEntry`
(`src/application/primitives/list-worktrees.ts`) consumes `<admin>/gitdir` verbatim, so a
relative pointer becomes a relative `FilePath` and escapes the worktree-scoped filesystem.
The fix is to resolve the pointer against the admin directory before using it — the same
resolution `resolvePointer` (`src/repository/find-layout.ts`) already performs for the
gitfile side, which is why the discovery half already works. It is **unconditional**, not
gated on the extension: §1h measures git's reader resolving relative pointers whether or not
the extension is set, and the extension gating only the writer. The write side needs no
change — tsgit's `worktree.add` and `worktree.move` write absolute pointers, which is exactly
what git's own `worktree add` and `worktree move` do without `--relative-paths`. Emitting
relative pointers (a `--relative-paths` equivalent) is a write-side feature nothing here
requires; it is out of scope.

**`compatObjectFormat` — refused at its point of use, and every use is one.** §1i measures
the predicate and the tier separately, and both matter. The predicate is narrow: the refusal
fires only on a repository the format verdict has already **accepted**, at version exactly 1,
with a top-level entry that has a value — every other version state, spelling and value shape
is answered by an earlier step of §1d. The tier is wide: once the predicate holds, every
command dies, `config --list` and `rev-parse --git-dir` included. A refusal that kills the
config porcelain is [ADR-664]'s class, so it is thrown from `readRepositoryFormat` at open
(§2), after the verdict it depends on. That satisfies [ADR-667]'s standing rule exactly — it
never reads the repository wrong, and it never refuses to open a repository git opens,
because git opens no such repository.

The code it carries is settled by [ADR-685]: the generic
`REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }`, shared with the sibling SHA-256
design and specified there once for both. This design **consumes** it and does not re-specify
its shape. Two things follow that are this design's to state. First, the family's **current
membership is exactly one** — `compatObjectFormat` — which is the measurement of §1b/§3, not a
property of the code; the code stays general precisely so a future extension git adds and
tsgit has not yet implemented joins by name, with no new code and no new ADR. Second, the
distinction from [ADR-668]'s two gate codes is **tier, not severity**: the gate codes refuse a
repository git also refuses to open, while this refuses an operation on a repository git's
format gate accepts (§1d step 5 versus step 4).

The five names git treats as v1-only (`noop-v1`, `objectFormat`, `compatObjectFormat`,
`refStorage`, `relativeWorktrees`) are refused by git at v0 regardless of what tsgit
implements (§1b); that arm is pure faithfulness and independent of the table above.

### 4. Error shape

git renders four refusals across the acceptance surface, plus one at §1i's earlier tier.

- **`bad numeric config value …`** — already `CONFIG_BAD_NUMERIC_VALUE` with a matching
  `reason` enum (§1a). No new code, no new rendering.
- **Two new acceptance codes** ([ADR-668]):
  `REPOSITORY_FORMAT_VERSION_UNSUPPORTED { version: number }` and
  `REPOSITORY_EXTENSIONS_UNSUPPORTED { version: number; extensions: ReadonlyArray<string> }`.
  `version` (0 vs 1) selects which of git's two extension messages the interop test
  reconstructs, so the payload is total and the reconstruction is branch-free on a sentinel.
  The **parsed** integer is carried, never the literal — `1k` reconstructs as `found 1024`.
  Names are the lower-cased key with the subsection preserved verbatim, joined by `.`.
  Singular versus plural is derivable from list length ([ADR-249]).
- **One point-of-use code**, `REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }`
  ([ADR-685]) — a separate family from the two above, per [ADR-668]'s consequence. Raised at
  the point of use, never at the acceptance gate, which accepts every name git knows
  ([ADR-667]). `extension` is the lower-cased key with the subsection preserved, matching the
  gate codes' convention; `value` carries what the config declared, because git's refusal is
  presence-triggered and value-independent (§1i), so a caller never has to re-open the config
  to answer "declared as what?". Exactly one name reaches it today, and the `docs/use/errors.md`
  row says so while the code stays general.
- **Extension *value*-grammar refusals are a fourth family and not this gate's**
  ([ADR-696]): `CONFIG_INVALID_ENUM_VALUE` for `objectFormat`/`refStorage`, and
  `CONFIG_MISSING_VALUE` for the valueless arm. The acceptance gate never parses an
  extension's value.
- **One new `reason` literal** on the existing `CONFIG_SCOPE_NOT_AVAILABLE { scope, reason }`
  for an explicitly-named `local`/`worktree` scope on a rejected repository (§2), shared with
  the ownership gate.

Rendering in `src/domain/error.ts` follows the house convention for list-bearing codes —
`WORKING_TREE_DIRTY` renders a count, not the list — so the detail string names the version
and the count plus the first offender, while the **payload** carries every name. That keeps
the rendered detail bounded even though the names are config-supplied text.

### 5. Threat model

The repository config is attacker-influenceable whenever a repository arrives from an
untrusted source (a clone, a shared checkout, a submodule, a received bundle). The gate reads
no new file, opens no new path, and grants no new capability — `<commonDir>/config` is
already read at Stage 2 — so it introduces no new trust surface. What it changes:

- **Closes the SHA-256 misdiagnosis by supporting it.** Today a SHA-256 repository is read as
  SHA-1 and reported as `OBJECT_HASH_MISMATCH` (Context) — *unsupported* reported as
  *corrupt*, and, anywhere a stored oid were trusted without re-verification, two hash spaces
  mixed under one 40-hex assumption. [ADR-667] closes it by **building the support**, not by
  refusing, and [ADR-681] takes that to full read/write/create parity
  (`docs/design/sha256-object-format.md`). The acceptance gate's part is to stop pretending the
  name is unknown; the residual hash-space risk is owned by that design's width-correctness
  work ([ADR-694]), not by this gate.
- **Closes the reftable misdiagnosis by supporting it.** Measured, a real
  `--ref-format=reftable` repository does not present as an empty-but-valid ref set today: it
  throws `INVALID_REF { reason: 'ref name component must not start with .' }` from
  `branch.list`, `status` and `tag.create`, and `OBJECT_NOT_FOUND { id: 'HEAD' }` from `log`,
  because git plants `ref: refs/heads/.invalid` in `HEAD` as a files-backend tripwire. That
  stub is what stops a write path reconciling against an empty view of a populated
  repository — an accident of git's on-disk layout, not a guarantee tsgit designed, and it
  covers only the verbs that resolve `HEAD` first. [ADR-667] closes the class by building the
  backend, and [ADR-680] makes that a *complete* backend — read, write and compaction, all
  three adapters (`docs/design/reftable-ref-storage.md`) — so the tripwire stops being the only
  thing standing between tsgit and a reconciled-against-empty write.
- **Closes an over-permissive hole.** tsgit today opens and operates a v1
  `compatObjectFormat` repository that git refuses on every command (§1i). Refusing at open
  (§3) removes a repository shape tsgit was reading with an object-id model git declines to
  apply. The refusal is scoped to exactly the version state git refuses, so it cannot
  over-reach: an absent or negative version accepts in both tools.
- **Narrows a loud-but-wrong refusal.** A relative-paths worktree set fails three worktree
  verbs with `PATHSPEC_OUTSIDE_REPO` on a path that escapes the worktree-scoped filesystem
  (§1h). Resolving the pointer removes the escape rather than tolerating it: the resolved
  path is then subject to the same containment check every other worktree path is.
- **Respects an explicit on-disk contract.** `preciousObjects` is a repository declaring that
  its objects must never be deleted. tsgit honours it by construction (§3), and the
  verification is recorded so a future object-deleting verb inherits the obligation instead of
  silently breaking the promise.
- **Config-supplied strings are data only.** The extension names in the payload are never
  interpolated into a path, never used to select a code path, and never used unbounded in a
  rendered string (§4). The enumeration runs over an already-tokenised file;
  `scanConfigFile`'s deliberate absence of a size cap is unchanged and still bounded by the
  fact that a regular file always terminates.
- **Reach is the security property, and the allowlist guard is what carries it.** The verdict
  itself is safe by construction: a frozen layout field populated on every discovery route by
  one Stage-2 call, read synchronously with no I/O. What is *not* safe by construction is the
  **membership** — fifteen verbs shared one assert, and only four may survive. [ADR-682]'s
  third tier is explicit at every call site but **fails open**: `assertRepository` keeps its
  short, natural name, so a future command that reaches for it inherits none of the four
  acceptance gates and would operate on a rejected or untrusted repository. Left to
  convention, that reach would be *maintained* rather than *derived*, and only the exhaustive
  per-verb interop sweep (Test strategy, row 8) would catch a regression — and only for verbs
  the sweep already knows about, which by definition excludes the new one. §2a's guard is what
  converts it back to derived: an unguarded caller is a **build failure**, and the only way to
  become a survivor is an allowlist edit whose `reason` names a pinned interop row. This is not
  a nicety of the option — [ADR-682] records that without the guard, inverting the default
  (option 1) would have been the correct choice instead. The same guard covers the ownership
  gate, since all four refusals ride the one tier.
- **The unbacked set is now a single name, and that shrinks the residual.** After [ADR-680],
  [ADR-681] and [ADR-683], the only accepted-but-unbacked extension is `compatObjectFormat`
  (§3) — and it is unbacked in *git* too. Every other accepted name is either implemented,
  inert, or honoured by construction, so acceptance no longer opens a window between "the gate
  said yes" and "the reader understands the on-disk shape".
- **What remains open.** `compatObjectFormat` is refused rather than supported, which is
  faithful only for as long as git itself refuses it on the reference build. If a future git
  gains the Rust-backed support, the refusal becomes a divergence and must be revisited; the
  pinned §1i rows are what will detect that, because they assert git's refusal as co-truth
  rather than assuming it.

### 6. Genericity and symmetry checks

**Version genericity.** The comparison is `version > MAX_REPOSITORY_FORMAT_VERSION` with the
ceiling as a named constant (= 1), never membership in `{0, 1}` — §1a's `-1` row proves a
membership test would refuse where git accepts, and a named ceiling makes a future v2 a
one-line change. The v1-only arm keys on `version === 0` **exactly**, matching git's own
message text ("repo version is 0"): §1c measures `-1`, `-5` and *absent* all accepting a
v1-only extension, so any relaxation to `version <= 0` — or any collapse of "absent" into
`0` — refuses three shapes git accepts.

**Registry genericity.** The nine names are a constant describing **git's registry**, not
tsgit's capabilities ([ADR-667]). Two lists are needed and they are different: the nine
(for the unknown-at-v1 arm) and the five v1-only ones (for the v0 arm). Neither shrinks when
tsgit lacks support for a name, and neither grows when tsgit gains it — the only thing that
moves a name is a new git release, which is what makes the interop sweep of §1b the
regression detector for this constant.

**Width genericity.** Object-id width is exactly what `objectFormat` controls; the gate
itself hard-codes no width, and the sibling SHA-256 design owns the width question.
`parseGitInt` is int64, so no version literal git accepts can overflow tsgit's parse.

**Write-path / read-path symmetry.** `bootstrapRepository` writes
`repositoryformatversion = 0` and no `[extensions]` section, so nothing tsgit creates can
trip its own gate (R12) — an interop row asserts this in both directions
(tsgit-created → git-openable, git-created v0/v1 → tsgit-openable). The read side gains the
gate; the write side gains nothing, and that asymmetry is deliberate: tsgit has no reason to
emit a v1 repository until it implements an extension that requires one. The one place the
write side touches an accepted extension is `worktree.add`/`worktree.move` on a
`relativeWorktrees` repository, and §1h measures tsgit's absolute pointers matching git's own
default exactly.

**Read-path/read-path symmetry.** Two traps, both measured. §1e: the two key families read
from the same Stage-2 scan have *different* scoping rules, so a shared `pickScoped` call over
all four keys would be the natural refactor and would be **wrong**. §2: the two acceptance
gates drop the same scope at *different depths*, so a shared early return in `readConfig`
would be the natural refactor and would be wrong for the format arm.

## Decisions

Every candidate this design raised — the three original and the two it surfaced on revision —
is settled, each by its own ADR. One new candidate is open, and it is a question the ratified
mitigation creates rather than one the measurements left behind.

| # | Decision | Ratified choice |
|---|---|---|
| D1 | **Where the refusal is raised.** git's format gate is its own tier (§1f): every repository-needing verb dies, while four `config` read verbs demote the repository to absent and survive. | **The split** ([ADR-666]). The operational surface refuses; the four surviving `config` read verbs keep git's porcelain behaviour with the repository config scope dropped. §2 places it: one carried verdict on the layout, one check on `assertAcceptedRepository`, one scope check in the config scope reader — the same tier the ownership gate builds ([ADR-679]). The design's original objection to the split — that the sibling trust gate would have to replicate it — was void, and the two gates now share one mechanism. §1f's porcelain rows are **co-truth**, not an asserted divergence. |
| D2 | **The accepted-extensions set at v1.** | **Mirror git's nine** ([ADR-667]), with scope expanded so acceptance is not a lie. No divergence at the gate, no allowlist. §3 records how each name is backed after the expansion: four implemented (`worktreeConfig`, `partialClone`, `objectFormat` per [ADR-681], `refStorage` per [ADR-680]), two inert, one honoured by construction, one backed by the pointer resolution measured here (§1h), and exactly **one** — `compatObjectFormat` — refused precisely at the point of use (§1i). The standing rule — refuse at the point of use, never misread, never refuse to open what git opens — binds every future name. |
| D3 | **Error-code shape for the gate.** | **Two codes** ([ADR-668]): `REPOSITORY_FORMAT_VERSION_UNSUPPORTED { version }` and `REPOSITORY_EXTENSIONS_UNSUPPORTED { version, extensions }`. Every payload total, every reconstruction branch-free on a sentinel, matching the [ADR-654] precedent of two work-tree refusal codes for two distinct conditions. Point-of-use refusals (D5) are a separate family and do not reuse these codes; extension **value**-grammar refusals are a third family and reuse the config codes ([ADR-696]). |
| D4 | **Which assert carries the acceptance refusals.** [ADR-666] ratified the split without saying where it attaches, and tsgit's existing membership matched neither side: fifteen verbs shared bare `assertRepository` while §1f measures exactly four survivors. | **A third tier** ([ADR-682]) — **ratified by the user against this design's recommendation of inverting the default.** `assertRepository` keeps its meaning and its four survivors; the new `assertAcceptedRepository` = `assertRepository` + the four acceptance gates and takes the eleven movers; `assertOperationalRepository` = `assertAcceptedRepository` + the eager `[core]` gate and keeps its 45 modules. §2 enumerates the movers, verified against the symbol rather than inferred. The tier is explicit at every call site and names git's real three tiers — its cost is that it **fails open**, which is why D4 ships with the guard below rather than without it. |
| D5 | **The point-of-use refusal family's shape.** | **One generic code** ([ADR-685]): `REPOSITORY_EXTENSION_UNSUPPORTED { extension, value }`, raised at the point of use and never at the gate. Settled once for this design and the sibling SHA-256 design, which raised it independently; this design consumes it and does not re-specify it. Current membership is exactly one name (`compatObjectFormat`), which is a fact about how much the surrounding scope implements, not about the code — so the code stays general and a future unbacked name joins by name, with no new code and no new ADR. |
| D6 | **The fails-open mitigation D4 requires.** A future command reaching for bare `assertRepository` would silently operate on a rejected or untrusted repository. | **A mechanical allowlist guard, in this change** ([ADR-682]) — specified in §2a: `tooling/audit-assert-tier.ts` + `tooling/audit-assert-tier.allowlist.json`, wired as `check:assert-tier` in `validate`, blocking from day one, in the same allowlist-audit family as `check:write-surfaces` and `check:browser-surface`. It resolves the local binding of `assertRepository` across `src/`, attributes every call to its enclosing exported verb, and fails on an unguarded caller, a stale entry, or an unattributable call. `check:architecture` (dependency-cruiser) cannot host it: its rules are module-granular and the survivors and writers share `config.ts`. What is left genuinely open inside D6 is the guard's *granularity* — DN-3. |

### New and unsettled

One candidate, and it is new: it exists only because [ADR-682] chose the fails-open tier and
required a guard. Nothing in §1's matrix bears on it — it is an internal-structure question
about how the guard is expressed, with no observable difference to any caller and no
git-faithfulness content.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DN-3 | **The allowlist guard's granularity, and therefore its home.** [ADR-682] words the mitigation at **verb** granularity — "no module calls bare `assertRepository` unless it appears on an explicit allowlist of exactly those four verbs" — but the repo's architecture-tier check (`check:architecture`, dependency-cruiser) is **module**-granular, and the four survivors share `src/application/commands/config.ts` with the five writers. So verb granularity and the existing architecture harness cannot both be had without moving source. | **(a) A verb-granular audit script** — `tooling/audit-assert-tier.ts` + its allowlist JSON + `check:assert-tier` in `validate`, using the TypeScript compiler API already used by `tooling/dts-value-exports.ts` and `tooling/truthful-dts.ts`; §2a as written. **(b) A verb-granular source-scanning *test*** — `tooling/test/unit/assert-tier-consistency.test.ts` with the allowlist inline, following the `tooling/test/unit/hot-paths-consistency.test.ts` precedent; no wireit target, no report, runs inside `test:unit`. **(c) A module-granular dependency-cruiser rule** — move bare `assertRepository` into its own module (`src/application/primitives/internal/assert-repository.ts`), barrel-ise `commands/config.ts` into internal read-verb and write-verb modules, and express the allowlist as the `from.pathNot` list of one `forbidden` rule in `.dependency-cruiser.cjs`. | **(a)** | (a) is the only option that is simultaneously verb-granular (what [ADR-682] actually says), blocking in `validate` under the architecture-check family, and free of source churn in the modules it audits. It also matches the two existing allowlist audits exactly — same file shape, same `reason` field, same stale-entry posture — so there is nothing new for a reviewer to learn. (b) is cheaper by one wireit entry and one report, but it lands a shipping-safety precondition in the *test* tier: a skipped or filtered test suite silently disarms the guard, and `test:unit` is the tier most often scoped down during iteration. (c) is the most architecturally honest — the invariant becomes a property of the module graph rather than of a scanner — but it buys that by splitting a **published subpath** (`./commands/config`) into internal modules and by dropping to module granularity, so a fifth verb added to the read module would slip through the very rule that exists to catch it; it also trades a small guard for a real refactor inside a security change, which is the collateral [ADR-682] rejected option 3 for. If the user prefers (c), the module split should be its own commit ahead of the gate, not folded into it. |

## Test strategy

**Unit** — the read side extends `test/unit/repository/read-repository-format.test.ts` (the
file already covers absence, `core.bare`, `core.worktree`, `config.worktree` scoping and both
existing throws, with `MemoryFileSystem` + `posixPolicy` + `fileSystemLayoutProbe`, and uses
try/catch + direct `.data` assertions for every refusal — the mutation-resistant pattern
CLAUDE.md mandates). New Given/When/Then groups, one per §1 family:

- every §1a version literal — accepted rows assert the parsed value, refused rows assert the
  carried `{ kind: 'version', version }`, grammar rows assert the **thrown**
  `{ code: 'CONFIG_BAD_NUMERIC_VALUE', key: 'core.repositoryformatversion', source, value, reason }`
  with `reason` isolated per arm;
- the four §1a resolution rows (last-wins accepted, last-wins refused, early-malformed,
  late-malformed) — each as its own test, since they are separate guards;
- case-insensitivity of `[core]`/key, and the `[core "x"]` no-op;
- each of the nine extensions × {absent, v0, v1} as an `it.each` sweep over a table whose
  oracle shape is uniform (accept / v1-only-refuse / unknown-refuse), plus an unknown name in
  the same three states — the absent column is what stops `0` and "absent" being collapsed.
  The `compatObjectFormat` × v1 cell is the one that **throws** rather than carrying a
  verdict (§1i), so it is asserted separately rather than folded into the sweep's oracle;
- §1i's own matrix as its own group, because the predicate has four independent guards and
  CLAUDE.md requires each to be triggered alone: absent version accepts, `-1` accepts, `0`
  takes the v1-only arm, `2`/`99` take the version arm, a subsectioned spelling takes the
  unknown arm, a valueless entry raises the config-syntax refusal, and only the top-level
  valued entry at version exactly 1 throws the compat code — plus the four ordering rows
  (`core.bare`, `extensions.worktreeConfig` and an unknown sibling each beat it;
  `core.sparseCheckout` loses to it);
- the §1c list shapes: singular, plural, file order, duplicates, valueless, subsectioned
  (`X.bogus`, `.bogus`, `x.worktreeconfig`);
- §1e: version and extensions planted in `config.worktree` are inert, while
  `core.bare`/`core.worktree` there still win — one test each, so the asymmetry is pinned
  from both sides;
- §1e/R8: `extensions.worktreeConfig` honoured at v0;
- §1d step 3 versus step 4: an open-time layout refusal (`core.bare = banana`) fires and no
  verdict is carried; a v99 repository carries a verdict and throws nothing at open.

The tier side lands against `repo-state.ts` (existing tests under
`test/unit/application/primitives/internal/`), and now covers three asserts rather than two:
`assertAcceptedRepository` throws each of the two gate codes off a frozen layout field;
`assertRepository` throws **neither** on the same layout (the survivors' arm — one test per
code, so a mutant that drops one guard cannot hide behind the other);
`assertOperationalRepository` throws the format code **before** `assertEagerConfigValid`'s
(§1d's step-4-beats-step-5 row); and `assertDiscoveryBooleansValid`'s refusal beats all of
them. Plus the config scope reader: a merged read drops `local`/`worktree` on a rejected
layout while keeping `global`/`system`, and an explicit `local` scope raises
`CONFIG_SCOPE_NOT_AVAILABLE`.

**The allowlist guard needs its own test**, and it is not covered by any of the above — the
guard is tooling, not `src/`. `tooling/test/unit/audit-assert-tier.test.ts`, modelled on
`tooling/test/unit/audit-write-surfaces.test.ts` and driven off in-memory source strings
rather than the real tree so the fixtures are readable and the invariants are isolated:

- a module calling the bare assert from a **non-allowlisted** exported verb is reported, with
  the module, the verb and the line in the finding;
- the same call from an **allowlisted** verb is not reported;
- an allowlist entry matching **no** call site is reported as stale;
- an aliased import (`import { assertRepository as gentle }`) is still attributed — binding
  resolution, not name matching;
- a call reached through the deprecated `commands/internal/repo-state.ts` **re-export shim** is
  attributed to the calling verb, not to the shim (this is the arm that would silently pass
  under an import-path guard, and `config.ts` is a live instance of it today);
- a call that cannot be attributed to an exported declaration **fails** rather than being
  skipped;
- a malformed allowlist (missing `reason`, empty `reason`, not an array) raises the loader's
  error rather than degrading to an empty allowlist — the fail-open-on-bad-input arm;
- the shipped `tooling/audit-assert-tier.allowlist.json` has exactly the five documented
  entries, so shipping a sixth is a diff a reviewer sees in this test too.

One integration-shaped assertion belongs with it: the audit run over the **real** `src/` tree
exits 0. That is the arm that fails the day someone adds a fifth caller, and it is the reason
the audit is a `validate` dependency rather than advisory.

`list-worktrees.ts` gains its own group for §1h: a relative `<admin>/gitdir` resolves to the
same entry an absolute one produces, `prunable` is computed from the resolved path, and a
pointer escaping the worktree scope after resolution still refuses.

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
7. **The nine-name acceptance sweep**: each of git's nine planted at v1, asserting both tools
   accept — the regression detector for the §1b registry constant against a future git.
8. **Tier co-truth** (§1f), and it must cover the refusing side as thoroughly as the
   surviving one, because the surviving set is four verbs out of the fifteen that shared one
   assert before [ADR-682] split them. This sweep is also the evidence an allowlist entry
   points at: a verb may only join `tooling/audit-assert-tier.allowlist.json` once it has a
   row here (§2a). Surviving: `config --list` and `--list --show-origin` exit 0 with an empty
   repository scope in both tools, `config core.bare` / `config remote.origin.url` /
   `config --get-regexp ^remote` "not found" in both, and a `config --global --list` row
   proving the scopes that remain are untouched. Refusing: `config --local --list`, each of
   the five `config` **writers** (with the repository config file asserted **byte-unchanged**
   afterwards), and each of the six `remote` verbs — `remote`, `remote -v`,
   `remote get-url`, `remote show -n`, `remote add`, `remote set-url` — refusing in both
   tools. A row-per-verb sweep, not a spot check: a verb that silently survives is precisely
   the failure the allowlist guard exists to prevent — the sweep catches it for the fifteen
   verbs that exist today, and §2a's guard catches it for the sixteenth.
9. **Precedence co-truth** (§1d), both tiers per row: `core.bare = banana`,
   `extensions.worktreeConfig = banana` and a broken config line each beat the version on
   `config --list` *and* on an operational verb; `core.sparseCheckout = banana`,
   `core.maxTreeDepth = abc` and a valueless `core.excludesFile` each lose to the version on
   the operational verb and never fire on the porcelain. The step-5 rows go here too, and
   they are the ones that prove the tier is per-condition: on a v1 `compatObjectFormat`
   repository `config --list` dies in both tools, while on the v99 repository three rows
   above it it survives in both.
10. Route coverage (R5): subdirectory, explicit `gitDir`, cwd-is-gitdir bare, linked worktree
    via the common config, and the nested-inside-a-good-repo no-climb-past row.
11. Bootstrap (R11/R12): `init` against an existing v99 repository refuses in both tools with
    the config byte-unchanged (§1g — the refusal, not the code, is the oracle); a
    tsgit-created repository is v0 with no `[extensions]` and opens in git.
12. **§1h `relativeWorktrees`**, `skipIf` gated on `git worktree add --relative-paths` being
    available: a relative worktree set built by git, then `worktree.list` in tsgit against
    `git worktree list` — same paths, same `prunable` verdicts — plus the same comparison
    after relocating the whole tree, which is the property the extension exists for.
13. **§1i `compatObjectFormat`**, the full version matrix as co-truth: absent and `-1` both
    tools operate the repository; `0` both take the v1-only arm and the porcelain survives;
    `1` both refuse every verb including `config --list`; `2`/`99` both take the version arm
    and the porcelain survives. The `= 1` row is what will detect a future git gaining the
    Rust-backed support, and the surrounding rows are what stop the refusal over-reaching.
14. **The backed extensions**, owned by the sibling suites but cross-referenced here: a real
    `--object-format=sha256` repository and a real `--ref-format=reftable` repository must
    pass the acceptance gate (no format refusal) — this suite asserts the *gate's* verdict
    only; the sibling suites assert the repositories operate.

**Property tests** — applying CLAUDE.md's four lenses honestly, **no `*.properties.test.ts`
sibling is warranted for the gate itself**: the version parse delegates entirely to
`parseGitInt`, which already carries its own coverage (lenses 1 and 3 belong there, not here);
the acceptance predicate is a lookup against a closed nine-element registry, which the "small
enum ⇒ parameterised sweep" exclusion covers and whose only oracle would be the registry
itself (the lens-4 tautology exclusion). The one honest candidate is the **extension
enumerator** — a counting/order invariant (lens 4: *N* `[extensions]` entries in a generated
config ⇒ *N* reported names, in the same order, subsection-qualified). If the enumerator
lands as a standalone `ConfigToken[] → ReadonlyArray<string>` function it earns a small
sibling asserting that invariant over arbitrary `[extensions]` blocks; if it lands inlined in
`readRepositoryFormat`, the `it.each` sweep above covers it and no sibling is added.

**Public-surface gates** — the new codes touch: the union members + factories
(`src/domain/repository/error.ts`, next to `NOT_A_REPOSITORY` / `WORK_TREE_CONFIG_INVALID`),
the rendered detail in `src/domain/error.ts`, one new `reason` literal on
`CONFIG_SCOPE_NOT_AVAILABLE` (`src/domain/commands/error.ts`), a row per code in
`docs/use/errors.md` → *Repository state* (Code / Payload / Raised when, matching the depth of
the neighbouring `WORK_TREE_CONFIG_INVALID` and `CONFIG_BAD_BOOLEAN_VALUE` rows), the new
`RepositoryLayout` field on the `openRepository` docs page **together with the enumerated
surviving-verb set** ([ADR-666]'s first consequence, now a documented **three-tier** contract
per [ADR-682]: which verbs sit on `assertRepository`, which on `assertAcceptedRepository`,
which on `assertOperationalRepository`), and a regenerated `reports/api.json` committed at
pre-PR. `src/domain/repository/` is inside the coverage scope, so the new factories and their
rendering arms need 100 % line/branch coverage and a zero-survivor mutation result.

Two gates are new to the *harness* rather than to the public surface, and both belong to §2a:
the `check:assert-tier` wireit target added to `validate`'s dependency list, and
`tooling/audit-assert-tier.allowlist.json` committed with its five entries. The audit's own
sources are inside `tooling/`, which sits outside the 100 %-coverage scope but inside
`tooling/test/unit`'s reach — the same posture `audit-write-surfaces` and
`audit-browser-surface` already have.

## Out of scope

- **The ownership/trust (`safe.directory`) gate** — a sibling design in this PR
  (`docs/design/ownership-trust-gate.md`), whose own predicate, allowlist grammar and probe
  capability are not designed or probed here — including the ordering of `implicitBare` and
  `untrusted` relative to each other inside `assertAcceptedRepository`, and the surviving set
  for the implicit-bare refusal, both of which that design measures. What the two designs
  **do** share is now large and named: one acceptance tier (`assertAcceptedRepository`,
  [ADR-682]), one allowlist guard over the tier below it (§2a covers both gates, since all
  four refusals ride the one assert), one dropped-scope rule, one
  `CONFIG_SCOPE_NOT_AVAILABLE` reason literal, and one enumerated surviving-verb set on the
  docs page. §2 states the one place the two gates must **not** share an implementation
  point.
- **SHA-256 object format** — designed separately in this PR
  (`docs/design/sha256-object-format.md`), ratified as full read/write/create parity
  ([ADR-681]) with bundle v3 ([ADR-683]) and a repository-aware oid predicate ([ADR-694]).
  This design accepts `objectFormat`, records it as **implemented** in §3, and specifies none
  of it.
- **Reftable ref storage** — designed separately in this PR
  (`docs/design/reftable-ref-storage.md`), ratified as a complete backend including writing
  and compaction on all three adapters ([ADR-680]). This design accepts `refStorage`, records
  it as **implemented** in §3, and specifies none of it.
- **Bundle v3** — the `@object-format` capability header ([ADR-683]) belongs to the SHA-256
  design. Named here only because it is part of what makes §3's "eight of nine are backed"
  true; nothing about it is designed or edited here.
- **Implementing `compatObjectFormat`** — git itself refuses it on the reference build (§1i),
  so there is nothing to be faithful to. It is refused at the point of use; implementing it
  is separate work that would be triggered by a future git gaining the support.
- **Emitting relative worktree pointers** — a `--relative-paths` equivalent on
  `worktree.add`/`worktree.move`. §1h measures git writing absolute pointers by default even
  on a repository carrying the extension, and tsgit already matches that, so nothing here
  requires the write-side feature.
- **Writing a v1 repository** — no `init --object-format` / `--ref-format` equivalent from
  this design, no `[extensions]` emission. The write path is unchanged (R12). One adjacent
  write-path gap was measured and is deliberately left alone: `git clone --filter=blob:none`
  writes `repositoryformatversion = 1` with **no** `[extensions]` section (the filter lives in
  `[remote "origin"] promisor` / `partialclonefilter`), while tsgit's `bootstrapRepository`
  writes `0` for every clone. Both are accepted by both tools — a v1 repository with no
  extensions is accepted (§1a) and a promisor remote at v0 is accepted (§1b) — so this gate
  neither creates nor closes the gap.
- **Rendering git's `warning:` lines** — §1f's two warnings are display, and the library emits
  no display string ([ADR-249]).
- **`extensions.*` value-grammar refusals for accepted extensions** beyond what already
  exists — `extensions.worktreeConfig = banana` is already the discovery-boolean gate's job
  (`repo-state.ts:63`). Now that all nine names are accepted, the value refusals git measures
  for `preciousObjects`, `relativeWorktrees`, `partialClone`, `objectFormat` and `refStorage`
  (§1b) become reachable conditions; each belongs to the subsystem that consumes the value —
  and for the two enums that subsystem has now settled its codes: `CONFIG_INVALID_ENUM_VALUE`
  plus `CONFIG_MISSING_VALUE` for `objectFormat` and `refStorage` ([ADR-696]), owned by the
  SHA-256 and reftable designs. The remaining boolean and string grammars are separate work.
  None of it belongs to the acceptance gate, which never parses an extension's value.
- **Guarding `assertAcceptedRepository` itself** — §2a states why: a verb that takes it in
  place of `assertOperationalRepository` misses only the eager `[core]` gate, a measured
  *different* tier with no attacker-relevant content ([ADR-639]). The guard fences bare
  `assertRepository` alone, which is what [ADR-682] requires.
- **Retiring the deprecated `commands/internal/repo-state.ts` shim** — §2 drops `config.ts`'s
  use of it for this one symbol; the shim's other re-exports and their callers are untouched,
  and the guard is call-site based specifically so the shim's existence changes nothing.

[ADR-226]: ../adr/226-git-faithfulness-prime-directive.md
[ADR-249]: ../adr/249-describe-structured-data-only.md
[ADR-639]: ../adr/639-ungated-commands-join-the-eager-config-gate.md
[ADR-654]: ../adr/654-two-work-tree-refusal-codes.md
[ADR-658]: ../adr/658-layout-read-surface-is-a-facade-field.md
[ADR-661]: ../adr/661-layout-config-read-includes-config-worktree.md
[ADR-664]: ../adr/664-layout-config-refusals-surface-at-open-time.md
[ADR-666]: ../adr/666-repository-format-refusals-keep-gits-config-porcelain-tier.md
[ADR-667]: ../adr/667-tsgit-accepts-every-extension-git-knows.md
[ADR-668]: ../adr/668-two-repository-format-refusal-codes.md
[ADR-678]: ../adr/678-an-untrusted-repository-still-exposes-its-structural-layout.md
[ADR-679]: ../adr/679-an-untrusted-repository-reads-as-an-empty-config-scope.md
[ADR-680]: ../adr/680-reftable-ships-as-a-complete-backend.md
[ADR-681]: ../adr/681-sha256-reaches-full-write-parity.md
[ADR-682]: ../adr/682-acceptance-refusals-attach-to-a-third-tier.md
[ADR-683]: ../adr/683-bundle-v3-is-implemented-now.md
[ADR-684]: ../adr/684-dubious-ownership-carries-an-optional-foreign-path.md
[ADR-685]: ../adr/685-one-generic-point-of-use-refusal-code.md
[ADR-694]: ../adr/694-width-correctness-comes-from-a-repository-aware-oid-predicate.md
[ADR-696]: ../adr/696-extension-enum-values-reuse-the-config-error-family.md
