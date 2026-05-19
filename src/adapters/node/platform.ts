/**
 * Adapter-internal platform indirection. Phase 14.4.
 *
 * Exported as a named function so callers that need to test both branches
 * of platform-dependent logic can inject a stub. `process.platform` is a
 * read-only Node global and cannot be replaced with `vi.stubGlobal`, and
 * ESM module-bindings are not interceptable via `vi.spyOn` — dependency
 * injection is the simplest pattern that works.
 *
 * @internal — not re-exported from `src/adapters/node/index.ts`.
 */

export type PlatformPredicate = () => boolean;

export const isWindows: PlatformPredicate = () => process.platform === 'win32';
