/**
 * Browser-side parity scenario registry.
 *
 * Imports the scenario modules under `test/parity/scenarios/**` and exposes
 * them as a name-keyed registry on `window.__tsgitParity`. The browser
 * parity spec (`test/browser/parity.spec.ts`) reads the registry inside
 * `page.evaluate(...)` — by name, never by passing function references
 * across the boundary (see ADR-127).
 *
 * Bundled by `tooling/build-parity-bundle.ts` into
 * `test/browser/parity-scenarios.bundle.js`, which `test/browser/index.html`
 * imports.
 */
/// <reference lib="dom" />
import { SCENARIOS } from '../parity/scenarios/index.ts';
import type { Scenario } from '../parity/scenarios/types.ts';

declare global {
  interface Window {
    __tsgitParity?: Readonly<Record<string, Scenario<unknown>>>;
  }
}

const registry: Record<string, Scenario<unknown>> = {};
for (const scenario of SCENARIOS) {
  registry[scenario.name] = scenario;
}

window.__tsgitParity = Object.freeze(registry);
window.dispatchEvent(new Event('tsgit-parity:ready'));
