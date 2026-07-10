# 468 — stop shipping source maps in the npm package

- **Status:** accepted
- **Date:** 2026-07-10
- **Design:** docs/design/bundle-size-optimization.md

## Context

The published tarball measures ~1029 KiB compressed. A per-group `gzip -9`
breakdown of the built `dist/` shows source maps (`.js.map` + `.cjs.map`) are
**53% (547 KiB)** of that payload — the single dominant contributor. The maps
are pure build artefacts: `dist/` is gitignored, so they are never committed,
and the library sources are public on GitHub. Shipping them in a minified
library's package buys consumers little and costs every installer the download.

The code (`.js` + `.cjs`, 28%) is already minified (terser `passes:2`) and
tree-shaken (`sideEffects:false`), and the types (`.d.ts` + `.d.cts`, 18%) are
dual-emitted because `attw --profile node16` requires it — both are at their
structural floor while shipping a dual ESM+CJS package. Source maps are the only
slack.

The question is *how* to stop shipping them.

## Options considered

1. **No-emit in the shipped build** — set `sourcemap: false` on both rollup code
   outputs (and `sourceMap: false` in the TS plugin to suppress the resulting
   build warning). Rollup then writes no `.map` file **and** no
   `//# sourceMappingURL=` trailer — the two drop atomically, so no consumer
   devtools 404. No `files`/`.npmignore` surgery. *(design recommendation)*
2. **Emit-but-exclude** — keep `sourcemap: true`, exclude `.map` from the tarball
   via a `files` negation or `.npmignore`, and strip the `sourceMappingURL`
   trailer from every shipped file (terser does not strip it — rollup appends it
   after terser). Strictly more moving parts; a missed trailer strip leaves the
   404 footgun. Maps aren't committed, so keeping them emitted has no repo value.
3. **Keep shipping maps** (status quo) — rejected: it is the entire 53% bloat
   with no consumer benefit for a minified library.

## Decision

Adopt option 1 — **do not emit source maps in the shipped build** (user-ratified;
matches the design recommendation). Set `sourcemap: false` on both rollup code
outputs and `sourceMap: false` in the `@rollup/plugin-typescript` options (the
latter purely to keep the build warning-free — the output flag is the sole
authority for the shipped map + trailer).

This decision is made **durable** by a regression guard (design D5): a
`*.map`-forbidden-path assertion is added to `tooling/verify-tarball.sh` (broad
pattern `^package/.*\.map$`), so no `.map` can silently return to the tarball
after this change. The guard is the executable red→green spec for the change —
there is no vitest surface for packaging.

## Consequences

- Compressed tarball drops from ~1029 KiB to ~482–489 KiB (~2.1×) — the whole
  optimization, in one flag flip plus a guard.
- No `src/` diff, no git-observable state change: this is a build-artefact-only
  change, so no interop matrix is required (see design §Git-faithfulness
  framing). The size matrix stands in for the behaviour matrix.
- `check:size` (measures `dist/esm/**/*.js` gzip) and `check:exports`
  (`attw --pack`) are both **neutral** to map removal — neither ever read maps —
  so `validate` stays green unchanged.
- **Config-honesty cleanup (design D4):** `tsconfig.build.json` carries
  `declarationMap:true` + `sourceMap:true` that are vestigial for the shipped
  build (rollup + the `dts` plugin own the emitted artefacts). They are dropped
  to make the config honestly reflect "no maps shipped" — guarded by first
  confirming no other consumer (`docs:json`, `build:parity`) relies on tsc-side
  maps; if any does, the flag stays with a one-line "why".
- Consumers wanting to debug into the package fall back to the public TS sources.
  Publishing maps to a separate out-of-band store remains a possible future
  nicety, explicitly out of scope here.
