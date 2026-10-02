import type { GitPathSyntax } from '../application/primitives/internal/git-path-syntax.js';

const POSIX_ROOT = '/';
const GIT_SEPARATORS = /\//g;
const WINDOWS_SEPARATOR = '\\';

/** The root a path hangs off, read the way `syntax`'s git build reads it: POSIX, drive or UNC share. */
export const filesystemRootOf = (syntax: GitPathSyntax, path: string): string => {
  const { root } = syntax.splitRoot(path);
  if (root === '' || root === POSIX_ROOT) return POSIX_ROOT;
  const native = root.replace(GIT_SEPARATORS, WINDOWS_SEPARATOR);
  return native.endsWith(WINDOWS_SEPARATOR) ? native : `${native}${WINDOWS_SEPARATOR}`;
};
