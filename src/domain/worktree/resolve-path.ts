/**
 * Resolve a user-supplied worktree path to a clean absolute path. A linked
 * worktree may live anywhere (`../sibling`, an absolute path), so — unlike an
 * in-repo working-tree path — `..` is allowed and resolved here rather than
 * rejected. The result has no `.`/`..`/empty segments; the FS containment escape
 * (ADR-298) then re-roots at it. Pure POSIX path algebra.
 */

/** The last path component of an absolute path (used as the default branch/id). */
export const worktreePathBasename = (absolutePath: string): string => {
  const segments = absolutePath.split('/').filter((s) => s !== '');
  return segments[segments.length - 1] ?? '';
};

/**
 * Resolve `input` against `cwd` into a normalised absolute path. An absolute
 * `input` ignores `cwd`; a relative one is joined onto it. `.` segments are
 * dropped and `..` pops the previous segment (never below the root).
 */
export const resolveWorktreePath = (cwd: string, input: string): string => {
  const base = input.startsWith('/') ? input : `${cwd}/${input}`;
  const out: string[] = [];
  for (const segment of base.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return `/${out.join('/')}`;
};
