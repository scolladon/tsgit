import { envBadBooleanValue } from '../../domain/commands/error.js';
import { parseGitBoolean } from '../../domain/config/config-ini.js';
import { primaryPath } from '../../domain/diff/change-path.js';
import {
  type ConflictKind,
  classifyUnmerged,
  comparePaths,
  type DiffChange,
  type FlatTree,
  type GroupedIndex,
  type UnmergedEntryGroup,
} from '../../domain/diff/index.js';
import {
  diffIndexAgainstTreeKeyed,
  groupUnmergedEntriesKeyed,
} from '../../domain/diff/index-diff.js';
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import {
  escapedPathOf,
  type IndexPathKey,
  indexPathKey,
  keyOfPath,
  viewOfEscaped,
} from '../../domain/git-index/index-path-key.js';
import { hasEscapedBytes } from '../../domain/objects/encoding.js';
import {
  deriveWorkingMode,
  FILE_MODE,
  type FileMode,
  type RefName,
} from '../../domain/objects/index.js';
import type { FilePath, ObjectId } from '../../domain/objects/object-id.js';
import type { Context } from '../../ports/context.js';
import type {
  WorkingTreeComparison,
  WorkingTreeDelta,
} from '../primitives/compare-working-tree-entry.js';
import { assertValidPromisorRemoteConfig } from '../primitives/internal/boolean-config-guard.js';
import { boundedMapFor } from '../primitives/internal/concurrency.js';
import { withFilterProcessPool } from '../primitives/internal/filter-process-pool.js';
import { acquireOptionalIndexLock, type IndexLock } from '../primitives/internal/index-lock.js';
import { hasRacyTimestamp } from '../primitives/internal/is-entry-stat-clean.js';
import { joinPath } from '../primitives/internal/join-working-tree-path.js';
import { assertOperationalRepositorySettingsFirst } from '../primitives/internal/repo-state.js';
import {
  scanTrackedEntries,
  type TrackedScan,
  verifiedBy,
} from '../primitives/internal/scan-tracked-entries.js';
import { readHeadTreeEscaped } from '../primitives/read-head-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { isUnreadableRef, resolveRefOrMissing } from '../primitives/resolve-ref.js';
import type { WalkWorkingTreeEntry } from '../primitives/types.js';
import { walkWorkingTree } from '../primitives/walk-working-tree.js';
import { buildRepoIgnorePredicate } from './internal/build-ignore-evaluator.js';
import { embeddedRepositories } from './internal/embedded-repository.js';
import { createGranularityTracker } from './internal/progress-tracker.js';
import { pruneGitlinkDirectories } from './internal/prune-gitlink-directories.js';
import { branchRefFromHead, readHeadRaw, requireWorkTree } from './internal/repo-state.js';
import { resolveRevisionName } from './internal/revision-name.js';
import {
  type SubmoduleIgnore,
  type SubmoduleState,
  submoduleIgnores,
  submoduleState,
} from './internal/submodule-state.js';

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
  /**
   * git's porcelain v2 `S<c><m><u>` submodule field, present on a row whose HEAD or index
   * side is a gitlink and absent otherwise: `commitChanged` (`C`) is the submodule's HEAD
   * differing from the recorded commit, `trackedChanges` (`M`) its own tracked changes,
   * `untrackedChanges` (`U`) its untracked files.
   */
  readonly submodule?: {
    readonly commitChanged: boolean;
    readonly trackedChanges: boolean;
    readonly untrackedChanges: boolean;
  };
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

/** Options for {@link status}. */
export interface StatusOptions {
  /**
   * Write refreshed stat data back to the index under the optional `index.lock`.
   * Default `true`; `false` is git's `--no-optional-locks status`: no lock is taken
   * and the index is never written. `GIT_OPTIONAL_LOCKS` in the context env disables
   * it too; `refresh: false` takes precedence and skips reading the variable.
   */
  readonly refresh?: boolean;
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

/**
 * Summarize the state of the working tree against git's columns, one correlated
 * record per changed path. `changes` carries each tracked path's **staged** column
 * (index vs HEAD-tree, git's "Changes to be committed") and **working-tree** column
 * (index vs working tree) together with the blob endpoints of each side — the
 * structured form of `git status --porcelain=v2`'s ordinary line. `untracked` is
 * the separate set of untracked paths (git's `?` lines; a directory holding another
 * repository is listed once, with a trailing slash); `unmerged` is the
 * conflicted column (stage 1/2/3 blobs, git's "Unmerged paths"). A conflicted path
 * is reported only under `unmerged`. `clean` is true only when all three are empty.
 *
 * Progress reporting: emits `status:scan` start before the working-tree fan-out,
 * updates every 100 lstat completions, and end in a finally block so the consumer
 * always pairs start with end. `total` is undefined — a design choice that avoids
 * revealing repository size to non-trusted progress sinks.
 */
export const status = (ctx: Context, opts: StatusOptions = {}): Promise<StatusResult> =>
  withFilterProcessPool(ctx, () => statusInScope(ctx, opts));

/** git's `-uno` (`no`) or its default untracked walk (`all`). */
export type UntrackedFilesMode = 'all' | 'no';

/**
 * How a dirty check runs a checkout's status — git's `-uno` and `--ignore-submodules=none`
 * flags — never part of the public surface.
 */
export interface DirtyCheckStatusOptions extends StatusOptions {
  /** git's `-uno`: no untracked walk, in this status and in the ones it runs on its own submodules. */
  readonly untrackedFiles?: UntrackedFilesMode;
  /** git's `--ignore-submodules=<mode>` on the command line: every gitlink takes it, the configured modes unread. */
  readonly submoduleIgnore?: SubmoduleIgnore;
}

/** The status git runs inside a submodule for a dirty check. */
export const statusForDirtyCheck = (
  ctx: Context,
  opts: DirtyCheckStatusOptions,
): Promise<StatusResult> => withFilterProcessPool(ctx, () => statusInScope(ctx, opts));

const OPTIONAL_LOCKS_ENV = 'GIT_OPTIONAL_LOCKS';

/** Whether status may take the optional index lock: `refresh: false` wins without
 *  reading the env (git's `--no-optional-locks` overwrites the variable); otherwise
 *  `GIT_OPTIONAL_LOCKS` decides, unset meaning enabled. */
const refreshEnabled = (ctx: Context, opts: StatusOptions): boolean => {
  if (opts.refresh === false) return false;
  const value = ctx.env?.get(OPTIONAL_LOCKS_ENV);
  if (value === undefined) return true;
  const parsed = parseGitBoolean(value);
  if (!parsed.ok) throw envBadBooleanValue(OPTIONAL_LOCKS_ENV, value);
  return parsed.value;
};

const HEAD_NAME = 'HEAD';

type StatusReport = Omit<StatusResult, 'branch' | 'detached'>;

/** What the report and the opportunistic refresh share, the lock held when refresh is enabled. */
interface LockedScan {
  readonly index: GitIndex;
  readonly tracked: TrackedEntries;
  readonly trackedScan: TrackedScan;
  readonly submodules: SubmoduleStates;
  readonly hidden: ReadonlySet<FilePath>;
  readonly workDir: string;
  readonly lock: IndexLock | undefined;
  readonly untrackedFiles: UntrackedFilesMode;
}

/** Scans untracked, reports, then refreshes the index when able; the lock is released whatever happens. */
const reportUnderLock = async (
  ctx: Context,
  { index, tracked, trackedScan, submodules, hidden, workDir, lock, untrackedFiles }: LockedScan,
): Promise<StatusReport> => {
  try {
    const untracked =
      untrackedFiles === 'no' ? [] : await scanUntracked(ctx, index, tracked.trackedPaths);
    const workingMap = withoutChanges(trackedScan.workingMap, hidden);
    const scanned = { workingMap, submodules, untracked };
    const report = await reportStatus(ctx, { index, tracked, scanned, workDir });
    if (lock) await updateIndexIfAble(lock, index, trackedScan);
    return report;
  } finally {
    await lock?.release();
  }
};

type HeadView = Pick<StatusResult, 'branch' | 'detached'>;

const UNKNOWN_HEAD: HeadView = { branch: undefined, detached: false };

/** git's `branch.head`: the branch HEAD names, detached, or unknown when HEAD's chain cannot be read. */
const headViewOf = async (ctx: Context): Promise<HeadView> => {
  try {
    const head = await readHeadRaw(ctx);
    await resolveRefOrMissing(ctx, HEAD_NAME);
    return { branch: branchRefFromHead(head), detached: head.kind === 'direct' };
  } catch (err) {
    if (isUnreadableRef(err)) return UNKNOWN_HEAD;
    throw err;
  }
};

const statusInScope = async (
  ctx: Context,
  opts: DirtyCheckStatusOptions,
): Promise<StatusResult> => {
  await assertOperationalRepositorySettingsFirst(ctx);
  const workDir = requireWorkTree(ctx, 'status');
  // Promisor-remote guard (see assertValidPromisorRemoteConfig) — loaded up front.
  await assertValidPromisorRemoteConfig(ctx);
  const head = await headViewOf(ctx);
  // `readIndex` returns an empty index when the file is absent (fresh/unborn
  // repo); a thrown error means a corrupt index, which we let propagate rather
  // than fabricate an empty one — fabricating it would report every HEAD path as
  // a spurious staged deletion (git errors on a corrupt index too).
  const index = await readIndex(ctx);
  ctx.progress.start(STATUS_SCAN_OP);
  try {
    const report = await scanAndReport(ctx, opts, {
      index,
      tracked: trackedEntriesOf(index),
      workDir,
    });
    return { ...head, ...report };
  } finally {
    ctx.progress.end(STATUS_SCAN_OP);
  }
};

/** Scans the tracked tree, runs git's dirty check on its gitlinks (a refusal precedes any index write), then reports. */
const scanAndReport = async (
  ctx: Context,
  opts: DirtyCheckStatusOptions,
  { index, tracked, workDir }: Pick<LockedScan, 'index' | 'tracked' | 'workDir'>,
): Promise<StatusReport> => {
  const trackedScan = await scanTrackedTree(ctx, index, tracked);
  const refresh = refreshEnabled(ctx, opts);
  const untrackedFiles = opts.untrackedFiles ?? 'all';
  const gitmodules = { workDir, stage0: tracked.stage0Map };
  const paths = gitlinkPathsOf(tracked);
  const ignores = await submoduleIgnores(ctx, gitmodules, paths, opts.submoduleIgnore);
  const hidden = hiddenOf(ignores);
  const dirtyChecks = { refresh, ignores, untrackedFiles };
  const submodules = await submoduleStatesOf(ctx, tracked, trackedScan, dirtyChecks);
  const lock = refresh ? await acquireOptionalIndexLock(ctx) : undefined;
  const scan = { index, tracked, trackedScan, submodules, hidden, workDir, lock, untrackedFiles };
  return reportUnderLock(ctx, scan);
};

/** The index's tracked entries: stage 0 by path, the unmerged groups, and every tracked path. */
interface TrackedEntries {
  readonly grouped: GroupedIndex;
  readonly stage0Map: ReadonlyMap<FilePath, IndexEntry>;
  readonly trackedPaths: ReadonlySet<IndexPathKey>;
}

/** Partition the index into the stage-0 (tracked) entries and the unmerged
 *  (stage 1/2/3) groups. A conflicted path has no stage-0 entry, so it is
 *  reported only under the unmerged column. */
const trackedEntriesOf = (index: GitIndex): TrackedEntries => {
  const grouped = groupUnmergedEntriesKeyed(index);
  const stage0Map = new Map<FilePath, IndexEntry>(
    grouped.staged.map((entry) => [escapedPathOf(entry), entry]),
  );
  const trackedPaths = new Set<IndexPathKey>(grouped.staged.map(indexPathKey));
  for (const path of grouped.unmerged.keys()) trackedPaths.add(keyOfPath(path));
  return { grouped, stage0Map, trackedPaths };
};

/** What the working tree holds: every tracked file's delta, and the untracked paths. */
interface ScannedTree {
  readonly workingMap: Map<FilePath, WorkingTreeDelta>;
  readonly submodules: SubmoduleStates;
  readonly untracked: ReadonlyArray<FilePath>;
}

type SubmoduleStates = ReadonlyMap<FilePath, SubmoduleState>;

/** A gitlink git neither assumes valid nor finds gone from disk; a skip-worktree one never yields a delta. */
const isDirtyChecked = (entry: IndexEntry, delta: WorkingTreeDelta): boolean =>
  entry.mode === FILE_MODE.GITLINK && !entry.flags.assumeValid && delta.status !== 'absent';

type DirtyCheck = readonly [FilePath, IndexEntry, WorkingTreeDelta, SubmoduleIgnore];

const gitlinkPathsOf = ({ stage0Map }: TrackedEntries): ReadonlyArray<FilePath> =>
  [...stage0Map].filter(([, entry]) => entry.mode === FILE_MODE.GITLINK).map(([path]) => path);

/** The scan's deltas with the given paths read as unchanged, the scan's own map left to the index refresh. */
const withoutChanges = (
  workingMap: ReadonlyMap<FilePath, WorkingTreeDelta>,
  hidden: ReadonlySet<FilePath>,
): Map<FilePath, WorkingTreeDelta> =>
  new Map(
    [...workingMap].map(([path, delta]) => [
      path,
      hidden.has(path) ? { ...delta, status: 'unchanged' } : delta,
    ]),
  );

type SubmoduleIgnores = ReadonlyMap<FilePath, SubmoduleIgnore>;

const hiddenOf = (ignores: SubmoduleIgnores): ReadonlySet<FilePath> =>
  new Set([...ignores].filter(([, mode]) => mode === 'all').map(([path]) => path));

const dirtyChecksOf = (
  { stage0Map }: TrackedEntries,
  { workingMap }: TrackedScan,
  ignores: SubmoduleIgnores,
): ReadonlyArray<DirtyCheck> => {
  const checked: DirtyCheck[] = [];
  for (const [path, entry] of stage0Map) {
    const delta = workingMap.get(path);
    const mode = ignores.get(path);
    if (delta === undefined || mode === undefined || mode === 'all') continue;
    if (isDirtyChecked(entry, delta)) checked.push([path, entry, delta, mode]);
  }
  return checked;
};

/** git's dirty check runs over each gitlink the scan found on disk; it refuses a `.git` that leads to no repository. */
const submoduleStatesOf = async (
  ctx: Context,
  tracked: TrackedEntries,
  scan: TrackedScan,
  { refresh, ignores, untrackedFiles }: DirtyChecks,
): Promise<SubmoduleStates> => {
  const states = new Map<FilePath, SubmoduleState>();
  // git runs the checkouts' statuses one after another.
  for (const [path, entry, delta, ignore] of dirtyChecksOf(tracked, scan, ignores)) {
    const childStatus = (child: Context) =>
      statusForDirtyCheck(child, {
        refresh,
        untrackedFiles: childUntrackedFiles(untrackedFiles, ignore),
      });
    states.set(path, await submoduleState(ctx, entry, delta, { childStatus, ignore }));
  }
  return states;
};

interface DirtyChecks {
  readonly refresh: boolean;
  readonly ignores: SubmoduleIgnores;
  readonly untrackedFiles: UntrackedFilesMode;
}

/** git's `is_submodule_modified` passes `-uno` down when untracked files are ignored, by flag or by the gitlink's mode. */
const childUntrackedFiles = (
  inherited: UntrackedFilesMode,
  ignore: SubmoduleIgnore,
): UntrackedFilesMode => (inherited === 'no' || ignore === 'untracked' ? 'no' : 'all');

/** Write the refreshed stat data back, only when something is worth persisting:
 *  a drifted entry, or an entry racy against the index file's own mtime. */
const updateIndexIfAble = async (
  lock: IndexLock,
  index: GitIndex,
  scan: TrackedScan,
): Promise<void> => {
  const racy = index.indexMtime !== undefined && hasRacyTimestamp(index.entries, index.indexMtime);
  if (scan.refreshed.length === 0 && !racy) return lock.release();
  // A path the scan found unchanged, by stat or by content, is git's `CE_UPTODATE`.
  await lock.commitRefresh(index, scan.refreshed, verifiedBy(scan));
};

const scanTrackedTree = async (
  ctx: Context,
  index: GitIndex,
  tracked: TrackedEntries,
): Promise<TrackedScan> => {
  const tracker = createGranularityTracker(ctx.progress, STATUS_SCAN_OP, STATUS_SCAN_GRANULARITY);
  return scanTrackedEntries(ctx, index, tracked.grouped.staged, () => tracker.tick());
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
): Promise<StatusReport> => {
  const headId = await resolveRevisionName(ctx, HEAD_NAME);
  const headTree = headId === undefined ? undefined : await readHeadTreeEscaped(ctx);
  const { unmerged: groups } = tracked.grouped;
  const stagedKindMap = collectStagedKinds(index, headTree, groups);
  const changes = buildChanges(stagedKindMap, scanned, headTree, tracked.stage0Map);
  const unmerged = await buildUnmergedEntries(ctx, groups, workDir);
  const { untracked } = scanned;
  const clean = changes.length === 0 && untracked.length === 0 && unmerged.length === 0;
  return { changes, untracked, unmerged, clean };
};

/**
 * Untracked pass: walk the working tree (gitignore-filtered) and collect every
 * path not tracked (stage-0 or unmerged). Tracked-but-ignored entries stay
 * tracked; the ignore filter affects untracked emission only. The walk stays
 * sequential (a stateful ignore stack, and its emission order is a pinned
 * contract) — this pass never reads a leaf's stat, only its path and kind bits,
 * so it pays zero `lstat`s regardless.
 */
const scanUntracked = async (
  ctx: Context,
  index: GitIndex,
  trackedPaths: ReadonlySet<IndexPathKey>,
): Promise<FilePath[]> => {
  const ignore = pruneGitlinkDirectories(await buildRepoIgnorePredicate(ctx), index.entries);
  const repositories = embeddedRepositories(ctx, index.entries);
  const untracked: FilePath[] = [];
  for await (const entry of walkWorkingTree(ctx, {
    ignore,
    isNestedRepository: repositories.holds,
  })) {
    if (!trackedPaths.has(keyOfPath(entry.path))) untracked.push(untrackedSpelling(entry));
  }
  return untracked.sort(comparePaths);
};

const SEPARATOR = '/';

/** A repository directory is listed as git's `-uall` porcelain lists it: with a trailing slash. */
const untrackedSpelling = ({
  path,
  isDirectory,
}: Pick<WalkWorkingTreeEntry, 'path' | 'isDirectory'>): FilePath =>
  isDirectory ? (`${path}${SEPARATOR}` as FilePath) : path;

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
  for (const change of diffIndexAgainstTreeKeyed(index, headTree).changes) {
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
  { workingMap, submodules }: Pick<ScannedTree, 'workingMap' | 'submodules'>,
  headTree: FlatTree | undefined,
  stage0Map: ReadonlyMap<FilePath, IndexEntry>,
): ChangedPath[] => {
  const paths = new Set<FilePath>(stagedKindMap.keys());
  for (const [path, delta] of workingMap) {
    if (unstagedKindOf(delta, submodules.get(path)) !== undefined) paths.add(path);
  }
  const changes = [...paths].map((path) =>
    buildChangedPath(
      path,
      stagedKindMap.get(path),
      workingMap.get(path),
      headTree,
      stage0Map.get(path),
      submodules.get(path),
    ),
  );
  return changes
    .sort((a, b) => comparePaths(a.path, b.path))
    .map((change) => ({ ...change, path: viewOfEscaped(change.path) }));
};

/** A gitlink whose checkout holds changes is modified in the working tree though its commit did not move; a file in its place keeps its kind. */
const unstagedKindOf = (
  delta: WorkingTreeDelta,
  checked: SubmoduleState | undefined,
): ChangeKind | undefined => {
  const kind = toUnstagedKind(delta.status);
  if (kind !== undefined || checked === undefined) return kind;
  return checked.trackedChanges || checked.untrackedChanges ? 'modified' : undefined;
};

/** Whether a row's HEAD or index side is a gitlink: only those carry git's submodule field. */
const submoduleOf = (
  delta: WorkingTreeDelta | undefined,
  head: { readonly mode: string } | undefined,
  indexEntry: IndexEntry | undefined,
): ChangedPath['submodule'] => {
  if (head?.mode !== FILE_MODE.GITLINK && indexEntry?.mode !== FILE_MODE.GITLINK) return undefined;
  return {
    commitChanged: indexEntry?.mode === FILE_MODE.GITLINK && delta?.status === 'modified',
    trackedChanges: false,
    untrackedChanges: false,
  };
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
  checked: SubmoduleState | undefined,
): ChangedPath => {
  const head = headTree?.entries.get(path);
  const unstaged = delta === undefined ? undefined : unstagedKindOf(delta, checked);
  const submodule = checked ?? submoduleOf(delta, head, indexEntry);
  return {
    path,
    ...(staged !== undefined && { staged }),
    ...(unstaged !== undefined && { unstaged }),
    ...(head !== undefined && { head: { id: head.id, mode: head.mode } }),
    ...(indexEntry !== undefined && { index: { id: indexEntry.id, mode: indexEntry.mode } }),
    ...(delta?.worktreeMode !== undefined && { worktree: { mode: delta.worktreeMode } }),
    ...(submodule !== undefined && { submodule }),
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
      path: viewOfEscaped(path),
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
  // A lossy name reads as absent, with no fs call naming it.
  if (hasEscapedBytes(path)) return undefined;
  const stat = await ctx.fs.lstat(joinPath(workDir, path)).catch(() => undefined);
  return stat === undefined ? undefined : deriveWorkingMode(stat);
};
