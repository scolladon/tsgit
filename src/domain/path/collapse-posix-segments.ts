/**
 * Collapses `.`/`..`/duplicate-slash segments in a POSIX-style path, joining
 * what remains back onto a single leading slash. Shared by
 * `repository/portable-posix-policy.ts` (already-absolute paths only) and
 * `adapters/memory/memory-file-system.ts` (paths rooted against `rootDir`
 * before reaching here) — both feed it a string that is absolute by the time
 * it arrives, so this does not implement `path.posix.resolve`'s
 * relative-to-cwd fallback.
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
