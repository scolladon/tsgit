import { primaryPath } from '../../domain/diff/change-path.js';
import {
  type ConflictKind,
  classifyUnmerged,
  comparePaths,
  type DiffChange,
  diffIndexAgainstTree,
  type FlatTree,
  type GroupedIndex,
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
import { readConfig } from '../primitives/config-read.js';
import { assertValidPromisorRemoteConfig } from '../primitives/internal/boolean-config-guard.js';
import { type CleanOrder, withCleanOrder } from '../primitives/internal/clean-order.js';
import { boundedMapFor } from '../primitives/internal/concurrency.js';
import { withFilterProcessPool } from '../primitives/internal/filter-process-pool.js';
import { joinPath } from '../primitives/internal/join-working-tree-path.js';
import {
  type AttributeProvider,
  maybeBuildAttributeProvider,
} from '../primitives/internal/read-gitattributes.js';
import { assertOperationalRepositorySettingsFirst } from '../primitives/internal/repo-state.js';
import { readHeadTree } from '../primitives/read-head-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { walkWorkingTree } from '../primitives/walk-working-tree.js';
import { buildRepoIgnorePredicate } from './internal/build-ignore-evaluator.js';
import { createGranularityTracker } from './internal/progress-tracker.js';
import { branchRefFromHead, readHeadRaw, requireWorkTree } from './internal/repo-state.js';
import { resolveRevisionName } from './internal/revision-name.js';

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
export const status = (ctx: Context): Promise<StatusResult> =>
  withFilterProcessPool(ctx, () => statusInScope(ctx));

const HEAD_NAME = 'HEAD';

const statusInScope = async (ctx: Context): Promise<StatusResult> => {
  await assertOperationalRepositorySettingsFirst(ctx);
  const workDir = requireWorkTree(ctx, 'status');
  // Promisor-remote guard (see assertValidPromisorRemoteConfig) — loaded up front.
  await assertValidPromisorRemoteConfig(ctx);
  const head = await readHeadRaw(ctx);
  // `readIndex` returns an empty index when the file is absent (fresh/unborn
  // repo); a thrown error means a corrupt index, which we let propagate rather
  // than fabricate an empty one — fabricating it would report every HEAD path as
  // a spurious staged deletion (git errors on a corrupt index too).
  const index = await readIndex(ctx);
  const tracked = trackedEntriesOf(index);
  ctx.progress.start(STATUS_SCAN_OP);
  try {
    const scanned = await scanStatusTree(ctx, index, tracked);
    const report = await reportStatus(ctx, { index, tracked, scanned, workDir });
    return { branch: branchRefFromHead(head), detached: head.kind === 'direct', ...report };
  } finally {
    ctx.progress.end(STATUS_SCAN_OP);
  }
};

/** The index's tracked entries: stage 0 by path, the unmerged groups, and every tracked path. */
interface TrackedEntries {
  readonly grouped: GroupedIndex;
  readonly stage0Map: ReadonlyMap<FilePath, IndexEntry>;
  readonly trackedPaths: ReadonlySet<FilePath>;
}

/** Partition the index into the stage-0 (tracked) entries and the unmerged
 *  (stage 1/2/3) groups. A conflicted path has no stage-0 entry, so it is
 *  reported only under the unmerged column. */
const trackedEntriesOf = (index: GitIndex): TrackedEntries => {
  const grouped = groupUnmergedEntries(index);
  const stage0Map = new Map<FilePath, IndexEntry>(
    grouped.staged.map((entry) => [entry.path, entry]),
  );
  const trackedPaths = new Set<FilePath>(grouped.unmerged.keys());
  for (const path of stage0Map.keys()) trackedPaths.add(path);
  return { grouped, stage0Map, trackedPaths };
};

/** What the working tree holds: every tracked file's delta, and the untracked paths. */
interface ScannedTree {
  readonly workingMap: Map<FilePath, WorkingTreeDelta>;
  readonly untracked: ReadonlyArray<FilePath>;
}

/** Build the check-in attribute provider once per status invocation. It is always
 *  present; a path whose attributes resolve to the identity conversion costs one lookup. */
const scanStatusTree = async (
  ctx: Context,
  index: GitIndex,
  tracked: TrackedEntries,
): Promise<ScannedTree> => {
  const tracker = createGranularityTracker(ctx.progress, STATUS_SCAN_OP, STATUS_SCAN_GRANULARITY);
  const provider = await maybeBuildAttributeProvider(ctx, index);
  const { staged } = tracked.grouped;
  const workingMap = await scanWorkingTree(ctx, staged, tracker, provider, index.indexMtime);
  const untracked = await scanUntracked(ctx, tracked.trackedPaths);
  return { workingMap, untracked };
};

/** git's status names HEAD through `get_oid`, warning on an ambiguous HEAD and
 *  refusing a malformed core.warnAmbiguousRefs once HEAD resolves. */
const reportStatus = async (
  ctx: Context,
  {
    index,
    tracked,
    scanned,
    workDir,
  }: {
    readonly index: GitIndex;
    readonly tracked: TrackedEntries;
    readonly scanned: ScannedTree;
    readonly workDir: string;
  },
): Promise<Omit<StatusResult, 'branch' | 'detached'>> => {
  await resolveRevisionName(ctx, HEAD_NAME);
  const headTree = await readHeadTree(ctx);
  const { unmerged: groups } = tracked.grouped;
  const stagedKindMap = collectStagedKinds(index, headTree, groups);
  const changes = buildChanges(stagedKindMap, scanned.workingMap, headTree, tracked.stage0Map);
  const unmerged = await buildUnmergedEntries(ctx, groups, workDir);
  const { untracked } = scanned;
  const clean = changes.length === 0 && untracked.length === 0 && unmerged.length === 0;
  return { changes, untracked, unmerged, clean };
};

/**
 * Working-tree pass: compare every stage-0 entry to its working file. A
 * skip-worktree entry is intentionally absent from disk (sparse), so it is not
 * compared — its staged column is still surfaced via `stage0Map`. Every entry
 * ticks the progress tracker. The optional provider enables clean-filter
 * re-application so smudged-then-unmodified files report unchanged. The
 * optional `indexMtime` (the `.git/index` file's own mtime) arms the
 * stat-cache short-circuit in `compareWorkingTreeDelta` — `status` is the
 * only consumer that supplies it today. The comparisons fan out through the
 * `ioBound` bucket: each `lstat`+optional-hash is independent per path, and
 * `boundedMap`'s completion-order-independent result array is safe here
 * because every entry is keyed by its own unique path.
 */
const scanEntry = async (
  ctx: Context,
  entry: IndexEntry,
  provider: AttributeProvider | undefined,
  indexMtime: GitIndex['indexMtime'],
): Promise<readonly [FilePath, WorkingTreeDelta] | undefined> => {
  const delta = entry.flags.skipWorktree
    ? undefined
    : await compareWorkingTreeDelta(ctx, entry, provider, indexMtime);
  return delta === undefined ? undefined : [entry.path, delta];
};

const scanWorkingTree = async (
  ctx: Context,
  stage0: ReadonlyArray<IndexEntry>,
  tracker: GranularityTracker,
  provider: AttributeProvider | undefined,
  indexMtime: GitIndex['indexMtime'],
): Promise<Map<FilePath, WorkingTreeDelta>> => {
  const scan = (order?: CleanOrder) =>
    boundedMapFor(ctx, 'ioBound', stage0, async (entry) => {
      try {
        const scanned = await scanEntry(ctx, entry, provider, indexMtime);
        tracker.tick();
        return scanned;
      } finally {
        order?.release(entry.path);
      }
    });
  // A clean driver hears the paths in index order, however the reads race;
  // without attributes, or with no driver configured, no clean runs or
  // refuses, and the scan needs no order.
  const ordered = provider !== undefined && (await configuresFilterDriver(ctx));
  const results = ordered ? await inIndexOrder(ctx, stage0, scan) : await scan();
  return deltaMapOf(results);
};

/** Whether any `[filter "<driver>"]` section is configured: without one, a filter attribute
 *  resolves to no driver, so no clean runs and none refuses. */
const configuresFilterDriver = async (ctx: Context): Promise<boolean> =>
  ((await readConfig(ctx)).filter?.size ?? 0) > 0;

/** Runs `scan` with every stage-0 path enlisted, so a clean driver hears them in index order. */
const inIndexOrder = <T>(
  ctx: Context,
  stage0: ReadonlyArray<IndexEntry>,
  scan: (order: CleanOrder) => Promise<T>,
): Promise<T> =>
  withCleanOrder(ctx, (order) => {
    for (const entry of stage0) order.enlist(entry.path);
    return scan(order);
  });

const deltaMapOf = (
  results: ReadonlyArray<readonly [FilePath, WorkingTreeDelta] | undefined>,
): Map<FilePath, WorkingTreeDelta> => {
  const map = new Map<FilePath, WorkingTreeDelta>();
  for (const result of results) {
    if (result !== undefined) map.set(...result);
  }
  return map;
};

/**
 * Untracked pass: walk the working tree (gitignore-filtered) and collect every
 * path not tracked (stage-0 or unmerged). Tracked-but-ignored entries stay
 * tracked; the ignore filter affects untracked emission only. The walk stays
 * sequential (a stateful ignore stack, and its emission order is a pinned
 * contract) — this pass never reads a leaf's stat at all, destructuring only
 * `path` from each walk entry, so it pays zero `lstat`s regardless.
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
 * Build the unmerged entries, carrying the conflict state, the present per-stage
 * blobs, and the conflicted file's on-disk mode (`worktree`, git's `mW`; omitted
 * when the file is absent). A conflicted path has no stage-0 entry, so it is
 * absent from the working-tree pass and its mode is read here — `lstat`-derived
 * only, since git does no content hash for `mW`. The result is byte-ordered by
 * path: `groupUnmergedEntries` preserves the order of the index (whose entries
 * are required to be byte-sorted, a git index invariant), and fanning the
 * per-path `lstat`s through the `ioBound` bucket does not disturb that —
 * `boundedMap` returns results in INPUT order regardless of completion order.
 */
const buildUnmergedEntries = (
  ctx: Context,
  groups: ReadonlyMap<FilePath, UnmergedEntryGroup>,
  workDir: string,
): Promise<UnmergedEntry[]> =>
  boundedMapFor(ctx, 'ioBound', [...groups], async ([path, group]) => {
    const worktreeMode = await readWorktreeMode(ctx, workDir, path);
    return {
      kind: classifyUnmerged(group),
      path,
      ...(group.stage1 && { base: conflictStage(group.stage1) }),
      ...(group.stage2 && { ours: conflictStage(group.stage2) }),
      ...(group.stage3 && { theirs: conflictStage(group.stage3) }),
      ...(worktreeMode !== undefined && { worktree: { mode: worktreeMode } }),
    };
  });

/** The conflicted file's on-disk git mode, or `undefined` when it is absent. */
const readWorktreeMode = async (
  ctx: Context,
  workDir: string,
  path: FilePath,
): Promise<FileMode | undefined> => {
  const stat = await ctx.fs.lstat(joinPath(workDir, path)).catch(() => undefined);
  return stat === undefined ? undefined : deriveWorkingMode(stat);
};
