import { pathspecOutsideRepo } from '../domain/commands/error.js';
import type { FilePath } from '../domain/objects/object-id.js';
import type { FileSystem } from '../ports/file-system.js';

/**
 * Wrap a user-supplied FileSystem so every path-taking method asserts that
 * the path is contained within `cwd`. commands ALREADY validate
 * cwd-relative paths via `validatePath` before computing absolute paths;
 * this wrapper is defense-in-depth for adapters whose own implementation
 * (e.g., a buggy `realpath`) might lie about resolution.
 *
 * Bypassed when `openRepository` is called with `unsafeRawAdapters: true`.
 *
 * Threat model: only protects path-naming surface (which path strings the
 * adapter sees). A malicious FS can still return adversarial **content** for
 * `read`/`readUtf8`; that level of trust is delegated to the caller's choice
 * of FS implementation.
 */
/**
 * Filter an allowlist of external paths through two defensive checks before
 * trusting them: reject empty strings (a malicious / buggy adapter returning
 * `''` would otherwise add the root-relative path `'/x'` to the allowlist) and
 * reject paths containing a `..` segment (which would let the adapter slip a
 * traversal-bearing path past the containment guard). The allowed paths come
 * from the FS adapter's own `homedir()` / `xdgConfigHome()` / `systemConfigPath()`
 * methods; in production these are trusted, but defence in depth costs nothing.
 */
const sanitizeAllowlist = (paths: ReadonlyArray<string>): ReadonlyArray<string> =>
  paths.filter((p) => p.length > 0 && !p.split(/[\\/]/).includes('..'));

export const wrapFsValidator = (
  fs: FileSystem,
  cwd: string,
  allowExternalPaths: ReadonlyArray<string> = [],
): FileSystem => {
  const allowSet = new Set(sanitizeAllowlist(allowExternalPaths));
  const guard = (path: string): void => {
    if (isContainedIn(path, cwd)) return;
    if (allowSet.has(path)) return;
    throw pathspecOutsideRepo(path as FilePath);
  };
  return {
    read: (p) => {
      guard(p);
      return fs.read(p);
    },
    readSlice: (p, o, l) => {
      guard(p);
      return fs.readSlice(p, o, l);
    },
    readUtf8: (p) => {
      guard(p);
      return fs.readUtf8(p);
    },
    write: (p, d) => {
      guard(p);
      return fs.write(p, d);
    },
    writeExclusive: (p, d) => {
      guard(p);
      return fs.writeExclusive(p, d);
    },
    writeUtf8: (p, c) => {
      guard(p);
      return fs.writeUtf8(p, c);
    },
    appendUtf8: (p, c) => {
      guard(p);
      return fs.appendUtf8(p, c);
    },
    exists: (p) => {
      guard(p);
      return fs.exists(p);
    },
    stat: (p) => {
      guard(p);
      return fs.stat(p);
    },
    lstat: (p) => {
      guard(p);
      return fs.lstat(p);
    },
    readdir: (p) => {
      guard(p);
      return fs.readdir(p);
    },
    mkdir: (p) => {
      guard(p);
      return fs.mkdir(p);
    },
    rm: (p) => {
      guard(p);
      return fs.rm(p);
    },
    rename: (s, d) => {
      guard(s);
      guard(d);
      return fs.rename(s, d);
    },
    readlink: (p) => {
      guard(p);
      return fs.readlink(p);
    },
    symlink: (target, linkPath) => {
      // Both arguments are path-confined: the link itself MUST live under cwd
      // (linkPath), and its target MUST also resolve under cwd so we can't
      // create a link inside the repo that points at /etc/passwd. `target` is
      // checked via the same predicate; relative targets that don't start
      // with '/' would be evaluated relative to the link's directory at
      // resolve time — for now we only accept absolute targets that match
      // the cwd-confinement rule.
      guard(target);
      guard(linkPath);
      return fs.symlink(target, linkPath);
    },
    chmod: (p, mode) => {
      guard(p);
      return fs.chmod(p, mode);
    },
    rmRecursive: (p) => {
      guard(p);
      return fs.rmRecursive(p);
    },
    openWithNoFollow: (p, mode) => {
      guard(p);
      return fs.openWithNoFollow(p, mode);
    },
    homedir: () => fs.homedir(),
    xdgConfigHome: () => fs.xdgConfigHome(),
    systemConfigPath: () => fs.systemConfigPath(),
  };
};

/**
 * Containment check: `path` is inside `cwd` iff `path === cwd` OR
 * `path.startsWith(cwd + '/')`. Naive prefix check is sufficient when
 * `cwd` is absolute and normalized (no trailing separator, no `..`
 * components); the facade enforces these via `validateOptions` and
 * `defaultCwd`.
 *
 * Windows fix: callers may produce paths with a mix of `\` (Node's
 * `path.resolve` output) and `/` (template-string-built paths like
 * `${gitDir}/HEAD`). Normalize both sides to forward slash so the prefix
 * check compares like-with-like. POSIX paths are unaffected — they
 * already use `/`.
 */
const normalizeSeparators = (p: string): string => p.replace(/\\/g, '/');

const isContainedIn = (path: string, cwd: string): boolean => {
  const a = normalizeSeparators(path);
  const b = normalizeSeparators(cwd);
  if (a === b) return true;
  const normalizedCwd = b.endsWith('/') ? b : `${b}/`;
  return a.startsWith(normalizedCwd);
};
