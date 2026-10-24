/**
 * git's `require_clean_work_tree`: a `cherry-pick` (and, later, `revert`/
 * `rebase`) refuses to start unless the index matches HEAD (no staged changes),
 * the working tree matches the index (no unstaged changes), and there are no
 * unmerged entries. Collects every offending path and throws `WORKING_TREE_DIRTY`.
 */
import { workingTreeDirty } from '../../../domain/commands/error.js';
import type { EscapedFlatTree } from '../../../domain/diff/flat-tree.js';
import { comparePaths } from '../../../domain/diff/index.js';
import type { GitIndex, IndexEntry } from '../../../domain/git-index/index.js';
import { escapedPathOf, viewOfEscaped } from '../../../domain/git-index/index-path-key.js';
import { FILE_MODE } from '../../../domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { compareAndRefresh, scopeOf } from '../../primitives/compare-working-tree-entry.js';
import { flattenEscapedTree } from '../../primitives/flatten-tree.js';
import { buildCheckinAttributeProvider } from '../../primitives/internal/read-gitattributes.js';
import { createLeadingPathScanner } from '../../primitives/internal/symlinked-leading-path.js';
import { readIndex } from '../../primitives/read-index.js';
import {
  configuredSubmoduleIgnore,
  readGitmodulesRows,
  type SubmoduleIgnore,
} from './submodule-state.js';

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
  readonly ignoresChange: (path: FilePath, head: HeadSide, entry: IndexEntry) => boolean;
  readonly ignoresRemoval: (path: FilePath, head: { readonly mode: FileMode }) => boolean;
}

type ConfiguredIgnores = ReadonlyMap<FilePath, SubmoduleIgnore>;

/** A gitlink-to-gitlink difference, or a gitlink added or removed; a gitlink turning into a file never is one. */
const isGitlinkDifference = (head: HeadSide, entry: IndexEntry): boolean =>
  isGitlink(entry.mode) && (head === undefined || isGitlink(head.mode));

/** A configured mode other than `all` asks git to look at the gitlink even where it would otherwise skip it. */
const asksToSee = (mode: SubmoduleIgnore | undefined): boolean =>
  mode !== undefined && mode !== 'all';

/**
 * `require_clean_work_tree`'s staged side (rebase, pull): a gitlink difference is skipped
 * unless the submodule's configured mode asks to see it — git sets its ignore flag and lets
 * `is_submodule_ignored` replace it with the configured mode, so `none`, `untracked` and
 * `dirty` count the change while `all` and an unconfigured submodule do not.
 */
const preflightPolicy = (modes: ConfiguredIgnores): GitlinkPolicy => ({
  ignoresChange: (path, head, entry) =>
    isGitlinkDifference(head, entry) && !asksToSee(modes.get(path)),
  ignoresRemoval: (path, head) => isGitlink(head.mode) && !asksToSee(modes.get(path)),
});

/** The sequencer's `index_differs_from(HEAD)`: a gitlink difference counts unless the configured mode is `all`. */
const sequencerPolicy = (modes: ConfiguredIgnores): GitlinkPolicy => ({
  ignoresChange: (path, head, entry) =>
    isGitlinkDifference(head, entry) && modes.get(path) === 'all',
  ignoresRemoval: (path, head) => isGitlink(head.mode) && modes.get(path) === 'all',
});

/** Every gitlink the index or HEAD records. */
const gitlinkPaths = (
  stage0: ReadonlyArray<IndexEntry>,
  headFlat: EscapedFlatTree,
): ReadonlySet<FilePath> => {
  const paths = new Set<FilePath>();
  for (const entry of stage0) if (isGitlink(entry.mode)) paths.add(entry.path);
  for (const [path, head] of headFlat.entries)
    if (isGitlink(head.mode)) paths.add(viewOfEscaped(path));
  return paths;
};

/** The ignore mode each gitlink's submodule configuration declares; read only when a gitlink exists. */
const configuredIgnores = async (
  ctx: Context,
  stage0: ReadonlyArray<IndexEntry>,
  headFlat: EscapedFlatTree,
): Promise<ConfiguredIgnores> => {
  const paths = gitlinkPaths(stage0, headFlat);
  const workDir = ctx.layout.workDir;
  if (paths.size === 0 || workDir === undefined) return new Map();
  const stage0Map = new Map(stage0.map((entry) => [entry.path, entry]));
  const rows = await readGitmodulesRows(ctx, { workDir, stage0: stage0Map });
  const modes = new Map<FilePath, SubmoduleIgnore>();
  for (const path of paths) {
    const mode = await configuredSubmoduleIgnore(ctx, path, rows);
    if (mode !== undefined) modes.set(path, mode);
  }
  return modes;
};

interface Policies {
  readonly preflight: GitlinkPolicy;
  readonly sequencer: GitlinkPolicy;
}

/** The ignore modes git's in-process submodule config holds for one run: read once at the pre-flight, reused by the picks. */
export type SubmoduleIgnoreModes = ConfiguredIgnores;

const policiesFor = async (
  ctx: Context,
  stage0: ReadonlyArray<IndexEntry>,
  headFlat: EscapedFlatTree,
  known?: SubmoduleIgnoreModes,
): Promise<Policies & { readonly modes: SubmoduleIgnoreModes }> => {
  const modes = known ?? (await configuredIgnores(ctx, stage0, headFlat));
  return { modes, preflight: preflightPolicy(modes), sequencer: sequencerPolicy(modes) };
};

/** Paths whose index (id, mode) differs from the flattened HEAD tree, incl. staged deletions. */
const stagedDirtyAgainst = (
  headFlat: EscapedFlatTree,
  stage0: ReadonlyArray<IndexEntry>,
  policy: GitlinkPolicy,
): ReadonlyArray<FilePath> => {
  const indexPaths = new Set(stage0.map(escapedPathOf));
  const dirty: FilePath[] = [];
  for (const entry of stage0) {
    const head = headFlat.entries.get(escapedPathOf(entry));
    if (policy.ignoresChange(entry.path, head, entry)) continue;
    if (head === undefined || head.id !== entry.id || head.mode !== entry.mode) {
      dirty.push(entry.path);
    }
  }
  for (const [path, head] of headFlat.entries) {
    if (indexPaths.has(path)) continue;
    const view = viewOfEscaped(path);
    if (!policy.ignoresRemoval(view, head)) dirty.push(view);
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
  // One leading-path memo for the whole pass: a shared directory is lstat-ed once.
  const scope = scopeOf(provider, indexMtime, createLeadingPathScanner(ctx));
  const dirty: FilePath[] = [];
  for (const entry of stage0) {
    // Skip-worktree (sparse-excluded) entries are intentionally off-disk.
    if (entry.flags.skipWorktree) continue;
    // git runs these pre-flights with submodules ignored: a moved checkout is not a change.
    if (entry.mode === FILE_MODE.GITLINK) continue;
    const { delta } = await compareAndRefresh(ctx, entry, scope);
    if (delta.status !== 'unchanged') dirty.push(entry.path);
  }
  return dirty;
};

/**
 * `require_clean_work_tree`, answering the submodule ignore modes it read: git keeps them in
 * its process for the rest of the run, so a rebase's picks judge the index by these modes
 * rather than by the `.gitmodules` the detached checkout happens to hold.
 */
export const cleanWorkTreePreflight = async (
  ctx: Context,
  headTree: ObjectId,
): Promise<SubmoduleIgnoreModes> => {
  const index = await readIndex(ctx);
  const { stage0, unmerged } = partitionIndex(index.entries);
  const headFlat = await flattenEscapedTree(ctx, headTree);
  const { preflight, modes } = await policiesFor(ctx, stage0, headFlat);
  refuseDirtyWorkTree([
    ...unmerged,
    ...stagedDirtyAgainst(headFlat, stage0, preflight),
    ...(await unstagedDirty(ctx, stage0, index.indexMtime)),
  ]);
  return modes;
};

export const assertCleanWorkTree = async (ctx: Context, headTree: ObjectId): Promise<void> => {
  await cleanWorkTreePreflight(ctx, headTree);
};

const refuseDirtyWorkTree = (paths: ReadonlyArray<FilePath>): void => {
  const dirty = new Set<FilePath>(paths);
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
  const headFlat = await flattenEscapedTree(ctx, headTree);
  const { sequencer } = await policiesFor(ctx, stage0, headFlat);
  refuseDirty([...unmerged, ...stagedDirtyAgainst(headFlat, stage0, sequencer)]);
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
  modes?: SubmoduleIgnoreModes,
): Promise<ReadonlyArray<FilePath>> => {
  const { stage0 } = partitionIndex((await readIndex(ctx)).entries);
  const headFlat = await flattenEscapedTree(ctx, headTree);
  const { sequencer } = await policiesFor(ctx, stage0, headFlat, modes);
  return [...stagedDirtyAgainst(headFlat, stage0, sequencer)].sort(comparePaths);
};

/** How the index differs from a tree, as git's `index_has_changes` sees it and what it hides. */
export interface IndexDifferences {
  /** Differences git refuses to merge over, in raw-byte order. */
  readonly refused: ReadonlyArray<FilePath>;
  /** Gitlink differences a configured `all` hides from that check; the two-way checkout keeps them. */
  readonly carried: ReadonlyArray<FilePath>;
}

/** git's `index_has_changes(HEAD)` before a merge strategy runs, with the gitlinks it skips told apart. */
export const indexDifferences = async (
  ctx: Context,
  headTree: ObjectId,
): Promise<IndexDifferences> => {
  const { stage0 } = partitionIndex((await readIndex(ctx)).entries);
  const headFlat = await flattenEscapedTree(ctx, headTree);
  const { sequencer } = await policiesFor(ctx, stage0, headFlat);
  const refused = new Set(stagedDirtyAgainst(headFlat, stage0, sequencer));
  const every = stagedDirtyAgainst(headFlat, stage0, EVERY_DIFFERENCE);
  return {
    refused: [...refused].sort(comparePaths),
    carried: every.filter((path) => !refused.has(path)).sort(comparePaths),
  };
};

/** Nothing is skipped: every index difference from HEAD counts. */
const EVERY_DIFFERENCE: GitlinkPolicy = {
  ignoresChange: () => false,
  ignoresRemoval: () => false,
};

/**
 * The staged changes the pre-flight let through, in raw-byte order — gitlink differences
 * whatever their ignore mode. git's checkout of `onto` keeps them in the index (its two-way
 * rule keeps what the index holds on a path both trees agree on), so the replay carries them.
 */
export const stagedGitlinkChanges = async (
  ctx: Context,
  headTree: ObjectId,
  modes?: SubmoduleIgnoreModes,
): Promise<ReadonlyArray<FilePath>> => {
  const { stage0 } = partitionIndex((await readIndex(ctx)).entries);
  // HEAD is flattened once and read under both policies.
  const headFlat = await flattenEscapedTree(ctx, headTree);
  const { preflight } = await policiesFor(ctx, stage0, headFlat, modes);
  const refusedByPreflight = new Set(stagedDirtyAgainst(headFlat, stage0, preflight));
  const counted = stagedDirtyAgainst(headFlat, stage0, EVERY_DIFFERENCE);
  return counted.filter((path) => !refusedByPreflight.has(path)).sort(comparePaths);
};
