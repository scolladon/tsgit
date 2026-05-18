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
import { type Changeset, computeChangeset } from './compute-changeset.js';
import { walkTree } from './walk-tree.js';

export interface MaterializeTreeOpts {
  readonly targetTree: ObjectId;
  readonly currentIndex: GitIndex;
  readonly force?: boolean;
  readonly paths?: ReadonlySet<FilePath>;
  /**
   * When true, every target-tree path is written to the working tree
   * unconditionally — even paths the index→target diff classified as `noop`
   * (same `id` AND `mode`). Required by `reset --hard`, where the working
   * tree may diverge from the index (uncommitted local modifications); the
   * standard index→target diff cannot see that drift, so noops would skip
   * paths the caller wants overwritten. Default `false` keeps the Phase
   * 13.1 checkout behaviour: clean files are never spuriously rewritten.
   */
  readonly forceRewriteAll?: boolean;
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

const indexEntriesByPath = (index: GitIndex): Map<FilePath, IndexEntry> => {
  const out = new Map<FilePath, IndexEntry>();
  for (const entry of index.entries) {
    if (entry.flags.stage === 0) out.set(entry.path, entry);
  }
  return out;
};

const writtenEntriesByPath = (
  writtenEntries: ReadonlyArray<IndexEntry>,
): Map<FilePath, IndexEntry> => {
  const out = new Map<FilePath, IndexEntry>();
  for (const entry of writtenEntries) out.set(entry.path, entry);
  return out;
};

const preserveOutOfScope = (
  oldByPath: ReadonlyMap<FilePath, IndexEntry>,
  scopedPaths: ReadonlySet<FilePath> | undefined,
): IndexEntry[] => {
  if (scopedPaths === undefined) return [];
  const out: IndexEntry[] = [];
  for (const [path, entry] of oldByPath) {
    if (!scopedPaths.has(path)) out.push(entry);
  }
  return out;
};

const pickEntry = (
  path: FilePath,
  writtenByPath: ReadonlyMap<FilePath, IndexEntry>,
  oldByPath: ReadonlyMap<FilePath, IndexEntry>,
): IndexEntry | undefined => writtenByPath.get(path) ?? oldByPath.get(path);

const mergeNewIndexEntries = (
  writtenEntries: ReadonlyArray<IndexEntry>,
  currentIndex: GitIndex,
  target: ReadonlyArray<TargetEntry>,
  scopedPaths: ReadonlySet<FilePath> | undefined,
): ReadonlyArray<IndexEntry> => {
  const writtenByPath = writtenEntriesByPath(writtenEntries);
  const oldByPath = indexEntriesByPath(currentIndex);

  const merged: IndexEntry[] = preserveOutOfScope(oldByPath, scopedPaths);
  for (const entry of target) {
    const picked = pickEntry(entry.path, writtenByPath, oldByPath);
    if (picked !== undefined) merged.push(picked);
  }
  merged.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return merged;
};

const upgradeNoopsToUpdates = (changeset: Changeset): Changeset => {
  let upgraded = 0;
  const entries = changeset.entries.map((entry) => {
    if (entry.kind !== 'noop') return entry;
    upgraded += 1;
    return { ...entry, kind: 'update' as const };
  });
  if (upgraded === 0) return changeset;
  return {
    entries,
    stats: {
      ...changeset.stats,
      update: changeset.stats.update + upgraded,
      noop: changeset.stats.noop - upgraded,
    },
  };
};

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

  const rawChangeset = computeChangeset(indexForDiff, target);
  const changeset =
    opts.forceRewriteAll === true ? upgradeNoopsToUpdates(rawChangeset) : rawChangeset;

  const result = await applyChangeset(ctx, {
    changeset,
    force: opts.force ?? false,
    workdir: ctx.layout.workDir,
  });

  return {
    newIndexEntries: mergeNewIndexEntries(
      result.writtenEntries,
      opts.currentIndex,
      target,
      opts.paths,
    ),
    written: result.written,
    deleted: result.deleted,
  };
};
