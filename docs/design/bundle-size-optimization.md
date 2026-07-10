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
