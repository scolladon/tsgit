/**
 * git's `require_clean_work_tree`: a `cherry-pick` (and, later, `revert`/
 * `rebase`) refuses to start unless the index matches HEAD (no staged changes),
 * the working tree matches the index (no unstaged changes), and there are no
 * unmerged entries. Collects every offending path and throws `WORKING_TREE_DIRTY`.
 */
import { workingTreeDirty } from '../../../domain/commands/error.js';
import type { IndexEntry } from '../../../domain/git-index/index.js';
import type { FilePath, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { compareWorkingTreeEntry } from '../../primitives/compare-working-tree-entry.js';
import { flattenTree } from '../../primitives/flatten-tree.js';
import { readIndex } from '../../primitives/read-index.js';

interface PartitionedIndex {
  readonly stage0: ReadonlyArray<IndexEntry>;
  readonly unmerged: ReadonlyArray<FilePath>;
}

/** Split the index into stage-0 entries and the paths of any unmerged entries. */
const partitionIndex = (entries: ReadonlyArray<IndexEntry>): PartitionedIndex => {
  const stage0: IndexEntry[] = [];
  const unmerged: FilePath[] = [];
  for (const entry of entries) {
    if (entry.flags.stage === 0) stage0.push(entry);
    else unmerged.push(entry.path);
  }
  return { stage0, unmerged };
};

/** Paths whose index (id, mode) differs from HEAD's tree, incl. staged deletions. */
const stagedDirty = async (
  ctx: Context,
  stage0: ReadonlyArray<IndexEntry>,
  headTree: ObjectId,
): Promise<ReadonlyArray<FilePath>> => {
  const headFlat = await flattenTree(ctx, headTree);
  const indexPaths = new Set(stage0.map((e) => e.path));
  const dirty: FilePath[] = [];
  for (const entry of stage0) {
    const head = headFlat.entries.get(entry.path);
    if (head === undefined || head.id !== entry.id || head.mode !== entry.mode) {
      dirty.push(entry.path);
    }
  }
  for (const path of headFlat.entries.keys()) {
    if (!indexPaths.has(path)) dirty.push(path);
  }
  return dirty;
};

/** Tracked, on-disk paths whose working copy differs from the index. */
const unstagedDirty = async (
  ctx: Context,
  stage0: ReadonlyArray<IndexEntry>,
): Promise<ReadonlyArray<FilePath>> => {
  const dirty: FilePath[] = [];
  for (const entry of stage0) {
    // Skip-worktree (sparse-excluded) entries are intentionally off-disk.
    if (entry.flags.skipWorktree) continue;
    if ((await compareWorkingTreeEntry(ctx, entry)) !== 'unchanged') dirty.push(entry.path);
  }
  return dirty;
};

export const assertCleanWorkTree = async (ctx: Context, headTree: ObjectId): Promise<void> => {
  const { stage0, unmerged } = partitionIndex((await readIndex(ctx)).entries);
  const dirty = new Set<FilePath>([
    ...unmerged,
    ...(await stagedDirty(ctx, stage0, headTree)),
    ...(await unstagedDirty(ctx, stage0)),
  ]);
  if (dirty.size > 0) throw workingTreeDirty({ localChanges: [...dirty], untracked: [] });
};
