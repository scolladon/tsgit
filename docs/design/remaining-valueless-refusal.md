# Design — remaining-valueless-refusal

> Brief: extend 24.9l's `CONFIG_MISSING_VALUE` refusal to the *other* string-typed config keys git dies on when present-but-valueless — `branch.*.merge`/`remote`, `merge.*.driver`/`name`, `core` path-likes (`excludesFile`/`attributesFile`/`hooksPath`), and `remote.*.pushUrl` — under the **faithful-maximal** scope chosen by the user (ADR-346): add the refusal at *every* family git dies on that a tsgit command reaches, across both lazy and eager dies. `submodule.*` is excluded (git does not die).
> Status: accepted (ADRs 346–349)

## Context

24.9l (ADRs 327–329, `docs/design/missing-value-refusal-parity.md`) built the whole mechanism for the valueless-string refusal and shipped it for **identity** (`user.name`/`email`) and **remote-URL** (`remote.<n>.url` on `fetch`/`push`). This is the dependency-ordered follow-up ADR-329 deferred: the *remaining* string-typed keys. The user has accepted **faithful-maximal** scope (ADR-346) — deviating from the prior design's faithful-minimal recommendation on all three judgement calls — so the eager guards that were "defer" candidates are now in scope and must be made concrete.

The enabler is already in place — this design does **not** redesign it:

- `src/application/commands/internal/valueless-config-guard.ts` — `assertNoValuelessConfig(ctx, section, subsection, keys)`: throws `CONFIG_MISSING_VALUE { key, source, line }` for the FIRST valueless key (by config-file line) among `keys` under `[<section> "<subsection>"]`; returns normally otherwise.
- `src/application/primitives/config-read.ts` — `findFirstValuelessEntry(ctx, section, subsection, keys)` (the cold-path re-tokenize behind the guard). It iterates **tokens in file order**, lower-cases section + key, and keeps the subsection **verbatim**, producing `qualifiedKey` as `${loweredSection}.${subsection}.${loweredKey}` (e.g. `branch.Main.merge`) — matching git's reported key exactly. It matches a section via `matchesSection` (`tokenSection.toLowerCase() === section.toLowerCase() && tokenSubsection === subsection`): **the subsection is an exact-match filter — there is no subsection-wildcard.** The merge layer erases every valueless string field to absent (ADR-315 D4: `if (value === null) continue`), so a `ParsedConfig` consumer cannot itself distinguish absent from valueless — the guard re-reads raw tokens on the cold path (ADR-327).
- `src/domain/commands/error.ts` — `configMissingValue(key, source, line)` + the `CONFIG_MISSING_VALUE` variant.

ADR-226 (prime directive) binds observable behaviour byte-for-byte; ADR-249 refines it: faithfulness binds the **data + on-disk state + refusal conditions**, not rendered stdout. The library emits the structured error carrying `{ key, source, line }`; each interop test reconstructs git's two display lines from those fields and diffs against real `git`.

### What the maximal scope forced us to re-pin

The four in-scope families are NOT four copies of 24.9l. Re-pinning the two accepted eager guards (ADR-348 `core`, ADR-349 `branch`) and re-verifying the lazy ones (ADR-347 `merge`, `pushUrl`) under an isolated environment uncovered **three architectural facts the prior matrix and two of the ADRs assumed away**:

1. **git's `branch.*` and `merge.*` dies scan ALL subsections, not the resolved one.** `git pull` dies on a valueless `branch.other.merge` while you are on `main` with no `[branch "main"]` at all (B7); a conflicting merge dies on a valueless `merge.custom.driver` with **no `.gitattributes` referencing `custom`** (M4). git loads the whole `[branch *]` / `[merge *]` table and dies on the first valueless key by file line. tsgit's consumers, by contrast, read only the *resolved* subsection (`config.branch?.get(currentBranch)`; `namedChoice` reached only when a `merge=<name>` attribute resolves). **A subsection-scoped guard is therefore unfaithful** — and `findFirstValuelessEntry`'s exact-subsection filter cannot express "any subsection". This is a real primitive gap (see Design §0).
2. **`pushUrl` dies even when a usable `url` is present.** Valued `url` + valueless `pushurl` → both `fetch` and `push` die (P5). The existing guard sits *inside* `if (url === undefined)`, which a valued url skips entirely — so the pushUrl extension is **not** a one-token list change; the guard must move to fire eagerly when the remote object is built.
3. **`core` path-likes have no non-`config` chokepoint that already exists.** git dies on every tsgit command except porcelain `config` (C5–C9), which both `readConfig` and `assertRepository` are reached by — so neither can host the guard (C2 forbids `config` dying). A *new* shared guard helper, called from each non-`config` command entry, is required.

The deliverable is the faithful matrix (kept + extended) and the concrete eager-guard placements it implies.

## Requirements

1. Every in-scope family gains a `CONFIG_MISSING_VALUE { key, source, line }` refusal reconstructing git's two lines (`error: missing value for '<key>'` / `fatal: bad config variable '<key>' in file '<F>' at line <N>`, exit 128). The library emits no rendered string (ADR-249).
2. **Ordering is file-position** (pinned): with several valueless candidate keys in scope, the refusal reports the FIRST by config-file line — what `findFirstValuelessEntry` already does. No key-priority / resolution-order rule (`pushurl ?? url`) governs *which key is reported* (P2/P3).
3. **The reported key matches git's case-folding** (pinned): section lower-cased, key lower-cased, subsection verbatim (`branch.Main.merge`, `core.excludesfile`, `remote.origin.pushurl`).
4. **Valueless ≠ absent ≠ empty-string.** Only a present-but-valueless (null) key refuses. An **absent** key keeps today's behaviour (`NO_UPSTREAM_CONFIGURED`, feature-off silent fallback); an **empty-string** key (`core.excludesFile = `) also keeps today's behaviour — git does NOT die on empty (C10). `findFirstValuelessEntry` already fires only on `value === null`, so empty/absent are correct by construction; tests pin all three.
5. **`submodule.*` is excluded**, with the matrix row proving git does not die (S1/S2).
6. **Porcelain reads stay faithful**: `config --get`/`--list`/`--type=bool` succeed on valueless keys (ADR-314, C2/C11) — the refusals live at command consumers only, never inside `readConfig` / `findFirstValuelessEntry` itself.
7. **The eager `core` and `branch`/`merge`-table guards must fire on the same command surface git dies on and no wider** — `core` on every non-`config` command (C5–C9); `branch` within `pull` before any network (B8); the merge-table guard only when a real 3-way content merge runs (M3/M4 lazy, not eager on `status`/`log`).

## Design

### Pinned git behaviour (git 2.54.0; `env -i`, isolated existing `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off) — authoritative

Fixtures written directly into `<tmp>/.git/config` (git's CLI cannot emit a valueless entry), then the real command run in a `mktemp -d` throwaway. The worktree's `.git/config` was spot-checked intact (`git config --get remote.origin.url` → `git@github.com:scolladon/tsgit.git`) after every write-probe batch.

| # | Config (in `.git/config`) | Command(s) | git stderr (two lines) | exit | Conclusion |
|---|---|---|---|---|---|
| B1 | `[branch "main"]` / `remote = origin` / `merge` (valueless, line 8) | `git pull`, `git pull origin main`, `git status` | `error: missing value for 'branch.main.merge'`<br>`fatal: bad config variable 'branch.main.merge' in file '.git/config' at line 8` | 128 | git dies on valueless `branch.<cur>.merge` |
| B2 | `[branch "main"]` / `remote` (valueless, line 7) / `merge = …` | `git pull`, `git status` | `… 'branch.main.remote'` … `at line 7` | 128 | dies on valueless `branch.<cur>.remote` |
| B3 | `[branch "main"]` / `remote` (line 5) / `merge` — both valueless, **remote earlier** | `git pull` | `… 'branch.main.remote'` … `at line 5` | 128 | first valueless **by file line** |
| B4 | `[branch "Main"]` / `Merge` (valueless, mixed case, line 5) | `git status` | `… 'branch.Main.merge'` … `at line 5` | 128 | **key lower-cased, subsection verbatim** |
| B5 | `[branch "main"]` / `merge` valueless | `git log -1`, `rev-parse`, `branch --list`, `commit`, `add`, `diff`, `show` | (no die — exit 0) | 0 | branch keys NOT read by non-tracking commands |
| B6 | `[branch "main"]` / `merge` valueless, **HEAD detached** | `git status` → 0; `git pull origin main` → 128; `git pull` → 128 | 0 / 128 | `status` reads only when HEAD is *attached*; `pull` reads `[branch *]` eagerly → dies even detached / explicit args |
| **B7** | `[branch "other"]` / `remote = origin` / `merge` (valueless, line 8); on `main`, **NO `[branch "main"]`** | `git pull`; `git status` | `… 'branch.other.merge'` … `at line 8` | 128 | **NEW — `pull`/`status` validate EVERY `[branch *]` section, not only the current one.** `status` dies because HEAD is attached (B6: detached → 0). The valueless key is in a section for a branch we are not on. |
| **B7b** | `[branch "zzz"]` / `merge` (line 7) + `[branch "main"]` / `merge` (line 9) — both valueless; on `main` | `git pull`; `git status` | `… 'branch.zzz.merge'` … `at line 7` | 128 | **NEW — across all sections, first valueless **by file line** wins (`zzz` reported though we are on `main`).** Confirms guard must scan ALL `branch.*` subsections, file-order. |
| **B8** | `[remote "origin"] url = /nonexistent` + `[branch "main"]` valueless `merge` (line 10) | `git pull`, `git pull origin main` | `… 'branch.main.merge'` … `at line 10` | 128 | **NEW — die is BEFORE any network** (url unreachable, yet the config error fires, not a connection error). The eager `pull` guard must run before `fetch`. |
| M1 | `.gitattributes` `f.txt merge=custom` + `[merge "custom"]` / `driver` (valueless, line 5) | `git merge <conflicting>` | `error: missing value for 'merge.custom.driver'`<br>`… at line 5` | 128 | git dies at a merge resolving `merge=custom` |
| M2 | `[merge "custom"]` / `driver = cat %A` / `name` (valueless, line 6) | `git merge <conflicting>` | `… 'merge.custom.name'` … `at line 6` | 128 | dies on valueless `name` too |
| M3 | `[merge "custom"]` / `driver` valueless | `git status`, `log -1`, `rev-parse`, `add`, `diff`; **fast-forward / no-content-merge merge** (only one side touched the file) | (no die — exit 0) | 0 | merge-driver table is **lazy** — read only when a real 3-way content merge runs for some path, NOT in `git_default_config`, NOT when no path is content-merged |
| **M4** | `[merge "custom"]` / `driver` valueless, **NO `.gitattributes` referencing `custom`** | `git merge <conflicting>`; **`git merge` where both sides edit a file on non-overlapping lines (auto-resolves)**; `git merge-tree --write-tree` | `… 'merge.custom.driver'` … `at line 7` | 128 | **NEW — ANY real 3-way content merge of a path dies, even when (a) NO path resolves `merge=custom` and (b) the merge AUTO-RESOLVES with no conflict.** The trigger is "a path enters content merge" (both sides changed it), not "a conflict occurs". git loads the WHOLE `[merge *]` table at content-merge time and dies on the first valueless `driver`/`name` by file line — independent of attribute resolution. `merge-tree` (no worktree) dies identically. |
| **M4b** | as M4 but the valueless `[merge "custom"]` removed | `git merge <conflicting>` | normal `CONFLICT (content)` | 1 | control — the die is the valueless driver, not the conflict |
| S1 | `.gitmodules` + `[submodule "sub"]` / `url` (valueless) | `git submodule status`/`init`/`sync`/`update --init`, `git status` | (no die) | 0 | **git does NOT die on valueless `submodule.<n>.url`** |
| S2 | `[submodule "sub"]` / `url = …` / `update` (valueless) | `git submodule status`/`init`/`update --init`, `git status` | (no die) | 0 | **git does NOT die on valueless `submodule.<n>.update`** |
| C1 | `[core]` / `excludesFile` (valueless, line 5) | `git status`, `add`, `log -1`, `rev-parse`, `cat-file -p HEAD` | `error: missing value for 'core.excludesfile'`<br>`… at line 5` | 128 | dies **eagerly** (`git_default_core_config` fires on nearly every command); key lower-cased |
| C2 | `[core]` / `excludesFile` valueless | `git config --get user.name`, `git config --list` | (no die) | 0 | porcelain config read bypasses the typed callback (ADR-314 parity) |
| C3 | `[core]` / `attributesFile` (valueless) | `git status`, `add`, `checkout .` | `… 'core.attributesfile'` … | 128 | dies eagerly |
| C4 | `[core]` / `hooksPath` (valueless) | `git commit` (hook-firing) | `… 'core.hookspath'` … | 128 | dies eagerly |
| **C5–C9** | `[core]` / `excludesFile` valueless | full tsgit-supported sweep: `status`, `add -A`, `log -1`, `rev-parse HEAD`, `rev-parse --git-dir`, `cat-file -p`, `commit`, `diff`, `show`, `checkout <f>`, `ls-files`, `branch --list`, `tag`, `reflog`, `stash list` | `… 'core.excludesfile'` … `at line 5` | 128 | **NEW — git dies on the ENTIRE tsgit command set. The only exceptions are porcelain `config --get`/`--list` (C2).** This is the eager-guard's exact command surface. |
| **C10** | `[core]` / `excludesFile = ` (empty value, has `=`); also `hooksPath = ` | `git status`, `log -1`, `rev-parse` | (no die) | 0 | **NEW — git does NOT die on an empty-string path-like; only valueless (null) dies.** The guard must fire on null, never on `''`. |
| **C11** | `[core]` / `excludesFile` valueless | `git config --list` / `--get user.name` | (no die) | 0 | **NEW — confirms the eager `core` guard must NOT live in `readConfig`/`assertRepository`, both of which `config` reaches.** |
| P1 | `[remote "origin"]` / `url = …` / `pushurl` (valueless, line 6) | `git push origin main` **AND** `git fetch origin` | `error: missing value for 'remote.origin.pushurl'`<br>`… at line 6` | 128 | `pushurl` read **eagerly with the remote object** — dies on fetch too, not just push |
| P2 | `[remote "origin"]` / `pushurl` (line 5) / `url` — both valueless, **pushurl earlier** | `git push origin main` | `… 'remote.origin.pushurl'` … `at line 5` | 128 | first valueless **by file line** |
| P3 | `[remote "origin"]` / `url` (line 5) / `pushurl` — both valueless, **url earlier** | `git push origin main` | `… 'remote.origin.url'` … `at line 5` | 128 | first by line — **NOT** a `pushurl ?? url` resolution order |
| P4 | `[remote "origin"]` / `pushurl` (valueless, no url) | `git push origin main` | `… 'remote.origin.pushurl'` … `at line 5` | 128 | pushurl-only valueless still dies |
| **P5** | `[remote "origin"]` / `url = /tmp/nonexistent` (valued) / `pushurl` (valueless, line 8) | `git push origin main` **AND** `git fetch origin` | `… 'remote.origin.pushurl'` … `at line 8` | 128 | **NEW — dies on valueless `pushurl` even when a USABLE `url` is present.** The die is independent of whether the remote resolves to a usable URL → the guard must fire eagerly, NOT on the `url === undefined` absent path. |
| — | any valueless key | `git config --list` / `--get` / `--type=bool` | succeed (ADR-314) | 0 | porcelain reads unchanged (consistency check) |

### §0 — The shared primitive gap the scan-all-subsections families need

`findFirstValuelessEntry`'s `subsection` argument is an **exact-match filter** (`matchesSection`: `tokenSubsection === subsection`). B7/B7b and M4 prove git scans **all** `branch.*` (resp. `merge.*`) subsections and reports the first valueless by file line. So the eager `branch` guard and the merge-table guard cannot be expressed as `assertNoValuelessConfig(ctx, 'branch', <one-subsection>, …)`.

**Resolution — add a subsection-wildcard scan to the existing primitive, reused by both eager families.** A new helper `findFirstValuelessInSection(ctx, section, keys)` (sibling of `findFirstValuelessEntry`) iterates the same token stream, matching **any** subsection of `section` (`tokenSection.toLowerCase() === section.toLowerCase()`, ignoring `tokenSubsection`), lower-casing the key and keeping the matched subsection verbatim in `qualifiedKey`. A thin `assertNoValuelessInSection(ctx, section, keys)` wraps it exactly as `assertNoValuelessConfig` wraps `findFirstValuelessEntry`. The existing exact-subsection helper is untouched (still used by `remote`/`pushurl`, which IS subsection-scoped — git reads only the named remote, P1–P5 are all `[remote "origin"]`). This is one small additive primitive, fully covered by the same `findFirstValuelessEntry` test shape; it carries no `ParsedConfig` change and no new error code.

### In-scope guard placements (faithful-maximal, ADRs 346–349)

#### 1. `remote.*.pushUrl` — eager guard at fetch + push (extends 24.9l's url guard) — ADR-346

The existing `['url']` guard sits **inside** `if (url === undefined)` (push L156-160; fetch L142-145). P5 disproves that placement for `pushurl`: a valued url skips the block, yet git still dies. So at **both** sites the guard moves to fire eagerly, right after the remote object is resolved, BEFORE the url-absent refusal:

```
const remote = config.remote?.get(remoteName)
await assertNoValuelessConfig(ctx, 'remote', remoteName, ['url', 'pushurl'])   // eager — fires even when url is valued
// …then the existing url-absent / pushUrl??url resolution unchanged
```

`findFirstValuelessEntry` reports the first valueless of the set by line — reproducing P1 (pushurl valueless, url valued → pushurl), P2 (pushurl earlier → pushurl), P3 (url earlier → url), P4 (pushurl-only). The subsection is the named remote (exact match — correct; git reads only that remote). Fetch's functional read is `url` only, but P1/P5 require fetch to *also* die on a valueless `pushurl` — so fetch's guard list includes `pushurl` even though fetch never uses that URL. The push comment "valueless `pushurl` is not yet in scope" is removed. The absent-url refusal (`REMOTE_NOT_CONFIGURED`) stays on its existing path; the empty-string-url branch (`remote.url === ''`) is unaffected (a valued-but-empty url is not valueless).

#### 2. `branch.*.merge`/`remote` — eager guard in `pull`, scanning ALL `[branch *]` — ADR-349

ADR-349 mandates the eager `pull`-scoped guard closing the explicit-args / detached gap. B7/B7b pin that the scan is **all subsections**, file-order; B8 pins it fires **before network**. So the guard is the FIRST config-touching step of `pull`, before `resolveUpstream` and before `fetch`:

```
export const pull = async (ctx, opts) => {
  await assertRepository(ctx); await assertNotBare(ctx,'pull'); await assertNoPendingOperation(ctx)
  await assertNoValuelessInSection(ctx, 'branch', ['merge', 'remote'])   // EAGER — all [branch *], before resolveUpstream/fetch
  const head = await readHeadRaw(ctx); … resolveUpstream(…) … fetch(…)
}
```

- **All-subsections** (`assertNoValuelessInSection`, §0) reproduces B7/B7b: a valueless `branch.other.merge` dies even on `main` with no `[branch "main"]`; with two valueless sections the first by file line is reported.
- **Before `resolveUpstream`'s `opts.ref`/`currentBranch` short-circuit and before `fetch`** reproduces B8 (die before network) and B1/B6 (dies on `pull origin main` and detached HEAD — the explicit-args/detached gap the refusal-path-only guard left open).
- **`status` and other tracking-aware commands are out of `pull`'s scope** (B5/B6: their reads are narrower; `status` dies only when HEAD is attached). ADR-349 is explicitly `pull`-scoped; extending the eager branch validation to `status` is a separate follow-up (Out of scope), matching git's observed `pull`-vs-`status` split.
- The **absent** case is unaffected: a fully-absent `[branch "<cur>"]` makes the guard return normally, and `resolveUpstream` still throws `NO_UPSTREAM_CONFIGURED` (B6 detached: no tracking → git doesn't read a present-null key → no die in tsgit either). Key set `['merge','remote']` bounds the candidates; file-line order (req 2) decides which is reported.

#### 3. `core.excludesFile`/`attributesFile`/`hooksPath` — eager guard on every non-`config` command — ADR-348

git dies on the entire tsgit command set except porcelain `config` (C5–C9), on null only (C10), and `config` reaches both `readConfig` and `assertRepository` (C11) — so neither read primitive can host the guard. The guard is a **new shared command-preamble helper**:

```
// src/application/commands/internal/valueless-config-guard.ts (sibling of assertNoValuelessConfig)
export const assertNoValuelessCoreConfig = (ctx) =>
  assertNoValuelessConfig(ctx, 'core', undefined, ['excludesfile', 'attributesfile', 'hookspath'])
```

`core` is a flat (no-subsection) section, so the **exact** `findFirstValuelessEntry(subsection=undefined)` is correct here — no wildcard needed. Placement:

- **The rule**: called from the top of **every command tsgit ships, except `config`** (which must stay non-throwing, C2/C11) **and the repo-creating `init`/`clone`** (no pre-existing config to validate; they build the `.git/config`). git dies on the whole non-`config` surface (C5–C9 sweep: `status`, `add`, `commit`, `log`, `show`, `diff`, `rev-parse` incl. `--git-dir`, `cat-file`, `checkout`, `ls-files`, `branch`, `tag`, `reflog`, `stash`, `merge`, …), so each entry carries the guard. The implement plan enumerates the shipped commands from the barrel (`src/application/commands/index.ts`) and the interop sweep pins one representative per command family; a command added later inherits the rule. Every command in scope already calls `assertRepository` (verified across the command set), so the guard slots in right after it.
- **NOT called from `config`** (C2/C11) — `config` is the one porcelain command git keeps non-throwing; the guard never sits in `readConfig`/`assertRepository`, both of which `config` calls.
- **null-only** (C10): `findFirstValuelessEntry` matches `value === null`, so an empty-string or absent `core.*` path-like falls through with no regression to the silent-miss feature consumers (`readGlobalExcludes`, `readGlobal` attributes, `resolveHooksDir`), which keep treating absent/empty as feature-off.
- Placed **at the top of each command's body**, after `assertRepository` (so a non-repo still gets `NOT_A_REPOSITORY` first — git also errors on no-repo before the config die) and before the command's real work — reproducing git's "dies on almost everything".

This is the largest blast radius in the PR. Because the guard is a single helper called from ~35 entry points, the implement plan slices it command-family by command-family with one interop row per representative command; the helper itself is one unit. A future refactor MAY hoist it into a shared command preamble, but that preamble does not exist today and inventing one is out of this PR's scope (Decisions §, note).

#### 4. `merge.*.driver`/`name` — lazy guard at the merge-driver-table load, scanning ALL `[merge *]` — ADR-347 (with a placement correction the pinning forces)

ADR-347 fixed the guard at `namedChoice` before the `return TEXT` fallback. **The pinning (M4) disproves that placement's faithfulness:** git dies on a valueless `merge.custom.driver` during ANY real 3-way content merge — including `merge-tree` and a conflicting merge with **no `.gitattributes` referencing `custom`**. tsgit's `namedChoice` is reached ONLY when a `merge=<name>` attribute resolves for a path (`driverFromMergeValue` → `namedChoice` only on the named branch). A `namedChoice`-only guard would therefore MISS git's die for every conflicting merge that does not carry a custom `merge=` attribute — the common case. It also reads only the *resolved* subsection, but M4 shows git scans the whole `[merge *]` table.

Two faithful placements are possible; both stay **lazy** (M3: only on a real content merge, never on `status`/`log`), honouring ADR-347's intent, but they differ in fidelity to M4:

- **(A) — table-scan at first content merge.** In `buildContentMerger` (the single `ContentMerger` every 3-way consumer routes through — confirmed: `merge` directly, `cherry-pick`/`revert`/`rebase`/`stash` via `apply-merge-to-worktree`), guard once, lazily, the first time the merger runs for a path:

  ```
  return async (mergeCtx) => {
    await ensureNoValuelessMergeDriver(ctx)   // once-latched; assertNoValuelessInSection(ctx,'merge',['driver','name'])
    … existing per-path resolve+dispatch …
  }
  ```

  This reproduces M1/M2/M4 exactly: any path entering content merge triggers the whole-table scan (all `[merge *]` subsections, first valueless by file line), with no dependence on attribute resolution. It stays lazy: `buildContentMerger` is *constructed* on every merge, but the returned closure (which holds the guard) is *invoked* only by `mergeTrees` per path that needs content merging — a fast-forward / no-content-merge merge invokes it for zero paths and never throws (M3). The latch makes the table scan run at most once per operation regardless of path count. This is the **faithful** option.

- **(B) — `namedChoice` only (ADR-347 as written).** Guard inside `namedChoice` before `return TEXT`, scanning the resolved `[merge "<name>"]` only. Faithful to M1/M2 (an attribute resolves the named driver) but **unfaithful to M4** (misses every content merge with no `merge=<name>` attribute — including auto-resolving merges). Smaller diff, but a known faithfulness gap.

ADR-347's original decision text named `namedChoice`; M4 was not in the matrix ADR-347 first saw. This load-bearing divergence between the accepted ADR and the pinned behaviour was escalated to the user and **resolved as option (A)**: ADR-347 is amended to "guard at the content-merge-table load in `buildContentMerger`, scanning all `[merge *]` subsections, once-lazily on the first content merge" — the lazy/merge-scoped intent is preserved; only the chokepoint moves up from `namedChoice` to the merger that calls it. **Placement (A) is therefore the implementation target**; option (B) is recorded only as the rejected alternative.

### Shared-helper vs separate verdict (ADRs 348/349 cross-reference)

The three eager/lazy validations split into **two reused primitives + three thin section-specific wrappers**, NOT one shared guard:

- **`branch` (eager, pull) and `merge` (lazy, content-merge)** share the new **all-subsections** scan `findFirstValuelessInSection` / `assertNoValuelessInSection` (§0) — both need "any subsection, first valueless by file line". They do NOT share a *call site* (one is `pull`'s preamble; the other is the content-merger), and their key sets differ (`['merge','remote']` vs `['driver','name']`), so each is a one-line wrapper over the shared scan.
- **`core` (eager, every command)** uses the **exact-subsection** `findFirstValuelessEntry(subsection=undefined)` via its own `assertNoValuelessCoreConfig` wrapper — `core` is flat, every-command, and must dodge `config`; it shares nothing with the per-subsection families beyond the underlying error + cold-path-reread mechanism.
- **`pushUrl`** stays on the existing exact-subsection `assertNoValuelessConfig` (the remote is named) — only its call site moves out of the `url === undefined` block and its key list gains `pushurl`.

So: **one new primitive (subsection-wildcard scan) shared by `branch`+`merge`; `core` and `pushUrl` keep the existing exact-subsection primitive.** No monolithic shared guard — the scopes (per-subsection-all vs flat-exact), call surfaces (pull / content-merge / every-command / fetch-push), and key sets are genuinely different, and forcing them into one helper would couple a pull-time check to a merge-time check to a per-command preamble.

### Error shape, detection mechanism, hexagonal placement — inherited

`CONFIG_MISSING_VALUE { key, source, line }` (ADR-328), cold-path re-read (ADR-327), guards in the application layer (ADR-329 pattern). The only *new* code beyond call sites is the subsection-wildcard scan primitive (§0) and the `assertNoValuelessCoreConfig` wrapper — both additive, no `ParsedConfig` change, no new error code, no public-type ripple.

### Source-path token (inherited from ADR-328)

`source` is tsgit's resolved **absolute** config path (`${commonGitDir}/config`). Each interop test normalizes the `file '<F>'` token to git's repo-relative `.git/config` before comparing; `key` and `line` compare verbatim (ADR-249: the path string is the caller's to render).

## Decisions (resolved by ADRs 346–349)

The scope and per-family approach are no longer open — they are fixed by the accepted ADRs. This subsection records the resolution and the **placements pinned by this revision**; there are no open candidates the user must pick from, except the one blocking ADR-347 amendment escalated below.

| Family | Resolution | Placement (pinned this revision) |
|---|---|---|
| Scope | **Faithful-maximal** (ADR-346) — guard every family git dies on that tsgit reaches, lazy + eager. `submodule.*` excluded (S1/S2). | — |
| `remote.*.pushUrl` | Extend the url guard to `['url','pushurl']` at fetch + push (ADR-346). | **Eager**, right after `config.remote?.get(remoteName)`, before the `url === undefined` refusal (P5). Exact-subsection (named remote). |
| `branch.*.merge`/`remote` | **Eager** in `pull`, closing the explicit-args/detached gap (ADR-349). | First config step of `pull` (after the repo/bare/pending asserts), **before `resolveUpstream` and `fetch`** (B8). **All `[branch *]` subsections** via the new wildcard scan (B7/B7b). |
| `core` path-likes | **Eager** reproducing `git_default_core_config` (ADR-348). | New `assertNoValuelessCoreConfig` helper called at the top of **every non-`config` command** (C5–C9), after `assertRepository`. Flat exact-subsection; null-only (C10); never in `readConfig`/`assertRepository`/`config` (C2/C11). |
| `merge.*.driver`/`name` | **Lazy** at the content-merge-table load (ADR-347, **amended**). | **RESOLVED → option (A).** The content-merge-table load in `buildContentMerger`, all `[merge *]` subsections, fired once-lazily on the first content merge (M4). ADR-347 amended from `namedChoice` to this chokepoint; `namedChoice` (option B) was unfaithful to M4. |

### Escalation RESOLVED (ADR-347 placement vs pinned M4)

The blocking item below was escalated to the user and **resolved as option (A)** — ADR-347's Decision is amended to the content-merge-table load in `buildContentMerger` (all `[merge *]` subsections, once-lazily on the first content merge). The amendment is recorded in `docs/adr/347-merge-driver-valueless-guard-at-resolution.md` (Status: amended). No code shipped under the original `namedChoice` placement, so this is a pure design-phase correction.

```
{ phase: design, status: RESOLVED → (A),
  reason: "ADR-347 fixed the merge-driver guard at `namedChoice` (reached only when a `merge=<name>` attribute resolves a path). Re-pinning under an isolated env (M4) shows git dies on a valueless `merge.*.driver`/`name` during ANY real 3-way content merge — including a conflicting `git merge` and `git merge-tree` with NO `.gitattributes` referencing the driver. A `namedChoice`-only guard misses the common no-attribute case, so the ADR-347 placement as written is unfaithful to the maximal scope it was accepted under.",
  chosen: "(A) Amend ADR-347: move the guard up to the content-merge-table load in `buildContentMerger` (the chokepoint all 3-way consumers route through), scanning ALL `[merge *]` subsections, fired once-lazily on the first content merge. Faithful to M1/M2/M4, preserves ADR-347's lazy/merge-scoped intent; needs the new wildcard scan (§0, already needed for `branch`)."
}
```

## Test strategy

Per ADR-329's proven shape. Each in-scope guard gets unit + interop coverage; assert `.data` fields **individually** via try/catch (never bare `toThrow(Class)`), one isolated test per guard condition (mutation-resistant, per project conventions). The new wildcard scan primitive (§0) gets its own unit tests mirroring `findFirstValuelessEntry`'s.

### Unit

- **`findFirstValuelessInSection` / `assertNoValuelessInSection` (new primitive)**: a valueless key in subsection A reported when A is the only section; with subsections A (line m) and B (line n>m) both valueless, **A reported** (file-order discriminator, killing a fixed-subsection mutant); a valueless key in a non-matching *section* not reported; an empty-string (`= `) key not reported (null-only); case-folding (section/key lower-cased, subsection verbatim). 200-run is overkill (not a parser); example tests only.
- **`pull` eager branch guard**: valueless `branch.<cur>.merge` → `CONFIG_MISSING_VALUE { key:'branch.<cur>.merge', line, source }`; valueless `branch.<other>.merge` while on `<cur>` with no `[branch "<cur>"]` → reports `branch.<other>.merge` (B7 — proves all-subsections, killing a current-branch-only mutant); two valueless sections, earlier-line reported (B7b discriminator); valueless `branch.<cur>.remote` → `.remote`; **fires before fetch** — drive `pull` with a stub fetch that records whether it was called, assert the guard throws and fetch was NOT invoked (B8 ordering, killing a "guard after fetch" mutant); absent tracking → still `NO_UPSTREAM_CONFIGURED` (regression, assert the code); valued tracking → resolves.
- **`push` / `fetch` eager pushUrl guard**: valueless `pushurl` with **valued url** → `{ key:'remote.<n>.pushurl', line }` on BOTH push and fetch (P1/P5 — the decisive "valued url still dies" test, killing a "guard inside url===undefined" mutant); both valueless, url earlier → `url`; both valueless, pushurl earlier → `pushurl` (P2/P3 discriminator pair); pushurl-only valueless → `pushurl` (P4); absent url+pushurl → still `REMOTE_NOT_CONFIGURED`; valued url, absent pushurl → resolves.
- **`core` eager guard (`assertNoValuelessCoreConfig`)**: valueless `excludesFile`/`attributesFile`/`hooksPath` each in isolation → `{ key:'core.excludesfile' | 'core.attributesfile' | 'core.hookspath', line }` (three isolated guard-condition tests); two valueless core path-likes, earlier-line reported; **empty-string `excludesFile = ` → no throw** (C10, killing an "any-core-key" mutant that ignores null); absent → no throw; representative non-`config` command (`status`) throws, `config` (`configList`/`configGet`) does NOT throw on the same fixture (C2/C11 — the porcelain-exemption test).
- **`merge` lazy guard (placement (A), resolved)**: conflicting 3-way merge with valueless `merge.<d>.driver`, **no attribute** → `{ key:'merge.<d>.driver', line }` (M4); valueless `name` (driver valued) → `.name` (M2); clean / fast-forward merge with the same valueless driver → no throw (M3 laziness); a cherry-pick/revert reaching the same content merger inherits the throw (one representative, others by shared-path note); valid driver → resolves.

### Interop (`test/integration/missing-value-refusal-interop.test.ts`, extend)

Mirror the existing valueless-identity interop: write the valueless line by `writeFile` into `<tmp>/.git/config`, run real `git` via `tryRunGit`/`runGit` into a tmpdir's `.git` (scrubbed env, `interop-helpers.ts`), capture exit 128 + the two stderr lines; run tsgit's command on the same repo; reconstruct git's two lines from `{ key, source, line }` (normalizing the `file '<F>'` token to repo-relative; `key`/`line` verbatim) and assert equality. Per in-scope family:

- `branch.<main>.merge` valueless → `git pull` vs tsgit `pull` (B1); valueless `branch.other.merge` on `main` → both die reporting `branch.other.merge` (B7); two valueless branch sections, earlier reported (B7b).
- `remote.origin.pushurl` valueless with **valued url** → `git push origin main` **and** `git fetch origin` (P5) vs tsgit `push`/`fetch`; both valueless, url earlier → `url` (P3); pushurl earlier → `pushurl` (P2).
- `core.excludesFile` valueless → representative tsgit command (`status`) vs `git status` (C1); `core.hooksPath` valueless → `commit` vs `git commit` (C4); **empty-string `core.excludesFile = ` → real `git status` exits 0 AND tsgit `status` does not raise** (C10 distinctness, documents valueless-vs-empty); **`config --list` on a valueless `core.excludesFile` succeeds in both** (C2/C11 porcelain exemption).
- `merge.custom.driver` valueless, **no attribute** → `git merge <conflicting>` vs tsgit `merge` (M4) — placement (A), per the amended ADR-347.
- **Distinctness controls**: `git config --list` on a valueless fixture **succeeds** in both; `submodule.*.url` valueless → real `git submodule update --init` exits 0 (S1) and tsgit does NOT raise `CONFIG_MISSING_VALUE` (documents the excluded family without regressing it).

### Property tests — DO NOT APPLY

Per the four-lens rule: these are **command-surface refusals**, not a parser/round-trip, matcher/aggregator, total-function-over-grammar, or idempotence/counting invariant. The new wildcard scan is `findFirstValuelessEntry`'s detection generalised to "any subsection" — example tests document the literal behaviour; the file-order detection is the existing tokeniser's, already tested. No `*.properties.test.ts` sibling is warranted.

## Out of scope

- **`submodule.*.url` / `.update`** — git does **not** die on a valueless value (S1/S2); excluded, not deferred. There is no faithful refusal to add.
- **`branch.*` eager validation on `status` and other tracking-aware commands** — B5/B6/B7 show `status` dies on a valueless `branch.*` key when HEAD is attached (any branch's section), but ADR-349 scopes this PR to `pull` (matching git's observed `pull`-vs-`status` split being driven by attach state). Extending the eager branch guard to `status` (and other attached-HEAD readers) is a tracked follow-up under the corrected B7 matrix; it is NOT silently added here.
- **`merge.*` placement** — pending the blocking escalation (ADR-347 amendment); if option (C) is chosen, the whole family defers.
- **A shared command preamble for `core`** — the eager `core` guard is called from ~35 entry points today because no shared "every command starts here" preamble exists. Building one is a structural refactor with its own blast radius; this PR calls the helper per-entry. A follow-up MAY hoist it.
- **Absent-config divergence** — tsgit's `NO_UPSTREAM_CONFIGURED`/`REMOTE_NOT_CONFIGURED`/`AUTHOR_UNCONFIGURED` on the wholly-absent case is a pre-existing, untouched divergence; no regression.
- **Int-typed valueless shape** — different message (`bad numeric config value '' … invalid unit`, single fatal line, no `at line N`); no int key merged today (ADR-329); blocked, its own future code.
- **Porcelain read surfaces** (`config --get`/`--list`/`--type=bool`) — already faithful via ADR-314 (C2/C11); explicitly kept non-throwing by placing every guard at command consumers, never in `readConfig`/`findFirstValuelessEntry`.
- **Writing valueless entries** — git's CLI cannot; not a surface (ADR-314/315 D5).
- **The byte-exact repo-relative `file '<F>'` token** — caller-side rendering (ADR-249); library emits its absolute resolved path in `source`; interop normalizes.
