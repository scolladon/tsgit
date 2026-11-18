import type { IndexEntry } from '../../../domain/git-index/index.js';
import {
  escapedPathOf,
  type IndexPathKey,
  indexPathKey,
  isLossy,
} from '../../../domain/git-index/index-path-key.js';
import { FILE_MODE, type FilePath } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import type { FileStat } from '../../../ports/file-system.js';
import { createWorkingTreeDirtyCheck, type WorkingTreeDirtyCheck } from '../apply-changeset.js';
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
const isVerifiable = (entry: IndexEntry): boolean =>
  !isLossy(entry) && entry.mode !== FILE_MODE.GITLINK;

/** A racy stat settles nothing: the caller falls back to the content compare. */
const deferRacyToContent = async (): Promise<boolean> => false;

/** What the up-to-date check settled for the out-of-pattern candidates. */
export interface MoverVerdicts {
  /** Content differs from the entry: the file stays. */
  readonly dirty: ReadonlySet<IndexPathKey>;
  /** A regular file or symlink stood there and matched its entry; nothing else was proven. */
  readonly verifiedClean: ReadonlySet<IndexPathKey>;
}

type Verdict = 'dirty' | 'verified-clean' | 'unproven';

const isFileOrLink = (stat: FileStat | undefined | typeof UNREACHABLE): stat is FileStat =>
  stat !== undefined && stat !== UNREACHABLE && (stat.isFile || stat.isSymbolicLink);

const verdictOf = async (
  ctx: Context,
  isDirty: WorkingTreeDirtyCheck,
  entry: IndexEntry,
  absPath: string,
  indexMtime: IndexMtime | undefined,
): Promise<Verdict> => {
  const stat = await lstatBeyondLink(ctx, absPath);
  // git's ie_match_stat: a stat-clean entry is up to date without reading the file.
  if (
    isFileOrLink(stat) &&
    (await matchesCachedStat({ entry, indexMtime }, absPath, stat, deferRacyToContent))
  ) {
    return 'verified-clean';
  }
  if (await isDirty(absPath, entry.id)) return 'dirty';
  return isFileOrLink(stat) ? 'verified-clean' : 'unproven';
};

/** An out-of-pattern file whose content differs from its entry stays, as git's up-to-date check keeps it. */
export const judgeMovers = async (
  ctx: Context,
  workdir: string,
  candidates: ReadonlyArray<IndexEntry>,
  indexMtime: IndexMtime | undefined,
): Promise<MoverVerdicts> => {
  const isDirty = createWorkingTreeDirtyCheck(ctx);
  const verifiable = candidates.filter(isVerifiable);
  const verdicts = await boundedMapFor(ctx, 'ioBound', verifiable, (entry) =>
    verdictOf(ctx, isDirty, entry, joinPath(workdir, escapedPathOf(entry)), indexMtime),
  );
  const keysWith = (wanted: Verdict): Set<IndexPathKey> =>
    new Set(verifiable.filter((_, i) => verdicts[i] === wanted).map(indexPathKey));
  return { dirty: keysWith('dirty'), verifiedClean: keysWith('verified-clean') };
};

export const notUpToDate = async (
  ctx: Context,
  workdir: string,
  candidates: ReadonlyArray<IndexEntry>,
  indexMtime: IndexMtime | undefined,
): Promise<ReadonlySet<IndexPathKey>> =>
  (await judgeMovers(ctx, workdir, candidates, indexMtime)).dirty;

/** One warning, as git prints it, for the out-of-pattern files left in place. */
export const warnLeftDespiteSparse = (ctx: Context, paths: ReadonlyArray<FilePath>): void => {
  if (paths.length === 0) return;
  ctx.logger?.warn?.(
    `${NOT_UP_TO_DATE_HEADER}${paths.map((p) => `\t${p}\n`).join('')}${REAPPLY_HINT}`,
  );
};
