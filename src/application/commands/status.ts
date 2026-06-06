import { primaryPath } from '../../domain/diff/change-path.js';
import {
  type ConflictKind,
  classifyUnmerged,
  comparePaths,
  type DiffChange,
  diffIndexAgainstTree,
  type FlatTree,
  groupUnmergedEntries,
  type UnmergedEntryGroup,
} from '../../domain/diff/index.js';
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import { deriveWorkingMode, type FileMode, type RefName } from '../../domain/objects/index.js';
import type { FilePath, ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import {
  compareWorkingTreeDelta,
  type WorkingTreeComparison,
  type WorkingTreeDelta,
} from '../primitives/compare-working-tree-entry.js';
import { readHeadTree } from '../primitives/read-head-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { walkWorkingTree } from '../primitives/walk-working-tree.js';
import { buildRepoIgnorePredicate } from './internal/build-ignore-evaluator.js';
import { createGranularityTracker } from './internal/progress-tracker.js';
import { assertRepository, readHeadRaw } from './internal/repo-state.js';

export type ChangeKind = 'modified' | 'added' | 'deleted' | 'type-changed' | 'mode-changed';

export type { ConflictKind } from '../../domain/diff/index.js';

/** A blob reference on one side of a comparison: its object id and file mode. */
export interface BlobSide {
  readonly id: ObjectId;
  readonly mode: FileMode;
}

/**
 * The working-tree side of a change: mode only. The working file need not be in
 * the object store, so git reports its mode (`mW`) but no working blob oid.
 */
export interface WorktreeSide {
  readonly mode: FileMode;
}

/**
 * One tracked path with a staged and/or unstaged change — the structured form of
 * `git status --porcelain=v2`'s ordinary changed-entry line. At least one of
 * `staged` (index vs HEAD, git's X) and `unstaged` (worktree vs index, git's Y) is
 * present. The `head` / `index` / `worktree` sides carry the blobs that form the
 * change's diffs; a side is omitted when the path does not exist there (staged add
 * → no `head`; staged delete → no `index`; deleted in the worktree → no
 * `worktree`). The hunks for any path are one read away — staged: `head` blob ↔
 * `index` blob; unstaged: `index` blob ↔ the working file at `path`.
 */
export interface ChangedPath {
  readonly path: FilePath;
  readonly staged?: ChangeKind;
  readonly unstaged?: ChangeKind;
  readonly head?: BlobSide;
  readonly index?: BlobSide;
  readonly worktree?: WorktreeSide;
}

/**
 * An unmerged (conflicted) path: its git conflict state plus the per-stage blobs
 * (`base` = stage 1, `ours` = stage 2, `theirs` = stage 3; omitted when that stage
 * is absent) and the conflicted file's on-disk mode (`worktree`, git's `mW`;
 * omitted when the file is absent on disk). The stages plus `worktree` make the
 * entry lossless against git's porcelain unmerged reporting (v1 `XY` from `kind`,
 * the full v2 `u`-line modes/oids from the stages and `worktree`).
 */
export interface UnmergedEntry {
  readonly kind: ConflictKind;
  readonly path: FilePath;
  readonly base?: BlobSide;
  readonly ours?: BlobSide;
  readonly theirs?: BlobSide;
  readonly worktree?: WorktreeSide;
}

export interface StatusResult {
  readonly branch: RefName | undefined;
  readonly detached: boolean;
  readonly changes: ReadonlyArray<ChangedPath>;
  readonly untracked: ReadonlyArray<FilePath>;
  readonly unmerged: ReadonlyArray<UnmergedEntry>;
  readonly clean: boolean;
}

const STATUS_SCAN_OP = 'status:scan';
const STATUS_SCAN_GRANULARITY = 100;

interface GranularityTracker {
  readonly tick: () => void;
}

/**
 * Summarize the state of the working tree against git's columns, one correlated
 * record per changed path. `changes` carries each tracked path's **staged** column
 * (index vs HEAD-tree, git's "Changes to be committed") and **working-tree** column
 * (index vs working tree) together with the blob endpoints of each side — the
 * structured form of `git status --porcelain=v2`'s ordinary line. `untracked` is
 * the separate set of untracked paths (git's `?` lines); `unmerged` is the
 * conflicted column (stage 1/2/3 blobs, git's "Unmerged paths"). A conflicted path
 * is reported only under `unmerged`. `clean` is true only when all three are empty.
 *
 * Progress reporting: emits `status:scan` start before the working-tree fan-out,
 * updates every 100 lstat completions, and end in a finally block so the consumer
 * always pairs start with end. `total` is undefined — a design choice that avoids
 * revealing repository size to non-trusted progress sinks.
 */
export const status = async (ctx: Context): Promise<StatusResult> => {
  await assertRepository(ctx);
  const head = await readHeadRaw(ctx);
  const branch = head.kind === 'symbolic' ? head.target : undefined;
  const detached = head.kind === 'direct';
  // `readIndex` returns an empty index when the file is absent (fresh/unborn
  // repo); a thrown error means a corrupt index, which we let propagate rather
  // than fabricate an empty one — fabricating it would report every HEAD path as
  // a spurious staged deletion (git errors on a corrupt index too).
  const index = await readIndex(ctx);
  // Partition the index into the stage-0 (tracked) entries and the unmerged
  // (stage 1/2/3) groups. A conflicted path has no stage-0 entry, so it is
  // reported only under the unmerged column.
  const grouped = groupUnmergedEntries(index);
  const stage0Map = new Map<FilePath, IndexEntry>(
    grouped.staged.map((entry) => [entry.path, entry]),
  );
  const trackedPaths = new Set<FilePath>(grouped.unmerged.keys());
  for (const path of stage0Map.keys()) trackedPaths.add(path);
  ctx.progress.start(STATUS_SCAN_OP);
  try {
    const tracker = createGranularityTracker(ctx.progress, STATUS_SCAN_OP, STATUS_SCAN_GRANULARITY);
    const workingMap = await scanWorkingTree(ctx, grouped.staged, tracker);
    const unmergedWorktreeModes = await scanUnmergedWorktree(ctx, grouped.unmerged);
    const untracked = await scanUntracked(ctx, trackedPaths);
    const headTree = await readHeadTree(ctx);
    const stagedKindMap = collectStagedKinds(index, headTree, grouped.unmerged);
    const changes = buildChanges(stagedKindMap, workingMap, headTree, stage0Map);
    const unmerged = toUnmergedEntries(grouped.unmerged, unmergedWorktreeModes);
    const clean = changes.length === 0 && untracked.length === 0 && unmerged.length === 0;
    return { branch, detached, changes, untracked, unmerged, clean };
  } finally {
    ctx.progress.end(STATUS_SCAN_OP);
  }
};

/**
 * Working-tree pass: compare every stage-0 entry to its working file. A
 * skip-worktree entry is intentionally absent from disk (sparse), so it is not
 * compared — its staged column is still surfaced via `stage0Map`. Every entry
 * ticks the progress tracker.
 */
const scanWorkingTree = async (
  ctx: Context,
  stage0: ReadonlyArray<IndexEntry>,
  tracker: GranularityTracker,
): Promise<Map<FilePath, WorkingTreeDelta>> => {
  const map = new Map<FilePath, WorkingTreeDelta>();
  await Promise.all(
    stage0.map(async (entry) => {
      if (!entry.flags.skipWorktree) map.set(entry.path, await compareWorkingTreeDelta(ctx, entry));
      tracker.tick();
    }),
  );
  return map;
};

/**
 * Unmerged-path pass: read each conflicted file's on-disk mode (git's `u`-line
 * `mW`). A conflicted path has no stage-0 entry, so it is absent from the
 * working-tree pass and needs its own lookup. The mode is `lstat`-derived only —
 * git does no content hash for `mW` — and a file absent from disk is dropped
 * (git's `mW = 000000`, surfaced as an omitted `worktree` side).
 */
const scanUnmergedWorktree = async (
  ctx: Context,
  unmerged: ReadonlyMap<FilePath, UnmergedEntryGroup>,
): Promise<Map<FilePath, FileMode>> => {
  const map = new Map<FilePath, FileMode>();
  await Promise.all(
    [...unmerged.keys()].map(async (path) => {
      const mode = await readWorktreeMode(ctx, path);
      if (mode !== undefined) map.set(path, mode);
    }),
  );
  return map;
};

/** The conflicted file's on-disk git mode, or `undefined` when it is absent. */
const readWorktreeMode = async (ctx: Context, path: FilePath): Promise<FileMode | undefined> => {
  const stat = await ctx.fs.lstat(`${ctx.layout.workDir}/${path}`).catch(() => undefined);
  return stat === undefined ? undefined : deriveWorkingMode(stat);
};

/**
 * Untracked pass: walk the working tree (gitignore-filtered) and collect every
 * path not tracked (stage-0 or unmerged). Tracked-but-ignored entries stay
 * tracked; the ignore filter affects untracked emission only.
 */
const scanUntracked = async (
  ctx: Context,
  trackedPaths: ReadonlySet<FilePath>,
): Promise<FilePath[]> => {
  const ignore = await buildRepoIgnorePredicate(ctx);
  const untracked: FilePath[] = [];
  for await (const { path } of walkWorkingTree(ctx, { ignore })) {
    if (!trackedPaths.has(path)) untracked.push(path);
  }
  return untracked.sort(comparePaths);
};

/**
 * Staged pass: project the index-vs-HEAD diff onto staged kinds, dropping
 * conflicted paths (reported only under `unmerged`).
 */
const collectStagedKinds = (
  index: GitIndex,
  headTree: FlatTree | undefined,
  unmerged: ReadonlyMap<FilePath, UnmergedEntryGroup>,
): Map<FilePath, ChangeKind> => {
  const map = new Map<FilePath, ChangeKind>();
  for (const change of diffIndexAgainstTree(index, headTree).changes) {
    const path = primaryPath(change);
    if (!unmerged.has(path)) map.set(path, toStagedKind(change));
  }
  return map;
};

/**
 * Merge the staged and working passes into one record per changed path. A path is
 * changed when it has a staged kind or a non-`unchanged` working status; clean
 * tracked files drop out. Records are byte-ordered by path.
 */
const buildChanges = (
  stagedKindMap: ReadonlyMap<FilePath, ChangeKind>,
  workingMap: ReadonlyMap<FilePath, WorkingTreeDelta>,
  headTree: FlatTree | undefined,
  stage0Map: ReadonlyMap<FilePath, IndexEntry>,
): ChangedPath[] => {
  const paths = new Set<FilePath>(stagedKindMap.keys());
  for (const [path, delta] of workingMap) {
    if (toUnstagedKind(delta.status) !== undefined) paths.add(path);
  }
  const changes = [...paths].map((path) =>
    buildChangedPath(
      path,
      stagedKindMap.get(path),
      workingMap.get(path),
      headTree,
      stage0Map.get(path),
    ),
  );
  return changes.sort((a, b) => comparePaths(a.path, b.path));
};

/**
 * Build one `ChangedPath`: the staged/unstaged kinds plus the `head` (HEAD tree),
 * `index` (stage-0 entry), and `worktree` (working comparison) sides. Each side is
 * populated whenever it exists, independent of which axis flagged the change — so
 * the record reconstructs a porcelain v2 ordinary line directly.
 */
const buildChangedPath = (
  path: FilePath,
  staged: ChangeKind | undefined,
  delta: WorkingTreeDelta | undefined,
  headTree: FlatTree | undefined,
  indexEntry: IndexEntry | undefined,
): ChangedPath => {
  const head = headTree?.entries.get(path);
  const unstaged = delta === undefined ? undefined : toUnstagedKind(delta.status);
  return {
    path,
    ...(staged !== undefined && { staged }),
    ...(unstaged !== undefined && { unstaged }),
    ...(head !== undefined && { head: { id: head.id, mode: head.mode } }),
    ...(indexEntry !== undefined && { index: { id: indexEntry.id, mode: indexEntry.mode } }),
    ...(delta?.worktreeMode !== undefined && { worktree: { mode: delta.worktreeMode } }),
  };
};

/**
 * Project an index-vs-HEAD `DiffChange` onto a staged `ChangeKind`. A kind change
 * is `type-changed` (git `T`); a same-blob mode difference is `mode-changed`; a
 * content change is `modified`. `diffIndexAgainstTree` never emits renames, so the
 * residual `modified` arm is only reached by a content-bearing `modify`.
 */
export const toStagedKind = (change: DiffChange): ChangeKind => {
  if (change.type === 'add') return 'added';
  if (change.type === 'delete') return 'deleted';
  if (change.type === 'type-change') return 'type-changed';
  if (change.type === 'modify' && change.oldId === change.newId) return 'mode-changed';
  return 'modified';
};

/**
 * Project a working-tree comparison onto the unstaged `ChangeKind`: `absent` is
 * git's ` D`, the type/mode/content variants map 1:1, and `unchanged` yields no
 * unstaged change.
 */
export const toUnstagedKind = (status: WorkingTreeComparison): ChangeKind | undefined => {
  if (status === 'absent') return 'deleted';
  if (status === 'type-changed') return 'type-changed';
  if (status === 'mode-changed') return 'mode-changed';
  if (status === 'modified') return 'modified';
  return undefined;
};

const conflictStage = (entry: IndexEntry): BlobSide => ({ id: entry.id, mode: entry.mode });

/**
 * Project the grouped unmerged entries into `UnmergedEntry[]`, carrying the
 * conflict state, the present per-stage blobs, and the conflicted file's on-disk
 * mode (`worktree`, git's `mW`; omitted when the file is absent). The result is
 * byte-ordered by path without an explicit sort: `groupUnmergedEntries` preserves
 * the order of the index, whose entries are required to be byte-sorted (a git
 * index invariant).
 */
const toUnmergedEntries = (
  groups: ReadonlyMap<FilePath, UnmergedEntryGroup>,
  worktreeModes: ReadonlyMap<FilePath, FileMode>,
): UnmergedEntry[] => {
  const entries: UnmergedEntry[] = [];
  for (const [path, group] of groups) {
    const worktreeMode = worktreeModes.get(path);
    entries.push({
      kind: classifyUnmerged(group),
      path,
      ...(group.stage1 && { base: conflictStage(group.stage1) }),
      ...(group.stage2 && { ours: conflictStage(group.stage2) }),
      ...(group.stage3 && { theirs: conflictStage(group.stage3) }),
      ...(worktreeMode !== undefined && { worktree: { mode: worktreeMode } }),
    });
  }
  return entries;
};
