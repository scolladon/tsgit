import type { RefName } from '../objects/index.js';

/**
 * The candidate ref names a short base may stand for, in gitrevisions
 * resolution priority order (the six "Specifying revisions" rules):
 *
 * 1. verbatim — covers full `refs/…` paths, the `HEAD` literal, and top-level
 *    pseudo-refs like `refs/stash` / `MERGE_HEAD`;
 * 2. `refs/<base>` — top-level refs (this is the rule that resolves `stash`);
 * 3. `refs/tags/<base>`;
 * 4. `refs/heads/<base>` — tags precede heads, so a name that is both a tag and
 *    a branch resolves to the tag first (matching git);
 * 5. `refs/remotes/<base>`;
 * 6. `refs/remotes/<base>/HEAD`.
 *
 * Shared by `rev-parse` and `merge` so tsgit resolves a short ref the same way
 * everywhere.
 */
export const refCandidates = (base: string): ReadonlyArray<RefName | 'HEAD'> => [
  base as RefName,
  `refs/${base}` as RefName,
  `refs/tags/${base}` as RefName,
  `refs/heads/${base}` as RefName,
  `refs/remotes/${base}` as RefName,
  `refs/remotes/${base}/HEAD` as RefName,
];
