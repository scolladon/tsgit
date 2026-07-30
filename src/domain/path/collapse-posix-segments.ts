/**
 * Collapses `.`/`..`/duplicate-slash segments in a POSIX-style path, joining
 * what remains back onto a single leading slash: absolute in, absolute out.
 * `..` never pops below the root. Deliberately NOT `path.posix.resolve` —
 * there is no relative-to-cwd fallback; callers root their input first.
 */
export const collapsePosixSegments = (path: string): string => {
  const resolved: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return `/${resolved.join('/')}`;
};
