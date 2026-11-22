import { clearSkipWorktreeFromPresentFiles } from '../../application/primitives/internal/clear-skip-worktree-from-present-files.js';
import type { IndexResolver } from '../../ports/snapshot-resolvers.js';

/**
 * Decorator that clears the skip-worktree bit of present files on every resolve, above the cache:
 * the cached parse stays raw, so a file appearing or vanishing between two resolves is seen
 * without any index write.
 */
export const createClearingIndexResolver = (inner: IndexResolver): IndexResolver => ({
  resolve: async (ctx, opts) =>
    clearSkipWorktreeFromPresentFiles(ctx, await inner.resolve(ctx, opts)),
});
