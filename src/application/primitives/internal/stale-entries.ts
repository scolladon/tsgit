import type { GitIndex } from '../../../domain/git-index/index.js';
import type { IndexEntry } from '../../../domain/git-index/index-entry.js';
import {
  type IndexPathKey,
  indexPathKey,
  isLossy,
} from '../../../domain/git-index/index-path-key.js';
import { FILE_MODE } from '../../../domain/objects/file-mode.js';
import type { Context } from '../../../ports/context.js';
import { racyContentMatcher } from '../compare-working-tree-entry.js';
import type { ChangesetEntry } from '../compute-changeset.js';
import { boundedMapFor } from './concurrency.js';
import type { RacyContentCheck } from './is-entry-stat-clean.js';
import { lstatBeyondLink, matchesCachedStat, UNREACHABLE } from './is-entry-stat-clean.js';
import { joinPath } from './join-working-tree-path.js';
import { createLeadingPathScanner } from './symlinked-leading-path.js';

const stageZeroByKey = (index: GitIndex): Map<IndexPathKey, IndexEntry> =>
  new Map(
    index.entries.filter((e) => e.flags.stage === 0).map((e) => [indexPathKey(e), e] as const),
  );

const isUpToDate = async (
  ctx: Context,
  cached: IndexEntry,
  indexMtime: GitIndex['indexMtime'],
  absPath: string,
  contentMatches: RacyContentCheck,
): Promise<boolean> => {
  const stat = await lstatBeyondLink(ctx, absPath);
  if (stat === undefined || stat === UNREACHABLE) return false;
  if (cached.mode === FILE_MODE.GITLINK) return stat.isDirectory;
  return matchesCachedStat({ entry: cached, indexMtime }, absPath, stat, contentMatches);
};

/**
 * Which git routine judges a work-tree path up to date: the one-way merge (`reset --hard`, forced
 * switch, stash) follows a symlinked leading directory with a plain lstat, while `checkout_entry`
 * (path restore) treats an entry beyond such a link as missing.
 */
export type StaleRule = 'oneway' | 'checkoutEntry';

/** git's one-way merge: a noop whose work-tree path is not up to date becomes an update. */
export const upgradeStaleNoops = async (
  ctx: Context,
  entries: ReadonlyArray<ChangesetEntry>,
  index: GitIndex,
  workdir: string,
  rule: StaleRule = 'oneway',
): Promise<ReadonlyArray<ChangesetEntry>> => {
  const cachedByKey = stageZeroByKey(index);
  const contentMatches = racyContentMatcher(ctx);
  const scanner = createLeadingPathScanner(ctx);
  const judged = await boundedMapFor(ctx, 'ioBound', entries, async (entry) => {
    if (entry.kind !== 'noop' || isLossy(entry)) return entry;
    const cached = cachedByKey.get(indexPathKey(entry));
    if (cached?.flags.skipWorktree === true) return entry;
    if (rule === 'checkoutEntry' && (await scanner.hasSymlinkedLeadingPath(entry.path))) {
      return { ...entry, kind: 'update' as const };
    }
    const absPath = joinPath(workdir, entry.path);
    const upToDate =
      cached !== undefined &&
      (await isUpToDate(ctx, cached, index.indexMtime, absPath, contentMatches));
    return upToDate ? entry : { ...entry, kind: 'update' as const };
  });
  return judged;
};
