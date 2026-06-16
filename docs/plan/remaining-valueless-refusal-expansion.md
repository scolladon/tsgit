# Plan — remaining-valueless-refusal expansion (E1/E2/E3)

> Source: design doc `docs/design/remaining-valueless-refusal.md` (§ `## Expansion (folded in by user request — E1/E2/E3)`) · ADRs `350` (E1 token cache), `351` (E2 shared preamble), none for E3 (faithfulness fix; git is the spec — matrix rows E3a–E3-all)
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema — `## Slice N` + `### Context` + `### TDD steps` + `### Gate` + `### Commit`.

## Surface-gate confirmation (read first — no public surface is tripped)

This PR-expansion adds NO new exported public symbol and changes NO public type:

- **E1** changes only the *internal* `config-read.ts` cache shape and adds an internal token accessor; `readConfig`/`findFirstValuelessEntry`/`findFirstValuelessInSection`/`invalidateConfigCache`/`__resetConfigCacheForTests` keep their current signatures and return types. `ParsedConfig` is unchanged.
- **E2** adds `assertCommandPreamble` to `src/application/primitives/internal/repo-state.ts` (re-exported through the existing `commands/internal/repo-state.ts` shim). Both are under `internal/` — NOT barrelled from `commands/index.ts`, NOT in `repository.ts`, NOT in `index.ts`/`index.node.js`. `assertNoValuelessCoreConfig` stays exported (still used by the preamble helper).
- **E3** fixes three internal primitive consumers (`readGlobalExcludes`, `readGlobal` attributes, `resolveHooksDir`); no new error code, no `ParsedConfig` change, no enum/switch.

Therefore: **do NOT run `npm run docs:json`**, no `reports/api.json` regeneration, no barrel/facade/README/doc-coverage/browser-scenario touch. If any slice finds itself editing `commands/index.ts`, `repository.ts`, `index.ts`, `index.node.js`, or `reports/api.json`, STOP — that is a sign the symbol leaked public and the plan is being violated.

## Sizing rules applied

- E1 is one slice (cache shape + finder reroute + new cache-reuse test all touch one file pair; behaviour-identity is proven by existing finder/guard tests passing unchanged).
- E2's 37-file / 67-call-site swap is split into **the helper slice + three family slices** so each diff is reviewable; the helper slice lands the helper and routes the read/inspect family, then mutation/integration/network families follow. Each family slice re-runs the representative throw tests already present per command (the safety net) — those are not standalone test slices, they are the per-slice gate.
- E3 is split per consumer family: `excludesFile`+`attributesFile` (identical `== '' → off` guard, share the interop file) in one slice, `hooksPath` (the special `absent ≠ empty` sentinel) in its own slice because its handling differs and needs the decisive E3c/E3c-dist interop. Tests fold into each slice.

## Sequence

E1 (Slice 1) → E2 (Slices 2–5) → E3 (Slices 6–7). E3 is independent of E1/E2 and may be reordered freely, but is placed last so the broad E2 file-touches land on a stable cache. Sequential slices share one working tree and build on each other.

---

## Slice 1 — E1: per-Context config token cache + finder reroute

### Context

**Goal (ADR-350):** stop `scanFirstValueless` from re-reading + re-tokenizing `.git/config` on every command. Cache the token stream alongside the parsed config in the one existing WeakMap, single source of truth, single invalidation point. **Behaviour-identical** — same `{ key, source, line }` for every input.

**File to touch:** `src/application/primitives/config-read.ts`.

Current shape (exact, as landed):
- `let cache: WeakMap<Context, Promise<ParsedConfig>> = new WeakMap();` (L52).
- `readConfig(ctx)` (L61–67): returns cached promise or calls `loadConfig(ctx)` and caches it.
- `__resetConfigCacheForTests()` (L70–72): `cache = new WeakMap();`.
- `invalidateConfigCache(ctx)` (L80–82): `cache.delete(ctx);`.
- `loadConfig(ctx)` (L84–89): `const path = ${commonGitDir(ctx)}/config; const raw = await readRawConfig(ctx, path); if (raw === undefined) return {}; return parseConfigText(raw, path);`.
- `readRawConfig(ctx, path)` (L91–98): `fs.readUtf8`, maps `FILE_NOT_FOUND` → `undefined`, rethrows other errors.
- `scanFirstValueless(ctx, section, keys, matchHeader)` (L120–152): **the reroute target.** Today it does its OWN `const path = ${commonGitDir(ctx)}/config; const raw = await readRawConfig(ctx, path); if (raw === undefined) return undefined; const tokens = tokenizeConfig(raw, path);` then walks `tokens` (header-match → first valueless `value === null` whose lowered key ∈ `keySet`, returning `{ key: qualifiedKey, source: path, line: token.startLine + 1 }`). The match/lower-case/verbatim-subsection walk MUST stay byte-identical.
- `findFirstValuelessEntry` (L162–172) and `findFirstValuelessInSection` (L183–190) call `scanFirstValueless` with their header-matchers — unchanged.
- `parseConfigText` (L245–248): `const sections = parseIniSections(text, source); return assembleParsed(sections);`.
- `parseIniSections` (L482–495) internally calls `tokenizeConfig(text, source)` to build sections — so the parser ALREADY tokenizes once; today the token array is discarded.
- `tokenizeConfig(text, source?)` (L318–319) returns `ReadonlyArray<ConfigToken>`. `ConfigToken` (L217–243) carries `kind`/`section`/`subsection`/`startLine`/`value` — the fields the scan needs. `ConfigToken` is already exported.

**Recommended cache shape (ADR-350 decision (a) — single WeakMap, `{ parsed, tokens, source }`):**
- Introduce an internal `interface ConfigCacheEntry { readonly parsed: ParsedConfig; readonly tokens: ReadonlyArray<ConfigToken>; readonly source: string; }` (do NOT export — internal).
- Change `cache` to `WeakMap<Context, Promise<ConfigCacheEntry>>`.
- Add internal `loadConfigEntry(ctx): Promise<ConfigCacheEntry>`: compute `path = ${commonGitDir(ctx)}/config` once, `raw = await readRawConfig(ctx, path)`; when `raw === undefined` return `{ parsed: {}, tokens: [], source: path }`; else tokenize once (`const tokens = tokenizeConfig(raw, path)`) and assemble parsed from those tokens. To avoid a second tokenize inside `parseIniSections`, refactor so the entry's `parsed` is built from the SAME `tokens` array — extract a `parseIniSectionsFromTokens(tokens)` (the loop currently in `parseIniSections` L486–494 that consumes `tokenizeConfig`'s output), then `parseIniSections(text, source)` becomes `parseIniSectionsFromTokens(tokenizeConfig(text, source))` (keep `parseIniSections` exported and behaviour-identical for its other callers and tests). `parsed = assembleParsed(parseIniSectionsFromTokens(tokens))`.
- Add an internal cache accessor `readConfigEntry(ctx): Promise<ConfigCacheEntry>` mirroring `readConfig`'s single-flight pattern (get-or-set on `cache`).
- `readConfig(ctx)` returns `readConfigEntry(ctx).then((e) => e.parsed)` — unchanged public contract (`Promise<ParsedConfig>`).
- `__resetConfigCacheForTests` and `invalidateConfigCache` operate on the one `cache` unchanged (clearing the pair as a unit — the load-bearing correctness property, constraint (b)).
- Reroute `scanFirstValueless`: replace its `readRawConfig` + `tokenizeConfig` head with `const { tokens, source } = await readConfigEntry(ctx);` then walk `tokens` exactly as today; reported `source` is `entry.source` (still `${commonGitDir}/config`), `line` still `token.startLine + 1`. A file-absent context now yields `tokens: []` → the walk returns `undefined` (preserving today's "no config → undefined").

**Keep `<20 lines` per function, early returns, immutable.** No `any`. `loadConfig` is removed or becomes a thin `.parsed` wrapper if any internal caller remains (check: only `readConfig` calls it — fold it into `readConfigEntry`).

**Safety net (existing, must pass UNCHANGED) in `test/unit/application/primitives/config-read.test.ts`:**
- `beforeEach(__resetConfigCacheForTests)` (L31–33). `seed(ctx, content)` writes `${gitDir}/config` (L26–28).
- Finder/guard blocks: the `findFirstValuelessEntry`/`findFirstValuelessInSection` cases (valueless detection, file-order, case-folding, empty/absent discriminators) and the `[core]`/`[remote]`/`[branch]`/`[merge]` valueless-key blocks (around L996–L3238).
- Cache-hit blocks already present: "second hits cache (fs.readUtf8 invoked once)" (L543), readConfig-twice (L560), explicit-reset re-read (L764, expects 2 reads), `invalidateConfigCache` re-read (L1511, expects 2) and the two-context isolation (L1530). These must STILL pass — they pin single-flight + invalidation, now over the entry.
- Existing `parseIniSections` direct-call tests (around L2824+) must pass unchanged after the `parseIniSectionsFromTokens` extraction.

**New cache-reuse test (the E1 proof):** a `Given a cached config entry, When a finder runs after readConfig on the same Context` block asserting `fs.readUtf8` for the config path is invoked **once** across `readConfig(ctx)` then `findFirstValuelessEntry(ctx, ...)` (or `assertNoValuelessCoreConfig` imported from `commands/internal/valueless-config-guard.js`). Pair with: after `invalidateConfigCache(ctx)`, the next finder re-reads (spy count 2). And the inverse order (finder first, then `readConfig`) also serves one read. Use `vi.spyOn(ctx.fs, 'readUtf8')` per the existing cache tests.

### TDD steps

- RED 1 — add the cache-reuse test (finder after `readConfig`, assert `readUtf8` called once). Fails today: the finder re-reads, so the spy is called twice (current behaviour). Expected failure: `expected 1, received 2`.
- RED 2 — add the post-invalidation re-read test (finder after `invalidateConfigCache`, spy count 2) and the finder-first-then-readConfig single-read test. RED 2's invalidation case may already pass; the finder-first case fails (two reads today).
- GREEN — implement `ConfigCacheEntry` + `readConfigEntry` + `parseIniSectionsFromTokens`; reroute `scanFirstValueless` to `readConfigEntry`; `readConfig` returns `.parsed`. Run the full `config-read.test.ts` — all existing finder/guard/cache/parse blocks pass unchanged; the new tests go green.
- REFACTOR — fold `loadConfig` into `readConfigEntry` (no dead duplicate), confirm no function exceeds 20 lines, no `any`, immutable entry. Run `get_diagnostics_for_file` on `config-read.ts`.

### Gate

`npx vitest run test/unit/application/primitives/config-read.test.ts test/unit/application/commands/internal/valueless-config-guard.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/config-read.ts test/unit/application/primitives/config-read.test.ts`

### Commit

`perf(config): cache the config token stream per-Context so guards reuse the parser's tokenize`

---

## Slice 2 — E2: shared command preamble helper + read/inspect family routing

### Context

**Goal (ADR-351):** introduce `assertCommandPreamble(ctx) = assertRepository(ctx) → assertNoValuelessCoreConfig(ctx)` and route the read/inspect command family through it. Behaviour-preserving: same two asserts, same repo→core order, same observable refusals.

**Where the helper lives:** add `assertCommandPreamble` to `src/application/primitives/internal/repo-state.ts` (the source-of-truth module; it already exports `assertRepository`, `assertNotBare`, `assertNoPendingOperation`, `isBare`, `readHeadRaw`). `assertNoValuelessCoreConfig` is in `src/application/commands/internal/valueless-config-guard.ts` — but `repo-state.ts` is in `primitives/`, and `valueless-config-guard.ts` is in `commands/`, so importing the guard into `repo-state.ts` would make a primitive depend on a command-layer module (wrong direction: `commands → primitives`). **Resolution:** define `assertCommandPreamble` in `src/application/commands/internal/repo-state.ts` (the commands-layer shim, which already re-exports the primitive asserts) — it is the natural commands-layer home, can import `assertNoValuelessCoreConfig` from the sibling `./valueless-config-guard.js` and `assertRepository` from `../../primitives/internal/repo-state.js`, and every command already imports its repo asserts from `./internal/repo-state.js`. This keeps the dependency direction correct and is the import the design's blast-radius note names (`from repo-state.js`).

Helper (in `src/application/commands/internal/repo-state.ts`, replacing the pure re-export shim with a module that re-exports AND adds the helper):
```
import { assertNoValuelessCoreConfig } from './valueless-config-guard.js';
import { assertRepository } from '../../primitives/internal/repo-state.js';
// ...keep the existing re-exports...
export const assertCommandPreamble = async (ctx: Context): Promise<void> => {
  await assertRepository(ctx);
  await assertNoValuelessCoreConfig(ctx);
};
```
Keep the existing re-export block (`assertNoPendingOperation`, `assertNotBare`, `assertRepository`, `isBare`, `readHeadRaw` from `../../primitives/internal/repo-state.js`). Import `Context` from `../../../ports/context.js`. `assertNoValuelessCoreConfig` stays exported from `valueless-config-guard.ts` (no removal).

**Routing pattern per command file:** each file today has
```
import { assertRepository, ... } from './internal/repo-state.js';
import { assertNoValuelessCoreConfig } from './internal/valueless-config-guard.js';
...
  await assertRepository(ctx);
  await assertNoValuelessCoreConfig(ctx);
```
Replace the pair with `await assertCommandPreamble(ctx);` and adjust imports: add `assertCommandPreamble` to the `./internal/repo-state.js` import; drop the now-unused `assertNoValuelessCoreConfig` import AND drop `assertRepository` from the repo-state import **only if the file uses it nowhere else** (several commands call `assertRepository` again or use its return value — keep it if still referenced; remove the `valueless-config-guard` import only if `assertNoValuelessCoreConfig` is unreferenced afterwards). Verify with Serena `find_referencing_symbols` / a grep for leftover uses before deleting an import.

**This slice's family — read/inspect (14 commands, one call-site each):**
`status.ts`, `log.ts`, `show.ts`, `diff.ts`, `rev-parse.ts`, `cat-file.ts`, `reflog.ts`, `blame.ts`, `describe.ts`, `name-rev.ts`, `range-diff.ts`, `read-file-at.ts`, `shortlog.ts`, `whatchanged.ts`.
(`status.ts` confirmed: `assertRepository` L115, `assertNoValuelessCoreConfig` L116; import L26–27.)

**Exempt — do NOT touch:** `config.ts`, `init.ts`, `clone.ts` (they keep bare `assertRepository`; `config` must NOT gain the core guard — porcelain exemption C2/C11).

**Safety net (existing per-command throw tests):** each of these commands already has a unit test asserting a valueless `core.*` makes it refuse with `CONFIG_MISSING_VALUE`. They now exercise the throw THROUGH `assertCommandPreamble` and must pass unchanged. Add the helper's own unit test by EXTENDING the existing `test/unit/application/commands/internal/repo-state.test.ts` (it already imports `assertRepository`/`assertNotBare`/`assertNoPendingOperation`/`isBare`/`readHeadRaw` from `commands/internal/repo-state.js` — top-level `describe('internal/repo-state')` L17 with per-symbol blocks `assertRepository` L18, `isBare` L57, `assertNotBare` L122, `readHeadRaw` L162, `assertNoPendingOperation` L277; `createMemoryContext()` builds the ctx). Add `assertCommandPreamble` to that import and a new `describe('assertCommandPreamble')` block under the same top-level describe: `Given a non-repo ctx, When assertCommandPreamble → throws NOT_A_REPOSITORY` (and the core guard is never reached — use a fixture where a valueless `core.excludesFile` is also present but no `HEAD`, assert the repo error wins, proving order); `Given a repo with valueless core.excludesFile → throws CONFIG_MISSING_VALUE { key: 'core.excludesfile' }` (assert `.data` fields via try/catch, not bare `toThrow`); `Given a clean repo → resolves`. Seed config via `ctx.fs.writeUtf8(${gitDir}/config, ...)`; a memory context has no `HEAD` by default (so `assertRepository` throws) — write `${gitDir}/HEAD` to make it a "repo" (mirror the existing `assertRepository` block's repo-vs-non-repo setup).

### TDD steps

- RED — write `repo-state.test.ts` for `assertCommandPreamble` (the three cases above). Fails: `assertCommandPreamble` does not exist (import error / undefined).
- GREEN — add `assertCommandPreamble` to `commands/internal/repo-state.ts`; tests go green.
- GREEN (routing) — swap the pair → `assertCommandPreamble(ctx)` in the 14 read/inspect files, fixing imports per file. Re-run each command's existing test file; all stay green (throw now routed through the preamble).
- REFACTOR — `get_diagnostics_for_file` on the helper module and a sampled command file; confirm no unused imports remain (biome `noUnusedImports`).

### Gate

`npx vitest run test/unit/application/commands/internal/repo-state.test.ts test/unit/application/commands/status.test.ts test/unit/application/commands/log.test.ts test/unit/application/commands/show.test.ts test/unit/application/commands/diff.test.ts test/unit/application/commands/rev-parse.test.ts test/unit/application/commands/cat-file.test.ts test/unit/application/commands/reflog.test.ts test/unit/application/commands/blame.test.ts test/unit/application/commands/describe.test.ts test/unit/application/commands/name-rev.test.ts test/unit/application/commands/range-diff.test.ts test/unit/application/commands/read-file-at.test.ts test/unit/application/commands/shortlog.test.ts test/unit/application/commands/whatchanged.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/repo-state.ts test/unit/application/commands/internal/repo-state.test.ts src/application/commands/status.ts src/application/commands/log.ts src/application/commands/show.ts src/application/commands/diff.ts src/application/commands/rev-parse.ts src/application/commands/cat-file.ts src/application/commands/reflog.ts src/application/commands/blame.ts src/application/commands/describe.ts src/application/commands/name-rev.ts src/application/commands/range-diff.ts src/application/commands/read-file-at.ts src/application/commands/shortlog.ts src/application/commands/whatchanged.ts`

### Commit

`refactor(commands): route read/inspect commands through assertCommandPreamble`

---

## Slice 3 — E2: route the mutation command family through the preamble

### Context

Same swap as Slice 2 (`assertRepository(ctx); assertNoValuelessCoreConfig(ctx)` → `assertCommandPreamble(ctx)`), same import-fix rules, same safety net. `assertCommandPreamble` already exists (Slice 2).

**This slice's family — local mutation commands:**
`add.ts` (1 site; pair at L72–73, imports L34), `commit.ts` (1), `rm.ts` (1), `mv.ts` (1), `reset.ts` (1), `checkout.ts` (1), `tag.ts` (3 call-sites — multiple entry points, swap each), `branch.ts` (1).

**Ordering to preserve:** `commit.ts` — the preamble must stay before the identity-resolution logic (the author/committer config reads), exactly where the pair sits today. `tag.ts`'s three entries each keep their own subsequent asserts (if any) after the preamble. For any file with extra asserts after the pair (e.g. `assertNotBare`), keep those AFTER `assertCommandPreamble`, unchanged in order.

**Multi-site caution (`tag.ts`):** swap ALL three `assertRepository(ctx); assertNoValuelessCoreConfig(ctx)` sequences; only drop the `assertNoValuelessCoreConfig`/`assertRepository` imports once no site references them. Verify each entry with a grep for residual `assertNoValuelessCoreConfig(ctx)` after editing (must be 0 in the file).

**Safety net:** existing per-command throw tests for each (valueless `core.*` → refuse) pass unchanged through the preamble. No new tests beyond Slice 2's helper test.

### TDD steps

- RED — none new (helper tested in Slice 2). The "RED" here is the regression guard: before editing, the existing per-command tests are green; they must stay green after the swap (a broken swap turns them red).
- GREEN — swap the pair in the 8 files (all `tag.ts` sites), fix imports. Run each command's test file; all green.
- REFACTOR — diagnostics on a sampled file; confirm no unused imports; confirm `commit.ts` preamble still precedes identity logic and `tag.ts` has 0 residual `assertNoValuelessCoreConfig(ctx)`.

### Gate

`npx vitest run test/unit/application/commands/add.test.ts test/unit/application/commands/commit.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/mv.test.ts test/unit/application/commands/reset.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/tag.test.ts test/unit/application/commands/branch.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/add.ts src/application/commands/commit.ts src/application/commands/rm.ts src/application/commands/mv.ts src/application/commands/reset.ts src/application/commands/checkout.ts src/application/commands/tag.ts src/application/commands/branch.ts`

### Commit

`refactor(commands): route mutation commands through assertCommandPreamble`

---

## Slice 4 — E2: route the integration/network/merge family through the preamble

### Context

Same swap and rules as Slices 2–3. `assertCommandPreamble` exists.

**This slice's family — fetch/push/pull/remote + merge-family (multi-entry) commands:**
`fetch.ts` (1), `fetch-missing.ts` (1), `push.ts` (1), `pull.ts` (1), `remote.ts` (1), `merge.ts` (1), `abort-merge.ts` (1), `continue-merge.ts` (1), `cherry-pick.ts` (4 sites), `revert.ts` (4 sites), `rebase.ts` (4 sites), `stash.ts` (4 sites).

**Load-bearing ordering — `pull.ts` (verified as landed, L96–100):**
```
await assertRepository(ctx);          // L96
await assertNoValuelessCoreConfig(ctx); // L97
await assertNotBare(ctx, 'pull');     // L98
await assertNoPendingOperation(ctx);  // L99
await assertNoValuelessInSection(ctx, 'branch', ['merge', 'remote']); // L100
```
becomes:
```
await assertCommandPreamble(ctx);                 // repo → core (L96–97 collapsed)
await assertNotBare(ctx, 'pull');
await assertNoPendingOperation(ctx);
await assertNoValuelessInSection(ctx, 'branch', ['merge', 'remote']);
```
Imports: `pull.ts` imports `assertNoPendingOperation`, `assertNotBare`, `assertRepository` from `./internal/repo-state.js` (L19–21) and `assertNoValuelessCoreConfig`, `assertNoValuelessInSection` (L25–26) — add `assertCommandPreamble` to the repo-state import, drop `assertNoValuelessCoreConfig` (now unused; `assertNoValuelessInSection` stays), drop `assertRepository` only if unreferenced elsewhere in `pull.ts` (it is reached only via the collapsed pair — confirm with grep). The combined assert sequence must remain repo → core → bare → pending → branch.

**`merge.ts`/`abort-merge.ts`/`continue-merge.ts`/`cherry-pick.ts`/`revert.ts`/`rebase.ts`/`stash.ts`:** each keeps its own `assertNotBare`/`assertNoPendingOperation` calls AFTER the preamble, unchanged in order. For the 4-site files, swap every site; drop the guard/`assertRepository` imports only when 0 residual references remain.

**`push.ts`/`fetch.ts` note:** the eager `pushUrl` guard (`assertNoValuelessConfig(ctx, 'remote', remoteName, ['url', 'pushurl'])`) is NOT the repo+core pair and is NOT touched by E2 — it stays exactly where it is (after `config.remote?.get(remoteName)`). Only the leading `assertRepository; assertNoValuelessCoreConfig` pair becomes `assertCommandPreamble`.

**Sparse note:** the design mentions sparse routing "via `assertSparseReady`'s internal call" — `sparse-checkout.ts` is covered in Slice 5 (it is not in this family list). Do not touch it here.

**Safety net:** existing per-command throw tests (valueless `core.*` → refuse) plus the `pull` branch-guard tests (valueless `branch.*` → refuse, fires before fetch) pass unchanged — the branch guard is untouched and still runs after the preamble.

### TDD steps

- RED — regression guard: existing tests for these commands are green pre-swap.
- GREEN — swap the pair in the 12 files (all multi-sites), fix imports, preserving `pull`'s repo→core→bare→pending→branch order and each merge-family command's post-preamble asserts. Run each command's test file; all green.
- REFACTOR — diagnostics on `pull.ts` + one merge-family file; grep each 4-site file for 0 residual `assertNoValuelessCoreConfig(ctx)`; confirm `pull` assert order.

### Gate

`npx vitest run test/unit/application/commands/fetch.test.ts test/unit/application/commands/fetch-missing.test.ts test/unit/application/commands/push.test.ts test/unit/application/commands/pull.test.ts test/unit/application/commands/remote.test.ts test/unit/application/commands/merge.test.ts test/unit/application/commands/abort-merge.test.ts test/unit/application/commands/continue-merge.test.ts test/unit/application/commands/cherry-pick.test.ts test/unit/application/commands/revert.test.ts test/unit/application/commands/rebase.test.ts test/unit/application/commands/stash.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/fetch.ts src/application/commands/fetch-missing.ts src/application/commands/push.ts src/application/commands/pull.ts src/application/commands/remote.ts src/application/commands/merge.ts src/application/commands/abort-merge.ts src/application/commands/continue-merge.ts src/application/commands/cherry-pick.ts src/application/commands/revert.ts src/application/commands/rebase.ts src/application/commands/stash.ts`

### Commit

`refactor(commands): route network and merge commands through assertCommandPreamble`

---

## Slice 5 — E2: route the worktree/submodule/sparse family + final-sweep verification

### Context

Same swap and rules. `assertCommandPreamble` exists. This slice closes E2 and verifies the full surface is consistent.

**This slice's family — remaining multi-entry/scoped commands:**
`worktree.ts` (4 sites), `submodule.ts` (6 sites), `sparse-checkout.ts` (1 site).

**Sparse ordering:** `sparse-checkout.ts` keeps any `assertSparseReady`/sparse-specific asserts after the preamble. The design notes sparse readiness has its own internal call — do not alter it; only collapse the leading repo+core pair.

**Multi-site (`worktree.ts` 4, `submodule.ts` 6):** swap EVERY `assertRepository(ctx); assertNoValuelessCoreConfig(ctx)` site; drop the guard/`assertRepository` imports only when 0 residual references remain in the file (grep each after editing — `submodule.ts` and `worktree.ts` may re-use `assertRepository` at other entry points, so keep the import if still referenced).

**Final-sweep verification (the E2 closure proof — run as part of the gate, not a separate slice):**
- `grep -rn 'assertNoValuelessCoreConfig(ctx)' src/application/commands/*.ts` returns ONLY the line inside `valueless-config-guard.ts` (the helper's own body, L48–49) and the line inside `commands/internal/repo-state.ts`'s `assertCommandPreamble` — i.e. ZERO remaining direct call-sites in command bodies.
- `config.ts`, `init.ts`, `clone.ts` still call bare `assertRepository` and do NOT call `assertCommandPreamble` (porcelain/repo-creating exemption intact). Confirm `config.ts` has no `assertCommandPreamble` import.

**Safety net:** existing per-command throw tests for `worktree`/`submodule`/`sparse-checkout` pass unchanged through the preamble.

### TDD steps

- RED — regression guard: existing tests green pre-swap.
- GREEN — swap the pair in the 3 files (all `worktree`/`submodule` sites), fix imports, keep sparse asserts after the preamble. Run the test files; all green.
- VERIFY — run the two greps above; assert 0 residual command-body call-sites and the three exemptions intact. (This is the E2-complete invariant.)
- REFACTOR — diagnostics on `submodule.ts`; confirm no unused imports.

### Gate

`npx vitest run test/unit/application/commands/worktree.test.ts test/unit/application/commands/submodule.test.ts test/unit/application/commands/sparse-checkout.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/worktree.ts src/application/commands/submodule.ts src/application/commands/sparse-checkout.ts`

### Commit

`refactor(commands): route worktree, submodule and sparse commands through assertCommandPreamble`

---

## Slice 6 — E3: empty-string core.excludesFile / attributesFile feature-off

### Context

**Goal (faithfulness fix; git is the spec — matrix E3a/E3b/E3a-ctrl):** a valued-but-EMPTY `core.excludesFile = ` / `core.attributesFile = ` (`value === ''`, NOT `null`) must be treated as **feature-off**, identical to absent — NOT resolved as a literal path. This is orthogonal to the valueless refusal (which fires null-only and is unchanged): empty is valued, so it does not refuse; it just must not be a path. No `ParsedConfig` change (the parser already keeps `''`; only `null` is dropped).

**File 1 — `src/application/primitives/internal/read-gitignore.ts`, `readGlobalExcludes` (L37–44):**
Current:
```
const config = await readConfig(ctx);
const raw = config.core?.excludesFile;
if (raw === undefined) return undefined;
const resolved = expandUserPath(ctx, raw);
...
```
The trap: `raw === ''` → `expandUserPath(ctx, '')` returns `''` → `loadCappedUtf8(ctx, '', ...)` → `lstat('')` → error instead of feature-off. Fix (E3a): widen the guard to `if (raw === undefined || raw === '') return undefined;` — the empty short-circuit returns the same `undefined` the absent branch returns, before `expandUserPath`/`lstat` can mis-resolve.

**File 2 — `src/application/primitives/internal/read-gitattributes.ts`, `readGlobal` (L33–39):**
Current:
```
const raw = (await readConfig(ctx)).core?.attributesFile;
if (raw === undefined) return undefined;
const resolved = expandUserPath(ctx, raw);
...
```
Identical fix (E3b): `if (raw === undefined || raw === '') return undefined;`. `readGlobal` feeds `buildAttributeProvider` (L67–96); an empty attributesFile yields no global source, no throw.

**Tests:**
- `readGlobalExcludes` — extend `test/unit/application/commands/internal/read-gitignore.test.ts` (the `describe('readGlobalExcludes')` block starts L154; existing cases: no key → undefined L155, absolute path loads L167, `~/` expand L189, `~/` no-home undefined L210). Add `Given core.excludesFile = '' (empty string)` → `When readGlobalExcludes` → `Then returns undefined` (no throw, no `lstat('')`). Seed `'[core]\n  excludesFile = \n'` via `ctx.fs.writeUtf8(${gitDir}/config, ...)`; `beforeEach`/`afterEach` reset the config cache (`__resetConfigCacheForTests`, already imported L8). Regression cases already present (absent → undefined, valued → loads) stay; assert empty is a distinct `it`.
- `readGlobal` (attributes) — extend `test/unit/application/primitives/internal/read-gitattributes.test.ts` (model: `seed(ctx, path, content)` L11; `merge(ctx, path)` L15 resolves an attribute through the provider). Add `Given core.attributesFile = '' (empty string)` → resolving an attribute yields the same result as no global file (no global source, no throw). Seed config `'[core]\n  attributesFile = \n'` into `${gitDir}/config` and a root `.gitattributes` if needed to prove the global is simply absent. Pair with a control: a valued `attributesFile` pointing at a real file still loads its rules.

Assert via direct value checks (`expect(sut).toBeUndefined()` / resolved-attribute equality) — no bare `toThrow`. Each guard condition (empty vs absent vs valued) is an isolated `it`.

### TDD steps

- RED — `readGlobalExcludes` empty-string test: today `excludesFile = ''` makes `loadCappedUtf8(ctx, '', ...)` → `lstat('')` throw (a `TsgitError`, not `undefined`). Expected failure: the test expects `undefined`, receives a thrown error.
- RED — `readGlobal` attributes empty-string test: same trap on `core.attributesFile`. Expected failure: thrown error / mis-resolved global instead of feature-off.
- GREEN — add the `|| raw === ''` short-circuit to both `readGlobalExcludes` and `readGlobal`. Tests go green; absent/valued regressions stay green.
- REFACTOR — `get_diagnostics_for_file` on both files; functions stay `<20` lines (one-line guard widen). Confirm the empty guard returns the SAME `undefined` as absent (no new branch beyond the `|| === ''`).

### Gate

`npx vitest run test/unit/application/commands/internal/read-gitignore.test.ts test/unit/application/primitives/internal/read-gitattributes.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/read-gitignore.ts src/application/primitives/internal/read-gitattributes.ts test/unit/application/commands/internal/read-gitignore.test.ts test/unit/application/primitives/internal/read-gitattributes.test.ts`

### Commit

`fix(config): treat empty core.excludesFile/attributesFile as feature-off, matching git`

---

## Slice 7 — E3: empty-string core.hooksPath = no hook fires (absent ≠ empty)

### Context

**Goal (faithfulness fix; matrix E3c/E3c-dist — the DECISIVE distinctness):** an empty `core.hooksPath = ` must make `runHook` find **no hook** (commit succeeds, no hook fires), and it must NOT collapse to the default `${gitDir}/hooks` dir (absent → default fires; empty → nothing fires) and NOT to `${workDir}/` (a CWD `./pre-commit` must NOT fire either). This is the one path-like where `absent ≠ empty`. No `ParsedConfig` change.

**File — `src/application/primitives/internal/run-hook.ts`, `resolveHooksDir` (L19–30):**
Current:
```
const fallback = `${layout.gitDir}/${HOOKS_SUBDIR}`;
if (hooksPath === undefined) return fallback;           // absent → default dir (hooks fire) — KEEP
if (hooksPath.startsWith('~/')) { ... }
if (isAbsolutePath(hooksPath)) return hooksPath;
return `${layout.workDir}/${hooksPath}`;                // '' would yield `${workDir}/` (wrong — CWD)
```
The trap: `hooksPath === ''` → `'' === undefined`? no; `''.startsWith('~/')`? no; `isAbsolutePath('')`? no → returns `` `${layout.workDir}/` `` (the worktree root — wrong; a `./pre-commit` there could fire). Fix (E3c): add a `hooksPath === ''` branch BEFORE the relative fallback that resolves to a directory guaranteed to hold no hook scripts, so the runner's `${hooksDir}/${name}` stat fails → `skipped` → no hook fires.

**Runner contract that makes the sentinel work (verified):** the hook runner resolves `${hooksDir}/${name}` and stats it; `NodeHookRunner.isRunnable` (`node-hook-runner.ts` L106–118) returns `false` when `stat` throws (absent/non-file) → `run` returns `{ kind: 'skipped' }` (L98); `MemoryHookRunner.run` returns the mapped outcome or `SKIPPED` for an unmapped hook (`memory-hook-runner.ts` L25–28). `runHook` (`run-hook.ts` L71–81): `skipped` → returns (no throw). So a `hooksDir` under which `${hooksDir}/pre-commit` cannot resolve to an executable yields "no hook fires" — exactly E3c. The exact sentinel value (e.g. a path under `${gitDir}` that is a file, or a reserved sub-path that cannot contain executables) is an implementation detail the slice PINS against the E3c interop below; the binding constraint is: **`resolveHooksDir('', layout)` must NOT equal `${gitDir}/hooks` (default), must NOT equal `${workDir}/` (CWD), and `${resolved}/pre-commit` must not resolve to a runnable hook.**

**Tests:**
- Unit — extend `test/unit/application/primitives/run-hook.test.ts` (existing `describe('primitives/run-hook resolveHooksDir')` L20; `layout(overrides?)` helper builds a `RepositoryLayout`; cases: undefined → `<gitDir>/hooks` L21, absolute verbatim, `~/` expand, relative → `<workDir>/...`). Add `Given an empty-string hooksPath` → `When resolveHooksDir` → `Then it does NOT return <gitDir>/hooks and does NOT return <workDir>/` (assert the sentinel is distinct from both via two `expect(...).not.toBe(...)` plus an `expect(sut).toBe(<sentinel>)` pinning the chosen value). Pair with the runtime proof in the `runHook` describe block (L103): `Given a Context with hooksPath = '' and a runner mapping pre-commit to exit 1` → `When runHook('pre-commit')` → `Then it resolves without throwing` (no hook fires) — seed config `'[core]\n\thooksPath = \n'`, build ctx with a `MemoryHookRunner`; because the resolved `hooksDir` is the no-hook sentinel, the memory runner is invoked with that `hooksDir` (assert via `runner.calls[0].hooksDir` it is NOT the default) and the outcome is "no throw". Control: `Given hooksPath undefined (UNSET) and a pre-commit mapped to exit 1` → `runHook` THROWS `HOOK_FAILED` (default dir fires — E3c-dist) — this proves absent ≠ empty.
- Interop — extend `test/integration/missing-value-refusal-interop.test.ts` (the file already houses the valueless-core interop; helpers `initRepo`, `stageFile`, `tryRunGit`/`runGit`, `runGitEnv`, `openRepository`, `writeFile` into `${ours}/.git/config`; the `VALUELESS_CORE_HOOKSPATH_FIXTURE` block is at L1085, the empty-excludes block at L1184). Add a `Given a config with an empty-string core.hooksPath and a blocking pre-commit hook` block:
  - write `'[core]\n\trepositoryformatversion = 0\n\thooksPath = \n'` into `${ours}/.git/config`, create an executable `.git/hooks/pre-commit` that `exit 1`s (chmod +x), stage a file;
  - real `git commit` → **exit 0** (hook does NOT fire — E3c) via `tryRunGit(['-C', ours, 'commit', '-m', 'x'], { env: runGitEnv() })`, assert `g.ok === true`;
  - tsgit `repo.commit({ message: 'x' })` → resolves (commit succeeds), assert no throw and an actual commit object is produced;
  - CONTROL (E3c-dist): UNSET hooksPath (no `hooksPath` line) + the same blocking pre-commit → real `git commit` BLOCKED (exit 1) AND tsgit `commit` throws `HOOK_FAILED` — the hook fires when absent.
  Use a node `pre-commit` shim that runs cross-platform (the interop file is node-run; the existing hooks-e2e tests under `test/integration/posix-only/` are the model for executable-hook creation — write `#!/bin/sh\nexit 1\n`, `chmod 0o755`). If the executable-bit hook is POSIX-only, gate the interop hook rows behind the same `posix-only` guard the repo already uses rather than failing on Windows CI.

Assert via direct value/`.data` checks (no bare `toThrow(Class)`); empty vs absent are separate `it`s (the decisive discriminator).

### TDD steps

- RED — `resolveHooksDir('', layout())` unit test expecting the sentinel (not default, not `${workDir}/`): today returns `` `${workDir}/` `` → fails the `.not.toBe(${workDir}/)` assertion.
- RED — `runHook` empty-hooksPath test expecting no throw with a blocking pre-commit mapped: today resolves to `${workDir}/` and (if a `pre-commit` is reachable there) could fire; at minimum the `hooksDir` assertion (`not.toBe` default) drives the sentinel. The UNSET control already passes (proves the default path).
- GREEN — add the `hooksPath === ''` sentinel branch to `resolveHooksDir`; unit tests go green. Run the interop empty-hooksPath + UNSET-control rows; both pass (empty → exit 0 / no throw; unset → blocked / `HOOK_FAILED`).
- REFACTOR — `get_diagnostics_for_file` on `run-hook.ts`; `resolveHooksDir` stays `<20` lines (one added early-return branch); confirm the sentinel is a named constant if non-trivial (no magic value).

### Gate

`npx vitest run test/unit/application/primitives/run-hook.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/run-hook.ts test/unit/application/primitives/run-hook.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit

`fix(hooks): treat empty core.hooksPath as no-hooks-dir, distinct from absent, matching git`
