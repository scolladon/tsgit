/**
 * Project a target tree onto a fresh stage-0 IndexEntry list, preserving
 * stat-cache fields from the prior index where the path's `id` AND `mode`
 * both match (the "stat-cache donor" strategy).
 *
 * Pure with respect to the working tree: this primitive never calls
 * `fs.lstat`, `fs.read`, or any working-tree-side API. It only reads git
 * objects via `walkTree` → `readObject` for nested trees.
 *
 * Used by `reset --mixed` to rebuild the index from a target
 * commit's tree. Will be re-used by `reset --hard` composed
 * with `materializeTree` to also write the working tree.
 *
 * ## Preconditions
 *
 * `currentIndex` MUST be read under the same `acquireIndexLock` that will
 * later commit the result. Reading the index BEFORE the lock is acquired
 * lets a concurrent writer mutate it between the donor-map build and the
 * commit, producing a result that reflects neither the pre-reset nor the
 * post-reset state. See `reset.ts:rebuildIndexFromCommit` for the
 * canonical pattern: acquire → read → build → commit → release-in-finally.
 */
import {
  type GitIndex,
  type IndexEntry,
  type IndexEntryFlags,
  STAGE0_FLAGS,
  skipWorktreeEntry,
} from '../../domain/git-index/index.js';
import { pathComparatorFor } from '../../domain/git-index/index-writer.js';
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../domain/objects/index.js';
import type { SparseMatcher } from '../../domain/sparse/index.js';
import type { Context } from '../../ports/context.js';
import { walkTree } from './walk-tree.js';

export interface BuildIndexFromTreeOpts {
  readonly targetTree: ObjectId;
  readonly currentIndex: GitIndex;
  /**
   * Sparse-checkout filter. When supplied, an excluded path is rebuilt as a
   * zero-stat skip-worktree entry and an in-pattern path has any stale
   * skip-worktree bit cleared. `undefined` ⇒ sparse inactive — the rebuilt
   * index is byte-identical to the non-sparse behaviour.
   */
  readonly sparse?: SparseMatcher;
}

interface TargetLeaf {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const donorByPath = (currentIndex: GitIndex): Map<FilePath, IndexEntry> => {
  const map = new Map<FilePath, IndexEntry>();
  for (const entry of currentIndex.entries) {
    if (entry.flags.stage !== 0) continue;
    map.set(entry.path, entry);
  }
  return map;
};

const collectLeaves = async (ctx: Context, treeId: ObjectId): Promise<TargetLeaf[]> => {
  const leaves: TargetLeaf[] = [];
  for await (const entry of walkTree(ctx, treeId)) {
    if (entry.mode === FILE_MODE.DIRECTORY) continue;
    leaves.push({ path: entry.path, id: entry.id, mode: entry.mode });
  }
  return leaves;
};

const zeroStatEntry = (leaf: TargetLeaf): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: leaf.mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: leaf.id,
  flags: STAGE0_FLAGS,
  path: leaf.path,
});

/**
 * Resolve the `flags` of a donor-matched, in-pattern (or non-sparse) leaf.
 * Stage is always forced to 0. When sparse is active the skip-worktree bit is
 * cleared — the donor may carry a stale one from when the path was excluded,
 * and the matcher (which classified this path in-pattern) is authoritative.
 * When sparse is inactive the donor flags pass through verbatim, so a manually
 * set skip-worktree bit survives a non-sparse `reset --mixed`.
 */
const includedFlags = (
  donorFlags: IndexEntryFlags,
  sparse: SparseMatcher | undefined,
): IndexEntryFlags =>
  sparse !== undefined
    ? { ...donorFlags, stage: 0, skipWorktree: false }
    : { ...donorFlags, stage: 0 };

const projectLeaf = (
  leaf: TargetLeaf,
  donors: ReadonlyMap<FilePath, IndexEntry>,
  sparse: SparseMatcher | undefined,
): IndexEntry => {
  validateIndexPath(leaf.path, NO_PARSER_OFFSET, leaf.mode);
  // An excluded path is rebuilt as a zero-stat skip-worktree entry — the file
  // is absent from disk, so any donor stat cache is meaningless.
  if (sparse !== undefined && !sparse(leaf.path)) return skipWorktreeEntry(leaf);
  const donor = donors.get(leaf.path);
  const matches = donor !== undefined && donor.id === leaf.id && donor.mode === leaf.mode;
  if (!matches) return zeroStatEntry(leaf);
  return { ...donor, flags: includedFlags(donor.flags, sparse) };
};

export const buildIndexFromTree = async (
  ctx: Context,
  opts: BuildIndexFromTreeOpts,
): Promise<ReadonlyArray<IndexEntry>> => {
  const donors = donorByPath(opts.currentIndex);
  const leaves = await collectLeaves(ctx, opts.targetTree);
  const entries = leaves.map((leaf) => projectLeaf(leaf, donors, opts.sparse));
  entries.sort(pathComparatorFor(entries));
  return entries;
};
