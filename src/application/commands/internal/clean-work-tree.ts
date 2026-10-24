/**
 * git's `require_clean_work_tree`: a `cherry-pick` (and, later, `revert`/
 * `rebase`) refuses to start unless the index matches HEAD (no staged changes),
 * the working tree matches the index (no unstaged changes), and there are no
 * unmerged entries. Collects every offending path and throws `WORKING_TREE_DIRTY`.
 */
import { workingTreeDirty } from '../../../domain/commands/error.js';
import { comparePaths } from '../../../domain/diff/index.js';
import type { GitIndex, IndexEntry } from '../../../domain/git-index/index.js';
import { escapedPathOf, viewOfEscaped } from '../../../domain/git-index/index-path-key.js';
import { FILE_MODE } from '../../../domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { compareWorkingTreeEntry } from '../../primitives/compare-working-tree-entry.js';
import { flattenEscapedTree } from '../../primitives/flatten-tree.js';
import { buildCheckinAttributeProvider } from '../../primitives/internal/read-gitattributes.js';
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

const isGitlink = (mode: FileMode): boolean => mode === FILE_MODE.GITLINK;

type HeadSide = { readonly mode: FileMode } | undefined;

/** Which gitlink differences between the index and HEAD a caller's git counterpart ignores. */
interface GitlinkPolicy {
  readonly ignoresChange: (head: HeadSide, entry: IndexEntry) => boolean;
  readonly ignoresRemoval: (head: { readonly mode: FileMode }) => boolean;
}

/**
 * `require_clean_work_tree` (rebase, pull) runs with submodules ignored: a change between
 * two gitlinks, or one adding or removing a gitlink, is skipped. A gitlink turning into a
 * file still counts.
 */
const IGNORING_GITLINKS: GitlinkPolicy = {
  ignoresChange: (head, entry) =>
    isGitlink(entry.mode) && (head === undefined || isGitlink(head.mode)),
  ignoresRemoval: (head) => isGitlink(head.mode),
};

/** The sequencer's `index_differs_from(HEAD)` counts every gitlink difference. */
const COUNTING_GITLINKS: GitlinkPolicy = {
  ignoresChange: () => false,
  ignoresRemoval: () => false,
};

/** Paths whose index (id, mode) differs from HEAD's tree, incl. staged deletions. */
const stagedDirty = async (
  ctx: Context,
  stage0: ReadonlyArray<IndexEntry>,
  headTree: ObjectId,
  policy: GitlinkPolicy,
): Promise<ReadonlyArray<FilePath>> => {
  const headFlat = await flattenEscapedTree(ctx, headTree);
  const indexPaths = new Set(stage0.map(escapedPathOf));
  const dirty: FilePath[] = [];
  for (const entry of stage0) {
    const head = headFlat.entries.get(escapedPathOf(entry));
    if (policy.ignoresChange(head, entry)) continue;
    if (head === undefined || head.id !== entry.id || head.mode !== entry.mode) {
      dirty.push(entry.path);
    }
  }
  for (const [path, head] of headFlat.entries) {
    if (!indexPaths.has(path) && !policy.ignoresRemoval(head)) dirty.push(viewOfEscaped(path));
  }
  return dirty;
};

/** Tracked, on-disk paths whose working copy differs from the index. */
const unstagedDirty = async (
  ctx: Context,
  stage0: ReadonlyArray<IndexEntry>,
  indexMtime: GitIndex['indexMtime'],
): Promise<ReadonlyArray<FilePath>> => {
  const provider = await buildCheckinAttributeProvider(ctx);
  const dirty: FilePath[] = [];
  for (const entry of stage0) {
    // Skip-worktree (sparse-excluded) entries are intentionally off-disk.
    if (entry.flags.skipWorktree) continue;
    // git runs these pre-flights with submodules ignored: a moved checkout is not a change.
    if (entry.mode === FILE_MODE.GITLINK) continue;
    if ((await compareWorkingTreeEntry(ctx, entry, provider, indexMtime)) !== 'unchanged')
      dirty.push(entry.path);
  }
  return dirty;
};

export const assertCleanWorkTree = async (ctx: Context, headTree: ObjectId): Promise<void> => {
  const index = await readIndex(ctx);
  const { stage0, unmerged } = partitionIndex(index.entries);
  const dirty = new Set<FilePath>([
    ...unmerged,
    ...(await stagedDirty(ctx, stage0, headTree, IGNORING_GITLINKS)),
    ...(await unstagedDirty(ctx, stage0, index.indexMtime)),
  ]);
  // Raw-byte path order matches git's refusal; the Set's insertion order
  // (unmerged, staged-dirty, unstaged-dirty) is not faithful for non-ASCII paths.
  if (dirty.size > 0) {
    throw workingTreeDirty({ localChanges: [...dirty].sort(comparePaths), untracked: [] });
  }
};

/** Throws `WORKING_TREE_DIRTY` naming `dirty`, deduplicated, in git's raw-byte order. */
const refuseDirty = (dirty: ReadonlyArray<FilePath>): void => {
  if (dirty.length === 0) return;
  throw workingTreeDirty({ localChanges: [...new Set(dirty)].sort(comparePaths), untracked: [] });
};

/**
 * git's sequencer pre-flight for `cherry-pick` and `revert` (`index_differs_from`):
 * refuses unmerged entries and an index that differs from HEAD, but tolerates
 * unstaged work-tree changes (the merge's would-overwrite check guards those).
 */
export const assertCleanIndex = async (ctx: Context, headTree: ObjectId): Promise<void> => {
  const { stage0, unmerged } = partitionIndex((await readIndex(ctx)).entries);
  refuseDirty([...unmerged, ...(await stagedDirty(ctx, stage0, headTree, COUNTING_GITLINKS))]);
};

/** The `--no-commit` pre-flight: staged changes ride along, only unmerged entries refuse. */
export const assertNoUnmergedEntries = async (ctx: Context): Promise<void> => {
  refuseDirty(partitionIndex((await readIndex(ctx)).entries).unmerged);
};

/** Tracked paths whose working copy differs from the index, in git's raw-byte order. */
export const unstagedChangePaths = async (ctx: Context): Promise<ReadonlyArray<FilePath>> => {
  const index = await readIndex(ctx);
  const { stage0 } = partitionIndex(index.entries);
  return [...(await unstagedDirty(ctx, stage0, index.indexMtime))].sort(comparePaths);
};

/** Paths whose index entry differs from `headTree`, in git's raw-byte order. */
export const stagedChangePaths = async (
  ctx: Context,
  headTree: ObjectId,
): Promise<ReadonlyArray<FilePath>> => {
  const { stage0 } = partitionIndex((await readIndex(ctx)).entries);
  return [...(await stagedDirty(ctx, stage0, headTree, COUNTING_GITLINKS))].sort(comparePaths);
};
