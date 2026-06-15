# Design — string-typed-valueless-refusal

> Brief: extend 24.9l's `CONFIG_MISSING_VALUE` refusal to the remaining string-typed config keys git dies on (`branch.*.merge`/`remote`, `merge.*.driver`/`name`, `submodule.*.url`/`update`, `core` path-likes, `remote.*.pushUrl`), via `assertNoValuelessConfig` calls — one per consuming site for the lazy keys, one shared eager gate for the `[core]` path-likes — plus a pinned interop matrix per key.
> Status: self-reviewed ×3 → revised against ADRs 346–349 → accepted

> Revision note (ADRs 346–349): the four load-bearing decisions are now resolved. ADR-346 chose **eager broad** `[core]` validation (deviates from the original candidate E per-accessor rec); ADR-347 makes `submodule.<n>.update` a **real config-sourced mode with git's precedence**, then guards it (deviates from the original candidate D defer); ADR-348/349 ratified the original A/B/C/F recs. The empirical pins for the two deviations (core death breadth, submodule update-mode precedence) are folded into the Design and Test sections below.

## Context

git dies — exit 128 — when a string-typed config key holds a NULL (valueless) value, while porcelain reads (`config --get`/`--list`) succeed. For most keys the death is **lazy** (at the typed-read use site); for the `[core]` path-likes it is **eager and broad** (in `git_default_config` at config load — pinned below). 24.9l (ADRs 327–329) closed this divergence for the two highest-traffic surfaces (commit identity, remote `url` on fetch/push) and shipped a reusable enabler:

- `assertNoValuelessConfig(ctx, section, subsection, keys)` (`src/application/commands/internal/valueless-config-guard.ts`) — throws `CONFIG_MISSING_VALUE { key, source, line }` (factory `configMissingValue`, `src/domain/commands/error.ts`) for the **first** valueless entry by config-file line among `keys`; returns normally if none is valueless. In 24.9l it was called **only on a command's refusal path**. 24.9r keeps that for the lazy keys and adds one **eager pre-flight** call site for the `[core]` path-likes (ADR-346) — the guard's no-op-unless-valueless contract makes both call patterns safe (it never throws for a valued or absent entry). The accessor's docstring should be widened to reflect the eager call site.
- backing primitive `findFirstValuelessEntry(ctx, section, subsection, keys)` (`src/application/primitives/config-read.ts`) — cold-path raw re-tokenize. It lowercases the section + variable segments and preserves the subsection verbatim when building the qualified key token, and reports the 1-based config-file line. `ParsedConfig`/`IniSection` are unchanged.

ADR-329 deferred the remaining string-typed keys as a dependency-ordered follow-up. **This change (24.9r) lands that breadth.** The mechanism and error shape are FIXED by ADR-327/328 and are NOT open choices here. Two of the five key families exceed a pure "single additive call, no schema change" follow-up, as the ADRs resolved:

- **`[core]` path-likes (ADR-346)** — git's death is *eager and broad*, so a single per-accessor guard would under-refuse (e.g. `git log` dies in git but tsgit's `log` touches no config). The faithful shape is a **shared eager gate** across the default-config-loading surface, not a per-accessor guard. Still reuses `findFirstValuelessEntry` + `CONFIG_MISSING_VALUE`; only the trigger breadth widens (this refines ADR-327, does not supersede it).
- **`submodule.<n>.update` (ADR-347)** — tsgit does not read this key from config today (mode comes from `.gitmodules`), so there was no faithful death site. ADR-347 makes it a **real config-sourced mode with git's config-over-gitmodules precedence** (a behaviour change, pinned below), creating the consuming read the guard then sits on.

The candidate keys (from ADR-329's deferral list + the backlog 24.9r text):
`branch.<name>.merge` / `branch.<name>.remote`, `merge.<driver>.driver` / `merge.<driver>.name`, `submodule.<name>.url` / `submodule.<name>.update`, `core.excludesFile` / `core.attributesFile` / `core.hooksPath`, `remote.<name>.pushUrl`.

## Requirements

- For each in-scope key, when present-but-valueless in `.git/config`, the consuming tsgit command refuses with `CONFIG_MISSING_VALUE { key, source, line }` whose fields reconstruct git's two-line `error: missing value for '<key>'` / `fatal: bad config variable '<key>' in file '<F>' at line <N>` (exit 128).
- The guard fires **precisely** when git dies and never when git succeeds. The pinning below shows no key falls through to a default in the presence of a valueless entry; the only variation is *where* the death sits. For the **lazy keys** the guard sits on the command's existing refusal/fallback path (a *valued* config resolves normally, the *wholly-absent* case keeps its own existing refusal code). For the **`[core]` path-likes** the guard is an eager pre-flight that runs *before* the command's work — it must still no-op for a valued or absent `[core]` section (the guard only throws on present-but-valueless), and must NOT run on the config-porcelain path (which git keeps alive).
- The `key` token matches git's: section + variable segments lowercased, subsection preserved verbatim (`core.excludesfile`, `submodule.mysub.url`, `branch.main.merge`). `findFirstValuelessEntry` already does exactly this.
- `source` is tsgit's absolute config path; the interop test normalizes the `file '<F>'` token (ADR-328/249 — the library emits data, not git's rendered string).
- `ParsedConfig`/`IniSection`/`api.json` stay unchanged (ADR-327). Porcelain `config --get`/`--list` still succeed on a valueless entry.
- No regression on the absent path: each command keeps its existing absent-case refusal/fallback (`NO_UPSTREAM_CONFIGURED`, `REMOTE_NOT_CONFIGURED`, built-in text driver, defaults).
- **`[core]` path-likes refuse with git's broad reach (ADR-346):** every command that loads git's default config refuses on a valueless `core.excludesfile`/`core.attributesfile`/`core.hookspath` *before* doing its work; the config porcelain (`config --get`/`--list`/`getRegexp`) keeps succeeding. The breadth boundary is pinned empirically below.
- **`submodule.<n>.update` becomes a real mode source (ADR-347):** `submoduleUpdate` resolves the update mode with git's precedence (`opts.mode` > config `submodule.<n>.update` > `.gitmodules` `submodule.<n>.update` > `checkout`), then guards the valueless config case at that new consuming read. This is a behaviour change (precedence), not just refusal wiring — its own tests cover the precedence, not only the valueless row.

## Design

### Pinned git matrix (git 2.54.0)

All probes ran in fresh `mktemp -d` repos with ambient `GIT_*` scrubbed, `HOME`/`XDG_CONFIG_HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, signing off. The valueless fixture line was hand-written (git's CLI cannot emit a valueless entry). "Missing-value shape" = the exact two lines `error: missing value for '<key>'` / `fatal: bad config variable '<key>' in file '<F>' at line <N>`, exit 128.

| key | git consuming command pinned | dies with missing-value shape? | exit | exact `<key>` token git prints | line | fall-through? |
|---|---|---|---|---|---|---|
| `branch.<n>.merge` | `git pull` / `git merge @{upstream}` | **YES** | 128 | `branch.main.merge` (subsection verbatim) | its line | NO — dies, does not fall through |
| `branch.<n>.remote` | `git pull` / `git merge @{upstream}` | **YES** | 128 | `branch.main.remote` | its line | NO — does **not** fall back to `origin` default |
| `merge.<d>.driver` | `git merge <branch>` (content merge engaging the driver) | **YES** | 128 | `merge.mydriver.driver` | its line | NO |
| `merge.<d>.name` | `git merge <branch>` | **YES** | 128 | `merge.mydriver.name` | its line | NO — read **independently** of `.driver` |
| `submodule.<n>.url` | `git submodule update` (`--init`) | **YES** | 128 | `submodule.mysub.url` | its line | NO. `git submodule sync` does **not** die (reads `.gitmodules`) |
| `submodule.<n>.update` | `git submodule update` | **YES** | 128 | `submodule.mysub.update` | its line | NO — does not fall through to `.gitmodules`/checkout default. **Config is a real mode source** (precedence pinned below). |
| `core.excludesFile` | **broad** — every default-config-loading porcelain cmd (`status`, `log`, `commit`, `add`, `diff`, `show`, `branch`, `checkout`, `merge`, `tag`, `ls-files`, `stash`, `for-each-ref`, `rev-parse HEAD`, `check-ignore`, `check-attr`) | **YES (eager, broad)** | 128 | `core.excludesfile` (lowercased) | its line | NO. `config --list`/`--get`/`--get-regexp`/`--show-origin` **survive** (separate read path) |
| `core.attributesFile` | **broad** — same set as `excludesFile` (eager in `git_default_config`) | **YES (eager, broad)** | 128 | `core.attributesfile` (lowercased) | its line | NO. Config porcelain survives |
| `core.hooksPath` | **broad but narrower** — work-doing cmds (`status`, `log`, `commit`, `add`, `diff`, `show`, `checkout`, `merge`, `rev-parse --git-path hooks`, `check-ignore`, `check-attr`); does **NOT** die on pure ref-listing (`branch`, `tag`, `for-each-ref`, `ls-files`, `stash list`, `rev-parse HEAD`) | **YES (eager)** | 128 | `core.hookspath` (lowercased) | its line | NO — does **not** fall back to `.git/hooks` default. Config porcelain survives |
| `remote.<n>.pushUrl` (valued `url` present) | `git push origin main` | **YES** | 128 | `remote.origin.pushurl` (lowercased) | its line | NO — does **not** fall back to the valued `url` |
| `remote.<n>.pushUrl` (no `url`) | `git push origin main` | **YES** | 128 | `remote.origin.pushurl` | its line | NO |

Verbatim death blocks (representative):
```
error: missing value for 'branch.main.merge'
fatal: bad config variable 'branch.main.merge' in file '.git/config' at line 10

error: missing value for 'merge.mydriver.driver'
fatal: bad config variable 'merge.mydriver.driver' in file '.git/config' at line 5

error: missing value for 'core.hookspath'
fatal: bad config variable 'core.hookspath' in file '.git/config' at line 3

error: missing value for 'remote.origin.pushurl'
fatal: bad config variable 'remote.origin.pushurl' in file '.git/config' at line 6
```

**Headline finding: NO key silently uses a default in the presence of a valueless entry.** None falls through. The pre-design hypotheses — `branch.remote`→origin default, `core.hooksPath`→`.git/hooks` default, `submodule.update`→checkout default, `remote.pushUrl`→`url` fallback — are all **FALSE**. The single nuance is *timing/breadth*: the lazy keys (`branch.*`, `merge.*`, `submodule.*`, `remote.*.pushurl`) die at their typed-read consumer; the `[core]` path-likes die **eagerly and broadly** in `git_default_config` at config load. So there is a faithful death site for every row — for the lazy keys it is the consuming read, for the `[core]` keys it is a shared eager gate.

#### `[core]` path-like death breadth (ADR-346 — pinned in fresh `mktemp` repos, git 2.54.0)

Each `[core]` path-like fixture was a clean `.git/config` with the valueless key on a known line. Per-command exit-code matrix (`DIES` = exit 128 with the two-line missing-value shape; `OK` = succeeds):

| command | `core.excludesfile` | `core.attributesfile` | `core.hookspath` |
|---|---|---|---|
| `status` / `status --porcelain` | DIES | DIES | DIES |
| `log` | DIES | DIES | DIES |
| `add` | DIES | DIES | DIES |
| `diff` / `diff --cached` | DIES | DIES | DIES |
| `show` | DIES | DIES | DIES |
| `commit` | DIES | DIES | DIES |
| `checkout <branch>` | DIES | DIES | DIES |
| `merge <branch>` | DIES | DIES | DIES |
| `check-ignore <p>` | DIES | DIES | DIES |
| `check-attr -a <p>` | DIES | DIES | DIES |
| `rev-parse --git-path hooks` | DIES | DIES | DIES |
| `branch` (list) | DIES | DIES | **OK** |
| `tag` (list) | DIES | DIES | **OK** |
| `for-each-ref` | DIES | DIES | **OK** |
| `ls-files` | DIES | DIES | **OK** |
| `stash list` | DIES | DIES | **OK** |
| `rev-parse HEAD` | DIES | DIES | **OK** |
| **`config --list`** | **OK** | **OK** | **OK** |
| **`config --get <key>`** | **OK** | **OK** | **OK** |
| **`config --get-regexp 'core[.].*'`** | **OK** | **OK** | **OK** |
| **`config --list --show-origin`** | **OK** | **OK** | **OK** |

Boundary findings:
- **`excludesfile`/`attributesfile`** die on the *entire* default-config-loading porcelain — even pure ref-listing (`branch`/`tag`/`for-each-ref`) and `rev-parse HEAD`. They are validated in `git_default_config`, run on every config load.
- **`hookspath`** dies on the narrower set of *work-doing* commands but **NOT** on pure ref-listing or `rev-parse HEAD`. Its validation is reached only when the hooks dir is resolved (run-command / index-touching paths), not on a bare ref read.
- **The config porcelain never dies** for any of the three — `config --list`/`--get`/`--get-regexp`/`--show-origin` all exit 0, because they read through a separate path (not `git_default_config`). This is the split tsgit must reproduce.
- The two-line shape and key token are identical across all three (`core.excludesfile`/`core.attributesfile`/`core.hookspath`, lowercased; exit 128).

#### `submodule.<n>.update` config-over-gitmodules precedence (ADR-347 — pinned with a real `file://` submodule, git 2.54.0)

Setup: an upstream sub repo at C1→C2, a superproject recording `mysub@C2`, the working submodule drifted to C1 so a `checkout`-mode update moves it to C2 and a `none`-mode update leaves it at C1. Plain `git submodule update` (no CLI mode), varying `.gitmodules` vs `.git/config` update modes:

| `.gitmodules` update | config `submodule.mysub.update` | CLI | result | wins |
|---|---|---|---|---|
| `none` | `checkout` | — | submodule moved C1→C2 | **config `checkout`** |
| `checkout` | `none` | — | submodule stayed at C1 (no-op) | **config `none`** |
| `none` | *unset* | — | stayed at C1 | `.gitmodules none` |
| `checkout` | *unset* | — | moved C1→C2 | `.gitmodules checkout` |
| *unset* | *unset* | — | moved C1→C2 | `checkout` default |
| *anything* | `none` | `--checkout` | moved C1→C2 | **CLI `--checkout`** |

**Pinned precedence (highest → lowest): `--checkout`/`--merge`/`--rebase` CLI > config `submodule.<n>.update` > `.gitmodules` `submodule.<n>.update` > `checkout` default.** Config overrides `.gitmodules` in **both** directions (it can both enable and suppress the update). This is the precedence tsgit's `submoduleUpdate` must adopt (today it ignores the config mode entirely — `opts.mode ?? updateModes.get(row.name) ?? 'checkout'`, where `updateModes` is `.gitmodules`-sourced).

Valueless: a valueless `submodule.mysub.update` in `.git/config` makes `git submodule update` die (exit 128, `submodule.mysub.update`, two-line shape) — confirmed in the same probe.

Auxiliary pins:
- **Parse-vs-consumer:** `git config --file <fixture> --list` succeeds (exit 0) on every fixture, printing the valueless key as a bare `=`-less line. For the lazy keys the refusal is at the consumer's typed read; for the `[core]` keys the *operational* read (`git_default_config`) dies but the porcelain read path survives — both never refuse at parse time. This matches tsgit's parser (valueless → `value: null`, lenient) and the guard placements below.
- **Casing:** git canonicalizes section + variable name segments to lowercase but preserves the bracketed-quoted subsection as-written. `findFirstValuelessEntry` produces `${section.toLowerCase()}.${subsection}.${key.toLowerCase()}` — exactly this shape. No code change needed for casing; verified the in-scope key tokens (`core.excludesfile`, `submodule.mysub.url`/`.update`, `branch.main.merge`) match.
- **`git submodule sync` does NOT read the config url** — it resolves the url from `.gitmodules`. tsgit's `syncLevel` (`submodule.ts` ~289) also reads `row.url` from `.gitmodules` and only checks `config.submodule[name].url !== undefined` as an initialised-gate, not as the value source — so sync needs no valueless-url guard, faithful to git.

### Consuming-site map (verified against the worktree source)

Each row reuses `assertNoValuelessConfig`. Three safe placement patterns appear below:

- **Absent-path placement (the push/fetch idiom)** — read config → reach the absent/fallback branch (the value is `undefined`) → call the guard there → then throw/return the existing absent behaviour. A *valued* config resolves and returns before the guard ever runs; the *absent* case reaches the guard, which returns normally (no matching entry), then falls through to the existing refusal. Used for `submodule.<n>.url`.
- **Pre-resolution placement** — call the guard *before* a fallback substitutes a default (e.g. `?? 'origin'`, `?? url`, the config update mode), because git dies on the valueless key **even when a fallback value is available**. The guard is still a no-op for a valued config (`findFirstValuelessEntry` returns `undefined`), so a valued key resolves normally afterwards. Used for `branch.<n>.remote`/`.merge`, `remote.<n>.pushurl`, `merge.<d>.{driver,name}`, and `submodule.<n>.update`.
- **Eager shared-gate placement (NEW, ADR-346)** — call the guard over the three `[core]` path-likes at a shared operational pre-flight, *before* the command does its work, so the refusal breadth matches git's `git_default_config` eager death. Used ONLY for the `[core]` path-likes (chokepoint below). The config porcelain must bypass this gate (it reads through a separate path), mirroring git.

In all three patterns the guard throws ONLY for a present-but-valueless entry, so none can refuse where git succeeds.

- **`branch.<n>.merge` / `branch.<n>.remote`** *(DECIDED — ADR-348)* — `pull.ts` `resolveUpstream` (~75–89). git reads BOTH `branch.<cur>.remote` and `branch.<cur>.merge` for `pull`/upstream-merge and dies on whichever is valueless (subject to file-line order). tsgit currently: `remote = opts.remote ?? tracking?.remote ?? 'origin'` and `branch = opts.ref ?? shortMergeRef(tracking?.merge)`; the absent/fallback path is `branch === undefined → noUpstreamConfigured`. **Placement (ADR-348):** a single multi-key `assertNoValuelessConfig(ctx, 'branch', <name>, ['remote','merge'])` **early in `resolveUpstream`**, before the `?? 'origin'` and `?? merge` fallbacks substitute — so a valueless `remote` refuses despite the would-be `origin` default, and the first valueless key by file-line is reported.
  - `remote-config.ts` `listBranchReferrers` (~50–65) and `submodule.ts` `resolveBaseUrl` (~146) also read `branch.<n>.remote`, but as a pure equality filter / `?? 'origin'` default for `remote rename`/`remote remove`/submodule base-url — git's death site for these keys is the **pull/upstream** read, not these. ADR-348 scopes the guard to `pull` only and leaves these readers unguarded (documented divergence; `status` does not compute upstream tracking, so it has no read to die at either).
- **`merge.<d>.driver` / `merge.<d>.name`** *(DECIDED — ADR-349)* — `resolve-merge-driver.ts` `namedChoice` (~29–38). git engages the driver only when a path's `merge` attribute names `<d>`; tsgit's `namedChoice` is reached on exactly that path. Today: valueless `.driver` → `driver?.driver === undefined` → returns built-in `TEXT` (silent divergence); `.name` valueless → silently omitted. The faithful death fires when `merge=<d>` selects this driver and `<d>.driver`/`<d>.name` is valueless. **Placement (ADR-349):** a single multi-key `assertNoValuelessConfig(ctx, 'merge', <d>, ['driver','name'])` inside `namedChoice` **before** the `driver?.driver === undefined → TEXT` fallthrough — fires on whichever of `.driver`/`.name` is valueless by file-line (git reads `.name` independently — pinned). A built-in name (`text`/`binary`/`union`) and an absent `[merge "<d>"]` section keep returning `TEXT`.
- **`submodule.<n>.url`** *(DECIDED — ADR-349)* — `submodule.ts` `submoduleUpdate` (~717/734). git's death site is `submodule update`/`--init`. tsgit treats valueless as undefined with fallbacks (`existing !== undefined`, `?? row.url ?? ''`). **Placement (ADR-349):** `assertNoValuelessConfig(ctx, 'submodule', row.name, ['url'])` on the `config.submodule?.get(row.name)?.url === undefined` branch in `submoduleUpdate` (~717), before the `init`/skip decision — git's pinned death command. `submoduleInit`'s `existing` read (~215) is an init-time gate and `syncLevel` (~289) reads `.gitmodules` (pinned) — neither gets a guard; `submoduleUpdate` is the single faithful site.
- **`submodule.<n>.update`** *(DECIDED — ADR-347, BEHAVIOUR CHANGE)* — today `submoduleUpdate` resolves the mode as `opts.mode ?? updateModes.get(row.name) ?? 'checkout'` (`submodule.ts` ~722), where `updateModes` comes from `validateUpdateModes(rows)` reading `.gitmodules` (~104). The config field `config.submodule[<name>].update` is parsed (`ParsedConfig.submodule[name].update`) but **ignored** — so there was no faithful death site. ADR-347 fixes this in two steps:
  1. **Make config a real mode source with git's precedence** (pinned above): resolve `mode = opts.mode ?? configMode ?? gitmodulesMode ?? 'checkout'`, where `configMode = parseUpdateMode(config.submodule?.get(row.name)?.update)`. The config update mode **overrides** the `.gitmodules` mode in both directions (enable and suppress). Reuse `parseUpdateMode` for validation parity (an invalid config mode throws the same `invalidOption` as a `.gitmodules` one — confirm against git's `submodule.<n>.update` validation in the plan). This is a behaviour change requiring its own precedence + mode-resolution tests, not only the valueless row.
  2. **Guard the valueless config case at that new consuming read** (pre-resolution placement): `assertNoValuelessConfig(ctx, 'submodule', row.name, ['update'])` before the mode resolution, so a valueless `submodule.<n>.update` refuses where `git submodule update` dies. Co-occurrence with a valueless `url` under the same `[submodule "<n>"]`: git reports the earlier-by-file-line key — see "Cross-key file-line ordering". The `url` guard (above) and the `update` guard can be combined into one `['url','update']` call at the consuming site if both reads sit before any fallback, preserving file-line order; the plan picks the exact call shape (one combined call vs two ordered reads) so both keys report git's first-by-line.
- **`core.excludesFile` / `core.attributesFile` / `core.hooksPath`** *(DECIDED — ADR-346, EAGER BROAD GATE)* — the per-accessor reads are `read-gitignore.ts` `readGlobalExcludes` (~37–44, valueless → `undefined` → no global excludes), `read-gitattributes.ts` `readGlobal` (~33–39), `run-hook.ts` `invokeHook` (~45–63 → `resolveHooksDir(config.core?.hooksPath, …)`, valueless → `${gitDir}/hooks` default). A per-accessor guard would refuse only on the narrow command set that reaches each accessor — but git's death is **eager and broad** (pinned: `excludesfile`/`attributesfile` die on the whole porcelain incl. `log`/`branch`/`tag`, `hookspath` on the work-doing subset). tsgit's `log` touches no config at all, so per-accessor would leave `tsgit log` succeeding where `git log` dies — an observable refusal-condition divergence the prime directive forbids. **Placement (ADR-346): a shared eager gate** over `['excludesfile','attributesfile','hookspath']`, run before the command does its work, on the operational surface but NOT the config porcelain. See the chokepoint analysis below.

### `[core]` eager-gate chokepoint (ADR-346 — recommended implementation shape)

This is the one open *implementation-shape* question ADR-346 left to the design (the user already chose eager-broad; **where** the gate lands is an engineering choice, not a user decision). The worktree was inspected to find the chokepoint that reproduces git's split (operational surface dies, config porcelain survives):

**The two read paths are already cleanly separated in tsgit:**

- **Operational reads** go through `readConfig(ctx) → ParsedConfig` (`config-read.ts`). All work-doing commands that touch config flow through it: `commit`, `merge`, `pull`, `push`, `submodule`, `remote`, `sparse-checkout`, plus the `[core]` accessors (`readGlobalExcludes`, `readGlobal`, `invokeHook`) and `isBare`.
- **Config porcelain** (`configGet`/`configGetAll`/`configList`/`configGetRegexp`) reads through a **completely separate path** — `config-scoped-read.ts` (`readConfigSections`/`getConfigValue`/`getAllConfigValues`), which walks raw `IniSection[]` per scope and **never calls `readConfig`**. This is the exact analogue of git's `git_default_config`-vs-`config --list` split: the porcelain naturally bypasses any gate placed on the `readConfig` path.

**The gap a `readConfig` gate alone leaves:** git dies on `excludesfile`/`attributesfile` even for commands that read no config — notably `git log`, `git branch`, `git tag`, `git for-each-ref`, `git rev-parse HEAD`. tsgit's `log` calls neither `readConfig` nor any `[core]` accessor (it goes `assertRepository` → walk primitives). So a gate placed only inside `readConfig` would still leave `tsgit log` (and the ref-listing commands) succeeding where git dies. `assertRepository` itself is a pure HEAD-existence check — it does **not** read config today.

**A verified constraint that shapes the recommendation:** the config porcelain (`config.ts`) calls the **exact same** `assertRepository` as `log`/`status`/`branch`/`tag` (single definition in `repo-state.ts`; `config.ts` imports it nine times). So a gate dropped *unconditionally* into `assertRepository` would also gate the porcelain — breaking the bypass git preserves. The gate therefore cannot live in the shared `assertRepository` body as-is; it needs a path the operational commands take and the porcelain does not.

**Recommended chokepoint (surface to the plan/ADR follow-through):**

- Add a small eager primitive — `assertNoValuelessCorePaths(ctx)` — that calls `assertNoValuelessConfig(ctx, 'core', undefined, [...])`. It is a no-op unless a `[core]` path-like is present-but-valueless. Because it re-tokenizes the repo-local config (cold path), gate it to run once per command, not on the hot `readConfig` cache path.
- **Call it from a dedicated operational pre-flight that the porcelain does NOT share.** The faithful, lowest-divergence shape is a thin `assertOperationalRepository(ctx)` (or an opt-in flag on `assertRepository`) that does the HEAD check **and** the eager core-paths gate, called by the operational commands (`log`, `status`, `branch`, `tag`, `commit`, `add`, `diff`, `show`, `checkout`, `merge`, …) while the config porcelain keeps calling the bare `assertRepository`. This is the only single point that also covers the **config-free** commands (`log`, `branch`, `tag`, `for-each-ref`) — the sole placement matching git's *full* `excludesfile`/`attributesfile` breadth — while preserving the porcelain bypass by construction. The plan enumerates exactly which `assertRepository` callers switch to the operational pre-flight (cross-check each against the breadth matrix: the porcelain `config.*` commands and any other command git does NOT kill must stay on the bare entry).
- **Rejected alternative — gate inside `loadConfig`/`readConfig`:** simpler and automatically porcelain-safe (porcelain bypasses `readConfig`), but it under-refuses on the config-free commands (`log`/`branch`/`tag`), leaving a residual narrow divergence for `excludesfile`/`attributesfile`. **Not** faithful to ADR-346's full breadth; only acceptable if the plan explicitly accepts that gap (it should not).
- **`hookspath` narrower breadth (the load-bearing subtlety):** the matrix shows `hookspath` does NOT die on pure ref-listing (`branch`/`tag`/`for-each-ref`/`ls-files`/`stash list`/`rev-parse HEAD`). So the eager gate cannot validate all three keys on one surface: it must validate `['excludesfile','attributesfile']` on the **full** operational surface (incl. ref-listing) and `['hookspath']` only on the **work-doing** subset. Concretely: split into two calls — the broad pair from `assertOperationalRepository`, and a narrower `assertNoValuelessConfig(ctx,'core',undefined,['hookspath'])` from a work-doing pre-flight (or fold it into the `invokeHook`/index-touching path, gated eagerly there). The plan must split the key set by breadth and prove it; a single combined `['excludesfile','attributesfile','hookspath']` call on the whole surface is the simplest shape but **diverges** on `hookspath` for ref-listing.

This chokepoint is the design's recommendation; the plan finalises the exact pre-flight split (which callers, which key subset where) and proves it with the interop breadth matrix (multiple commands die + `config --list` survives + `hookspath` ref-listing survivors).

### Why each guard is faithful (and safe)

The guard is a no-op for a valued config (`findFirstValuelessEntry` returns `undefined`) and for the absent case (no matching entry → `undefined`). It throws ONLY for a present-but-valueless entry, so no placement pattern can refuse where git succeeds. The structural subtlety is `remote.<n>.pushUrl`, `branch.<n>.remote`, and `submodule.<n>.update`, where git dies even though a fallback value (valued `url` / `origin` default / `.gitmodules` mode) is available — these use the pre-resolution placement so the guard is reached before the fallback substitutes (ADR-348/349/347). For the `[core]` path-likes the eager gate runs before any work, so a valueless value refuses regardless of which accessor would have read it (ADR-346).

**Cross-key file-line ordering.** When two keys under one subsection are both valueless (e.g. both `branch.<n>.remote` and `.merge`; both `remote.<n>.pushurl` and `.url`; both `submodule.<n>.url` and `.update`; both `merge.<d>.driver` and `.name`; or several `[core]` path-likes), git reports whichever is **earlier in the config file**. A single `assertNoValuelessConfig(ctx, section, sub, [k1, k2, …])` call preserves this — `findFirstValuelessEntry` scans the token stream by line and returns the first match across all keys. Two separate single-key guard calls would instead report a fixed key-order regardless of file position, diverging from git. This makes the **single multi-key call** the faithful shape wherever git reads sibling keys that can co-occur (ADR-348 `['remote','merge']`, ADR-349 `['driver','name']`/`['pushurl','url']`, the `[core]` gate's `['excludesfile','attributesfile','hookspath']`, and the submodule `['url','update']` co-occurrence).

## Decisions (resolved)

Every load-bearing choice is now decided by an accepted ADR. No open candidates remain. (Original candidate letters kept for traceability with the pre-ADR design.)

| was # | Choice | Decision | ADR |
|---|---|---|---|
| A | Guard placement for `branch.<n>.remote` / `.merge` | Single multi-key `assertNoValuelessConfig(ctx,'branch',<name>,['remote','merge'])` **early in `pull`'s `resolveUpstream`**, before the `?? 'origin'`/`?? merge` fallbacks (so a valueless `remote` refuses despite the would-be default; first valueless key by file-line reported). Scope to `pull` only — `listBranchReferrers`/`resolveBaseUrl` stay unguarded; `status` does not compute upstream tracking. | **ADR-348** (matched the original rec: candidates 2+3) |
| B | Whether `merge.<d>.name` is guarded jointly with `.driver` | Single multi-key `assertNoValuelessConfig(ctx,'merge',<d>,['driver','name'])` in `namedChoice` before the `TEXT` fallthrough — fires on whichever is valueless by file-line (git reads `.name` independently). | **ADR-349** (matched original rec B-1) |
| C | The faithful site(s) for `submodule.<n>.url` | `assertNoValuelessConfig(ctx,'submodule',<n>,['url'])` on the `url === undefined` branch in `submoduleUpdate` only — git's pinned death command. `submoduleInit`/`syncLevel` unguarded. | **ADR-349** (matched original rec C-1) |
| D | `submodule.<n>.update` placement | **DEVIATES from original rec (was "defer").** Make `config.submodule[<n>].update` a **real mode source** with git's precedence (`opts.mode` > config > `.gitmodules` > `checkout` — pinned), then guard the valueless case at that new consuming read in `submoduleUpdate`. A behaviour change (feature scope), not just refusal wiring. | **ADR-347** (chose original alt D-3) |
| E | Placement family for the three `[core]` path-likes | **DEVIATES from original rec (was "per-accessor, single-key each").** Refuse **eagerly with git's broad reach**: a shared eager gate over `['excludesfile','attributesfile','hookspath']` across the default-config-loading surface, before the command does its work, while the config porcelain keeps succeeding. Chokepoint recommended above (`assertNoValuelessCorePaths` from the shared operational pre-flight, split by breadth for `hookspath`). | **ADR-346** (chose a refined form of original alt E-2) |
| F | `remote.<n>.pushUrl` guard placement | Replace the existing `['url']`-only guard with a **single pre-resolution `['pushurl','url']`** call in `resolveRemoteUrl`, after `readConfig`, before `url = pushUrl ?? url`. Wholly-absent still falls to `REMOTE_NOT_CONFIGURED`. Re-verify the existing `url`-only interop row (unchanged for a single valueless key). | **ADR-349** (matched original rec F-3) |

## Test strategy

### Interop pins (faithfulness — the load-bearing layer)

Extend `test/integration/missing-value-refusal-interop.test.ts` (the 24.9l structure). For **every** in-scope key (all rows above — `submodule.<n>.update` is now in scope per ADR-347), add a per-key block mirroring the existing `user.name`/`remote.origin.url` blocks:

1. **git refusal pin** — hand-write a fixture with the valueless key at a known line into a fresh `mktemp` repo's `.git/config`; run git's pinned consuming command (`pull`, `merge`, `submodule update`, a `[core]` operational command, `push` for pushurl) via the isolated `runGit`/`tryRunGit` helpers; assert `g.ok === false`, stderr contains `missing value for '<key>'`, `bad config variable '<key>'`, and `at line <N>`.
2. **tsgit structured pin** — same fixture, drive the tsgit facade (`repo.pull`, `repo.merge`, `repo.submoduleUpdate`, a `[core]`-gated operational command, `repo.push`); assert each `CONFIG_MISSING_VALUE` field individually (`code`, `key`, `line`, `source` matches `/\/config$/`) — mutation-resistant per-field, try/catch + direct `.data` assertions.
3. **two-line reconstruction** — run both git and tsgit on the same fixture; reconstruct git's two lines from tsgit's `{key,line}` with the `.git/config` path-token normalization (the existing `replace(/in file '[^']+'/, …)` idiom) and assert equality.
4. **absent-vs-valueless distinctness** — a fixture with the section present but the key absent (or no section), assert tsgit throws the **existing** absent-case code (`NO_UPSTREAM_CONFIGURED`, `REMOTE_NOT_CONFIGURED`, built-in `text` for the merge driver, default hooks dir / no global excludes / `.gitmodules`-sourced update mode) and **not** `CONFIG_MISSING_VALUE`.
5. **`--list` happy-path** — `git config --file <fixture> --list` and tsgit `configList` both succeed on the valueless fixture, proving the refusal is at the consumer (or the operational gate), not the parse. **For the `[core]` keys this is load-bearing, not representative:** add an explicit row per `[core]` key asserting tsgit `configList`/`configGet`/`configGetRegexp` succeed on the valueless fixture while the operational commands die — this pins the porcelain-bypass the eager gate must preserve.

6. **`[core]` eager-breadth matrix (ADR-346)** — the load-bearing new layer. Per `[core]` key, with the valueless fixture:
   - assert **multiple operational commands die** in BOTH git and tsgit — at minimum `repo.status`, `repo.log`, `repo.commit` (and `repo.branch.list`/`repo.tag.list` for `excludesfile`/`attributesfile`, which die in git's broad set) — each with the right `{key,line,source}`.
   - assert the **config porcelain survives** (`configList`/`configGet`/`configGetRegexp` exit-ok with the valueless entry visible as `value: null`).
   - **`hookspath` narrower breadth:** assert `hookspath` dies on the work-doing commands but the ref-listing commands (`repo.branch`, `repo.tagList`, etc.) **succeed** — matching the pinned matrix. This pins the split-by-breadth wiring; a single combined-key gate on the full surface would fail this row.
7. **Submodule update-mode precedence (ADR-347 behaviour change)** — independent of the valueless row. With a real `file://` submodule (shared `beforeAll`), assert tsgit `repo.submoduleUpdate` reproduces the pinned precedence against git: config `submodule.<n>.update` **overrides** the `.gitmodules` mode in both directions (config `checkout` over `.gitmodules none` performs the update; config `none` over `.gitmodules checkout` is a no-op), `opts.mode` overrides config, and `.gitmodules` applies when config is absent. Compare resulting submodule HEAD/state against real git on the same fixture.
8. **Sibling-key file-line ordering** — for the multi-key sites (`branch.<n>.['remote','merge']`, `remote.<n>.['pushurl','url']`, `merge.<d>.['driver','name']`, `submodule.<n>.['url','update']`), add a fixture where **both** sibling keys are valueless, in each order, and assert tsgit reports the key on the **earlier config line** (matching git's pinned per-entry callback order). For the `[core]` gate, a fixture with two `[core]` path-likes both valueless, asserting the earlier-line key is reported. This pins the cross-key ordering the single multi-key `assertNoValuelessConfig` call delivers (ADR-348/349/347/346). At least one ordering pin per multi-key site, both orders covered.

The matrix has **one pinned valueless row per in-scope key**, plus the breadth matrix for `[core]` and the precedence matrix for `submodule.update`. The fixtures must control line numbers exactly (the 24.9l fixtures latch the valueless entry to a known line and assert that line). Casing must be asserted against git's verbatim token (`core.excludesfile` lowercased, `submodule.mysub.url`/`.update` subsection-preserved).

For `merge.<d>.driver`/`.name`, `submodule.<n>.url`/`.update` (incl. the precedence matrix), the fixture setup is heavier (a `.gitattributes` `* merge=<d>` + a real conflicting content merge; a `.gitmodules` + a `file://` submodule source registered into config, pinned to two commits so the update mode is observable). Follow the interop-helper isolation (ADR-337/338/339): isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off, scrubbed `GIT_*`, `protocol.file.allow=always` for the `file://` submodule. Reuse a shared `beforeAll` repo per heavy block where possible (project memory: heavy git-spawning interop times out hooks under validate's concurrency — one shared repo + 60s timeout).

### Unit tests (per guarded consuming site)

At each guarded site add unit tests driving the three states independently (Object Calisthenics / mutation-resistant guard isolation per CLAUDE.md):
- **valueless** → `CONFIG_MISSING_VALUE` with the right `{key,line,source}` (try/catch + `.data` assertions, never bare `toThrow(ErrorClass)`).
- **valued** → resolves normally (driver chosen, upstream resolved, url returned, hooks dir / global excludes resolved, update mode applied).
- **absent** → existing fallback/refusal (e.g. `'origin'` default, built-in `text`, `NO_UPSTREAM_CONFIGURED`, `.gitmodules`-sourced update mode, `checkout` default).
Each guard condition (e.g. `branch.<n>.remote` vs `.merge`; `pushurl` vs `url`; `submodule.<n>.url` vs `.update`) gets an **isolated** test triggering that key alone — one test triggering both does not prove each guard fires independently.

**`[core]` eager gate (ADR-346) — its own unit tests** on the gate primitive (`assertNoValuelessCorePaths`) and on the pre-flight that calls it:
- valueless `excludesfile`/`attributesfile`/`hookspath` each → `CONFIG_MISSING_VALUE` with the right `{key,line,source}`, triggered in isolation (one key valueless at a time).
- a valued or absent `[core]` section → gate is a no-op (command proceeds).
- the config porcelain path does NOT invoke the gate (assert `configList`/`configGet` succeed on the valueless fixture at the unit layer) — pins the porcelain bypass.
- if the gate splits the key set by breadth (`hookspath` on the work-doing subset only), an isolated test that a ref-listing entry point does NOT refuse on valueless `hookspath` but DOES on valueless `excludesfile`.

**`submodule.<n>.update` precedence (ADR-347 behaviour change) — its own unit tests** on `submoduleUpdate`'s mode resolution, independent of the valueless guard:
- config `checkout` over `.gitmodules none` → update performed; config `none` over `.gitmodules checkout` → no-op (both directions).
- `opts.mode` over config; config over `.gitmodules`; `.gitmodules` over the `checkout` default — each precedence step an isolated test.
- an invalid config update mode → `invalidOption` (parity with the `.gitmodules` invalid path via `parseUpdateMode`).

### Property tests

**Not applicable.** Per the CLAUDE.md four-lens test (round-trip / compositional matcher / total function over a grammar / idempotence-counting), this work is command-site **wiring** plus one mode-resolution precedence change — neither introduces a new parser, matcher, or algebraic grammar. It adds `assertNoValuelessConfig` calls at consuming sites and a shared eager gate, reusing the already-property-tested `findFirstValuelessEntry`/`tokenizeConfig` parser; the config tokenizer's grammar invariants are already covered by the existing `config-read.properties.test.ts` family.

The one genuinely new behaviour — the `submodule.<n>.update` config-over-gitmodules **precedence** (ADR-347) — is still **not** a property lens: it is a small total-order selection over at most four sources (`opts.mode` > config > `.gitmodules` > default), not a round-trip pair, a compositional matcher over an array, a total function over a grammar, or an idempotence/counting invariant. It is a 4-value precedence chain best covered by the parameterised example sweep above (the four-lens guidance explicitly routes small-enum / few-source selection to example sweeps, not properties). Stated explicitly so the review pass does not flag a missing `*.properties.test.ts` sibling.

## Out of scope

- **Int-typed valueless** (24.9s) — `fatal: bad numeric config value '' for '<key>' …: invalid unit` is a different shape (single `fatal:` line, no `error:` prefix, no `at line N`); needs its own error code and is **blocked** until an int config key is merged into `ParsedConfig` (ADR-329).
- **The mechanism / error-shape redesign** — fixed by ADR-327 (cold-path re-read) and ADR-328 (`CONFIG_MISSING_VALUE {key,source,line}`, absolute `source`). Not revisited here. (ADR-346 *refines* ADR-327's trigger breadth for the `[core]` keys; the detection primitive and error shape are unchanged.)
- **`git submodule sync`'s `submodule.<n>.url`** — pinned NOT to die in git (reads `.gitmodules`); tsgit's `syncLevel` matches, so no guard.
- **The `branch.<n>.remote` reads in `remote rename`/`remote remove`/submodule base-url resolution** — not git's pinned death site for these keys; ADR-348 scopes the guard to `pull`'s `resolveUpstream`.
- **Other `submodule.<n>` config-over-gitmodules overrides** — only the `update` mode precedence is added (ADR-347); other fields (e.g. `url` sync semantics) keep their current resolution.
- **Other `[core]` string keys** — the eager gate (ADR-346) validates only the three path-likes git validates for this change (`excludesfile`/`attributesfile`/`hookspath`); other `[core]` string keys are out until pinned to die.
- **Keys git does NOT die on** — none in this candidate set; the matrix proves every in-scope key dies (lazily at the consumer, or eagerly+broadly for `[core]`). The earlier fall-through hypotheses were all disproven empirically.
