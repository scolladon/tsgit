# Design — string-typed-valueless-refusal

> Brief: extend 24.9l's `CONFIG_MISSING_VALUE` refusal to the remaining string-typed config keys git dies lazily on (`branch.*.merge`/`remote`, `merge.*.driver`/`name`, `submodule.*.url`/`update`, `core` path-likes, `remote.*.pushUrl`), each via one `assertNoValuelessConfig` call at its consuming site, plus a pinned interop matrix per key.
> Status: self-reviewed ×3 → awaiting ADR conversation

## Context

git dies lazily — at the **use** site, exit 128 — when a string-typed config key holds a NULL (valueless) value, while porcelain reads (`config --get`/`--list`) succeed. 24.9l (ADRs 327–329) closed this divergence for the two highest-traffic surfaces (commit identity, remote `url` on fetch/push) and shipped a reusable enabler:

- `assertNoValuelessConfig(ctx, section, subsection, keys)` (`src/application/commands/internal/valueless-config-guard.ts`) — throws `CONFIG_MISSING_VALUE { key, source, line }` (factory `configMissingValue`, `src/domain/commands/error.ts`) for the **first** valueless entry by config-file line among `keys`; returns normally if none is valueless. Called **only on a command's refusal path** so a valued config still resolves and the wholly-absent case still falls through to the caller's own refusal.
- backing primitive `findFirstValuelessEntry(ctx, section, subsection, keys)` (`src/application/primitives/config-read.ts`) — cold-path raw re-tokenize. It lowercases the section + variable segments and preserves the subsection verbatim when building the qualified key token, and reports the 1-based config-file line. `ParsedConfig`/`IniSection` are unchanged.

ADR-329 deferred the remaining string-typed keys as a dependency-ordered follow-up: each is a single additive `assertNoValuelessConfig` call, no schema change. **This change (24.9r) lands that breadth.** The mechanism and error shape are FIXED by ADR-327/328 and are NOT open choices here.

The candidate keys (from ADR-329's deferral list + the backlog 24.9r text):
`branch.<name>.merge` / `branch.<name>.remote`, `merge.<driver>.driver` / `merge.<driver>.name`, `submodule.<name>.url` / `submodule.<name>.update`, `core.excludesFile` / `core.attributesFile` / `core.hooksPath`, `remote.<name>.pushUrl`.

## Requirements

- For each in-scope key, when present-but-valueless in `.git/config`, the consuming tsgit command refuses with `CONFIG_MISSING_VALUE { key, source, line }` whose fields reconstruct git's two-line `error: missing value for '<key>'` / `fatal: bad config variable '<key>' in file '<F>' at line <N>` (exit 128).
- The guard fires **precisely** when git dies and never when git falls through. (Pinning below shows git falls through in **no** case in this set — but the guard must still sit on the command's existing refusal/fallback path so a *valued* config resolves normally and the *wholly-absent* case keeps its own existing refusal code.)
- The `key` token matches git's: section + variable segments lowercased, subsection preserved verbatim (`core.excludesfile`, `submodule.mysub.url`, `branch.main.merge`). `findFirstValuelessEntry` already does exactly this.
- `source` is tsgit's absolute config path; the interop test normalizes the `file '<F>'` token (ADR-328/249 — the library emits data, not git's rendered string).
- `ParsedConfig`/`IniSection`/`api.json` stay unchanged (ADR-327). Porcelain `config --get`/`--list` still succeed on a valueless entry.
- No regression on the absent path: each command keeps its existing absent-case refusal/fallback (`NO_UPSTREAM_CONFIGURED`, `REMOTE_NOT_CONFIGURED`, built-in text driver, defaults).
- Where git dies on a key tsgit has **no faithful consuming site** for (`submodule.<name>.update`), resolve as a decision candidate — do not invent a site.

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
| `submodule.<n>.update` | `git submodule update` (`--init`) | **YES** | 128 | `submodule.mysub.update` | its line | NO — does not fall through to `.gitmodules`/checkout default |
| `core.excludesFile` | `git status` / `git check-ignore <path>` | **YES** | 128 | `core.excludesfile` (lowercased) | its line | NO |
| `core.attributesFile` | `git check-attr -a <path>` / `git status` | **YES** | 128 | `core.attributesfile` (lowercased) | its line | NO |
| `core.hooksPath` | `git commit` (any hook-invoking cmd) / `git rev-parse --git-path hooks/*` | **YES** | 128 | `core.hookspath` (lowercased) | its line | NO — does **not** fall back to `.git/hooks` default |
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

**Headline finding: there is NO lazy fall-through anywhere in this set.** Every key dies eagerly at its consumer; none silently uses a default in the presence of a valueless entry. The pre-design hypotheses — `branch.remote`→origin default, `core.hooksPath`→`.git/hooks` default, `submodule.update`→checkout default, `remote.pushUrl`→`url` fallback — are all **FALSE**. This means there is a faithful death site to guard for every row **that tsgit actually reads** (the `submodule.update` caveat below).

Auxiliary pins:
- **Parse-vs-consumer:** `git config --file <fixture> --list` succeeds (exit 0) on every fixture, printing the valueless key as a bare `=`-less line. The refusal is always at the consumer's typed read, never at parse time — matching tsgit's parser (valueless → `value: null`, lenient) and the guard sitting at each command site.
- **Casing:** git canonicalizes section + variable name segments to lowercase but preserves the bracketed-quoted subsection as-written. `findFirstValuelessEntry` produces `${section.toLowerCase()}.${subsection}.${key.toLowerCase()}` — exactly this shape. No code change needed for casing; verified the in-scope key tokens (`core.excludesfile`, `submodule.mysub.url`, `branch.main.merge`) match.
- **`git submodule sync` does NOT read the config url** — it resolves the url from `.gitmodules`. tsgit's `syncLevel` (`submodule.ts` ~289) also reads `row.url` from `.gitmodules` and only checks `config.submodule[name].url !== undefined` as an initialised-gate, not as the value source — so sync needs no valueless-url guard, faithful to git.

### Consuming-site map (verified against the worktree source)

Each row reuses `assertNoValuelessConfig`. Two safe placement patterns appear below:

- **Absent-path placement (the push/fetch idiom)** — read config → reach the absent/fallback branch (the value is `undefined`) → call the guard there → then throw/return the existing absent behaviour. A *valued* config resolves and returns before the guard ever runs; the *absent* case reaches the guard, which returns normally (no matching entry), then falls through to the existing refusal. Used where git's death and the value's absence coincide (the `submodule.url`, `core` path-likes).
- **Pre-resolution placement** — call the guard *before* a fallback substitutes a default (e.g. `?? 'origin'`, `?? url`), because git dies on the valueless key **even when a fallback value is available**. The guard is still a no-op for a valued config (`findFirstValuelessEntry` returns `undefined`), so a valued key resolves normally afterwards. Required for `branch.<n>.remote` and `remote.<n>.pushurl`.

In both patterns the guard throws ONLY for a present-but-valueless entry, so neither can refuse where git succeeds.

- **`branch.<n>.merge` / `branch.<n>.remote`** — `pull.ts` `resolveUpstream` (~75–89). git reads BOTH `branch.<cur>.remote` and `branch.<cur>.merge` for `pull`/upstream-merge and dies on whichever is valueless (subject to file-line order). tsgit currently: `remote = opts.remote ?? tracking?.remote ?? 'origin'` and `branch = opts.ref ?? shortMergeRef(tracking?.merge)`; the absent/fallback path is `branch === undefined → noUpstreamConfigured`. Guard placement (see Decision candidate A) governs whether one guard at the `NO_UPSTREAM_CONFIGURED` throw covers both keys, or whether `branch.<n>.remote` needs its own guard before the `?? 'origin'` fallback (because git dies on a valueless `remote` even when a default would otherwise apply).
  - `remote-config.ts` `listBranchReferrers` (~50–65) and `submodule.ts` `resolveBaseUrl` (~146) also read `branch.<n>.remote`, but as a pure equality filter / `?? 'origin'` default for `remote rename`/`remote remove`/submodule base-url — git's death site for these keys is the **pull/upstream** read, not these. Decision candidate A covers whether to guard only `pull`.
- **`merge.<d>.driver` / `merge.<d>.name`** — `resolve-merge-driver.ts` `namedChoice` (~29–38). git engages the driver only when a path's `merge` attribute names `<d>`; tsgit's `namedChoice` is reached on exactly that path. Today: valueless `.driver` → `driver?.driver === undefined` → returns built-in `TEXT` (silent divergence); `.name` valueless → silently omitted. The faithful death fires when `merge=<d>` selects this driver and `<d>.driver`/`<d>.name` is valueless. Guard placement: call `assertNoValuelessConfig(ctx, 'merge', name, ['driver', 'name'])` inside `namedChoice` **before** the `driver?.driver === undefined → TEXT` fallthrough, so a valueless `.driver` (or `.name`) under a *selected* driver refuses, while a built-in name (`text`/`binary`/`union`) and an absent `[merge "<d>"]` section keep returning `TEXT`. Decision candidate B fixes whether `.name` is guarded jointly with `.driver` (git reads `.name` independently — pinned) or only alongside a present `.driver`.
- **`submodule.<n>.url`** — `submodule.ts` `submoduleInit` (~215), `submoduleUpdate` (~717/734). git's death site is `submodule update`/`--init`. tsgit treats valueless as undefined with fallbacks (`existing !== undefined`, `?? row.url ?? ''`). Guard placement: on the `config.submodule?.get(row.name)?.url === undefined` branch in `submoduleUpdate` (~717), call `assertNoValuelessConfig(ctx, 'submodule', row.name, ['url'])` before the `init`/skip decision, so a valueless registered url refuses where git dies. `syncLevel` (~289) needs **no** guard (sync reads `.gitmodules`, pinned). Decision candidate C fixes whether `submoduleInit`'s own `existing` read (~215) also needs a guard or whether `submoduleUpdate` is the single faithful site.
- **`submodule.<n>.update`** — git dies on it at `submodule update`, but **tsgit never reads `config.submodule[name].update` for a real purpose**: `validateUpdateModes(rows)` (`submodule.ts` ~104) reads `update` from `.gitmodules` rows; `submoduleUpdate` uses `opts.mode ?? updateModes.get(row.name) ?? 'checkout'` (~722). The config field is parsed into `ParsedConfig.submodule[name].update` but has no consuming read. **There is no faithful death site.** Decision candidate D resolves: guard it anyway / defer / document the divergence.
- **`core.excludesFile`** — `read-gitignore.ts` `readGlobalExcludes` (~37–44). Today valueless → `raw === undefined` → returns `undefined` (no global excludes). git dies at `status`/`check-ignore`. Guard placement: Decision candidate E — `core` path-likes have many consumers and the faithful death is eager at config-load in git (not lazy per-accessor), so the placement question (per-accessor vs a single shared `[core]` guard at a status-class chokepoint) is genuinely open.
- **`core.attributesFile`** — `read-gitattributes.ts` `readGlobal` (~33–39). Same shape as `excludesFile`; same Decision candidate E.
- **`core.hooksPath`** — `run-hook.ts` `invokeHook` (~45–63) → `resolveHooksDir(config.core?.hooksPath, …)`. Today valueless → `hooksPath === undefined` → `${gitDir}/hooks` default. git dies at any hook-invoking command. Same Decision candidate E (the `[core]` placement family).
- **`remote.<n>.pushUrl`** — `push.ts` `resolveRemoteUrl` (~148–163). Today `url = remote?.pushUrl ?? remote?.url`; the existing guard at line 159 covers `['url']` only, on the `url === undefined` absent path. git dies on a valueless `pushurl` **even when `url` is valued** (pinned) — so the existing guard does NOT cover it (a valued `url` skips the `url === undefined` branch entirely). The `pushurl` guard must therefore run pre-resolution; and because git reports file-line order when both `pushurl` and `url` are valueless, the faithful shape is a single `['pushurl','url']` call (Decision candidate F).

### Why each guard is faithful (and safe)

The guard is a no-op for a valued config (`findFirstValuelessEntry` returns `undefined`) and for the absent case (no matching entry → `undefined`). It throws ONLY for a present-but-valueless entry, so neither placement pattern can refuse where git succeeds. The structural subtlety is `remote.<n>.pushUrl` and `branch.<n>.remote`, where git dies even though a fallback value (valued `url` / `origin` default) is available — these use the pre-resolution placement so the guard is reached before the fallback substitutes; Decision candidates A and F call this out explicitly.

**Cross-key file-line ordering.** When two keys under one subsection are both valueless (e.g. both `branch.<n>.remote` and `.merge`, or both `remote.<n>.pushurl` and `.url`), git reports whichever is **earlier in the config file**. A single `assertNoValuelessConfig(ctx, section, sub, [k1, k2])` call preserves this — `findFirstValuelessEntry` scans the token stream by line and returns the first match across all keys. Two separate single-key guard calls would instead report a fixed key-order regardless of file position, diverging from git. This makes the **single multi-key call** the faithful shape wherever git reads sibling keys that can co-occur (Decision candidates A and F).

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| A | Guard placement for `branch.<n>.remote` / `.merge`, given git dies on a valueless `branch.<n>.remote` **even when `origin` would default** | (1) Single guard at `pull.ts`'s `NO_UPSTREAM_CONFIGURED` throw, keys `['remote','merge']` — but this never fires for valueless `remote` because the `?? 'origin'` default makes `branch !== undefined` and the throw is skipped. (2) Guard `['remote','merge']` **early in `resolveUpstream`** (right after reading `tracking`), before the `?? 'origin'` and `?? merge` fallbacks, firing on either valueless key by file-line order. (3) Scope to `pull` only and leave `remote rename`/`remove`/submodule base-url reads (`listBranchReferrers`, `resolveBaseUrl`) unguarded for this backlog. | (2) **and** (3): one early guard in `resolveUpstream` over `['remote','merge']`; do not touch the rename/submodule readers. | Only (2) actually fires for a valueless `remote` (git dies despite the default); file-line order across both keys matches git's per-entry callback order (ADR-327). (3) keeps the diff bounded — git's pinned death site for these keys is the upstream read, not `remote rename`. |
| B | Whether `merge.<d>.name` is guarded jointly with `.driver` or only when `.driver` is present | (1) Single guard `assertNoValuelessConfig(ctx,'merge',name,['driver','name'])` in `namedChoice` before the `TEXT` fallthrough — fires on whichever of `.driver`/`.name` is valueless by file-line, matching git reading `.name` independently. (2) Guard only `['driver']`; treat valueless `.name` as absent (a residual divergence). (3) Two separate guards, `.driver` then `.name`, in fixed order (diverges from git's file-line order). | (1) — one guard over `['driver','name']`. | git pinned that `.name` dies independently of `.driver`; the single ordered-by-line guard is the faithful, minimal shape and reuses the enabler verbatim. |
| C | The faithful site(s) for `submodule.<n>.url` | (1) Guard only in `submoduleUpdate` (~717), git's pinned death command. (2) Guard in both `submoduleInit` (~215) and `submoduleUpdate`. (3) Guard in `submoduleInit` only. | (1) — `submoduleUpdate` only. | git dies on valueless registered url at `submodule update`; `submoduleInit`'s `existing` read is an init-time gate, and `submodule sync` reads `.gitmodules` (pinned, no guard). One site matches git's pinned command. |
| D | `submodule.<n>.update` — git dies on it, but tsgit has **no consuming read** (mode comes from `.gitmodules`, not config) | (1) **Defer** to a follow-up backlog entry with a written divergence note (no guard now). (2) Add a synthetic guard at `submoduleUpdate` (~717) over `['url','update']` so the key still refuses, despite tsgit never reading the value. (3) Make tsgit read `config.submodule[name].update` as a real mode source (faithful to git's precedence) and then guard it. | (1) **Defer + document**. | There is no faithful site today; (2) would refuse on a value tsgit ignores (faithful refusal but no behavioural consumer — fragile, surprising); (3) is a real behaviour change (config-over-gitmodules update precedence) outside this backlog's "one guard per consuming site" scope. Record as a dependency-ordered follow-up like ADR-329 did for this very set. |
| E | Placement family for the three `[core]` path-likes (`excludesFile`, `attributesFile`, `hooksPath`) — git's death is eager at config-load, tsgit's reads are lazy per-accessor | (1) Per-accessor guard at each reader's `=== undefined` fallback (`readGlobalExcludes`, `readGlobal`, `invokeHook`), keys `[the one core key]` each — fires only when that accessor runs. (2) One shared `assertNoValuelessConfig(ctx,'core',undefined,['excludesfile','attributesfile','hookspath'])` at a status-class chokepoint, approximating git's eager load. (3) Per-accessor but each guarding the full `['excludesfile','attributesfile','hookspath']` set so any core path-like refuses at any of the three readers. | (1) — per-accessor, single-key each. | Per-accessor matches tsgit's lazy architecture and the enabler's "one call at the consuming site" contract (ADR-327). git's eager-vs-lazy timing is a rendering/timing detail, not part of the data contract (ADR-249) — what matters is that the key refuses with the right `{key,source,line}` when the value is needed. (2) invents a chokepoint that does not exist; (3) over-fires (refuses on `attributesFile` while resolving excludes). |
| F | Where the `remote.<n>.pushUrl` guard goes relative to the existing `url` guard in `push.ts` `resolveRemoteUrl`, including the both-valueless co-occurrence | (1) Add `pushurl` to the existing `url`-undefined guard line 159 — WRONG: a valued `url` skips that branch, so valueless `pushurl` never refuses. (2) Keep the existing `['url']` guard on the absent path and add a **separate** `['pushurl']` guard pre-resolution — fires for valueless `pushurl`, but if both `pushurl` and `url` are valueless it always reports `pushurl` first, ignoring file-line order. (3) Replace both with a **single** `['pushurl','url']` guard pre-resolution (after `readConfig`, before `url = pushUrl ?? url`); on no valueless entry it returns and the `url === undefined` branch still throws `REMOTE_NOT_CONFIGURED`. | (3) — single pre-resolution `['pushurl','url']` guard. | git dies on valueless `pushurl` even with a valued `url` (pinned), so the guard must precede the `?? url` fallback; and a single multi-key call preserves git's file-line ordering when both are valueless (see "Cross-key file-line ordering"). The absent path keeps `REMOTE_NOT_CONFIGURED` because the guard no-ops when nothing is valueless. (2) diverges on the both-valueless co-occurrence. **Note:** 24.9l pinned only `['url']`; this widens it to `['pushurl','url']` — confirm the existing `url`-only interop row still passes (it must, since file-line order with one valueless key is unchanged). |

## Test strategy

### Interop pins (faithfulness — the load-bearing layer)

Extend `test/integration/missing-value-refusal-interop.test.ts` (the 24.9l structure). For each **in-scope** key (every row above except `submodule.<n>.update` per Decision candidate D), add a per-key block mirroring the existing `user.name`/`remote.origin.url` blocks:

1. **git refusal pin** — hand-write a fixture with the valueless key at a known line into a fresh `mktemp` repo's `.git/config`; run git's pinned consuming command (`pull`, `merge`, `submodule update`, `status`/`check-ignore`, `check-attr`, `commit` for hooksPath, `push` for pushurl) via the isolated `runGit`/`tryRunGit` helpers; assert `g.ok === false`, stderr contains `missing value for '<key>'`, `bad config variable '<key>'`, and `at line <N>`.
2. **tsgit structured pin** — same fixture, drive the tsgit facade (`repo.pull`, `repo.merge`, `repo.submoduleUpdate`, the ignore/attributes/hook paths, `repo.push`); assert each `CONFIG_MISSING_VALUE` field individually (`code`, `key`, `line`, `source` matches `/\/config$/`) — mutation-resistant per-field, try/catch + direct `.data` assertions.
3. **two-line reconstruction** — run both git and tsgit on the same fixture; reconstruct git's two lines from tsgit's `{key,line}` with the `.git/config` path-token normalization (the existing `replace(/in file '[^']+'/, …)` idiom) and assert equality.
4. **absent-vs-valueless distinctness** — a fixture with the section present but the key absent (or no section), assert tsgit throws the **existing** absent-case code (`NO_UPSTREAM_CONFIGURED`, `REMOTE_NOT_CONFIGURED`, built-in `text` for the merge driver, default hooks dir / no global excludes) and **not** `CONFIG_MISSING_VALUE`.
5. **`--list` happy-path** — `git config --file <fixture> --list` and tsgit `configList` both succeed on the valueless fixture, proving the refusal is at the consumer, not the parse (one representative case suffices, the parser is shared).
6. **Sibling-key file-line ordering** — for the two multi-key sites (`branch.<n>.['remote','merge']` and `remote.<n>.['pushurl','url']`), add a fixture where **both** sibling keys are valueless, in each order, and assert tsgit reports the key on the **earlier config line** (matching git's pinned per-entry callback order). This pins the cross-key ordering that the single multi-key `assertNoValuelessConfig` call delivers and a split-call placement would break (Decision candidates A, F). At least one such ordering pin per multi-key site, both orders covered.

The matrix has **one pinned row per in-scope key**. The fixtures must control line numbers exactly (the 24.9l fixtures latch the valueless entry to a known line and assert that line). Casing must be asserted against git's verbatim token (`core.excludesfile` lowercased, `submodule.mysub.url` subsection-preserved).

For `merge.<d>.driver`/`.name` and `submodule.<n>.url`, the fixture setup is heavier (a `.gitattributes` `* merge=<d>` + a real conflicting content merge; a `.gitmodules` + a `file://` submodule source registered into config). Follow the interop-helper isolation (ADR-337/338/339): isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off, scrubbed `GIT_*`. Reuse a shared `beforeAll` repo per heavy block where possible (project memory: heavy git-spawning interop times out hooks under validate's concurrency — one shared repo + 60s timeout).

### Unit tests (per guarded consuming site)

At each guarded site add unit tests driving the three states independently (Object Calisthenics / mutation-resistant guard isolation per CLAUDE.md):
- **valueless** → `CONFIG_MISSING_VALUE` with the right `{key,line,source}` (try/catch + `.data` assertions, never bare `toThrow(ErrorClass)`).
- **valued** → resolves normally (driver chosen, upstream resolved, url returned, hooks dir / global excludes resolved).
- **absent** → existing fallback/refusal (e.g. `'origin'` default, built-in `text`, `NO_UPSTREAM_CONFIGURED`).
Each guard condition (e.g. `branch.<n>.remote` vs `.merge`; `pushurl` vs `url`) gets an **isolated** test triggering that key alone — one test triggering both does not prove each guard fires independently.

### Property tests

**Not applicable.** Per the CLAUDE.md four-lens test (round-trip / compositional matcher / total function over a grammar / idempotence-counting), this work is command-site **wiring** — it adds `assertNoValuelessConfig` calls at consuming sites and reuses the already-property-tested `findFirstValuelessEntry`/`tokenizeConfig` parser. No new parser, matcher, or algebraic grammar is introduced. The grammar-level invariants of the config tokenizer are already covered by the existing `config-read.properties.test.ts` family. Stated explicitly so the review pass does not flag a missing `*.properties.test.ts` sibling.

## Out of scope

- **Int-typed valueless** (24.9s) — `fatal: bad numeric config value '' for '<key>' …: invalid unit` is a different shape (single `fatal:` line, no `error:` prefix, no `at line N`); needs its own error code and is **blocked** until an int config key is merged into `ParsedConfig` (ADR-329).
- **The mechanism / error-shape redesign** — fixed by ADR-327 (cold-path re-read) and ADR-328 (`CONFIG_MISSING_VALUE {key,source,line}`, absolute `source`). Not revisited here.
- **`submodule.<name>.update`** — git dies on it but tsgit has no consuming read; deferred per Decision candidate D (no faithful site to guard without a behaviour change).
- **`git submodule sync`'s `submodule.<n>.url`** — pinned NOT to die in git (reads `.gitmodules`); tsgit's `syncLevel` matches, so no guard.
- **The `branch.<n>.remote` reads in `remote rename`/`remote remove`/submodule base-url resolution** — not git's pinned death site for these keys (per Decision candidate A, recommendation scopes to `pull`).
- **Keys git does NOT lazily die on** — none in this candidate set; the matrix proves every in-scope key dies. (The earlier fall-through hypotheses were all disproven empirically.)
