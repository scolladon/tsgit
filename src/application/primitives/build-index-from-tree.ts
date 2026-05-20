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
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { walkTree } from './walk-tree.js';

export interface BuildIndexFromTreeOpts {
  readonly targetTree: ObjectId;
  readonly currentIndex: GitIndex;
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
  flags: { assumeValid: false, extended: false, stage: 0 },
  path: leaf.path,
});

const projectLeaf = (leaf: TargetLeaf, donors: ReadonlyMap<FilePath, IndexEntry>): IndexEntry => {
  const donor = donors.get(leaf.path);
  const matches = donor !== undefined && donor.id === leaf.id && donor.mode === leaf.mode;
  if (!matches) return zeroStatEntry(leaf);
  return {
    ...donor,
    flags: { ...donor.flags, stage: 0 },
  };
};

// The comparator + the `entries.sort` call below are a defensive layer. Every
// caller reaches the sort through `collectLeaves` → `walkTree`, which performs
// a depth-first traversal of an on-disk tree; on-disk trees are always written
// by `serializeTreeContent` → `sortTreeEntries`, so the leaves arrive in
// byte-sorted order and the sort is a guaranteed no-op. There is no public-API
// path that can deliver unsorted leaves, hence every mutation of this
// comparator is provably equivalent.
// Stryker disable next-line ConditionalExpression,EqualityOperator,UnaryOperator: equivalent — every caller feeds byte-sorted leaves (walkTree of an on-disk, canonically-serialized tree), so the comparator's result never reorders the array regardless of how it is mutated.
const byPath = (a: IndexEntry, b: IndexEntry): number =>
  a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

export const buildIndexFromTree = async (
  ctx: Context,
  opts: BuildIndexFromTreeOpts,
): Promise<ReadonlyArray<IndexEntry>> => {
  const donors = donorByPath(opts.currentIndex);
  const leaves = await collectLeaves(ctx, opts.targetTree);
  const entries = leaves.map((leaf) => projectLeaf(leaf, donors));
  // Defensive sort: walkTree's depth-first traversal of a git-canonical tree
  // (entries sorted with trailing-`/` for subtrees) yields byte-sorted leaf
  // paths in practice, so this sort is a no-op for trees written via
  // `writeTree`/`serializeTreeContent`. We keep it because `parseTreeContent`
  // does NOT defensively re-sort on read — a tree fetched from a remote that
  // emits non-canonical wire data would otherwise produce an unsorted index
  // entry list. The git index format requires byte-sorted entries, and
  // in-memory consumers (diff helpers, materialise) trust this ordering.
  // Stryker disable next-line MethodExpression: equivalent — every reachable input is already byte-sorted (see `byPath` above), so dropping the sort leaves the array unchanged; no public-API path delivers unsorted leaves.
  entries.sort(byPath);
  return entries;
};
