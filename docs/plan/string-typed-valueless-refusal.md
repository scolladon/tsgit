# Plan — string-typed-valueless-refusal

> Source: design doc `docs/design/string-typed-valueless-refusal.md` · ADRs 346–349 (backlog 24.9r)
> The plan is the implementation script AND the knowledge handoff. Slice agents start with zero context.

## Surface check (no new public symbol)

- **No new error code.** Reuses `CONFIG_MISSING_VALUE` — already a member of the error union (`src/domain/commands/error.ts:130-135`), already wired into the exhaustiveness `switch` (`src/domain/error.ts:393-394`), already factory `configMissingValue(key, source, line)` (`src/domain/commands/error.ts:465-466`). No barrel/exhaustiveness/api.json change for the error.
- **No new Tier-1 command.** No barrel entry, no `Repository` facade method, no `docs/use/commands/*` page, no browser scenario, no README count bump, no `reports/api.json` regeneration. Confirmed: this change adds guards at existing command bodies plus internal helpers only.
- **New helpers are ALL internal** (consumed only within `src/`, never re-exported from `src/index*.ts`):
  - Slice 4 adds module-private functions inside `submodule.ts` (mode resolution). Not exported.
  - Slice 6 adds `assertNoValuelessCorePaths(ctx)` and `assertOperationalRepository(ctx)` to `src/application/primitives/internal/repo-state.ts`, re-exported through the existing shim `src/application/commands/internal/repo-state.ts` (which already re-exports `assertRepository`, `assertNotBare`, etc.). These are application-internal — the shim is NOT in `src/index*.ts`, so no public surface gate fires. Verified: `grep "repo-state" src/index.node.ts src/index.ts` returns nothing.
  - Slice 7 adds `assertNoValuelessHooksPath(ctx)` (or folds the work-doing `['hookspath']` gate into `assertOperationalRepository` via a parameter — slice 7 decides). Internal, same location, same shim.
- **`ParsedConfig` / `IniSection` / `api.json` unchanged** (ADR-327). `ParsedConfig.submodule[name].update` already exists (`config-read.ts:38`); slice 4 starts *reading* it but adds no field.

→ **No api.json change. No barrel change. No Tier-1 surface. No new error code.** Only internal helpers + guard calls + one behaviour change (slice 4).

## Shared enabler (reused verbatim by every slice — do NOT modify its behaviour)

- `assertNoValuelessConfig(ctx, section, subsection, keys)` — currently `src/application/commands/internal/valueless-config-guard.ts`; **slice 1 relocates it to `src/application/primitives/internal/valueless-config-guard.ts`** (see LAYERING BLOCKER below). Async; awaits `findFirstValuelessEntry`; throws `configMissingValue(found.key, found.source, found.line)` when a match exists, else returns. No-op for valued or absent entries. **Slice 6 must widen its JSDoc** (currently says "Call ONLY on a command's refusal path") to also document the eager pre-flight call pattern (ADR-346) — the runtime is unchanged, only the doc.
- `findFirstValuelessEntry(ctx, section, subsection, keys)` — `src/application/primitives/config-read.ts:122-150`. Cold re-tokenize of `${commonGitDir(ctx)}/config`; returns `{ key, source, line }` for the FIRST valueless (`value === null`) entry by file line among `keys` (lowercased compare), or `undefined`. Qualified key = `section.toLowerCase() + (subsection ? '.'+subsection : '') + '.' + key.toLowerCase()` (subsection verbatim). `line` is 1-based (`token.startLine + 1`). Used as-is for `section: 'core', subsection: undefined`.
- `configMissingValue(key, source, line)` — `src/domain/commands/error.ts:465`. `new TsgitError({ code: 'CONFIG_MISSING_VALUE', key, source, line })`.

### LAYERING BLOCKER — the guard must move to the primitives layer (handled in slice 1)

`dependency-cruiser` rule `primitives-cannot-import-commands` (`.dependency-cruiser.cjs:21-26`, severity **error**, runs under `npm run validate`) HARD-FORBIDS `src/application/primitives/**` from importing `src/application/commands/**`. Two slices need the guard from a primitive:
- **Slice 2** — `resolve-merge-driver.ts` is a **primitive** (`src/application/primitives/`).
- **Slice 6** — `primitives/internal/repo-state.ts` is a **primitive**.

The 24.9l guard lives at `src/application/commands/internal/valueless-config-guard.ts` (a command-layer location), so a primitive importing it violates the rule. **Resolution (folded into slice 1, the FIRST slice, so every later slice builds on the moved location): RELOCATE `assertNoValuelessConfig` to the primitives layer** — move it to `src/application/primitives/internal/valueless-config-guard.ts` (it already only depends on `findFirstValuelessEntry` (primitive) + `configMissingValue` (domain), both down-layer — the move is dependency-clean). Adjust its three down-layer relative imports for the new depth, and repoint the EXISTING command-layer importers to the new path (find them: `grep -rln valueless-config-guard src/` — currently `commit.ts`, `push.ts`, `fetch.ts`, and the guard's own file). Commands importing a primitive is the legal direction (`commands → primitives`). **Run `npx depcruise src/ --config .dependency-cruiser.cjs` after the move to confirm zero violations.** No public-surface impact (internal helper, not in `src/index*.ts`). From slice 1 onward, EVERY slice imports the guard from `src/application/primitives/internal/valueless-config-guard.js` — adjust the relative prefix per importer's location.

## Existing call-site idioms to copy (study before writing)

- **Refusal-path placement (commit identity)** — `commit.ts:97`: `await assertNoValuelessConfig(ctx, 'user', undefined, ['name', 'email']);` after `assertRepository`/`assertNotBare`, before the identity resolve.
- **Absent-path placement (push url)** — `push.ts:148-163` `resolveRemoteUrl`: reads config, computes `url = remote?.pushUrl ?? remote?.url`; on `url === undefined` calls `await assertNoValuelessConfig(ctx, 'remote', remoteName, ['url']);` THEN throws `remoteNotConfigured`. **Slice 5 REPLACES this** with a pre-resolution `['pushurl','url']` call.
- **fetch** — `src/application/commands/fetch.ts` near line 143 holds the sibling `['url']` guard (same pattern as push). Out of scope to change, but read it for the idiom.

## Interop test conventions (extend `test/integration/missing-value-refusal-interop.test.ts`)

Study the existing `user.name` (lines 76-200) and `remote.origin.url` (lines 253-490) blocks. Per in-scope key, mirror this five-part shape inside the existing `describe.skipIf(!GIT_AVAILABLE)('missing-value-refusal interop', …)`:

1. **git refusal pin** — write a hand-authored fixture (valueless key at a known line) into `${ours}/.git/config` via `writeFile`; run the pinned git command via `tryRunGit([...], { env: runGitEnv() })`; assert `g.ok === false`, `g.stderr` contains `missing value for '<key>'`, `bad config variable '<key>'`, `at line <N>`.
2. **tsgit structured pin** — same fixture; drive the facade (`repo.pull`/`repo.merge`/`repo.submoduleUpdate`/`repo.push`/`repo.status` etc.); `try/catch`; assert `data.code === 'CONFIG_MISSING_VALUE'`, `data.key`, `data.line`, `data.source` matches `/\/config$/` — each field individually (mutation-resistant; never bare `toThrow`).
3. **two-line reconstruction** — run both; split `g.stderr` on `\n`, find `error:`/`fatal:` lines; assert `errorLine === \`error: missing value for '${data.key}'\``; normalize git's path token with `.replace(/in file '[^']+'/, \`in file '.git/config'\`)` and assert equals the reconstructed `fatal:` line built from `{key,line}`.
4. **absent-vs-valueless distinctness** — fixture with the section present but key absent (or no section); assert tsgit throws the EXISTING absent-case code, NOT `CONFIG_MISSING_VALUE`.
5. **`--list` happy-path** — `tryRunGit(['config','--file',<fixturepath>,'--list'])` ok; tsgit `configList(ctx, {})` resolves (using `createNodeContext({ workDir: ours })` per the existing pattern at line 194).

**Isolation (ADR-337/338/339):** the helpers (`runGit`/`tryRunGit`/`runGitEnv`/`GIT_AVAILABLE`) from `./interop-helpers.js` already scrub `GIT_*`, set `GIT_CONFIG_NOSYSTEM=1`, isolate HOME, and disable signing. For `file://` submodules add `-c protocol.file.allow=always` to the git invocations and the equivalent allow to tsgit's clone path. **Heavy git-spawning blocks (merge driver, submodule) MUST share one `beforeAll` repo and use a 60s timeout** (project memory: interop times out hooks under validate's concurrency otherwise). The existing top-level block uses `beforeEach`/`afterEach` per-case tmpdirs (cheap fixtures); keep that for the light slices (1, 5, 6, 7) and add nested `describe` blocks with their own `beforeAll` + 60s for the heavy ones (2, 3, 4).

## Per-slice gate template (resolve `<touched-tests>`/`<touched-files>` per slice)

`npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`

## Ordering & cross-slice dependencies

Low-risk single-site guards first (1, 5), then heavier single-site guards (2, 3), then the behaviour-change slice (4), then the architecturally heavy core gates (6, 7). Slices share the one interop file `test/integration/missing-value-refusal-interop.test.ts` (sequential — same working tree, each appends its blocks). Slices 6 and 7 share the `assertOperationalRepository` chokepoint: **slice 6 creates it; slice 7 extends it** (declared in slice 7 Context). No other cross-slice code coupling.

---

## Slice 1 — `branch.<n>.{remote,merge}` valueless refusal in pull's resolveUpstream

### Context
- **FIRST: relocate the guard to the primitives layer** (see "LAYERING BLOCKER" above — this slice owns the move because every later slice depends on the new path). Move `assertNoValuelessConfig` from `src/application/commands/internal/valueless-config-guard.ts` to `src/application/primitives/internal/valueless-config-guard.ts`. Fix its relative imports for the new depth (`configMissingValue` from `../../../domain/commands/error.js`; `Context` type from `../../../ports/context.js`; `findFirstValuelessEntry` from `../config-read.js`). Repoint existing importers (`grep -rln valueless-config-guard src/`: `commit.ts`, `push.ts:51`, `fetch.ts`) to `'../primitives/internal/valueless-config-guard.js'`. Delete the old file. Run `npx depcruise src/ --config .dependency-cruiser.cjs` → zero violations. This is a behaviour-preserving move; no test should change behaviour (commit/push/fetch interop stay green).
- **File:** `src/application/commands/pull.ts`. Symbol: `resolveUpstream` (lines 75-89), an `async` arrow `(ctx, currentBranch, opts, fallbackRef) => Promise<Upstream>`.
- **Current body (verbatim):**
  ```
  const config = await readConfig(ctx);
  const tracking = currentBranch !== undefined ? config.branch?.get(currentBranch) : undefined;
  const remote = opts.remote ?? tracking?.remote ?? 'origin';
  const branch = opts.ref ?? shortMergeRef(tracking?.merge);
  if (branch === undefined) { throw noUpstreamConfigured(fallbackRef); }
  return { remote, branch };
  ```
- **Change (ADR-348, pre-resolution placement):** after `const config = await readConfig(ctx);`, and only when `currentBranch !== undefined`, call `await assertNoValuelessConfig(ctx, 'branch', currentBranch, ['remote', 'merge']);` BEFORE the `?? 'origin'` and `?? merge` fallbacks substitute. Place it before computing `remote`/`branch`. When `currentBranch === undefined` (detached HEAD) there is no `[branch "<n>"]` subsection to read, so skip the guard (no faithful death site).
- **Import (after the relocation):** add `import { assertNoValuelessConfig } from '../primitives/internal/valueless-config-guard.js';` to pull.ts (pull is a command; the path is `../primitives/internal/...`).
- **Why pre-resolution:** git dies on a valueless `branch.<n>.remote` EVEN THOUGH `'origin'` would otherwise default (pinned matrix row 2, "does NOT fall back to origin default"). The single multi-key `['remote','merge']` call preserves git's first-valueless-by-file-line ordering (design "Cross-key file-line ordering").
- **Scope (ADR-348):** guard `pull` ONLY. Do NOT touch `remote-config.ts` `listBranchReferrers` (~50-65) or `submodule.ts` `resolveBaseUrl` (~140-149); `status` computes no upstream tracking. These are documented divergences.
- **Absent-case code:** `noUpstreamConfigured(fallbackRef)` — `src/domain/commands/error.ts:360`, code `NO_UPSTREAM_CONFIGURED`. Imported at pull.ts:12.
- **Unit test file:** `test/unit/application/commands/pull.test.ts` (exists). Memory-context idiom: `createMemoryContext()` from `src/adapters/memory/memory-adapter.js`; seed config via `ctx.fs.writeUtf8(\`${ctx.layout.gitDir}/config\`, <text>)`; seed `.git/HEAD` as `ref: refs/heads/main\n` (see `resolve-merge-driver.test.ts:16-24` and `repo-state.test.ts:13-15` for the seed idiom). `pull` needs HEAD symbolic to compute `currentBranch`; call `resolveUpstream` indirectly via `pull` OR (preferred for guard isolation) test it through `repo.pull` failing fast at config read, before any network — the guard fires before `fetch`, so no transport mock is needed.
- **Interop:** add a light block (per-case `beforeEach` tmpdir, the top-level pattern). Pinned git command: `tryRunGit(['-C', ours, 'pull'], { env: runGitEnv() })` after `git init -b main` + a config fixture with a valueless `branch.main.remote` / `.merge`. tsgit: `repo.pull({})`. Fixture controls the line; HEAD on `main` so `branch.main` is the read subsection.

### TDD steps
1. **RED (unit, valueless remote isolated):** fixture config `[branch "main"]\n\tremote\n\tmerge = refs/heads/main\n` (remote valueless at a known line). `repo.pull({})` → expect `CONFIG_MISSING_VALUE { key: 'branch.main.remote', line: <N>, source: /\/config$/ }`. FAILS now: current code defaults `remote` to `'origin'`, reaches `noUpstreamConfigured` or proceeds — never `CONFIG_MISSING_VALUE`.
2. **RED (unit, valueless merge isolated):** fixture `[branch "main"]\n\tremote = origin\n\tmerge\n`. Expect `CONFIG_MISSING_VALUE { key: 'branch.main.merge', line: <N> }`. FAILS: current code sets `branch = undefined → noUpstreamConfigured`.
3. **RED (unit, file-line ordering — both valueless, both orders):** fixture A `[branch "main"]\n\tremote\n\tmerge\n` → expect key `branch.main.remote` (earlier line). Fixture B `[branch "main"]\n\tmerge\n\tremote\n` → expect key `branch.main.merge`. FAILS now.
4. **RED (unit, valued resolves):** fixture `[branch "main"]\n\tremote = origin\n\tmerge = refs/heads/main\n`; assert `repo.pull` does NOT throw `CONFIG_MISSING_VALUE` (it may throw a downstream network/ref error — assert the thrown code is not `CONFIG_MISSING_VALUE`, or stub fetch). Confirms guard no-ops on valued.
5. **RED (unit, absent → NO_UPSTREAM_CONFIGURED):** fixture with no `[branch "main"]` section; assert `repo.pull({})` throws `NO_UPSTREAM_CONFIGURED`, not `CONFIG_MISSING_VALUE`.
6. **GREEN (relocation):** perform the guard move + importer repoint + `depcruise` check FIRST; run `commit`/`push`/`fetch` interop to confirm the move is behaviour-preserving.
7. **GREEN (guard):** add the import + the single guard call in `resolveUpstream`.
8. **RED→GREEN (interop):** add the five-part block (git pin / tsgit pin / reconstruction / absent distinctness `NO_UPSTREAM_CONFIGURED` / `--list` ok) for `branch.main.remote`, plus one both-valueless file-line ordering interop pin.
9. **REFACTOR:** verify early-return for detached HEAD reads cleanly; no nesting >2.

### Gate
`npx depcruise src/ --config .dependency-cruiser.cjs && npx vitest run test/unit/application/commands/pull.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/pull.ts src/application/primitives/internal/valueless-config-guard.ts src/application/commands/commit.ts src/application/commands/push.ts src/application/commands/fetch.ts test/unit/application/commands/pull.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit
`feat(pull): refuse valueless branch upstream config`

---

## Slice 2 — `merge.<d>.{driver,name}` valueless refusal in namedChoice

### Context
- **File:** `src/application/primitives/resolve-merge-driver.ts`. Symbol: `namedChoice` (lines 29-38), `async (ctx, name) => Promise<MergeDriverChoice>`.
- **Current body (verbatim):**
  ```
  if (name === 'text') return TEXT;
  if (name === 'binary') return BINARY;
  if (name === 'union') return UNION;
  const driver = (await readConfig(ctx)).merge?.get(name);
  if (driver?.driver === undefined) return TEXT; // unconfigured / driverless → built-in text
  return driver.name === undefined
    ? { kind: 'external', command: driver.driver }
    : { kind: 'external', command: driver.driver, name: driver.name };
  ```
- **Change (ADR-349, pre-resolution placement):** after the three built-in early returns and BEFORE the `(await readConfig(ctx)).merge?.get(name)` typed read reaches the `driver?.driver === undefined → TEXT` fallthrough, insert `await assertNoValuelessConfig(ctx, 'merge', name, ['driver', 'name']);`. Built-in names (`text`/`binary`/`union`) return before the guard, so they never refuse. An absent `[merge "<name>"]` section makes the guard no-op (no matching entry) and the existing `driver?.driver === undefined → TEXT` still returns TEXT.
- **Import:** add `import { assertNoValuelessConfig } from './internal/valueless-config-guard.js';` — after slice 1's relocation the guard lives at `primitives/internal/`, and `resolve-merge-driver.ts` is in `primitives/`, so the path is `./internal/valueless-config-guard.js` (a same-tier primitive import — legal, no `primitives-cannot-import-commands` violation). This is exactly why slice 1 relocated the guard.
- **Why `['driver','name']` jointly:** git reads `.name` INDEPENDENTLY of `.driver` (pinned matrix row 4 + ADR-349 Neutral). A valueless `.name` under a selected driver refuses even when `.driver` is valued. Single multi-key call preserves file-line order.
- **`name` parameter = the driver subsection** (the `merge=<d>` attribute value), passed verbatim as the subsection.
- **Unit test file:** `test/unit/application/primitives/resolve-merge-driver.test.ts` (exists). Reuse the `seed(ctx, attrs, config)` helper (lines 16-24) and `choose(ctx, path)` (line 14). To trigger `namedChoice('mydriver')`, seed `.gitattributes` `* merge=mydriver\n` and a config `[merge "mydriver"]` block. Extend the existing describe tree with `Given merge=mydriver with valueless driver`, etc.
- **Interop (heavy — `.gitattributes` + a real conflicting content merge):** add a nested `describe` with its own `beforeAll` (shared repo) + 60s timeout. Build: a repo with `.gitattributes` `* merge=mydriver`, two branches that conflict on a file, config `[merge "mydriver"]` with valueless `driver`. Pinned git command: `git merge <branch>` (the content merge engages the driver). tsgit: `repo.merge({ rev: <branch> })`. The valueless death only fires when the driver is selected for a conflicting path.

### TDD steps
1. **RED (unit, valueless driver isolated):** `seed(ctx, '* merge=mydriver\n', '[merge "mydriver"]\n\tdriver\n')`; `choose(ctx, 'a.txt')` → expect `CONFIG_MISSING_VALUE { key: 'merge.mydriver.driver', line: <N> }` (try/catch + `.data`). FAILS now: `driver?.driver === undefined → TEXT`.
2. **RED (unit, valueless name isolated):** `seed(ctx, '* merge=mydriver\n', '[merge "mydriver"]\n\tdriver = mycmd\n\tname\n')`; expect `CONFIG_MISSING_VALUE { key: 'merge.mydriver.name', line: <N> }`. FAILS: name silently omitted today.
3. **RED (unit, file-line ordering both valueless, both orders):** driver-then-name fixture → `merge.mydriver.driver`; name-then-driver fixture → `merge.mydriver.name`.
4. **RED (unit, built-in name still TEXT):** `seed(ctx, '* merge=text\n')` and `* merge=binary`/`* merge=union`; assert no throw, returns the built-in choice. (Largely covered by existing tests — assert they still pass; the guard must not run for built-ins.)
5. **RED (unit, absent `[merge "mydriver"]` → TEXT):** `seed(ctx, '* merge=mydriver\n')` with no `[merge]` section; assert `choose` returns `{ kind: 'text' }`, no throw.
6. **RED (unit, valued driver+name resolves external):** `seed(ctx, '* merge=mydriver\n', '[merge "mydriver"]\n\tdriver = mycmd\n\tname = My Driver\n')`; assert `{ kind: 'external', command: 'mycmd', name: 'My Driver' }`.
7. **GREEN:** add import + the single guard call after the three built-in returns.
8. **RED→GREEN (interop):** add the heavy block (shared `beforeAll`, 60s) — git/tsgit pins for `merge.mydriver.driver`, reconstruction, absent distinctness (built-in `text` driver on absent section → merge proceeds), `--list` ok.
9. **REFACTOR:** confirm `namedChoice` stays <20 lines; no added nesting.

### Gate
`npx vitest run test/unit/application/primitives/resolve-merge-driver.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/resolve-merge-driver.ts test/unit/application/primitives/resolve-merge-driver.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit
`feat(merge): refuse valueless merge driver config`

---

## Slice 3 — `submodule.<n>.url` valueless refusal in submoduleUpdate

### Context
- **File:** `src/application/commands/submodule.ts`. Symbol: `submoduleUpdate` (lines 702-749).
- **Current consuming branch (verbatim, lines 717-721):**
  ```
  if (config.submodule?.get(row.name)?.url === undefined) {
    if (opts.init !== true) continue;
    await submoduleInit(ctx, { paths: [row.path] });
    config = await readConfig(ctx);
  }
  ```
- **Change (ADR-349, absent-path placement):** on the `config.submodule?.get(row.name)?.url === undefined` branch (before the `init`/`continue` decision at line 718), call `await assertNoValuelessConfig(ctx, 'submodule', row.name, ['url']);`. A valued url returns false from the `=== undefined` test and never reaches the guard; an absent url reaches the guard which no-ops (no matching entry) then keeps the existing `init`/skip behaviour. **NOTE:** slice 4 will combine this into `['url','update']` at the consuming read — slice 3 ships `['url']` alone; slice 4 refactors to the joint call. Keep slice 3's call shape easy for slice 4 to extend.
- **Import:** add `import { assertNoValuelessConfig } from '../primitives/internal/valueless-config-guard.js';` to submodule.ts (a command → primitive import; after slice 1's relocation). submodule.ts already imports `readConfig`/`ParsedConfig` from `../primitives/config-read.js` (line 32), same primitives tree.
- **Scope (ADR-349):** guard `submoduleUpdate` ONLY. Do NOT guard `submoduleInit`'s `existing` read (line 215, init-time gate) or `syncLevel` (line 295, `config.submodule?.get(row.name)?.url === undefined` is an initialised-gate that reads the url from `.gitmodules` via `row.url`, not config — pinned: `git submodule sync` does NOT die). These are out of scope per the design.
- **`submoduleUpdate` first lines:** `assertRepository`, `assertNotBare(ctx, 'submodule update')`, then reads `.gitmodules` rows, `validateUpdateModes`, `readIndex`, `readConfig`. The guard sits inside the per-row loop on the url-undefined branch.
- **Unit test file:** `test/unit/application/commands/submodule-update.test.ts` (exists). Study its memory-context fixture setup (`.gitmodules`, gitlink in index, `.git/config` `[submodule "<n>"]`). To reach the url-undefined branch with a valueless url, seed config `[submodule "mysub"]\n\turl\n` plus a `.gitmodules` row + a gitlink in the index for the path (so `pinned !== undefined` and the loop reaches the url check).
- **Interop (heavy — `file://` submodule):** nested `describe` with `beforeAll` shared repo + 60s + `-c protocol.file.allow=always`. Setup: an upstream sub repo (a couple commits) at a `file://` URL, a superproject recording the gitlink, `.gitmodules` declaring the submodule, and `.git/config` with a valueless `submodule.mysub.url`. Pinned git: `git submodule update` (the design pins `--init`; for the valueless-url row a registered-but-valueless config triggers the death without `--init`). tsgit: `repo.submoduleUpdate({})` or `submoduleUpdate(ctx, {})` via the facade. Reuse fixture scaffolding from `test/integration/submodule-init-sync-deinit-interop.test.ts` / `test/integration/submodules.test.ts` for the `file://` submodule helper shape. **This `beforeAll` submodule repo is REUSED by slice 4** — build it as a shared helper in the interop file so slice 4 extends it.

### TDD steps
1. **RED (unit, valueless url isolated):** seed `.gitmodules` + index gitlink + config `[submodule "mysub"]\n\turl\n`; call `submoduleUpdate(ctx, {})` → expect `CONFIG_MISSING_VALUE { key: 'submodule.mysub.url', line: <N> }`. FAILS now: url-undefined branch `continue`s (no `init`).
2. **RED (unit, valued url resolves):** config `[submodule "mysub"]\n\turl = file:///…\n`; assert `submoduleUpdate` does NOT throw `CONFIG_MISSING_VALUE` (proceeds to clone/reconcile — may need the `file://` source present or assert thrown code != CONFIG_MISSING_VALUE).
3. **RED (unit, absent url → existing skip/init behaviour):** config with `[submodule "mysub"]` but no `url`; `submoduleUpdate(ctx, {})` (no `init`) → no throw, submodule skipped (entry absent). Confirms guard no-ops on absent.
4. **GREEN:** add the import + `['url']` guard on the url-undefined branch.
5. **RED→GREEN (interop):** add the heavy block (shared `beforeAll` submodule repo). git/tsgit pins for `submodule.mysub.url`, reconstruction, absent distinctness (registered but no url → skip), `--list` ok.
6. **REFACTOR:** confirm the loop body stays readable; the guard is one awaited statement.

### Gate
`npx vitest run test/unit/application/commands/submodule-update.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/submodule.ts test/unit/application/commands/submodule-update.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit
`feat(submodule): refuse valueless submodule url config`

---

## Slice 4 — `submodule.<n>.update` becomes config-sourced (config over .gitmodules), then refuses valueless (BEHAVIOUR CHANGE)

> **Flagged: feature-behaviour-change slice.** The review battery (code/security/perf/tests) will scrutinize this. It is NOT pure refusal wiring — it adds git's config-over-gitmodules update-mode precedence.

### Context
- **File:** `src/application/commands/submodule.ts`. Symbol: `submoduleUpdate` (702-749). Mode resolution is line 722:
  ```
  const mode = opts.mode ?? updateModes.get(row.name) ?? 'checkout';
  ```
  where `updateModes` = `validateUpdateModes(rows)` (lines 104-117) reads update mode from `.gitmodules` rows (`row.update`). `config.submodule[<name>].update` is parsed into `ParsedConfig.submodule[name].update` (`config-read.ts:38`, populated by `mergeSubmodule` lines 1002-1023, which already skips valueless `update` via `if (value !== null)`) but **currently ignored**.
- **Pinned precedence (ADR-347, design matrix lines 109-118):** `opts.mode` (CLI) > config `submodule.<n>.update` > `.gitmodules` `submodule.<n>.update` > `checkout` default. Config overrides `.gitmodules` in BOTH directions (config `checkout` over gitmodules `none` performs the update; config `none` over gitmodules `checkout` is a no-op).
- **Change part 1 (behaviour):** introduce a config-mode read. Add a module-private helper (internal, not exported), e.g.:
  ```
  const resolveUpdateMode = (
    opts: SubmoduleUpdateOptions,
    config: ParsedConfig,
    gitmodulesMode: SubmoduleUpdateMode | undefined,
    name: string,
  ): SubmoduleUpdateMode => {
    const configRaw = config.submodule?.get(name)?.update;
    const configMode = configRaw === undefined ? undefined : parseUpdateMode(configRaw);
    if (configRaw !== undefined && configMode === undefined)
      throw invalidOption(\`submodule.${name}.update\`, \`invalid value '${configRaw}'\`);
    return opts.mode ?? configMode ?? gitmodulesMode ?? 'checkout';
  };
  ```
  Replace line 722 with `const mode = resolveUpdateMode(opts, config, updateModes.get(row.name), row.name);`.
  - `parseUpdateMode` — `src/domain/submodule/update-mode.ts:12`, `(raw) => SubmoduleUpdateMode | undefined` (valid set `checkout|rebase|merge|none`). `invalidOption` already imported (submodule.ts:13). The invalid-config-mode refusal mirrors `validateUpdateModes`' `.gitmodules` path (lines 110-113), so an invalid config update value throws the SAME `invalidOption` shape with key `submodule.<n>.update` — confirm against git's `fatal: invalid value for 'submodule.<n>.update'`.
- **Change part 2 (valueless guard):** because a valueless `submodule.<n>.update` parses to `value: null` (skipped by `mergeSubmodule`, so `config.submodule[name].update === undefined`), the typed read alone cannot distinguish valueless from absent. The guard catches it: extend slice 3's call on the url-undefined branch is NOT the right site (update is read for EVERY row, not only url-undefined). Place a guard at the new consuming read. **Combine with slice 3's `url` guard into one ordered call to preserve git's file-line order on co-occurrence** (design "Cross-key file-line ordering" + ADR-347 step 2): the design says co-occurring valueless `url`+`update` under one `[submodule "<n>"]` must report git's earlier-by-line key. Since slice 3 guards `url` only on the url-undefined branch and `update` is consumed unconditionally, the faithful shape is **one `assertNoValuelessConfig(ctx, 'submodule', row.name, ['url','update'])` call run unconditionally at the top of the per-row body, before both the url-undefined branch AND the mode resolution.** Slice 4 MOVES slice 3's `['url']` call to this joint `['url','update']` call at the row-body top, removing the narrower one. Verify: a valued url + valued update → no-op; the existing url-undefined branch logic and the new mode resolution run unchanged after the guard.
  - **Caution:** moving the url guard to the row-body top changes WHEN it fires relative to `init`. Confirm git's order: git validates the whole config before acting, so a valueless `url`/`update` dies before any per-row init. The row-body-top placement matches. Re-run slice 3's interop pins to confirm no regression.
- **Unit test file:** `test/unit/application/commands/submodule-update.test.ts` (exists). The precedence tests need a `.gitmodules` with `update = <mode>` AND a config `[submodule "<n>"]\n\turl = …\n\tupdate = <mode>\n`, plus an index gitlink at a pinned oid where checkout-mode moves HEAD and none-mode does not. Study the existing checkout/none update tests for the gitlink + child-context setup.
- **Interop (heavy — REUSE slice 3's shared `file://` submodule `beforeAll`):** add the precedence matrix block. Setup mirrors design lines 107-118: upstream sub at C1→C2, superproject recording `mysub@C2`, working submodule drifted to C1 (so `checkout` moves C1→C2, `none` leaves C1). Vary `.gitmodules` update vs `.git/config` update. Pinned git: `git submodule update` (no CLI mode). Assert tsgit's resulting submodule HEAD matches git's for each row of the matrix. Plus the valueless `submodule.mysub.update` row (git pin / tsgit pin / reconstruction / absent → `.gitmodules`-sourced mode / `--list` ok) and the `url`+`update` co-occurrence file-line ordering (both orders).

### TDD steps
1. **RED (unit, config checkout over gitmodules none → update performed):** `.gitmodules` `update = none`, config `update = checkout`, gitlink pin drifted; `submoduleUpdate(ctx, {})` → submodule HEAD moves to pin, `entries[0].mode === 'checkout'`, `changed === true`. FAILS now: code reads `.gitmodules` `none` → no-op.
2. **RED (unit, config none over gitmodules checkout → no-op):** `.gitmodules` `update = checkout`, config `update = none`; expect `mode === 'none'`, `changed === false`. FAILS now: code reads `.gitmodules` `checkout`.
3. **RED (unit, opts.mode over config):** config `update = none`, `opts.mode = 'checkout'` → update performed.
4. **RED (unit, config over gitmodules, gitmodules over default — isolated steps):** (a) config set, gitmodules unset → config mode; (b) config unset, gitmodules set → gitmodules mode; (c) both unset → `checkout`.
5. **RED (unit, invalid config update → invalidOption):** config `update = bogus`; expect `INVALID_OPTION` with key `submodule.<n>.update` (try/catch + `.data`). FAILS now: config update ignored, no validation.
6. **RED (unit, valueless update isolated):** config `[submodule "mysub"]\n\turl = file:///…\n\tupdate\n`; expect `CONFIG_MISSING_VALUE { key: 'submodule.mysub.update', line: <N> }`. FAILS now.
7. **RED (unit, url+update co-occurrence ordering, both orders):** url-then-update valueless → `submodule.mysub.url`; update-then-url valueless → `submodule.mysub.update`.
8. **GREEN:** add `resolveUpdateMode` helper, replace line 722, MOVE slice 3's `['url']` guard to a row-body-top `['url','update']` call.
9. **RED→GREEN (interop):** precedence matrix block (compare HEAD vs git) + valueless `update` row + co-occurrence ordering. Re-run slice 3's `url` interop pins (must still pass with the moved guard).
10. **REFACTOR:** `resolveUpdateMode` stays a small pure-ish function (<20 lines, early returns, no boolean params); confirm `submoduleUpdate` loop body did not grow nesting >2.

### Gate
`npx vitest run test/unit/application/commands/submodule-update.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/submodule.ts test/unit/application/commands/submodule-update.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit
`feat(submodule): source update mode from config with git precedence`

---

## Slice 5 — `remote.<n>.pushurl` valueless refusal (replace url-only guard with pre-resolution `['pushurl','url']`)

### Context
- **File:** `src/application/commands/push.ts`. Symbol: `resolveRemoteUrl` (lines 148-163), `async (ctx, remoteName) => Promise<string>`.
- **Current body (verbatim, lines 152-162):**
  ```
  const config = await readConfig(ctx);
  const remote = config.remote?.get(remoteName);
  // `pushurl` overrides `url` for push (canonical-git parity).
  const url = remote?.pushUrl ?? remote?.url;
  if (url === undefined) {
    // Only a valueless `url` reproduces git's lazy `missing value` die here; a
    // valueless `pushurl` is not yet in scope (no pinned matrix row for it).
    await assertNoValuelessConfig(ctx, 'remote', remoteName, ['url']);
    throw remoteNotConfigured(remoteName);
  }
  return url;
  ```
- **Change (ADR-349, pre-resolution placement):** REPLACE the existing `['url']`-only guard with a SINGLE `await assertNoValuelessConfig(ctx, 'remote', remoteName, ['pushurl', 'url']);` placed AFTER `const config = await readConfig(ctx);` and BEFORE `const url = remote?.pushUrl ?? remote?.url;`. Then the `if (url === undefined) throw remoteNotConfigured(remoteName);` keeps only the absent-case throw (drop the inner guard call and its stale comment). Remove the obsolete comment lines (157-158, "not yet in scope").
- **Why pre-resolution:** git dies on a valueless `pushurl` EVEN WHEN `url` is valued (pinned matrix rows 11-12; `pushurl ?? url` fallback does not save it). The guard must run before the fallback. For a single valueless `url` (the existing 24.9l row), file-line order with one match is identical, so the existing interop row stays green (ADR-349 Negative).
- **`assertNoValuelessConfig` import already present** in push.ts (slice 1 repointed it to `'../primitives/internal/valueless-config-guard.js'` during the relocation) — no import change in this slice.
- **Absent-case code:** `remoteNotConfigured(remoteName)` — `src/domain/commands/error.ts:357`, code `REMOTE_NOT_CONFIGURED`. Imported at push.ts:23 (`remoteNotConfigured`).
- **Unit test file:** `test/unit/application/commands/push.test.ts` (exists). Trigger `resolveRemoteUrl` via `repo.push({ remote: 'origin' })` (or `push(ctx, …)`) failing at config read before any transport. Memory-context: seed `.git/HEAD` + config.
- **Interop:** extend the EXISTING `remote.origin.url` block area in the interop file. Add: (a) valueless-pushurl-with-valued-url fixture (`[remote "origin"]\n\tpushurl\n\turl = https://x\n`) → `remote.origin.pushurl`; (b) both-valueless ordering (pushurl-then-url, url-then-pushurl) → earlier-by-line key; (c) re-verify the EXISTING 24.9l `url`-only row (lines 253-441) still asserts `remote.origin.url` — it must remain green (the test already exists; just confirm).

### TDD steps
1. **RED (unit, valueless pushurl with valued url):** config `[remote "origin"]\n\tpushurl\n\turl = https://x\n`; `repo.push({ remote: 'origin' })` → expect `CONFIG_MISSING_VALUE { key: 'remote.origin.pushurl', line: <N> }`. FAILS now: `url = remote.url` is valued, guard never runs.
2. **RED (unit, both valueless, both orders):** pushurl-then-url → `remote.origin.pushurl`; url-then-pushurl → `remote.origin.url`.
3. **RED (unit, valueless url only still refuses url):** config `[remote "origin"]\n\turl\n` → `CONFIG_MISSING_VALUE { key: 'remote.origin.url' }` (regression guard for the moved call).
4. **RED (unit, valued pushurl resolves, no throw):** config with valued `pushurl` + valued `url`; assert push does NOT throw `CONFIG_MISSING_VALUE` (proceeds to transport — assert thrown code != CONFIG_MISSING_VALUE or stub).
5. **RED (unit, absent → REMOTE_NOT_CONFIGURED):** config `[remote "origin"]` with no url/pushurl → `REMOTE_NOT_CONFIGURED`, not `CONFIG_MISSING_VALUE`.
6. **GREEN:** replace the `['url']` guard with the pre-resolution `['pushurl','url']` call; drop the stale comment + inner guard.
7. **RED→GREEN (interop):** add pushurl pins + both-orders ordering pin; confirm existing `url`-only block still green.
8. **REFACTOR:** `resolveRemoteUrl` reads cleanly; the `if (url === undefined)` now holds only the throw.

### Gate
`npx vitest run test/unit/application/commands/push.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/push.ts test/unit/application/commands/push.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit
`feat(push): refuse valueless remote pushurl config`

---

## Slice 6 — `core.excludesFile` / `core.attributesFile` eager BROAD gate across operational commands

> **Flagged: architecturally heavy.** Establishes the operational-vs-porcelain chokepoint that slice 7 extends. The Context block nails the exact insertion point so the implementer does not re-explore command routing.

### Context
- **The split (design "[core] eager-gate chokepoint", lines 146-166):** git validates `core.excludesfile`/`core.attributesfile` EAGERLY in `git_default_config` — they die on EVERY default-config-loading porcelain command (status, log, commit, add, diff, show, branch list, tag list, checkout, merge, …) INCLUDING config-free ref-listing — but the config porcelain (`config --get`/`--list`/`getRegexp`) SURVIVES (separate read path). tsgit must reproduce: operational commands refuse, `repo.config.*` does not.
- **Why a per-accessor guard is insufficient:** the lazy accessors are `readGlobalExcludes` (`src/application/primitives/internal/read-gitignore.ts:37-44`, valueless → `config.core?.excludesFile === undefined` → returns undefined) and `readGlobal` (`src/application/primitives/internal/read-gitattributes.ts:33-39`). But `tsgit log` (`log.ts`) and `tsgit branch.list`/`tag.list` touch NEITHER accessor (they go `assertRepository` → walk/ref-store primitives, no `readConfig`). A per-accessor guard would leave `tsgit log` succeeding where `git log` dies — an observable refusal-condition divergence (prime directive).
- **The chokepoint (verified):** every operational command calls `await assertRepository(ctx)` as its FIRST line (confirmed: status.ts:114, log.ts:43, branch.ts:60/96/121/138, tag.ts:45/64/88, commit.ts:73, add.ts:71, diff.ts:33, show.ts:104, checkout.ts:308, merge.ts:150, submodule.ts:203/287/378/426/609/706, …). `config.ts` ALSO calls the SAME bare `assertRepository` (imported from the `./internal/repo-state.js` shim). So a gate dropped into `assertRepository`'s body would gate the porcelain too — breaking git's bypass. **Therefore the gate cannot live in `assertRepository`; it needs a NEW entry the operational commands take and the porcelain does not.**
- **Source-of-truth file:** `src/application/primitives/internal/repo-state.ts` (the shim `src/application/commands/internal/repo-state.ts` re-exports from it; commands import via the shim). `assertRepository` is there (lines 23-30): a pure HEAD-existence check returning the repo root `FilePath`.
- **Decision (this slice creates):**
  1. Add internal `assertNoValuelessCorePaths(ctx)` to `primitives/internal/repo-state.ts`: `await assertNoValuelessConfig(ctx, 'core', undefined, ['excludesfile', 'attributesfile']);` (NOTE: `hookspath` is NOT in this broad set — slice 7 adds it on the narrower work-doing surface). Import `assertNoValuelessConfig` from `./valueless-config-guard.js` — after slice 1's relocation it is a SAME-DIRECTORY primitive (`primitives/internal/`), so the import is legal (no `primitives-cannot-import-commands` violation; this is the whole reason slice 1 moved it). `findFirstValuelessEntry` handles `section: 'core', subsection: undefined` → qualified key `core.excludesfile` lowercased (matches git, design line 124).
  2. Add internal `assertOperationalRepository(ctx)` to `repo-state.ts`: `await assertRepository(ctx); await assertNoValuelessCorePaths(ctx); return <root>;` — does the HEAD check AND the eager broad core gate, returns the same `FilePath` root as `assertRepository`. Re-export both through the shim `src/application/commands/internal/repo-state.ts`.
  3. **Switch the operational commands' first-line `await assertRepository(ctx)` to `await assertOperationalRepository(ctx)`.** Enumerate (cross-checked against the breadth matrix — every command git kills on `excludesfile`/`attributesfile`): `status`, `log`, `branch` (all 4 call sites), `tag` (all 3), `commit`, `add`, `diff`, `show`, `checkout`, `merge`, `stash`, `reset`, `rm`, `mv`, `blame`, `describe`, `name-rev`, `range-diff`, `whatchanged`, `shortlog`, `reflog`, `rev-parse`, `cherry-pick`, `revert`, `abort-merge`, `continue-merge`, `rebase`, `cat-file`, `read-file-at`, `fetch`, `fetch-missing`, `pull`, `push`, `remote`, `sparse-checkout`, `submodule` (all verbs), `worktree`. **DO NOT switch `config.ts`** — it MUST stay on bare `assertRepository` (the porcelain bypass). Cross-check `init.ts` (creates the repo; no default-config-load death — leave on bare or no assert).
  - **Pragmatic scope note:** the breadth matrix names a representative porcelain set. The interop matrix proves the gate on `status`/`log`/`commit`/`branch.list`/`tag.list` and proves `config.*` survives. The exhaustive command-switch is mechanical; the implementer switches every `assertRepository` first-line call EXCEPT `config.ts` (and `init.ts` if it has no death site). Each switched command keeps its existing `const root = await assertRepository(ctx)` return-value usage by reading the identical return from `assertOperationalRepository`.
- **JSDoc widening:** update `assertNoValuelessConfig`'s docstring (`valueless-config-guard.ts:5-11`) — the "Call ONLY on a command's refusal path" line is now false; add the eager pre-flight pattern (ADR-346). Runtime unchanged.
- **No public surface:** `assertOperationalRepository` / `assertNoValuelessCorePaths` are application-internal; not in `src/index*.ts`. No api.json/barrel change.
- **Test files:**
  - Unit: `test/unit/application/commands/internal/repo-state.test.ts` (exists; imports from the shim). Add describe blocks for `assertNoValuelessCorePaths` and `assertOperationalRepository`: valueless `excludesfile`/`attributesfile` each (isolated) → `CONFIG_MISSING_VALUE`; valued/absent `[core]` → no-op (HEAD check still returns root); confirm the porcelain bypass at the unit layer by asserting bare `assertRepository` does NOT throw on the valueless fixture. Seed config via `ctx.fs.writeUtf8(\`${ctx.layout.gitDir}/config\`, …)` + HEAD (existing `seedRepo` helper, line 13).
  - Interop: extend `missing-value-refusal-interop.test.ts`. **Breadth matrix block (load-bearing, ADR-346 test layer 6):** per key (`excludesfile`, `attributesfile`), valueless fixture → assert MULTIPLE operational commands die in BOTH git and tsgit — at minimum `repo.status()`, `repo.log()`, `repo.commit()`, `repo.branch.list()`/`repo.tag.list()` (the latter two prove the config-free ref-listing breadth) — each `CONFIG_MISSING_VALUE { key, line, source }`; and assert the config porcelain SURVIVES (`configList`/`configGet`/`configGetRegexp` ok with the valueless entry visible as `value: null`). Use the light per-case `beforeEach` tmpdir pattern (these are cheap — no submodule/merge fixtures).

### TDD steps
1. **RED (unit, valueless excludesfile via operational gate):** seed HEAD + config `[core]\n\texcludesfile\n`; `assertOperationalRepository(ctx)` → expect `CONFIG_MISSING_VALUE { key: 'core.excludesfile', line: <N> }`. FAILS: helper does not exist yet.
2. **RED (unit, valueless attributesfile isolated):** config `[core]\n\tattributesfile\n` → `core.attributesfile`.
3. **RED (unit, two core path-likes both valueless → earlier line):** `[core]\n\texcludesfile\n\tattributesfile\n` → `core.excludesfile`; reversed → `core.attributesfile`.
4. **RED (unit, valued/absent core → no-op):** config `[core]\n\texcludesfile = /x\n` and config with no `[core]`; `assertOperationalRepository` returns the root, no throw.
5. **RED (unit, porcelain bypass):** on the valueless `excludesfile` fixture, assert bare `assertRepository(ctx)` does NOT throw (returns root) — pins the split at the unit layer.
6. **GREEN:** add `assertNoValuelessCorePaths` + `assertOperationalRepository` to `primitives/internal/repo-state.ts`; re-export via the shim; widen the guard JSDoc.
7. **GREEN (command switch):** switch operational commands' first-line `assertRepository` → `assertOperationalRepository` (NOT `config.ts`). Run the full unit suite incrementally to catch any command relying on `assertRepository`'s return shape (it is identical).
8. **RED→GREEN (interop breadth matrix):** add the breadth block for `excludesfile` + `attributesfile`: status/log/commit/branch.list/tag.list die (both tools), config porcelain survives; reconstruction for one representative command; `--list` ok.
9. **REFACTOR:** confirm `assertOperationalRepository` is small and composes the two existing checks; no duplication across the switched commands.

### Gate
`npx vitest run test/unit/application/commands/internal/repo-state.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/repo-state.ts src/application/commands/internal/repo-state.ts src/application/commands/internal/valueless-config-guard.ts test/unit/application/commands/internal/repo-state.test.ts test/integration/missing-value-refusal-interop.test.ts`
(plus `biome check` over each switched command file the slice touched)

### Commit
`feat(config): refuse valueless core excludesfile/attributesfile eagerly`

---

## Slice 7 — `core.hooksPath` NARROW eager gate (work-doing commands only)

> **Flagged: architecturally heavy.** Extends slice 6's chokepoint with the narrower-breadth `hookspath` gate. Depends on slice 6 (`assertOperationalRepository` must already exist).

### Context
- **The narrower breadth (design lines 50, 99-104, 164; matrix lines 88-93):** `core.hooksPath` dies ONLY on work-doing commands (status, log, commit, add, diff, show, checkout, merge, and git's `check-ignore`/`check-attr`/`rev-parse --git-path hooks`) — but does NOT die on pure ref-listing (`branch` list, `tag` list, tsgit's `log` IS in git's hookspath death set per matrix line 81 — **note: git's `log` DIES on hookspath**; re-read matrix lines 75-93 carefully: `log` row = DIES for all three including hookspath; the OK rows for hookspath are `branch`/`tag`/`for-each-ref`/`ls-files`/`stash list`/`rev-parse HEAD`). So `hookspath` must NOT be in slice 6's broad pair (which fires on `branch.list`/`tag.list`), because `branch`/`tag` list SURVIVE a valueless `hookspath`.
- **Insertion decision (this slice):** `hookspath`'s validated surface = the work-doing subset, EXCLUDING pure ref-listing (`branch.list`, `tag.list`). Two viable shapes; the implementer picks and proves with the matrix:
  - **(A) Separate gate + selective call:** add internal `assertNoValuelessHooksPath(ctx)` = `await assertNoValuelessConfig(ctx, 'core', undefined, ['hookspath']);` to `primitives/internal/repo-state.ts`; call it from the work-doing commands only (status, log, commit, add, diff, show, checkout, merge, stash, reset, rm, mv, rebase, cherry-pick, revert, …) — i.e. every command in slice 6's switched set EXCEPT `branch` and `tag` (and any other pure ref-lister: `reflog`, `name-rev`, `describe`, `rev-parse HEAD` — cross-check each against matrix lines 88-93; the ref-listers that survive hookspath stay without the hookspath gate). Operationally: most work-doing commands can call a combined `assertOperationalRepository(ctx, { hooks: true })` while `branch`/`tag` call `assertOperationalRepository(ctx)` (no hooks). Adding a single optional `{ hooks?: boolean }` param to `assertOperationalRepository` (default false → broad pair only; true → broad pair + hookspath) is the lowest-divergence shape and keeps one entry point. **Beware boolean-param smell** (CLAUDE.md): prefer a named options object `{ hooks: true }` over a positional boolean.
  - **(B) Fold into `invokeHook`/index-touching path:** gate `hookspath` eagerly where hooks resolve (`run-hook.ts:55` `resolveHooksDir(config.core?.hooksPath, …)`). REJECTED: git dies on hookspath for `status`/`log`/`diff` which do NOT necessarily invoke a hook — under-refuses. Use (A).
- **Pre-chewed (A) implementation:** extend `assertOperationalRepository(ctx, opts: { hooks?: boolean } = {})`: after the broad `assertNoValuelessCorePaths`, when `opts.hooks === true` also `await assertNoValuelessConfig(ctx, 'core', undefined, ['hookspath']);`. Switch work-doing commands to `assertOperationalRepository(ctx, { hooks: true })`; leave `branch`/`tag` (and other ref-listers that survive per the matrix) on `assertOperationalRepository(ctx)`. `config.ts` stays on bare `assertRepository`.
  - **Co-occurrence note:** a fixture with valueless `excludesfile` AND `hookspath` under one `[core]`: on a work-doing command, both keys are in the validated set, so `findFirstValuelessEntry(['excludesfile','attributesfile','hookspath'])`-equivalent ordering must report the earlier line. Since (A) issues TWO separate `assertNoValuelessConfig` calls (broad pair, then hookspath), a valueless `excludesfile` earlier than `hookspath` is caught by the first call (correct); but a valueless `hookspath` EARLIER than `excludesfile` would be missed by the first call and caught by the second — still reports `hookspath`, the earlier key — CORRECT, because the first call finds no `excludesfile`/`attributesfile` match and the second finds `hookspath`. Only a case where BOTH a broad-pair key AND `hookspath` are valueless needs care: the first call reports the FIRST broad-pair match by line, even if a `hookspath` sits on an earlier line. To preserve git's strict file-line order across all three, the implementer MAY instead issue a SINGLE `assertNoValuelessConfig(ctx, 'core', undefined, ['excludesfile','attributesfile','hookspath'])` on the work-doing surface and the `['excludesfile','attributesfile']` pair on the ref-listing surface. **Prefer the single-combined-call-per-surface shape** (design lines 164, 172): work-doing surface validates all three in one call; ref-listing surface validates only the pair. This makes `assertOperationalRepository(ctx, { hooks: true })` issue ONE call over `['excludesfile','attributesfile','hookspath']`, and `{ hooks: false }` issue ONE call over `['excludesfile','attributesfile']`.
- **Test files:**
  - Unit: `test/unit/application/commands/internal/repo-state.test.ts`. Add: valueless `hookspath` → `assertOperationalRepository(ctx, { hooks: true })` throws `CONFIG_MISSING_VALUE { key: 'core.hookspath' }`; `assertOperationalRepository(ctx)` (hooks false) on the SAME valueless-hookspath fixture does NOT throw (the narrow split — ref-listing survives); valueless `excludesfile` throws on BOTH. This isolated pair pins the breadth split (CLAUDE.md guard-isolation).
  - Interop: extend the breadth matrix block. **`hookspath` narrower breadth (ADR-346 test layer 6, load-bearing):** valueless `hookspath` fixture → assert it DIES on work-doing commands (`repo.status`, `repo.commit`, and `repo.log` — `log` dies on hookspath per matrix) in BOTH git and tsgit, AND SURVIVES on ref-listing (`repo.branch.list()`, `repo.tag.list()`) in BOTH — matching the pinned matrix; config porcelain survives. A single combined-key gate on the full surface would fail the branch/tag-survive row — this pins the split-by-breadth wiring.

### TDD steps
1. **RED (unit, valueless hookspath via work-doing gate):** seed HEAD + `[core]\n\thookspath\n`; `assertOperationalRepository(ctx, { hooks: true })` → `CONFIG_MISSING_VALUE { key: 'core.hookspath', line: <N> }`. FAILS: gate ignores hookspath.
2. **RED (unit, hookspath survives ref-listing gate):** same fixture; `assertOperationalRepository(ctx)` (no hooks) → no throw, returns root. Pins the narrow split.
3. **RED (unit, excludesfile still dies on both):** valueless `excludesfile`; both `{ hooks: true }` and `{ hooks: false }` throw `core.excludesfile` (regression guard for slice 6).
4. **RED (unit, three-key file-line ordering on work-doing surface):** `[core]\n\thookspath\n\texcludesfile\n` → reports `core.hookspath` (earlier); reversed → `core.excludesfile`.
5. **GREEN:** extend `assertOperationalRepository` with the `{ hooks }` option (single combined call per surface); switch work-doing commands to `{ hooks: true }`, leave ref-listers on the bare-options call.
6. **RED→GREEN (interop hookspath narrow matrix):** hookspath dies on status/commit/log, survives on branch.list/tag.list (both tools); config porcelain survives; reconstruction for one work-doing command; absent hookspath → default hooks dir (no throw).
7. **REFACTOR:** confirm the `{ hooks }` option reads cleanly (named option, not positional boolean); the combined-key call keeps one detection path; no nesting >2.

### Gate
`npx vitest run test/unit/application/commands/internal/repo-state.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/repo-state.ts src/application/commands/internal/repo-state.ts test/unit/application/commands/internal/repo-state.test.ts test/integration/missing-value-refusal-interop.test.ts`
(plus `biome check` over each work-doing command file switched to `{ hooks: true }`)

### Commit
`feat(config): refuse valueless core hooksPath on work-doing commands`

---

## Phase-boundary note (for the implement phase, not a slice)

After slice 7, run the FULL `npm run validate` (not just touched-test gates) — slices 6/7 switch ~38 command entry points, so a green per-slice gate does not prove the whole suite. Any command whose existing tests assert on `assertRepository`'s return-value root must see the identical `FilePath` from `assertOperationalRepository` (it returns the same value); if a test mocks `assertRepository` directly it may need its mock pointed at the new entry — surface that as an in-slice fix, not a phase-boundary surprise.

## Flagged risk (escalate if hit during implement)

If, during slice 6/7, switching every operational `assertRepository` call proves to entangle commands whose breadth does NOT match git's (e.g. a command tsgit routes through `assertRepository` that git does NOT kill on a valueless `[core]` path-like — none found in the matrix, but the exhaustive switch may surface one), STOP and escalate `{ slice, reason, ≤3 options }` rather than silently narrowing the gate. The matrix (design lines 75-104) is the authority on which commands die; a tsgit command not in it that would now refuse is a divergence to flag, not absorb.
