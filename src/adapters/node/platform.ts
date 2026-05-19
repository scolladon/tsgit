/**
 * Adapter-internal platform indirection. Phase 14.4.
 *
 * Exported as a named function so callers that need to test both branches
 * of platform-dependent logic can inject a stub. `process.platform` is a
 * read-only Node global and cannot be replaced with `vi.stubGlobal`, and
 * ESM module-bindings are not interceptable via `vi.spyOn` — dependency
 * injection is the simplest pattern that works.
 *
 * Not re-exported from `src/adapters/node/index.ts` (callers use the
 * default `NodeFileSystem` constructor; the injection is for tests only).
 */

export type PlatformPredicate = () => boolean;

export const isWindows: PlatformPredicate = () => process.platform === 'win32';
