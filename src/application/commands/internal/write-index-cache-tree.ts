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
  assertIsTree,
  isCacheTreeFullyValid,
  updateCacheTree,
} from '../../primitives/internal/update-cache-tree.js';
import { readIndex } from '../../primitives/read-index.js';
import { rejectUnmergedIndex } from './unmerged-index.js';

/** git's commit refresh is `REFRESH_QUIET`: nothing reports per-entry progress. */
const QUIET_SCAN = (): void => undefined;

type Scan = Awaited<ReturnType<typeof scanTrackedEntries>>;

const settleCacheTree = async (
  ctx: Context,
  lock: IndexLock,
  index: GitIndex,
  scan: Scan,
): Promise<ObjectId> => {
  const entries = withRefreshedStat(index, scan.refreshed);
  const carried = carriedCacheTreeOf(index.extensions, ctx.hashConfig.digestLength);
  const settled = (await isCacheTreeFullyValid(ctx, carried)) ? carried : undefined;
  const verified = verifiedBy(scan);
  if (settled?.id !== undefined) {
    await assertIsTree(ctx, settled.id);
    if (scan.refreshed.length > 0)
      await lock.commit(entries, 'update', { cacheTree: settled, verified });
    return settled.id;
  }
  const { cacheTree, rootTree } = await updateCacheTree(ctx, entries, carried, 'write');
  await lock.commit(entries, 'update', { cacheTree, verified });
  return rootTree;
};

/** Every entry is stage 0 here: `rejectUnmergedIndex` has already refused otherwise. */
const scanQuietly = (ctx: Context, index: GitIndex): Promise<Scan> =>
  scanTrackedEntries(ctx, index, index.entries, QUIET_SCAN);

const refreshAndUpdate = async (
  ctx: Context,
  lock: IndexLock,
  index: GitIndex,
): Promise<ObjectId> => settleCacheTree(ctx, lock, index, await scanQuietly(ctx, index));

/**
 * The refreshed index git's parent process writes after the child commit replaces the child's
 * cache-tree with the one it read before it: only the refreshed stats land, TREE keeps its state.
 */
const refreshKeepingCarriedTree = async (
  ctx: Context,
  lock: IndexLock,
  index: GitIndex,
): Promise<ObjectId> => {
  const scan = await scanQuietly(ctx, index);
  if (scan.refreshed.length === 0) return settleCacheTree(ctx, lock, index, scan);
  const entries = withRefreshedStat(index, scan.refreshed);
  const carried = carriedCacheTreeOf(index.extensions, ctx.hashConfig.digestLength);
  const { rootTree } = await updateCacheTree(ctx, entries, carried, 'write');
  await lock.commit(entries, 'update', { verified: verifiedBy(scan) });
  return rootTree;
};

type IndexPass = (ctx: Context, lock: IndexLock, index: GitIndex) => Promise<ObjectId>;

const underIndexLock = (ctx: Context, pass: IndexPass): Promise<ObjectId> =>
  withFilterProcessPool(ctx, async () => {
    const lock = await acquireIndexLock(ctx);
    try {
      const index = await readIndex(ctx);
      rejectUnmergedIndex(index.entries);
      return await pass(ctx, lock, index);
    } finally {
      await lock.release();
    }
  });

/** git's prepare_index for a plain commit: lock, read, refuse unmerged, refresh stats, update TREE, write iff stats or TREE changed. */
export const writeIndexCacheTree = (ctx: Context): Promise<ObjectId> =>
  underIndexLock(ctx, refreshAndUpdate);

/** A sequencer `--continue`: the commit pass of `writeIndexCacheTree`, except a stat refresh leaves TREE as it was. */
export const writeContinuedIndex = (ctx: Context): Promise<ObjectId> =>
  underIndexLock(ctx, refreshKeepingCarriedTree);
