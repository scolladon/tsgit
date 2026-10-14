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
import type { IndexEntry } from '../../domain/git-index/index.js';
import { NO_PARSER_OFFSET, validateIndexPath } from '../../domain/git-index/path-validator.js';
import { emptyPathspec, pathspecNoMatch } from '../../domain/index.js';
import {
  deriveWorkingMode,
  FILE_MODE,
  type FileMode,
  type ObjectId,
} from '../../domain/objects/index.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { matchesPathspec } from '../../domain/pathspec/index.js';
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
import { limiterFor } from '../primitives/internal/concurrency.js';
import type { ConcurrencyLimiter } from '../primitives/internal/concurrency-limiter.js';
import { type ConversionRoute, convertToGit } from '../primitives/internal/convert-blob.js';
import { withFilterProcessPool } from '../primitives/internal/filter-process-pool.js';
import { indexEntryFromStat } from '../primitives/internal/index-entry-from-stat.js';
import type { IndexLock } from '../primitives/internal/index-lock.js';
import { indexRuleEntries } from '../primitives/internal/index-rule-entries.js';
import { type IndexMtime, isEntryStatClean } from '../primitives/internal/is-entry-stat-clean.js';
import { joinPath } from '../primitives/internal/join-working-tree-path.js';
import {
  type AttributeProvider,
  buildCheckinAttributeProvider,
} from '../primitives/internal/read-gitattributes.js';
import { assertBigFileThresholdValid } from '../primitives/internal/repo-settings-gate.js';
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
  assertNoPendingOperation,
  assertOperationalRepository,
  requireWorkTree,
} from './internal/repo-state.js';
import {
  assertNoSymlinkedLeadingPath,
  enforceLiteralMustMatch,
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
}

/**
 * Stage paths in the index. Two modes:
 *
 * - **Literal-path mode** (`paths` non-empty, `all` falsy): every path is
 *  validated, read, hashed, and staged. Missing paths reject the whole call.
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
      : addAll(ctx, undefined, scope);
  }
  if (paths.length === 0) throw emptyPathspec();
  if (opts.renormalize === true) return addRenormalized(ctx, paths, scope);
  return dispatchPathspec(ctx, paths, scope);
};

// Branch on the resolved pathspec: pure literals that each name an
// existing file route through the byte-identical per-path stage flow
// from; anything else (globs, literal directories, negations)
// walks the working tree and filters with the matcher.
const dispatchPathspec = async (
  ctx: Context,
  paths: ReadonlyArray<string>,
  scope: ConversionScope,
): Promise<AddResult> => {
  const resolved = resolvePathspec(paths);
  const { literalMustMatch } = resolved;
  await assertNoSymlinkedLeadingPath(ctx, resolved.symlinkScanTargets);
  if (!resolved.hasGlob && (await allLiteralsAreFiles(ctx, literalMustMatch))) {
    return addLiteralOnly(ctx, literalMustMatch, scope);
  }
  return addByPathspec(ctx, resolved, scope);
};

const addLiteralOnly = async (
  ctx: Context,
  validated: ReadonlyArray<FilePath>,
  scope: ConversionScope,
): Promise<AddResult> => {
  const lock = await acquireIndexLock(ctx);
  const ensurePromisorConfigValid = createPromisorGuard(ctx);
  try {
    const { indexRules, ...state } = await readExistingEntries(ctx);
    const staging = { ctx, scope: { ...scope, indexRules }, ...state, ensurePromisorConfigValid };
    const { newEntries, added, modified, eolNotices, restagedPaths } = await stageLiterals(
      staging,
      validated,
    );
    await commitIfChanged(lock, state.entries.size, Array.from(newEntries.values()), restagedPaths);
    return { added, modified, removed: [], eolNotices };
  } finally {
    await lock.release();
  }
};

/** What every path is staged against: the index as read, and the add's attributes and guard. */
interface Staging {
  readonly ctx: Context;
  readonly scope: StagingScope;
  readonly entries: ReadonlyMap<FilePath, IndexEntry>;
  readonly indexMtime: IndexMtime | undefined;
  readonly ensurePromisorConfigValid: PromisorGuard;
}

/** git stages the tracked paths first, then the untracked ones, each group in index order. */
const trackedFirst = (
  paths: ReadonlyArray<FilePath>,
  existing: ReadonlyMap<FilePath, IndexEntry>,
): FilePath[] => {
  const sorted = [...paths].sort(comparePaths);
  return [
    ...sorted.filter((path) => existing.has(path)),
    ...sorted.filter((path) => !existing.has(path)),
  ];
};

/** git stages — and cleans — in index order, whatever order the paths came in. */
const stageLiterals = async (
  staging: Staging,
  validated: ReadonlyArray<FilePath>,
): Promise<{
  readonly newEntries: ReadonlyMap<FilePath, IndexEntry>;
  readonly added: ReadonlyArray<FilePath>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly eolNotices: ReadonlyArray<EolNotice>;
  readonly restagedPaths: ReadonlyArray<FilePath>;
}> => {
  const { ctx, scope, entries: existing, indexMtime } = staging;
  const newEntries = new Map<FilePath, IndexEntry>(existing);
  const added: FilePath[] = [];
  const modified: FilePath[] = [];
  const eolNotices: EolNotice[] = [];
  const restagedPaths: FilePath[] = [];
  for (const path of trackedFirst(validated, existing)) {
    const previous = existing.get(path);
    const guard = staging.ensurePromisorConfigValid;
    const result = await stageOne(ctx, path, scope, previous, indexMtime, guard);
    if (result === 'missing') throw pathspecNoMatch(path);
    const { entry, notice } = result;
    newEntries.set(path, entry);
    if (wasRestaged(previous, entry)) restagedPaths.push(path);
    if (notice !== undefined) eolNotices.push(notice);
    if (previous === undefined) added.push(path);
    else if (previous.id !== entry.id || previous.mode !== entry.mode) modified.push(path);
  }
  return { newEntries, added, modified, eolNotices, restagedPaths };
};

/** git's SKIP_IF_UNCHANGED: a re-staged, added or removed path is a change; additions are always re-staged, so a size drift is a removal. */
const changesIndex = (
  existingCount: number,
  entries: ReadonlyArray<IndexEntry>,
  restagedPaths: ReadonlyArray<FilePath>,
): boolean => restagedPaths.length > 0 || entries.length !== existingCount;

const commitIfChanged = async (
  lock: IndexLock,
  existingCount: number,
  entries: ReadonlyArray<IndexEntry>,
  restagedPaths: ReadonlyArray<FilePath>,
): Promise<void> => {
  if (!changesIndex(existingCount, entries, restagedPaths)) return;
  await lock.commit(entries, 'update', { restagedPaths });
};

/** `ie_match_stat` clean paths keep their entry object; every other path was rebuilt, which git's add_index_entry reports to the cache-tree. */
const wasRestaged = (previous: IndexEntry | undefined, entry: IndexEntry): boolean =>
  entry !== previous;

const allLiteralsAreFiles = async (
  ctx: Context,
  literals: ReadonlyArray<FilePath>,
): Promise<boolean> => {
  if (literals.length === 0) return false;
  for (const path of literals) {
    if (namesDirectoryOnly(path)) return false;
    const stat = await lstatOrMissing(ctx, path);
    if (stat === undefined) return false;
    if (stat.isDirectory && !stat.isSymbolicLink) return false;
  }
  return true;
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
  walk: AsyncIterable<WalkWorkingTreeEntry>,
  existing: ReadonlyMap<FilePath, IndexEntry>,
  seen: Set<FilePath>,
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
  walk: AsyncIterable<WalkWorkingTreeEntry>,
  existing: ReadonlyMap<FilePath, IndexEntry>,
): AsyncGenerator<WalkWorkingTreeEntry> {
  const walked = new Map<FilePath, WalkWorkingTreeEntry>();
  for await (const walkEntry of walk) walked.set(walkEntry.path, walkEntry);
  for (const path of existing.keys()) {
    const walkEntry = walked.get(path);
    if (walkEntry === undefined) continue;
    walked.delete(path);
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
const dispatchInCleanOrder = (
  ctx: Context,
  walk: AsyncIterable<WalkWorkingTreeEntry>,
  stage: (walkEntry: WalkWorkingTreeEntry) => Promise<WalkOutcome>,
  span: OrderSpan,
): Promise<ReadonlyArray<StagedEntry>> =>
  withCleanOrder(
    ctx,
    async (order) => {
      const dispatcher = { limiter: limiterFor(ctx, 'ioBound'), order, stage };
      const pending: Promise<StagedEntry>[] = [];
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

/** Stage one walked entry under the limiter, releasing its clean turn whatever the outcome. */
const dispatchWalkEntry = (
  {
    limiter,
    order,
    stage,
  }: {
    readonly limiter: ConcurrencyLimiter;
    readonly order: CleanOrder;
    readonly stage: (walkEntry: WalkWorkingTreeEntry) => Promise<WalkOutcome>;
  },
  walkEntry: WalkWorkingTreeEntry,
): Promise<StagedEntry> => {
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
  { matcher, literalMustMatch, literalSpellings }: ResolvedPathspec,
  scope: ConversionScope,
): Promise<AddResult> => {
  const combinedIgnore = withPathspec(await buildRepoIgnorePredicate(ctx), matcher);
  const lock = await acquireIndexLock(ctx);
  const ensurePromisorConfigValid = createPromisorGuard(ctx);
  try {
    const staged = await stageIgnoredWalk(ctx, combinedIgnore, scope, ensurePromisorConfigValid);
    const { newEntries, matched, added, modified, eolNotices, restagedPaths } = tallyWalkOutcomes(
      staged.existing,
      staged.outcomes,
    );
    // git add never refuses the whole tree, even when it holds nothing to add.
    const mustMatch = literalMustMatch.filter((literal) => !namesWholeTree(literal));
    enforceLiteralMustMatch(mustMatch, matched, literalSpellings);
    await commitIfChanged(
      lock,
      staged.existing.size,
      Array.from(newEntries.values()),
      restagedPaths,
    );
    return { added: [...added].sort(), modified: [...modified].sort(), removed: [], eolNotices };
  } finally {
    await lock.release();
  }
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
  const { matcher, literalMustMatch, literalSpellings, symlinkScanTargets } =
    resolvePathspec(paths);
  await assertNoSymlinkedLeadingPath(ctx, symlinkScanTargets);
  const lock = await acquireIndexLock(ctx);
  const ensurePromisorConfigValid = createPromisorGuard(ctx);
  try {
    const { entries } = await readIndexOrEmpty(ctx);
    const staging = {
      ctx,
      scope: { ...scope, indexRules: NO_INDEX_RULES },
      ensurePromisorConfigValid,
    };
    const renormalized = await renormalizeEntries(staging, entries, matcher);
    const onDisk = await literalsOnDisk(ctx, literalMustMatch);
    // Stryker disable next-line MethodExpression: equivalent — the whole-tree literal is itself among the on-disk literals (the work tree exists), so enforceLiteralMustMatch accepts it unfiltered.
    const mustMatch = literalMustMatch.filter((literal) => !namesWholeTree(literal));
    enforceLiteralMustMatch(mustMatch, onDisk, literalSpellings);
    await commitIfChanged(lock, entries.length, renormalized.entries, renormalized.restagedPaths);
    return { added: [], modified: renormalized.modified, removed: [], eolNotices: [] };
  } finally {
    await lock.release();
  }
};

/** The literals naming something on disk: every tracked one the pass re-cleaned, and an untracked file git accepts and stages nothing for. */
const literalsOnDisk = async (
  ctx: Context,
  literals: ReadonlyArray<FilePath>,
): Promise<ReadonlyArray<FilePath>> => {
  const present: FilePath[] = [];
  for (const literal of literals) {
    if ((await lstatOrMissing(ctx, literal)) !== undefined) present.push(literal);
  }
  return present;
};

/** Whether `add --renormalize` re-cleans this entry: a merged, checked-out file or symlink in the pathspec. */
const isRecleaned = (entry: IndexEntry, matcher: ResolvedPathspec['matcher']): boolean =>
  entry.flags.stage === 0 &&
  !entry.flags.skipWorktree &&
  RECLEANED_MODES.has(entry.mode) &&
  matchesPathspec(matcher, entry.path);

const RECLEANED_MODES: ReadonlySet<FileMode> = new Set([
  FILE_MODE.REGULAR,
  FILE_MODE.EXECUTABLE,
  FILE_MODE.SYMLINK,
]);

const renormalizeEntries = async (
  staging: Omit<Staging, 'entries' | 'indexMtime'>,
  entries: ReadonlyArray<IndexEntry>,
  matcher: ResolvedPathspec['matcher'],
): Promise<{
  readonly entries: ReadonlyArray<IndexEntry>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly restagedPaths: ReadonlyArray<FilePath>;
}> => {
  const next: IndexEntry[] = [];
  const modified: FilePath[] = [];
  const restagedPaths: FilePath[] = [];
  for (const previous of entries) {
    if (!isRecleaned(previous, matcher)) {
      next.push(previous);
      continue;
    }
    const entry = await renormalizeOne(staging, previous);
    next.push(entry);
    if (wasRestaged(previous, entry)) restagedPaths.push(previous.path);
    if (entry.id !== previous.id || entry.mode !== previous.mode) modified.push(previous.path);
  }
  return { entries: next, modified, restagedPaths };
};

const renormalizeOne = async (
  { ctx, scope, ensurePromisorConfigValid }: Omit<Staging, 'entries' | 'indexMtime'>,
  previous: IndexEntry,
): Promise<IndexEntry> => {
  const { path } = previous;
  await ensurePromisorConfigValid();
  const fresh = await lstatOrMissing(ctx, path);
  if (fresh === undefined) throw pathspecNoMatch(path);
  if (fresh.size > MAX_WORKING_TREE_BLOB_BYTES) {
    throw workingTreeFileTooLarge(path, fresh.size, MAX_WORKING_TREE_BLOB_BYTES);
  }
  const mode: FileMode = deriveWorkingMode(fresh);
  validateIndexPath(path, NO_PARSER_OFFSET, mode);
  const { id } = await writeCleanedBlob(ctx, path, fresh, scope, previous, 'renormalize');
  return indexEntryFromStat(fresh, mode, id, path);
};

/** Read the index, then stage every walked entry `ignore` keeps. */
const stageIgnoredWalk = async (
  ctx: Context,
  ignore: IgnorePredicate,
  scope: ConversionScope,
  ensurePromisorConfigValid: PromisorGuard,
): Promise<{
  readonly existing: ReadonlyMap<FilePath, IndexEntry>;
  readonly outcomes: ReadonlyArray<WalkOutcome>;
}> => {
  const { entries: existing, indexMtime, indexRules } = await readExistingEntries(ctx);
  const outcomes = await stageWalkedEntries(
    ctx,
    walkWorkingTree(ctx, { ignore }),
    existing,
    new Set<FilePath>(),
    { ...scope, indexRules },
    indexMtime,
    ensurePromisorConfigValid,
  );
  return { existing, outcomes };
};

/** `.gitignore` prunes directories and leaves; the pathspec filters leaves only. */
const withPathspec =
  (ignore: IgnorePredicate, matcher: ResolvedPathspec['matcher']): IgnorePredicate =>
  async (path, isDirectory) => {
    if (await ignore(path, isDirectory)) return true;
    if (isDirectory) return false;
    return !matchesPathspec(matcher, path);
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
  existing: ReadonlyMap<FilePath, IndexEntry>,
): FilePath[] =>
  outcomes
    .filter(({ path, entry }) => wasRestaged(existing.get(path), entry))
    .map(({ path }) => path);

/** The index once every walked outcome is staged, and which paths were matched, added, modified. */
const tallyWalkOutcomes = (
  existing: ReadonlyMap<FilePath, IndexEntry>,
  outcomes: ReadonlyArray<WalkOutcome>,
): {
  readonly newEntries: ReadonlyMap<FilePath, IndexEntry>;
  readonly matched: ReadonlyArray<FilePath>;
  readonly added: ReadonlyArray<FilePath>;
  readonly modified: ReadonlyArray<FilePath>;
  readonly eolNotices: ReadonlyArray<EolNotice>;
  readonly restagedPaths: ReadonlyArray<FilePath>;
} => {
  const newEntries = new Map<FilePath, IndexEntry>(existing);
  const matched: FilePath[] = [];
  const added: FilePath[] = [];
  const modified: FilePath[] = [];
  for (const outcome of outcomes) {
    matched.push(outcome.path);
    newEntries.set(outcome.path, outcome.entry);
    if (outcome.kind === 'added') added.push(outcome.path);
    else if (outcome.kind === 'modified') modified.push(outcome.path);
  }
  const restagedPaths = restagedPathsOf(outcomes, existing);
  return { newEntries, matched, added, modified, eolNotices: noticesOf(outcomes), restagedPaths };
};

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
    const { entries: existing, indexMtime, indexRules } = await readExistingEntries(ctx);
    const newEntries = new Map<FilePath, IndexEntry>(existing);
    const seen = new Set<FilePath>();
    const added: FilePath[] = [];
    const modified: FilePath[] = [];

    // Walk-time pruning: the walker calls `ignore` on every directory
    // (skipping ignored subtrees) and every leaf. By the time we see a
    // leaf here, the ignore filter has already passed.
    const outcomes = await stageWalkedEntries(
      ctx,
      walkWorkingTree(ctx, { ignore }),
      existing,
      seen,
      { ...scope, indexRules },
      indexMtime,
      ensurePromisorConfigValid,
    );
    for (const outcome of outcomes) {
      newEntries.set(outcome.path, outcome.entry);
      if (outcome.kind === 'added') added.push(outcome.path);
      else if (outcome.kind === 'modified') modified.push(outcome.path);
    }
    const removed = await collectRemovedPaths(existing, seen, ignore);
    for (const path of removed) newEntries.delete(path);
    added.sort();
    modified.sort();
    // Stryker disable next-line MethodExpression: equivalent — `removed` is built by iterating `existing`, a Map populated from the always-byte-sorted index (serializeIndex sorts on every write), so it is already in ascending path order; the sort is a defensive no-op.
    removed.sort();
    await commitIfChanged(
      lock,
      existing.size,
      Array.from(newEntries.values()),
      restagedPathsOf(outcomes, existing),
    );
    return { added, modified, removed, eolNotices: noticesOf(outcomes) };
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
 * The post-walk removal pass: every prior index entry the walk did not see on
 * disk is a candidate removal. Two entries are preserved (NOT removed):
 *
 * - **skip-worktree** — a sparse-excluded entry is legitimately absent;
 *   staging its removal would silently un-sparse it into a deletion.
 * - **tracked-but-ignored** — a tracked file under a pruned subtree
 *   (directory-level ignore) the walker skipped. Git's invariant: ignore
 *   rules don't auto-untrack.
 */
const collectRemovedPaths = async (
  existing: ReadonlyMap<FilePath, IndexEntry>,
  seen: ReadonlySet<FilePath>,
  ignore: IgnorePredicate,
): Promise<FilePath[]> => {
  const removed: FilePath[] = [];
  for (const [path, entry] of existing) {
    if (seen.has(path)) continue;
    if (entry.flags.skipWorktree) continue;
    if (await isPathOrAncestorIgnored(path, ignore)) continue;
    removed.push(path);
  }
  return removed;
};

/**
 * True if `path` or any ancestor directory is reported ignored by the
 * predicate. Git's directory-level ignore rules (`build/`) match the
 * directory entry, NOT the files under it; the walker handles this by
 * pruning at descent, but the post-walk re-check must mirror it.
 */
const isPathOrAncestorIgnored = async (
  path: FilePath,
  ignore: IgnorePredicate,
): Promise<boolean> => {
  if (await ignore(path, false)) return true;
  const segments = path.split('/');
  for (let i = 1; i < segments.length; i += 1) {
    const ancestor = segments.slice(0, i).join('/') as FilePath;
    if (await ignore(ancestor, true)) return true;
  }
  return false;
};

const processWalkEntry = async (
  ctx: Context,
  walkEntry: WalkWorkingTreeEntry,
  existing: ReadonlyMap<FilePath, IndexEntry>,
  seen: Set<FilePath>,
  scope: StagingScope,
  indexMtime: IndexMtime | undefined,
  ensurePromisorConfigValid: PromisorGuard,
): Promise<WalkOutcome> => {
  const { path, isFile, isDirectory, isSymbolicLink } = walkEntry;
  // Mark presence BEFORE any further filter so the post-walk
  // "missing from disk → removed" pass is exact. Ignore filtering
  // already happened at walk-time in; this function only sees
  // leaves the walker chose to yield.
  seen.add(path);
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
    existing.get(path),
    indexMtime,
    ensurePromisorConfigValid,
  );
  const previous = existing.get(path);
  const withNotice = notice === undefined ? {} : { notice };
  if (previous === undefined) return { kind: 'added', path, entry, ...withNotice };
  if (previous.id !== entry.id || previous.mode !== entry.mode) {
    return { kind: 'modified', path, entry, ...withNotice };
  }
  return { kind: 'unchanged', path, entry, ...withNotice };
};

interface ExistingIndexState {
  readonly entries: ReadonlyMap<FilePath, IndexEntry>;
  readonly indexMtime: IndexMtime | undefined;
  readonly indexRules: ReadonlyMap<FilePath, IndexEntry>;
}

const readExistingEntries = async (ctx: Context): Promise<ExistingIndexState> => {
  const { entries, indexMtime } = await readIndexOrEmpty(ctx);
  const out = new Map<FilePath, IndexEntry>();
  const unmerged: IndexEntry[] = [];
  for (const entry of entries) {
    out.set(entry.path, entry);
    if (entry.flags.stage !== 0) unmerged.push(entry);
  }
  const indexRules = new Map(indexRuleEntries(unmerged).map((entry) => [entry.path, entry]));
  return { entries: out, indexMtime, indexRules };
};

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

const stageOne = async (
  ctx: Context,
  path: FilePath,
  scope: StagingScope,
  previous: IndexEntry | undefined,
  indexMtime: IndexMtime | undefined,
  ensurePromisorConfigValid: PromisorGuard,
): Promise<StagedBlob | 'missing'> => {
  const stat = await lstatOrMissing(ctx, path);
  if (stat === undefined) return 'missing';
  return stageFromStat(ctx, path, stat, scope, previous, indexMtime, ensurePromisorConfigValid);
};

/**
 * The three kind bits `stageFromStat`'s TOCTOU check needs — satisfied
 * structurally by both a full `FileStat` (`stageOne`'s literal-path lstat)
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
  if (previous !== undefined && restagesAsIs(previous, fresh, indexMtime))
    return { entry: previous };
  // Authoritative size cap — uses the fresh stat so a grow-between-walk-and-
  // stage race cannot smuggle an oversize blob past the pre-filter.
  if (fresh.size > MAX_WORKING_TREE_BLOB_BYTES) {
    throw workingTreeFileTooLarge(path, fresh.size, MAX_WORKING_TREE_BLOB_BYTES);
  }
  const mode: FileMode = deriveWorkingMode(fresh);
  validateIndexPath(path, NO_PARSER_OFFSET, mode);
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
 * comes either from a real lstat (`stageOne`) or from the walker's readdir
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
 * blob to read. `previous` is the last stage recorded, so only an unmerged
 * path consults the stage-2 entries read with the index.
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
  return ctx.fs.read(joinPath(workDir, path));
};
