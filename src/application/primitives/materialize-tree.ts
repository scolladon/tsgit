/**
 * Compose `walkTree → computeChangeset → applyChangeset` to update the
 * working tree to a target tree's contents.
 *
 * - Branch switch mode: `paths === undefined` — diff the entire current
 *   index against the entire target tree.
 * - Path-restore mode: `paths !== undefined` — restrict both sides of
 *   the diff to those paths.
 *
 * Returns the new IndexEntry list for the caller to commit, plus
 * written/deleted counts. The primitive does NOT commit the index — the
 * caller decides (see design §3.2 + ADR-020).
 */
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { applyChangeset } from './apply-changeset.js';
import { computeChangeset } from './compute-changeset.js';
import { walkTree } from './walk-tree.js';

export interface MaterializeTreeOpts {
  readonly targetTree: ObjectId;
  readonly currentIndex: GitIndex;
  readonly force?: boolean;
  readonly paths?: ReadonlySet<FilePath>;
}

export interface MaterializeTreeResult {
  readonly newIndexEntries: ReadonlyArray<IndexEntry>;
  readonly written: number;
  readonly deleted: number;
}

interface TargetEntry {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const collectTargetEntries = async (ctx: Context, treeId: ObjectId): Promise<TargetEntry[]> => {
  const collected: TargetEntry[] = [];
  for await (const entry of walkTree(ctx, treeId)) {
    if (entry.mode === FILE_MODE.DIRECTORY) continue;
    collected.push({ path: entry.path, id: entry.id, mode: entry.mode });
  }
  return collected;
};

const filterByPaths = <T extends { readonly path: FilePath }>(
  entries: ReadonlyArray<T>,
  paths: ReadonlySet<FilePath>,
): T[] => entries.filter((e) => paths.has(e.path));

export const materializeTree = async (
  ctx: Context,
  opts: MaterializeTreeOpts,
): Promise<MaterializeTreeResult> => {
  const allTarget = await collectTargetEntries(ctx, opts.targetTree);
  const target = opts.paths === undefined ? allTarget : filterByPaths(allTarget, opts.paths);

  const indexForDiff =
    opts.paths === undefined
      ? opts.currentIndex
      : ({
          ...opts.currentIndex,
          entries: filterByPaths(opts.currentIndex.entries, opts.paths),
        } satisfies GitIndex);

  const changeset = computeChangeset(indexForDiff, target);

  const result = await applyChangeset(ctx, {
    changeset,
    force: opts.force ?? false,
    workdir: ctx.layout.workDir,
  });

  return {
    newIndexEntries: result.writtenEntries,
    written: result.written,
    deleted: result.deleted,
  };
};
