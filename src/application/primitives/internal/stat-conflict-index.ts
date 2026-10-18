import type { GitIndex, IndexEntry } from '../../../domain/git-index/index.js';
import { escapedPathOf, isLossy } from '../../../domain/git-index/index-path-key.js';
import type { FilePath } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { withStatData } from './index-entry-from-stat.js';
import { joinPath } from './join-working-tree-path.js';
import { requireWorkTree } from './repo-state.js';

const isStageZero = (entry: IndexEntry): boolean => entry.flags.stage === 0;

const sameContent = (a: IndexEntry, b: IndexEntry): boolean => a.id === b.id && a.mode === b.mode;

const priorStageZeroByPath = (index: GitIndex): ReadonlyMap<FilePath, IndexEntry> =>
  new Map(index.entries.filter(isStageZero).map((entry) => [escapedPathOf(entry), entry]));

/**
 * The stat data git records at a conflict stop: a clean path the merge did not touch keeps its
 * entry as it was, a path the merge wrote takes the stat of the file it wrote. Unmerged stages
 * and entries with no file behind them stay zero-stat.
 */
export const withConflictStopStats = async (
  ctx: Context,
  entries: ReadonlyArray<IndexEntry>,
  currentIndex: GitIndex,
  written: ReadonlySet<FilePath>,
): Promise<ReadonlyArray<IndexEntry>> => {
  const prior = priorStageZeroByPath(currentIndex);
  const workDir = requireWorkTree(ctx, 'merge');
  const statOf = async (entry: IndexEntry): Promise<IndexEntry> => {
    if (!isStageZero(entry) || isLossy(entry)) return entry;
    const path = escapedPathOf(entry);
    if (written.has(path)) {
      return withStatData(entry, await ctx.fs.lstat(joinPath(workDir, path)));
    }
    const before = prior.get(path);
    return before !== undefined && sameContent(before, entry) ? before : entry;
  };
  return Promise.all(entries.map(statOf));
};
