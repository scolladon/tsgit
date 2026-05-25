# ADR-146: No bundling step for Deno / Bun / Workers drivers

## Status

Accepted (at `4911c0d`)

## Context

The browser parity driver bundles scenarios into
`test/browser/parity-scenarios.bundle.js` via a standalone rollup
invocation (`tooling/build-parity-bundle.ts`, see ADR-127). The reason:
Playwright's `page.evaluate(fn, args)` serializes `fn` to source — a TS
module graph cannot cross that boundary without pre-bundling.

The Deno, Bun, and Workers runtimes do not have that constraint:

- **Deno** natively loads `.ts` files (built-in transpiler).
- **Bun** natively loads `.ts` files (built-in transpiler).
- **Workers (via `@cloudflare/vitest-pool-workers`)** loads `.ts`
  through the Vite/Vitest transform pipeline that the rest of the
  project already uses.

So three of the four new drivers could either (a) re-use the browser
parity bundle, or (b) import scenarios directly via relative path.

Option (a) — re-use the bundle — would mean every runtime driver imports
`../../browser/parity-scenarios.bundle.js`. That file is `.gitignore`d
and only exists after `npm run build:parity`. Drivers' `npm install` /
`deno cache` / `bun install` would fail-by-default on a clean checkout.

Option (b) — direct TS imports — works on a clean checkout and matches
the runtime's native loading semantics.

## Decision

Deno, Bun, and Workers drivers import scenarios via direct relative
path:

```typescript
import { SCENARIOS } from '../../parity/scenarios/index.ts';
```

No `build:parity:<runtime>` recipe. No new bundle artifacts. The
browser bundle stays the only one — it exists for `page.evaluate`'s
boundary, not as a generic test-distribution mechanism.

## Consequences

### Positive

- Clean-checkout drivers run with no pre-build step.
- One less artifact to track in `.gitignore`, fewer wireit recipes to
  invalidate.
- The TS source IS the test input — no chance of a bundled
  scenario drifting from the registry it was built from.

### Negative

- Each runtime's loader transpiles TS on every run. Negligible cost
  (≤ 50 KB of scenario source).
- Deno + Bun runtime test scripts include `.ts` extensions in import
  specifiers, which TypeScript's default `moduleResolution` flags as
  errors. Mitigated per-runtime: Deno honours `.ts` extensions
  natively; Bun's `bunfig.toml` opts in; Workers' tsconfig sets
  `allowImportingTsExtensions: true`.

### Neutral

- If a future runtime is added that cannot load `.ts` directly (e.g. a
  WASM runtime), this ADR is revisited per-runtime — no need to
  pre-emptively bundle for runtimes that don't require it.
