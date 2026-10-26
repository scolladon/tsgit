import type { GitIndex, IndexEntry } from '../../../domain/git-index/index.js';
import type { Context } from '../../../ports/context.js';
import { withFilterProcessPool } from '../../primitives/internal/filter-process-pool.js';
import { acquireIndexLock, withRefreshedStat } from '../../primitives/internal/index-lock.js';
import { scanTrackedEntries, verifiedBy } from '../../primitives/internal/scan-tracked-entries.js';
import type { IsVerified } from '../../primitives/internal/smudge-racily-clean.js';
import { readIndex } from '../../primitives/read-index.js';
import { rejectUnmergedIndex } from './unmerged-index.js';

/** git's commit and stash refresh is `REFRESH_QUIET`: nothing reports per-entry progress. */
export const QUIET_SCAN = (): void => undefined;

export interface RefreshedIndex {
  /** The index with every stat-drifted, content-equal entry carrying its working file's stat. */
  readonly currentIndex: GitIndex;
  readonly refreshed: ReadonlyArray<IndexEntry>;
  /** The paths the scan found unchanged, so the commit's racy smudge does not re-read them. */
  readonly verified: IsVerified;
}

/** git's `refresh_index`: stat-only drift is refreshed, a content change or a flagged entry is left as read. */
export const refreshedIndex = async (ctx: Context, index: GitIndex): Promise<RefreshedIndex> => {
  const scan = await scanTrackedEntries(ctx, index, index.entries, QUIET_SCAN);
  return {
    currentIndex: { ...index, entries: [...withRefreshedStat(index, scan.refreshed)] },
    refreshed: scan.refreshed,
    verified: verifiedBy(scan),
  };
};

/**
 * git's `refresh_and_write_cache`: refreshes stage-0 stat drift, rewrites the index unconditionally,
 * and only then refuses an unmerged one — the refusal leaves the refreshed index on disk.
 */
export const refreshAndWriteIndex = (ctx: Context): Promise<void> =>
  withFilterProcessPool(ctx, async () => {
    const lock = await acquireIndexLock(ctx);
    try {
      const index = await readIndex(ctx);
      const { currentIndex, verified } = await refreshedIndex(ctx, index);
      await lock.commit(currentIndex.entries, 'update', { verified });
      rejectUnmergedIndex(index.entries);
    } finally {
      await lock.release();
    }
  });
