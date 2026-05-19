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

// equivalent-mutant: mutating `'win32'` to `""` (or the comparison to `false`)
// flips the return to the opposite host's value. On the Linux mutation runner
// `isWindows()` is always false; complementary Windows tests inject `() => true`
// at the constructor boundary, so the mutant has no observable effect on
// Linux but is killed on Windows runners.
export const isWindows: PlatformPredicate = () => process.platform === 'win32';
