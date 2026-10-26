import type { Context } from '../../../ports/context.js';
import { withFilterProcessPool } from '../../primitives/internal/filter-process-pool.js';
import { acquireIndexLock, withRefreshedStat } from '../../primitives/internal/index-lock.js';
import { scanTrackedEntries, verifiedBy } from '../../primitives/internal/scan-tracked-entries.js';
import { readIndex } from '../../primitives/read-index.js';
import { rejectUnmergedIndex } from './unmerged-index.js';

/** git's commit and stash refresh is `REFRESH_QUIET`: nothing reports per-entry progress. */
export const QUIET_SCAN = (): void => undefined;

/** git's `refresh_and_write_cache`: refuses an unmerged index, refreshes stat-only drift, writes only when something refreshed. */
export const refreshAndWriteIndex = (ctx: Context): Promise<void> =>
  withFilterProcessPool(ctx, async () => {
    const lock = await acquireIndexLock(ctx);
    try {
      const index = await readIndex(ctx);
      rejectUnmergedIndex(index.entries);
      const scan = await scanTrackedEntries(ctx, index, index.entries, QUIET_SCAN);
      if (scan.refreshed.length === 0) return;
      await lock.commit(withRefreshedStat(index, scan.refreshed), 'update', {
        verified: verifiedBy(scan),
      });
    } finally {
      await lock.release();
    }
  });
