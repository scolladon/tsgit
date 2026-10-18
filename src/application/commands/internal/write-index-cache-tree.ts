import { carriedCacheTreeOf } from '../../../domain/git-index/cache-tree-update.js';
import type { GitIndex } from '../../../domain/git-index/index.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { withFilterProcessPool } from '../../primitives/internal/filter-process-pool.js';
import {
  acquireIndexLock,
  type IndexLock,
  withRefreshedStat,
} from '../../primitives/internal/index-lock.js';
import { scanTrackedEntries, verifiedBy } from '../../primitives/internal/scan-tracked-entries.js';
import {
  isCacheTreeFullyValid,
  updateCacheTree,
} from '../../primitives/internal/update-cache-tree.js';
import { readIndex } from '../../primitives/read-index.js';
import { rejectUnmergedIndex } from './unmerged-index.js';

/** git's commit refresh is `REFRESH_QUIET`: nothing reports per-entry progress. */
const QUIET_SCAN = (): void => undefined;

const refreshAndUpdate = async (
  ctx: Context,
  lock: IndexLock,
  index: GitIndex,
): Promise<ObjectId> => {
  // Every entry is stage 0 here: `rejectUnmergedIndex` has already refused otherwise.
  const scan = await scanTrackedEntries(ctx, index, index.entries, QUIET_SCAN);
  const entries = withRefreshedStat(index, scan.refreshed);
  const carried = carriedCacheTreeOf(index.extensions, ctx.hashConfig.digestLength);
  const settled = (await isCacheTreeFullyValid(ctx, carried)) ? carried : undefined;
  const verified = verifiedBy(scan);
  if (settled?.id !== undefined) {
    if (scan.refreshed.length > 0)
      await lock.commit(entries, 'update', { cacheTree: settled, verified });
    return settled.id;
  }
  const { cacheTree, rootTree } = await updateCacheTree(ctx, entries, carried, 'write');
  await lock.commit(entries, 'update', { cacheTree, verified });
  return rootTree;
};

/** git's prepare_index for a plain commit: lock, read, refuse unmerged, refresh stats, update TREE, write iff stats or TREE changed. */
export const writeIndexCacheTree = (ctx: Context): Promise<ObjectId> =>
  withFilterProcessPool(ctx, async () => {
    const lock = await acquireIndexLock(ctx);
    try {
      const index = await readIndex(ctx);
      rejectUnmergedIndex(index.entries);
      return await refreshAndUpdate(ctx, lock, index);
    } finally {
      await lock.release();
    }
  });
