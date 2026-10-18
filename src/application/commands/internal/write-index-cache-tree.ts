import { carriedCacheTreeOf } from '../../../domain/git-index/cache-tree-update.js';
import type { CacheTreeEntry } from '../../../domain/git-index/index-entry.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { acquireIndexLock } from '../../primitives/internal/index-lock.js';
import {
  isCacheTreeFullyValid,
  updateCacheTree,
} from '../../primitives/internal/update-cache-tree.js';
import { readIndex } from '../../primitives/read-index.js';
import { rejectUnmergedIndex } from './unmerged-index.js';

const settledRoot = async (
  ctx: Context,
  carried: CacheTreeEntry | undefined,
): Promise<ObjectId | undefined> =>
  (await isCacheTreeFullyValid(ctx, carried)) ? carried?.id : undefined;

/** git's prepare_index for a plain commit: lock, read, refuse unmerged, update TREE, write iff it changed. */
export const writeIndexCacheTree = async (ctx: Context): Promise<ObjectId> => {
  const lock = await acquireIndexLock(ctx);
  try {
    const index = await readIndex(ctx);
    rejectUnmergedIndex(index.entries);
    const carried = carriedCacheTreeOf(index.extensions, ctx.hashConfig.digestLength);
    const settled = await settledRoot(ctx, carried);
    if (settled !== undefined) return settled;
    const { cacheTree, rootTree } = await updateCacheTree(ctx, index.entries, carried, 'write');
    await lock.commit(index.entries, 'update', { cacheTree });
    return rootTree;
  } finally {
    await lock.release();
  }
};
