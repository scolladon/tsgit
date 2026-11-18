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
import { joinPath } from './join-working-tree-path.js';

const NOT_UP_TO_DATE_HEADER =
  'The following paths are not up to date and were left despite sparse patterns:\n';
const REAPPLY_HINT =
  '\nAfter fixing the above paths, you may want to run `git sparse-checkout reapply`.';

/** A lossy path and a gitlink keep the verdict they had before: the delete wave already handles them. */
const isVerifiable = (entry: IndexEntry): boolean =>
  !isLossy(entry) && entry.mode !== FILE_MODE.GITLINK;

/** An out-of-pattern file whose content differs from its entry stays, as git's up-to-date check keeps it. */
export const notUpToDate = async (
  ctx: Context,
  workdir: string,
  candidates: ReadonlyArray<IndexEntry>,
): Promise<ReadonlySet<IndexPathKey>> => {
  const isDirty = createWorkingTreeDirtyCheck(ctx);
  const dirty = new Set<IndexPathKey>();
  for (const entry of candidates.filter(isVerifiable)) {
    if (await isDirty(joinPath(workdir, escapedPathOf(entry)), entry.id)) {
      dirty.add(indexPathKey(entry));
    }
  }
  return dirty;
};

/** One warning, as git prints it, for the out-of-pattern files left in place. */
export const warnLeftDespiteSparse = (ctx: Context, paths: ReadonlyArray<FilePath>): void => {
  if (paths.length === 0) return;
  ctx.logger?.warn?.(
    `${NOT_UP_TO_DATE_HEADER}${paths.map((p) => `\t${p}\n`).join('')}${REAPPLY_HINT}`,
  );
};
