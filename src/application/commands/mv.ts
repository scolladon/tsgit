/**
 * `mv` porcelain — rename/move tracked paths in the index and working tree,
 * faithful to `git mv`. The resulting index + tree read back (via
 * `git ls-files --stage` / `git write-tree`) match canonical git; raw index
 * bytes differ only by per-host stat-cache fields.
 *
 * @writes
 *   surface: mv
 *   kind:    equivalent-under-readback
 *   format:  git-index-tree-state
 */
import {
  mvBadSource,
  mvDestinationBeyondSymlink,
  mvDestinationDirectoryMissing,
  mvDestinationExists,
  mvDestinationNotDirectory,
  mvIntoSelf,
  mvMultipleSourcesSameTarget,
  mvOverlappingSources,
  mvSourceDirectoryEmpty,
  mvSourceNotTracked,
} from '../../domain/commands/error.js';
import { basename, dirname, TsgitError } from '../../domain/error.js';
import {
  entriesAtLeadingDirectories,
  entriesBeneath,
} from '../../domain/git-index/directory-file-conflict.js';
import type { GitIndex, IndexEntry } from '../../domain/git-index/index.js';
import { withPath } from '../../domain/git-index/index-entry.js';
import type { IndexPathKey } from '../../domain/git-index/index-path-key.js';
import {
  escapedPathOf,
  hasBytePrefix,
  indexPathKey,
  isLossy,
  keyOfPath,
  pathBytesOf,
  viewOfEscaped,
} from '../../domain/git-index/index-path-key.js';
import { type IndexPathRules, NO_PARSER_OFFSET } from '../../domain/git-index/path-validator.js';
import { emptyPathspec } from '../../domain/index.js';
import { encode, wellFormed } from '../../domain/objects/encoding.js';
import type { FilePath } from '../../domain/objects/object-id.js';
import { asciiLower } from '../../domain/pretty/ascii.js';
import type { Context } from '../../ports/context.js';
import {
  type ComparisonScope,
  compareAndRefresh,
  scopeOf,
} from '../primitives/compare-working-tree-entry.js';
import { readConfig } from '../primitives/config-read.js';
import type { IndexLock } from '../primitives/internal/index-lock.js';
import { indexPathRulesOf } from '../primitives/internal/index-path-rules.js';
import { joinPathSegment } from '../primitives/internal/join-path-segment.js';
import { joinPath } from '../primitives/internal/join-working-tree-path.js';
import { buildCheckinAttributeProvider } from '../primitives/internal/read-gitattributes.js';
import {
  beyondSymlink,
  createLeadingPathScanner,
  type LeadingPathScanner,
} from '../primitives/internal/symlinked-leading-path.js';
import { readExecutableBitTrust } from '../primitives/read-executable-bit-trust.js';
import { readIndex } from '../primitives/read-index.js';
import { readStatCheck } from '../primitives/read-stat-check.js';
import { acquireIndexLock } from './internal/index-update.js';
import {
  assertNoPendingOperation,
  assertOperationalRepository,
  requireWorkTree,
} from './internal/repo-state.js';
import { discardDirectory, renameInWorkingTree, validatePath } from './internal/working-tree.js';

// Same tolerance set as `rm`: a missing-or-unparsable index is treated as
// "no entries" so a refusal is still computed off the empty map; every other
// read error propagates. A predicate (not a Set) so each literal is attributed
// per-test under mutation coverage.
const isIndexMissingCode = (code: string): boolean =>
  code === 'FILE_NOT_FOUND' || code === 'INVALID_INDEX_HEADER' || code === 'INVALID_INDEX_ENTRY';

export interface MvOptions {
  /** Overwrite an existing destination (a file source only). `-f`. */
  readonly force?: boolean;
  /** Validate and report the plan without touching index or working tree. `-n`. */
  readonly dryRun?: boolean;
  /** Skip refused (source → target) pairs instead of aborting the whole call. `-k`. */
  readonly skipErrors?: boolean;
}

export interface MvMove {
  readonly from: FilePath;
  readonly to: FilePath;
}

/**
 * Per-source refusals that `skipErrors` collects rather than throwing. Every reason
 * but `rename-failed` is decided while planning; `rename-failed` is collected at execution.
 */
export type MvSkipReason =
  | 'source-not-tracked'
  | 'source-directory-empty'
  | 'bad-source'
  | 'destination-exists'
  | 'into-self'
  | 'destination-beyond-symlink'
  | 'rename-failed'; // the working-tree rename was refused

type PlanSkipReason = Exclude<MvSkipReason, 'rename-failed'>;

export interface MvSkipped {
  readonly source: FilePath;
  readonly reason: MvSkipReason;
}

export interface MvResult {
  readonly moved: ReadonlyArray<MvMove>;
  readonly skipped: ReadonlyArray<MvSkipped>;
}

type DestinationMode =
  | { readonly kind: 'rename'; readonly target: FilePath }
  | { readonly kind: 'into-dir'; readonly destDir: FilePath };

interface PlanItem {
  readonly kind: 'file' | 'directory';
  readonly source: FilePath;
  readonly target: FilePath;
  readonly entries: ReadonlyArray<IndexEntry>;
  /** Lossy members left in place, which keep the source directory alive. */
  readonly retained: ReadonlyArray<IndexEntry>;
}

type Verdict =
  | {
      readonly kind: 'file' | 'directory';
      readonly entries: ReadonlyArray<IndexEntry>;
      readonly retained: ReadonlyArray<IndexEntry>;
      /** Members that stay put because their destination lies beyond a symbolic link. */
      readonly skippedMembers: ReadonlyArray<IndexEntry>;
    }
  | {
      readonly skip: PlanSkipReason;
      /** Names the refused member when it differs from the user's source. */
      readonly source?: FilePath;
      readonly target?: FilePath;
    };

/**
 * Move/rename tracked paths in the index and the working tree, faithful to
 * `git mv`. Each (source → target) pair is validated up front; on any refusal
 * nothing is moved (unless `skipErrors`). Blob ids and modes are copied from the
 * source's index entry — the working file is renamed as-is, never re-hashed.
 */
export const mv = async (
  ctx: Context,
  sources: ReadonlyArray<string>,
  destination: string,
  opts: MvOptions = {},
): Promise<MvResult> => {
  await assertOperationalRepository(ctx);
  requireWorkTree(ctx, 'mv');
  await assertNoPendingOperation(ctx);
  const request = parseRequest(sources, destination);
  const lock = await acquireIndexLock(ctx);
  try {
    const index = await readIndexMap(ctx);
    const plan = await planUnderLock(ctx, index.byPath, request, opts);
    if (opts.dryRun === true) return { moved: plannedMoves(plan.planned), skipped: plan.skipped };
    return await executePlan(ctx, lock, index, plan, opts);
  } finally {
    await lock.release();
  }
};

interface MvRequest {
  readonly sources: ReadonlyArray<FilePath>;
  readonly firstSource: FilePath;
  readonly destination: string;
  readonly destNoSlash: FilePath;
}

const parseRequest = (sources: ReadonlyArray<string>, destination: string): MvRequest => {
  const validatedSources = sources.map((source) =>
    validatePath(stripTrailingSlash(wellFormed(source))),
  );
  const [firstSource] = validatedSources;
  if (firstSource === undefined) throw emptyPathspec();
  assertNoOverlappingSources(validatedSources);
  const wellFormedDestination = wellFormed(destination);
  const destNoSlash = validatePath(stripTrailingSlash(wellFormedDestination));
  return {
    sources: validatedSources,
    firstSource,
    destination: wellFormedDestination,
    destNoSlash,
  };
};

const planUnderLock = async (
  ctx: Context,
  byPath: ReadonlyMap<IndexPathKey, IndexEntry>,
  { sources, firstSource, destination, destNoSlash }: MvRequest,
  opts: MvOptions,
): Promise<Plan> => {
  const mode = await resolveDestinationMode(ctx, firstSource, destination, destNoSlash);
  if (mode.kind === 'rename' && sources.length > 1) {
    throw mvDestinationNotDirectory(firstSource, mode.target);
  }
  const policy = await destinationPolicyOf(ctx, opts);
  const plan = await buildPlan(ctx, byPath, sources, mode, opts, policy);
  assertNoTargetCollision(plan.planned);
  return plan;
};

interface IndexMove {
  readonly from: IndexEntry;
  readonly to: IndexEntry;
}

interface RepathedItem {
  readonly item: PlanItem;
  readonly moves: ReadonlyArray<IndexMove>;
}

interface ExecutedItem extends RepathedItem {
  readonly outcome: 'renamed' | 'skipped';
}

// Every target is validated before the first rename, so a refused path moves nothing.
const executePlan = async (
  ctx: Context,
  lock: IndexLock,
  index: IndexAsRead,
  { planned, skipped }: Plan,
  opts: MvOptions,
): Promise<MvResult> => {
  const { byPath } = index;
  const pathRules = indexPathRulesOf(ctx);
  const repathed = planned.map((item) => repathItem(pathRules, item));
  const executed = await renameEach(ctx, repathed, opts);
  const indexed = executed.filter(movesIndex);
  applyToIndex(byPath, indexed);
  const upToDate = await refreshMoved(ctx, index, indexed);
  await removeAbandonedSources(ctx, byPath, executed);
  await lock.commit(Array.from(byPath.values()), 'update', {
    verified: (path) => upToDate.has(path),
  });
  return {
    moved: plannedMoves(indexed.map(({ item }) => item)),
    skipped: [...skipped, ...renameSkipsOf(executed)],
  };
};

const repathItem = (pathRules: IndexPathRules, item: PlanItem): RepathedItem => ({
  item,
  moves: item.entries.map((from) => {
    const to = withPath(from, { path: repath(from, item.source, item.target) });
    pathRules.validateIndexPath(to.path, NO_PARSER_OFFSET, to.mode);
    return { from, to };
  }),
});

const renameEach = async (
  ctx: Context,
  repathed: ReadonlyArray<RepathedItem>,
  opts: MvOptions,
): Promise<ReadonlyArray<ExecutedItem>> => {
  const run = opts.skipErrors === true ? renameOrSkip : renameOrThrow;
  const executed: ExecutedItem[] = [];
  for (const { item, moves } of repathed) {
    executed.push({ item, moves, outcome: await run(ctx, item) });
  }
  return executed;
};

const renameOrThrow = async (ctx: Context, item: PlanItem): Promise<'renamed'> => {
  await renameInWorkingTree(ctx, item.source, item.target);
  return 'renamed';
};

const renameOrSkip = async (ctx: Context, item: PlanItem): Promise<'renamed' | 'skipped'> => {
  const targetWasAbsent = (await lstatOrUndefined(ctx, item.target)) === undefined;
  try {
    return await renameOrThrow(ctx, item);
  } catch (err) {
    if (!(err instanceof TsgitError)) throw err;
    if (targetWasAbsent && abandonsSource(item)) await removePartialMove(ctx, item.target);
    return 'skipped';
  }
};

// An item without index moves leaves the index at its source, so what it moved stays.
const abandonsSource = (item: PlanItem): boolean =>
  item.kind === 'directory' && item.retained.length === 0 && item.entries.length > 0;

const removePartialMove = async (ctx: Context, target: FilePath): Promise<void> => {
  if ((await lstatOrUndefined(ctx, target)) === undefined) return;
  await discardDirectory(ctx, target);
};

// A directory's index entries move even when its rename was refused: git moves the
// members it could address and leaves the rest where they were.
const movesIndex = ({ item, outcome }: ExecutedItem): boolean =>
  outcome === 'renamed' || item.kind === 'directory';

const renameSkipsOf = (executed: ReadonlyArray<ExecutedItem>): ReadonlyArray<MvSkipped> =>
  executed
    .filter(({ outcome }) => outcome === 'skipped')
    .map(({ item }) => ({ source: item.source, reason: 'rename-failed' }));

// After the whole loop: a later source may have been renamed into the abandoned
// directory, so a per-item cleanup would delete it too early. Only a directory is
// cleaned: the index replacement rule can drop a skipped file's entry, and its path
// then names whatever now stands there, which git keeps.
const removeAbandonedSources = async (
  ctx: Context,
  byPath: ReadonlyMap<IndexPathKey, IndexEntry>,
  executed: ReadonlyArray<ExecutedItem>,
): Promise<void> => {
  for (const { item, outcome } of executed) {
    if (item.kind !== 'directory' || outcome !== 'skipped') continue;
    if (classifySource(byPath, item.source).kind !== 'untracked') continue;
    await discardDirectory(ctx, item.source);
  }
};

/** The index as read: its entries by path, and its own mtime, the racy test's reference. */
interface IndexAsRead {
  readonly byPath: Map<IndexPathKey, IndexEntry>;
  readonly indexMtime: GitIndex['indexMtime'];
}

const NO_INDEX: Pick<GitIndex, 'entries' | 'indexMtime'> = { entries: [] };

const readIndexMap = async (ctx: Context): Promise<IndexAsRead> => {
  const index = await readIndex(ctx).catch((err: unknown) => {
    if (err instanceof TsgitError && isIndexMissingCode(err.data.code)) return NO_INDEX;
    throw err;
  });
  const byPath = new Map<IndexPathKey, IndexEntry>();
  for (const entry of index.entries) byPath.set(indexPathKey(entry), entry);
  return { byPath, indexMtime: index.indexMtime };
};

const refreshScope = async (ctx: Context, indexMtime: GitIndex['indexMtime']) => ({
  ...scopeOf(await buildCheckinAttributeProvider(ctx), indexMtime, createLeadingPathScanner(ctx)),
  executableBit: await readExecutableBitTrust(ctx),
  statCheck: await readStatCheck(ctx),
});

/**
 * A moved entry as git's refresh leaves it when it is up to date: a skip-worktree entry as it
 * is, without a look at its file; an unchanged one with the stat the rename left. `undefined`
 * when the content differs: the entry keeps the stat it was read with.
 */
const settleMoved = async (
  ctx: Context,
  to: IndexEntry,
  scope: ComparisonScope,
): Promise<IndexEntry | undefined> => {
  if (to.flags.skipWorktree) return to;
  const { delta, refreshed } = await compareAndRefresh(ctx, to, scope);
  if (delta.status !== 'unchanged') return undefined;
  return refreshed ?? to;
};

/**
 * git's `rename_index_entry_at`: each moved entry is refreshed at its new path. The paths
 * returned are up to date; any other is left to the racy smudge of the index write.
 */
const refreshMoved = async (
  ctx: Context,
  { byPath, indexMtime }: IndexAsRead,
  indexed: ReadonlyArray<ExecutedItem>,
): Promise<ReadonlySet<FilePath>> => {
  const upToDate = new Set<FilePath>();
  const moved = indexed.flatMap(({ moves }) => moves);
  if (moved.length === 0) return upToDate;
  const scope = await refreshScope(ctx, indexMtime);
  for (const { to } of moved) {
    const settled = await settleMoved(ctx, to, scope);
    if (settled === undefined) continue;
    upToDate.add(to.path);
    byPath.set(indexPathKey(to), settled);
  }
  return upToDate;
};

const resolveDestinationMode = async (
  ctx: Context,
  firstSource: FilePath,
  destination: string,
  destNoSlash: FilePath,
): Promise<DestinationMode> => {
  // A trailing slash makes git resolve a leading-and-final link (R17).
  const stat = destination.endsWith('/')
    ? await statOrUndefined(ctx, destNoSlash)
    : await lstatOrUndefined(ctx, destNoSlash);
  if (stat?.isDirectory === true) {
    return { kind: 'into-dir', destDir: destNoSlash };
  }
  if (destination.endsWith('/')) {
    // A trailing slash forces directory interpretation; the directory is absent.
    // `destination` (with its slash) is display-only here, never operated on.
    throw mvDestinationDirectoryMissing(firstSource, destination as FilePath);
  }
  return { kind: 'rename', target: destNoSlash };
};

interface Plan {
  readonly planned: ReadonlyArray<PlanItem>;
  readonly skipped: ReadonlyArray<MvSkipped>;
}

const buildPlan = async (
  ctx: Context,
  byPath: ReadonlyMap<IndexPathKey, IndexEntry>,
  sources: ReadonlyArray<FilePath>,
  mode: DestinationMode,
  opts: MvOptions,
  policy: DestinationPolicy,
): Promise<Plan> => {
  const planned: PlanItem[] = [];
  const skipped: MvSkipped[] = [];
  for (const source of sources) {
    const target = targetOf(mode, source);
    const verdict = await validateMove(ctx, byPath, source, target, opts, policy);
    if (!('skip' in verdict)) {
      skipped.push(...skippedMembersOf(verdict));
      const { kind, entries, retained } = verdict;
      planned.push({ kind, source, target, entries, retained });
    } else if (opts.skipErrors === true) {
      skipped.push({ source, reason: verdict.skip });
    } else {
      throw refusal(verdict.skip, verdict.source ?? source, verdict.target ?? target);
    }
  }
  return { planned, skipped };
};

const targetOf = (mode: DestinationMode, source: FilePath): FilePath =>
  mode.kind === 'rename'
    ? mode.target
    : (joinPathSegment(mode.destDir, basename(source)) as FilePath);

const skippedMembersOf = ({
  skippedMembers,
}: {
  readonly skippedMembers: ReadonlyArray<IndexEntry>;
}): ReadonlyArray<MvSkipped> =>
  skippedMembers.map((member) => ({ source: member.path, reason: 'destination-beyond-symlink' }));

const validateMove = async (
  ctx: Context,
  byPath: ReadonlyMap<IndexPathKey, IndexEntry>,
  source: FilePath,
  target: FilePath,
  opts: MvOptions,
  policy: DestinationPolicy,
): Promise<Verdict> => {
  const classified = classifySource(byPath, source);
  if (classified.kind === 'untracked') return { skip: await untrackedVerdictOf(ctx, source) };
  if (!(await sourceExistsOnDisk(ctx, source, classified.kind))) return { skip: 'bad-source' };
  const unmovable = unmovableMembers(classified.entries, source, target, opts);
  if (unmovable !== undefined) return unmovable;
  const entries = classified.entries.filter((entry) => !isLossy(entry));
  const retained = classified.entries.filter(isLossy);
  if (target === source || target.startsWith(`${source}/`)) return { skip: 'into-self' };
  const refused = await refuseDestination(ctx, byPath, {
    source,
    target,
    kind: classified.kind,
    policy,
    first: classified.entries[0],
    members: entries,
    retained,
    opts,
  });
  return refused ?? { kind: classified.kind, entries, retained, skippedMembers: [] };
};

const unmovableMembers = (
  members: ReadonlyArray<IndexEntry>,
  source: FilePath,
  target: FilePath,
  opts: MvOptions,
): Verdict | undefined => {
  const lossyMember = members.find(isLossy);
  if (lossyMember !== undefined && opts.skipErrors !== true) {
    return memberBadSource(lossyMember, source, target);
  }
  return members.every(isLossy) ? { skip: 'bad-source' } : undefined;
};

interface DestinationCheck {
  readonly source: FilePath;
  readonly target: FilePath;
  readonly kind: 'file' | 'directory';
  readonly policy: DestinationPolicy;
  /** The first tracked member, which a refusal names; without `skipErrors` it is addressable. */
  readonly first: IndexEntry;
  /** The addressable members: what actually moves. */
  readonly members: ReadonlyArray<IndexEntry>;
  readonly retained: ReadonlyArray<IndexEntry>;
  readonly opts: MvOptions;
}

const refuseDestination = async (
  ctx: Context,
  byPath: ReadonlyMap<IndexPathKey, IndexEntry>,
  check: DestinationCheck,
): Promise<Verdict | undefined> => {
  const { source, target, kind, policy } = check;
  if (await destinationBeyondSymlink(ctx, policy.scanner, target)) {
    return beyondSymlinkVerdict(check);
  }
  // `dirname` of a validated path is a prefix of it — still a valid repo path.
  const parent = dirname(target) as FilePath;
  // Stryker disable next-line StringLiteral: equivalent — parent is never this literal, and when parent === '' the work-tree root makes isDirectoryOnDisk('') true, so any comparison literal takes the same no-throw path (the `!== ''` short-circuit only spares a redundant lstat)
  if (parent !== '' && !(await isDirectoryOnDisk(ctx, parent))) {
    throw mvDestinationDirectoryMissing(source, target);
  }
  if (await destinationFree(ctx, byPath, source, target, kind, policy)) return undefined;
  return { skip: 'destination-exists' };
};

// An existing destination is never this refusal: it reports as present or as a
// missing directory, whichever the plain checks decide.
const destinationBeyondSymlink = async (
  ctx: Context,
  scanner: LeadingPathScanner,
  target: FilePath,
): Promise<boolean> =>
  (await lstatOrUndefined(ctx, target)) === undefined && (await beyondSymlink(scanner, target));

// Git renames the directory itself through the link and skips each member it
// cannot place; a file has no such partial outcome.
const beyondSymlinkVerdict = ({
  kind,
  source,
  target,
  first,
  members,
  retained,
  opts,
}: DestinationCheck): Verdict => {
  const skip = 'destination-beyond-symlink';
  if (kind === 'file') return { skip };
  if (opts.skipErrors === true) {
    return { kind, entries: [], retained, skippedMembers: members };
  }
  return { skip, source: first.path, target: repath(first, source, target) };
};

// Git names the member it cannot address, in the view a message can carry.
const memberBadSource = (member: IndexEntry, source: FilePath, target: FilePath): Verdict => {
  const escaped = escapedPathOf(member);
  return {
    skip: 'bad-source',
    source: viewOfEscaped(escaped),
    target: viewOfEscaped(`${target}${escaped.slice(source.length)}` as FilePath),
  };
};

type TrackedEntries = readonly [IndexEntry, ...IndexEntry[]];

type SourceClass =
  | { readonly kind: 'file'; readonly entries: TrackedEntries }
  | { readonly kind: 'directory'; readonly entries: TrackedEntries }
  | { readonly kind: 'untracked' };

const classifySource = (
  byPath: ReadonlyMap<IndexPathKey, IndexEntry>,
  source: FilePath,
): SourceClass => {
  const exact = byPath.get(keyOfPath(source));
  if (exact !== undefined) return { kind: 'file', entries: [exact] };
  const prefix = encode(source);
  const entries = Array.from(byPath.values()).filter((entry) =>
    hasBytePrefix(pathBytesOf(entry), prefix),
  );
  const [first, ...rest] = entries;
  if (first === undefined) return { kind: 'untracked' };
  return { kind: 'directory', entries: [first, ...rest] };
};

const sourceExistsOnDisk = async (
  ctx: Context,
  source: FilePath,
  kind: 'file' | 'directory',
): Promise<boolean> => {
  const stat = await lstatOrUndefined(ctx, source);
  if (stat === undefined) return false;
  if (kind === 'directory') return stat.isDirectory && !stat.isSymbolicLink;
  return stat.isFile || stat.isSymbolicLink;
};

// git's `lstat` of the source fails before it consults the index, so an absent path is a bad source.
// A plain directory without a tracked member is "empty" to git; a link or a file is just untracked.
const untrackedVerdictOf = async (ctx: Context, source: FilePath): Promise<PlanSkipReason> => {
  const stat = await lstatOrUndefined(ctx, source);
  if (stat === undefined) return 'bad-source';
  return stat.isDirectory ? 'source-directory-empty' : 'source-not-tracked';
};

interface DestinationPolicy {
  readonly force: boolean;
  readonly ignoreCase: boolean;
  readonly scanner: LeadingPathScanner;
}

// Read once per call: the config does not change under the index lock.
const destinationPolicyOf = async (ctx: Context, opts: MvOptions): Promise<DestinationPolicy> => ({
  force: opts.force === true,
  ignoreCase: (await readConfig(ctx)).core?.ignoreCase === true,
  scanner: createLeadingPathScanner(ctx),
});

const destinationFree = async (
  ctx: Context,
  byPath: ReadonlyMap<IndexPathKey, IndexEntry>,
  source: FilePath,
  target: FilePath,
  kind: 'file' | 'directory',
  policy: DestinationPolicy,
): Promise<boolean> => {
  // Git's escape: a file whose target is its own case variant is the same path on a
  // case-insensitive store. A directory source has no such escape.
  const caseVariantOfFile =
    kind === 'file' && policy.ignoreCase && asciiLower(source) === asciiLower(target);
  const onDisk = !caseVariantOfFile && (await lstatOrUndefined(ctx, target)) !== undefined;
  if (!byPath.has(keyOfPath(target)) && !onDisk) return true;
  // `force` overwrites only a file source; a directory source over an existing
  // path is always refused (verified against git: `mv -f dir present-file` fails).
  return kind === 'file' && policy.force;
};

// Refuse moving both a directory and something inside it (`mv a a/b dir`) — the
// shared subtree would be relocated twice. Faithful to git's
// "cannot move both 'a/b' and its parent directory 'a'".
const assertNoOverlappingSources = (sources: ReadonlyArray<FilePath>): void => {
  for (const parent of sources) {
    for (const child of sources) {
      // equivalent-mutant: a path never startsWith(itself + '/'), so the self-pair is
      // already excluded by the startsWith check; the `child !== parent` operand is
      // redundant and forcing it true cannot change the outcome.
      if (child !== parent && child.startsWith(`${parent}/`)) {
        throw mvOverlappingSources(child, parent);
      }
    }
  }
};

const assertNoTargetCollision = (planned: ReadonlyArray<PlanItem>): void => {
  const seen = new Set<FilePath>();
  for (const item of planned) {
    if (seen.has(item.target)) throw mvMultipleSourcesSameTarget(item.source, item.target);
    seen.add(item.target);
  }
};

const plannedMoves = (planned: ReadonlyArray<PlanItem>): ReadonlyArray<MvMove> => {
  const moves: MvMove[] = [];
  for (const item of planned) {
    for (const entry of item.entries) {
      moves.push({ from: entry.path, to: repath(entry, item.source, item.target) });
    }
  }
  // equivalent-mutant: a move set has unique `from` paths, so `a.from === b.from` is
  // unreachable; the tie-branch (0), the `<`/`>` boundary variants, and the second
  // ternary's value are all indistinguishable for an insertion sort over distinct keys
  // (it only ever moves an element on the strictly-less `-1` result).
  return moves.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
};

const applyToIndex = (
  byPath: Map<IndexPathKey, IndexEntry>,
  indexed: ReadonlyArray<ExecutedItem>,
): void => {
  const moves = indexed.flatMap((executed) => executed.moves);
  for (const { from } of moves) byPath.delete(indexPathKey(from));
  const remaining = Array.from(byPath.values());
  for (const { to } of moves) {
    for (const conflict of conflictsWith(byPath, remaining, to.path)) {
      byPath.delete(indexPathKey(conflict));
    }
    byPath.set(indexPathKey(to), to);
  }
};

// Git's replacement: a file where a directory is needed, or a directory's entries
// where a file now lands, leave the index. `remaining` keeps index order for the search.
const conflictsWith = (
  byPath: ReadonlyMap<IndexPathKey, IndexEntry>,
  remaining: ReadonlyArray<IndexEntry>,
  path: FilePath,
): ReadonlyArray<IndexEntry> => [
  ...entriesAtLeadingDirectories(byPath, path),
  ...entriesBeneath(remaining, path),
];

// `entry.path` is `source` (file) or `${source}/…` (directory member), so the
// suffix after `source` (possibly empty) reparents onto `target` unchanged.
const repath = (entry: IndexEntry, source: FilePath, target: FilePath): FilePath =>
  `${target}${entry.path.slice(source.length)}` as FilePath;

const refusal = (reason: PlanSkipReason, source: FilePath, target: FilePath): TsgitError => {
  switch (reason) {
    case 'source-not-tracked':
      return mvSourceNotTracked(source, target);
    case 'source-directory-empty':
      return mvSourceDirectoryEmpty(source, target);
    case 'bad-source':
      return mvBadSource(source, target);
    case 'destination-exists':
      return mvDestinationExists(source, target);
    case 'into-self':
      return mvIntoSelf(source, target);
    case 'destination-beyond-symlink':
      return mvDestinationBeyondSymlink(source, target);
  }
};

const stripTrailingSlash = (path: string): string =>
  path.endsWith('/') ? path.slice(0, -1) : path;

const workPath = (ctx: Context, path: FilePath): string =>
  joinPath(requireWorkTree(ctx, 'mv'), path);

const lstatOrUndefined = async (
  ctx: Context,
  path: FilePath,
): Promise<Awaited<ReturnType<Context['fs']['lstat']>> | undefined> =>
  ctx.fs.lstat(workPath(ctx, path)).catch(() => undefined);

const statOrUndefined = async (
  ctx: Context,
  path: FilePath,
): Promise<Awaited<ReturnType<Context['fs']['stat']>> | undefined> =>
  ctx.fs.stat(workPath(ctx, path)).catch(() => undefined);

const isDirectoryOnDisk = async (ctx: Context, path: FilePath): Promise<boolean> => {
  // `stat` follows the parent's own link, as `rename(2)` does.
  return (await statOrUndefined(ctx, path))?.isDirectory === true;
};
