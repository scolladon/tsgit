# ADR-002: Rollup for Production Builds

## Status

Accepted (at `a5c00ad`)

## Context

The PRD mandates strict bundle size budgets (< 15 kB single command, < 150 kB full library gzipped). We need dual CJS/ESM output, tree-shaking, minification, and type declaration bundling. Options evaluated: raw tsc, esbuild, tsup, rollup.

## Decision

Use rollup with:
- `@rollup/plugin-typescript` for TS compilation
- `@rollup/plugin-terser` for minification (2-pass compression)
- `rollup-plugin-dts` for bundled type declarations
- `rollup-plugin-visualizer` for bundle analysis

Output: `dist/esm/` (ESM .js), `dist/cjs/` (CJS .cjs), `dist/types/` (.d.ts).

## Consequences

### Positive

- Best tree-shaking via scope hoisting — smallest possible output
- Dual CJS/ESM from a single build config
- Bundle analysis HTML report for debugging size regressions

### Negative

- Slower than esbuild (acceptable — build is not on the hot path)
- Rollup config is more complex than tsup
- `@rollup/plugin-typescript` has friction with tsconfig (requires compilerOptions overrides)

### Neutral

- size-limit enforces budgets independently of the bundler choice
