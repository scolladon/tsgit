import type { IndexEntry } from '../../../domain/git-index/index.js';
import {
  escapedPathOf,
  type IndexPathKey,
  indexPathKey,
  isLossy,
} from '../../../domain/git-index/index-path-key.js';
import { deriveWorkingMode, FILE_MODE } from '../../../domain/objects/file-mode.js';
import type { FilePath } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import type { FileStat } from '../../../ports/file-system.js';
import { createWorkingTreeDirtyCheck, type WorkingTreeDirtyCheck } from '../apply-changeset.js';
import { readConfig } from '../config-read.js';
import { boundedMapFor } from './concurrency.js';
import {
  type IndexMtime,
  lstatBeyondLink,
  matchesCachedStat,
  UNREACHABLE,
} from './is-entry-stat-clean.js';
import { joinPath } from './join-working-tree-path.js';
import { lazily } from './lazily.js';
import { createLeadingPathScanner, type LeadingPathScanner } from './symlinked-leading-path.js';

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
  readonly verifiedClean: ReadonlySet<FilePath>;
}

type Verdict = 'dirty' | 'verified-clean' | 'unproven';

/** What one judgement shares across its candidates. */
interface Judgement {
  readonly ctx: Context;
  readonly isDirty: WorkingTreeDirtyCheck;
  readonly scanner: LeadingPathScanner;
  readonly trustsExecutableBit: () => Promise<boolean>;
  readonly hasSymlinks: () => Promise<boolean>;
  readonly indexMtime: IndexMtime | undefined;
}

/** git's ie_match_stat mode test: a type change is always a change; the executable bit only when core.filemode trusts it. */
const modeDiffers = async (
  { trustsExecutableBit, hasSymlinks }: Judgement,
  entry: IndexEntry,
  stat: FileStat,
): Promise<boolean> => {
  const working = deriveWorkingMode(stat);
  if (working === entry.mode) return false;
  // Without symlink support a symlink entry is checked out as a regular file: not a type change.
  if (entry.mode === FILE_MODE.SYMLINK && stat.isFile && !(await hasSymlinks())) return false;
  const executableBitOnly = working !== FILE_MODE.SYMLINK && entry.mode !== FILE_MODE.SYMLINK;
  return !executableBitOnly || (await trustsExecutableBit());
};

const verdictOf = async (
  judgement: Judgement,
  entry: IndexEntry,
  absPath: string,
): Promise<Verdict> => {
  const { ctx, isDirty, scanner, indexMtime } = judgement;
  const stat = await lstatBeyondLink(ctx, absPath);
  // git's verify_uptodate: ENOENT is up to date, any other lstat failure is left and warned.
  if (stat === undefined) return 'unproven';
  if (stat === UNREACHABLE) return 'dirty';
  // git never reads through a symlinked leading directory: what it reaches there is not the entry.
  if (await scanner.hasSymlinkedLeadingPath(escapedPathOf(entry))) return 'dirty';
  // A directory or another kind of occupant is never the entry's file, and is never read.
  if (!stat.isFile && !stat.isSymbolicLink) return 'dirty';
  if (await modeDiffers(judgement, entry, stat)) return 'dirty';
  // git's ie_match_stat: a stat-clean entry is up to date without reading the file.
  if (await matchesCachedStat({ entry, indexMtime }, absPath, stat, deferRacyToContent)) {
    return 'verified-clean';
  }
  return (await isDirty(absPath, entry.id)) ? 'dirty' : 'verified-clean';
};

/** An out-of-pattern file whose content differs from its entry stays, as git's up-to-date check keeps it. */
export const judgeMovers = async (
  ctx: Context,
  workdir: string,
  candidates: ReadonlyArray<IndexEntry>,
  indexMtime: IndexMtime | undefined,
): Promise<MoverVerdicts> => {
  const judgement: Judgement = {
    ctx,
    isDirty: createWorkingTreeDirtyCheck(ctx),
    scanner: createLeadingPathScanner(ctx),
    trustsExecutableBit: lazily(async () => (await readConfig(ctx)).core?.fileMode !== false),
    hasSymlinks: lazily(async () => (await readConfig(ctx)).core?.symlinks !== false),
    indexMtime,
  };
  const verifiable = candidates.filter(isVerifiable);
  const verdicts = await boundedMapFor(ctx, 'ioBound', verifiable, (entry) =>
    verdictOf(judgement, entry, joinPath(workdir, escapedPathOf(entry))),
  );
  const entriesWith = (wanted: Verdict): ReadonlyArray<IndexEntry> =>
    verifiable.filter((_, i) => verdicts[i] === wanted);
  return {
    dirty: new Set(entriesWith('dirty').map(indexPathKey)),
    verifiedClean: new Set(entriesWith('verified-clean').map(escapedPathOf)),
  };
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
