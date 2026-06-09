/**
 * Longest common ancestor directory of a set of absolute POSIX paths. Used to
 * root a worktree filesystem wide enough to reach both the repository and a
 * linked worktree that lives outside it, before the multi-root validator
 * narrows access back down (ADR-298). Pure path algebra.
 */

/** Split an absolute path into its non-empty segments. */
const segmentsOf = (absolutePath: string): ReadonlyArray<string> =>
  absolutePath.split('/').filter((segment) => segment !== '');

/**
 * The deepest directory that contains every path in `paths` (each absolute).
 * Returns `/` when the paths share no prefix or when `paths` is empty.
 */
export const commonAncestor = (paths: ReadonlyArray<string>): string => {
  if (paths.length === 0) return '/';
  const segmentLists = paths.map(segmentsOf);
  const shortest = Math.min(...segmentLists.map((list) => list.length));
  const shared: string[] = [];
  for (let i = 0; i < shortest; i += 1) {
    const segment = segmentLists[0]?.[i];
    if (segment === undefined) break;
    if (!segmentLists.every((list) => list[i] === segment)) break;
    shared.push(segment);
  }
  return `/${shared.join('/')}`;
};
