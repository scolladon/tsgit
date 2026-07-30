import type { RepositoryLayoutInput } from '../repository.js';
import { isContainedIn } from './wrap-fs-validator.js';

/**
 * Containment-minimised FS root set for a repository layout —
 * `[workDir, gitDir, commonDir ?? gitDir]` deduped, with any root already
 * contained in another root dropped. First-seen order is preserved so
 * `workDir` (the guard's hot path in `wrapFsValidator`) stays first when it
 * survives.
 *
 * Minimisation is not cosmetic: the caller's containment guard runs on every
 * path-taking FS call. A normal repo (no `commonDir`) collapses to exactly
 * `[workDir]` — bit-identical to the pre-discovery single-root guard — rather
 * than paying two redundant prefix comparisons per call forever. A linked
 * worktree collapses to `[workDir, commonDir]` (the admin `gitDir` always
 * lives under `commonDir`); a hand-written `commondir` pointing at an
 * unrelated subtree keeps all three.
 */
export const layoutRootsOf = (layout: RepositoryLayoutInput): ReadonlyArray<string> => {
  const candidates = [layout.workDir, layout.gitDir, layout.commonDir ?? layout.gitDir];
  const deduped: string[] = [];
  for (const candidate of candidates) {
    if (!deduped.includes(candidate)) deduped.push(candidate);
  }
  return deduped.filter(
    (root) => !deduped.some((other) => other !== root && isContainedIn(root, other)),
  );
};
