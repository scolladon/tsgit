# Plan — valueless-config-followups

> Source: design doc `docs/design/valueless-config-followups.md` · ADRs `351`, `352` (C has none — faithfulness fix, new backlog 24.9w)
> The plan is the implementation script AND the knowledge handoff. Slice agents start
> with zero context: whatever a slice block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.
>
> Three independent deltas, sequenced A → B → C-readers → C-hooks. They share one
> working tree and build on each other (B's wildcard finder consumes A's cached
> tokens). Landing on current `main` (#179's base).
>
> **Public-surface decision (up front, binding):** the one new exported symbol,
> `findFirstValuelessInSection` (Slice 2), is **INTERNAL** — consumed only by
> `build-content-merger.ts`, a sibling in `src/application/primitives/`, via a
> relative `./config-read.js` import. It is **NOT** added to
> `src/application/primitives/index.ts`. Therefore **no `reports/api.json` regen**
> and **no `check:doc-typedoc` surface gate** is tripped (typedoc documents the
> primitives barrel; a non-barrelled export is invisible to it). No `ParsedConfig`
> shape change, no new error code (`CONFIG_MISSING_VALUE` pre-exists). ADR-352
> mandates the merger import the domain error `configMissingValue` directly rather
> than a command-layer wrapper, so no `assertNoValuelessInSection` guard wrapper is
> introduced.

## Sizing rules

- Every slice costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only slices: coverage/interop/property tests fold
  into the implementation slice whose code they exercise.
- A slice that would be a pure test pass over already-landed code merges into its
  neighbour.

## Slice 1 — A: per-Context config token cache (ADR-351, closes 26.9)

### Context

**Goal (behaviour-PRESERVING perf):** make `findFirstValuelessEntry` reuse an
already-tokenized config stream cached per-`Context` alongside `ParsedConfig`,
populated by a SINGLE tokenize, invalidated in lockstep with `readConfig`. The guard
must compute the byte-identical `{ key, source, line }` for every input — only *where
the tokens come from* changes. No interop (faithfulness-neutral by construction).

**File:** `src/application/primitives/config-read.ts` (the ONLY production file this
slice touches). Current shape (verified line anchors):

- L52 `let cache: WeakMap<Context, Promise<ParsedConfig>> = new WeakMap();` — extend
  the value to a `{ parsed, tokens, source }` entry (see Decision candidate 1(a)).
- L61–67 `readConfig` returns `Promise<ParsedConfig>` (public contract, UNCHANGED
  return type) — make it `(await loadConfig(ctx)).parsed` / `entry.parsed`.
- L70–72 `__resetConfigCacheForTests` and L80–82 `invalidateConfigCache` operate on
  the one WeakMap — UNCHANGED bodies (clearing the entry clears parsed+tokens
  atomically, which is the load-bearing correctness property).
- L84–89 `loadConfig`: today `readRawConfig` then `parseConfigText(raw, path)`; on a
  missing file returns `{}`. Rework to: read raw once → `tokenizeConfig(raw, path)`
  once → assemble `parsed` from those tokens → return `{ parsed, tokens, source: path }`.
  Missing file → `{ parsed: {}, tokens: [], source: path }`.
- L91–98 `readRawConfig` (the FILE_NOT_FOUND→undefined catch) — UNCHANGED, reused.
- L122–150 `findFirstValuelessEntry(ctx, section, subsection, keys)`: today does its
  OWN `readRawConfig` + `tokenizeConfig` (L128–131). Reroute it to consume the cached
  entry's tokens. Add a private `readConfigEntry(ctx)` that returns the cached
  `Promise<{parsed, tokens, source}>` (the WeakMap accessor `readConfig` currently
  inlines) and a `loadConfigEntry`; `findFirstValuelessEntry` awaits `readConfigEntry`,
  walks `entry.tokens` with its EXISTING `matchesSection`/lower-case-key/first-by-line
  logic, and uses `entry.source` for `ValuelessEntry.source`. Absent file ⇒
  `tokens: []` ⇒ no matching section ⇒ returns `undefined` (exactly as the `raw ===
  undefined → undefined` path does today).
- **The single-tokenize seam (the one structural refactor):** L205–208
  `parseConfigText` → L442–455 `parseIniSections(text, source)` re-tokenizes INTERNALLY
  (L446 `for (const token of tokenizeConfig(text, source))`). If `loadConfig` calls
  both `tokenizeConfig` AND `parseConfigText`, the bytes tokenize TWICE. Fix per
  ADR-351: extract `parseIniSectionsFromTokens(tokens)` = the existing
  `parseIniSections` loop body (L443–454) minus its `tokenizeConfig` call; `loadConfig`
  tokenizes once and feeds the array to BOTH `parseIniSectionsFromTokens` (→ assemble
  via `assembleParsed`, L862–868) AND the cache entry. Keep `parseIniSections(text,
  source)` exported and behaviour-identical as a thin `tokenizeConfig` →
  `parseIniSectionsFromTokens` wrapper (its other callers are the config writers in
  `update-config.ts`). `parseIniSections` / `tokenizeConfig` exports stay UNCHANGED.
  `parseIniSectionsFromTokens` is a private (non-exported) helper — no barrel change.

**`ConfigToken` type** is already exported (L177–203); `ValuelessEntry` (L100–104),
`IniSection` (L163–167) unchanged.

**Test file:** `test/unit/application/primitives/config-read.test.ts` (574 LOC, many
cases). Helpers/anchors:
- L1 imports `{ beforeEach, describe, expect, it, vi }`; `createMemoryContext`,
  `__resetConfigCacheForTests`, `findFirstValuelessEntry`, `invalidateConfigCache`,
  `readConfig`.
- L26 helper writes config via `ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, …)`.
- L29 root `describe('primitives/config-read', …)`; L31 `beforeEach`
  `__resetConfigCacheForTests()`.
- Existing spy-based cache cases to mirror: L542 `'Then second hits cache (fs.readUtf8
  invoked once)'` uses `const spy = vi.spyOn(ctx.fs, 'readUtf8'); … expect(spy)
  .toHaveBeenCalledTimes(1)`; L763 reset-re-read (`toHaveBeenCalledTimes(2)`); L1510
  `invalidateConfigCache` re-read (`toHaveBeenCalledTimes(2)`); L1529 per-context
  isolation. These are the templates for the new cache-reuse case.
- **ALL existing `findFirstValuelessEntry` / `readConfig` / `parseIniSections` cases
  must pass UNCHANGED** — that is the behaviour-identity proof. Do NOT edit them.

**Cache-staleness audit (caveat — learned the hard way):** the reroute means
`findFirstValuelessEntry` now reads through the SAME cache `readConfig` warms. Any
existing test that does `readConfig(ctx)` (or any reader) → then `ctx.fs.writeUtf8`
a NEW config directly → then calls a finder, will now get STALE tokens unless it calls
`invalidateConfigCache(ctx)` after the raw write (production always invalidates on a
config write via `updateCoreConfig`). Audit `config-read.test.ts` (and any test that
imports `findFirstValuelessEntry`) for a seed → read → raw-write → finder ordering and
add `invalidateConfigCache(ctx)` after such a write **in this slice**. (`beforeEach`'s
`__resetConfigCacheForTests` resets BETWEEN cases, not within one.)

### TDD steps

- **RED** — add `describe('Given readConfig has warmed the cache for a config with a
  valueless [core] path-like', …)` > `describe('When findFirstValuelessEntry runs on
  the same context', …)` > `it('Then fs.readUtf8 for the config path is invoked once
  across both', …)`: arrange a `createMemoryContext` with a valueless
  `core.excludesfile` config written, `const spy = vi.spyOn(ctx.fs, 'readUtf8')`, call
  `await readConfig(ctx)` then `await findFirstValuelessEntry(ctx,'core',undefined,
  ['excludesfile'])`; assert the found entry's fields AND
  `expect(spy).toHaveBeenCalledTimes(1)`. **Fails today** (`toHaveBeenCalledTimes(2)`:
  the finder issues its own `readRawConfig`).
- **RED** — sibling `it('Then after invalidateConfigCache the next finder re-reads
  (spy count 2)', …)`: same arrange, `readConfig` → `invalidateConfigCache(ctx)` →
  finder; assert `toHaveBeenCalledTimes(2)`. Proves shared invalidation. **Fails
  today** only if the first RED's single-read does not exist; pin it regardless.
- **RED** — `it('Then a finder before readConfig also serves the cache (single read)',
  …)`: finder first, then `readConfig`; assert `toHaveBeenCalledTimes(1)` and identical
  parsed result. **Fails today** (two reads).
- **RED** — file-absent case `it('Then an absent config is served from cache without a
  second fs hit', …)`: no config file, `readConfig` then finder; assert finder returns
  `undefined` and `toHaveBeenCalledTimes(1)` (or 0 if absent short-circuits before a
  read — assert the production behaviour: the FILE_NOT_FOUND path still hits
  `readUtf8` once and caches `tokens: []`). **Fails today** (the finder re-reads).
- **GREEN** — implement the cache-entry extension, `loadConfigEntry`/`readConfigEntry`,
  the `parseIniSectionsFromTokens` extraction, and the `findFirstValuelessEntry`
  reroute as described in Context. Run the cache-staleness audit and add any missing
  `invalidateConfigCache` calls to pre-existing tests made stale by the reroute.
- **REFACTOR** — confirm `readConfig`'s public return type is unchanged
  (`Promise<ParsedConfig>`); confirm `parseIniSections`/`tokenizeConfig`/`ConfigToken`
  exports are byte-identical; verify no Stryker `disable` comment was added. Run the
  full `config-read.test.ts` suite to confirm every pre-existing case is green
  unchanged (behaviour-identity proof).

### Gate
`npx vitest run test/unit/application/primitives/config-read.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/config-read.ts test/unit/application/primitives/config-read.test.ts`

### Commit
`perf(config): cache the config token stream per-context alongside the parse`

## Slice 2 — B: eager all-`[merge *]` driver valueless at the content-merge chokepoint (ADR-352, closes 24.9v)

### Context

**Goal (faithfulness — MORE refusals):** any real 3-way **content** merge of a path
refuses on the FIRST valueless `merge.<d>.driver`/`name` by config-file line across
**ALL** `[merge *]` subsections — independent of attribute resolution (M4) and of
conflict-vs-auto-resolve. Stays **lazy** (no die on fast-forward / read commands —
M3). Removes the now-subsumed per-driver guard from `namedChoice`.

**New primitive — `findFirstValuelessInSection` (INTERNAL, NOT barrelled):**
add to `src/application/primitives/config-read.ts` as a sibling of
`findFirstValuelessEntry` (L122–150). Signature:
`export const findFirstValuelessInSection = async (ctx: Context, section: string, keys:
ReadonlyArray<string>): Promise<ValuelessEntry | undefined>`. It is
`findFirstValuelessEntry` minus the subsection filter: match ANY subsection of
`section` (`token.section.toLowerCase() === section.toLowerCase()`, ignore
`token.subsection`), lower-case the key against `keySet`, FIRST valueless
(`value === null`) by file line. The qualified key keeps the matched subsection
**verbatim**: `${section.toLowerCase()}.${matchedSubsection}.${loweredKey}` — and
`matchedSubsection` is the OPEN section's `token.subsection` (which may be `undefined`
for the no-subsection form, though `[merge]` with no subsection is not a real driver;
keep it correct anyway). After A (Slice 1) lands, it consumes the cached token stream
via `readConfigEntry` exactly like `findFirstValuelessEntry` — ONE walk over the same
cached tokens, no extra read. `matchesSection` (L106–112) stays for the exact finder;
do NOT alter `findFirstValuelessEntry` (still used by core/user/remote/branch/submodule
exact-subsection guards). **No `assertNoValuelessInSection` wrapper** (ADR-352: import
the domain error directly at the chokepoint).

**Chokepoint guard — `build-content-merger.ts`:**
`src/application/primitives/build-content-merger.ts`. `buildContentMerger(ctx, labels)`
(L40–79) returns an async per-path closure (L47). Add a latched eager guard as the
FIRST statement of that closure (before the `Promise.all` blob reads at L48):
```
let providerPromise; const provider = () => (providerPromise ??= buildAttributeProvider(ctx));
let driverGuard;                                   // once-latched
const ensureNoValuelessMergeDriver = () =>
  (driverGuard ??= findFirstValuelessInSection(ctx, 'merge', ['driver', 'name']).then((found) => {
    if (found !== undefined) throw configMissingValue(found.key, found.source, found.line);
  }));
return async (mergeCtx) => {
  await ensureNoValuelessMergeDriver();            // whole-table scan, all [merge *], first by line
  const [ours, theirs, base] = await Promise.all([ … ]);   // existing body unchanged
  …
};
```
Imports to add: `findFirstValuelessInSection` from `./config-read.js`; `configMissingValue`
from `../../domain/commands/error.js` (LAYERING — domain error directly into a
primitive; do NOT import the command-layer `valueless-config-guard.ts` here). The
latch (`??=`) makes the scan run AT MOST once per operation regardless of path count;
because it sits INSIDE the returned closure, constructing the merger does not run it —
a fast-forward / no-content-merge merge invokes the closure for ZERO paths and never
throws (M3 laziness). `merge-tree --write-tree` routes through the same merger (M-tree
covered). `ContentMerger` signature (verified): `(ctx, base, ours, theirs) =>
Promise<ContentMergeResult> | ContentMergeResult` — but the test drives it as
`sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0))`.

**Removal — `resolve-merge-driver.ts`:** `src/application/primitives/resolve-merge-driver.ts`,
`namedChoice` (L30–40) currently calls `await assertNoValuelessConfig(ctx, 'merge',
name, ['driver', 'name'])` at L34. **Remove that line** (and the now-unused import of
`assertNoValuelessConfig` from `./internal/valueless-config-guard.js` at L10 IF no
other use remains in the file — verify; `readConfig` import at L8 stays). The chokepoint
scan subsumes it (fires for ANY content merge before any specific driver resolves, at
the same-or-earlier key by file line), so the attribute-selected case is still refused
via the chokepoint — the no-regression test pins this.

**Test MOVE (the load-bearing rework):** `test/unit/application/primitives/resolve-merge-driver.test.ts`
(425 LOC) has a block `describe('resolvePathMergeSpec — valueless merge driver config',
…)` (≈L208–345) that asserts the guard AT `resolvePathMergeSpec` via a `chooseData`
helper (try/catch returning `err.data`) and a `seed(ctx, attrs, config)` helper (L16:
writes `.gitattributes` to `${workDir}/.gitattributes` and config to
`${gitDir}/config`). Cases there: valueless `driver` → `merge.mydriver.driver` line 2;
valued driver + valueless `name` → `merge.mydriver.name` line 3; both valueless driver-
first → driver line 2; both name-first → name line 2; no matching section → text (no
throw); valued driver+name → external (no throw); `merge=text` built-in same-named
valueless section → text without consulting config. When `namedChoice`'s guard is
removed, these guard-assertion cases NO LONGER throw at `resolvePathMergeSpec` — they
must **MOVE** to `build-content-merger.test.ts`, reframed to drive a content merge
through `buildContentMerger` (the new guard home). The non-guard cases (no-section →
text, valued → external, `merge=text` built-in → text without consulting config) STAY
in `resolve-merge-driver.test.ts` as pure resolution tests (they no longer involve a
throw and prove `resolvePathMergeSpec` itself is guard-free now).

**Test home — `build-content-merger.test.ts`:** `test/unit/application/primitives/build-content-merger.test.ts`.
Helpers: `enc`/`dec` (L11–12), `blob(ctx, content)` via `writeObject` (L14), `mergeCtxFor(ctx,
{base?, ours, theirs, path?})` (L17–34) building a `ContentMergeContext`. Root
`describe('buildContentMerger', …)` (L36). Existing pattern: `const sut =
buildContentMerger(ctx); const mergeCtx = await mergeCtxFor(ctx, {…}); const result =
await sut(mergeCtx, undefined, new Uint8Array(0), new Uint8Array(0))`. Config is seeded
by `ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, …)`; `.gitattributes` by
`ctx.fs.writeUtf8(`${ctx.layout.workDir}/.gitattributes`, …)`. Add a `describe('Given a
valueless [merge *] driver config', …)` block with a `mergeData` try/catch helper
(mirror `chooseData`) capturing `err.data`.

**Pinned bytes (interop matrix, design §B — the `line` is whatever the chosen fixture
puts the valueless key on; derive it from the fixture, do NOT hard-code a magic line.
The existing interop fixtures use a `[core]\n\trepositoryformatversion = 0\n[merge
"…"]\n\tdriver\n` shape that lands `driver` on line 4 — reuse that style):**
- M4: `[merge "custom"]` / `driver` valueless, NO `.gitattributes` referencing custom,
  both sides edit `f.txt` on NON-overlapping lines (auto-resolves, NO conflict) → dies
  `merge.custom.driver` at its fixture line, exit 128. The decisive no-attribute test.
- M2: driver valued + `name` valueless → `merge.custom.name` at the name's line.
- M-order: `[merge "zzz"]`/`name` valueless (earlier line) + `[merge "aaa"]`/`driver`
  valueless (later line) → `merge.zzz.name` reported (FIRST by file line wins across
  subsections, even though `aaa`/`driver` is lexically first).
- M3: fast-forward merge with valueless driver → exit 0 (lazy); `status`/`log`/`add` → 0.
- Refusal carries `CONFIG_MISSING_VALUE { key, source, line }`, exit 128.

**Interop file:** `test/integration/missing-value-refusal-interop.test.ts`. The block
`describe.skipIf(!GIT_AVAILABLE)('missing-value-refusal interop — merge driver', …)`
(L946–1226) ALREADY exists with a `beforeAll` building a diverged graph that conflicts
on `data.txt` WITH `.gitattributes` `* merge=mydriver` (L956), `MERGE_AUTHOR_ENV`,
`writeBothConfig(fixture)` (L985), `resetBoth` (L977), and fixtures
`VALUELESS_MERGE_DRIVER_FIXTURE` (driver line 4), `VALUELESS_MERGE_BOTH_*`,
`VALUELESS_MERGE_NAME_VALUED_DRIVER_FIXTURE`, `ABSENT_MERGE_DRIVER_FIXTURE`. tsgit merge
driven via `repo.merge.run({ rev: 'theirs', message: 'm' })`; git via `tryRunGit(['-C',
peer, 'merge', '--no-ff', '-m', 'm', 'theirs'], { env: MERGE_AUTHOR_ENV })`. The
existing cases use the `* merge=mydriver` ATTRIBUTE path (the old `namedChoice` case).
**Add the decisive M4 distinctness rows** the new chokepoint enables: a NEW fixture
graph WITHOUT `.gitattributes` referencing the driver AND with NON-overlapping edits
(auto-resolve) — proving the die fires with no attribute and no conflict. Add to the
same block (or a sibling `beforeAll` graph) and the M3 fast-forward distinctness row
(valueless driver + fast-forward merge → both exit 0). Reconstruct git's two lines from
`{ key, source, line }` per the established `normalizedSource = '.git/config'` /
`replace(/in file '[^']+'/, …)` pattern (L173–179). Use `interop-helpers.ts`
(`runGit`/`tryRunGit`/`runGitEnv`/`GIT_AVAILABLE`) — scrubbed `GIT_*`, isolated HOME,
`GIT_CONFIG_NOSYSTEM=1` already wired; git's CLI writes the valueless line via
`writeFile` (it cannot emit valueless itself). 60s `beforeAll` timeout (heavy
git-spawning interop times out hooks under validate's concurrency — project memory).

**Property tests — DO NOT APPLY** (design §B "Property tests — DO NOT APPLY"):
`findFirstValuelessInSection` is a command-surface refusal detector, not a
parser/round-trip/matcher/grammar/counting case. Example tests document the literal
behaviour; the file-order detection is the existing tokenizer's, already tested.

### TDD steps

- **RED (finder)** in `config-read.test.ts` — `describe('Given two [merge *]
  subsections each with a valueless key', …)` > `describe('When findFirstValuelessInSection
  scans the merge section', …)` > `it('Then it reports the earlier-by-line key with its
  verbatim subsection', …)`: seed `[merge "zzz"]\n\tname\n[merge "aaa"]\n\tdriver\n`
  via `writeUtf8`, call `findFirstValuelessInSection(ctx,'merge',['driver','name'])`;
  assert `key === 'merge.zzz.name'`, the right `line`, `source` matches `/\/config$/`.
  **Fails**: symbol does not exist. Add isolated `it`s: single subsection reported;
  non-matching SECTION not reported; empty-string (`= `) key not reported (null-only);
  case-folding (section/key lowered, subsection verbatim). File-order discriminator is
  a separate `it`.
- **GREEN (finder)** — add `findFirstValuelessInSection` to `config-read.ts` consuming
  the cached tokens (Slice-1 `readConfigEntry`).
- **RED (chokepoint, M4)** in `build-content-merger.test.ts` — `describe('Given a
  valueless merge.custom.driver and NO merge attribute', …)` > `describe('When a path
  enters content merge', …)` > `it('Then it throws CONFIG_MISSING_VALUE for
  merge.custom.driver at its line', …)`: seed `[merge "custom"]\n\tdriver\n` to
  `${gitDir}/config`, NO `.gitattributes`, `mergeCtxFor` with non-overlapping edits,
  `await sut(mergeCtx, undefined, …)` via a `mergeData` try/catch; assert `.code`/`.key`/
  `.line`/`.source` individually. **Fails today** (guard only fired in `namedChoice`,
  unreachable with no attribute) — this is the decisive M4 test.
- **RED (M2 / M-order / no-regression / M3)** — `it` M2 (valued driver + valueless
  `name` → `.name`); `it` M-order (two valueless `[merge *]` sections, earlier-line
  reported); `it` no-regression (attribute-SELECTED valueless driver still refuses via
  the chokepoint — moved from `resolve-merge-driver.test.ts`); `it` M3 (a merger whose
  closure is invoked for ZERO content-merge paths does NOT throw — e.g. construct the
  merger and never call the closure, OR call it for a path that needs no content merge;
  assert no throw). All fail or are mis-homed today.
- **GREEN (chokepoint)** — add the latched eager guard to `buildContentMerger`; remove
  `assertNoValuelessConfig` from `namedChoice` (and its now-dead import if unused);
  move the guard-assertion cases out of `resolve-merge-driver.test.ts` into
  `build-content-merger.test.ts` (keep the pure-resolution cases in place).
- **RED→GREEN (interop)** — add the M4 no-attribute auto-resolve distinctness row and
  the M3 fast-forward distinctness row to `missing-value-refusal-interop.test.ts`;
  reconstruct git's two lines and assert parity. Verify the existing merge-driver block
  still passes (its attribute-path cases now refuse via the chokepoint — same bytes).
- **REFACTOR** — confirm `resolve-merge-driver.test.ts` pure-resolution cases still
  pass with the guard gone; confirm `findFirstValuelessInSection` is NOT added to
  `src/application/primitives/index.ts` (internal); confirm no command-layer import
  leaked into the primitive; run the merge-driver + content-merger + config-read units
  together.

### Gate
`npx vitest run test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/build-content-merger.test.ts test/unit/application/primitives/resolve-merge-driver.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/config-read.ts src/application/primitives/build-content-merger.ts src/application/primitives/resolve-merge-driver.ts test/unit/application/primitives/config-read.test.ts test/unit/application/primitives/build-content-merger.test.ts test/unit/application/primitives/resolve-merge-driver.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit
`fix(merge): refuse a valueless merge-driver config at the content-merge chokepoint`

## Slice 3 — C: empty-string `core.excludesFile`/`attributesFile` treated as feature-off (24.9w)

### Context

**Goal (faithfulness fix — git is the spec, no ADR):** a valued-but-EMPTY (`''`, NOT
null) `core.excludesFile` / `core.attributesFile` is feature-OFF (exit 0, no file
loaded), matching git — distinct from the valueless (null) refusal (UNCHANGED) and
from absent (also feature-off here; `== absent`). The fix is purely at the two
consumers; no `ParsedConfig` / type / error-code change (the parser already keeps `''`
as a valued string — `applyCoreEntry` L897 skips only `value === null`, then assigns
the string).

**Why a naive `toBeUndefined()` is NOT enough (caveat — learned the hard way):** today
`readGlobalExcludes('')` → `expandUserPath(ctx, '')` returns `''` unchanged (verified:
`expandUserPath` L12–20 falls through both `~` guards and returns `raw`) →
`loadCappedUtf8(ctx, '', …)` calls `ctx.fs.lstat('')` (L48). The memory adapter masks
this: `resolve('')` → `rootDir`, which `lstat`s fine and is not a file, so
`loadCappedUtf8` returns `undefined` — meaning a `toBeUndefined()` assertion PASSES even
WITHOUT the fix. The behavioral kill is therefore `expect(lstatSpy).not.toHaveBeenCalledWith('')`
(spy on `ctx.fs.lstat`): the fix must short-circuit BEFORE the `lstat('')`.

**File 1 — `src/application/primitives/internal/read-gitignore.ts`:** `readGlobalExcludes`
(L37–44). Anchor L40 `if (raw === undefined) return undefined;` (where `raw =
config.core?.excludesFile`, L39). Widen to `if (raw === undefined || raw === '') return
undefined;`. This returns BEFORE `expandUserPath`/`loadCappedUtf8` can `lstat('')`.
(Note: there are TWO `read-gitignore.ts` — this is the **primitives/internal** one with
`readGlobalExcludes`; the `commands/internal` one is different and untouched.)

**File 2 — `src/application/primitives/internal/read-gitattributes.ts`:** `readGlobal`
(L33–39). Anchor L35 `if (raw === undefined) return undefined;` (where `raw = (await
readConfig(ctx)).core?.attributesFile`, L34). Widen identically: `|| raw === ''`. This
makes `buildAttributeProvider` (L67–96) yield no global source for an empty
`attributesFile`.

**Test 1 — `test/unit/application/commands/internal/read-gitignore.test.ts`** (this is
where `readGlobalExcludes` is unit-tested — verified via grep; the primitives/internal
copy has no colocated test). Imports (L1–11): `{ afterEach, describe, expect, it }`,
`createMemoryContext`, `readGlobalExcludes`, `__resetConfigCacheForTests`,
`MAX_GITIGNORE_BYTES`, `TsgitError`, `FilePath`. `seed(homeDir?)` helper (L15) builds a
ctx + writes `${gitDir}/HEAD`. Config is written via `ctx.fs.writeUtf8(`${ctx.layout
.gitDir}/config`, …)`. **Cache-staleness caveat:** if a test warms the config cache
before writing the empty-excludes config, call `invalidateConfigCache(ctx)` after the
write (Slice 1's reroute makes the finder/readConfig share one cache). Add
`describe('Given core.excludesFile = "" (empty, feature-off)', …)` > `describe('When
readGlobalExcludes runs', …)` > two `it`s: `'Then it returns undefined'` AND `'Then it
never lstats the empty path'` (the behavioral kill via `vi.spyOn(ctx.fs, 'lstat')` +
`expect(spy).not.toHaveBeenCalledWith('')`). Regression `it`s already present: absent →
undefined (unchanged); a real valued path still loads — keep them green.

**Test 2 — `test/unit/application/primitives/internal/read-gitattributes.test.ts`.**
Imports (L1–9): `{ describe, expect, it, vi }`, `createMemoryContext`,
`buildAttributeProvider`, etc. Helpers: `seed(ctx, path, content)` (L10) writes a file;
`merge(ctx, path)` (L14) resolves the `merge` attribute. Existing global-attributes
cases at L91 (absolute), L109 (only global), L126 (`~/`), L143 (`~` alone) use `seed(ctx,
'/repo/.git/config', '[core]\n  attributesFile = …')`. Add `describe('Given
core.attributesFile = "" (empty, feature-off)', …)` > `describe('When
buildAttributeProvider resolves a path', …)` > `it('Then no global source is yielded')`
AND `it('Then it never lstats the empty path')` (`vi.spyOn(ctx.fs, 'lstat')` +
`not.toHaveBeenCalledWith('')`).

**Interop — `test/integration/missing-value-refusal-interop.test.ts`:** add a NEW
`describe.skipIf(!GIT_AVAILABLE)` block (or extend the existing top block) for the
empty-path-likes. Use `runGit`/`tryRunGit`/`runGitEnv`/`GIT_AVAILABLE` from
`interop-helpers.ts`. git's CLI CAN write an empty value (`git config core.excludesFile
''`) — but for a controlled byte, prefer `writeFile` of a `[core]\n\texcludesFile = \n`
fixture (note the trailing space then newline) into `${ours}/.git/config`, matching the
existing fixture style. Rows (design §B+C interop):
- E3a: `core.excludesFile = ` (empty) + an untracked `ignoreme.log` → real `git status
  --porcelain` exits 0 with the untracked file shown AND tsgit `status` exits 0 / does
  not raise (drive tsgit via `openRepository({ cwd: ours }).status(...)`).
- E3a-ctrl (boundary): empty `core.excludesFile` exits 0 in BOTH WHILE valueless
  (`excludesFile` no `=`) dies 128 in BOTH — the empty-vs-valueless discriminator.
- E3a-cfg (porcelain): `git config --list` / tsgit `configList` succeed on empty
  `core.excludesFile` (ADR-314 — porcelain reads keep the empty value; unaffected).
- E3b: `core.attributesFile = ` (empty) → `git status` / `git checkout .` exit 0 AND
  tsgit does not raise.

### TDD steps

- **RED** — `read-gitignore.test.ts`: add the empty-excludes `it`s including the
  `expect(lstatSpy).not.toHaveBeenCalledWith('')` behavioral kill. The
  `not.toHaveBeenCalledWith('')` test **fails today** (the `lstat('')` IS called before
  the fix); the `toBeUndefined` companion passes today (masked) but documents intent.
- **RED** — `read-gitattributes.test.ts`: add the empty-attributes `it`s with the same
  `not.toHaveBeenCalledWith('')` kill. **Fails today.**
- **GREEN** — widen both guards (`|| raw === ''`) in `read-gitignore.ts` and
  `read-gitattributes.ts`.
- **RED→GREEN (interop)** — add the E3a / E3a-ctrl / E3a-cfg / E3b rows; run real git +
  tsgit on the same tmp repo, assert co-behaviour (exit 0 empty, exit 128 valueless
  control). Boundary control is one `it` asserting BOTH tools on BOTH fixtures.
- **REFACTOR** — confirm the valueless (null) refusal path is untouched (E3a-ctrl green);
  confirm no `ParsedConfig`/error-code change; confirm the regression cases (absent →
  undefined, valued path loads) still pass.

### Gate
`npx vitest run test/unit/application/commands/internal/read-gitignore.test.ts test/unit/application/primitives/internal/read-gitattributes.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/read-gitignore.ts src/application/primitives/internal/read-gitattributes.ts test/unit/application/commands/internal/read-gitignore.test.ts test/unit/application/primitives/internal/read-gitattributes.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit
`fix(config): treat an empty core.excludesFile/attributesFile as feature-off`

## Slice 4 — C: empty `core.hooksPath` is a "no hooks dir" sentinel (24.9w; absent ≠ empty)

### Context

**Goal (faithfulness — the absent≠empty case):** an empty (`''`) `core.hooksPath` means
NO hook fires (feature-off, exit 0) — and per E3c-dist it is **NOT** the default
`${gitDir}/hooks` (absent fires that), **NOT** the explicit default dir, and **NOT**
`${workDir}/` (the CWD). This is the one path-like whose empty-handling is NOT simply
`== absent`: for `hooksPath`, **absent ≠ off** (absent fires the default-dir hook).

**Bug today — `src/application/primitives/run-hook.ts`:** `resolveHooksDir(hooksPath,
layout)` (L20–31). With `hooksPath === ''`: `'' === undefined`? no (L25); `''.startsWith
('~/')`? no (L26); `isAbsolutePath('')`? no (L29 → L11 both checks false); → returns
`` `${layout.workDir}/${''}` `` = `` `${workDir}/` `` (the worktree root — WRONG; it
would re-enable hooks resolved against the CWD). `HOOKS_SUBDIR = 'hooks'` (L8); fallback
`` `${layout.gitDir}/${HOOKS_SUBDIR}` `` (L24). `resolveHooksDir` is called at L59
(`hooksDir: resolveHooksDir(config.core?.hooksPath, ctx.layout)`) inside `invokeHook`
(L48–67), which `runHook` (L75–85) and `runInformationalHook` (L93–99) share. Note
`invokeHook` ALSO calls `assertNoValuelessConfig(ctx,'core',undefined,['hookspath'])`
at L55 — that is the VALUELESS (null) refusal (ADR-350, UNCHANGED); empty (`''`) is NOT
null, so it does NOT trip that guard — it flows to `resolveHooksDir`.

**The fix — a NAMED "no hooks dir" sentinel.** Add an empty-`hooksPath` branch to
`resolveHooksDir` that resolves to a directory guaranteed to contain no hook script,
so `runHook` finds no hook and fires nothing (matching E3c: commit succeeds). It must
NOT be the `${gitDir}/hooks` fallback (would re-enable the default-dir hook the UNSET
case fires — E3c-dist), and NOT `${workDir}/`. Use a **NAMED constant** for the
sentinel (e.g. a `NO_HOOKS_DIR` constant resolving to a path the runner can never match
a hook under — confirm against the hook-runner lookup contract that the chosen sentinel
yields "no hook matched / never invoked"; if the runner cannot express "no dir", the
sentinel must be a path that lstat-misses for every hook name). The concrete sentinel is
pinned against the E3c interop (commit succeeds, hook does not fire) and the unit assertions
below — it must satisfy `resolveHooksDir('', layout) !== fallback` AND
`!== `${workDir}/``. Do NOT add a Stryker/biome/v8 ignore comment.

**Test — `test/unit/application/primitives/run-hook.test.ts`.** Imports (L1–11): `{
beforeEach, describe, expect, it }`, `createMemoryContext`, `MemoryHookRunner`,
`__resetConfigCacheForTests`, `resolveHooksDir`, `runHook`, `TsgitError`,
`RepositoryLayout`. `layout(overrides?)` helper (L13: `{ workDir: '/repo', gitDir:
'/repo/.git', … }`). Root `describe('primitives/run-hook resolveHooksDir', …)` (L20).
Existing cases: L21 `Given no hooksPath` → defaults to `<gitDir>/hooks` (the UNSET
control — KEEP); L33 absolute POSIX; L45 absolute Windows; L57 `~/` with homeDir. Add
`describe('Given an empty hooksPath', …)` > `describe('When resolveHooksDir', …)` >
`it('Then it does NOT resolve to the default <gitDir>/hooks', …)` (assert `sut !==
`${layout().gitDir}/hooks``) AND `it('Then it does NOT resolve to the worktree root', …)`
(assert `sut !== `${layout().workDir}/``) AND `it('Then it resolves to the no-hooks
sentinel', …)` (assert `sut === NO_HOOKS_DIR` or the chosen named value). Plus a runtime
proof via `runHook`: `describe('Given an empty core.hooksPath and a blocking hook in
the default dir', …)` > `it('Then runHook fires no hook (no throw)', …)` — seed config
`[core]\n\thooksPath = \n`, wire a `MemoryHookRunner` whose default-dir hook would throw
if invoked, call `runHook(ctx, …)`, assert it RESOLVES (the sentinel made the lookup
miss). Pair with the UNSET control (absent `hooksPath` + same blocking hook → fires →
throws `HOOK_FAILED`) to pin absent ≠ empty. **Cache-staleness caveat:** call
`invalidateConfigCache(ctx)` after a raw config write that follows a warmed read.

**Interop — `test/integration/missing-value-refusal-interop.test.ts`:** add an
empty-`hooksPath` block. **POSIX-gate the executable-hook rows** (the hook script must
be executable — `chmod +x`; skip on non-POSIX). Rows (design §C):
- E3c: `core.hooksPath = ` (empty) + a blocking executable `.git/hooks/pre-commit`
  (`exit 1`) → real `git commit` SUCCEEDS (hook does not fire, exit 0) AND tsgit
  `commit` SUCCEEDS (hook does not fire). The decisive E3c parity.
- E3c-dist (unset control): NO `core.hooksPath`, same blocking pre-commit → `git commit`
  BLOCKED (exit 1, default-dir hook fires) AND tsgit blocked — proving absent ≠ empty.
Drive tsgit via `openRepository({ cwd: ours }).commit({…})` with a node `HookRunner`
wired (node context) so the hook actually runs; stage a file first. Use the
`MERGE_AUTHOR_ENV`-style identity env for the commit. `runGit`/`tryRunGit` from
`interop-helpers.ts`.

### TDD steps

- **RED** — `run-hook.test.ts`: add the three `resolveHooksDir('', layout())` `it`s
  (`!== default`, `!== workDir/`, `=== sentinel`). The `!== `${workDir}/`` and
  `=== sentinel` cases **fail today** (returns `` `${workDir}/` ``).
- **RED** — the `runHook` runtime `it`: empty `hooksPath` + blocking default-dir hook →
  no throw. **Fails today** (resolves to `${workDir}/`, and depending on runner the
  blocking hook may not be where it looks — assert the production "fires nothing"
  behaviour). Pair with the UNSET control `it` (must still throw `HOOK_FAILED`).
- **GREEN** — add the named no-hooks sentinel branch to `resolveHooksDir`; verify the
  UNSET (`undefined`) and absolute/`~/` branches are unchanged.
- **RED→GREEN (interop)** — add the POSIX-gated E3c parity row and the E3c-dist unset
  control; assert real git + tsgit co-behaviour (empty → commit succeeds in both; absent
  → commit blocked in both).
- **REFACTOR** — confirm the VALUELESS (null) `hooksPath` refusal (L55 guard) is
  untouched; confirm UNSET still fires the default-dir hook (control green); confirm no
  ignore directive added.

### Gate
`npx vitest run test/unit/application/primitives/run-hook.test.ts test/integration/missing-value-refusal-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/run-hook.ts test/unit/application/primitives/run-hook.test.ts test/integration/missing-value-refusal-interop.test.ts`

### Commit
`fix(hooks): treat an empty core.hooksPath as a no-hooks sentinel`
