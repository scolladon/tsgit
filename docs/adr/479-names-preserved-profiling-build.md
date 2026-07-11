# 479 — profiler reads a names-preserved build, not the shipped minified dist

- **Status:** accepted
- **Date:** 2026-07-11
- **Design:** docs/design/per-command-profile-capture.md · **Relates:** ADR-475, ADR-477

## Context

ADR-477 said the profiler consumes the compiled `dist/` (a strip-only runtime cannot resolve
`src/**`'s `.js`-suffixed specifiers nor parse parameter-property constructors). What that
overlooked: the shipped `dist/esm` is **aggressively minified** — `rollup.config.ts` runs
`@rollup/plugin-terser` with default name-mangling on, and 26.8 dropped source maps to shrink
the tarball. tsgit is FP-first (`export const foo = () => …`), and an arrow function's `.name`
follows its binding, which minification renames to a single letter. So a `node --prof-process`
digest of the shipped dist reports tsgit frames as mangled names (`$`, `Xr`, `t2`).

ADR-475 commits **hot-function self-shares** as the baseline, consumed by the findings-driven
hot-path work ("frame X is 41 % of `log` → optimise it") and diffed by the CI regression gate.
Mangled frame names make that baseline unactionable — you cannot map `$` back to a source
function without a source map, and none is emitted. This surfaced at baseline generation, after
the profiler was wired.

## Options considered

1. **Profile a names-preserved build of the same bundle** — a profiling-only rollup variant
   that runs the identical pipeline (resolve + typescript + tree-shake + scope-hoist) **minus
   terser**, emitting the `index.node` entry to a separate `dist-profile/esm/`. Bundling and
   tree-shaking are unchanged, so the hot path matches the shipped bundle; only name-mangling is
   off, so frames read as source names. The profiler builds and imports this variant.
   *(user-chosen)*
2. **Profile the TypeScript source via a dev runtime (tsx/esbuild)** — bypass the dist and
   profile source directly. Full readable names, but profiles *unbundled* source (different
   inlining/hoisting than the shipped bundle) and adds a tsx dev-dependency.
3. **Ship mangled names + a documented caveat** — commit the baseline as-is and defer
   readable-name profiling. Lowest effort, but the baseline is unactionable for its downstream
   consumers and merely defers the problem.

## Decision

Adopt **option 1** (user-ratified): the profiler builds and reads a **names-preserved variant**
of the shipped bundle. Concretely:

- A profiling rollup config (`rollup.profile.config.ts`) builds only the `index.node` ESM entry
  through the same `resolve` + `typescript` + tree-shake pipeline as `rollup.config.ts`, **but
  omits `@rollup/plugin-terser`**, emitting to `dist-profile/esm/` (git-ignored).
- `npm run build:profile` produces it; the `profile` npm script runs `npm run build:profile`
  (not `npm run build`) before profiling.
- `tooling/profile.ts`'s `DIST_ENTRY` points at `dist-profile/esm/index.node.js`.

This refines ADR-477's "compiled dist": the profiler still consumes a **compiled bundle** (not
source), preserving the strip-only-runtime rationale and the bundle's hot-path shape — it just
consumes the mangle-off variant so the committed shares carry source-level frame names.

## Consequences

- The committed baseline's `hotShares`/`setupShares` carry readable source function names,
  actionable by the hot-path work and diffable by the regression gate.
- A new git-ignored build output `dist-profile/` and a `build:profile` script; the shipped
  `dist/` and its minification (26.8's tarball budget) are untouched — the profiling build is a
  separate, dev-only artifact.
- Faithfulness: removing terser does not change which functions are hot (bundling/tree-shaking
  are identical; terser only mangles names + strips whitespace), so the names-preserved profile
  reflects the shipped bundle's hot path. `unsafe_math`/`pure_getters` compress passes are off in
  the profiling build, an acceptable divergence for a hot-*function* baseline (it identifies
  which function is hot, not micro-optimised arithmetic).
- If a future change makes the shipped and profiling bundles diverge structurally (e.g. a terser
  pass that drops a whole function), the profile would over-report it — a signal to re-pin, not a
  silent skew.
