import type { IndexEntry } from '../../../domain/git-index/index.js';
import {
  escapedPathOf,
  type IndexPathKey,
  indexPathKey,
  isLossy,
} from '../../../domain/git-index/index-path-key.js';
import { FILE_MODE, type FilePath } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { createWorkingTreeDirtyCheck } from '../apply-changeset.js';
import { boundedMapFor } from './concurrency.js';
import {
  type IndexMtime,
  lstatBeyondLink,
  matchesCachedStat,
  UNREACHABLE,
} from './is-entry-stat-clean.js';
import { joinPath } from './join-working-tree-path.js';

const NOT_UP_TO_DATE_HEADER =
  'The following paths are not up to date and were left despite sparse patterns:\n';
const REAPPLY_HINT =
  '\nAfter fixing the above paths, you may want to run `git sparse-checkout reapply`.';

/** A lossy path and a gitlink keep the verdict they had before: the delete wave already handles them. */
export const isVerifiable = (entry: IndexEntry): boolean =>
  !isLossy(entry) && entry.mode !== FILE_MODE.GITLINK;

/** A racy stat settles nothing: the caller falls back to the content compare. */
const deferRacyToContent = async (): Promise<boolean> => false;

/** git's ie_match_stat: a stat-clean entry is up to date without reading the file. */
const isStatClean = async (
  ctx: Context,
  entry: IndexEntry,
  absPath: string,
  indexMtime: IndexMtime | undefined,
): Promise<boolean> => {
  const stat = await lstatBeyondLink(ctx, absPath);
  if (stat === undefined || stat === UNREACHABLE) return false;
  return matchesCachedStat({ entry, indexMtime }, absPath, stat, deferRacyToContent);
};

/** An out-of-pattern file whose content differs from its entry stays, as git's up-to-date check keeps it. */
export const notUpToDate = async (
  ctx: Context,
  workdir: string,
  candidates: ReadonlyArray<IndexEntry>,
  indexMtime: IndexMtime | undefined,
): Promise<ReadonlySet<IndexPathKey>> => {
  const isDirty = createWorkingTreeDirtyCheck(ctx);
  const verdicts = await boundedMapFor(
    ctx,
    'ioBound',
    candidates.filter(isVerifiable),
    async (entry) => {
      const absPath = joinPath(workdir, escapedPathOf(entry));
      if (await isStatClean(ctx, entry, absPath, indexMtime)) return undefined;
      return (await isDirty(absPath, entry.id)) ? indexPathKey(entry) : undefined;
    },
  );
  return new Set(verdicts.filter((key): key is IndexPathKey => key !== undefined));
};

/** One warning, as git prints it, for the out-of-pattern files left in place. */
export const warnLeftDespiteSparse = (ctx: Context, paths: ReadonlyArray<FilePath>): void => {
  if (paths.length === 0) return;
  ctx.logger?.warn?.(
    `${NOT_UP_TO_DATE_HEADER}${paths.map((p) => `\t${p}\n`).join('')}${REAPPLY_HINT}`,
  );
};
