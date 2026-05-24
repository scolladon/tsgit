# ADR-127: Browser parity driver receives scenarios via bundled `window.__tsgitParity`, not function-source serialization

## Status

Accepted (at `91dfcc674ca8fd0bb818b6b9869b1700cf7919b4`)

## Context

Phase 19.5 makes a parity scenario run unmodified against the Node, Memory, and Browser adapters from a single source. The Browser driver runs scenarios through Playwright's `page.evaluate(fn, args)`, which serializes `fn` to source and re-evaluates it in the page. Two options for exposing `scenario.run` inside the page:

1. **Bundle the scenario set into the harness.** A new `test/browser/parity-scenarios.bundle.ts` imports every `<name>.scenario.ts` and assigns the registry to `window.__tsgitParity`. The Playwright spec body calls `page.evaluate((name) => window.__tsgitParity[name].run(...), ...)`. Cost: one new wireit recipe (`build:parity`) drives a standalone rollup invocation (`tooling/build-parity-bundle.ts`) that emits `test/browser/parity-scenarios.bundle.js`; `test:e2e` gets `build:parity` as a wireit dependency.
2. **Serialize the function source.** Pass `scenario.run` directly to `page.evaluate(run, args)`. Cost: `run` must be a pure top-level arrow that closes over nothing — Vitest's transform pipeline injects `import.meta.url`-bearing prelude into ESM test modules, which Playwright's serializer drops, producing scoping bugs at runtime. The fragility is silent: serialization succeeds, the page runs garbled JS, and the failure surfaces as a `ReferenceError` deep inside the browser console with no source map.

The current browser harness already exposes its runtime through a bundle (`test/browser/index.html:11-32` builds `window.__tsgit` from `/dist/esm/index.browser.js`). Option 1 mirrors that exact pattern; option 2 introduces a parallel mechanism.

## Decision

Option 1 — bundle scenarios into the harness via a small standalone rollup driver, expose them on `window.__tsgitParity`, and add `build:parity` as a wireit dependency of `test:e2e`. The bundle output is `.gitignore`d. Browser spec bodies reference scenarios by name (`window.__tsgitParity['init-add-commit-status']`), not by passing function references across the `page.evaluate` boundary.

## Consequences

### Positive

- **Mirrors the existing harness shape.** The same place a reviewer looks to find `window.__tsgit` is the same place they find `window.__tsgitParity`. Future readers don't ask "why two patterns for the same problem?"
- **Scoping is explicit.** A scenario is whatever its bundle entry imports — no hidden runtime serialization gotchas. A failing browser parity test points at the scenario file by name, not at a serialized function body.
- **Adding a scenario is one file plus a one-line entry in the bundle barrel.** No driver changes; no `page.evaluate(run, ...)` refactor per scenario.

### Negative

- **One more wireit recipe and one more rollup invocation.** The first time `test:e2e` runs from a clean tree, `build:parity` runs alongside `build`. Negligible (the bundle has two scenarios; rollup completes in well under a second). The recipe is bounded — its inputs are `test/parity/scenarios/**` and `test/browser/parity-scenarios.bundle.ts`, so changes to `src/` do not retrigger it.
- **Bundle output is generated, not source.** A new entry in `.gitignore` and a small expectation that contributors run `npm run build:parity` (or `test:e2e`) after editing scenarios. Mitigated by wireit's automatic dependency-driven rebuild.

### Neutral

- **The `audit-parity-fixtures` lint applies to scenarios, not the bundle.** The bundle barrel is mechanical; it just re-exports. The audit reads the scenario files directly, so the bundle layer is transparent to determinism enforcement.
