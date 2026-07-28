# Design — no-build browser bundle

> Brief: ship a single-file, tree-shaken, minified ESM browser distribution as an
> additional rollup output; expose it through the `package.json` exports/CDN
> fields so a CDN URL resolves to it; extend the size budgets to cover it; and
> document the two browser consumption paths (bundler vs CDN/no-build). Origin:
> loading tsgit in a browser tab from `dist/esm` fans out into 13 module fetches,
> and no no-build browser procedure is documented.
> Status: draft → self-reviewed ×3

## Context

This is a **packaging / build-artefact** change, in the same family as
[bundle-size-optimization](bundle-size-optimization.md) (ADRs 468–470). It adds
one emitted file, two `package.json` CDN fields, one size budget, one raised
tarball cap and two doc sections. It touches **no `src/` behaviour**, changes
**no public API**, and leaves the structured-output policy (ADR-249) untouched —
the bundle re-exports exactly the surface `src/index.browser.ts` already exports.

Section numbering below (§1–§6) is the *design* narrative. The **D1–D7** ids in
[§ Decision candidates](#decision-candidates) are a separate, independent set —
they are not section references.

### Git-faithfulness framing (explicit)

Per `.claude/workflow/faithfulness.md` and ADR-226, the prime directive binds
git's **observable behaviour and on-disk repo state** — object SHAs, refs,
reflogs, state files, refusal conditions. Nothing here touches any of those: no
`src/` diff, no new command, no changed write path. **No interop matrix and no
`mktemp` git-state probe are required for this change** — the empirical pinning
that *is* required is a **packaging matrix** (artefact shape, CDN resolution,
`attw` resolution, size/tarball budgets), pinned below by running the real
tools, exactly as `bundle-size-optimization.md` substituted a size matrix for a
behaviour matrix. Every git-behaviour interop test in the repo stays untouched
and must stay green unchanged.

### What exists today

| Surface | Today |
| --- | --- |
| `rollup.config.ts` | two config objects. #1: multi-entry (11 entry points) → `output: [dist/esm (dir), dist/cjs (dir)]`, terser + treeshake + visualizer, `sourcemap:false`. #2: `dts` → `dist/types/*.d.ts` + `*.d.cts`. `external: [/^node:/]`. |
| `package.json` | `main`→`dist/cjs/index.cjs`, `module`→`dist/esm/index.js`, `types`, a per-subpath `exports` map (`.`, `./auto/*`, `./primitives`, `./commands/*`, `./operators`, `./transport`, `./adapters/*`). **No** top-level `unpkg` / `jsdelivr` / `browser` field. `files: ["dist","LICENSE","README.md"]`, `sideEffects:false`. |
| `.size-limit.json` | 9 per-entry budgets + a `Full library` glob budget on `dist/esm/**/*.js`, limit 335 kB gzip. Run by `check:size` (in `validate` and in CI's `build` job). |
| `tooling/verify-tarball.sh` | `SIZE_CAP=550 KiB`; `npm pack`; size check; required-content greps; forbidden-path greps (incl. `^package/.*\.map$` from ADR-468); `attw --pack` unless `--quick`. Wired as `check:tarball` (quick) in `validate` and `verify:tarball` at tag push. |
| `test/browser/` | Playwright e2e: `serve.mjs` serves the **repo root** on `127.0.0.1:5181`, `index.html` imports `/dist/esm/index.browser.js` + `/dist/esm/adapters/browser/index.js` into `window.__tsgit`, five `*.spec.ts` files use the `readyPage` fixture. |
| `docs/get-started/browser.md` | Documents the **bundler** path only (install from npm, let the bundler resolve the `browser` export condition, `openRepository({rootHandle})`). |
| `README.md` | Runtime table maps `Browser (OPFS)` → `@scolladon/tsgit/auto/browser`. |

### The measured problem

`dist/esm/index.browser.js` is an entry in a **code-split** build: rollup hoists
shared code into `chunks/`, so the browser entry's static import graph is 13
files. Walked on the freshly built `dist/` in this worktree:

| file | bytes |
| --- | --- |
| `chunks/index-*.js` | 227 411 |
| `chunks/write-sparse-checkout-*.js` | 152 794 |
| `chunks/error-*.js` | 23 152 |
| `chunks/repository-*.js` | 15 985 |
| `chunks/browser-http-transport-*.js` | 6 488 |
| `chunks/inflate-*.js` | 6 164 |
| `primitives/index.js` | 5 471 |
| `transport/index.js` | 3 853 |
| `index.browser.js` | 1 890 |
| `chunks/lru-cache-*.js` · `chunks/adapter-detect-*.js` · `chunks/progress-*.js` · `chunks/readable-stream-*.js` | 1 038 · 755 · 532 · 265 |
| **total** | **13 files · 445 798 B raw · 144 813 B gzip-9 summed per file · 115 501 B brotli (concatenated)** |

The **summed per-file** gzip figure is the honest over-the-wire number: a CDN
compresses each response independently, so the 13-file path costs 144 813 B in
13 responses. (Compressing the concatenation as one stream gives 142 104 B — a
number no consumer ever experiences; it is quoted only where a like-for-like
single-stream comparison is meant.)

All 13 specifiers are relative; **zero bare specifiers** (zero-dependency
library), so the graph is self-contained — it is a *request-count* problem, not a
resolution problem. Measured graph depth: **2 levels** — `index.browser.js`
imports all twelve others directly. So a `<script type="module">` pays two
round-trip generations and **13 requests** (1 + 12) before the first line of user
code runs. The cost is request count and per-response overhead against the
browser's per-origin connection budget, not a deep serial chain — stated
precisely so nobody later "fixes" a waterfall depth that does not exist.

`src/` contains **zero dynamic imports** (`grep -rnE "await import\(|=\s*import\("` → empty).
The split exists *only* because the build has 11 entry points sharing code. A
single-entry build therefore yields exactly one file with no `inlineDynamicImports`
gymnastics needed (the flag is still set, defensively, so a future dynamic import
cannot silently re-split the artefact).

## Requirements

1. `npm run build` emits exactly one additional artefact: a single-file,
   minified, tree-shaken **ESM** bundle of the browser entry.
2. The artefact's static import graph is **one file** — zero `import`/`export …
   from` specifiers, zero bare specifiers, no `//# sourceMappingURL=` trailer,
   no `node:` references.
3. The artefact exposes the **same named export set** as
   `dist/esm/index.browser.js` (46 named exports, incl. `openRepository`,
   `detectRuntime`, `isBrowser`, `isNode`, `consoleProgress`, the branded-type
   constructors and the diff/merge constants). No API addition, no API removal.
4. The artefact ships inside the npm tarball, and the package's CDN-root URLs
   (`https://unpkg.com/@scolladon/tsgit`, `https://cdn.jsdelivr.net/npm/@scolladon/tsgit`)
   resolve to it instead of today's CJS `dist/cjs/index.cjs`.
5. A browser page loading the artefact issues **exactly one** network request for
   tsgit code (against 13 today) and completes an `init → add → commit → status`
   round-trip against OPFS.
6. `check:size` carries a gzip budget for the new artefact, and the existing
   `Full library` budget is not silently consumed by it.
7. `npm run validate` is green end to end — in particular `check:exports`
   (`attw --pack --profile node16`), `check:tarball`, `check:doc-links`,
   `check:spelling` and `check:test-pyramid`.
8. **No `.map` ships** for the new artefact: ADR-468's `^package/.*\.map$`
   forbidden-path guard stays unmodified and stays green.
9. README and `docs/get-started/browser.md` document **both** browser paths —
   bundler (unchanged) and CDN/no-build (new) — with a version-qualified URL a
   reader can copy and run.
10. No `src/` diff, no git-observable behaviour change, therefore **no new
    interop test** and no change to any existing one.

## Design

### 1 · The artefact

A **third config object** appended to the array exported by `rollup.config.ts`:

```ts
{
  input: 'src/index.browser.ts',
  output: {
    file: 'dist/browser/tsgit.js',
    format: 'esm',
    sourcemap: false,
    inlineDynamicImports: true,
  },
  external,                 // shared with the other configs
  plugins: [resolve(), typescript({ …same options… }), terser(terserOptions)],
  treeshake: { moduleSideEffects: false, propertyReadSideEffects: false },
}
```

It **must** be a third config object, not a third `output` on config #1: a
`file:`-based single-file output is incompatible with config #1's multi-entry
`input` map, and `inlineDynamicImports` is incompatible with multiple inputs.
That is a rollup structural fact, not a choice.

`external: [/^node:/]` is shared with the other configs. It never fires today
(the artefact has zero `node:` references, measured), and it is safe to keep: if
a future refactor ever pulled a `node:` import into the browser graph, rollup
would emit a literal `import"node:…"` into the artefact — which the single-file
predicate in [§ Test strategy](#a-the-artefact-really-is-single-file--packaging-assertions)
catches as a non-zero import-position count, failing the gate rather than
shipping a browser-broken bundle.

The `visualizer` plugin is deliberately **not** repeated on this config — it
writes a single `reports/bundle-analysis.html`, and a second config writing the
same path would clobber the code-split treemap that `bundle-size-optimization.md`
relies on.

**Pinned artefact matrix** (rollup 4.62.3, `@rollup/plugin-typescript` 12.3.0,
terser via `@rollup/plugin-terser` 1.0.0, same `terserOptions` and `treeshake`
settings as the shipped build):

| property | multi-file (`dist/esm/index.browser.js`, today) | single-file prototype |
| --- | --- | --- |
| files fetched | **13** | **1** |
| raw bytes | 445 798 | **434 404** |
| gzip-9, as served (per file, summed) | 144 813 | **136 201** |
| gzip-9, single stream | 142 104 | **136 201** |
| brotli, single stream | 115 501 | **110 443** |
| physical lines | 2 per file (measured, all 13) | 2 (code + trailing newline) |
| `import`-statement occurrences in output | 8 in the entry, ≥3 in every chunk | **0** |
| `sourceMappingURL` trailer | absent | **absent** |
| `node:` references | none | **none** |
| named exports | 46 | **46** |
| build cost | — | **+4.2 s** on top of the current 25.5 s `npm run build` |

The single-file form is also smaller, not just fewer: **-2.6 % raw** and
**-5.9 % gzip as actually served** (144 813 → 136 201), because the per-chunk
export/import plumbing disappears and terser mangles across what were previously
module boundaries.

Export parity is measured, not assumed: `dist/esm/index.browser.js` carries 46
names across five `export{…}` clauses, and the prototype carries 46 — same count,
same names.

Sanity-checked as valid ESM by importing the prototype in Node
(`await import('…/tsgit.js')` → 46 named exports, `typeof openRepository ===
'function'`, `isBrowser() === false` under Node). It imports cleanly because
`index.browser.ts` touches no DOM global at module scope — the OPFS/SubtleCrypto
adapters are only constructed inside `openRepository`.

**What the artefact does *not* carry** (pinned on the prototype): the browser
adapter classes (`BrowserHttpTransport`, `BrowserCompressor`, `BrowserHashService`)
and the transport middleware (`withRetry`, `withAuth`, `withLogging`) are **not**
among the 46 exports, because `src/index.browser.ts` does not re-export them.
A CDN consumer therefore gets the documented `openRepository({ rootHandle })`
path and nothing more. See decision **D7**.

### 2 · Package exposure — pinned CDN semantics

The brief assumes an exports-map subpath makes a CDN URL resolve. **It does
not.** Pinned live against both CDNs below. (Every URL in this doc is written as
inline code on purpose — see the lychee constraint in
[§ 6 · Documentation](#6--documentation).)

| probe (`curl -sI`) | result |
| --- | --- |
| `https://unpkg.com/vue@3` | `302` → `…/vue@3.5.40/dist/vue.global.js` — exactly the `unpkg` field value |
| `https://cdn.jsdelivr.net/npm/vue@3` | `200` — serves the `jsdelivr` field target |
| `https://unpkg.com/@scolladon/tsgit@3.1.2/auto/browser` (an **exports-only** subpath, no such directory in the tarball) | **404** |
| `https://cdn.jsdelivr.net/npm/@scolladon/tsgit@3.1.2/auto/browser` | **404** |
| `https://unpkg.com/vue@3.5.13/compiler-sfc` (a **real directory** in the tarball) | `301` → `…/compiler-sfc/index.js` — directory-index resolution, not exports resolution |
| `https://cdn.jsdelivr.net/npm/vue@3.5.13/compiler-sfc` | **404** — jsDelivr does not even do directory-index |
| `https://unpkg.com/@scolladon/tsgit@3.1.2/dist/esm/index.browser.js` | `200` — literal tarball paths always work |
| `https://unpkg.com/@scolladon/tsgit@3.1.2` (**today**) | `301` → `…/dist/cjs/index.cjs` (falls back to `main`) |
| `https://cdn.jsdelivr.net/npm/@scolladon/tsgit@3.1.2` (**today**) | `200`, body begins `"use strict";var e=require("./chunks/…")` |

Two conclusions, both load-bearing:

1. **Today's CDN root serves CJS.** A `<script type="module">` pointing at
   `https://unpkg.com/@scolladon/tsgit` fetches a `require()`-based file and
   throws in the browser. Adding the top-level `unpkg` / `jsdelivr` fields is the
   *only* thing that fixes the package's front door.
2. **An `exports` subpath is CDN-invisible.** A `"./browser"` subpath would serve
   bundler users only — and those users are already served by
   `@scolladon/tsgit/auto/browser`. CDN users address the artefact by its
   **literal tarball path**.

Field-value form: every in-the-wild package sampled from the registry writes the
value **without** a `./` prefix (`vue` → `dist/vue.global.js`, `preact` →
`dist/preact.min.js`). Resolution of a `./`-prefixed value is **unpinned**; use
the proven form.

A top-level `"browser"` field is deliberately **not** added: jsDelivr's fallback
chain (`jsdelivr` → `browser` → `main`) is already satisfied by the explicit
`jsdelivr` field, and a top-level `"browser"` field changes legacy-bundler
resolution for the *whole package* — a behaviour change well outside this brief.

**Pinned `attw --pack . --profile node16` matrix** (this is what `check:exports`
runs, and it is in `validate`), measured on a throwaway copy of the package with
the prototype bundle at `dist/browser/tsgit.js`:

| `exports["./browser"]` | node16 from CJS | node16 from ESM | bundler | attw exit |
| --- | --- | --- | --- | --- |
| *absent* (top-level `unpkg`+`jsdelivr` only) | — | — | — | **0** |
| `"./dist/browser/tsgit.js"` (string) | ❌ No types | ❌ No types | ❌ No types | 1 |
| `{ types, default }` | ⚠️ ESM (dynamic import only) | 🟢 | 🟢 | 1 |
| `{ import: { types, default } }` | 💀 Resolution failed | 🟢 | 🟢 | 1 |
| `{ import: {types, default→bundle}, require: {types, default→dist/cjs/index.browser.cjs} }` | 🟢 (CJS) | 🟢 | 🟢 | **0** |

The control row also proves the two new **top-level fields are attw-neutral** and
that the extra file in the tarball is attw-neutral. Only the last row keeps
`check:exports` green — and it does so only by pointing `require` at a
*different artefact* (the code-split CJS entry), which makes
`@scolladon/tsgit/browser` mean two different things by format. See decision **D2**.

### 3 · Budgets — both gates move

**`check:size`.** `.size-limit.json` gains one entry:

```json
{ "name": "Browser bundle (no-build)", "path": "dist/browser/tsgit.js", "limit": "150 kB", "gzip": true }
```

150 kB against the pinned 136 201 B gzip is ~10 % headroom, matching the
per-entry budget style already in the file.

Placing the artefact **outside `dist/esm/`** keeps the `Full library` glob
(`dist/esm/**/*.js`) measuring the code-split library only. Measured both ways:

| `Full library` (`dist/esm/**/*.js`, gzip) | value | budget | headroom |
| --- | --- | --- | --- |
| today | 164 674 | 335 000 | 50.8 % |
| with the bundle placed **inside** `dist/esm/` | **300 875** | 335 000 | **10.2 %** |
| with the bundle at `dist/browser/` | 164 674 (unchanged) | 335 000 | 50.8 % |

**`check:tarball` / `verify:tarball` — this gate goes RED without a cap change.**
The artefact *must* ship in the tarball: unpkg and jsDelivr serve exclusively
from the published npm tarball, so excluding it would make requirement 4
impossible. Measured with `npm pack --dry-run --json`:

| tarball | bytes | vs `SIZE_CAP` (563 200) |
| --- | --- | --- |
| today | 538 829 | pass, **4.3 % headroom** |
| with `dist/browser/tsgit.js` | **671 936** | **FAIL — 19.3 % over** |

Delta `+133 107 B`. The bundle is a near-duplicate of code already in
`dist/esm/`, but gzip's 32 KiB window cannot dedupe across a 1.8 MB tar stream,
so the cost is essentially the artefact's own compressed size. The cap must rise
(**D4**) — that is forced by physics, only the number is a choice.

Note also how little slack the current cap had: 4.3 % headroom, well inside the
"too tight" band ADR-469 itself rejected when it declined 512 KiB. Raising it is
overdue independently of this change.

### 4 · Source map — pinned cost

Emitting a map for this artefact was measured: **2 541 792 B raw / 734 010 B
gzip-9** — *larger than the entire current tarball*. It would take the published
package from 671 936 B to roughly 1.41 MB, a 2.1× blow-up on top of the 1.25×
this change already costs. It would also require narrowing ADR-468's deliberately broad
`^package/.*\.map$` forbidden-path guard to carve out one file, reopening a
decision ratified this month on exactly this trade-off. Flipping
`sourcemap:true` on this output while the TS plugin keeps `sourceMap:false` also
re-raises the plugin warning ADR-468's matrix documented
(`(!) [plugin typescript] … 'sourceMap' compiler option must be set …`).

The design carries `sourcemap:false`; the decision framing is candidate **D3**.

### 5 · Build wiring

`rollup.config.ts` exports an array, so a third config object is produced by the
same `rollup -c` invocation `build:js` already runs — no new script, no second
toolchain. Four mechanical follow-ons:

- `package.json` → `wireit.build:js.output` must gain `"dist/browser/**"`,
  otherwise wireit neither caches nor cleans the new artefact and a
  `clean: "if-file-deleted"` build can leave a stale copy behind.
- `package.json` → `wireit.test:e2e.files` lists `test/browser/index.html`
  by name (not a glob), so the second harness page from
  [§ Test strategy](#b-it-is-loadable-esm-in-a-real-browser-in-one-request--e2e)
  must be added there too, or wireit will serve a cached-stale e2e result after
  the page changes.
- `check:size` and `check:tarball` already declare `files: ["dist/**", …]`, so
  they pick the new path up with no change. `.gitignore` ignores `dist/`
  wholesale, so `dist/browser/` is covered with no edit.
- `.ls-lint.yml` constrains `test/**` only for `.ts` / `.test.ts` / `.bench.ts`;
  the new `.spec.ts` matches the kebab-case `.ts` rule and the new `.html`
  harness page is unconstrained. `biome.json`'s `files.includes` already covers
  `test/**`, so the new spec is linted without a config edit.

CI needs no new job: the `build` job already runs `npm run build` +
`npm run check:size` + `npm run check:exports` and uploads `dist/` as the
artifact every downstream job (integration, runtime-parity, e2e) downloads.

### 6 · Documentation

Two paths, one page each side:

- **README** — the runtime table gains a *Browser (no build)* row pointing at the
  CDN URL form, keeping the existing *Browser (OPFS)* → `/auto/browser` row for
  bundler users.
- **`docs/get-started/browser.md`** — a new *No build step (CDN)* section after
  *Install*, showing a complete page a reader can copy and run:

  ```html
  <script type="module">
    import { openRepository } from 'https://unpkg.com/@scolladon/tsgit@3/dist/browser/tsgit.js';
    const repo = await openRepository({ rootHandle: await navigator.storage.getDirectory() });
  </script>
  ```

  plus the jsDelivr equivalent, and a short *which path do I want* table (bundler
  = tree-shakes to your usage, dedupes with your app's deps; CDN = zero build,
  one request, whole library).

  **Version specifier in the snippet.** The primary example uses `@3` (floating
  major) rather than a concrete version: the docs ship *with* the release, so
  `@3` resolves to a version carrying `dist/browser/` from the moment the page is
  published, whereas a hard-coded `@3.<n>.<n>` written at design time is a guess
  about what release-please will cut. A follow-up line documents the exact-pin
  form and says why production should prefer it (immutable URL, no silent
  re-resolution on the next release). Both forms live inside code fences.

**Two doc-gate constraints, both pinned:**

- `check:doc-links` (lychee) **does not extract URLs from fenced code blocks or
  inline code spans** — probed with a file holding three CDN URLs (one fenced,
  one inline-code, one prose link): lychee reported `1 Total / 1 Unique`, the
  prose link only. That prose link, pointing at a not-yet-published path,
  returned `404` and lychee exited **2**. So CDN URLs must live **inside code
  fences**; a prose markdown link to the new path would turn `check:doc-links`
  red on the PR (the artefact does not exist at that URL until the release
  publishes). If a prose link is ever wanted, it needs a `.lychee.toml` exclude.
- `check:spelling` (cspell) already accepts `unpkg`, `jsDelivr`, `CDN` and
  `tarball` — probed against the real `docs/**/*.md` glob, so **no `cspell.json`
  edit is needed**. It rejects the closed-up spellings of "tree-shaken" and
  "import map", and rejects "SRI" written out in full; the hyphenated / spelled-out
  forms used throughout this doc all pass. cspell inspects inline code spans and
  fenced blocks too, so a package name in backticks is still spell-checked.

The library's **structured-output philosophy (ADR-249) is untouched** — this
change ships no new option, no rendered string, no format flag. It is packaging
only.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| D1 | Artefact path + filename | (a) `dist/browser/tsgit.js` · (b) `dist/esm/tsgit.browser.js` · (c) `dist/tsgit.browser.js` | **(a)** | (b) is measured to burn the `Full library` budget from 50.8 % → 10.2 % headroom and mixes a bundled artefact into the code-split output dir; (c) sits at `dist/` root with no home beside the format directories. (a) gives a self-describing CDN path and leaves the `Full library` budget untouched. Note the tarball cap (D4) must rise under **every** option — that cost is not avoidable by path choice. |
| D2 | `exports` / CDN field shape | (a) top-level `"unpkg"` + `"jsdelivr"` **only**, no new exports subpath · (b) (a) **+** `"./browser"` as `{import:{types,default→bundle}, require:{types,default→dist/cjs/index.browser.cjs}}` · (c) (a) **+** `"./browser"` as a plain string or import-only | **(a)** | Pinned: CDNs ignore `exports` (both 404 on `/auto/browser`), so a subpath buys **zero** CDN reach — it is a bundler alias duplicating the existing `/auto/browser`. (b) is the only subpath shape that keeps `attw` green, and it does so by making one specifier mean two different artefacts by format. (c) is pinned RED (`No types` / `Resolution failed`) and fails `check:exports`. |
| D3 | Sourcemap policy | (a) no map (consistent with ADR-468) · (b) emit but exclude from the tarball · (c) ship a map for this one artefact | **(a)** | Measured: the map is 734 010 B gzip — bigger than the whole current tarball. (c) also requires narrowing ADR-468's broad `*.map` guard. (b) is the exact shape ADR-468 rejected: a `sourceMappingURL` trailer with no map behind it 404s in consumer devtools. |
| D4 | `SIZE_CAP` in `tooling/verify-tarball.sh` (**forced** — the gate is RED at the current value) | (a) 750 KiB (768 000) · (b) 700 KiB (716 800) · (c) 800 KiB (819 200) | **(a)** | Applies ADR-469's own method — `measured × 1.1–1.15`, rounded to a clean KiB boundary — to the pinned 671 936 B: 14.3 % headroom. (b) leaves 6.7 %, the same fragility band ADR-469 rejected when it declined 512 KiB. (c)'s 22 % is loose enough for a real regression to slip under, against ADR-469's tight-by-choice posture. This decision is **orthogonal to D1** — the tarball grows by the same 133 107 B wherever the artefact sits. |
| D5 | Where the docs live | (a) README runtime-table row **+** a *No build step (CDN)* section in `docs/get-started/browser.md` · (b) README only · (c) a new dedicated `docs/get-started/browser-cdn.md` | **(a)** | The browser audience already has one landing page; both paths belong side by side so the reader picks, rather than discovering the second path only from the README. (b) leaves the canonical browser page silently wrong-by-omission. (c) splits one audience across two pages and adds a cross-link surface for `check:doc-links` to police. |
| D6 | Where the bundle build runs | (a) third config object in the existing `rollup.config.ts` array, produced by the current `build:js` · (b) separate `rollup.browser.config.ts` + a `build:browser` wireit script that `build` depends on · (c) separate script **not** in `build`, wired only into `check:size` / CI | **(a)** | One toolchain, one invocation, +4.2 s; `dist/` stays complete after any `npm run build`, which every downstream consumer (e2e, runtime-parity, `npm pack`, the CI `dist` artifact) assumes. (b) buys independent wireit caching at the cost of a second config file duplicating plugin setup. (c) makes `npm run build` produce an incomplete `dist/` — a trap for every consumer listed above. |
| D7 | What the bundle exports | (a) `src/index.browser.ts` as-is — the pinned 46 exports, **no** browser adapter classes, **no** transport middleware · (b) a new bundle-only entry re-exporting `index.browser` + `adapters/browser` + `transport` · (c) two bundles (core + adapters) | **(a)** | Keeps the change packaging-only with zero API surface delta — the CDN artefact is byte-for-byte the same *surface* as the bundler path, so docs and support answers never fork. (b) creates a public surface that exists in no other entry, and pulls `check:doc-coverage` / `check:browser-surface` into a packaging change. (c) reintroduces the multi-request problem this change exists to remove. |

## Test strategy

No interop test: **there is no git-behaviour change to pin** (see
[Git-faithfulness framing](#git-faithfulness-framing)). Every existing interop
test must stay green *unchanged* — that is the regression signal, not a new one.

Three claims need proving.

### (a) The artefact really is single-file — packaging assertions

House precedent for packaging assertions is `tooling/verify-tarball.sh` (ADR-468
made the `*.map` forbidden-path grep the executable spec for a build-flag flip;
ADR-470 wired it to PR cadence via `check:tarball`). Extend the same script:

1. **Required content** — `grep -E "^package/dist/browser/tsgit\.js$"` on the tar
   inventory, alongside the existing `dist/` / `package.json` / `LICENSE` /
   `README.md` assertions.
2. **Single-file content assertion** — extract the artefact from the tarball
   (`tar -xzOf "$TARBALL" package/dist/browser/tsgit.js`) and fail if it contains
   any module specifier.

   **The predicate matters, and a naive one is already wrong.** A plain
   `from "…"` grep produces a **false positive on this very artefact**: the
   minified output contains the string literal `"empty from"` immediately
   followed by `,Xc="too many seeds"`, which a `from\s*["']` pattern happily
   matches. The pinned, control-validated predicate is the pair

   - import position: `/\bimport\s*[{*'"(a-zA-Z]/` → must be **0**
   - re-export form: `/}\s*from\s*["']/` → must be **0**

   measured against both a positive and negative control:

   | file | import position | re-export form |
   | --- | --- | --- |
   | prototype `tsgit.js` | **0** | **0** |
   | `dist/esm/index.browser.js` | 8 | 7 |
   | `dist/esm/primitives/index.js` | 3 | 3 |
   | `dist/esm/chunks/repository-*.js` | 6 | 6 |

   Every code-split file scores ≥3 on both, the bundle scores 0 on both — a true
   zero-baseline assertion with a proven separation, not a threshold.
3. **`.map` guard** — unchanged. The existing broad `^package/.*\.map$` already
   covers the new artefact; it must stay green with no edit, which is itself the
   proof that D3(a) landed.

RED→GREEN: add assertions (1) and (2) against the current build → both fail
(no such file in the tarball). Add the rollup config object → both pass.
Assertion (3) is already green and must stay green with no edit. All three run in
`validate` through `check:tarball --quick` and at tag push through
`verify:tarball`.

*Alternative vehicle considered and rejected:* a Node integration test reading
`dist/browser/tsgit.js`. It would need a build-or-skip preamble (the
`dispose-free-exit.test.ts` idiom, with a `beforeAll` timeout raised to
`600_000` for a cold build) and would duplicate what the tarball script already
walks. The tarball script also asserts the stronger property — that the file is
*published*, not merely *built*.

### (b) It is loadable ESM in a real browser, in one request — e2e

New Playwright spec `test/browser/no-build-bundle.spec.ts` plus a second harness
page `test/browser/no-build.html`:

```html
<script type="module">
  import { openRepository, isBrowser } from '/dist/browser/tsgit.js';
  window.__tsgitBundle = { openRepository, isBrowser };
  window.dispatchEvent(new Event('tsgit:bundle-ready'));
</script>
```

`serve.mjs` serves the repo root and already maps `.js`, so `/dist/browser/tsgit.js`
resolves with **no server change**. The spec asserts, on its own `page.goto`
(not the shared `readyPage` fixture, which is bound to `index.html`):

1. **Request count** — count `page.on('request')` events whose URL contains
   `/dist/`. Expect exactly **1**. A control assertion on the existing
   `index.html` harness page expects **>1** (13 today), so the spec fails if the
   bundle ever silently re-splits *or* if the control stops distinguishing the
   two paths.
2. **Functional round-trip** — `init → add → commit → status` against OPFS from
   `window.__tsgitBundle`, mirroring `opfs-roundtrip.spec.ts` step-by-step
   assertions (40-hex commit id, `refs/heads/main`, `clean === true`).
3. `isBrowser() === true` from the bundle.

Skip on WebKit exactly as `opfs-roundtrip.spec.ts` does
(`test.skip(({browserName}) => browserName === 'webkit', 'OPFS not exposed in Playwright WebKit')`);
the request-count assertion (1) can run on all three engines since it needs no
OPFS.

Tier accounting: `test-pyramid-budgets.json` puts the e2e tier at
`target: 5, warnBelow: 3, warnAbove: null` — no upper bound, so 5 → 6 spec files
is fine. The e2e tier is **not** listed in the `gwtTitle` / `aaaBody` /
`sutNaming` / `sutBindsResult` heuristic tiers, so the Playwright spec follows
the existing `test/browser/*.spec.ts` conventions rather than the unit-tier
Given/When/Then + `sut` rules.

`check:browser-surface` is additive-only (it asserts every `Repository` binding
appears in *some* browser spec or parity scenario); a new spec can only add
coverage, never remove it.

### (c) It stays within budget — existing gates, extended

| gate | expectation | pinned basis |
| --- | --- | --- |
| `check:size` — new `Browser bundle (no-build)` entry | pass at 136 201 B against a 150 kB limit | measured on the prototype |
| `check:size` — `Full library` | **unchanged** at 164 674 / 335 000 | measured; the artefact is outside the glob under D1(a) |
| `check:tarball` / `verify:tarball` | pass at 671 936 B against the raised cap | measured via `npm pack --dry-run --json`; RED at today's 563 200 |
| `check:exports` (`attw --pack --profile node16`) | exit 0 | pinned control row: top-level fields + extra file are attw-neutral |
| `check:doc-links` (lychee) | pass | pinned: fenced/inline code URLs are not extracted |
| `check:spelling` (cspell) | pass | pinned: `unpkg`, `jsDelivr`, `CDN`, `tarball` all accepted |
| `check:dead-code` (knip) | pass | `src/index.browser.ts` is already a knip entry; no new source file |
| `check:doc-typedoc` (`reports/api.json` diff, pre-push) | **no diff to commit** | typedoc reads `src/`, which this change does not touch |

### Reproduction commands (re-run to re-pin)

Artefact shape — write this as a throwaway ESM script (heredoc, not `node -e`,
so the regexes need no shell escaping) and run it against the built artefact:

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

Budgets and resolution:

```bash
npm run build
npx size-limit --json
npm pack --dry-run --json
npx attw --pack . --profile node16
```

CDN semantics (post-release only):

```bash
curl -sI -o /dev/null -w "%{http_code} %{redirect_url}\n" https://unpkg.com/@scolladon/tsgit
curl -sI -o /dev/null -w "%{http_code} %{redirect_url}\n" https://cdn.jsdelivr.net/npm/@scolladon/tsgit
```

The CDN probes cannot be asserted in CI before the release publishes — the URLs
only exist once the tarball is on npm. `pkg-pr-new` publishes a preview build per
PR to a separate origin, so it verifies the *tarball contents* but not the
unpkg/jsDelivr field resolution. That last hop is a **post-release manual
verification**, listed as such in the PR body rather than pretended into a test.

## Out of scope

- **A UMD / IIFE global build** (`<script src=…>` without `type="module"`,
  setting `window.tsgit`). Requirement 1 says ESM; a classic-script global is a
  second artefact with its own budget and its own naming decision.
- **A single-file Node bundle.** Node consumers install from npm and get
  code-splitting benefits; there is no request-waterfall problem to solve.
- **Publishing sourcemaps out of band** to a separate store — already declared
  out of scope by ADR-468 and unchanged here.
- **Integrity (`integrity="sha384-…"`) hashes in the docs.** The hash changes
  every release and cannot be written at doc-authoring time; documenting a stale
  one is worse than documenting none.
- **An import-map-based multi-file CDN recipe.** It solves the resolution problem
  we do not have (zero bare specifiers) and not the request-count problem we do.
- **Any public API change**, any new command option, any rendered-output surface.
  ADR-249 stands untouched: this change ships bytes, not behaviour.
- **Dropping the CJS or `.d.cts` outputs** to claw back tarball space — both are
  structurally required (`exports` `require` conditions; `attw --profile node16`),
  as established by `bundle-size-optimization.md`.
