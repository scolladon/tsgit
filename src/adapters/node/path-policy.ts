/**
 * Path-policy abstraction. Phase 14.4.
 *
 * Encapsulates every platform-aware path operation the Node adapter needs.
 * Production code uses `nativePolicy` (host-matching). Tests inject
 * `windowsPolicy` or `posixPolicy` to simulate either platform on any host,
 * eliminating the "host vs. simulated platform" confusion that was
 * leaking into containment / cache / errno code paths.
 *
 * Design notes:
 * - `sep` is the platform separator string, used for prefix containment.
 * - `caseInsensitive` drives `normalizeForCompare`; Windows + macOS HFS+
 *   could share this in theory, but tsgit treats macOS as case-sensitive
 *   per Git's `core.ignorecase` default and POSIX convention.
 * - `rootOf` returns the volume/drive prefix produced by `path.parse`.
 *   Examples: `/` on POSIX, `'C:\\'` on Windows, `'\\\\server\\share\\'`
 *   for UNC paths.
 * - The interface is *only* the subset NodeFileSystem actually needs; we
 *   intentionally do not expose all of `nodePath`'s surface so callers
 *   can't smuggle host-bound calls back in.
 */

import * as nodePath from 'node:path';

export interface PathPolicy {
  readonly sep: '\\' | '/';
  readonly caseInsensitive: boolean;
  isAbsolute(path: string): boolean;
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  /**
   * Returns the volume/drive prefix produced by `path.parse(p).root`.
   * POSIX: `/` for absolute, `''` for relative.
   * Windows: `'C:\\'`, `'\\\\server\\share\\'`, or `''` for relative.
   */
  rootOf(path: string): string;
  /** Case-fold on case-insensitive platforms; identity otherwise. */
  normalizeForCompare(path: string): string;
}

const narrowSep = (sep: string): '\\' | '/' => {
  if (sep !== '\\' && sep !== '/') {
    throw new Error(`PathPolicy: unsupported separator ${JSON.stringify(sep)}`);
  }
  return sep;
};

const makePolicy = (impl: typeof nodePath.posix, caseInsensitive: boolean): PathPolicy => ({
  sep: narrowSep(impl.sep),
  caseInsensitive,
  isAbsolute: (path: string) => impl.isAbsolute(path),
  resolve: (...parts: string[]) => impl.resolve(...parts),
  join: (...parts: string[]) => impl.join(...parts),
  dirname: (path: string) => impl.dirname(path),
  basename: (path: string) => impl.basename(path),
  rootOf: (path: string) => impl.parse(path).root,
  normalizeForCompare: (path: string) => (caseInsensitive ? path.toLowerCase() : path),
});

export const posixPolicy: PathPolicy = makePolicy(nodePath.posix, false);
export const windowsPolicy: PathPolicy = makePolicy(nodePath.win32, true);

/**
 * Pick the policy that matches the given platform string. Extracted as a
 * pure helper so both arms are unit-testable on any host (the inline
 * `process.platform` branch is otherwise only ever exercised on its native
 * arm and hides the other from coverage / mutation testing).
 * @internal
 */
export const selectNativePolicy = (platform: NodeJS.Platform): PathPolicy =>
  platform === 'win32' ? windowsPolicy : posixPolicy;

/** Host-matching policy — chosen by `process.platform`. */
export const nativePolicy: PathPolicy = selectNativePolicy(process.platform);
