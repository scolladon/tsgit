/**
 * Recursively `Object.freeze` every plain-object reachable from `value`.
 *
 * Coverage:
 * - Plain objects (`Object.prototype` parent or null prototype): frozen + walked.
 * - Arrays: frozen + walked via `Object.keys` (which returns index strings) —
 *   no special-casing needed.
 * - Function-valued slots: the slot itself is frozen via the parent's freeze;
 *   the closure scope is the caller's responsibility (documented carve-out
 *   for `dnsResolver`/auth-getter style fields in `RepositoryConfig`).
 * - Primitives, null, undefined: returned unchanged.
 * - Already-frozen objects: short-circuit; never re-freeze.
 *
 * Cycle handling: the `Object.isFrozen` early return doubles as a cycle guard.
 * After freezing the parent, any back-edge to it short-circuits because
 * `Object.isFrozen` is now true. No separate WeakSet needed.
 */
export const deepFreeze = <T>(value: T): Readonly<T> => {
  walk(value);
  return value;
};

const walk = (value: unknown): void => {
  if (value === null || typeof value !== 'object') return;
  if (Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Object.keys(value)) {
    walk((value as Record<string, unknown>)[key]);
  }
};
