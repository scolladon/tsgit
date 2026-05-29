import type { RefName } from '../objects/index.js';

/**
 * The candidate ref names a short base may stand for, in resolution priority
 * order: verbatim (covers full `refs/…` paths and the `HEAD` literal), then the
 * `refs/heads/`, `refs/tags/`, and `refs/remotes/` namespaces. This is the
 * gitrevisions ref-DWIM ladder shared by `rev-parse` and `merge` so tsgit
 * resolves a short ref the same way everywhere.
 */
export const refCandidates = (base: string): ReadonlyArray<RefName | 'HEAD'> => [
  base as RefName,
  `refs/heads/${base}` as RefName,
  `refs/tags/${base}` as RefName,
  `refs/remotes/${base}` as RefName,
];
