# Design — remaining-valueless-refusal

> Brief: extend 24.9l's `CONFIG_MISSING_VALUE` refusal to the *other* string-typed config keys git dies lazily on when present-but-valueless — `branch.*.merge`/`remote`, `merge.*.driver`/`name`, `submodule.*.url`/`update`, `core` path-likes (`excludesFile`/`attributesFile`/`hooksPath`), and `remote.*.pushUrl` — by adding one `assertNoValuelessConfig` call at each *real* consuming site, scoped to the families git actually refuses on AND tsgit actually reads.
> Status: draft → self-reviewed ×3 → accepted

## Context

24.9l (ADRs 327–329, `docs/design/missing-value-refusal-parity.md`) built the whole mechanism for the valueless-string refusal and shipped it for **identity** (`user.name`/`email`) and **remote-URL** (`remote.<n>.url` on `fetch`/`push`). This is the dependency-ordered follow-up ADR-329 deferred: the *remaining* string-typed keys.

The enabler is already in place — this design does **not** redesign it:

- `src/application/commands/internal/valueless-config-guard.ts` — `assertNoValuelessConfig(ctx, section, subsection, keys)`: on a command's refusal path, throws `CONFIG_MISSING_VALUE { key, source, line }` for the FIRST valueless key (by config-file line) among `keys` under `[<section> "<subsection>"]`; returns normally otherwise.
- `src/application/primitives/config-read.ts` — `findFirstValuelessEntry` (the cold-path re-tokenize behind the guard). It already iterates **tokens in file order**, lower-cases section + key, and keeps the subsection **verbatim**, producing `qualifiedKey` as `${loweredSection}.${subsection}.${loweredKey}` (e.g. `branch.Main.merge`) — matching git's reported key exactly (pinned below). The merge layer erases every valueless string field to absent (ADR-315 D4: `if (value === null) continue`), so the parsed `ParsedConfig` consumer cannot itself distinguish absent from valueless — the guard re-reads raw tokens on the cold path (ADR-327).
- `src/domain/commands/error.ts` — `configMissingValue(key, source, line)` + the `CONFIG_MISSING_VALUE` variant.

The established calling pattern (ADR-329, already shipped): the guard is called **immediately before the existing "absent" refusal**, so a valued config still resolves and the absent case still falls through. Identity (`current-identity.ts` L15), `fetch.ts` L142-143, `push.ts` L155-160 (today `['url']` only, with a comment that valueless `pushurl` is out of scope — this PR adds it).

ADR-226 (prime directive) binds observable behaviour byte-for-byte; ADR-249 refines it: faithfulness binds the **data + on-disk state + refusal conditions**, not rendered stdout. The library emits the structured error carrying `{ key, source, line }`; the interop test reconstructs git's two display lines from those fields and diffs against real `git`.

### The decisive constraint this design surfaces

24.9l's two families share a property the brief assumed of the remaining five but which the empirical pinning **disproves for most of them**: git dies *and* tsgit has a real refusal-path consumer that reads the key string-typed. For the remaining families the pinned matrix splits three ways:

1. **git dies AND tsgit reads it at a refusal/consuming site** → a guard is warranted (`branch.*`, `remote.*.pushUrl`).
2. **git dies but tsgit's consumer collapses the valueless case to a benign fallback instead of refusing** (`merge.*.driver`/`name` → built-in `text`; `core` path-likes → silent miss) → adding a guard means *introducing a new refusal where tsgit currently has none*. This is a faithfulness choice, not a mechanical extension — surfaced as a decision candidate, not decided here.
3. **git does NOT die at all** (`submodule.*.url`/`update`) → there is nothing to be faithful to; excluded with the matrix row proving it.

The deliverable is the faithful matrix and the scoped guard set it implies — not a guard for every key in the brief regardless of git's behaviour.

## Requirements

1. Every key family for which git **does** die lazily on a present-but-valueless string read, **and** which tsgit consumes at a site that already refuses, gains a `CONFIG_MISSING_VALUE { key, source, line }` refusal reconstructing git's two lines (`error: missing value for '<key>'` / `fatal: bad config variable '<key>' in file '<F>' at line <N>`, exit 128). The library emits no rendered string (ADR-249).
2. **Ordering is file-position** (pinned): with several valueless candidate keys under one section, the refusal reports the FIRST by config-file line — exactly what `findFirstValuelessEntry` already does. No key-priority / resolution-order rule (`pushurl ?? url`) governs *which key is reported*.
3. **The reported key matches git's case-folding** (pinned): section lower-cased, key lower-cased, subsection verbatim (`branch.Main.merge`, `core.excludesfile`, `remote.origin.pushurl`). `findFirstValuelessEntry` already produces this.
4. **Absent ≠ valueless, no regression.** Each guard sits on the existing refusal path immediately before the existing "absent" throw (`NO_UPSTREAM_CONFIGURED`, `REMOTE_NOT_CONFIGURED`, …); a valued key still resolves, an absent key still falls through to the existing behaviour unchanged.
5. **A family git does NOT die on is excluded**, with the matrix row proving it (`submodule.*`). A family git dies on but tsgit does not currently read at a refusal site is **deferred or guarded only per an explicit decision** (`merge.*`, `core` path-likes) — not silently added.
6. Porcelain reads (`config --get`/`--list`/`--type=bool`) stay faithful (succeed on valueless keys, ADR-314) — unchanged; the refusal lives at command consumers only.

## Design

### Pinned git behaviour (git 2.54.0; `env -i`, isolated non-existent `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off) — authoritative

Fixtures written directly into `<tmp>/.git/config` (git's CLI cannot emit a valueless entry), then the real command run in the `mktemp -d` throwaway. The worktree's `.git/config` was spot-checked intact afterwards.

| # | Config (in `.git/config`) | Command(s) | git stderr (two lines) | exit | Conclusion |
|---|---|---|---|---|---|
| B1 | `[branch "main"]` / `remote = origin` / `merge` (valueless, line 8) | `git pull`, `git pull origin main`, `git status` | `error: missing value for 'branch.main.merge'`<br>`fatal: bad config variable 'branch.main.merge' in file '.git/config' at line 8` | 128 | git dies on valueless `branch.<cur>.merge` |
| B2 | `[branch "main"]` / `remote` (valueless, line 7) / `merge = …` | `git pull`, `git status` | `… 'branch.main.remote'` … `at line 7` | 128 | dies on valueless `branch.<cur>.remote` |
| B3 | `[branch "main"]` / `remote` (line 5) / `merge` — both valueless, **remote earlier** | `git pull` | `… 'branch.main.remote'` … `at line 5` | 128 | first valueless **by file line** |
| B4 | `[branch "Main"]` / `Merge` (valueless, mixed case) | `git status` | `… 'branch.Main.merge'` … `at line 5` | 128 | **key lower-cased, subsection verbatim** |
| B5 | `[branch "main"]` / `merge` valueless | `git log -1`, `config --get user.name`, `rev-parse`, `branch --list`, `commit`, `stash list`, `diff`, `show` | (no die — exit 0) | 0 | branch keys read only by **tracking-aware** commands (status/pull), not universally eager |
| B6 | `[branch "main"]` / `merge` valueless, **HEAD detached** | `git status` → 0; `git pull origin main` → 128 (`'branch.main.merge'`); `git pull` (no remote.origin) → 128 | 0 / 128 | `status` reads only the *current* branch's tracking (none when detached → no die); `pull` reads `[branch *]` **eagerly** building its refspec/remote map → dies even detached / with explicit args |
| M1 | `.gitattributes` `f.txt merge=custom` + `[merge "custom"]` / `driver` (valueless, line 5) | `git merge a` (conflicting) | `error: missing value for 'merge.custom.driver'`<br>`… at line 5` | 128 | git dies at the merge that resolves `merge=custom` |
| M2 | `[merge "custom"]` / `driver = cat %A` / `name` (valueless, line 6) | `git merge a` | `… 'merge.custom.name'` … `at line 6` | 128 | dies on valueless `name` too |
| M3 | `[merge "custom"]` / `driver` valueless | `git status`, `log -1`, `rev-parse`, `add` | (no die — exit 0) | 0 | merge driver is **lazy**: read only when a merge resolves `merge=custom`, NOT in `git_default_config` |
| S1 | `.gitmodules` + `[submodule "sub"]` / `url` (valueless) | `git submodule status`/`init`/`sync`/`update --init`, `git status` | (no die) | 0 | **git does NOT die on valueless `submodule.<n>.url`** |
| S2 | `[submodule "sub"]` / `url = …` / `update` (valueless) | `git submodule status`/`init`/`update --init`, `git status` | (no die) | 0 | **git does NOT die on valueless `submodule.<n>.update`** |
| C1 | `[core]` / `excludesFile` (valueless, line 5) | `git status`, `add`, `log -1`, `rev-parse`, `cat-file -p HEAD`, `hash-object` | `error: missing value for 'core.excludesfile'`<br>`… at line 5` | 128 | dies **eagerly** (`git_default_core_config` fires on nearly every command); key lower-cased |
| C2 | `[core]` / `excludesFile` valueless | `git config --get user.name` | (no die) | 0 | porcelain config read bypasses the typed callback (ADR-314 parity) |
| C3 | `[core]` / `attributesFile` (valueless) | `git status`, `add`, `checkout .` | `… 'core.attributesfile'` … | 128 | dies eagerly |
| C4 | `[core]` / `hooksPath` (valueless) | `git commit` (hook-firing) | `… 'core.hookspath'` … | 128 | dies eagerly |
| P1 | `[remote "origin"]` / `url = …` / `pushurl` (valueless, line 6) | `git push origin main` **AND** `git fetch origin` | `error: missing value for 'remote.origin.pushurl'`<br>`… at line 6` | 128 | `pushurl` read **eagerly with the remote object** — dies on fetch too, not just push |
| P2 | `[remote "origin"]` / `pushurl` (line 5) / `url` — both valueless, **pushurl earlier** | `git push origin main` | `… 'remote.origin.pushurl'` … `at line 5` | 128 | first valueless **by file line** |
| P3 | `[remote "origin"]` / `url` (line 5) / `pushurl` — both valueless, **url earlier** | `git push origin main` | `… 'remote.origin.url'` … `at line 5` | 128 | first by line — **NOT** a `pushurl ?? url` resolution order |
| P4 | `[remote "origin"]` / `pushurl` (valueless, no url) | `git push origin main` | `… 'remote.origin.pushurl'` … `at line 5` | 128 | pushurl-only valueless still dies |
| — | any valueless key | `git config --list` / `--get` / `--type=bool` | succeed (ADR-314) | 0 | porcelain reads unchanged (consistency check) |

### Scoping conclusion (drawn from the matrix, not from the brief)

| Family | git dies? | tsgit consumer (today) | Reaches a refusal path? | Verdict |
|---|---|---|---|---|
| `branch.<cur>.merge` / `.remote` | **Yes** (B1–B4) | `pull.ts` `resolveUpstream` (L82): `config.branch?.get(cur)?.remote/merge` → throws `NO_UPSTREAM_CONFIGURED` when `merge` absent | **Yes** | **IN SCOPE** — guard at pull's resolveUpstream |
| `remote.<n>.pushUrl` | **Yes**, on fetch+push (P1–P4) | `fetch.ts`/`push.ts` `resolveRemoteUrl` — push reads `pushUrl ?? url`; fetch reads `url` only, but git dies on a valueless `pushurl` at **both** | **Yes** (existing url guard) | **IN SCOPE** — extend the existing `['url']` guard to `['url','pushurl']` at **both** fetch and push |
| `merge.<d>.driver` / `.name` | **Yes**, lazily at merge (M1–M3) | `resolve-merge-driver.ts` `namedChoice`: `driver?.driver === undefined → return TEXT` (built-in fallback) | **No** — valueless collapses to built-in text, no refusal | **DECISION** (candidate #2) — add a consumer guard vs defer |
| `core.excludesFile` / `attributesFile` / `hooksPath` | **Yes**, eagerly (C1–C4) | `read-gitignore.ts` (`=== undefined → undefined`), `read-gitattributes.ts` (silent miss), `run-hook.ts` `resolveHooksDir` (falls to default) | **No** — every consumer treats valueless as absent and silently falls through | **DECISION** (candidate #3) — guard a chosen subset vs defer |
| `submodule.<n>.url` / `.update` | **No** (S1, S2) | `submodule.ts` (`?.url === undefined → skip row`); `.update` read from `.gitmodules`, not config | n/a | **EXCLUDED** — nothing to be faithful to |

The two families that are mechanical extensions of 24.9l (git dies + tsgit refuses) are `branch.*` and `pushUrl`. The other three are either impossible to match (submodule — git agrees with tsgit's "absent") or require *introducing a refusal tsgit lacks today* (merge driver, core path-likes), which is a faithfulness-vs-blast-radius judgement reserved for the ADR phase.

### In-scope guard placements

All three reuse `findFirstValuelessEntry` + `CONFIG_MISSING_VALUE` unchanged; each is one `assertNoValuelessConfig` call on an existing refusal path, before the existing absent throw.

**`branch.*` — `pull.ts` `resolveUpstream` (L75-89).** Today: when `branch === undefined` (no `opts.ref` and no resolvable `tracking?.merge`), throws `noUpstreamConfigured(fallbackRef)`. The guard fires when the upstream cannot be resolved from config, before that throw:

```
when branch (the merge ref) cannot be resolved from config (the existing throw point):
  if currentBranch !== undefined:                                  // detached HEAD has no [branch "<cur>"] to read
    await assertNoValuelessConfig(ctx, 'branch', currentBranch, ['merge', 'remote'])
  throw noUpstreamConfigured(fallbackRef)
```

The `currentBranch !== undefined` guard is load-bearing: `assertNoValuelessConfig(ctx, 'branch', undefined, …)` would match the *section-less* `[branch]` block (subsection `undefined`), not a per-branch section — wrong target. On detached HEAD there is no current-branch tracking to refuse over (B6: `status` doesn't die either), so the guard is correctly skipped and `NO_UPSTREAM_CONFIGURED` stands.

Subtlety pinned (B1/B6): git's `branch.*` die is partly **eager within `pull`** — it reads every `[branch *]` section building its refspec/remote map, so it dies on valueless `branch.<cur>.merge` *even when `git pull origin main` supplies the upstream explicitly, and even with HEAD detached* (B6). `git status`, by contrast, reads only the *current* branch's tracking — no die when detached (B6) or when not on the configured branch. tsgit's `resolveUpstream` reads `config.branch?.get(currentBranch)` only — the current branch, only when `opts.ref` is not given. So the faithful-but-bounded placement is the refusal path (when tsgit *would* otherwise throw `NO_UPSTREAM_CONFIGURED`): it matches git's die for the common `git pull` (no args, on a branch) invocation, but NOT git's eager die on `pull origin main` / detached HEAD. Closing that gap needs an eager guard on pull's branch-config read (candidate #4(c)) — a larger design, surfaced not assumed. Key order `['merge', 'remote']` is irrelevant to *which* key is reported (file-line order decides, requirement 2); it only bounds the candidate set.

**`remote.*.pushUrl` — `push.ts` (L155-160) and `fetch.ts` (L142-143).** Today both guard `['url']`. Pinned P1–P4: git reads `url` and `pushurl` together when the remote object is built and dies on the first valueless of the two *by file line*, on **both** fetch and push. So both sites become:

```
await assertNoValuelessConfig(ctx, 'remote', remoteName, ['url', 'pushurl'])
```

`findFirstValuelessEntry` reports the first valueless of the set by line — reproducing P2 (`pushurl` earlier → `pushurl`), P3 (`url` earlier → `url`), P4 (pushurl-only). The push comment "valueless `pushurl` is not yet in scope" is removed. Note fetch's functional read is `url` only, but faithfulness (P1) requires fetch to *also* die on a valueless `pushurl` — so fetch's guard list includes `pushurl` too even though fetch never uses that URL. The list order is cosmetic (file-line decides the reported key); `['url', 'pushurl']` mirrors the existing call shape.

### Error shape, detection mechanism, hexagonal placement — all inherited, unchanged

`CONFIG_MISSING_VALUE { key, source, line }` (ADR-328), `findFirstValuelessEntry` cold-path re-read (ADR-327), guard in the application layer on the refusal path (ADR-329's established pattern). No new error code, no new primitive, no `ParsedConfig` change, no public-type ripple. Each in-scope addition is a one-line call (plus, for `branch`, threading `currentBranch` — already in `resolveUpstream`'s scope).

### Source-path token (inherited from ADR-328)

`source` is tsgit's resolved **absolute** config path (`${commonGitDir}/config`), the same value `findFirstValuelessEntry` already returns. The interop test normalizes the `file '<F>'` token to git's repo-relative `.git/config` before comparing; `key` and `line` compare verbatim (ADR-249: the path string is the caller's to render).

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | **Scope — which of the five families warrant a guard this PR.** | (a) **Faithful-minimal**: only the families git dies on AND tsgit already refuses on — `branch.*` (pull) + `remote.*.pushUrl` (fetch+push). Exclude `submodule.*` (git doesn't die). Defer `merge.*` + `core` path-likes (tsgit has no refusal path; guarding them = new refusal, see #2/#3). (b) **Faithful-maximal**: also add new refusals for `merge.*` and `core` path-likes wherever git dies, introducing refusals tsgit lacks today. (c) **branch-only / pushUrl-only split** into two PRs. | **(a)** | (a) lands every case that is a *mechanical* extension of 24.9l (git dies + tsgit already refuses) — no new refusal surface, no behaviour change beyond the message. (b) couples this to candidates #2/#3, each of which changes tsgit from "silently falls back" to "refuses" — a real behaviour change with its own blast radius (every status/add/log for `core.*`, every conflicting merge for `merge.*`), better decided on its own evidence. (c) over-fragments two near-identical one-line additions. `submodule.*` is excluded under every option (S1/S2 — git agrees with tsgit). **Deferrals, dependency-ordered:** `merge.*` (candidate #2), `core` path-likes (candidate #3), each a tracked follow-up. **User decides.** |
| 2 | **`merge.*.driver`/`name` — guard or defer.** git dies lazily at the merge resolving `merge=<driver>` (M1/M2); tsgit's `namedChoice` collapses valueless `driver` to built-in `text` (no refusal). | (a) **Defer** — keep tsgit's silent fallback; record a follow-up. (b) **Guard in `namedChoice`** — when `merge.<d>` is configured but `driver`/`name` is valueless, call `assertNoValuelessConfig(ctx, 'merge', name, ['driver','name'])` before the `return TEXT` fallback, reproducing git's die at merge. (c) **Guard but only for `driver`** (the functional key), leave `name` as benign. | **(a) defer** | The guard would convert a benign fallback (valueless driver → built-in 3-way text, a harmless outcome) into a hard refusal — a genuine behaviour change, not a message change, on the merge hot path. It is faithful (git dies), so it is a legitimate follow-up, but it is lazy (M3: not eager), low-traffic (only conflicting merges on a path with a custom `merge=` attribute), and orthogonal to the eager/refusal-path families in candidate #1. (b) is the faithful choice if breadth is wanted; (c) is unfaithful by halves (M2 pins git dying on `name` too). **User decides whether to fold into this PR or defer.** |
| 3 | **`core` path-likes (`excludesFile`/`attributesFile`/`hooksPath`) — guard or defer.** git dies **eagerly** (C1/C3/C4 — `git_default_core_config` on nearly every command); tsgit reads each at a silent-miss consumer (`read-gitignore`/`read-gitattributes`/`run-hook`), no refusal path. | (a) **Defer** — record a follow-up; these need an *eager* guard (git dies on `status`/`log`/`add`, not just at a feature use-site), unlike every 24.9l site. (b) **Guard at each feature consumer** (`readGlobalExcludes`, `readGlobal` attributes, `resolveHooksDir`) — matches git only when that feature is exercised, NOT git's eager die on `log`/`rev-parse`. (c) **Add one eager guard** on a shared early path (e.g. inside `readConfig`/`loadConfig`) covering all three `core` path-likes, reproducing git's "dies on almost everything". | **(a) defer** | These are categorically unlike 24.9l: git's die is **eager** (C1 — fires on `log`/`rev-parse`/`cat-file`), so faithful parity needs an *eager* guard (option c), which is an architectural choice — putting a refusal inside the config-read hot path that today never throws on valueless. That is a larger, separable design (it changes when *every* command refuses, and risks regressing the absent/empty cases), worth its own ADR + matrix. (b) is the cheap-but-unfaithful half-measure (catches `status`/`add` but not `log`). Defer (a) keeps this PR a clean extension; the eager-guard design is the tracked follow-up. **User decides.** |
| 4 | **`branch.*` guard breadth — which consuming sites.** tsgit reads `branch.*` at three sites: `pull.ts` `resolveUpstream` (refuses `NO_UPSTREAM_CONFIGURED`), `submodule.ts` `resolveBaseUrl` (`branch.<head>.remote ?? 'origin'`, no refusal), `remote-config.ts` `listBranchReferrers` (rename/remove rewrite, no refusal). git dies eagerly on tracking-aware commands (B5: status/pull yes; log/commit no). | (a) **pull only** — guard `resolveUpstream`'s refusal path; defer the others. (b) **pull + submodule** — also guard `resolveBaseUrl` before its `'origin'` fallback. (c) **eager guard** on a shared branch-config read covering every site (closest to git's eager die). | **(a) pull only** | `resolveUpstream` is the one `branch.*` site that *already* refuses, so it is the mechanical 24.9l-style extension. `resolveBaseUrl`'s `?? 'origin'` is a benign fallback (like the `core`/`merge` cases — guarding it = new refusal, see #2/#3); `listBranchReferrers` is a rewrite, not a read-for-purpose. (c) chases git's eager die — same architectural cost as candidate #3(c). Pinned caveat B1 (git dies even on `git pull origin main`): tsgit's explicit-`opts.ref` path skips the config read, so (a) matches the no-arg `git pull` die but not the explicit-args die; closing that gap is the eager-guard follow-up. **User decides.** |

## Test strategy

Per ADR-329's proven shape. Each in-scope guard gets unit + interop coverage; assert `.data` fields **individually** via try/catch (never bare `toThrow(Class)`), one isolated test per guard condition (mutation-resistant, per project conventions).

### Unit

- **`pull` `resolveUpstream`** (drive `pull` with a stubbed fetch/merge, or test `resolveUpstream` through `pull`'s entry): valueless `branch.<cur>.merge` → `CONFIG_MISSING_VALUE { key:'branch.<cur>.merge', line, source }`; valueless `branch.<cur>.remote` → `{ key:'branch.<cur>.remote' }`; both valueless, remote earlier → `{ key:'branch.<cur>.remote', line: <earlier> }` (the **file-order discriminator** test, separate from the single-valueless cases, killing a fixed-key mutant); absent branch tracking → still `NO_UPSTREAM_CONFIGURED` (regression guard, assert the code); valued tracking → resolves (no throw).
- **`push` / `fetch` `resolveRemoteUrl`**: valueless `pushurl` (url valued) → `{ key:'remote.<n>.pushurl', line }` on **both** push and fetch; both valueless with `url` earlier → `{ key:'remote.<n>.url' }`; both valueless with `pushurl` earlier → `{ key:'remote.<n>.pushurl' }` (file-order pair — the P2/P3 discriminator); absent url+pushurl → still `REMOTE_NOT_CONFIGURED`; valued url → resolves.

### Interop (`test/integration/missing-value-refusal-interop.test.ts`, extend; or a sibling)

Mirror the existing valueless-identity interop: write the valueless line by `writeFile` into `<tmp>/.git/config` (git's CLI cannot emit a valueless entry), run real `git` via `tryRunGit` into a tmpdir's `.git` (scrubbed env, `interop-helpers.ts`), capture exit 128 + the two stderr lines; run tsgit's command on the same repo; reconstruct git's two lines from `{ key, source, line }` (normalizing the `file '<F>'` token to repo-relative; `key`/`line` verbatim) and assert equality. Per in-scope family:

- `branch.<main>.merge` valueless → `git pull` (twin) vs tsgit `pull` (B1).
- `remote.origin.pushurl` valueless (url valued) → `git push origin main` **and** `git fetch origin` (P1) vs tsgit `push`/`fetch`.
- `remote.origin` both valueless, url earlier → reports `url` (P3); pushurl earlier → reports `pushurl` (P2).
- **Distinctness controls** (proving requirement 5/6): `git config --list` on the same file **succeeds** in both; `submodule.*.url` valueless → real `git submodule update --init` exits 0 (S1) and tsgit does NOT raise `CONFIG_MISSING_VALUE` (documents the excluded family without regressing it).

### Property tests — DO NOT APPLY

Per the four-lens rule: these are **command-surface refusals**, not a parser/round-trip, matcher/aggregator, total-function-over-grammar, or idempotence/counting invariant. The file-order detection is `findFirstValuelessEntry`'s already-tested behaviour; this PR adds call sites, not grammar. No `*.properties.test.ts` sibling is warranted.

## Out of scope

- **`submodule.*.url` / `.update`** — git does **not** die on a valueless value (S1/S2); excluded, not deferred. There is no faithful refusal to add.
- **`merge.*.driver`/`name`** — git dies lazily at merge (M1/M2) but tsgit collapses valueless → built-in `text`; guarding it introduces a new refusal (candidate #2). Deferred unless the user folds it in.
- **`core` path-likes** — git dies **eagerly** (C1/C3/C4); faithful parity needs an *eager* guard inside the config-read hot path, a separable architectural design (candidate #3). Deferred unless the user folds it in.
- **`branch.*` on non-refusal sites** (`submodule.resolveBaseUrl`, `remote-config.listBranchReferrers`) and the **explicit-`pull` -args eager-die gap** (B1) — candidate #4; deferred under the recommended pull-only scope.
- **Absent-config divergence** — tsgit's `NO_UPSTREAM_CONFIGURED`/`REMOTE_NOT_CONFIGURED`/`AUTHOR_UNCONFIGURED` on the wholly-absent case is a pre-existing, untouched divergence; no regression.
- **Int-typed valueless shape** — different message (`bad numeric config value '' … invalid unit`, single fatal line, no `at line N`); no int key merged today (ADR-329); blocked, its own future code.
- **Porcelain read surfaces** (`config --get`/`--list`/`--type=bool`) — already faithful via ADR-314 (C2); unchanged.
- **Writing valueless entries** — git's CLI cannot; not a surface (ADR-314/315 D5).
- **The byte-exact repo-relative `file '<F>'` token** — caller-side rendering (ADR-249); library emits its absolute resolved path in `source`; interop normalizes.
