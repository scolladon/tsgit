# Design — interop-helper-env-hardening

> Brief: harden `test/integration/interop-helpers.ts` so every spawned `git` reads no developer global/system config (isolated `HOME` + `GIT_CONFIG_NOSYSTEM=1`, keeping the existing `GIT_*` scrub), then sweep the ~44 `*-interop.test.ts` suites for tests that silently depend on ambient config.
> Status: draft → self-reviewed ×2 → accepted

## Context

### What `interop-helpers.ts` does today

`test/integration/interop-helpers.ts` is the shared spawn surface for every write-surface interop test. It computes a sanitised env **once at module load** and reuses it for all `git` invocations:

- `buildSafeEnv()` clones `process.env`, **drops every `GIT_*` key**, then sets `GIT_CEILING_DIRECTORIES = os.tmpdir()`. The result is frozen into the module-level constant `SAFE_ENV`.
- `runGit(args, { input?, env? })` → `execFileSync('git', …, { env: options.env ?? SAFE_ENV })`. The `args`-as-array shape never shells through a string.
- `runGitEnv()` returns a **fresh shallow copy** `{ ...SAFE_ENV }` so callers can spread it and add per-test vars: `{ ...runGitEnv(), GIT_AUTHOR_DATE, GIT_COMMITTER_DATE }`, `{ ...runGitEnv(), GIT_AUTHOR_NAME, … }`. 30+ suites spread it.
- `tryRunGit(args, { env? })` wraps `runGit` in try/catch for co-refusal assertions; it reuses the same `SAFE_ENV` scrubbing.
- Convenience wrappers: `git(dir, …args)` (= `runGit(['-C', dir, …])`), `initBothRepos` (sets `user.name=Ada` / `user.email=ada@example.com` per repo), `lsStage`, `writeTreeOf`, `topReflogSubject`, `makePeerPair`, `hasGit`, `GIT_AVAILABLE`.

### Why the current scrub is insufficient

The `GIT_*` scrub fixes one trap (`GIT_DIR` env leakage from the husky pre-push hook — see project memory "Isolate git subprocess env"). It does **not** isolate config discovery. Spawned git still inherits the developer's `HOME`, so it reads `~/.gitconfig` (global) — and with no `GIT_CONFIG_NOSYSTEM`, it also reads `/etc/gitconfig` (or `$(brew --prefix)/etc/gitconfig`). The pinned design matrices that the interop tests assert against were produced under `env -i` + isolated `HOME` + `GIT_CONFIG_NOSYSTEM=1`; the tests run under a *different, dirtier* env. This is the same trap class as the `merge.conflictStyle=diff3` flake (project memory "Interop conflict-style diff3 trap"): the dev's global config silently changes git's observable bytes, so a green local run is not a faithful run.

The faithfulness pinning procedure (`.claude/workflow/faithfulness.md`) already mandates exactly this isolation **for probes**: *"Run real `git` controlled: scrub all `GIT_*`, isolate `HOME`, signing OFF."* This backlog promotes that discipline from a per-probe ritual into an always-on property of the helper that the *test suite itself* runs under.

**Existing precedent (proves the shape, motivates centralising it).** One suite — `missing-value-refusal-interop.test.ts` — *already* hand-rolls this exact hardening locally: it `mkdtemp`s an isolated `HOME` per test (with `afterEach` `rm` cleanup), then builds its commit env as `{ ...runGitEnv(), GIT_CONFIG_NOSYSTEM: '1', HOME: isolatedHome }`. That suite needed it because its valueless-identity assertion only holds when git reads *no* ambient `user.*`. This backlog hoists that pattern into the shared helper so the other 42 suites get it for free and no future suite has to reinvent (or forget) it.

### How the suites consume the helper (the sweep, summarised)

44 `*-interop.test.ts` files exist. One, `adapter-domain-interop.test.ts`, spawns **no real git** (it exercises the memory adapter + domain parsers cross-adapter; it has no `GIT_AVAILABLE` guard and does not import the spawn helpers) — out of scope. The other 43 spawn git via the helper. The full per-key sweep is in **§ Sweep findings**.

### Faithfulness pinning procedure

The empirical-pinning contract for this doc: `.claude/workflow/faithfulness.md`; prime directive: [ADR-226](../adr/226-git-faithfulness-prime-directive.md). All matrices below were pinned against the real `git` binary; none are from memory.

## Requirements

Verifiable statements (each maps to a test or a pinned matrix row):

1. **No developer global config is read.** Spawned git resolves no value from `~/.gitconfig` for any of: `merge.conflictStyle`, `init.defaultBranch`, `user.name`, `user.email`, `commit.gpgsign`, `diff.external`, `core.excludesfile`, and any custom `merge.<name>.driver`. (Matrix B.)
2. **No system config is read.** Spawned git resolves no value from `/etc/gitconfig` / `$(brew --prefix)/etc/gitconfig` (`credential.helper=osxkeychain` is the canary). (Matrix B.)
3. **No `XDG_CONFIG_HOME` config is read.** If the dev has `XDG_CONFIG_HOME` set to a directory containing `git/config`, spawned git must not read it. (Matrix C — independent leak vector, not covered by HOME isolation alone.)
4. **The per-test env spread survives.** `{ ...runGitEnv(), GIT_AUTHOR_DATE: … }` and `{ ...runGitEnv(), GIT_AUTHOR_NAME: … }` callers still get the isolation; the `HOME` / `GIT_CONFIG_NOSYSTEM` / scrub keys are present in the spread and are not clobbered by the author/committer additions.
5. **Explicit per-invocation config still wins.** A suite that *wants* a non-default value (`-c merge.conflictStyle=diff3`, `-c commit.gpgsign=false`) still gets it; isolation removes ambient defaults, it does not block explicit `-c`. (Matrix E.)
6. **Every existing interop suite still passes** under `npm run validate` after hardening — no behaviour change for suites that already set their config explicitly, and the now-redundant per-test `-c merge.conflictStyle=merge` / `--local` workarounds keep working (belt-and-suspenders).
7. **No `GIT_*` regression.** The existing `GIT_*` scrub + `GIT_CEILING_DIRECTORIES` guard is retained unchanged.
8. **Module-load lifecycle is sound.** Whatever `HOME` strategy is chosen has a defined cleanup story (or a pinned justification that none is needed).

## Design

### Empirical pinning (git 2.54.0, darwin)

All probes ran with `GIT_*` scrubbed. WRITE probes ran in `mktemp -d` throwaways, never in the worktree (a worktree shares `.git/config` with the main checkout and all siblings via the common dir). The dev's real ambient config used as the test oracle:

```
# ~/.gitconfig (global) — relevant keys
init.defaultbranch=main
merge.conflictstyle=diff3
commit.gpgsign=true
diff.external=difft
user.name=Sébastien Colladon
user.email=colladonsebastien@gmail.com
core.excludesfile=~/.gitignore
merge.mergiraf.driver=mergiraf merge … (custom driver)
# $(brew --prefix)/etc/gitconfig (system)
credential.helper=osxkeychain
```

#### Matrix A — current `SAFE_ENV` LEAKS (inherited HOME, no NOSYSTEM)

Env = `GIT_*` scrubbed + `GIT_CEILING_DIRECTORIES=<tmp>` + **inherited `HOME`**, no `GIT_CONFIG_NOSYSTEM`. Each `git config --get <key>`:

| key | value read | exit | source |
|---|---|---|---|
| `merge.conflictStyle` | `diff3` | 0 | global |
| `init.defaultBranch` | `main` | 0 | global |
| `user.name` | `Sébastien Colladon` | 0 | global |
| `user.email` | `colladonsebastien@gmail.com` | 0 | global |
| `commit.gpgsign` | `true` | 0 | global |
| `diff.external` | `difft` | 0 | global |
| `core.excludesfile` | `~/.gitignore` | 0 | global |
| `merge.mergiraf.driver` | `mergiraf merge …` | 0 | global |
| `credential.helper` | `osxkeychain` | 0 | **system** |

Every key leaks. This is the bug.

#### Matrix B — hardened env reads NOTHING

Env = `GIT_*` scrubbed + **`HOME=<empty tmpdir or non-existent path>`** + **`GIT_CONFIG_NOSYSTEM=1`** + `XDG_CONFIG_HOME` unset + `GIT_CEILING_DIRECTORIES`. Same nine `git config --get`:

| key | value read | exit |
|---|---|---|
| all nine keys above | *(none)* | **1** (not found) |

Every probe returns exit 1 / no value. Confirmed clean. Built-in defaults take over where they exist (e.g. `merge.conflictStyle` unset → git's built-in 2-way `merge` style, which is what the design matrices assume).

#### Matrix B2 — behaviour shift to be aware of: `init` default branch

| env | `git init` then `symbolic-ref HEAD` |
|---|---|
| current (leaks `init.defaultBranch=main`) | `refs/heads/main` |
| hardened (no config) | **`refs/heads/master`** |

Implication: any suite relying on the *ambient* `init.defaultBranch` would flip `main`→`master`. The sweep confirms **no suite relies on it** — every `init` in the corpus passes `-b main` (or `-b <branch>`) explicitly, and `initBothRepos` defaults its `branch` param to `main`. So this shift is latent, not active; hardening makes the corpus robust against a dev whose global config sets a different default branch.

#### Matrix C — `XDG_CONFIG_HOME` is an independent leak vector

With isolated `HOME` but `XDG_CONFIG_HOME` pointed at a dir containing `git/config` (`merge.conflictStyle=zealous-diff3`):

| env | `git config --get merge.conflictStyle` | exit |
|---|---|---|
| isolated HOME, `XDG_CONFIG_HOME` → real `git/config` | `zealous-diff3` | 0 (**leak**) |
| isolated HOME, `XDG_CONFIG_HOME` unset | *(none)* | 1 (clean) |

git reads `$XDG_CONFIG_HOME/git/config` independently of `HOME`. The dev's `XDG_CONFIG_HOME` is currently **unset**, so this is dormant — but `buildSafeEnv` passes through every non-`GIT_*` key, so a dev who sets `XDG_CONFIG_HOME` (common on Linux) would reintroduce the leak. Closing it is cheap. → Decision candidate (b).

#### Matrix D — non-existent `HOME` fail-soft (lifecycle pin)

Env with `HOME=/var/folders/does-not-exist-…` (a path that does not exist), `GIT_CONFIG_NOSYSTEM=1`:

| operation | result |
|---|---|
| `git config --get user.name` | exit 1 (no value, no error) |
| `git init -b main` → `add` → `commit` (with `GIT_AUTHOR_*`/`GIT_COMMITTER_*` + `-c user.*`) | exit 0, commit created (`log --oneline` shows it) |
| does git create `$HOME`? | **No** — the path still does not exist afterwards |
| does git write anything under `$HOME`? | **No** |

git treats a missing global-config dir as "no global config" and never writes to `$HOME` during read/init/add/commit (it would only write there for `git config --global …`, which the corpus never runs). This pins the lifecycle: **a `HOME` that git only ever reads from needs no cleanup** — whether it is an empty real tmpdir or a non-existent path. (Caveat: some platform credential/askpass helpers can write under `$HOME`; the corpus disables signing and uses no credential flows, so this does not arise — but it informs candidate (a)/(c).)

#### Matrix E — explicit `-c` survives hardening (escape hatch)

Hardened env (isolated HOME, NOSYSTEM):

| invocation | `merge.conflictStyle` | exit |
|---|---|---|
| `git config --get merge.conflictStyle` (no `-c`) | *(none → built-in `merge`)* | 1 |
| `git -c merge.conflictStyle=diff3 config --get merge.conflictStyle` | `diff3` | 0 |

Confirms requirement 5: a suite that legitimately wants a non-default style sets it per-invocation and still gets it.

### The hardening shape

`buildSafeEnv()` gains three additions on top of the existing `GIT_*` scrub + `GIT_CEILING_DIRECTORIES`:

1. `env.HOME = <isolated dir>` — strategy is decision candidate (a).
2. `env.GIT_CONFIG_NOSYSTEM = '1'` — closes the system-config vector (Matrix B canary `credential.helper`).
3. Neutralise `XDG_CONFIG_HOME` (drop it from the cloned env, or per candidate (b) point it inside the isolated HOME) — closes Matrix C.

These land in the single `buildSafeEnv()` factory, so all four consumers inherit them automatically:

- `runGit` / `tryRunGit` (default `env: SAFE_ENV`) — covered directly.
- `runGitEnv()` returns `{ ...SAFE_ENV }`, so the isolation keys are **part of the spread**. The 30+ callers that add `GIT_AUTHOR_*` / `GIT_COMMITTER_*` / `GIT_*_DATE` append *different* keys, so the spread never clobbers `HOME` / `GIT_CONFIG_NOSYSTEM`. Requirement 4 holds by construction. (Verified against the leak: `GIT_AUTHOR_*` are not `HOME`/`XDG`/`GIT_CONFIG_*`, so no key collision.)

Because the change is confined to one factory and the public helper signatures (`runGit`, `runGitEnv`, `tryRunGit`, `git`, …) are unchanged, no call site needs editing for the hardening itself. The sweep determines whether any call site’s *now-redundant* workaround should be cleaned up (decision candidate (d) — recommended: leave them, they are harmless belt-and-suspenders and the doc trail explains why).

### Module-load lifecycle

`SAFE_ENV` is computed once at import. If the chosen `HOME` strategy creates a tmpdir (candidate (a) variant 1), that dir is created at module-load and Matrix D proves git never writes into it, so an orphaned empty dir under `os.tmpdir()` is the only residue. Options: register an `afterAll`/process-exit cleanup, or accept the empty-dir leak (the OS reclaims `os.tmpdir()`), or sidestep creation entirely with a non-existent path (candidate (a) variant 3) or a guaranteed-empty existing dir (variant 2). This is decision candidate (c), coupled to (a).

## Decision candidates

> The user decides these in the ADR phase. Each ≤3 alternatives with a recommendation; recommendations are advisory.

| # | Decision | Alternatives | Recommendation |
|---|---|---|---|
| **(a)** | How is `HOME` isolated? | **1.** Create one empty tmpdir at module load (`mkdtempSync(os.tmpdir()+'/tsgit-interop-home-')`), set `HOME` to it. — **2.** Point `HOME` at a guaranteed-empty existing dir (e.g. `os.tmpdir()` itself, or a fixed `os.tmpdir()/tsgit-interop-empty-home`). — **3.** Set `HOME` to a deterministic non-existent path under `os.tmpdir()` and rely on git fail-soft (Matrix D). | **1 (create one empty tmpdir at module load).** Most defensible and matches the existing precedent — `missing-value-refusal-interop.test.ts` already `mkdtemp`s an isolated HOME per test. An empty real dir means git's read of `~/.gitconfig` and any helper that *expects* `$HOME` to exist both behave; Matrix D shows no writes occur so it stays empty. Doing it once at module load (vs per-test) matches the once-computed `SAFE_ENV` lifecycle. Variant 3 is leanest (no cleanup, Matrix D proves it safe) but relies on git tolerating a missing `$HOME` for *every* future operation, a faithfulness footgun if a suite later adds a credential/askpass flow. Variant 2 risks a non-empty dir if the path is reused. |
| **(b)** | Also neutralise `XDG_CONFIG_HOME`? | **1.** Unset (delete) `XDG_CONFIG_HOME` from the cloned env. — **2.** Point `XDG_CONFIG_HOME` at a path inside the isolated `HOME` (`<HOME>/.config`), so git's XDG lookup lands in the empty isolated tree. — **3.** Do nothing (rely on it being unset on the dev's machine). | **2 (point it inside the isolated HOME).** Matrix C proves XDG is an independent vector; option 3 is a latent leak on any Linux dev box. Pointing it inside the isolated HOME is self-consistent with candidate (a) and survives a child process that itself sets XDG relative defaults. Option 1 (unset) is simpler and equally correct for git itself; pick it if minimal env surface is preferred over self-consistency. |
| **(c)** | Cleanup story for a created tmpdir (only if (a)=variant 1 or 2-with-creation) | **1.** Accept the empty-dir leak (OS reclaims `os.tmpdir()`); document it. — **2.** Register a `globalTeardown` / process `exit` handler in the vitest setup that `rm -rf`s the dir. — **3.** Recreate-and-remove per `makePeerPair` instead of once at module load. | **1 (accept the empty-dir leak), documented.** Matrix D proves the dir stays empty (git writes nothing into it), and `os.tmpdir()` is OS-reclaimed; a teardown hook adds machinery for a zero-byte residue. Choose 2 if the project wants strictly zero tmp residue (mirrors `makePeerPair`'s explicit `dispose`). Variant 3 fragments the once-at-load `SAFE_ENV` model and is not recommended. |
| **(d)** | Scope of the sweep — what to do with now-redundant per-test workarounds (`-c merge.conflictStyle=merge`, `--local`, `commit.gpgsign=false`, and the hand-rolled HOME/NOSYSTEM env in `missing-value-refusal`) | **1.** Leave every workaround in place (belt-and-suspenders); hardening is purely additive. — **2.** Remove the redundant `-c merge.conflictStyle=merge` / `--local` / `gpgsign=false` pins now that the helper guarantees isolation. — **3.** Leave the per-test pins but delete only `missing-value-refusal`'s now-duplicated `makeCleanEnv` HOME/NOSYSTEM (it would be subsumed by the helper). | **1 (leave them).** They are correct and harmless; removing them widens the diff, risks reintroducing the trap if the helper is ever weakened, and the explanatory comments document the historical hazard. The point of this backlog is the *helper* guarantee, not a corpus-wide cleanup. Option 3 is the smallest justified cleanup (the precedent suite's local hardening becomes truly redundant), and is a reasonable middle ground if the user wants the duplication gone; do it only if it can stay behaviour-preserving. Option 2 is a broader tidy that belongs in its own backlog entry, not folded in here. |

## Test strategy

This is a **test-infrastructure** change; the primary proof is that the existing suite stays faithful and green.

1. **Regression gate (load-bearing):** full `npm run validate` (all 43 git-spawning interop suites + unit + types + lint + coverage) stays green under the hardened helper. Because the dev's global config currently *masks* the absence of explicit config in some suites (none found — but the sweep is the evidence), a green run after hardening proves the corpus was already self-sufficient.
2. **Focused isolation assertion (recommended):** a small interop test asserting the helper env reads no ambient config — e.g. spawn `git config --get merge.conflictStyle` and `git config --get credential.helper` through `runGit` and assert exit 1 / empty (`tryRunGit(...).ok === false`). This is a *regression tripwire*: it fails loudly if a future edit drops the `HOME`/NOSYSTEM keys, even on a dev whose global config is clean. It must not assert a *specific* leaked value (that would only pass on the author's machine) — it asserts *absence*. Follows the Given/When/Then + AAA + `sut` conventions; `sut` is the helper env / `runGit`.
3. **No new property tests:** the helper is I/O orchestration with no algebraic grammar (CLAUDE.md "When property tests are NOT appropriate"). Skip.
4. **No source/test phase refs:** the tripwire test and helper carry no backlog/ADR/phase markers (provenance lives here + in the commit).

## Out of scope

- The other 24.9x backlog entries (e.g. 24.9c config quoted values — already shipped; 24.9-series config parity work).
- Any **production** (`src/`) code — this is purely `test/integration/` infrastructure. tsgit's own config discovery (`readConfig`, `getConfigValue`) is local-only by design and unaffected.
- Non-interop unit helpers under `test/_helpers/` — unit-scoped, do not spawn git.
- `adapter-domain-interop.test.ts` — spawns no real git (cross-adapter, memory + domain only); not a consumer of the spawn helpers.
- Corpus-wide cleanup of now-redundant `-c merge.conflictStyle=merge` / `--local` workarounds (decision candidate (d); if pursued, a separate backlog entry).
- Windows path semantics for the isolated `HOME` (`USERPROFILE` vs `HOME`) — the interop suite runs on the POSIX CI lanes; if Windows interop is later added, the `HOME`/`USERPROFILE` split is a follow-up.

## Sweep findings

Corpus: 44 `*-interop.test.ts`. **1 spawns no git** (`adapter-domain-interop.test.ts` — out of scope). The other **43** spawn git via the helper. Per-key dependency on *ambient* config:

- **User identity (`user.name` / `user.email`):** No suite that commits relies on ambient `user.*`. Every committing suite sets identity explicitly — either via `initBothRepos` (`config user.name Ada` / `user.email ada@example.com`), via per-repo `git config user.*`, or via spread `GIT_AUTHOR_*` / `GIT_COMMITTER_*`. The four suites that set *no* identity (`add-interop`, `mv-interop`, `symbolic-ref-interop`, `adapter-domain-interop`) **never commit** — they only `init -b main` + `add` / `mv` / `symbolic-ref` / `write-tree`, none of which read identity. Without hardening, the dev's `user.name=Sébastien Colladon` would have leaked into any unguarded commit; the corpus guards every one.
- **`merge.conflictStyle`:** Already defended per-test. `add-add-content`, `conflict-marker-size-and-labels`, `distinct-types-with-base`, and `merge-conflict` pin `-c merge.conflictStyle=merge` with comments explicitly naming the diff3 trap ("the machine's global config may use diff3"). After hardening these become redundant-but-correct (Matrix B unsets the key → built-in `merge`).
- **`init.defaultBranch`:** Latent, not active. Every `init` passes `-b main`/`-b <branch>` explicitly (and `initBothRepos` defaults to `main`). Matrix B2 shows hardening flips the *unspecified* default `main`→`master`, but no suite leaves it unspecified — so green stays green, and the corpus is now robust to a dev with a different ambient default.
- **`commit.gpgsign`:** Already defended ubiquitously — ~25 suites set `commit.gpgsign=false` (per-repo `config` or `-c`) with comments noting a globally-enabled signing key would otherwise diverge the SHA. Hardening makes these redundant-but-correct (Matrix B unsets it → git's default off).
- **System config / `core.*` / `diff.external` / custom merge drivers:** No suite reads ambient values; suites that need a merge driver (`merge-driver-interop`, `merge.custom.driver`; `add-add-content`/`distinct-types`/`merge-driver` via `.gitattributes merge=union`) define it explicitly per-repo. `credential.helper=osxkeychain` (system) leaked under Matrix A but no suite consumes it; NOSYSTEM closes it cleanly.
- **`config-interop.test.ts`:** The clearest evidence — line ~118 uses `git config --local --list` *specifically* because "the user's global config bleeds into the result on developer machines." After hardening, `--local` is belt-and-suspenders rather than load-bearing.
- **`missing-value-refusal-interop.test.ts`:** *Already hardened locally* — `mkdtemp` isolated HOME + `GIT_CONFIG_NOSYSTEM=1` spread over `runGitEnv()` (its valueless-identity assertion requires git to read no ambient `user.*`). After centralising, its `makeCleanEnv` HOME/NOSYSTEM additions become redundant (decision candidate (d), option 3).

**Net:** the corpus was already disciplined — every config-sensitive operation is pinned per-test. Hardening makes those per-test pins redundant safety nets and eliminates the trap class at the helper level, so a future suite that *forgets* to pin no longer passes by accident on the author's machine while silently diverging from the design matrix.
