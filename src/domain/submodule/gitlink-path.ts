/**
 * Relative-path algebra for the absorbed submodule layout — the two pointers git
 * writes when a submodule lives at `.git/modules/<name>` with its working tree at
 * the superproject-relative `<path>`. Both inputs are already
 * `isUnsafeSubmoduleName`-validated (no leading/empty/`..` segment), so a split on
 * `/` yields the exact directory depth.
 */

/** Count `/`-separated segments of an already-safe (no leading/trailing slash) value. */
const segmentCount = (value: string): number => value.split('/').length;

/**
 * The `.git` gitfile content placed in the submodule working tree at `<path>`:
 * `gitdir: <../ × pathDepth>.git/modules/<name>`. The `../` run climbs from the
 * worktree back to the superproject root before descending into the absorbed
 * gitdir.
 */
export const submoduleGitfile = (name: string, path: string): string =>
  `gitdir: ${'../'.repeat(segmentCount(path))}.git/modules/${name}`;

/**
 * The `core.worktree` value written into `.git/modules/<name>/config`:
 * `<../ × (2 + nameDepth)><path>`. The absorbed gitdir sits two levels under the
 * superproject root (`.git/modules/`) plus the name's own depth, so the `../` run
 * climbs back to the root before descending into the worktree `<path>`.
 */
export const submoduleCoreWorktree = (name: string, path: string): string =>
  `${'../'.repeat(2 + segmentCount(name))}${path}`;

const commonPrefixLength = (from: ReadonlyArray<string>, to: ReadonlyArray<string>): number => {
  let length = 0;
  // Stryker disable next-line LogicalOperator,EqualityOperator: equivalent — an index at either array's length reads undefined on that side, and undefined equals only an undefined past the other end, so every loosened bound stops at the same length
  while (length < from.length && length < to.length && from[length] === to[length]) length++;
  return length;
};

/**
 * The relative path git writes as `core.worktree`: from the module directory up to the
 * deepest ancestor it shares with the working-tree path, then down to it. Both inputs are
 * absolute and normalised, so a split on `/` yields exact segments.
 */
export const relativePathBetween = (fromDirectory: string, toPath: string): string => {
  const from = fromDirectory.split('/');
  const to = toPath.split('/');
  const shared = commonPrefixLength(from, to);
  const climb = from.slice(shared).map(() => '..');
  return [...climb, ...to.slice(shared)].join('/');
};
