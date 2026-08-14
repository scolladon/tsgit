import type { PathPolicy } from '../adapters/node/path-policy.js';
// Every path reaching `portablePosixPolicy` is already absolute (the browser
// shim's OPFS root and `findLayout`'s resolved bases), so the collapse's
// absolute-in contract holds at every call site below.
import { collapsePosixSegments as normalizeAbsolutePosixPath } from '../domain/path/collapse-posix-segments.js';

/**
 * Dependency-free stand-in for `adapters/node/path-policy.ts`'s
 * `posixPolicy`. That value delegates to `node:path`, which the single-file
 * CDN bundle (`dist/browser/tsgit.js`, unpkg/jsdelivr) must never reference:
 * rollup treats every `node:*` specifier as external (`rollup.config.ts`),
 * so a value import of `posixPolicy` there would leave a surviving `import
 * 'node:path'` in the bundle — exactly what `verify-tarball.sh`'s
 * single-file check rejects.
 *
 * Scoped, not a general `path.posix` replacement: `resolve`/`join` only ever
 * receive an already-absolute argument in this codebase (`findLayout` and
 * `layoutFromGitfile` always join/resolve against an absolute `workDir` or
 * `gitDir`), so both simply normalize the joined string rather than
 * replicate `path.posix`'s "later absolute argument wins" or
 * relative-to-cwd-fallback semantics. `rootOf` mirrors `posixPolicy`'s
 * verdict for both input shapes: `'/'` for an absolute path, `''` for a
 * relative one.
 */
export const portablePosixPolicy: PathPolicy = {
  sep: '/',
  caseInsensitive: false,
  windowsSyntax: false,
  honoursNoFollow: true,
  isAbsolute: (path) => path.startsWith('/'),
  resolve: (...parts) => normalizeAbsolutePosixPath(parts.join('/')),
  join: (...parts) => normalizeAbsolutePosixPath(parts.join('/')),
  dirname: (path) => {
    const normalized = normalizeAbsolutePosixPath(path);
    const cut = normalized.lastIndexOf('/');
    return cut <= 0 ? '/' : normalized.slice(0, cut);
  },
  // No root special-case needed: `normalizeAbsolutePosixPath` always returns
  // a leading slash, so for '/' `lastIndexOf('/') + 1` is 1 and the slice is
  // already '' — identical to what an explicit `=== '/'` guard would return.
  basename: (path) => {
    const normalized = normalizeAbsolutePosixPath(path);
    return normalized.slice(normalized.lastIndexOf('/') + 1);
  },
  rootOf: (path) => (path.startsWith('/') ? '/' : ''),
  normalizeForCompare: (path) => path,
};
