# Plan — no-build browser bundle

> Source: design doc `docs/design/no-build-browser-bundle.md` · ADRs 525, 526, 527, 528, 529, 530, 531
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

**Zero `src/` delta.** No source file changes, no new exported TypeScript symbol, no
new command. The change is packaging: one new emitted artefact, two `package.json`
top-level fields, one size budget, one raised tarball cap, one e2e harness page +
spec, two doc surfaces.

**Public-surface decision (up front).** The one new *public* surface is the published
artefact path `dist/browser/tsgit.js` plus the top-level `unpkg` / `jsdelivr` fields.
It introduces **no new exported symbol** — the bundle re-exports `src/index.browser.ts`
unchanged (ADR-531), so none of the symbol-level surface gates apply (no barrel, no
`Repository` facade binding, no `docs/use/commands/` page, no `check:doc-coverage`
row, no `check:browser-surface` allowlist entry). The gates this public surface *does*
trip, pre-paid in the part that creates it:

| gate | tripped by | paid in |
| --- | --- | --- |
| `check:tarball` / `verify:tarball` (size cap + inventory) | the artefact ships in the tarball | Part 1 |
| `check:size` (size-limit needs every declared `path` to exist) | new `.size-limit.json` entry | Part 1 |
| `check:exports` (`attw --pack . --profile node16`) | new top-level fields + extra tarball file | Part 1 |
| `check:test-pyramid` (e2e tier file count) | new `*.spec.ts` | Part 2 |
| `check:doc-typedoc` (**prepush**, `git diff --exit-code -- reports/api.json`) | `typedoc.json` sets `"readme": "README.md"` — typedoc **embeds the README into `reports/api.json`**, so *any* README edit makes it stale | Part 3 |

That last row **corrects the design's Test-strategy table**, which claims
`check:doc-typedoc` has "no diff to commit — typedoc reads `src/`". Verified against
`reports/api.json`: the runtime table's `Browser (OPFS)` row is present verbatim in
the committed JSON. Part 3 regenerates and commits `reports/api.json`.

**House rules that bind every part.** ADR / phase / backlog numbers appear in *this*
plan and in the commit trailer conversation — never inside source, shell, HTML or test
code (comments included). No suppression directives of any flavour
(`@ts-ignore`, `biome-ignore`, `v8 ignore`, `stryker-disable`, `--no-errors-on-unmatched`
used to dodge a gate). No swallowed errors. Never commit on a red gate; if a gate
cannot be made green honestly, escalate `{ part, reason, ≤3 options }`.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

Three parts. Part 1 is the artefact + its packaging gates (one honest RED→GREEN on the
tarball script). Part 2 is test-infra-only (Playwright harness page + spec + fixture
helpers, no `src/` delta) — standalone by the exception above. Part 3 is docs-only —
standalone by the same exception. Parts run sequentially in one working tree; Part 2
needs Part 1's `dist/browser/tsgit.js` to exist, Part 3 needs nothing from Part 2.

## Part 1 — Emit the bundle, ship it, budget it

### Context

**Goal.** `npm run build` emits one additional artefact — a single-file, minified,
tree-shaken ESM bundle of the browser entry at `dist/browser/tsgit.js` — it ships in
the npm tarball, the CDN root URLs resolve to it, and both size gates cover it.

**Files touched (exact paths, all relative to the worktree root):**

1. `rollup.config.ts`
2. `tooling/verify-tarball.sh`
3. `package.json` (top-level `unpkg` + `jsdelivr`; `wireit.build:js.output`)
4. `.size-limit.json`

#### 1 · `rollup.config.ts` — current shape

Exports `defineConfig([configA, configB])`. Module-scope consts already present:
`entryPoints` (11 entries, includes `'index.browser': 'src/index.browser.ts'`),
`external = [/^node:/]`, `terserOptions`. Config A is the multi-entry ESM+CJS build
(plugins `resolve()`, `typescript({…})`, `terser(terserOptions)`, `visualizer({filename:'reports/bundle-analysis.html', …})`);
config B is the `dts` types build. Imports at the top:

```ts
import resolve from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { defineConfig } from 'rollup';
import dts from 'rollup-plugin-dts';
import { visualizer } from 'rollup-plugin-visualizer';
```

**Append a THIRD config object** to the array (ADR-530). It must be a third *config*,
not a third `output` on config A: a `file:` output and `inlineDynamicImports` are both
incompatible with multi-entry `input` — a rollup structural fact, not a preference.

```ts
  {
    input: 'src/index.browser.ts',
    output: {
      file: 'dist/browser/tsgit.js',
      format: 'esm',
      sourcemap: false,
      inlineDynamicImports: true,
    },
    external,
    plugins: [resolve(), typescript(tsPluginOptions), terser(terserOptions)],
    treeshake: {
      moduleSideEffects: false,
      propertyReadSideEffects: false,
    },
  },
```

- `sourcemap: false` is ADR-527 — a map for this artefact measures 734 010 B gzip,
  larger than the whole current tarball, and would need an exception carved out of the
  `^package/.*\.map$` forbidden-path guard. Do not flip it.
- `inlineDynamicImports: true` is defensive: `src/` has zero dynamic imports today
  (`grep -rnE "await import\(|=\s*import\(" src/` → empty), and the flag stops a
  future one from silently re-splitting the artefact.
- **Do NOT repeat `visualizer`** — it writes `reports/bundle-analysis.html` and a
  second config writing the same path clobbers the code-split treemap.
- `external` is the shared `[/^node:/]`. It never fires today (the artefact has zero
  `node:` references, measured); keeping it is safe because the single-file predicate
  added to `verify-tarball.sh` below catches any emitted `import"node:…"` as a
  non-zero import hit.

**Plugin options sharing.** Config A's `typescript({...})` literal must be lifted to a
module-scope const so the new config cannot drift from it. `@rollup/plugin-typescript`
exports the option type (`node_modules/@rollup/plugin-typescript/types/index.d.ts:129`
→ `export type RollupTypescriptOptions`), so annotate it:

```ts
import typescript, { type RollupTypescriptOptions } from '@rollup/plugin-typescript';

const tsPluginOptions: RollupTypescriptOptions = {
  tsconfig: './tsconfig.build.json',
  compilerOptions: {
    outDir: undefined,
    declaration: false,
    declarationMap: false,
    sourceMap: false,
    module: 'ESNext',
    moduleResolution: 'bundler',
  },
};
```

Call `typescript(tsPluginOptions)` in both config A and the new config — a fresh
plugin *instance* per call, one shared options object. If the build regresses or the
annotation rejects the literal, fall back to duplicating the options literal inline in
the new config and leave config A untouched; do not spend time fighting the type.

**`rollup.config.ts` is NOT covered by `npm run check:types`** — `tsconfig.json`'s
`include` is `["src/**/*.ts","test/**/*.ts","tooling/**/*.ts"]`. The compiler that sees
this file is rollup's own `--configPlugin @rollup/plugin-typescript`, i.e. the build.
`npm run build` is the type check for this file.

#### 2 · `tooling/verify-tarball.sh` — current shape and the three edits

Current structure (line numbers as committed): `--quick` arg parse (7–13); the
`SIZE_CAP=$((550 * 1024))` const with a comment block explaining its derivation
(15–22); `TARBALL=$(npm pack --silent)` + `INVENTORY=$(mktemp …)` + `SIZE=$(wc -c …)`
(24–28); `cleanup()` + `trap cleanup EXIT` (30–33); the size check (35–38);
`tar -tzf "$TARBALL" >"$INVENTORY"` (40); four **required-content** greps —
`^package/dist/`, `^package/package\.json$`, `^package/LICENSE$`, `^package/README\.md$`
(42–58); the **forbidden-content** loop over `^package/src/ ^package/test/
^package/reports/ ^package/\.claude/ ^package/\.github/ ^package/.*\.map$` (60–66);
the `attw --pack "$TARBALL" --profile node16` block gated on `QUICK == 0` (71–76); the
final `echo "OK: …"`.

**Edit (a) — a fifth required-content grep**, inserted after the `README.md` block,
same shape as its neighbours:

```bash
grep -E "^package/dist/browser/tsgit\.js$" "$INVENTORY" >/dev/null || {
  echo "FAIL: tarball missing dist/browser/tsgit.js" >&2
  exit 1
}
```

**Edit (b) — the single-file content assertion**, inserted after the forbidden-content
loop and before the `QUICK` block. Add `BUNDLE=$(mktemp -t tsgit-browser-bundle.XXXXXX)`
beside the existing `INVENTORY=$(mktemp …)` line and add `"$BUNDLE"` to `cleanup()`'s
`rm -f` list.

```bash
# Artefact shape. The browser bundle is the no-build CDN entry: a <script
# type="module"> must fetch it and nothing else. Any surviving module specifier
# means the build re-split and consumers would pay extra round trips.
tar -xzOf "$TARBALL" package/dist/browser/tsgit.js >"$BUNDLE"

if LC_ALL=C grep -aqE '(^|[^A-Za-z0-9_$])import[[:space:]]*[{*'\''"(A-Za-z]' "$BUNDLE"; then
  echo "FAIL: browser bundle contains an import statement — it is not single-file" >&2
  exit 1
fi
if LC_ALL=C grep -aqE '[}][[:space:]]*from[[:space:]]*["'\'']' "$BUNDLE"; then
  echo "FAIL: browser bundle contains a re-export — it is not single-file" >&2
  exit 1
fi
```

**The predicates are pinned and control-validated — do not "simplify" them.** A plain
`from\s*["']` grep produces a **false positive on this very artefact**: the minified
output contains the string literal `"empty from"` immediately followed by
`,Xc="too many seeds"`. The two pinned predicates are import-position
(`\bimport\s*[{*'"(a-zA-Z]`) and re-export-form (`}\s*from\s*["']`), measured as:

| file | import position | re-export form |
| --- | --- | --- |
| the new `dist/browser/tsgit.js` | **0** | **0** |
| `dist/esm/index.browser.js` | 8 | 7 |
| `dist/esm/primitives/index.js` | 3 | 3 |
| `dist/esm/chunks/repository-*.js` | 6 | 6 |

Shell-translation notes: `[[:space:]]` for `\s`; `(^|[^A-Za-z0-9_$])` for `\b` (adding
`$` to the excluded class is strictly safer — `$import` is an identifier, never a real
import); `[}]` rather than `\}` because `\}` in ERE is BSD/GNU-divergent; `LC_ALL=C`
and `-a` because terser output is not guaranteed pure ASCII and macOS grep may
otherwise classify it as binary. Both GNU grep (CI, ubuntu) and BSD grep (macOS)
support `-a`, `-q`, `-E`.

The extraction cannot mask a missing file: edit (a) runs first and exits with its own
message, so `tar -xzOf` is only ever reached for a member that exists.

**Edit (c) — `SIZE_CAP`** (ADR-528, forced: the gate is RED at the current value):

```bash
SIZE_CAP=$((750 * 1024))
```

Rewrite the comment block above it so it explains the new number honestly: dual ESM+CJS
code plus dual `.d.ts`/`.d.cts` types (both structurally required) plus the single-file
browser bundle the CDN path serves; the real pack measures ~656 KiB; the cap sits
~14 % above that — tight by choice. **No ADR/phase/backlog reference in the comment**
(repo rule: provenance lives in the commit, never in source).

Measured: tarball today 538 829 B → with the artefact **671 936 B** (+133 107 B).
Cap 563 200 → **768 000** = 14.3 % headroom. The forbidden `^package/.*\.map$` guard
stays **byte-identical** and must stay green — that green is the proof ADR-527 landed.

#### 3 · `package.json`

**(a) Two top-level CDN fields** (ADR-526), inserted between `"types"` and `"exports"`
(currently lines 30–31). **No `./` prefix** — every in-the-wild package sampled writes
the bare form (`vue` → `dist/vue.global.js`); resolution of a `./`-prefixed value is
unpinned.

```json
  "unpkg": "dist/browser/tsgit.js",
  "jsdelivr": "dist/browser/tsgit.js",
```

Do **not** add an `exports` subpath and do **not** add a top-level `"browser"` field.
Pinned live: both CDNs 404 on an exports-only subpath, so a subpath buys zero CDN
reach; the only attw-green subpath shape resolves `import`/`require` to two different
artefacts under one name; a top-level `"browser"` field changes legacy-bundler
resolution for the whole package.

**(b) `wireit.build:js.output`** (currently `["dist/esm/**","dist/cjs/**","dist/types/**"]`,
lines 241–245) gains `"dist/browser/**"`. Without it wireit neither caches nor cleans
the artefact and a `clean: "if-file-deleted"` build can leave a stale copy behind.

No other wireit edit in this part: `check:size`, `check:tarball`, `check:exports` all
already declare `files: ["dist/**", …]`, and `.gitignore` ignores `dist/` wholesale.

#### 4 · `.size-limit.json`

An array of 10 entries; the last is the `Full library` glob (`dist/esm/**/*.js`,
335 kB). Insert the new entry **before** `Full library` (keep the aggregate last):

```json
  {
    "name": "Browser bundle (no-build)",
    "path": "dist/browser/tsgit.js",
    "limit": "150 kB",
    "gzip": true
  },
```

150 kB against the pinned 136 201 B gzip is ~10 % headroom, matching the per-entry
style already in the file. `Full library` **must stay unchanged at 335 kB** and must
still measure 164 674 B — the artefact lives outside `dist/esm/` precisely so that glob
does not double-count it (ADR-525; placing it inside was measured to burn that budget
from 50.8 % to 10.2 % headroom).

#### Untouched on purpose — do not go hunting

- **`build:js` also runs `node --experimental-strip-types tooling/truthful-dts.ts`**
  after rollup. It enumerates published `(declaration file, runtime module)` pairs by
  walking `package.json`'s **`exports` map** (`tooling/dts-entries.ts`). This part adds
  no `exports` entry and the bundle ships no `.d.ts`, so that step is unaffected.
- **`knip`** (`check:dead-code`) tolerates `package.json` fields pointing into `dist/`:
  `main`, `module`, `types` and the whole `exports` map already do, and the gate is
  green today. `knip.json`'s `project` is `src/**/*.ts`. No `knip.json` edit.
- **CI needs no new job.** The `build` job already runs `npm run build` +
  `npm run check:size` + `npm run check:exports` and uploads `dist/` as the artifact
  every downstream job (integration, runtime-parity, e2e) downloads.
- **`.gitignore`** ignores `dist/` wholesale — `dist/browser/` needs no entry.
- **No `src/` file is edited in this part.** If you find yourself opening one, stop and
  escalate `{ part, reason, ≤3 options }`.

#### Pinned expectations for this part

| property | value |
| --- | --- |
| files fetched by a `<script type="module">` | 1 (was 13) |
| raw bytes | 434 404 |
| gzip-9 | 136 201 (vs 144 813 for the 13-file path as served) |
| named exports | 46, identical set to `dist/esm/index.browser.js` |
| `sourceMappingURL` trailer | absent |
| `node:` references | 0 |
| build cost | +4.2 s on the current ~25.5 s `npm run build` |

**Wireit staleness warning:** a size/tarball failure measured on a cached build is not
trustworthy. `rm -rf dist .wireit` before believing any `check:size` / `check:tarball`
red in this part.

### TDD steps

House vehicle for packaging assertions is `tooling/verify-tarball.sh` (precedent: the
`*.map` forbidden-path grep is the executable spec for a build-flag flip). There is no
vitest tier for this part — a Node integration test reading `dist/` was considered and
rejected: it needs a build-or-skip preamble with a 600 s `beforeAll`, duplicates what
the tarball script already walks, and asserts the weaker property (built, not
*published*).

1. **Baseline.** `rm -rf dist .wireit && npm run build` — a clean, current-config
   build. Confirm `dist/browser/` does **not** exist.
2. **RED (a) + (b).** Apply `verify-tarball.sh` edits (a) and (b) only — *not* the cap.
   Run `bash tooling/verify-tarball.sh --quick`.
   Expected failure: `FAIL: tarball missing dist/browser/tsgit.js`, exit 1.
   (Edit (b) is not reached yet — that is expected; step 5 proves it fires.)
3. **GREEN — the artefact.** Add the third `rollup.config.ts` config object (+ the
   `tsPluginOptions` lift) and `"dist/browser/**"` in `wireit.build:js.output`.
   `rm -rf dist .wireit && npm run build`, then `bash tooling/verify-tarball.sh --quick`.
   Expected **intermediate** failure — the size check runs *before* the inventory greps:
   `FAIL: tarball … is 671936 bytes (cap 563200)`. This is the forced-cap observation,
   not a mistake.
4. **GREEN — the cap.** Apply edit (c) (`SIZE_CAP=$((750 * 1024))` + rewritten comment).
   `bash tooling/verify-tarball.sh` (full, not `--quick`, so attw runs on the tarball).
   Expected: `OK: tarball … verified at 671936 bytes.` — assertions (a) and (b) now both
   pass and the untouched `^package/.*\.map$` guard is still green.
5. **Prove the predicates can fire (control).** Run the exact two greps from edit (b)
   against a code-split file — they MUST match, or the assertion is decoration:

   ```bash
   LC_ALL=C grep -acE '(^|[^A-Za-z0-9_$])import[[:space:]]*[{*'\''"(A-Za-z]' dist/esm/index.browser.js
   LC_ALL=C grep -acE '[}][[:space:]]*from[[:space:]]*["'\'']' dist/esm/index.browser.js
   ```

   Both must report a match (the files are single-line, so `-c` reports 1, not the 8/7
   occurrence counts — a match is what matters). Then re-run the same two greps against
   `dist/browser/tsgit.js` and confirm **no** match.
6. **GREEN — budgets.** Add the `.size-limit.json` entry, then `npx size-limit`.
   Expected: the new `Browser bundle (no-build)` row passes at ~136 kB / 150 kB, and
   `Full library` is unchanged at ~164.7 kB / 335 kB.
7. **GREEN — CDN fields.** Add `unpkg` + `jsdelivr` to `package.json`, then
   `npx attw --pack . --profile node16`. Expected exit 0 — the fields and the extra
   tarball file are both attw-neutral (pinned control row).
8. **Verify the artefact's shape** with the design's reproduction script. Write it via
   heredoc to a throwaway **outside the worktree** (`SHAPE=$(mktemp -t tsgit-shape.XXXXXX).mjs`
   or the session scratchpad — never a file inside the repo, which would show up in
   `git status` and in the commit), run `node "$SHAPE" dist/browser/tsgit.js`, then
   delete it:

   ```js
   import { readFileSync } from 'node:fs';
   import { gzipSync, brotliCompressSync } from 'node:zlib';

   const b = readFileSync(process.argv[2]);
   const s = b.toString('utf8');
   console.log({
     raw: b.length,
     gzip9: gzipSync(b, { level: 9 }).length,
     brotli: brotliCompressSync(b).length,
     importPosition: [...s.matchAll(/\bimport\s*[{*'"(a-zA-Z]/g)].length,
     reExportForm: [...s.matchAll(/}\s*from\s*["']/g)].length,
     sourceMappingUrl: s.includes('sourceMappingURL'),
     nodeRefs: [...s.matchAll(/["']node:[a-z/]+["']/g)].length,
   });
   ```

   Expected: `importPosition: 0`, `reExportForm: 0`, `sourceMappingUrl: false`,
   `nodeRefs: 0`, `raw` ≈ 434 404, `gzip9` ≈ 136 201. A material deviation (>5 %) from
   the pinned bytes means the build differs from the prototype — escalate
   `{ part, reason, ≤3 options }` rather than adjusting the budget to fit.
9. **Export parity.** `node --input-type=module -e "const m = await import('./dist/browser/tsgit.js'); console.log(Object.keys(m).length, typeof m.openRepository, m.isBrowser());"`
   (if the relative specifier does not resolve under `--eval`, pass an absolute
   `file://` URL instead).
   Expected: `46 function false` (46 named exports; `isBrowser()` is false under Node —
   the module imports cleanly in Node because `index.browser.ts` touches no DOM global
   at module scope). If the count is not 46, the input entry or treeshaking changed —
   escalate, do not "fix" by widening the entry (ADR-531 pins the surface).
10. **REFACTOR.** Re-read the three edited files: no duplicated plugin-option literal
    left behind, `terserOptions`/`external`/`treeshake` shared not copied, the
    `SIZE_CAP` comment explains the number without naming an ADR/phase, the two new
    shell blocks match the surrounding `|| { echo …; exit 1; }` house style.

### Gate

Part gate (`<touched-tests>` resolves to **none** — this part touches no vitest-tier
test; its executable spec is the tarball script):

```bash
npm run check:types && ./node_modules/.bin/biome check rollup.config.ts package.json .size-limit.json
```

Part-specific proof (all must be green in the same clean build):

```bash
rm -rf dist .wireit && npm run build \
  && bash tooling/verify-tarball.sh \
  && npx size-limit \
  && npx attw --pack . --profile node16
```

Note `npm run check:types` does not cover `rollup.config.ts` (not in `tsconfig.json`'s
`include`); `npm run build` is that file's type check and is already in the line above.
`biome check` does cover it (`biome.json` `files.includes` carries `"*.ts"` and
`"*.json"`); `tooling/verify-tarball.sh` is not a biome surface and no shell linter is
enabled in `.mega-linter.yml`.

### Commit

```
feat(browser): ship a single-file no-build browser bundle
```

## Part 2 — Prove the bundle loads in one request (e2e)

### Context

**Goal.** A real browser loading `dist/browser/tsgit.js` issues **exactly one**
request for tsgit code (against 13 for the code-split path) and completes an
`init → add → commit → status` round-trip against OPFS through it.

Test-infra-only part: no `src/` delta, no production code. Standalone per the sizing
exception.

**Files touched:**

1. `test/browser/no-build.html` (new)
2. `test/browser/fixtures.ts` (extend)
3. `test/browser/no-build-bundle.spec.ts` (new)
4. `package.json` (`wireit.test:e2e.files`)

**Preconditions.** Part 1 has landed, so `npm run build` produces
`dist/browser/tsgit.js`. If `dist/` is absent, run `npm run build` before any
Playwright invocation.

#### The existing e2e harness — what is already there

- `test/browser/serve.mjs` serves the **repo root** on `127.0.0.1:5181`, maps `.js` to
  `text/javascript`, and defaults `/` to `/test/browser/index.html`. `/dist/browser/tsgit.js`
  resolves with **no server change** — do not touch this file.
- `playwright.config.ts`: `testDir: './test/browser'`, `testMatch: /.*\.spec\.ts$/`
  (a new spec is auto-collected), `timeout: 30_000`, projects `chromium` / `firefox` /
  `webkit`, `webServer` runs `node test/browser/serve.mjs`.
- `test/browser/index.html` is the *code-split* harness: an inline module script
  importing `/dist/esm/adapters/browser/index.js` + `/dist/esm/index.browser.js` into
  `window.__tsgit`, dispatching `tsgit:ready`, plus a second `<script type="module"
  src="/test/browser/parity-scenarios.bundle.js">`. It is the **control** for the
  request-count assertion; leave it unchanged.
- `test/browser/fixtures.ts` exports: `HARNESS_PATH = '/test/browser/index.html'`,
  `waitForTsgitReady(page)` (goto + `waitForFunction` on `typeof window.__tsgit === 'object'`),
  `resetOpfs(page)`, `test` (base extended with a `readyPage` fixture = goto + reset),
  `Author` / `AUTHOR`, `seedRepo(page)`, and re-exports `expect` from `@playwright/test`.
- Existing specs (5 files: `decompression-stream`, `hash-interop`, `opfs-roundtrip`,
  `parity`, `surface-parity`) all consume the `readyPage` fixture. **This spec is the
  first to drive a raw `page`** — `readyPage` is bound to `index.html` and would load
  the wrong harness. Fixtures are lazy, so importing `test` from `./fixtures.js` and
  destructuring `{ page }` never triggers `readyPage`.

#### 1 · `test/browser/no-build.html` (new)

Mirror `index.html`'s structure exactly — same doctype/`lang`/`meta charset` shape —
but import **only** the bundle, and dispatch a distinct event. It must **not** carry
`index.html`'s second `<script src="/test/browser/parity-scenarios.bundle.js">` tag:
this page exists to demonstrate that one URL is the whole dependency, and anything else
on it invites a reader to doubt the count.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>tsgit no-build bundle harness</title>
  </head>
  <body>
    <h1>tsgit no-build bundle harness</h1>
    <p>This page is loaded by Playwright. It imports the single-file browser bundle
      and exposes it as <code>window.__tsgitBundle</code>.</p>
    <script type="module">
      import { isBrowser, openRepository } from '/dist/browser/tsgit.js';

      window.__tsgitBundle = { isBrowser, openRepository };
      window.dispatchEvent(new Event('tsgit:bundle-ready'));
    </script>
  </body>
</html>
```

Lint surfaces: `.ls-lint.yml` constrains `test/**` for `.ts` / `.test.ts` / `.bench.ts`
only — `.html` is unconstrained (`index.html` is the precedent). `.mega-linter.yml`
enables no HTML linter. Biome does not format `.html`.

#### 2 · `test/browser/fixtures.ts` (extend)

Add the no-build twins of `HARNESS_PATH` / `waitForTsgitReady`, immediately after them
so the pair reads together:

```ts
export const NO_BUILD_HARNESS_PATH = '/test/browser/no-build.html';

// Wait until the inline module script in no-build.html has assigned
// `window.__tsgitBundle` from the single-file browser bundle.
export const waitForBundleReady = async (page: Page): Promise<void> => {
  await page.goto(NO_BUILD_HARNESS_PATH, { waitUntil: 'load' });
  await page.waitForFunction(() => {
    return typeof (window as unknown as { __tsgitBundle?: unknown }).__tsgitBundle === 'object';
  });
};
```

Nothing else in `fixtures.ts` changes. `knip` does not scan `test/` (`project` is
`src/**/*.ts`), so these exports carry no dead-code risk.

#### 3 · `test/browser/no-build-bundle.spec.ts` (new)

Model it on `test/browser/opfs-roundtrip.spec.ts`: leading `/// <reference lib="dom" />`,
a file-level docblock, local `interface` shapes for the values crossing the
`page.evaluate` boundary, `test.describe` + `test.step` per git operation.

Structure — **two describes**, because the skip is not uniform:

```ts
test.describe('no-build bundle', () => {
  // request-count, control, isBrowser — no OPFS, runs on all three engines
});

test.describe('no-build bundle OPFS round-trip', () => {
  test.skip(({ browserName }) => browserName === 'webkit', 'OPFS not exposed in Playwright WebKit');
  // init → add → commit → status
});
```

The WebKit skip idiom is copied verbatim from `opfs-roundtrip.spec.ts:35`
(Playwright's headless WebKit does not expose `navigator.storage.getDirectory`).

Request counting — attach the listener **before** `goto`, return the live array:

```ts
const trackDistRequests = (page: Page): ReadonlyArray<string> => {
  const urls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/dist/')) urls.push(request.url());
  });
  return urls;
};
```

Assertions:

1. **One request** — after `waitForBundleReady(page)`: `expect(distRequests).toHaveLength(1)`
   and `expect(distRequests[0]).toContain('/dist/browser/tsgit.js')`. Filtering on
   `/dist/` excludes the harness page itself and any favicon probe.
2. **Control** — a second test that tracks the same way, then `waitForTsgitReady(page)`
   (the `index.html` harness), and asserts `expect(distRequests.length).toBeGreaterThan(1)`
   (13 today). Without this control, assertion 1 would still pass if the harness stopped
   loading tsgit at all.
3. **`isBrowser()` is `true`** from `window.__tsgitBundle` — the runtime detector must
   report browser inside a real page (it reports `false` under Node, per Part 1 step 9).
4. **Round-trip** — mirror `opfs-roundtrip.spec.ts` step-for-step, reading
   `window.__tsgitBundle` instead of `window.__tsgit`: `waitForBundleReady(page)` then
   `resetOpfs(page)`, write `a.txt` on the OPFS root, `openRepository({ rootHandle })`,
   `init` / `add(['a.txt'])` / `commit({message, author: AUTHOR})` / `status()`, dispose
   in a `finally`. Four `test.step`s asserting: `init.initialBranch === 'main'` and
   `init.bare === false`; `add.added` contains `'a.txt'`; `commit.id` matches
   `/^[0-9a-f]{40}$/` and `commit.branch === 'refs/heads/main'`; `status.clean === true`,
   `status.branch === 'refs/heads/main'`, `status.detached === false`, `changes` and
   `untracked` both `[]`.

#### 4 · `package.json` — `wireit.test:e2e.files`

Currently lists `test/browser/index.html` **by name** (not a glob), lines 458–464. Add
`"test/browser/no-build.html"` next to it, or wireit serves a cached-stale e2e result
after the page changes. `test/browser/**/*.ts` already covers the spec and fixtures.

#### Gate surfaces this part moves

- `check:test-pyramid`: the e2e tier (`test/browser/**/*.spec.ts`) goes 5 → 6 files.
  `test-pyramid-budgets.json` sets e2e `target: 5, warnBelow: 3, warnAbove: null` — no
  upper bound, so this passes. The e2e tier appears in **none** of the
  `gwtTitle` / `aaaBody` / `sutNaming` / `sutBindsResult` / `underAssertedUnit`
  heuristic tier lists, so follow the existing `test/browser/*.spec.ts` conventions
  (descriptive Given/When/Then titles, no `sut` variable, no AAA section comments) —
  do **not** import unit-tier conventions here.
- `check:browser-surface` is additive-only (every `Repository` binding must appear in
  *some* browser spec or parity scenario); a new spec can only add coverage.

#### Local execution reality — read before running anything

Only **chromium** is installed on this host (`~/Library/Caches/ms-playwright` has
`chromium-1228` + `chromium_headless_shell-1228`; no firefox, no webkit). CI is the
authority for the full three-engine matrix. Locally:

```bash
npx playwright test --project=chromium test/browser/no-build-bundle.spec.ts
```

The `webServer` block starts `serve.mjs` automatically. `dist/` must already be built.
`test/browser/parity-scenarios.bundle.js` is a wireit output and is **absent from a
fresh worktree** — run `npm run build:parity` once first, otherwise the control test's
`index.html` load 404s on that second script tag. (It is not a `/dist/` URL, so the
control count itself is unaffected either way, but a 404-free harness is one less thing
to explain when a run goes red.)
If the browser or web server cannot start at all, **do not weaken an assertion to make
something green and do not claim a pass** — record that the e2e run is CI-verified,
keep the static gates green, and note it in the commit prep. Escalate as
`{ part, reason, ≤3 options }` only if the spec cannot be written at all.

### TDD steps

1. **RED — the spec exists before its page.** Write `fixtures.ts`'s two new exports and
   the full `no-build-bundle.spec.ts`, but **not** `no-build.html`. Run the chromium
   command above.
   Expected failure: `serve.mjs` answers `/test/browser/no-build.html` with 404;
   `page.goto` **does not throw** on a non-2xx (Playwright returns the response), so the
   failure surfaces as `waitForFunction` timing out at the 30 s test timeout —
   `window.__tsgitBundle` is never assigned. Every test that calls
   `waitForBundleReady` fails (request-count, `isBrowser`, round-trip); the `index.html`
   **control test still passes**, which is exactly right — that asymmetry is the proof
   the control measures the other path and is not coupled to the new page.
2. **GREEN.** Add `test/browser/no-build.html`. Re-run. Expected: all tests pass on
   chromium; the request-count test reports exactly one `/dist/` URL and the control
   reports 13.
3. **RED — prove the request-count assertion is load-bearing.** Move the artefact aside
   (`mv dist/browser/tsgit.js /tmp/tsgit-bundle.bak`), re-run the request-count test:
   the module import 404s, `__tsgitBundle` is never set, the test fails. Restore
   (`mv /tmp/tsgit-bundle.bak dist/browser/tsgit.js`; if the backup is lost,
   `npm run build` regenerates it) and confirm green again. This is the proof the spec
   is wired to Part 1's artefact rather than passing vacuously.
4. **GREEN — wireit.** Add `"test/browser/no-build.html"` to `wireit.test:e2e.files`.
5. **Tier + surface gates.** `npm run check:test-pyramid` and
   `npm run check:browser-surface` — both green (6 e2e files is within budget; the new
   spec only adds `Repository` coverage).
6. **REFACTOR.** The spec must not duplicate `opfs-roundtrip.spec.ts`'s interfaces by
   accident-of-copy — keep the local `BrowserRepo` / bundle interfaces minimal and
   named for *this* file's needs; reuse `AUTHOR`, `resetOpfs`, `waitForTsgitReady`,
   `expect`, `test` from `./fixtures.js` rather than re-deriving them.

### Gate

Part gate (`<touched-tests>` is a Playwright spec, not a vitest project — the vitest
segment resolves to nothing; the e2e run stands in for it and is listed separately):

```bash
npm run check:types && ./node_modules/.bin/biome check test/browser/no-build-bundle.spec.ts test/browser/fixtures.ts package.json
```

Part-specific proof:

```bash
npm run check:test-pyramid && npm run check:browser-surface
npx playwright test --project=chromium test/browser/no-build-bundle.spec.ts   # chromium-only locally; CI runs all three engines
```

`npm run check:filesystem` (ls-lint) is also cheap and worth running once — it is the
gate that would reject a non-kebab-case spec filename.

### Commit

```
test(browser): cover the no-build bundle load path
```

## Part 3 — Document both browser paths

### Context

**Goal.** README and `docs/get-started/browser.md` document the two browser
consumption paths side by side — bundler (unchanged) and CDN/no-build (new) — with a
version-qualified URL a reader can copy and run (ADR-529).

Docs-only part: no `src/` delta, no test delta. Standalone per the sizing exception.

**Files touched:**

1. `README.md` (runtime table)
2. `docs/get-started/browser.md` (new section)
3. `reports/api.json` (regenerated — see the gate note below, this is the part's one
   non-obvious obligation)

#### 1 · `README.md`

The runtime table sits at lines 28–35:

```markdown
| Runtime | Import |
|---|---|
| Node.js 22+ | `@scolladon/tsgit` |
| Browser (OPFS) | `@scolladon/tsgit/auto/browser` |
| In-memory (tests) | `@scolladon/tsgit/auto/memory` |
…
```

Add one row **directly after** `Browser (OPFS)`:

```markdown
| Browser (no build) | `https://unpkg.com/@scolladon/tsgit@3/dist/browser/tsgit.js` |
```

**The URL must stay inside backticks.** `check:doc-links` (lychee) runs over `README.md`
and `docs/**/*.md`; it was probed and does **not** extract URLs from fenced blocks or
inline code spans, but it *does* extract prose links — and a prose link to this path
returns 404 until the release publishes, which exits lychee 2 and turns the gate red on
the PR. No `.lychee.toml` edit is needed or wanted.

Leave the `43 Tier-1 commands` capability line alone — this change adds no command.

#### 2 · `docs/get-started/browser.md`

Current structure: `# Get started — Browser` → `## Prerequisites` → `## Install`
(ends line 17 with the `"exports"` sentence) → `## Open a repository` →
`## Clone a remote` → `## Subdirectory layout` → `## What works in the browser` →
`## What doesn't` → `## Cleanup` → `## What's next` (a table).

Insert a new `## No build step (CDN)` section **between `## Install` and
`## Open a repository`** — the reader must see both paths before being told how to open
a repo. Content:

- One sentence of framing: the package ships a single-file, minified ESM bundle and the
  CDN root URLs resolve to it; one request, whole library, no build step.
- A copy-runnable `html` fence using the **floating major**:

  ````markdown
  ```html
  <script type="module">
    import { openRepository } from 'https://unpkg.com/@scolladon/tsgit@3/dist/browser/tsgit.js';

    const rootHandle = await navigator.storage.getDirectory();
    const repo = await openRepository({ rootHandle });
  </script>
  ```
  ````

- The jsDelivr equivalent in its own `html` fence:
  `https://cdn.jsdelivr.net/npm/@scolladon/tsgit@3/dist/browser/tsgit.js`.
- One line on pinning: `@3` floats to the latest 3.x; for production replace `@3` with
  the exact version you tested against so the URL is immutable and the next release
  cannot re-resolve it. **Do not invent a concrete version number** — the release
  release-please will cut is not knowable at authoring time, and a wrong pin in the docs
  is worse than a described form.
- One line on surface: the bundle exposes the same names as
  `@scolladon/tsgit/auto/browser` (`openRepository`, the runtime detectors, the
  branded-type constructors, the diff/merge constants) and deliberately **not** the
  browser adapter classes or the transport middleware — use the bundler path for those.
- A short *which path do I want* comparison table: install step (npm vs a URL), requests
  for tsgit code (bundler-resolved vs 1), payload (tree-shaken to your imports vs the
  whole library), dependency dedupe (yes vs no), debuggable source (yes vs minified
  only — the bundle ships no sourcemap by design).

Every CDN URL in this file lives inside a code fence or backticks, for the lychee reason
above.

`check:spelling` needs **no `cspell.json` edit** — `unpkg`, `jsDelivr`, `CDN` and
`tarball` are all accepted today (probed against the real `docs/**/*.md` glob, and this
plan plus the design doc already pass `npx cspell`). cspell *does* inspect inline code
and fenced blocks, so a misspelling inside a fence still fails; it rejects the closed-up
spellings of "tree-shaken" and "import map", and rejects "SRI" written out in full —
use the hyphenated / spelled-out forms.

#### 3 · `reports/api.json` — the non-obvious obligation

`typedoc.json` sets `"readme": "README.md"`, and `wireit.docs:json.files` lists
`README.md`. **Any README edit changes `reports/api.json`** — verified: the current
`Browser (OPFS)` row is present verbatim in the committed JSON as `{"kind":"text"…}`
nodes. `check:doc-typedoc` (`git diff --exit-code -- reports/api.json`) is a **prepush**
gate, not a `validate` gate: local `npm run validate` can be green while the push hook
rejects. Regenerate with `npm run docs:json` and **commit the result in this part**.
The diff will be small (README text nodes only) — this change adds no exported symbol,
so there is no typedoc-id churn.

#### Post-release manual verification (for the PR body, not a test)

The CDN root URLs cannot be asserted before the release publishes — they only exist once
the tarball is on npm, and `pkg-pr-new`'s per-PR preview lives on a different origin, so
it verifies tarball *contents* but not `unpkg`/`jsdelivr` field resolution. Carry this
into the PR body as a manual post-release check; do not pretend it into a test:

```bash
curl -sI -o /dev/null -w "%{http_code} %{redirect_url}\n" https://unpkg.com/@scolladon/tsgit
curl -sI -o /dev/null -w "%{http_code} %{redirect_url}\n" https://cdn.jsdelivr.net/npm/@scolladon/tsgit
```

Today these resolve to `dist/cjs/index.cjs` (a `require()`-based file that throws in a
browser); after the release they must resolve to `dist/browser/tsgit.js`.

### TDD steps

Docs-only: the executable specs are the doc gates, and the RED is a real, observed gate
failure — not a rhetorical one.

1. **RED — prove the api.json gate bites.** Edit `README.md` (the new runtime row) and
   run `npm run check:doc-typedoc`.
   Expected failure: `docs:json` regenerates `reports/api.json`, `git diff --exit-code`
   reports a non-empty diff, exit 1. This is the design's Test-strategy table being
   wrong, observed rather than argued.
2. **GREEN.** `npm run docs:json && git add reports/api.json`; re-run
   `npm run check:doc-typedoc` → clean.
3. **RED — prove the lychee constraint.** (Optional but cheap, and it is the reason the
   URL is in backticks.) Temporarily write the README row's URL as a bare prose link,
   run `npm run check:doc-links`: lychee extracts it, gets 404 on the unpublished path,
   exits 2. Revert to the inline-code form and re-run → green. Skip this probe only if
   the network is unavailable; never land the prose-link form.
4. **GREEN — the browser page.** Add the `## No build step (CDN)` section to
   `docs/get-started/browser.md`. Run `npm run check:doc-links` and a **fresh**
   `npx cspell --no-progress "docs/**/*.md" "*.md"` (bypass wireit's cache — a cached
   `check:spelling` can report green over an edit made after the cache entry).
5. **REFACTOR.** Re-read both files as a reader: the two paths are distinguishable in
   one glance, the README row and the `browser.md` section agree on the URL form, every
   CDN URL is still inside a fence or inline code, no invented version number, heading
   levels and table style match the surrounding file (`markdownlint` runs in CI over
   changed markdown; the repo carries no markdownlint config, so match the neighbours
   rather than inventing a style).

### Gate

Part gate — `<touched-tests>` and `<touched-files>` **both resolve to nothing** here:
this part touches no vitest test and no biome surface. `biome.json`'s `files.includes`
is `["src/**","test/**","*.ts","*.json", …]`, which covers only root-level JSON — it
matches neither `README.md`, nor `docs/**/*.md`, nor `reports/api.json`. Verified:
`biome check reports/api.json` and `biome check README.md` each exit **1** with
"No files were processed in the specified paths". So the biome segment is **dropped**,
not made to pass — do **not** paper over it with `--no-errors-on-unmatched` and do
**not** widen `biome.json`'s includes to make the gate literal.

```bash
npm run check:types
```

Part-specific proof:

```bash
npm run check:doc-links \
  && npx cspell --no-progress "docs/**/*.md" "*.md" \
  && npm run check:doc-typedoc
```

`reports/api.json` must be **staged or committed** when `check:doc-typedoc` runs — it
diffs the worktree against the index.

### Commit

```
docs(browser): document the CDN no-build path
```

## Phase-boundary gate

After Part 3, from a clean build (`rm -rf dist .wireit` first — a cached `check:size` /
`check:tarball` can report a stale verdict):

```bash
npm run validate
```

Expected to be green end to end, with these already pre-paid in-part: `check:size`
(Part 1), `check:tarball` (Part 1), `check:exports` (Part 1), `check:test-pyramid`
(Part 2), `check:browser-surface` (Part 2), `check:doc-links` + `check:spelling`
(Part 3). `check:doc-typedoc` is **prepush-only** and was paid in Part 3.

`npm run test:e2e` is not part of `validate`; CI's e2e job over all three engines is the
authority for Part 2's spec, and locally only chromium is installed.

Two `validate` members can go red for reasons that have nothing to do with this change
and must not be "fixed" by touching the plan's surfaces:

- **`check:deps`** flags any outdated dependency (`@cloudflare/workers-types` is
  daily-versioned and flags perpetually). Repo convention is to bump in-PR with
  `npx npm@10 install --save-exact <pkg>@<version>` — never `rm` + regenerate the lock
  (that drops the cross-platform native binaries CI's clean `npm ci` needs).
- **`check:size` / `check:tarball` on a stale `.wireit` cache** — re-measure after
  `rm -rf dist .wireit` before believing either.

Every existing interop test must stay green **unchanged** — there is no git-behaviour
delta here (no `src/` diff, no new command, no changed write path), so no interop
matrix and no `mktemp` git-state probe is owed. An interop test that moves is a
regression signal, not an expected edit.
