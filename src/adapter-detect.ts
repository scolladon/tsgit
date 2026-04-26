import type { Compressor } from './ports/compressor.js';
import type { FileSystem } from './ports/file-system.js';
import type { HashService } from './ports/hash-service.js';
import type { HttpTransport } from './ports/http-transport.js';

/**
 * The four adapter ports the facade plumbs into the Context. Each runtime
 * shim (`index.node.ts`, `index.browser.ts`, `index.default.ts` — wired in
 * Step 5) provides a `detectAdapter(): AdapterSet` that returns the runtime-
 * appropriate set.
 */
export interface AdapterSet {
  readonly fs: FileSystem;
  readonly hash: HashService;
  readonly compressor: Compressor;
  readonly transport: HttpTransport;
}

// `Object.hasOwn` rejects null/undefined targets via the `typeof === 'object'` guard.
// Combined with `obj != null` this collapses null+undefined into one branch, so the
// hasOwn-equivalent prototype-pollution check is exactly one boolean expression
// (no redundant guards for mutation testing to flip).
const hasOwn = (obj: unknown, key: string): boolean =>
  typeof obj === 'object' && obj !== null && Object.hasOwn(obj, key);

/**
 * Prototype-pollution-safe runtime check. Returns true only when `process` is
 * an object that owns BOTH `versions` and `versions.node` as own properties —
 * an attacker who pollutes `Object.prototype.versions` cannot make this
 * return true.
 *
 * Used as a manual fallback only; the primary detection mechanism is
 * `package.json` conditional exports (resolved at bundle time, immune to
 * runtime pollution).
 */
export const isNode = (): boolean => {
  // Use globalThis.process to keep the lookup uniform whether process is
  // declared (Node) or absent (browser/memory). `hasOwn` handles undefined
  // and null safely (returns false), so no separate early-return is needed.
  const proc = (globalThis as { readonly process?: unknown }).process;
  if (!hasOwn(proc, 'versions')) return false;
  return hasOwn((proc as { readonly versions?: unknown }).versions, 'node');
};

/**
 * Returns true when both `window` and `navigator` exist AS OWN globals on
 * `globalThis` AND have non-undefined values. Two-stage check:
 * - `hasOwn` rejects properties inherited from a polluted `Object.prototype`.
 * - `typeof` rejects own properties that have been assigned `undefined`
 *   (e.g., test harnesses that stub the global to undefined).
 */
export const isBrowser = (): boolean =>
  hasOwn(globalThis, 'window') &&
  typeof window !== 'undefined' &&
  hasOwn(globalThis, 'navigator') &&
  typeof navigator !== 'undefined';

/**
 * Three-way runtime classification used by manual call sites. Node takes
 * precedence over browser when both look present (e.g., test environments
 * with jsdom + a real Node process).
 */
export const detectRuntime = (): 'node' | 'browser' | 'memory' => {
  if (isNode()) return 'node';
  if (isBrowser()) return 'browser';
  return 'memory';
};
