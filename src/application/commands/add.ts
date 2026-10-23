/**
 * `add` porcelain — stage working-tree paths into the index, faithful to
 * `git add`. The resulting index + tree read back (via `git ls-files --stage`
 * / `git write-tree`) match canonical git; raw index bytes differ only by
 * per-host stat-cache fields.
 *
 * @writes
 *   surface: add
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */

import { invalidOption, workingTreeFileTooLarge } from '../../domain/commands/error.js';
import { comparePaths } from '../../domain/diff/path-compare.js';
import type { EolSettings } from '../../domain/eol/crlf-action.js';
import type { EolNotice } from '../../domain/eol/crlf-conversion.js';
import { operationAborted, TsgitError } from '../../domain/error.js';
import {
  entriesAtLeadingDirectories,
  entriesBeneath,
} from '../../domain/git-index/directory-file-conflict.js';
import type { IndexEntry } from '../../domain/git-index/index.js';
import {
  escapedPathOf,
  type IndexPath,
  type IndexPathKey,
  indexPathKey,
  isLossy,
  keyOfPath,
} from '../../domain/git-index/index-path-key.js';
import { NO_PARSER_OFFSET } from '../../domain/git-index/path-validator.js';
import {
  type ResolveUndoRecord,
  resolveUndoRecordOf,
} from '../../domain/git-index/resolve-undo.js';
import { emptyPathspec, pathspecNoMatch } from '../../domain/index.js';
import {
  deriveWorkingMode,
  FILE_MODE,
  type FileMode,
  type ObjectId,
} from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { matchesPathspec, type Pathspec } from '../../domain/pathspec/index.js';
import {
  matchesUnmergedPath,
  type PathspecVerdict,
  pathspecVerdict,
  withoutExactly,
} from '../../domain/pathspec/match-pathspec.js';
import { matchesIndexPath, matchesUnmergedIndexPath } from '../../domain/pathspec/matching-path.js';
import { globSpecialIndex } from '../../domain/pathspec/wildcard.js';
import { CHERRY_PICK, MERGE, REBASE, REVERT } from '../../domain/sequencer/operation-labels.js';
import type { Context } from '../../ports/context.js';
import type { FileStat } from '../../ports/file-system.js';
import { assertValidPromisorRemoteConfig } from '../primitives/internal/boolean-config-guard.js';
import {
  admitWrite,
  type CleanOrder,
  firstFailureOrValues,
  type OrderSpan,
  type Settled,
  settleInCleanTurn,
  withCleanOrder,
} from '../primitives/internal/clean-order.js';
import { boundedMapFor, limiterFor } from '../primitives/internal/concurrency.js';
import type { ConcurrencyLimiter } from '../primitives/internal/concurrency-limiter.js';
import { type ConversionRoute, convertToGit } from '../primitives/internal/convert-blob.js';
import { withFilterProcessPool } from '../primitives/internal/filter-process-pool.js';
import { indexEntryFromStat } from '../primitives/internal/index-entry-from-stat.js';
import type { CommitOptions, IndexLock } from '../primitives/internal/index-lock.js';
import { indexPathRulesOf } from '../primitives/internal/index-path-rules.js';
import { indexRuleEntries } from '../primitives/internal/index-rule-entries.js';
import { type IndexMtime, isEntryStatClean } from '../primitives/internal/is-entry-stat-clean.js';
import { joinPath } from '../primitives/internal/join-working-tree-path.js';
import {
  type AttributeProvider,
  buildCheckinAttributeProvider,
} from '../primitives/internal/read-gitattributes.js';
import { assertBigFileThresholdValid } from '../primitives/internal/repo-settings-gate.js';
import {
  createLeadingPathScanner,
  type LeadingPathScanner,
} from '../primitives/internal/symlinked-leading-path.js';
import { readIndex } from '../primitives/read-index.js';
import {
  IDENTITY_CONVERSION,
  readEolSettings,
  resolveConversion,
} from '../primitives/resolve-conversion.js';
import { streamsThroughFilter } from '../primitives/resolve-filter-driver.js';
import { MAX_WORKING_TREE_BLOB_BYTES, type WalkWorkingTreeEntry } from '../primitives/types.js';
import { walkWorkingTree } from '../primitives/walk-working-tree.js';
import { writeObject } from '../primitives/write-object.js';
import type { IgnorePredicate } from './internal/add-ignore.js';
import { buildRepoIgnorePredicate } from './internal/build-ignore-evaluator.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  type CommandPathspec,
  type PositivePathspec,
  reachesSkipWorktree,
  resolveCommandPathspec,
  trackPositives,
  unmatchedPositives,
} from './internal/pathspec-intake.js';
import {
  assertNoPendingOperation,
  assertOperationalRepository,
  requireWorkTree,
} from './internal/repo-state.js';
import {
  assertNoSymlinkedLeadingPath,
  namesDirectoryOnly,
  namesWholeTree,
  type ResolvedPathspec,
  resolvePathspec,
} from './internal/resolve-pathspec.js';

/** Runs the guard at most once, on first use, per {@link createPromisorGuard} call. */
type PromisorGuard = () => Promise<void>;

/**
 * Defers `assertValidPromisorRemoteConfig` to the first file the write path
 * actually touches, and single-flights it thereafter — so a pathspec that
 * matches nothing never pays it (or refuses on it) at all, while a
 * multi-file `add` pays it once instead of once per file. Each of `add`'s
 * three write-path entry points (`addLiteralOnly`, `addByPathspec`,
 * `addAll`) creates its own guard, scoping "once" to one `add` invocation.
 */
const createPromisorGuard = (ctx: Context): PromisorGuard => {
  let pending: Promise<void> | undefined;
  return () => (pending ??= assertValidPromisorRemoteConfig(ctx));
};

const INDEX_MISSING_CODES = new Set([
  'FILE_NOT_FOUND',
  'INVALID_INDEX_HEADER',
  'INVALID_INDEX_ENTRY',
]);

export interface AddOptions {
  /** git's `-f`: no ignore rule applies, on any route. */
  readonly force?: boolean;
  readonly all?: boolean;
  /** Re-clean every tracked path the pathspec names under the current attributes; never adds or removes. */
  readonly renormalize?: boolean;
}

export interface AddResult {
  readonly added: ReadonlyArray<FilePath>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly removed: ReadonlyArray<FilePath>;
  readonly eolNotices: ReadonlyArray<EolNotice>;
  /**
   * Pathspecs, as typed and in argument order, that matched only skip-worktree
   * entries. git lists them under 'outside of your sparse-checkout definition'
   * and exits 1. Empty when none.
   */
  readonly sparse: ReadonlyArray<string>;
  /**
   * Ignored entries a positive pathspec reached, sorted and deduplicated. git lists
   * them under 'The following paths are ignored by one of your .gitignore files' and
   * exits 1. A tracked path is never listed. Always empty with `force`.
   */
  readonly ignored: ReadonlyArray<FilePath>;
}

/**
 * Stage paths in the index. Two modes:
 *
 * - **Literal-path mode** (`paths` non-empty, `all` falsy): every path is
 *  validated, read, hashed, and staged. Untracked missing paths reject the whole
 *  call; a tracked path missing from disk is staged as a deletion and lands in
 *  `removed`, as are the tracked paths a glob or directory names.
 * - **Bulk mode** (`paths` empty, `all === true`): walk the working tree,
 *  stage every modified/new tracked file plus every untracked, non-ignored
 *  file. Files missing from disk but present in the prior index land in
 *  `removed`. `.git` and embedded repositories are skipped.
 *
 * Both modes acquire `.git/index.lock` once, read the existing index under
 * the lock, and commit a single replacement — no partial writes.
 */
export const add = (
  ctx: Context,
  paths: ReadonlyArray<string>,
  opts: AddOptions = {},
): Promise<AddResult> => withFilterProcessPool(ctx, () => addInScope(ctx, paths, opts));

/** What converts a path on its way into the repository: its attributes and the eol settings. */
interface ConversionScope {
  readonly provider: AttributeProvider;
  readonly settings: EolSettings;
}

/**
 * The scope once the index is read: the stage-2 entry of every unmerged path,
 * which is where git reads the index-CRLF rule when no stage 0 exists. Built
 * with the index so a bulk add of many unmerged paths reads it once.
 */
interface StagingScope extends ConversionScope {
  readonly indexRules: ReadonlyMap<FilePath, IndexEntry>;
}

const NO_INDEX_RULES: ReadonlyMap<FilePath, IndexEntry> = new Map();

const buildConversionScope = async (ctx: Context): Promise<ConversionScope> => ({
  provider: await buildCheckinAttributeProvider(ctx),
  settings: await readEolSettings(ctx),
});

const WHOLE_TREE_PATHSPEC = '.';

/** `force` is git's `-f`: no ignore rule applies, so nothing is ever ignored. */
const NEVER_IGNORED: IgnorePredicate = () => false;

const repoIgnoreOf = (
  ctx: Context,
  opts: AddOptions,
): Promise<IgnorePredicate> | IgnorePredicate =>
  opts.force === true ? NEVER_IGNORED : buildRepoIgnorePredicate(ctx);

const WHOLE_TREE_MATCHER = resolvePathspec([WHOLE_TREE_PATHSPEC]).matcher;

const addInScope = async (
  ctx: Context,
  paths: ReadonlyArray<string>,
  opts: AddOptions,
): Promise<AddResult> => {
  await assertOperationalRepository(ctx);
  requireWorkTree(ctx, 'add');
  // Allow `add` during a conflicted operation — staging resolved files IS the
  // path forward for merge / cherry-pick / revert / rebase alike.
  await assertNoPendingOperation(ctx, { except: [MERGE, CHERRY_PICK, REVERT, REBASE] });
  // Build the attribute provider ONCE per add invocation; a runner-less
  // context builds it only when a driver is required.
  const scope = await buildConversionScope(ctx);
  if (opts.all === true) {
    if (paths.length !== 0) {
      throw invalidOption('all', 'pathspec must be empty when all=true');
    }
    return opts.renormalize === true
      ? addRenormalized(ctx, [WHOLE_TREE_PATHSPEC], scope)
      : addAll(ctx, opts.force === true ? NEVER_IGNORED : undefined, scope);
  }
  if (paths.length === 0) throw emptyPathspec();
  if (opts.renormalize === true) return addRenormalized(ctx, paths, scope);
  return dispatchPathspec(ctx, paths, opts, scope);
};

// Branch on the resolved pathspec: pure literals that each name an
// existing file route through the byte-identical per-path stage flow
// from; anything else (globs, literal directories, negations)
// walks the working tree and filters with the matcher.
const dispatchPathspec = async (
  ctx: Context,
  paths: ReadonlyArray<string>,
  opts: AddOptions,
  scope: ConversionScope,
): Promise<AddResult> => {
  const resolved = resolveCommandPathspec(ctx, paths);
  const { literalMustMatch } = resolved;
  await assertNoSymlinkedLeadingPath(ctx, resolved.symlinkScanTargets);
  const walks = resolved.hasGlob || holdsExclusion(resolved.matcher);
  const stats = walks ? undefined : await literalStats(ctx, literalMustMatch);
  if (stats !== undefined) return addLiteralOnly(ctx, resolved, stats, scope);
  return addByPathspec(ctx, resolved, await repoIgnoreOf(ctx, opts), scope);
};

const holdsExclusion = (matcher: Pathspec): boolean => matcher.some((entry) => entry.negated);

const addLiteralOnly = async (
  ctx: Context,
  resolved: CommandPathspec,
  stats: LiteralStats,
  scope: ConversionScope,
): Promise<AddResult> => {
  const lock = await acquireIndexLock(ctx);
  const ensurePromisorConfigValid = createPromisorGuard(ctx);
  try {
    const { indexRules, unmergedStages, stageZeroBeside, sorted, ...state } =
      await readExistingEntries(ctx);
    const staging = {
      ctx,
      scope: { ...scope, indexRules },
      ...state,
      stageZeroBeside,
      ensurePromisorConfigValid,
    };
    const { sparse, stageable } = splitSparseLiterals(resolved, state.entries);
    const { remaining, restagedPaths, ...result } = await stageLiteralsOver(
      staging,
      sorted,
      stageable,
      stats,
    );
    await commitStaged(lock, { sorted, unmergedStages, stageZeroBeside }, remaining, restagedPaths);
    return { ...result, sparse: sparse.map(({ spelling }) => spelling), ignored: [] };
  } finally {
    await lock.release();
  }
};

/**
 * git leaves a skip-worktree entry alone and reports the literal that names it.
 * Only the entry's own path counts: a literal naming a symlink that replaced a
 * directory is staged, and the skip-worktree entries beneath it just go.
 */
const splitSparseLiterals = (
  resolved: CommandPathspec,
  entries: ReadonlyMap<IndexPathKey, IndexEntry>,
): { readonly sparse: ReadonlyArray<PositivePathspec>; readonly stageable: ResolvedPathspec } => {
  const namesSkipWorktree = ({ entry }: PositivePathspec): boolean => {
    const named = entries.get(keyOfPath(entry.body as FilePath));
    return named !== undefined && isStageZeroSkipWorktree(named);
  };
  const sparse = resolved.positives.filter(namesSkipWorktree);
  const sparseBodies = new Set(sparse.map(({ entry }) => entry.body));
  const literalMustMatch = resolved.literalMustMatch.filter((body) => !sparseBodies.has(body));
  return { sparse, stageable: { ...resolved, literalMustMatch } };
};

/** Stage the literals, then drop what a non-directory they inserted now replaces. */
const stageLiteralsOver = async (
  staging: Staging,
  sorted: ReadonlyArray<IndexEntry>,
  { literalMustMatch, matcher }: ResolvedPathspec,
  stats: LiteralStats,
) => {
  const { newEntries, inserted, restagedPaths, ...staged } = await stageLiterals(
    staging,
    literalMustMatch,
    stats,
  );
  const view = { sorted, inserted };
  const dropped = await dropBeneathInserted(staging.ctx, view, matcher, newEntries);
  return {
    ...staged,
    restagedPaths,
    remaining: dropped.remaining,
    removed: dropped.removed.sort(),
  };
};

/** What every path is staged against: the index as read, and the add's attributes and guard. */
interface Staging {
  readonly ctx: Context;
  readonly scope: StagingScope;
  readonly entries: ReadonlyMap<IndexPathKey, IndexEntry>;
  readonly stageZeroBeside: ReadonlyMap<IndexPathKey, IndexEntry>;
  readonly indexMtime: IndexMtime | undefined;
  readonly ensurePromisorConfigValid: PromisorGuard;
}

/** A staged unmerged path is always a change: its conflict is resolved whatever the content. */
const isModified = (previous: IndexEntry, entry: IndexEntry): boolean =>
  previous.flags.stage !== 0 || previous.id !== entry.id || previous.mode !== entry.mode;

/** git stages the tracked paths first, then the untracked ones, each group in index order. */
const trackedFirst = (
  paths: ReadonlyArray<FilePath>,
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
): FilePath[] => {
  const sorted = [...paths].sort(comparePaths);
  return [
    ...sorted.filter((path) => existing.has(keyOfPath(path))),
    ...sorted.filter((path) => !existing.has(keyOfPath(path))),
  ];
};

/** git stages — and cleans — in index order, whatever order the paths came in. */
const stageLiterals = async (
  staging: Staging,
  validated: ReadonlyArray<FilePath>,
  stats: LiteralStats,
): Promise<{
  readonly newEntries: Map<IndexPathKey, IndexEntry>;
  readonly added: ReadonlyArray<FilePath>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly eolNotices: ReadonlyArray<EolNotice>;
  readonly restagedPaths: ReadonlyArray<IndexPath>;
  readonly inserted: ReadonlyArray<InsertedPath>;
}> => {
  const { ctx, scope } = staging;
  const ordered = trackedFirst(validated, staging.entries).map((path) => ({
    path,
    stat: stats.get(path) as FileStat,
  }));
  // git converts and writes one path at a time, dying at the first loss, under safecrlf=true.
  const span: OrderSpan = scope.settings.safeCrlf === true ? 'write' : 'clean';
  const settled = await dispatchInCleanOrder(ctx, ordered, stageLiteral(staging), span);
  return foldLiteralOutcomes(staging, ordered.map(pathOf), firstFailureOrValues(settled));
};

const pathOf = ({ path }: Named): FilePath => path;

const stageLiteral =
  ({ ctx, scope, entries, indexMtime, ensurePromisorConfigValid }: Staging) =>
  ({ path, stat }: Named & { readonly stat: FileStat }): Promise<StagedBlob> =>
    stageFromFreshStat(
      ctx,
      path,
      stat,
      scope,
      entries.get(keyOfPath(path)),
      indexMtime,
      ensurePromisorConfigValid,
    );

/** The literals' outcomes folded in index order, so the result order is the staging order. */
const foldLiteralOutcomes = (
  { entries: existing, stageZeroBeside }: Staging,
  paths: ReadonlyArray<FilePath>,
  staged: ReadonlyArray<StagedBlob>,
) => {
  const newEntries = new Map<IndexPathKey, IndexEntry>(existing);
  const added: FilePath[] = [];
  const modified: FilePath[] = [];
  const eolNotices: EolNotice[] = [];
  const restagedPaths: IndexPath[] = [];
  const inserted: InsertedPath[] = [];
  paths.forEach((path, index) => {
    const { entry, notice } = staged[index] as StagedBlob;
    const previous = existing.get(keyOfPath(path));
    newEntries.set(keyOfPath(path), entry);
    if (wasRestaged(previous, entry)) restagedPaths.push(entry);
    if (notice !== undefined) eolNotices.push(notice);
    if (previous === undefined) added.push(path);
    else if (isModified(previous, entry) || stageZeroBeside.has(keyOfPath(path))) {
      modified.push(path);
    }
    if (previous === undefined || previous.flags.stage !== 0) inserted.push({ path, previous });
  });
  return { newEntries, added, modified, eolNotices, restagedPaths, inserted };
};

/** The index an add started from, as the directory/file step reads it. */
interface IndexView {
  readonly sorted: ReadonlyArray<IndexEntry>;
  readonly inserted: ReadonlyArray<InsertedPath>;
}

/** A path staged where the index had no stage-0 entry: `previous` is absent or unmerged. */
interface InsertedPath {
  readonly path: FilePath;
  readonly previous: IndexEntry | undefined;
}

/**
 * A path that now holds a non-directory leaves nothing beneath it, and a path staged beneath a
 * tracked file or symlink leaves that one behind — silently, as the removal pass reports it.
 * Takes ownership of `newEntries` (the caller's fresh map) and returns it as `remaining`.
 */
const dropBeneathInserted = async (
  ctx: Context,
  { sorted, inserted }: IndexView,
  matcher: ResolvedPathspec['matcher'],
  newEntries: Map<IndexPathKey, IndexEntry>,
): Promise<{
  remaining: Map<IndexPathKey, IndexEntry>;
  removed: FilePath[];
  dropped: Set<IndexPathKey>;
}> => {
  const remaining = newEntries;
  const removed: FilePath[] = [];
  const dropped = new Set<IndexPathKey>();
  for (const { path, previous } of inserted) {
    for (const leading of entriesAtLeadingDirectories(remaining, path)) {
      remaining.delete(indexPathKey(leading));
    }
    const reportMatcher = previous === undefined ? matcher : withoutExactly(matcher, path);
    const replaced = await replacedBeneath(ctx, stagesBeneath(sorted, path), reportMatcher);
    for (const key of replaced.dropped) {
      remaining.delete(key);
      dropped.add(key);
    }
    removed.push(...replaced.reported);
  }
  return { remaining, removed, dropped };
};

/**
 * The removals a walk reports once the D/F step has spoken: the post-walk pass's own, except for
 * what sits beneath an inserted path — that is the step's to report or to keep silent.
 */
const reportedRemovals = (
  removedEntries: ReadonlyArray<IndexEntry>,
  {
    removed,
    dropped,
  }: { readonly removed: ReadonlyArray<FilePath>; readonly dropped: ReadonlySet<IndexPathKey> },
): FilePath[] => [
  ...removedEntries.filter((entry) => !dropped.has(indexPathKey(entry))).map(({ path }) => path),
  ...removed,
];

/** What a walk leaves once the D/F step and the removal pass have spoken: the entries to keep and the paths to report. */
const settleRemovals = async (
  ctx: Context,
  view: IndexView,
  matcher: ResolvedPathspec['matcher'],
  newEntries: Map<IndexPathKey, IndexEntry>,
  removedEntries: ReadonlyArray<IndexEntry>,
) => {
  const replaced = await dropBeneathInserted(ctx, view, matcher, newEntries);
  for (const entry of removedEntries) replaced.remaining.delete(indexPathKey(entry));
  return {
    remaining: replaced.remaining,
    removed: reportedRemovals(removedEntries, replaced),
    everyRemoval: [...removedEntries.map(({ path }) => path), ...replaced.removed],
  };
};

/** Writes the staged entries beside the stages of the paths the add left alone. */
const commitStaged = (
  lock: IndexLock,
  {
    sorted,
    unmergedStages,
    stageZeroBeside,
  }: Pick<ExistingIndexState, 'sorted' | 'unmergedStages' | 'stageZeroBeside'>,
  remaining: ReadonlyMap<IndexPathKey, IndexEntry>,
  restagedPaths: ReadonlyArray<IndexPath>,
): Promise<void> =>
  commitIfChanged(
    lock,
    sorted.length,
    withEveryStage(remaining, unmergedStages, stageZeroBeside),
    resolutionOptions(restagedPaths, remaining, unmergedStages, stageZeroBeside),
  );

/** The paths a walk staged where the index held no stage-0 entry. */
const insertedBy = (
  outcomes: ReadonlyArray<WalkOutcome>,
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
): InsertedPath[] =>
  outcomes
    .map(({ path }) => ({ path, previous: existing.get(keyOfPath(path)) }))
    .filter(({ previous }) => previous === undefined || previous.flags.stage !== 0);

const appendTo = (
  groups: Map<IndexPathKey, IndexEntry[]>,
  key: IndexPathKey,
  entry: IndexEntry,
): void => {
  const group = groups.get(key);
  if (group === undefined) groups.set(key, [entry]);
  else group.push(entry);
};

/** Every stage of each path beneath `path`, grouped by path. */
const stagesBeneath = (
  sorted: ReadonlyArray<IndexEntry>,
  path: FilePath,
): Map<IndexPathKey, IndexEntry[]> => {
  const beneath = new Map<IndexPathKey, IndexEntry[]>();
  for (const entry of entriesBeneath(sorted, path)) {
    const key = indexPathKey(entry);
    appendTo(beneath, key, entry);
  }
  return beneath;
};

/**
 * What the new non-directory replaces: every stage-0 path beneath it goes (reported when the
 * matcher selects it and it is gone from disk, silent otherwise); an unmerged one goes only
 * when the matcher selects it, and is kept with every stage otherwise.
 */
const replacedBeneath = async (
  ctx: Context,
  beneath: ReadonlyMap<IndexPathKey, ReadonlyArray<IndexEntry>>,
  matcher: ResolvedPathspec['matcher'],
): Promise<{ dropped: IndexPathKey[]; reported: FilePath[] }> => {
  const stageZero = new Map<IndexPathKey, IndexEntry>();
  const dropped: IndexPathKey[] = [];
  const reported: FilePath[] = [];
  for (const [key, stages] of beneath) {
    const [first] = stages as [IndexEntry];
    if (first.flags.stage === 0) stageZero.set(key, first);
    else if (matchesUnmergedIndexPath(matcher, first, stages.length)) {
      dropped.push(key);
      reported.push(first.path);
    }
  }
  const gone = await collectMatchedRemovals(ctx, stageZero, [], indexVerdicts(matcher, stageZero));
  return {
    dropped: [...stageZero.keys(), ...dropped],
    reported: [...gone.map(({ path }) => path), ...reported],
  };
};

/** git's SKIP_IF_UNCHANGED: a re-staged, added or removed path is a change; additions are always re-staged, so a size drift is a removal. */
const changesIndex = (
  existingCount: number,
  entries: ReadonlyArray<IndexEntry>,
  { restagedPaths = [] }: CommitOptions,
): boolean => restagedPaths.length > 0 || entries.length !== existingCount;

const commitIfChanged = async (
  lock: IndexLock,
  existingCount: number,
  entries: ReadonlyArray<IndexEntry>,
  options: CommitOptions,
): Promise<void> => {
  if (!changesIndex(existingCount, entries, options)) return;
  await lock.commit(entries, 'update', options);
};

/** `ie_match_stat` clean paths keep their entry object; every other path was rebuilt, which git's add_index_entry reports to the cache-tree. */
const wasRestaged = (previous: IndexEntry | undefined, entry: IndexEntry): boolean =>
  entry !== previous;

/** The lstat of every literal, taken once; a literal that is no file routes the add to the walk. */
type LiteralStats = ReadonlyMap<FilePath, FileStat>;

const literalStats = async (
  ctx: Context,
  literals: ReadonlyArray<FilePath>,
): Promise<LiteralStats | undefined> => {
  if (literals.length === 0 || literals.some(namesDirectoryOnly)) return undefined;
  const probed = await boundedMapFor(ctx, 'ioBound', literals, (path) =>
    lstatOrBeneathFile(ctx, path),
  );
  const stats = new Map<FilePath, FileStat>();
  for (const [index, stat] of probed.entries()) {
    if (stat === undefined || (stat.isDirectory && !stat.isSymbolicLink)) return undefined;
    stats.set(literals[index] as FilePath, stat);
  }
  return stats;
};

const NOT_A_DIRECTORY = 'NOT_A_DIRECTORY';
const SEPARATOR = '/';

/** A literal beneath a regular file is routed to the pathspec walk, which stages its removal. */
const lstatOrBeneathFile = async (
  ctx: Context,
  path: FilePath,
): Promise<Awaited<ReturnType<typeof lstatOrMissing>>> => {
  try {
    return await lstatOrMissing(ctx, path);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === NOT_A_DIRECTORY) return undefined;
    throw err;
  }
};

/**
 * `lstat` a working-tree path, translating a missing path to `undefined`.
 * Any other failure (e.g. PERMISSION_DENIED) propagates — narrowing the
 * catch to FILE_NOT_FOUND-only is what keeps `git add missing-file` reporting
 * PATHSPEC_NO_MATCH without silently absorbing a genuine I/O error.
 */
const lstatOrMissing = async (
  ctx: Context,
  path: FilePath,
): Promise<Awaited<ReturnType<Context['fs']['lstat']>> | undefined> => {
  try {
    return await ctx.fs.lstat(joinPath(requireWorkTree(ctx, 'add'), path));
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_NOT_FOUND') return undefined;
    throw err;
  }
};

/** The walk as it streams, or as already collected. */
type WalkSource = AsyncIterable<WalkWorkingTreeEntry> | Iterable<WalkWorkingTreeEntry>;

/**
 * Fans every walked entry's `stageFromStat` work through an `ioBound` pool
 * while the walk itself (`walkWorkingTree`) stays a plain sequential
 * `for await` — the walker's ignore stack is stateful and its emission
 * order is a pinned contract; only the per-entry I/O that follows a yield is
 * safe to run concurrently. Staging is path-keyed and every caller sorts
 * `added`/`modified` afterwards, so completion order carries no meaning.
 *
 * A rejection (a hostile-path abort, or the walk itself throwing) is
 * settled rather than propagated immediately: every already-dispatched
 * task is drained (awaited to settlement, never left dangling) before the
 * error surfaces, so the index is never committed while a pooled write may
 * still be in flight. The surfaced error is the earliest-walked entry's
 * rejection, not whichever settles first under the pool's own scheduling —
 * a later-walked entry with a faster failure must not shadow an earlier
 * one's, or the refusal payload becomes a function of pool timing instead
 * of the deterministic walk order.
 */
const stageWalkedEntries = async (
  ctx: Context,
  walk: WalkSource,
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
  seen: Set<IndexPathKey>,
  scope: StagingScope,
  indexMtime: IndexMtime | undefined,
  ensurePromisorConfigValid: PromisorGuard,
): Promise<WalkOutcome[]> => {
  const stage = (walkEntry: WalkWorkingTreeEntry): Promise<WalkOutcome> =>
    processWalkEntry(ctx, walkEntry, existing, seen, scope, indexMtime, ensurePromisorConfigValid);
  // git converts and writes one path at a time, dying at the first loss, under safecrlf=true.
  const span: OrderSpan = scope.settings.safeCrlf === true ? 'write' : 'clean';
  const ordered = walkedTrackedFirst(walk, existing);
  return stagedOutcomes(await dispatchInCleanOrder(ctx, ordered, stage, span));
};

/**
 * The walked entries as git's `add` converts them: tracked paths in index order,
 * then the untracked ones in walk order, whatever safecrlf says — a clean driver
 * hears them in that order and the first refusal is the tracked path's. Buffered
 * as records (path, flags, lazy stat; about 1.4 KB per entry, +15 % CPU on a 20k
 * steady-state add -A) because git's `fill_directory` also collects the whole
 * walk before `add_files` runs.
 */
async function* walkedTrackedFirst(
  walk: WalkSource,
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
): AsyncGenerator<WalkWorkingTreeEntry> {
  const walked = new Map<IndexPathKey, WalkWorkingTreeEntry>();
  for await (const walkEntry of walk) walked.set(keyOfPath(walkEntry.path), walkEntry);
  for (const key of existing.keys()) {
    const walkEntry = walked.get(key);
    if (walkEntry === undefined) continue;
    walked.delete(key);
    yield walkEntry;
  }
  yield* walked.values();
}

/** The staged outcomes, in walk order; the earliest-walked entry's failure refuses instead. */
const stagedOutcomes = (staged: ReadonlyArray<StagedEntry>): WalkOutcome[] =>
  firstFailureOrValues(staged);

/** One walked entry once staged: its outcome, or the failure staging it met. */
type StagedEntry = Settled<WalkOutcome>;

/**
 * A clean driver hears the paths in walk order, however the reads race. Every
 * entry is settled, in walk order, before the walk's own failure surfaces.
 */
const dispatchInCleanOrder = <T extends Named, R>(
  ctx: Context,
  walk: AsyncIterable<T> | Iterable<T>,
  stage: (item: T) => Promise<R>,
  span: OrderSpan,
): Promise<ReadonlyArray<Settled<R>>> =>
  withCleanOrder(
    ctx,
    async (order) => {
      const dispatcher = { limiter: limiterFor(ctx, 'ioBound'), order, stage };
      const pending: Promise<Settled<R>>[] = [];
      try {
        for await (const walkEntry of walk) pending.push(dispatchWalkEntry(dispatcher, walkEntry));
      } catch (error) {
        await Promise.all(pending);
        throw error;
      }
      return Promise.all(pending);
    },
    span,
  );

/** Anything the clean order can enlist by its path. */
type Named = { readonly path: FilePath };

/** Stage one walked entry under the limiter, releasing its clean turn whatever the outcome. */
const dispatchWalkEntry = <T extends Named, R>(
  {
    limiter,
    order,
    stage,
  }: {
    readonly limiter: ConcurrencyLimiter;
    readonly order: CleanOrder;
    readonly stage: (item: T) => Promise<R>;
  },
  walkEntry: T,
): Promise<Settled<R>> => {
  order.enlist(walkEntry.path);
  return settleInCleanTurn(limiter, order, walkEntry.path, () => stage(walkEntry));
};

// Walk-and-filter add: applies `.gitignore` (so build artefacts stay
// out) and the user's pathspec on top. Directories are NOT pruned by
// the pathspec (a pattern like `*.ts` matches leaves, not dirs); only
// leaves are filtered by it. `.gitignore` directory pruning still
// applies via `buildRepoIgnorePredicate`.
const addByPathspec = async (
  ctx: Context,
  { matcher, positives }: CommandPathspec,
  repoIgnore: IgnorePredicate,
  scope: ConversionScope,
): Promise<AddResult> => {
  const lock = await acquireIndexLock(ctx);
  const ensurePromisorConfigValid = createPromisorGuard(ctx);
  try {
    const staged = await stageIgnoredWalk(
      ctx,
      repoIgnore,
      { matcher, positives },
      scope,
      ensurePromisorConfigValid,
    );
    const tally = tallyWalkOutcomes(staged.existing, staged.outcomes, staged.stageZeroBeside);
    const { matched } = tally;
    const removedEntries = await collectMatchedRemovals(
      ctx,
      staged.existing,
      matched,
      staged.verdicts,
    );
    const settled = await settleWalkRemovals(
      ctx,
      staged,
      matcher,
      tally.newEntries,
      removedEntries,
    );
    await commitStaged(lock, staged, settled.remaining, tally.restagedPaths);
    return sortedResult(tally, settled.removed, staged);
  } finally {
    await lock.release();
  }
};

/** git ≥ 2.0: `add <pathspec>` stages the deletion of every tracked path it names that the walk found missing from disk. */
const collectMatchedRemovals = (
  ctx: Context,
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
  matched: ReadonlyArray<FilePath>,
  verdicts: ReadonlyMap<IndexPathKey, PathspecVerdict>,
): Promise<IndexEntry[]> => {
  const named = new Map([...existing].filter(([key]) => verdicts.get(key)?.matched === true));
  return collectRemovedEntries(ctx, named, new Set(matched.map(keyOfPath)));
};

/**
 * `add --renormalize`: every stage-0 tracked file or symlink the pathspec names
 * is re-read and re-hashed in index order, with no stat-clean shortcut. Nothing
 * is added, removed or written to the working tree, and the conversion never
 * refuses. A tracked path gone from disk aborts the whole call, as git's
 * "unable to stat" does.
 */
const addRenormalized = async (
  ctx: Context,
  paths: ReadonlyArray<string>,
  scope: ConversionScope,
): Promise<AddResult> => {
  const { matcher, positives, symlinkScanTargets } = resolveCommandPathspec(ctx, paths);
  await assertNoSymlinkedLeadingPath(ctx, symlinkScanTargets);
  const lock = await acquireIndexLock(ctx);
  const ensurePromisorConfigValid = createPromisorGuard(ctx);
  try {
    const { entries } = await readIndexOrEmpty(ctx);
    const sparse = await refuseUnseenRenormalized(ctx, positives, entries);
    const staging = {
      ctx,
      scope: { ...scope, indexRules: NO_INDEX_RULES },
      ensurePromisorConfigValid,
    };
    const renormalized = await renormalizeEntries(staging, entries, matcher);
    await commitIfChanged(lock, entries.length, renormalized.entries, {
      restagedPaths: renormalized.restagedPaths,
    });
    return {
      added: [],
      modified: renormalized.modified,
      removed: [],
      eolNotices: [],
      sparse: sparse.map(({ spelling }) => spelling),
      ignored: [],
    };
  } finally {
    await lock.release();
  }
};

/** Collected in emission order: the walk's ignore stack is stateful, so it is walked once. */
const collectWalk = async (
  walk: AsyncIterable<WalkWorkingTreeEntry>,
): Promise<WalkWorkingTreeEntry[]> => {
  const walked: WalkWorkingTreeEntry[] = [];
  for await (const walkEntry of walk) walked.push(walkEntry);
  return walked;
};

/** git's `add` never refuses the whole tree, even when it holds nothing to add. */
const isNarrowerThanWholeTree = ({ entry }: PositivePathspec): boolean =>
  !namesWholeTree(entry.body as FilePath);

/** Whether some index entry reaches the positive: `--renormalize` has no walk and no shared pass. */
const indexSees = ({ entry }: PositivePathspec, entries: ReadonlyArray<IndexEntry>): boolean =>
  entries.some((indexed) => entry.compiled.test(escapedPathOf(indexed)));

/** git never stages a skip-worktree entry from the working tree: the file there is not the entry's content. */
const withoutSkipWorktree = (
  walked: ReadonlyArray<WalkWorkingTreeEntry>,
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
): WalkWorkingTreeEntry[] =>
  walked.filter(({ path }) => existing.get(keyOfPath(path))?.flags.skipWorktree !== true);

const isStageZeroSkipWorktree = (entry: IndexEntry): boolean =>
  entry.flags.skipWorktree && entry.flags.stage === 0;

const skipWorktreeOf = (existing: ReadonlyMap<IndexPathKey, IndexEntry>): IndexEntry[] =>
  [...existing.values()].filter(isStageZeroSkipWorktree);

const withoutSkipWorktreeEntries = (
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
): ReadonlyMap<IndexPathKey, IndexEntry> =>
  new Map([...existing].filter(([, entry]) => !entry.flags.skipWorktree));

/** One matcher pass over the index, shared by the refusal, the hidden pass and the removals. */
const verdictsOf = (
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
  verdictOf: (path: FilePath) => PathspecVerdict,
): ReadonlyMap<IndexPathKey, PathspecVerdict> =>
  new Map([...existing].map(([key, entry]) => [key, verdictOf(escapedPathOf(entry))]));

const indexVerdicts = (
  matcher: ResolvedPathspec['matcher'],
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
): ReadonlyMap<IndexPathKey, PathspecVerdict> =>
  verdictsOf(existing, (path) => pathspecVerdict(matcher, path));

/** Whether the pathspec's verbatim body, as typed, names something on disk. */
const namesOnDisk = async (ctx: Context, { entry, probesDisk }: PositivePathspec) =>
  probesDisk && (await lstatOrBeneathFile(ctx, entry.body as FilePath)) !== undefined;

/**
 * `add --renormalize` runs no directory fill, so a pathspec is seen through the
 * index alone; git still accepts one whose verbatim body names a file on disk.
 * A skip-worktree entry does not count as seen: git reports the pathspec that
 * reaches only such entries, before it asks the disk.
 */
const refuseUnseenRenormalized = async (
  ctx: Context,
  positives: ReadonlyArray<PositivePathspec>,
  entries: ReadonlyArray<IndexEntry>,
): Promise<ReadonlyArray<PositivePathspec>> => {
  const notSkipped = entries.filter((entry) => !entry.flags.skipWorktree);
  const unseen = unmatchedPositives(positives, (positive) => indexSees(positive, notSkipped));
  const skipped = entries.filter(isStageZeroSkipWorktree);
  const sparse = unseen.filter((positive) => reachesSkipWorktree(positive, skipped));
  for (const positive of unseen.filter((candidate) => !sparse.includes(candidate))) {
    if (!(await namesOnDisk(ctx, positive))) throw pathspecNoMatch(positive.spelling);
  }
  return sparse;
};

/** Every pathspec, in argument order, that neither the index pass nor the walk reaches. */
const unseenWalked = (
  positives: ReadonlyArray<PositivePathspec>,
  seenByIndexPass: (positive: PositivePathspec) => boolean,
  walked: ReadonlyArray<WalkWorkingTreeEntry>,
): ReadonlyArray<PositivePathspec> =>
  unmatchedPositives(
    positives,
    (positive) =>
      seenByIndexPass(positive) || walked.some(({ path }) => positive.entry.compiled.test(path)),
  );

/**
 * The first unseen pathspec, in argument order, git refuses. A wildcard whose
 * verbatim body names a file on disk is accepted, as git's `file_exists` escape
 * does; the whole tree is never refused.
 */
const refuseUnseenWalked = async (
  ctx: Context,
  unseen: ReadonlyArray<PositivePathspec>,
): Promise<void> => {
  for (const positive of unseen.filter(isNarrowerThanWholeTree)) {
    if (!(await namesDiskPath(ctx, positive))) {
      throw pathspecNoMatch(positive.spelling);
    }
  }
};

/**
 * git's `file_exists` escape: an unseen pathspec whose verbatim body names
 * something on disk is not refused (an empty directory, a wildcard spelled like
 * an ignored file, a literal an ignore rule hides).
 */
const namesDiskPath = async (
  ctx: Context,
  { entry, probesDisk }: PositivePathspec,
): Promise<boolean> => {
  if (!probesDisk) return false;
  const body = entry.body as FilePath;
  const stat = await lstatOrBeneathFile(ctx, body);
  return stat !== undefined && (!namesDirectoryOnly(body) || stat.isDirectory);
};

/** Whether `add --renormalize` re-cleans this entry: a merged, checked-out file or symlink in the pathspec. */
const isRecleaned = (entry: IndexEntry, matcher: ResolvedPathspec['matcher']): boolean =>
  entry.flags.stage === 0 &&
  !entry.flags.skipWorktree &&
  RECLEANED_MODES.has(entry.mode) &&
  matchesIndexPath(matcher, entry);

const RECLEANED_MODES: ReadonlySet<FileMode> = new Set([
  FILE_MODE.REGULAR,
  FILE_MODE.EXECUTABLE,
  FILE_MODE.SYMLINK,
]);

const renormalizeEntries = async (
  staging: Omit<Staging, 'entries' | 'indexMtime' | 'stageZeroBeside'>,
  entries: ReadonlyArray<IndexEntry>,
  matcher: ResolvedPathspec['matcher'],
): Promise<{
  readonly entries: ReadonlyArray<IndexEntry>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly restagedPaths: ReadonlyArray<IndexPath>;
}> => {
  const next: IndexEntry[] = [];
  const modified: FilePath[] = [];
  const restagedPaths: IndexPath[] = [];
  for (const previous of entries) {
    if (!isRecleaned(previous, matcher)) {
      next.push(previous);
      continue;
    }
    const entry = await renormalizeOne(staging, previous);
    next.push(entry);
    // renormalizeOne rebuilds every re-cleaned entry, so each one is restaged.
    restagedPaths.push(previous);
    if (entry.id !== previous.id || entry.mode !== previous.mode) modified.push(previous.path);
  }
  return { entries: next, modified, restagedPaths };
};

const renormalizeOne = async (
  {
    ctx,
    scope,
    ensurePromisorConfigValid,
  }: Omit<Staging, 'entries' | 'indexMtime' | 'stageZeroBeside'>,
  previous: IndexEntry,
): Promise<IndexEntry> => {
  const { path } = previous;
  await ensurePromisorConfigValid();
  if (isLossy(previous)) throw pathspecNoMatch(path);
  const fresh = await lstatOrMissing(ctx, path);
  if (fresh === undefined) throw pathspecNoMatch(path);
  if (fresh.size > MAX_WORKING_TREE_BLOB_BYTES) {
    throw workingTreeFileTooLarge(path, fresh.size, MAX_WORKING_TREE_BLOB_BYTES);
  }
  const mode: FileMode = deriveWorkingMode(fresh);
  indexPathRulesOf(ctx).validateIndexPath(path, NO_PARSER_OFFSET, mode);
  const { id } = await writeCleanedBlob(ctx, path, fresh, scope, previous, 'renormalize');
  return indexEntryFromStat(fresh, mode, id, path);
};

/**
 * git's `add` also runs an index-side pass that stages every matching tracked
 * entry whatever the ignore rules say, so a tracked file the pruned walk never
 * reached is still staged — a conflicted one resolved from the file on disk.
 * What the removal pass owns (gone, replaced by a directory) and what the pass
 * never stages (skip-worktree, lossy, gitlink) is left out.
 */
const hiddenTracked = async (
  ctx: Context,
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
  matcher: ResolvedPathspec['matcher'],
  walked: ReadonlyArray<WalkWorkingTreeEntry>,
  unmergedStages: ReadonlyMap<IndexPathKey, ReadonlyArray<IndexEntry>>,
  verdicts: ReadonlyMap<IndexPathKey, PathspecVerdict>,
): Promise<WalkWorkingTreeEntry[]> => {
  const walkedKeys = new Set(walked.map(({ path }) => keyOfPath(path)));
  const candidates = [...existing].filter(
    ([key, entry]) =>
      !walkedKeys.has(key) &&
      isHiddenCandidate(entry, matcher, unmergedStages.get(key), verdicts.get(key)),
  );
  const scanner = createLeadingPathScanner(ctx);
  const hidden = await boundedMapFor(ctx, 'ioBound', candidates, ([, entry]) =>
    hiddenWalkEntryOf(ctx, scanner, entry),
  );
  return hidden.filter((walkEntry) => walkEntry !== undefined);
};

const isHiddenCandidate = (
  entry: IndexEntry,
  matcher: ResolvedPathspec['matcher'],
  stages: ReadonlyArray<IndexEntry> | undefined,
  verdict: PathspecVerdict | undefined,
): boolean =>
  !entry.flags.skipWorktree &&
  !isLossy(entry) &&
  entry.mode !== FILE_MODE.GITLINK &&
  pathspecSelectsTracked(entry, matcher, stages, verdict);

/** A merged entry is selected on the index pass's verdict; an unmerged path under git's conflict rule. */
const pathspecSelectsTracked = (
  entry: IndexEntry,
  matcher: ResolvedPathspec['matcher'],
  stages: ReadonlyArray<IndexEntry> | undefined,
  verdict: PathspecVerdict | undefined,
): boolean =>
  stages === undefined
    ? verdict?.matched === true
    : matchesUnmergedIndexPath(matcher, entry, stages.length);

/** The walk entry the walker would have yielded, from the file as it lies on disk. */
const hiddenWalkEntryOf = async (
  ctx: Context,
  scanner: LeadingPathScanner,
  { path }: IndexEntry,
): Promise<WalkWorkingTreeEntry | undefined> => {
  if (await scanner.hasSymlinkedLeadingPath(path)) return undefined;
  const stat = await lstatOrBeneathFile(ctx, path);
  if (stat === undefined || (stat.isDirectory && !stat.isSymbolicLink)) return undefined;
  return {
    path,
    isFile: stat.isFile,
    isDirectory: false,
    isSymbolicLink: stat.isSymbolicLink,
    stat: () => Promise.resolve(stat),
  };
};

/** Read the index, then stage every walked entry `ignore` keeps. */
const stageIgnoredWalk = async (
  ctx: Context,
  repoIgnore: IgnorePredicate,
  { matcher, positives }: Pick<CommandPathspec, 'matcher' | 'positives'>,
  scope: ConversionScope,
  ensurePromisorConfigValid: PromisorGuard,
): Promise<{
  readonly existing: ReadonlyMap<IndexPathKey, IndexEntry>;
  readonly unmergedStages: ReadonlyMap<IndexPathKey, ReadonlyArray<IndexEntry>>;
  readonly stageZeroBeside: ReadonlyMap<IndexPathKey, IndexEntry>;
  readonly sorted: ReadonlyArray<IndexEntry>;
  readonly outcomes: ReadonlyArray<WalkOutcome>;
  readonly verdicts: ReadonlyMap<IndexPathKey, PathspecVerdict>;
  readonly sparse: ReadonlyArray<string>;
  readonly ignored: ReadonlyArray<FilePath>;
}> => {
  const {
    entries: existing,
    unmergedStages,
    stageZeroBeside,
    sorted,
    indexMtime,
    indexRules,
  } = await readExistingEntries(ctx);
  const tracker = trackPositives(matcher, positives);
  const verdicts = verdictsOf(withoutSkipWorktreeEntries(existing), (path) =>
    tracker.observe(path),
  );
  const collector = collectIgnored(repoIgnore, existing, positives);
  const ignore = withPathspec(collector.ignore, matcher, unmergedStages);
  const walked = withoutSkipWorktree(await collectWalk(walkWorkingTree(ctx, { ignore })), existing);
  const unseen = unseenWalked(positives, (positive) => tracker.seen(positive), walked);
  const skipped = skipWorktreeOf(existing);
  const sparse = unseen.filter((positive) => reachesSkipWorktree(positive, skipped));
  await refuseUnseenWalked(
    ctx,
    unseen.filter((positive) => !sparse.includes(positive)),
  );
  const hidden = await hiddenTracked(ctx, existing, matcher, walked, unmergedStages, verdicts);
  const outcomes = await stageWalkedEntries(
    ctx,
    [...walked, ...hidden],
    existing,
    new Set<IndexPathKey>(),
    { ...scope, indexRules },
    indexMtime,
    ensurePromisorConfigValid,
  );
  return {
    existing,
    unmergedStages,
    stageZeroBeside,
    sorted,
    outcomes,
    verdicts,
    sparse: sparse.map(({ spelling }) => spelling),
    ignored: collector.ignored(),
  };
};

/** The no-wildcard prefix of a pathspec body: the part git reads as a path before any pattern. */
const literalPrefixOf = ({ entry }: PositivePathspec): string => {
  const index = globSpecialIndex(entry.body);
  return index === -1 ? entry.body : entry.body.slice(0, index);
};

/**
 * Wraps the repository's ignore verdicts to remember the untracked paths a
 * positive pathspec reaches that a rule hides, as git reports them. The walk
 * prunes at the shallowest ignored directory, so that directory is what is
 * recorded; a tracked path is never reported.
 */
const collectIgnored = (
  repoIgnore: IgnorePredicate,
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
  positives: ReadonlyArray<PositivePathspec>,
): { readonly ignore: IgnorePredicate; readonly ignored: () => FilePath[] } => {
  const prefixes = positives.map(literalPrefixOf);
  const reached = (path: FilePath): boolean =>
    prefixes.some((prefix) => prefix === path || prefix.startsWith(path + SEPARATOR));
  const recorded = new Set<FilePath>();
  const ignore: IgnorePredicate = async (path, isDirectory) => {
    const verdict = await repoIgnore(path, isDirectory);
    if (verdict && !existing.has(keyOfPath(path)) && reached(path)) recorded.add(path);
    return verdict;
  };
  return { ignore, ignored: () => [...recorded].sort() };
};

/**
 * `.gitignore` prunes directories and leaves; the pathspec filters leaves only,
 * and keeps a multi-stage unmerged leaf that only an exact exclusion removes.
 */
const withPathspec =
  (
    ignore: IgnorePredicate,
    matcher: ResolvedPathspec['matcher'],
    unmergedStages: ReadonlyMap<IndexPathKey, ReadonlyArray<IndexEntry>>,
  ): IgnorePredicate =>
  async (path, isDirectory) => {
    if (await ignore(path, isDirectory)) return true;
    if (isDirectory || matchesPathspec(matcher, path)) return false;
    const stages = unmergedStages.get(keyOfPath(path));
    return stages === undefined || !matchesUnmergedPath(matcher, path, stages.length);
  };

/** The safecrlf notices of the walked outcomes: git warns for the tracked paths first, in index order. */
const noticesOf = (outcomes: ReadonlyArray<WalkOutcome>): EolNotice[] => {
  const noticed = outcomes.filter(hasNotice);
  const tracked = noticed.filter(({ kind }) => kind !== 'added').sort(byPath);
  const untracked = noticed.filter(({ kind }) => kind === 'added');
  return [...tracked, ...untracked].map(({ notice }) => notice);
};

const hasNotice = (outcome: WalkOutcome): outcome is WalkOutcome & { readonly notice: EolNotice } =>
  outcome.notice !== undefined;

const byPath = (a: WalkOutcome, b: WalkOutcome): number => comparePaths(a.path, b.path);

const restagedPathsOf = (
  outcomes: ReadonlyArray<WalkOutcome>,
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
): IndexPath[] =>
  outcomes
    .filter(({ path, entry }) => wasRestaged(existing.get(keyOfPath(path)), entry))
    .map(({ entry }) => entry);

/** The index once every walked outcome is staged, and which paths were matched, added, modified. */
const tallyWalkOutcomes = (
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
  outcomes: ReadonlyArray<WalkOutcome>,
  stageZeroBeside: ReadonlyMap<IndexPathKey, IndexEntry>,
): {
  readonly newEntries: Map<IndexPathKey, IndexEntry>;
  readonly matched: ReadonlyArray<FilePath>;
  readonly added: ReadonlyArray<FilePath>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly eolNotices: ReadonlyArray<EolNotice>;
  readonly restagedPaths: ReadonlyArray<IndexPath>;
} => {
  const newEntries = new Map<IndexPathKey, IndexEntry>(existing);
  const matched: FilePath[] = [];
  const added: FilePath[] = [];
  const modified: FilePath[] = [];
  for (const outcome of outcomes) {
    matched.push(outcome.path);
    newEntries.set(keyOfPath(outcome.path), outcome.entry);
    if (outcome.kind === 'added') added.push(outcome.path);
    else if (outcome.kind === 'modified' || stageZeroBeside.has(keyOfPath(outcome.path))) {
      modified.push(outcome.path);
    }
  }
  const restagedPaths = restagedPathsOf(outcomes, existing);
  return { newEntries, matched, added, modified, eolNotices: noticesOf(outcomes), restagedPaths };
};

/** The settled removals of a walk, given what it staged over the index it started from. */
const settleWalkRemovals = (
  ctx: Context,
  {
    sorted,
    existing,
    outcomes,
  }: {
    readonly sorted: ReadonlyArray<IndexEntry>;
    readonly existing: ReadonlyMap<IndexPathKey, IndexEntry>;
    readonly outcomes: ReadonlyArray<WalkOutcome>;
  },
  matcher: ResolvedPathspec['matcher'],
  newEntries: Map<IndexPathKey, IndexEntry>,
  removedEntries: ReadonlyArray<IndexEntry>,
) =>
  settleRemovals(
    ctx,
    { sorted, inserted: insertedBy(outcomes, existing) },
    matcher,
    newEntries,
    removedEntries,
  );

/** The walk's report, each list in path order. */
const sortedResult = (
  {
    added,
    modified,
    eolNotices,
  }: Pick<ReturnType<typeof tallyWalkOutcomes>, 'added' | 'modified' | 'eolNotices'>,
  removed: ReadonlyArray<FilePath>,
  { sparse, ignored }: Pick<AddResult, 'sparse' | 'ignored'>,
): AddResult => ({
  added: [...added].sort(),
  modified: [...modified].sort(),
  removed: [...removed].sort(),
  eolNotices,
  sparse,
  ignored,
});

/**
 * Bulk-mode `add --all`. Exposed for testability (custom `ignore` predicate).
 * Production callers go through `add({ all: true })`.
 */
export const addAll = async (
  ctx: Context,
  ignoreOverride?: IgnorePredicate,
  givenScope?: ConversionScope,
): Promise<AddResult> => {
  const scope = givenScope ?? (await buildConversionScope(ctx));
  const ignore = ignoreOverride ?? (await buildRepoIgnorePredicate(ctx));
  const lock = await acquireIndexLock(ctx);
  const ensurePromisorConfigValid = createPromisorGuard(ctx);
  try {
    const state = await readExistingEntries(ctx);
    const { entries: existing, sorted } = state;
    const seen = new Set<IndexPathKey>();
    // Walk-time pruning: the walker calls `ignore` on every directory
    // (skipping ignored subtrees) and every leaf. By the time we see a
    // leaf here, the ignore filter has already passed.
    const walkedEntries = withoutSkipWorktree(
      await collectWalk(walkWorkingTree(ctx, { ignore })),
      existing,
    );
    const hidden = await hiddenTracked(
      ctx,
      existing,
      WHOLE_TREE_MATCHER,
      walkedEntries,
      state.unmergedStages,
      indexVerdicts(WHOLE_TREE_MATCHER, existing),
    );
    const outcomes = await stageWalkedEntries(
      ctx,
      [...walkedEntries, ...hidden],
      existing,
      seen,
      { ...scope, indexRules: state.indexRules },
      state.indexMtime,
      ensurePromisorConfigValid,
    );
    const tally = tallyWalkOutcomes(existing, outcomes, state.stageZeroBeside);
    const removedEntries = await collectRemovedEntries(ctx, existing, seen);
    const walked = { sorted, existing, outcomes };
    const settled = await settleWalkRemovals(
      ctx,
      walked,
      WHOLE_TREE_MATCHER,
      tally.newEntries,
      removedEntries,
    );
    await commitStaged(lock, state, settled.remaining, tally.restagedPaths);
    return sortedResult(tally, settled.removed, { sparse: [], ignored: [] });
  } finally {
    await lock.release();
  }
};

interface WalkOutcome {
  readonly kind: 'added' | 'modified' | 'unchanged';
  readonly path: FilePath;
  readonly entry: IndexEntry;
  readonly notice?: EolNotice;
}

/**
 * A path under a leading component that is no longer a directory, or is a symlink
 * (git's `has_symlink_leading_path`), is as gone as a missing one; so is a tracked file
 * or symlink a directory replaced. A submodule checkout is a directory by design.
 */
const presentOnDisk = async (
  ctx: Context,
  scanner: LeadingPathScanner,
  entry: IndexEntry,
): Promise<boolean> => {
  try {
    if (await scanner.hasSymlinkedLeadingPath(entry.path)) return false;
    const stat = await lstatOrMissing(ctx, entry.path);
    if (stat === undefined) return false;
    return !stat.isDirectory || entry.mode === FILE_MODE.GITLINK;
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === NOT_A_DIRECTORY) return false;
    throw err;
  }
};

/**
 * The post-walk removal pass: every prior index entry the walk did not see is a
 * candidate, removed when it is really gone from disk. Ignore rules never
 * untrack, and never shield a missing tracked path from `add`, so presence on
 * disk (not the walk's ignore filter) decides. Two cases need no stat:
 *
 * - **skip-worktree** — a sparse-excluded entry is legitimately absent;
 *   staging its removal would silently un-sparse it into a deletion.
 * - **lossy path** — its raw bytes have no faithful working-tree name to stat.
 */
const collectRemovedEntries = async (
  ctx: Context,
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
  seen: ReadonlySet<IndexPathKey>,
): Promise<IndexEntry[]> => {
  const removed: IndexEntry[] = [];
  const scanner = createLeadingPathScanner(ctx);
  for (const [key, entry] of existing) {
    if (seen.has(key)) continue;
    if (entry.flags.skipWorktree) continue;
    if (!isLossy(entry) && (await presentOnDisk(ctx, scanner, entry))) continue;
    removed.push(entry);
  }
  return removed;
};

const processWalkEntry = async (
  ctx: Context,
  walkEntry: WalkWorkingTreeEntry,
  existing: ReadonlyMap<IndexPathKey, IndexEntry>,
  seen: Set<IndexPathKey>,
  scope: StagingScope,
  indexMtime: IndexMtime | undefined,
  ensurePromisorConfigValid: PromisorGuard,
): Promise<WalkOutcome> => {
  const { path, isFile, isDirectory, isSymbolicLink } = walkEntry;
  // Mark presence BEFORE any further filter so the post-walk
  // "missing from disk → removed" pass is exact. Ignore filtering
  // already happened at walk-time in; this function only sees
  // leaves the walker chose to yield.
  seen.add(keyOfPath(path));
  // The walker's kind bits come free from readdir (no `lstat`); passing them
  // straight to stageFromStat's TOCTOU check retires the walk-time `stat()`
  // this function used to pay just to re-derive the same three booleans.
  // stageFromStat's own re-lstat (still authoritative for the size cap) is
  // the only lstat left per file.
  const { entry, notice } = await stageFromStat(
    ctx,
    path,
    { isFile, isDirectory, isSymbolicLink },
    scope,
    existing.get(keyOfPath(path)),
    indexMtime,
    ensurePromisorConfigValid,
  );
  const previous = existing.get(keyOfPath(path));
  const withNotice = notice === undefined ? {} : { notice };
  if (previous === undefined) return { kind: 'added', path, entry, ...withNotice };
  if (isModified(previous, entry)) {
    return { kind: 'modified', path, entry, ...withNotice };
  }
  return { kind: 'unchanged', path, entry, ...withNotice };
};

interface ExistingIndexState {
  /** One entry per path: its stage-0 entry, else the last stage of an unmerged path. */
  readonly entries: ReadonlyMap<IndexPathKey, IndexEntry>;
  /** Every stage of every unmerged path, in index order. */
  readonly unmergedStages: ReadonlyMap<IndexPathKey, ReadonlyArray<IndexEntry>>;
  /** A stage-0 entry the index holds beside the conflict stages of the same path. */
  readonly stageZeroBeside: ReadonlyMap<IndexPathKey, IndexEntry>;
  /** The entries as read — one per stage, so its length is what the index holds. */
  readonly sorted: ReadonlyArray<IndexEntry>;
  readonly indexMtime: IndexMtime | undefined;
  readonly indexRules: ReadonlyMap<FilePath, IndexEntry>;
}

const readExistingEntries = async (ctx: Context): Promise<ExistingIndexState> => {
  const { entries, indexMtime } = await readIndexOrEmpty(ctx);
  const out = new Map<IndexPathKey, IndexEntry>();
  const unmerged: IndexEntry[] = [];
  const unmergedStages = new Map<IndexPathKey, IndexEntry[]>();
  const stageZero = new Map<IndexPathKey, IndexEntry>();
  for (const entry of entries) {
    const key = indexPathKey(entry);
    if (entry.flags.stage === 0 || out.get(key)?.flags.stage !== 0) out.set(key, entry);
    if (entry.flags.stage === 0) {
      stageZero.set(key, entry);
      continue;
    }
    unmerged.push(entry);
    appendTo(unmergedStages, key, entry);
  }
  const indexRules = new Map(indexRuleEntries(unmerged).map((entry) => [entry.path, entry]));
  const stageZeroBeside = new Map([...stageZero].filter(([key]) => unmergedStages.has(key)));
  return { entries: out, unmergedStages, stageZeroBeside, sorted: entries, indexMtime, indexRules };
};

/** An unmerged path stays so when the add left it unstaged: it is neither removed nor staged. */
const stillUnmerged = (
  entries: ReadonlyMap<IndexPathKey, IndexEntry>,
  key: IndexPathKey,
): boolean => (entries.get(key)?.flags.stage ?? 0) !== 0;

/** A stage-0 entry beside conflict stages is re-staged in place; the stages go only with the path. */
const keepsStages = (
  entries: ReadonlyMap<IndexPathKey, IndexEntry>,
  key: IndexPathKey,
  stageZeroBeside: ReadonlyMap<IndexPathKey, IndexEntry>,
): boolean => (stageZeroBeside.has(key) ? entries.has(key) : stillUnmerged(entries, key));

/**
 * The entries to write: what the add staged, plus every stage of the unmerged paths it left
 * alone — and of those whose stage-0 entry it re-staged.
 */
const withEveryStage = (
  entries: ReadonlyMap<IndexPathKey, IndexEntry>,
  unmergedStages: ReadonlyMap<IndexPathKey, ReadonlyArray<IndexEntry>>,
  stageZeroBeside: ReadonlyMap<IndexPathKey, IndexEntry>,
): IndexEntry[] => {
  if (unmergedStages.size === 0) return Array.from(entries.values());
  const out = Array.from(entries.values()).filter((entry) => entry.flags.stage === 0);
  for (const [key, stages] of unmergedStages) {
    if (!keepsStages(entries, key, stageZeroBeside)) continue;
    out.push(...stages);
  }
  return out;
};

/** The unmerged paths the add resolved, by staging them or removing them. */
const resolvedRecords = (
  unmergedStages: ReadonlyMap<IndexPathKey, ReadonlyArray<IndexEntry>>,
  working: ReadonlyMap<IndexPathKey, IndexEntry>,
  stageZeroBeside: ReadonlyMap<IndexPathKey, IndexEntry>,
): ReadonlyArray<ResolveUndoRecord> =>
  Array.from(unmergedStages)
    .filter(([key]) => !keepsStages(working, key, stageZeroBeside))
    .map(([, stages]) => resolveUndoRecordOf(stages));

const resolutionOptions = (
  restagedPaths: ReadonlyArray<IndexPath>,
  working: ReadonlyMap<IndexPathKey, IndexEntry>,
  unmergedStages: ReadonlyMap<IndexPathKey, ReadonlyArray<IndexEntry>>,
  stageZeroBeside: ReadonlyMap<IndexPathKey, IndexEntry>,
): CommitOptions => ({
  restagedPaths,
  resolveUndo: resolvedRecords(unmergedStages, working, stageZeroBeside),
});

const readIndexOrEmpty = async (
  ctx: Context,
): Promise<{
  readonly entries: ReadonlyArray<IndexEntry>;
  readonly indexMtime?: IndexMtime | undefined;
}> => {
  try {
    return await readIndex(ctx);
  } catch (err) {
    // Missing-or-corrupt index = "no entries"; everything else propagates so
    // I/O failures and permission errors are not silently absorbed.
    if (err instanceof TsgitError && INDEX_MISSING_CODES.has(err.data.code)) {
      return { entries: [], indexMtime: undefined };
    }
    throw err;
  }
};

/**
 * The three kind bits `stageFromStat`'s TOCTOU check needs — satisfied
 * structurally by a full `FileStat`
 * and a `WalkWorkingTreeEntry` (`processWalkEntry`'s walk, readdir-sourced).
 */
type EntryKind = Pick<FileStat, 'isFile' | 'isDirectory' | 'isSymbolicLink'>;

/** The index entry a path staged to, with the safecrlf notice its conversion raised. */
interface StagedBlob {
  readonly entry: IndexEntry;
  readonly notice?: EolNotice;
}

const stageFromStat = async (
  ctx: Context,
  path: FilePath,
  kind: EntryKind,
  scope: StagingScope,
  previous: IndexEntry | undefined,
  indexMtime: IndexMtime | undefined,
  ensurePromisorConfigValid: PromisorGuard,
): Promise<StagedBlob> => {
  // Promisor-remote guard (see createPromisorGuard) — lazy-once per add()
  // invocation, first paid when the write path actually engages.
  await ensurePromisorConfigValid();
  const fresh = await freshStatOfSameKind(ctx, path, kind);
  return stagePromisorChecked(ctx, path, fresh, scope, previous, indexMtime);
};

/** Stage a path whose stat was taken just now, by this call's own lstat. */
const stageFromFreshStat = async (
  ctx: Context,
  path: FilePath,
  fresh: FileStat,
  scope: StagingScope,
  previous: IndexEntry | undefined,
  indexMtime: IndexMtime | undefined,
  ensurePromisorConfigValid: PromisorGuard,
): Promise<StagedBlob> => {
  await ensurePromisorConfigValid();
  return stagePromisorChecked(ctx, path, fresh, scope, previous, indexMtime);
};

const stagePromisorChecked = async (
  ctx: Context,
  path: FilePath,
  fresh: FileStat,
  scope: StagingScope,
  previous: IndexEntry | undefined,
  indexMtime: IndexMtime | undefined,
): Promise<StagedBlob> => {
  if (previous !== undefined && restagesAsIs(previous, fresh, indexMtime))
    return { entry: previous };
  // Authoritative size cap — uses the fresh stat so a grow-between-walk-and-
  // stage race cannot smuggle an oversize blob past the pre-filter.
  if (fresh.size > MAX_WORKING_TREE_BLOB_BYTES) {
    throw workingTreeFileTooLarge(path, fresh.size, MAX_WORKING_TREE_BLOB_BYTES);
  }
  const mode: FileMode = deriveWorkingMode(fresh);
  indexPathRulesOf(ctx).validateIndexPath(path, NO_PARSER_OFFSET, mode);
  const { id, notice } = await writeCleanedBlob(ctx, path, fresh, scope, previous, 'write');
  const entry = indexEntryFromStat(fresh, mode, id, path);
  return notice === undefined ? { entry } : { entry, notice };
};

/**
 * Re-lstat under the index lock to close the TOCTOU window: an attacker
 * swapping the inode (regular ↔ symlink, file ↔ directory) between `kind`
 * being observed and our read would otherwise re-route the read through
 * `ctx.fs.read` (which follows symlinks), break the mode classification, or
 * trip an opaque adapter error. Abort the whole add on any type flip. `kind`
 * comes either from a real lstat or from the walker's readdir
 * dirent bits (`processWalkEntry`, spending no lstat to get here) — for the
 * walked case the reference point is readdir instead of a walk-time lstat, a
 * marginally wider window of the SAME TOCTOU class; this fresh lstat remains
 * the sole authority either way.
 */
const freshStatOfSameKind = async (
  ctx: Context,
  path: FilePath,
  kind: EntryKind,
): Promise<FileStat> => {
  const fresh = await ctx.fs.lstat(joinPath(requireWorkTree(ctx, 'add'), path));
  if (
    fresh.isSymbolicLink !== kind.isSymbolicLink ||
    fresh.isDirectory !== kind.isDirectory ||
    fresh.isFile !== kind.isFile
  ) {
    throw operationAborted();
  }
  return fresh;
};

/**
 * `ie_match_stat` short-circuit, as git's add takes it: a stat-clean path
 * (against the racy-guarded index mtime) whose mode is unchanged is re-staged
 * as-is — no read, no clean filter, no hash. This is also what keeps the
 * filter-section validation surface faithful: git only validates
 * `[filter *].required` when it actually converts, which a stat-clean path
 * never does.
 */
const restagesAsIs = (
  previous: IndexEntry,
  fresh: FileStat,
  indexMtime: IndexMtime | undefined,
): boolean =>
  indexMtime !== undefined &&
  // Stryker disable next-line ConditionalExpression: equivalent — deriveWorkingMode never returns FILE_MODE.GITLINK, so the next conjunct (mode match) is unconditionally false whenever previous.mode is GITLINK; forcing this operand's real-false case to `true` can never flip the chain's overall value.
  previous.mode !== FILE_MODE.GITLINK &&
  deriveWorkingMode(fresh) === previous.mode &&
  isEntryStatClean(previous, fresh, indexMtime);

/**
 * The cleaned blob's id, written to the store. Reached only once the staging
 * boundary passed: `.git`-alias (and NTFS/HFS-obscured variants) and a
 * symlinked `.gitmodules` component are refused before either read arm runs —
 * the walker (`validateWalkedEntryPath`) deliberately lets these through so
 * `status` can still list them, exactly as git's own directory walk does.
 * `validateIndexPath` mirrors git's `verify_path`, so both the regular-file and
 * symlink arms of `readContent` refuse identically, and the whole add aborts
 * before the index commit (git's add -A is all-or-nothing). git's `index_fd`
 * reads the threshold before hashing a regular file it does not stream
 * through a required filter.
 */
const writeCleanedBlob = async (
  ctx: Context,
  path: FilePath,
  fresh: FileStat,
  { provider, settings, indexRules }: StagingScope,
  previous: IndexEntry | undefined,
  route: ConversionRoute,
): Promise<{ readonly id: ObjectId; readonly notice?: EolNotice }> => {
  // Symlinks are never converted (git stores the link target verbatim).
  const conversion = fresh.isSymbolicLink
    ? IDENTITY_CONVERSION
    : await resolveConversion(ctx, provider, path, settings, { eagerSectionValidation: true });
  if (!fresh.isSymbolicLink && !streamsThroughFilter(conversion.filter)) {
    await assertBigFileThresholdValid(ctx);
  }
  const raw = await readContent(ctx, path, fresh);
  await admitWrite(ctx, path);
  const indexBlob = indexRuleBlob(indexRules, previous);
  const { bytes, notice } = await convertToGit(ctx, {
    path,
    bytes: raw,
    conversion,
    route,
    settings,
    ...(indexBlob !== undefined && { indexBlob }),
  });
  const id = (await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: bytes,
  })) as ObjectId;
  return notice === undefined ? { id } : { id, notice };
};

/**
 * git reads the index-CRLF rule from stage 0, else stage 2; a gitlink has no
 * blob to read. `previous` is the path's stage-0 entry when it has one, else
 * its last stage, so only a path with no stage-0 entry consults the stage-2
 * entries read with the index.
 */
const indexRuleBlob = (
  indexRules: StagingScope['indexRules'],
  previous: IndexEntry | undefined,
): ObjectId | undefined => {
  if (previous === undefined) return undefined;
  const ruled = previous.flags.stage === 0 ? previous : indexRules.get(previous.path);
  return ruled === undefined || ruled.mode === FILE_MODE.GITLINK ? undefined : ruled.id;
};

const readContent = async (
  ctx: Context,
  path: FilePath,
  stat: Awaited<ReturnType<Context['fs']['lstat']>>,
): Promise<Uint8Array> => {
  const workDir = requireWorkTree(ctx, 'add');
  if (stat.isSymbolicLink) {
    const bytes = new TextEncoder().encode(await ctx.fs.readlink(joinPath(workDir, path)));
    // Defence against an FS adapter that mis-reports symlink target length:
    // lstat reports the target byte length as `stat.size`, but a hostile
    // adapter could return an arbitrarily long string from readlink.
    if (bytes.byteLength > MAX_WORKING_TREE_BLOB_BYTES) {
      throw workingTreeFileTooLarge(path, bytes.byteLength, MAX_WORKING_TREE_BLOB_BYTES);
    }
    return bytes;
  }
  // `path` is already validated at the staging boundary (`stageFromStat`,
  // above `readContent`'s only call site) via `validateIndexPath` — the
  // git-faithful `verify_path` rule set. Reading straight off `ctx.fs`
  // (rather than through `internal/working-tree.ts`'s `readFile`, which
  // layers on the wider `validateWorkingTreePath` — leading-colon and
  // `.git`-alias rejections meant for user-typed pathspec text) keeps
  // walked content from being rejected by a pathspec-only rule.
  return readProbedBytes(ctx, joinPath(workDir, path), stat.size);
};

/**
 * git's `index_core` reads exactly the lstat'd size: a grown file is staged truncated to it,
 * a shrunk one is a short read that aborts the add.
 */
const readProbedBytes = async (
  ctx: Context,
  fullPath: string,
  probedSize: number,
): Promise<Uint8Array> => {
  const bytes = await ctx.fs.readSlice(fullPath, 0, probedSize);
  if (bytes.byteLength < probedSize) throw operationAborted();
  return bytes;
};
