# Design — bundle-size-optimization: drive the npm tarball back toward the floor

> Brief: the v2/v3 compressed npm tarball grew to ~1.1 MB (from ~220 KiB at
> v1.0) as the feature set landed, so the `verify:tarball` cap was relaxed 10×
> (to 7680 KiB / ~7.5 MiB) as a generous temporary ceiling. Drive it back down:
> verify minify + tree-shaking are effective across both ESM/CJS outputs, audit
> the npm `files` set for redundant artefacts (source maps, duplicate
> format/type emission), measure per-module contribution, then re-tighten the
> `tooling/verify-tarball.sh` cap once optimized. Honours the "dist must be the
> smallest possible" principle.
> Status: draft → self-reviewed ×3 → decisions ratified → reconciled against
> ADRs 468–470. D1/D2/D4/D5 adopted as recommended; **D3 deviated** — the
> re-tightened cap is now enforced in the per-PR gate in this change (ADR-470),
> not deferred to a follow-up. See [§ Decision candidates](#decision-candidates).

## Context

This is a **packaging / build-artefact** change. It touches only what ships in
the npm tarball and the guard that measures it — no `src/` behaviour, no
git-observable state. The prime directive (CLAUDE.md, ADR-226) binds git's
*observable behaviour* (object SHAs, refs, reflogs, on-disk state files,
refusal conditions); source-map emission and the `files` allowlist are **not
git-observable** — no interop matrix is required here (see [Git-faithfulness
framing](#git-faithfulness-framing)). The empirical work is instead a **size
matrix**, pinned by re-running `npm pack` and `gzip -9` on the built `dist/`.

### The change surface

| File | Role | What may change |
| --- | --- | --- |
| `rollup.config.ts` | two code outputs (esm→`dist/esm/*.js`, cjs→`dist/cjs/*.cjs`), both `sourcemap: true`; a second config emits dts (`.d.ts` + `.d.cts`). The TS plugin sets `sourceMap: true`. `visualizer` writes `reports/bundle-analysis.html` (gitignored, unshipped). | flip `sourcemap` (D1) |
| `tooling/verify-tarball.sh` | bash guard: `SIZE_CAP=$((7680 * 1024))`; `npm pack`; size check; required-content grep; forbidden-path grep; `attw --pack`. | lower `SIZE_CAP` (D2); rewrite the stale comment (no provenance refs); add a `*.map` forbidden-path guard (D5) |
| `package.json` | `files: ["dist","LICENSE","README.md"]`; large per-subpath `exports` map; `sideEffects:false`; `@rollup/plugin-terser` present. | `files` negation only under D1(b) |
| `tsconfig.build.json` | `declarationMap:true`, `sourceMap:true` — feeds tsc-side, but the rollup TS plugin overrides (`declarationMap:false`, `sourceMap:true`) and the `dts` plugin emits types with no maps, so these two flags are **vestigial for the shipped build**. | optionally drop the vestigial flags (D4) |
| `.size-limit.json` | per-entry gzip budgets on `dist/esm/**` (measures `.js` only — unaffected by maps); "Full library" budget 335 kB. | no change needed |

### Enforcement wiring (measured)

- `verify:tarball` is **not** in the `validate` wireit dependency list *today* —
  it runs only on tag-push CI. `check:size` (size-limit) and `check:exports`
  (attw `--pack`) **are** in `validate`. Per ADR-470 (D3 deviation) this change
  adds a **third slice**: a lightweight tarball-size + `*.map` forbidden-path
  check wired into the per-PR gate, so cap + map regressions surface at the PR
  that introduces them — the tag-push `verify:tarball` is retained on top (it
  still guards the published artefact and owns the `attw` resolution check).
- The per-PR check must **not** re-run `attw` — that stays with the existing
  `check:exports` (attw `--pack`) to avoid a double-attw. It asserts only the
  compressed-tarball size cap (D2) and the `*.map` forbidden-path guard (D5).
- There are **no vitest tests** for packaging; the executable spec is the bash
  guard itself.
- `dist/` is gitignored (`.gitignore:5`). Source maps are pure build artefacts,
  never committed — excluding them from the tarball changes nothing in-repo.
- There is **no `.npmignore`**; the `files[]` allowlist is the sole gate on
  tarball contents.

## Problem — the measured baseline

Re-measured in this worktree against the already-built `dist/` (`npm pack
--dry-run`, `gzip -9` per group). All numbers are reproducible via the commands
in [§ Test plan](#test-plan).

**`npm pack` today:** 135 files · compressed **1029 KiB** · unpacked 3251 KiB.

Uncompressed `dist/` by extension:

| ext | KiB | files |
| --- | --- | --- |
| `.js` (ESM code) | 461 | 24 |
| `.js.map` | 752 | 24 |
| `.cjs` (CJS code) | 491 | 24 |
| `.cjs.map` | 753 | 24 |
| `.d.ts` (ESM types) | 384 | 18 |
| `.d.cts` (CJS types) | 384 | 18 |

No `.d.ts.map` / `.d.cts.map` is emitted (the `dts` plugin generates no
declaration maps) — confirmed by `find dist -name '*.d.ts.map'` → empty.

**gzip-9 contribution to the 1029 KiB compressed payload:**

| group | KiB | share | lever |
| --- | --- | --- | --- |
| source maps (`.js.map` + `.cjs.map`) | 547 | 53% | **dominant — remove entirely** |
| code (`.js` + `.cjs`, ESM + CJS both shipped) | 295 | 28% | already minified; irreducible without a breaking API change |
| types (`.d.ts` + `.d.cts`) | 187 | 18% | dual-emit is required for attw `node16`; irreducible |

**The entire optimization is one lever: stop shipping source maps.** Removing
the map group drops the compressed tarball to ~482 KiB (code + types), a
**~2.1× reduction**. Code and types are both structurally required at their
current size (see [§ Non-goals](#non-goals)) — there is no second lever.

### Why code + types cannot shrink further (the backlog "audit the files set" ask)

The brief asks to audit the `files` set for **duplicate format/type emission**.
Both duplications are load-bearing, not redundant:

- **Dual ESM + CJS code** (`.js` + `.cjs`): the `exports` map carries `require`
  conditions for every subpath (`package.json:38,55,64,...`). `require()`
  consumers resolve to `dist/cjs/*.cjs`. Dropping CJS is a **breaking API
  change** for CJS callers — out of scope.
- **Dual `.d.ts` + `.d.cts` types**: required for `attw --profile node16` dual-
  format resolution. A CJS consumer resolving `require("@scolladon/tsgit")`
  must land on a `.d.cts` whose relative imports use `.cjs`, else attw reports
  "Masquerading as ESM" and `check:exports` fails (the rationale is documented
  inline at `rollup.config.ts:85-88`). Dropping `.d.cts` breaks `check:exports`
  — out of scope.

So the honest floor while shipping a **dual-format** package is **code + types
≈ 482 KiB compressed**. The old ~220 KiB v1 floor is **unreachable** — v1 was
smaller because it shipped fewer commands, not because it shipped less
redundancy. This is stated plainly so the re-tightened cap (D2) is set against
the real floor, not a nostalgic one.

## Minify + tree-shaking are already effective (verification, per the backlog ask)

The brief explicitly asks to *verify* minify + tree-shaking across both outputs.
They are already configured and applied to **both** esm + cjs (a single shared
plugin list in `rollup.config.ts:58-77`, so the `terser` + `treeshake` settings
apply to every output object). Verified effective:

- **Minify (terser, `passes:2`, `format.comments:false`):** `dist/esm/index.js`
  is **2 physical lines** (the code line + the `//# sourceMappingURL=` trailer)
  and 13 833 bytes with mangled short identifiers
  (`export{d as detectRuntime,i as isBrowser,...}`). No whitespace, no comments.
  The `.cjs` output is likewise single-line. → minify is working on both.
- **Tree-shaking (`treeshake.moduleSideEffects:false`,
  `propertyReadSideEffects:false`, plus `sideEffects:false` in `package.json`):**
  entry files are tiny because dead code is dropped and shared code is hoisted
  into `chunks/` — `size-limit` reports the main entry at **5 kB gzip**, facades
  at **1 kB**, adapters **0–1 kB**. The "Full library" (`dist/esm/**/*.js`,
  chunks included) is **152 kB gzip**, comfortably under the 335 kB budget. →
  tree-shaking is working.

**Conclusion (expected, now documented): minify + tree-shaking are already
effective; no code-shrinking work is warranted.** The design records this so a
future reader does not re-open a closed question. The only artefact bloat is
the source maps, which minify/tree-shake do not touch.

## Per-module contribution (the backlog "measure per-module" ask)

Two instruments already exist; both are used here, no new tooling required:

1. **`rollup-plugin-visualizer`** writes a gzip-sized **treemap** to
   `reports/bundle-analysis.html` on every build (gitignored, unshipped —
   confirmed present after build). This is the interactive per-module view.
2. **`.size-limit.json`** pins per-entry gzip budgets and runs in `validate`
   via `check:size`.

Measured per-entry (ESM, gzip) and the dominant shared chunks:

| entry / chunk | gzip |
| --- | --- |
| Core (`index.js`) | 5 kB |
| Facades (`index.node.js` / `index.default.js`) | 1 kB each |
| Primitives / Operators / Transport | 1–2 kB each |
| Node / Browser / Memory adapters | 0–1 kB each |
| **Full library** (`dist/esm/**/*.js`) | **152 kB** |
| chunk `index-*.js` (shared command/primitive core) | **69 kB** |
| chunk `write-sparse-checkout-*.js` | **41 kB** |
| chunk `error-*.js` | 6 kB |
| remaining 10 chunks | ≤5 kB each |

The weight lives in two shared chunks (`index-*` 69 kB + `write-sparse-checkout-*`
41 kB = 110 kB of the 152 kB ESM total). These are the real command surface —
they are minified and tree-shaken; there is no dead weight to cut. This table
is the answer to "measure per-module contribution": **the code is already at
its floor; the map artefacts are the only slack.**

## Git-faithfulness framing

Per `.claude/workflow/faithfulness.md`: the prime directive binds git's
observable behaviour and on-disk repo state. This change ships **no** `src/`
diff — it flips a build flag, lowers a size cap, and adds a forbidden-path
grep. Nothing here alters an object SHA, a ref, a reflog, a state file, or a
refusal condition. **No interop matrix and no `mktemp` state probe are
required.** The empirical pinning that *is* required is the **size matrix**
above (reproduced in [§ Test plan](#test-plan)), which stands in for the usual
behaviour matrix.

## Decision candidates

Load-bearing choices for the ADR conversation. **Now ratified** — the options
trail is kept for provenance, but each decision below states its settled
outcome. D1/D2/D4/D5 landed as recommended; **D3 deviated** (PR-gate-now, not
tag-push-only). See ADRs 468 (D1 + D4 + D5), 469 (D2), 470 (D3).

### D1 — Source-map handling

The dominant lever (547 KiB, 53%). *How* to stop shipping maps:

- **(a) No-emit in the shipped rollup build** — set `sourcemap: false` on both
  code outputs (`rollup.config.ts:42,51`) **and** `sourceMap: false` in the TS
  plugin `compilerOptions` (`rollup.config.ts:66`). Rollup then writes **no
  `.map` files and no `//# sourceMappingURL=` trailer** — the two move together
  automatically, so no consumer devtools 404. One-line-per-output; the `files`
  allowlist needs no change (maps simply cease to exist). **Both** flags are
  required: the output `sourcemap` is the sole authority for the shipped map +
  trailer (empirically pinned — output `sourcemap:false` alone suppresses both),
  but leaving the TS plugin's `sourceMap:true` while the output is `false` makes
  `@rollup/plugin-typescript` emit a build **warning** on every build:
  `(!) [plugin typescript] @rollup/plugin-typescript: Rollup 'sourcemap' option
  must be set to generate source maps.` — so the TS-plugin flag must be flipped
  too, for a clean build, not merely for tidiness.
- **(b) Emit-but-exclude** — keep `sourcemap: true`, exclude `.map` from the
  tarball via a `files` negation (or a new `.npmignore`) **and** strip the
  `//# sourceMappingURL=` trailer from every shipped `.js`/`.cjs`. This is
  strictly more moving parts: `files: ["dist"]` cannot negate a glob cleanly
  (npm `files` negation is `!dist/**/*.map`-style and brittle across npm
  versions), terser's `format.comments:false` does **not** strip the
  sourceMappingURL trailer (rollup appends it *after* terser), so a post-build
  `sed`/rollup-plugin step is needed. If the trailer is left in while the map
  is excluded, consumer devtools 404 on the missing map — a regression.
- **(c) Keep shipping maps** (status quo) — rejected: it is the entire 53%
  bloat; there is no consumer benefit to shipping maps for a minified library
  whose sources are on GitHub.

**Ratified: (a)** (ADR-468, as recommended). It removes the map files *and* the
trailer atomically in one flag flip, needs no `files`/`.npmignore` surgery, and
cannot leave a dangling trailer. (b) reintroduces the exact 404 footgun the
brief warns about and buys nothing — maps aren't committed, so keeping them
emitted has no repo value. If maps are ever wanted for a debug artefact, they
can be published to a separate sourcemap store out of band; that is not this
change.

### D2 — New `SIZE_CAP` value

Method: measure the post-optimization `npm pack` size, set
`cap = measured × ~1.1–1.15` headroom, round to a clean KiB boundary.

Measured basis: the projected no-maps tarball (exact file set, `gzip -9`) is
**489 KiB (501 178 bytes)**. The true `npm pack` number will land a little
different (npm's tar framing ≠ BSD tar), so the cap must be re-measured against
a real post-D1 `npm pack` before commit — but the projection is the anchor.

- **512 KiB (524 288)** — only ~4.7% over 489; too tight, a single new command
  could bust it and force another cap bump. Rejected as fragile.
- **550 KiB (563 200)** — ~12% headroom over 489. Absorbs a few commits' worth
  of growth before the guard fires; still a **13.6× tightening** from the
  current 7680 KiB. **Recommended.**
- **600 KiB (614 400)** — ~23% headroom; safe but loose enough that meaningful
  regressions slip under it. A reasonable alternative if the team wants a wider
  buffer between size-review cycles.

**Ratified: 550 KiB (563 200 bytes)** (ADR-469, as recommended), contingent on
the real post-D1 `npm pack` measuring ≤ ~500 KiB (re-measure at implement time;
if it lands higher, scale the cap by the same 1.1–1.15 rule and note it).
Honest-floor caveat baked into the rewritten comment: dual ESM+CJS shipping puts
the code+types floor at ~482 KiB, so the ~220 KiB v1 floor is unreachable — the
cap is set against the real floor, not the v1 one.

### D3 — Enforcement cadence

Should the re-tightened cap run in **PR CI** or stay **tag-push-only**?

- **(a) Status quo — tag-push-only.** `verify:tarball` stays out of `validate`;
  the cap is checked at release. Cheapest (no per-PR pack), but a size
  regression is invisible until release, and a busted cap blocks the release
  rather than the PR that caused it.
- **(b) Wire `verify:tarball` into `validate` (or a dedicated PR CI job).**
  Every PR packs + size-checks + attw-checks. Catches regressions at the PR
  that introduces them. Cost: `validate` already runs `check:exports`
  (`attw --pack .`) and `check:size` (size-limit) — so wiring the full
  `verify:tarball` **double-packs and runs `attw` twice** (verify-tarball's `attw`
  vs `check:exports`, and its size check vs `check:size`). Overlap noted.
- **(c) Add only the *size + forbidden-path* assertions to a lightweight PR
  gate**, leaving attw to the existing `check:exports`. Catches the regression
  this change guards (maps returning, tarball bloat) at PR time without the
  double-attw. Slightly more wiring than (a); avoids (b)'s redundancy.

**Ratified: (c) — lightweight PR gate now** (ADR-470, option 1; this
**deviates** from the design's original tag-push-only recommendation). The
user's standing no-follow-ups delivery default lands the full guard in this
change rather than deferring PR-time enforcement. The per-PR check asserts the
*compressed-tarball size cap* (D2) and the *`*.map` forbidden-path guard* (D5);
it deliberately leaves `attw` resolution to the existing `check:exports` — so no
double-attw (that was option (b)'s cost). The tag-push `verify:tarball`
invocation is **retained** on top: it still guards the published artefact at
release and owns the `attw --pack` resolution check. So option (a)'s tag-push
guard stays *and* the option (c) lighter check is added at PR cadence — the
`*.map`/size regressions are caught at the PR that introduces them.

*(Superseded original recommendation, kept for provenance: "(a) status quo for
this change, note (c) as the natural follow-up" — the concern was the overlap
cost of promoting the cap to PR CI; ADR-470 resolves it by scoping the per-PR
check to size + forbidden-path only, which does not duplicate `check:exports`.)*

The **exact wiring point** is an open planning detail: either add a
`verify:tarball` wireit dependency to `validate` (reusing the existing script,
but it must be reduced to *not* re-run attw at PR cadence to avoid the
double-attw), or add a dedicated lightweight script/CI job that packs once and
runs only the size + `*.map`-inventory assertions. The invariant fixed here is
*the cap + map guard run per PR*; which vehicle carries them is settled in
planning.

### D4 — Drop the vestigial `sourceMap`/`declarationMap` from `tsconfig.build.json`?

`tsconfig.build.json` sets `declarationMap:true` + `sourceMap:true`, but the
shipped build is produced by rollup (TS plugin overrides `declarationMap:false`,
`sourceMap:true` inline) and the `dts` plugin (no maps). So these two flags do
**not** feed the shipped artefacts — they would only matter to a raw `tsc`
emit, which the build does not use.

- **(a) Leave them.** Zero risk; but they falsely imply the shipped build emits
  declaration maps, and under D1(a) they contradict the new no-maps intent.
- **(b) Drop both flags** (or set false) to make the config honestly reflect
  "no maps shipped." Small clarity win; must first confirm no other consumer of
  `tsconfig.build.json` (typedoc `docs:json`, the parity bundle builder) relies
  on them — a quick grep at implement time.

**Ratified: (b), guarded** (ADR-468, as recommended). Align the config with the
no-maps decision so a future reader isn't misled — after confirming
`docs`/`docs:json`/`build:parity` don't depend on tsc-side maps.

**Guard result (grepped at revision time):** the only non-build consumer of
`tsconfig.build.json` is **typedoc** (`typedoc.json:20` →
`"tsconfig": "./tsconfig.build.json"`, driving `docs`/`docs:json`). Typedoc uses
that tsconfig for entry-point resolution and type analysis — it emits its own
JSON/HTML API docs, **not** `.js.map`/`.d.ts.map`, and does not read
`sourceMap`/`declarationMap` to produce map artefacts. `build:parity` does
**not** read `tsconfig.build.json` at all (it runs
`tooling/build-parity-bundle.ts`, which emits its own
`parity-scenarios.bundle.js.map` independently). **Conclusion: dropping both
flags is safe** — no consumer relies on tsc-side maps, so (b) lands clean and no
"why"-comment fallback is needed. (Planning still re-confirms with a live
`docs:json` run.)

### D5 — Regression guard: `*.map` forbidden-path check

Add `"^package/.*\.map$"` (or `\.map$`) to the forbidden-path loop in
`verify-tarball.sh:52`, so source maps can never silently return to the tarball
after D1. **Not really optional** — it is the executable spec that makes D1
durable. Listed as a decision only for the exact pattern:

- **(a) `"^package/.*\.map$"`** — matches any `.map` anywhere under `package/`.
  Broad and future-proof (catches `.d.ts.map` too, should the dts plugin ever
  start emitting them). **Recommended.**
- **(b) `"^package/dist/.*\.(js|cjs)\.map$"`** — narrower, matches only the two
  known code-map kinds. More precise but misses a future `.d.ts.map`.

**Ratified: (a)** (ADR-468, as recommended). No legitimate `.map` belongs in the
published tarball of a minified library; the broad pattern is the correct guard
and self-documents the intent. This same `*.map` forbidden-path assertion is
reused by the per-PR gate (D3 → ADR-470), so the guard fires at both cadences.

## Test plan (TDD framing)

This is build-config + a bash script with no vitest surface. Each slice gets a
red→green via the **bash guard as the executable spec** — the enhanced
`verify-tarball.sh` assertions are the test; the rollup change is the
implementation that makes them pass.

**Slice 1 — regression guard (D5), RED→GREEN as the spec-first step**

- RED: add the `*.map` forbidden-path assertion to `verify-tarball.sh` and run
  `npm run verify:tarball` against the **current** (map-shipping) build → the
  new grep fires, script exits 1 (`FAIL: tarball contains forbidden path
  matching ...map`). This is the executable proof that maps are present today.
- GREEN: apply D1 (`sourcemap:false`), rebuild, re-run → no `.map` in the
  inventory, assertion passes.

**Slice 2 — lowered cap (D2), RED→GREEN**

- RED: lower `SIZE_CAP` to the D2 value against the **current** build → the
  1029 KiB tarball exceeds the ~550 KiB cap, script exits 1
  (`FAIL: tarball ... bytes (cap ...)`).
- GREEN: with D1 applied, the tarball is ~489 KiB < cap → passes. Re-measure
  the real `npm pack` and confirm the cap × headroom holds; adjust the cap
  number if the real pack differs from the 489 KiB projection.

**Slice 3 — per-PR gate wiring (D3 → ADR-470), RED→GREEN**

The cap + `*.map` guard must fire at PR cadence, not just tag-push. Wire the
lightweight size + `*.map` forbidden-path check into the per-PR gate
(`validate`/CI) — the exact vehicle (a `verify:tarball` wireit dep on `validate`
reduced to skip attw, vs a dedicated lightweight pack-once script/CI job) is the
open planning detail; the invariant is *the cap + map guard run per PR*, without
re-running attw (that stays with `check:exports`).

- RED: wire the per-PR check against the **current** map-shipping build and run
  `npm run validate` → the check packs, sees the 1029 KiB tarball over the
  ~550 KiB cap **and** `.map` files in the inventory → `validate` exits 1. This
  is the executable proof that the PR gate now catches both the size and map
  regressions this change guards.
- GREEN: with D1 + D2 applied, `npm run validate` packs ~489 KiB < cap with no
  `.map` in the inventory → the per-PR check passes and `validate` is green.

So **stricter guard (script + per-PR wiring) + old rollup = RED; rollup change =
GREEN** across all three slices — a genuine failing-first sequence at both the
tag-push and per-PR cadences, not a rubber stamp.

**Reproduction commands (the size matrix — re-run to pin):**

```bash
npm run build
npm pack --dry-run --json          # → entryCount, size (compressed), unpackedSize
# per-group gzip-9 contribution:
{ find dist -name '*.js.map'; find dist -name '*.cjs.map'; } | xargs cat | gzip -9 | wc -c
{ find dist -name '*.js' ! -name '*.js.map'; find dist -name '*.cjs' ! -name '*.cjs.map'; } | xargs cat | gzip -9 | wc -c
{ find dist -name '*.d.ts'; find dist -name '*.d.cts'; } | xargs cat | gzip -9 | wc -c
npx size-limit --json              # per-entry gzip
```

**Rollup source-map behaviour matrix (pinned, `rollup 4.62.2` + `@rollup/plugin-typescript 12.3.0`):**

| output `sourcemap` | TS plugin `sourceMap` | `.map` emitted | trailer emitted | build warning |
| --- | --- | --- | --- | --- |
| `true` (status quo) | `true` | yes | yes | none |
| `false` | `true` | **no** | **no** | `(!) ... Rollup 'sourcemap' option must be set to generate source maps.` |
| `false` | `false` | **no** | **no** | none ← **D1a target** |

Confirmed by an isolated rollup run: output `sourcemap:false` alone suppresses
both the `.map` file and the `//# sourceMappingURL=` trailer atomically; the TS
plugin flag only governs the warning. This is the empirical basis for D1a.

**Does the sub-1MB story stay green under the existing gates?**

- `check:size` (in `validate`) measures `dist/esm/**/*.js` **gzip** only — it
  never looked at maps, so removing maps is **neutral** for it. "Full library"
  stays at 152 kB < 335 kB budget. Green, unchanged.
- `check:exports` (attw `--pack`, in `validate`) resolves types/exports — maps
  are irrelevant to it; removing them does not affect resolution. Green,
  unchanged. (Types dual-emit stays intact per [§ Non-goals](#non-goals), so
  attw's `node16` profile stays satisfied.)
- `verify:tarball` (tag-push) is the gate that actually tightens: lower cap +
  `*.map` forbidden-path. Both are exercised by the RED→GREEN slices above.
- The **per-PR gate** (D3 → ADR-470) newly runs the lightweight size + `*.map`
  check: it adds one `npm pack` per `validate` run but does **not** re-run attw
  (that stays with `check:exports`), so no double-attw. Exercised by slice 3.

No existing gate regresses. The *new* enforcement is the lowered cap + `*.map`
forbidden-path assertion (in `verify-tarball.sh`, at tag-push) **and** the
lightweight size + `*.map` check newly wired into the per-PR gate.

## Non-goals

- **Dropping CJS output** (`.cjs`) — breaking API change for `require()`
  consumers; the `exports` map's `require` conditions depend on it. Out of
  scope; documented here so it is not re-litigated.
- **Dropping `.d.cts` types** — required for attw `node16` dual-format
  resolution (`check:exports` would fail). Out of scope.
- **Shrinking the code** — already minified (`passes:2`) + tree-shaken
  (`moduleSideEffects:false` + `sideEffects:false`); verified 152 kB ESM gzip,
  no dead weight. No lever here.
- **Publishing maps out-of-band** — a separate sourcemap store is a possible
  future nicety; not part of driving the tarball down.
- **Removing the `visualizer` from the default build** — it writes only to
  `reports/` (gitignored, unshipped) and is the per-module instrument the
  backlog asks for; keep it.

## Surface gates (packaging-only checklist)

- [ ] `rollup.config.ts` — `sourcemap:false` on both code outputs **and** TS
      plugin `sourceMap:false` (D1a — both required; the TS flag suppresses the
      build warning); rebuild emits no `.map`, no trailer, no warning.
- [ ] `tooling/verify-tarball.sh` — `SIZE_CAP` lowered (D2); comment rewritten
      with **no** backlog/phase/ADR reference (repo rule); `*.map` added to the
      forbidden-path loop (D5).
- [ ] **Per-PR gate wiring (D3 → ADR-470)** — the lightweight tarball-size +
      `*.map` forbidden-path check runs in `validate`/CI (a `verify:tarball`
      wireit dep reduced to skip attw, or a dedicated lightweight pack-once
      script/CI job — vehicle settled in planning); it must **not** re-run attw
      (`check:exports` keeps that). RED against the current map-shipping build,
      GREEN after D1.
- [ ] `tsconfig.build.json` — vestigial map flags dropped (D4b); grep confirmed
      safe (typedoc reads the tsconfig for entry resolution, not map emission;
      `build:parity` doesn't read it) — re-confirm with a live `docs:json` run.
- [ ] `.size-limit.json` — unchanged (map-agnostic); re-confirm green.
- [ ] Real `npm pack` re-measured post-D1; cap number reconciled to
      measured × headroom.
- [ ] `npm run validate` green (`check:size` + `check:exports` neutral to the
      map removal; per-PR size + `*.map` check passes); `npm run verify:tarball`
      green under the new cap at tag-push.
- [ ] No `src/` diff; no interop test needed (build-artefact-only change).

## Size-limit raise — alternates object lookup and its git-faithfulness batch

Measured on a clean build (`rm -rf dist .wireit && npm run build`, `npx size-limit
--json`), gzip bytes, against `main` at the same toolchain. Each failing row is raised
to the measurement rounded up to the next 0.1 kB (≤100 B headroom, the slack the two
previous raises left); passing rows are unchanged.

| Row | main | measured | Δ | old limit | new limit | Attributable to |
|---|--:|--:|--:|--:|--:|---|
| Browser bundle (no-build) | 217 676 | 321 681 | +104 005 | 217.82 kB | 321.7 kB | every layer below — the bundle inlines all of them |
| Full library | 270 101 | 377 939 | +107 838 | 335 kB | 378 kB | every layer below |
| Chunks: domain | 80 279 | 119 137 | +38 858 | 80.41 kB | 119.2 kB | export-subst pretty expander (`domain/pretty`), merge renames / directory renames / merge command line (`domain/merge`), ERE automaton and bounded back-reference matcher (`domain/regex`), commit-graph split and Bloom (`domain/commit`), histogram / patience (`domain/diff`), new error members |
| Chunks: primitives | 74 500 | 99 473 | +24 973 | 74.54 kB | 99.5 kB | alternates chain and object store, limit-list and closure walks, signature verification, ambiguous-name candidates, split commit-graph writer, merge-base, config reads |
| Chunks: commands-internal | 44 995 | 79 384 | +34 389 | 46 kB | 79.4 kB | fetch ref map and branch tracking, octopus merge, rebase-merges steps, archive export-subst, fsck alternates roots and commit-graph verification |
| Chunks: repository | 7 857 | 9 108 | +1 251 | 7.9 kB | 9.2 kB | facade wiring for the new command options |
| Command (fetch) | 1 496 | 3 169 | +1 673 | 3 kB | 3.2 kB | fetch's refspec / ref-map rework |

The per-call-overhead perf fixes that followed (ref-miss and root-ref probes, peeled-tree
type read, unordered status scan, fsck offset sort) account for +176 B browser, +352 B full
library, +130 B primitives and +113 B commands-internal of the measured column. The
git-faithfulness fixes found while validating (gpg and ssh verifier output parsing, replace-ref
names read by their leading oid, fsck roots / unreadable worktree `HEAD` / per-copy referents,
branch-tracking valueless merges, rebase keeping commits that start empty and label reflogs, raw
`--no-commit` merge message, squash ident reads, GBK euro sign) account for +84 B browser,
+129 B full library, +162 B primitives and +117 B commands-internal more. The second ref-lookup
perf round (a loose miss tells absence from a file in its path only when `packed-refs` holds the
name, one read of a branch or start point per command, one unlink per branch-state file, the
rev-list typing walk's shallow set read once) accounts for +284 B browser, +330 B full library,
+228 B primitives and +26 B commands-internal more. The racily-clean smudge on index writes
(git's `do_write_index` → `ce_smudge_racily_clean_entry`, ADR-949) accounts for +263 B browser,
+626 B full library, +289 B primitives and +13 B repository more.

The npm tarball cap moved 1014 → 1370 KiB (1 038 052 → 1 402 019 B); its attribution
lives in `tooling/verify-tarball.sh`'s cap block.

## Size-limit raise — oid helpers and hash configs exported as values

Measured on a clean build (`rm -rf dist .wireit && npm run build`, `npx size-limit --json`),
gzip bytes, against `main` at the same toolchain. Each failing row is raised to the measurement
rounded up to the next 0.1 kB (≤100 B headroom); every other row is unchanged.

| Row | main | measured | Δ | old limit | new limit | Attributable to |
|---|--:|--:|--:|--:|--:|---|
| Browser bundle (no-build) | 321 681 | 321 737 | +56 | 321.7 kB | 321.8 kB | the five names below in the bundle's export list |
| Full library | 377 939 | 378 017 | +78 | 378 kB | 378.1 kB | `emptyTreeOid`, `EMPTY_TREE_OID`, `zeroOid`, `SHA1_CONFIG` and `SHA256_CONFIG` named in the export list of each of the four entries (`index` +48 B, `index.node` +46 B, `index.default` +48 B, `index.browser` +53 B, per-file gzip) and in the domain chunk's (+12 B); the values already lived in that chunk, and the minified import lists of the command and primitive files shifted for −129 B net |

The npm tarball cap is unchanged: the measured pack stayed under `tooling/verify-tarball.sh`'s cap.

## Size-limit raise — EOL conversion subsystem

Measured on a clean build (`rm -rf dist .wireit && WIREIT_CACHE=none npm run build`,
`npx size-limit --json`), gzip bytes, against `main` at the same toolchain; the measured column is the
branch's final tree (after the review and refactoring phases). Each failing row
is raised to the measurement rounded up to the next 0.1 kB plus 2 kB of review-round headroom;
every other row is unchanged.

| Row | main | measured | Δ | old limit | new limit | Attributable to |
|---|--:|--:|--:|--:|--:|---|
| Browser bundle (no-build) | 321 737 | 328 090 | +6 353 | 321.8 kB | 329.3 kB | the whole subsystem below, bundled once |
| Full library | 378 017 | 384 305 | +6 288 | 378.1 kB | 385.5 kB | the domain, primitives and commands-internal growth below plus the entries' re-exports (`EolNotice`, `RoundTripLoss`, `BlobUnchanged`) |
| Chunks: domain | 119 036 | 120 782 | +1 746 | 119.2 kB | 122.6 kB | `src/domain/eol`: text statistics and the binary classifier, the CRLF action resolution, the two CRLF converters and the LF→CRLF stream transform, the `ident` collapse and both expanders; the `EOL_ROUND_TRIP_UNSAFE` member and its detail; the modify/delete `blobUnchanged` arm of the three-way tree merge |
| Chunks: primitives | 99 470 | 102 179 | +2 709 | 99.5 kB | 103.9 kB | the per-path conversion resolver, the composed to-git / to-worktree steps and the streamed transform, the direction-taking attribute providers and index lookups, the working-tree writer, the converted dirty probe and comparison route, the renormalize attribute lookup and the content merger's normalisation |
| Chunks: commands-internal | 79 389 | 80 022 | +633 | 79.4 kB | 82 kB | `add`'s conversion scope, notices, index-order writes under `core.safecrlf=true` and `--renormalize`; `stash push`'s conversion and git's object-write order; `merge`'s `-X renormalize` wiring; `blame` and `archive` conversion |
| Command (add) | 2 402 | 3 243 | +841 | 3 kB | 3.5 kB | implementation +594 B (the conversion scope, the notices, the renormalize path and the write span under `core.safecrlf=true`); review fixes +247 B (tracked-before-untracked staging order on the literal and bulk paths, the index-rule blob chosen as stage 0 else 2 and its map built once per add, the gitlink skip); a per-command row takes 200 B of headroom, not the 2 kB the library rows took |

The npm tarball cap moved 1370 → 1410 KiB (1 402 333 → 1 421 159 B); its attribution lives in
`tooling/verify-tarball.sh`'s cap block.

## Size-limit raise — status refresh write-back and index extension carry

Measured with `npx size-limit --json` on a clean build after the review phase, gzip bytes, against
`main` (unchanged since the EOL raise). Each failing row is raised to the measurement rounded up to the
next 0.1 kB plus 2 kB of headroom for the remaining phases; every other row is unchanged. The review
added about 0.8 kB of correctness fixes: byte-exact cache-tree names, git's `unstage_changes_unless_new`
for a clean `stash apply`, the unmerged-index refusal, a refused autostash kept, and the lean lock create.

| Row | main | measured | Δ | old limit | new limit | Attributable to |
|---|--:|--:|--:|--:|--:|---|
| Browser bundle (no-build) | 328 090 | 331 602 | +3 512 | 329.3 kB | 333.7 kB | the whole change below, bundled once |
| Full library | 384 305 | 388 008 | +3 703 | 385.5 kB | 390.1 kB | the cache-tree serializer and chain invalidation, the index entry diff and the extension-carry policy (domain); the index-lock commit carrying extensions, the refresh-only commit with its trailer guard, the optional lock and its degrade report, the comparator's refresh verdict and the second-granularity racy check (primitives); `status`'s refresh write-back and `GIT_OPTIONAL_LOCKS`, `stash`'s pooled classification and hashing and its clean-apply index write, `add`'s re-staged paths and skipped no-op write, the `ENV_BAD_BOOLEAN_VALUE` refusal (commands) |

## Size-limit raise — byte-exact index paths

Measured with `npx size-limit --json` on a clean build, gzip, on the branch's tree after the review
phase. The `main` column is not re-measured here: see the previous section's measured column for the
rows it covers (browser bundle, full library); the domain and primitives chunks were not tracked
there. Each failing row is raised to the measurement rounded up to the next 0.1 kB plus 2 kB of
headroom for the remaining phases; every other row is unchanged.

| Row | main | measured | old limit | new limit | Attributable to |
|---|--:|--:|--:|--:|---|
| Chunks: domain | — | 122.69 kB | 122.6 kB | 124.7 kB | the raw-path codec and keys: the surrogate-escape codec, git's UTF-8 well-formedness table, the path-bytes key and the byte-ordered index writer and parser |
| Chunks: primitives | — | 104.46 kB | 103.9 kB | 106.5 kB | the symlink-safe write wave (links first, leading directories one component at a time), directory pruning, the lossy-entry skip in the changeset and the working-tree comparison |
| Browser bundle (no-build) | see previous section | 335.06 kB | 333.7 kB | 337.1 kB | the whole change, bundled once |
| Full library | see previous section | 391.73 kB | 390.1 kB | 393.8 kB | the above plus the escaped merge engine and file/directory conflicts (commands-internal), and the staged-only cherry-pick/revert check |

The npm tarball cap moved 1410 → 1423 KiB (measured pack 1 448 579 B); its attribution lives in
`tooling/verify-tarball.sh`'s cap block.

## Size-limit raise — add directory/file replacement and conflict stages

Measured with `npx size-limit --json` on clean builds, gzip: `main` at `0f8d0b16`, the branch after
the validation phase. Each failing row is raised to its measurement plus about 100 B; every other row
is unchanged. The `Command (add)` row had 41 B of headroom on `main`.

| Row | main | measured | old limit | new limit | Attributable to |
|---|--:|--:|--:|--:|---|
| Command (add) | 3 459 B | 4 286 B | 3.5 kB | 4.4 kB | the directory/file drop on all three add routes, the multi-stage index map, resolve-undo recording and the unmerged-path exclusion rule |
| Browser bundle (no-build) | 336 112 B | 337 410 B | 337.1 kB | 337.5 kB | the whole change, bundled once |
| Full library | 393 249 B | 394 361 B | 393.8 kB | 394.5 kB | the above plus the domain additions: the directory/file lookup, the resolve-undo encoder and merge, and the unmerged-path pathspec predicates |

The npm tarball cap moved 1423 → 1424 KiB (measured pack 1 457 786 B); its attribution lives in
`tooling/verify-tarball.sh`'s cap block.

## Size-limit raise — `.gitmodules` symlink aliases behind a backslash

Measured with `npx size-limit --json` on clean builds, gzip: `main` at `785fadfc`, the branch after
the security review fixes landed. Each failing row is raised to its measurement plus about 100 B;
every other row is unchanged.

| Row | main | measured | old limit | new limit | Attributable to |
|---|--:|--:|--:|--:|---|
| Full library | 394 361 B | 394 718 B | 394.5 kB | 394.8 kB | the `.gitmodules` symlink check's whole-path NTFS scan, the `.git` scan's component-leading backslash skip, the windows index path rules and the sparse-excluded entry check |
| Browser bundle (no-build) | 337 410 B | 337 663 B | 337.5 kB | 337.8 kB | the whole change, bundled once: the alias scan, the windows index path rules and their threading |

The npm tarball cap moved 1424 → 1425 KiB (measured pack 1 458 653 B); its attribution lives in
`tooling/verify-tarball.sh`'s cap block.

## Size-limit raise — cache-tree at O(change) and the checkout write path

Measured with `npx size-limit --json` on a clean build of the branch at `0dc6b37d`. Each failing row
is raised to its measurement plus about 100 B; every other row is unchanged.

| Row | main | measured | old limit | new limit | Attributable to |
|---|--:|--:|--:|--:|---|
| Full library | — | 397 867 B | 394.8 kB | 398.0 kB | the cache-tree planner and its write/repair driver, commit's index pass with the stat refresh, the two-way carry of a branch switch, the conflict-stop stats and `rm`'s resolve-undo |
| Browser bundle (no-build) | — | 340 458 B | 337.8 kB | 340.6 kB | the same change, bundled once |
| Chunks: domain | — | 125 758 B | 124.7 kB | 125.9 kB | the cache-tree planner (subtree order, carried-tree reuse, intent-to-add and unmerged invalidation) |
| Chunks: primitives | — | 107 189 B | 106.5 kB | 107.3 kB | the cache-tree driver, the shared tracked-entry scan, the two-way carry and the conflict-stop stats |

The npm tarball cap moved 1425 → 1436 KiB (measured pack 1 469 515 B); its attribution lives in
`tooling/verify-tarball.sh`'s cap block.

Review fixes on the same branch grew the measured rows again; raised the same way:

| Row | measured | old limit | new limit | Attributable to |
|---|--:|--:|--:|---|
| Full library | 398 981 B | 398.0 kB | 399.1 kB | the repair abort (`update_one`), the empty-tree presence rule, the tree-type check of a reused root, the pruned HEAD/target walk of a branch switch and the bounded literal read |
| Browser bundle (no-build) | 341 421 B | 340.6 kB | 341.6 kB | the same fixes, bundled once |
| Chunks: domain | 126 098 B | 125.9 kB | 126.2 kB | the repair abort and the oid-keeping invalidation |
| Chunks: primitives | 107 802 B | 107.3 kB | 107.9 kB | the pruned tree walk, the sparse carry and the root type check |
| Command (add) | 4 418 B | 4.4 kB | 4.6 kB | the bounded literal read and the pooled literal stats |

The npm tarball cap moved 1436 → 1439 KiB (measured pack 1 472 330 B); its attribution lives in
`tooling/verify-tarball.sh`'s cap block.

A second review round moved one row past its cap:

| Row | measured | old limit | new limit | Attributable to |
|---|--:|--:|--:|---|
| Chunks: primitives | 107 920 B | 107.9 kB | 108.1 kB | the repair abort's absent-oid set and the pruned walk's entry cap |

The third review round's repair fix (a parent hashed over a stale child that cannot be rebuilt) moved two rows again:

| Row | measured | old limit | new limit | Attributable to |
|---|--:|--:|--:|---|
| Full library | 399 210 B | 399.1 kB | 399.4 kB | the repair driver's working oid kept apart from the recorded oid |
| Browser bundle (no-build) | 341 668 B | 341.6 kB | 341.8 kB | the same change, bundled once |

## Size-limit raise — gc refuses a size-lying loose blob as git does

Measured on a clean build (`rm -rf dist .wireit && npm run build`, `npx size-limit --json`),
gzip bytes, against `main` at the same toolchain. Each failing row is raised to the measurement
rounded up to the next 0.1 kB (≤100 B headroom); every other row is unchanged.

| Row | main | measured | Δ | old limit | new limit | Attributable to |
|---|--:|--:|--:|--:|--:|---|
| Browser bundle (no-build) | 341 632 | 341 961 | +329 | 341.8 kB | 342.0 kB | every layer below — the bundle inlines all of them |
| Full library | 399 126 | 399 490 | +364 | 399.4 kB | 399.5 kB | every layer below |
| Chunks: commands-internal | 81 856 | 82 088 | +232 | 82 kB | 82.1 kB | gc's build-then-install staging of every pack, the verify of only the packs a run wrote with the in-window truncation acceptance, and the three fsck code sets admitting `LOOSE_OBJECT_CORRUPT` |

Rows that grew without crossing their cap: `Chunks: primitives` +125 B (the loose-truncation
predicate, the header-only typing of a blob want, the read-mode threading of the pack-building
reader and the three refusal sites naming their id), `Chunks: domain` +30 B (the
`LOOSE_OBJECT_CORRUPT` member, its factory and its message), `Chunks: repository` −7 B.

The npm tarball cap moved 1439 → 1440 KiB (1 472 909 → 1 474 199 B measured); its attribution
lives in `tooling/verify-tarball.sh`'s cap block.

The review fixes of the same change crossed three of these rows again, measured the same way on
a clean build; each is raised once more to the next 0.1 kB. The tarball cap holds (1 474 411 B
measured against 1 440 KiB).

| Row | before the fixes | measured | Δ | old limit | new limit | Attributable to |
|---|--:|--:|--:|--:|--:|---|
| Browser bundle (no-build) | 341 961 | 342 003 | +42 | 342.0 kB | 342.1 kB | every layer below |
| Full library | 399 490 | 399 645 | +155 | 399.5 kB | 399.7 kB | every layer below |
| Chunks: primitives | 108 066 | 108 128 | +62 | 108.1 kB | 108.2 kB | the local header peek (`peekDeclaredObjectHeader`, no fetch, no rescan), the peeled want's kind carried out of the tag-chain resolver so the closure probes a want once, and the header-only blob hop in `peel` |

## Size-limit raise — the pathspec glob dialect

Measured on a clean build (`rm -rf dist .wireit && npm run build`, `npx size-limit --json`),
gzip bytes, against `main` (`8dd442ee`) at the same toolchain. Each failing row is raised by
its measured delta, rounded up to the next 0.1 kB; every other row is unchanged.

| Row | main | measured | Δ | old limit | new limit | Attributable to |
|---|--:|--:|--:|--:|--:|---|
| Browser bundle (no-build) | 342 024 | 342 413 | +389 | 342.1 kB | 342.5 kB | every layer below |
| Full library | 399 484 | 400 108 | +624 | 399.7 kB | 400.4 kB | every layer below |
| Chunks: domain | 126 169 | 126 289 | +120 | 126.2 kB | 126.4 kB | the dialect matcher and its fast paths, the refusal helpers, `subpathOffset`, offset by the removed `scanStar`, `containsGlob` and `compileLiteral`/`compileDirectory` |
| Chunks: commands-internal | 82 088 | 82 203 | +115 | 82.1 kB | 82.3 kB | the index-side glob pass, offset by the removed `enforceLiteralMustMatch` |
| Command (add) | 4 416 | 4 707 | +291 | 4.6 kB | 4.9 kB | the glob-aware staging pass and its refusal helpers |

The npm tarball cap moved 1440 → 1442 KiB (1 476 231 B measured); its attribution lives in
`tooling/verify-tarball.sh`'s cap block.

The review and refactoring rounds of the same change crossed all five rows again, measured the
same way on a clean build; each is raised once more to the next 0.1 kB. The tarball cap moved
1442 → 1444 KiB (1 477 954 B measured); its attribution lives in `tooling/verify-tarball.sh`'s
cap block.

| Row | before the fixes | measured | Δ | old limit | new limit | Attributable to |
|---|--:|--:|--:|--:|--:|---|
| Browser bundle (no-build) | 342 413 | 342 984 | +571 | 342.5 kB | 343 kB | every layer below |
| Full library | 400 108 | 400 646 | +538 | 400.4 kB | 400.7 kB | every layer below |
| Chunks: domain | 126 289 | 126 480 | +191 | 126.4 kB | 126.5 kB | the one-pass `pathspecVerdict`, the literal-suffix post-filter on the general wildcard shape, and the ping-pong rows with their all-zero early exit in the ref-glob matcher |
| Chunks: commands-internal | 82 203 | 82 326 | +123 | 82.3 kB | 82.4 kB | the shared positive tracker (`trackPositives`), whose fail-closed `seen` replaced the per-command bookkeeping of `rm`, `add` and `checkout` |
| Command (add) | 4 707 | 4 991 | +284 | 4.9 kB | 5 kB | the literal on-disk escape with git's ancestor-ignore check and the directory-only trailing-slash rule, and the index-side pass staging a hidden conflicted path |
