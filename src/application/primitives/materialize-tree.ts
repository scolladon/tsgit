/**
 * Compose `walkTree → computeChangeset → applyChangeset` to update the
 * working tree to a target tree's contents.
 *
 * - Branch switch mode: `paths === undefined` — diff the entire current
 *  index against the entire target tree.
 * - Path-restore mode: `paths !== undefined` — restrict both sides of
 *  the diff to those paths.
 *
 * Returns the new IndexEntry list for the caller to commit, plus
 * written/deleted counts. The primitive does NOT commit the index — the
 * caller decides.
 *
 * ## Stat-source contract for `newIndexEntries` (load-bearing for)
 *
 * - **Paths that were written/added** (`add` or `update` changeset entries):
 *  the IndexEntry carries **post-write `lstat`-derived stat fields**
 *  (ctime/mtime/dev/ino/uid/gid/fileSize). These reflect the file we just
 *  wrote, so the next `status` runs the fast `isStatClean` path.
 * - **Paths whose changeset classification was `noop`** (skipped — index
 *  already matched target by `id + mode`): the IndexEntry is the caller's
 *  `currentIndex` entry verbatim. Donor stats survive across the call.
 * - An up-to-date noop under `forceRewriteAll` keeps its donor entry too; only a noop whose
 *  work-tree path is not up to date (absent, changed, or unreachable) is rewritten, so its
 *  entry carries the post-write stats.
 */

import { checkoutOverwriteDirty } from '../../domain/commands/error.js';
import { comparePaths } from '../../domain/diff/index.js';
import { type GitIndex, type IndexEntry, skipWorktreeEntry } from '../../domain/git-index/index.js';
import {
  escapedPathOf,
  type IndexPath,
  type IndexPathKey,
  indexPathKey,
  keyOfPath,
} from '../../domain/git-index/index-path-key.js';
import { pathComparatorFor } from '../../domain/git-index/index-writer.js';
import { NO_PARSER_OFFSET } from '../../domain/git-index/path-validator.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../domain/objects/index.js';
import type { SparseMatcher } from '../../domain/sparse/index.js';
import type { Context } from '../../ports/context.js';
import {
  type ApplyChangesetOpts,
  type ApplyChangesetResult,
  applyChangesetWithAttributes,
  type IgnoredOccupants,
  type UnmergedPaths,
  type UntrackedOccupants,
} from './apply-changeset.js';
import { racyContentMatcher } from './compare-working-tree-entry.js';
import {
  type Changeset,
  type ChangesetEntry,
  type ChangesetStats,
  computeChangeset,
  pathFields,
} from './compute-changeset.js';
import { readConfig } from './config-read.js';
import type { CheckoutMetadata } from './internal/apply-smudge-filter.js';
import { lstatIfReachable } from './internal/fs-probes.js';
import { indexPathRulesOf } from './internal/index-path-rules.js';
import { indexRuleEntries } from './internal/index-rule-entries.js';
import { matchesCachedStat, type RacyContentCheck } from './internal/is-entry-stat-clean.js';
import { joinPath } from './internal/join-working-tree-path.js';
import { lazily } from './internal/lazily.js';
import { diffTreesPruned, isBelowShared } from './internal/pruned-tree-diff.js';
import {
  type AttributeDirection,
  attributeBlobLookup,
  isAttributesPath,
} from './internal/read-gitattributes.js';
import { requireWorkTree } from './internal/repo-state.js';
import { type IsVerified, NOTHING_VERIFIED } from './internal/smudge-racily-clean.js';
import { type StaleRule, upgradeStaleNoops } from './internal/stale-entries.js';
import { carryStagedChanges } from './internal/two-way-carry.js';
import { walkTreeWithLossyBytes } from './walk-tree.js';

export interface MaterializeTreeOpts {
  readonly targetTree: ObjectId;
  readonly currentIndex: GitIndex;
  readonly force?: boolean;
  /**
   * Restrict the materialisation to these paths. A path selects the entry whose raw name it
   * encodes; a well-formed path never selects an entry whose raw name is not UTF-8.
   */
  readonly paths?: ReadonlySet<FilePath>;
  /**
   * git's one-way-merge reset: a no-op entry (the index already records the target) whose
   * work-tree path is not up to date, whether absent, changed or unreachable, is rewritten.
   * An up-to-date entry is left alone and a skip-worktree entry is never judged.
   * Default `false`: a no-op entry is never rewritten.
   */
  readonly forceRewriteAll?: boolean;
  /** The ref and commit the checkout moves to, told to a smudging process filter. */
  readonly checkoutMetadata?: CheckoutMetadata;
  /**
   * Branch-switch sparse-checkout filter. Honoured ONLY when `paths` is
   * undefined. A target-tree path the matcher rejects is NOT written to the
   * working tree; its `newIndexEntries` record carries `skipWorktree: true`
   * (the index keeps every path — git-faithful). A path the matcher accepts
   * that the *current* index records as skip-worktree (absent on disk) is
   * materialised even when its `id` matches, because the current index is
   * filtered to drop skip-worktree entries before the diff — such a path
   * classifies as `add`, never `noop`.
   */
  readonly sparse?: SparseMatcher;
  /**
   * The tree HEAD points at, set only by a non-forced branch switch. It turns the
   * index→target diff into git's two-way merge: a path HEAD and the target agree on keeps
   * its index entry and work file, and a path the index changed to a third version refuses.
   * A kept path the switch needs for a file or a directory does not stay.
   */
  readonly headTree?: ObjectId;
  /**
   * `protect` refuses an ignored occupant like an untracked one (git's `overwrite_ignore = 0`);
   * default `overwrite`.
   */
  readonly ignoredOccupants?: IgnoredOccupants;
  /**
   * `protect` refuses an untracked occupant even when forced (git's `reset_head` with
   * `UNPACK_RESET_PROTECT_UNTRACKED`); default `overwrite`.
   */
  readonly untrackedOccupants?: UntrackedOccupants;
  /**
   * `reset` resets a conflicted path to the target without the up-to-date check; default
   * `hidden`, where a conflicted path is invisible to the apply.
   */
  readonly unmergedPaths?: UnmergedPaths;
}

export interface MaterializeTreeResult {
  readonly newIndexEntries: ReadonlyArray<IndexEntry>;
  /** Count of work-tree rewrites; an up-to-date entry left alone is not counted. */
  readonly written: number;
  readonly deleted: number;
}

interface TargetEntry {
  readonly path: FilePath;
  readonly pathBytes?: Uint8Array;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const collectTargetEntries = async (ctx: Context, treeId: ObjectId): Promise<TargetEntry[]> => {
  const collected: TargetEntry[] = [];
  for await (const entry of walkTreeWithLossyBytes(ctx, treeId)) {
    if (entry.mode === FILE_MODE.DIRECTORY) continue;
    collected.push(entry);
  }
  return collected;
};

const filterByPaths = <T extends IndexPath>(
  entries: ReadonlyArray<T>,
  paths: ReadonlySet<FilePath>,
): T[] => entries.filter((e) => paths.has(escapedPathOf(e)));

const indexEntriesByPath = (index: GitIndex): Map<IndexPathKey, IndexEntry> => {
  const out = new Map<IndexPathKey, IndexEntry>();
  for (const entry of index.entries) {
    if (entry.flags.stage === 0) out.set(indexPathKey(entry), entry);
  }
  return out;
};

const writtenEntriesByPath = (
  writtenEntries: ReadonlyArray<IndexEntry>,
): Map<IndexPathKey, IndexEntry> => {
  const out = new Map<IndexPathKey, IndexEntry>();
  for (const entry of writtenEntries) out.set(indexPathKey(entry), entry);
  return out;
};

const PATH_SEPARATOR = '/';

const leadingDirectoriesOf = (path: string): string[] => {
  const dirs: string[] = [];
  for (let i = path.indexOf(PATH_SEPARATOR); i !== -1; i = path.indexOf(PATH_SEPARATOR, i + 1)) {
    dirs.push(path.slice(0, i));
  }
  return dirs;
};

/** A path a restored target entry would stand on, or lie beneath, as a file or directory. */
const collidesWithTarget = (
  path: string,
  targetPaths: ReadonlySet<string>,
  targetDirectories: ReadonlySet<string>,
): boolean =>
  targetDirectories.has(path) || leadingDirectoriesOf(path).some((d) => targetPaths.has(d));

/**
 * Every stage of every out-of-scope path survives, so another path's conflict is kept, except
 * a path colliding with a restored one as file and directory — git's path restore drops it.
 */
const preserveOutOfScope = (
  currentIndex: GitIndex,
  scopedPaths: ReadonlySet<FilePath> | undefined,
  target: ReadonlyArray<TargetEntry>,
): IndexEntry[] => {
  if (scopedPaths === undefined) return [];
  const targetPaths = new Set<string>(target.map((t) => t.path));
  const targetDirectories = new Set<string>(target.flatMap((t) => leadingDirectoriesOf(t.path)));
  return currentIndex.entries.filter((e) => {
    const path = escapedPathOf(e);
    return !scopedPaths.has(path) && !collidesWithTarget(path, targetPaths, targetDirectories);
  });
};

// git's copy_cache_entry keeps CE_VALID when a rewrite lands on the same blob and mode.
const keepsAssumeValid = (old: IndexEntry | undefined, written: IndexEntry): boolean =>
  old?.flags.assumeValid === true && old.id === written.id && old.mode === written.mode;

const withAssumeValid = (entry: IndexEntry): IndexEntry => ({
  ...entry,
  flags: { ...entry.flags, assumeValid: true },
});

const pickEntry = (
  entry: TargetEntry,
  writtenByPath: ReadonlyMap<IndexPathKey, IndexEntry>,
  oldByPath: ReadonlyMap<IndexPathKey, IndexEntry>,
): IndexEntry | undefined => {
  const key = indexPathKey(entry);
  const written = writtenByPath.get(key);
  const old = oldByPath.get(key);
  if (written === undefined) return old;
  return keepsAssumeValid(old, written) ? withAssumeValid(written) : written;
};

const mergeNewIndexEntries = (
  writtenEntries: ReadonlyArray<IndexEntry>,
  currentIndex: GitIndex,
  target: ReadonlyArray<TargetEntry>,
  scopedPaths: ReadonlySet<FilePath> | undefined,
): ReadonlyArray<IndexEntry> => {
  const writtenByPath = writtenEntriesByPath(writtenEntries);
  const oldByPath = indexEntriesByPath(currentIndex);

  const merged: IndexEntry[] = preserveOutOfScope(currentIndex, scopedPaths, target);
  for (const entry of target) {
    const picked = pickEntry(entry, writtenByPath, oldByPath);
    if (picked !== undefined) merged.push(picked);
  }
  merged.sort(pathComparatorFor(merged));
  return merged;
};

const tallyStats = (entries: ReadonlyArray<ChangesetEntry>): ChangesetStats => {
  const stats = { add: 0, update: 0, delete: 0, noop: 0 };
  for (const entry of entries) stats[entry.kind] += 1;
  return stats;
};

const lowestStageOfUnmerged = (index: GitIndex): Map<IndexPathKey, IndexEntry> => {
  const staged = new Map<IndexPathKey, IndexEntry>();
  const merged = new Set<IndexPathKey>();
  for (const entry of index.entries) {
    const key = indexPathKey(entry);
    if (entry.flags.stage === 0) merged.add(key);
    // Stryker disable next-line EqualityOperator: equivalent — a tie needs two entries with the same path and stage, which an index cannot hold, so `>=` only swaps an entry for its twin.
    else if ((staged.get(key)?.flags.stage ?? Infinity) > entry.flags.stage) staged.set(key, entry);
  }
  for (const key of merged) staged.delete(key);
  return staged;
};

// An unmerged path has no previous version to compare, so its entry carries none.
const resetUnmergedEntry = (low: IndexEntry, target: TargetEntry | undefined): ChangesetEntry =>
  target === undefined
    ? {
        kind: 'delete',
        ...pathFields(low),
        mode: low.mode,
        id: undefined,
        previousId: undefined,
        previousMode: low.mode,
      }
    : {
        kind: 'update',
        ...pathFields(target),
        mode: target.mode,
        id: target.id,
        previousId: undefined,
        previousMode: undefined,
      };

/** Makes conflicted paths visible to the apply: each becomes an update or delete to the target. */
const projectUnmergedPaths = (
  changeset: Changeset,
  currentIndex: GitIndex,
  target: ReadonlyArray<TargetEntry>,
): Changeset => {
  const unmerged = lowestStageOfUnmerged(currentIndex);
  const targetByKey = new Map(target.map((e) => [indexPathKey(e), e]));
  const entries = [
    ...changeset.entries.filter((e) => !unmerged.has(indexPathKey(e))),
    ...[...unmerged].map(([key, low]) => resetUnmergedEntry(low, targetByKey.get(key))),
  ];
  return { entries: entries.sort(pathComparatorFor(entries)), stats: tallyStats(entries) };
};

interface JudgedChangeset {
  readonly changeset: Changeset;
  readonly verified: IsVerified;
}

const rewriteStaleNoops = async (
  ctx: Context,
  changeset: Changeset,
  index: GitIndex,
  workdir: string,
  rule: StaleRule,
): Promise<JudgedChangeset> => {
  const { entries, upToDate } = await upgradeStaleNoops(
    ctx,
    changeset.entries,
    index,
    workdir,
    rule,
  );
  return {
    changeset: { entries, stats: tallyStats(entries) },
    verified: (path) => upToDate.has(path),
  };
};

/** Path-sort the merged entry list (in-pattern + synthesised excluded). */
const sortIndexEntries = (entries: ReadonlyArray<IndexEntry>): IndexEntry[] =>
  [...entries].sort(pathComparatorFor(entries));

interface MaterializePlan {
  readonly target: ReadonlyArray<TargetEntry>;
  readonly indexForDiff: GitIndex;
  /** Target paths the sparse matcher excluded — synthesised as skip-worktree. */
  readonly excluded: ReadonlyArray<TargetEntry>;
}

/**
 * Resolve the three materialisation modes into one uniform plan:
 * - path-restore (`paths` set) — both diff sides scoped to those paths;
 * - sparse branch-switch (`sparse` set, `paths` undefined) — target scoped to
 *   in-pattern paths, the diff base stripped of skip-worktree entries (so an
 *   excluded→included path is an `add`, not a `noop`), excluded paths split off;
 * - plain — the whole tree against the whole index.
 */
const planMaterialize = (
  allTarget: ReadonlyArray<TargetEntry>,
  opts: MaterializeTreeOpts,
): MaterializePlan => {
  if (opts.paths !== undefined) {
    return {
      target: filterByPaths(allTarget, opts.paths),
      indexForDiff: {
        ...opts.currentIndex,
        entries: filterByPaths(opts.currentIndex.entries, opts.paths),
      },
      excluded: [],
    };
  }
  const sparse = opts.sparse;
  if (sparse !== undefined) {
    // Partition in a single pass — one matcher call per target entry, not two.
    const target: TargetEntry[] = [];
    const excluded: TargetEntry[] = [];
    for (const entry of allTarget) {
      (sparse(entry.path) ? target : excluded).push(entry);
    }
    return {
      target,
      indexForDiff: {
        ...opts.currentIndex,
        entries: opts.currentIndex.entries.filter((e) => !e.flags.skipWorktree),
      },
      excluded,
    };
  }
  return { target: allTarget, indexForDiff: opts.currentIndex, excluded: [] };
};

/**
 * Git reads `.gitattributes` for a checkout from the index it is producing:
 * a path restore keeps the work tree first over the current index overlaid
 * with the restored paths, every other checkout reads the result index first.
 */
const checkoutDirection = (
  opts: MaterializeTreeOpts,
  plan: MaterializePlan,
): AttributeDirection => {
  const { paths } = opts;
  if (paths === undefined) {
    return {
      kind: 'index-first',
      index: attributeBlobLookup([...plan.target, ...plan.excluded]),
    };
  }
  const kept = indexRuleEntries(
    // Stryker disable next-line MethodExpression: equivalent — `kept` feeds only attributeBlobLookup, whose attributeBlobMap re-applies isAttributesPath; the pre-filter only keeps indexRuleEntries off non-attribute entries.
    opts.currentIndex.entries.filter((entry) => isAttributesPath(entry.path)),
  ).filter((entry) => !paths.has(escapedPathOf(entry)));
  return { kind: 'worktree-first', index: attributeBlobLookup([...kept, ...plan.target]) };
};

interface CarriedOpts {
  readonly opts: MaterializeTreeOpts;
  readonly allTarget: ReadonlyArray<TargetEntry>;
  /** Stage-0 entries git keeps untouched. */
  readonly carried: ReadonlyArray<IndexEntry>;
  /** Work files a directory replaces without a content check, as git does under sparse checkout. */
  readonly removals: ReadonlyArray<ChangesetEntry>;
}

/**
 * git re-evaluates the sparse patterns of every path the index holds, so these
 * never stay put; a path absent from the index (a staged deletion) stays absent.
 */
const sparseMovers = (
  sparse: SparseMatcher | undefined,
  index: ReadonlyArray<IndexEntry>,
): Set<IndexPathKey> => {
  if (sparse === undefined) return new Set();
  const outside = index.filter((e) => !sparse(e.path));
  const hidden = index.filter((e) => e.flags.skipWorktree);
  return new Set([...outside, ...hidden].map(indexPathKey));
};

interface HeadAgreement {
  /** Paths whose index entry (or absence) the switch leaves alone. */
  readonly agreed: (key: IndexPathKey) => boolean;
}

/** Applies git's two-way rule over HEAD, the target and the index, or refuses. */
const agreementWithHead = async (
  ctx: Context,
  opts: MaterializeTreeOpts & { readonly headTree: ObjectId },
  allTarget: ReadonlyArray<TargetEntry>,
  stageZero: ReadonlyArray<IndexEntry>,
): Promise<HeadAgreement> => {
  const { oldFiles, sharedDirs } = await diffTreesPruned(ctx, opts.headTree, opts.targetTree);
  const unshared = (e: IndexPath): boolean => !isBelowShared(sharedDirs, indexPathKey(e));
  const carry = carryStagedChanges(
    oldFiles,
    // Stryker disable next-line MethodExpression: equivalent — the index side below is still filtered, so no key under a shared directory has a staged version, and with no HEAD version either it is neither kept nor refused; the filter only bounds the map size.
    allTarget.filter(unshared),
    // Stryker disable next-line MethodExpression: equivalent — the target side above is still filtered, so a key under a shared directory has neither a HEAD nor a target version and counts as kept, which `agreed` already says of it; the filter only bounds the map size.
    stageZero.filter(unshared),
  );
  if (carry.refused.length > 0) {
    throw checkoutOverwriteDirty({
      localChanges: [...carry.refused].sort(comparePaths),
      untracked: [],
    });
  }
  return { agreed: (key) => carry.kept.has(key) || isBelowShared(sharedDirs, key) };
};

/** Kept entries a written target path displaces: under a file it writes, or in the way of a directory it needs. */
interface Displaced {
  /** Leave the carry and meet the one-way diff as deletions: dirty-checked, then removed. */
  readonly deletions: ReadonlySet<IndexPathKey>;
  /** Leave the carry and the diff: an added path meets the file as a leading obstruction. */
  readonly dropped: ReadonlySet<IndexPathKey>;
}

const keysOf = (entries: ReadonlyArray<IndexPath>): Set<IndexPathKey> =>
  new Set(entries.map(indexPathKey));

/** git's icase_exists: a stat-clean tracked file in an added path's way may be replaced. */
const obstructionMayGo = async (
  ctx: Context,
  index: GitIndex,
  entry: IndexEntry,
  contentMatches: RacyContentCheck,
): Promise<boolean> => {
  const absPath = joinPath(requireWorkTree(ctx, 'materializeTree'), escapedPathOf(entry));
  const stat = await lstatIfReachable(ctx.fs, absPath);
  if (stat === undefined) return false;
  return matchesCachedStat({ entry, indexMtime: index.indexMtime }, absPath, stat, contentMatches);
};

/** The colliders git may remove: none unless core.ignoreCase; the config is read only when one exists. */
const clearedObstructions = async (
  ctx: Context,
  index: GitIndex,
  over: ReadonlyArray<IndexEntry>,
): Promise<IndexEntry[]> => {
  const ignoreCase = lazily(async () => (await readConfig(ctx)).core?.ignoreCase === true);
  const contentMatches = racyContentMatcher(ctx);
  const going: IndexEntry[] = [];
  for (const entry of over) {
    if ((await ignoreCase()) && (await obstructionMayGo(ctx, index, entry, contentMatches))) {
      going.push(entry);
    }
  }
  return going;
};

/** Index of the first entry at or after `needle` in byte order; `sorted` is in index order. */
const firstAtOrAfter = (sorted: ReadonlyArray<IndexEntry>, needle: FilePath): number => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (comparePaths(escapedPathOf(sorted[mid] as IndexEntry), needle) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
};

/** The entries of `sorted` (index order) lying beneath the directory `path`: one contiguous run. */
const entriesBeneath = (sorted: ReadonlyArray<IndexEntry>, path: string): IndexEntry[] => {
  const prefix = `${path}${PATH_SEPARATOR}`;
  const found: IndexEntry[] = [];
  for (let i = firstAtOrAfter(sorted, prefix as FilePath); i < sorted.length; i++) {
    const entry = sorted[i] as IndexEntry;
    if (!escapedPathOf(entry).startsWith(prefix)) break;
    found.push(entry);
  }
  return found;
};

/** Splits the kept entries a written path displaces: beneath a written file, or in the way of a written directory. */
const displacedByTarget = async (
  ctx: Context,
  index: GitIndex,
  kept: ReadonlyArray<IndexEntry>,
  written: ReadonlyArray<TargetEntry>,
): Promise<Displaced> => {
  const dirs = new Set<string>(written.flatMap((t) => leadingDirectoriesOf(t.path)));
  const over = kept.filter((e) => dirs.has(escapedPathOf(e)));
  const going = await clearedObstructions(ctx, index, over);
  const beneath = written.flatMap((t) => entriesBeneath(kept, t.path));
  return {
    deletions: keysOf([...beneath, ...going]),
    dropped: keysOf(over.filter((e) => !going.includes(e))),
  };
};

/**
 * A file and a directory colliding while sparse checkout is on: the directory side stays in the
 * index, the file side leaves it. A file the patterns exclude is left alone in the work tree.
 */
interface SparseCollisions {
  /** Target files that give way to an index entry beneath them. */
  readonly targetFiles: ReadonlySet<IndexPathKey>;
  /** Index files that give way to a target path beneath them. */
  readonly indexFiles: ReadonlySet<IndexPathKey>;
  /** Index files standing above a target path inside the patterns: the directory replaces them on disk. */
  readonly replaced: ReadonlySet<IndexPathKey>;
  /** Sparse movers inside the patterns beneath a target file that gives way. */
  readonly surfaced: ReadonlySet<IndexPathKey>;
}

const NO_SPARSE_COLLISIONS: SparseCollisions = {
  targetFiles: new Set(),
  indexFiles: new Set(),
  replaced: new Set(),
  surfaced: new Set(),
};

interface IndexSides {
  /** Agreed entries the switch leaves alone, in index order. */
  readonly kept: ReadonlyArray<IndexEntry>;
  /** Sparse movers the target lacks, in index order. */
  readonly movers: ReadonlyArray<IndexEntry>;
}

/** The index files a target path stands beneath. */
const indexFilesAbove = (keys: ReadonlySet<IndexPathKey>, target: TargetEntry): IndexPathKey[] =>
  leadingDirectoriesOf(target.path)
    .map((dir) => keyOfPath(dir as FilePath))
    .filter((key) => keys.has(key));

interface TargetContribution {
  readonly isTargetFile: boolean;
  readonly surfaced: Iterable<IndexPathKey>;
  readonly indexFiles: Iterable<IndexPathKey>;
  readonly replaced: Iterable<IndexPathKey>;
}

const contributionOf = (
  sparse: SparseMatcher,
  sides: IndexSides,
  keys: ReadonlySet<IndexPathKey>,
  target: TargetEntry,
): TargetContribution => {
  const inPattern = sparse(target.path);
  const moversBelow = entriesBeneath(sides.movers, target.path);
  const indexFiles = indexFilesAbove(keys, target);
  return {
    isTargetFile: moversBelow.length + entriesBeneath(sides.kept, target.path).length > 0,
    surfaced: inPattern ? keysOf(moversBelow.filter((e) => sparse(e.path))) : [],
    indexFiles,
    replaced: inPattern ? indexFiles : [],
  };
};

const sparseCollisions = (
  sparse: SparseMatcher,
  sides: IndexSides,
  written: ReadonlyArray<TargetEntry>,
): SparseCollisions => {
  const keys = keysOf([...sides.kept, ...sides.movers]);
  const targetFiles = new Set<IndexPathKey>();
  const indexFiles = new Set<IndexPathKey>();
  const replaced = new Set<IndexPathKey>();
  const surfaced = new Set<IndexPathKey>();
  for (const target of written) {
    const contribution = contributionOf(sparse, sides, keys, target);
    if (contribution.isTargetFile) targetFiles.add(indexPathKey(target));
    for (const key of contribution.surfaced) surfaced.add(key);
    for (const key of contribution.indexFiles) indexFiles.add(key);
    for (const key of contribution.replaced) replaced.add(key);
  }
  return { targetFiles, indexFiles, replaced, surfaced };
};

const surfacedEntry = (entry: IndexEntry): IndexEntry => ({
  ...entry,
  flags: { ...entry.flags, skipWorktree: false },
});

interface CarrySplit {
  readonly stageZero: ReadonlyArray<IndexEntry>;
  readonly isKept: (key: IndexPathKey) => boolean;
  readonly dropped: ReadonlySet<IndexPathKey>;
  readonly droppedTarget: ReadonlySet<IndexPathKey>;
  readonly outsideTarget: ReadonlyArray<IndexEntry>;
  readonly surfaced: ReadonlyArray<IndexEntry>;
  readonly removals: ReadonlyArray<ChangesetEntry>;
}

const indexWithout = (
  index: MaterializeTreeOpts['currentIndex'],
  carried: ReadonlySet<IndexEntry>,
  dropped: ReadonlySet<IndexPathKey>,
): MaterializeTreeOpts['currentIndex'] => ({
  ...index,
  entries: index.entries.filter((e) => !carried.has(e) && !dropped.has(indexPathKey(e))),
});

const carriedOptsOf = (
  opts: MaterializeTreeOpts,
  allTarget: ReadonlyArray<TargetEntry>,
  { stageZero, isKept, dropped, droppedTarget, outsideTarget, surfaced, removals }: CarrySplit,
): CarriedOpts => {
  const carried = new Set(stageZero.filter((e) => isKept(indexPathKey(e))));
  return {
    opts: { ...opts, currentIndex: indexWithout(opts.currentIndex, carried, dropped) },
    allTarget: [
      ...allTarget.filter((e) => !isKept(indexPathKey(e)) && !droppedTarget.has(indexPathKey(e))),
      ...outsideTarget,
    ],
    carried: [...carried, ...surfaced.map(surfacedEntry)],
    removals,
  };
};

const inPatternOf = (
  sparse: SparseMatcher | undefined,
  written: ReadonlyArray<TargetEntry>,
): ReadonlyArray<TargetEntry> =>
  sparse === undefined ? written : written.filter((t) => sparse(t.path));

/** git leaves a path alone when an untracked file already stands where one of its directories belongs. */
const shadowedByFile = async (
  ctx: Context,
  surfaced: ReadonlyArray<IndexEntry>,
): Promise<IndexEntry[]> => {
  const workdir = requireWorkTree(ctx, 'materializeTree');
  const shadowed: IndexEntry[] = [];
  for (const entry of surfaced) {
    for (const dir of leadingDirectoriesOf(escapedPathOf(entry))) {
      const stat = await lstatIfReachable(ctx.fs, joinPath(workdir, dir));
      if (stat !== undefined && !stat.isDirectory) {
        shadowed.push(entry);
        break;
      }
    }
  }
  return shadowed;
};

/** The replaced files still on disk, each as a deletion with no previous version to compare. */
const removalsOf = async (
  ctx: Context,
  replaced: ReadonlyArray<IndexEntry>,
): Promise<ChangesetEntry[]> => {
  const workdir = requireWorkTree(ctx, 'materializeTree');
  const removals: ChangesetEntry[] = [];
  for (const entry of replaced) {
    const stat = await lstatIfReachable(ctx.fs, joinPath(workdir, escapedPathOf(entry)));
    if (stat === undefined || stat.isDirectory) continue;
    removals.push({
      kind: 'delete',
      ...pathFields(entry),
      mode: entry.mode,
      id: undefined,
      previousId: undefined,
      previousMode: entry.mode,
    });
  }
  return removals;
};

interface CarryPartition {
  readonly kept: ReadonlyArray<IndexEntry>;
  readonly keptKeys: ReadonlySet<IndexPathKey>;
  readonly outside: ReadonlyArray<IndexEntry>;
  readonly written: ReadonlyArray<TargetEntry>;
}

const partitionCarry = (
  allTarget: ReadonlyArray<TargetEntry>,
  stageZero: ReadonlyArray<IndexEntry>,
  agreed: (key: IndexPathKey) => boolean,
  movers: ReadonlySet<IndexPathKey>,
): CarryPartition => {
  const agreedKept = (e: IndexPath): boolean =>
    agreed(indexPathKey(e)) && !movers.has(indexPathKey(e));
  const kept = stageZero.filter(agreedKept);
  const keptKeys = keysOf([...kept, ...allTarget.filter(agreedKept)]);
  const outside = stagedOutsideTarget(stageZero, allTarget, agreed, movers);
  // An agreed path displaces nothing.
  const written = allTarget.filter((e) => !keptKeys.has(indexPathKey(e)));
  return { kept, keptKeys, outside, written };
};

interface CarryCollisions {
  readonly collisions: SparseCollisions;
  readonly displaced: Awaited<ReturnType<typeof displacedByTarget>>;
  readonly dropped: ReadonlySet<IndexPathKey>;
  readonly shadowed: ReadonlyArray<IndexEntry>;
  readonly removals: ReadonlyArray<ChangesetEntry>;
}

const surfacedAndReplaced = async (
  ctx: Context,
  { kept, outside }: CarryPartition,
  collisions: SparseCollisions,
): Promise<Pick<CarryCollisions, 'shadowed' | 'removals'>> => {
  const shadowed = await shadowedByFile(
    ctx,
    outside.filter((e) => collisions.surfaced.has(indexPathKey(e))),
  );
  const removals = await removalsOf(
    ctx,
    [...kept, ...outside].filter((e) => collisions.replaced.has(indexPathKey(e))),
  );
  return { shadowed, removals };
};

const resolveCarryCollisions = async (
  ctx: Context,
  opts: MaterializeTreeOpts,
  partition: CarryPartition,
): Promise<CarryCollisions> => {
  const { kept, outside, written } = partition;
  const collisions =
    opts.sparse === undefined
      ? NO_SPARSE_COLLISIONS
      : sparseCollisions(opts.sparse, { kept, movers: outside }, written);
  const displaced = await displacedByTarget(
    ctx,
    opts.currentIndex,
    kept,
    inPatternOf(opts.sparse, written).filter((t) => !collisions.targetFiles.has(indexPathKey(t))),
  );
  const dropped = new Set([...displaced.dropped, ...collisions.indexFiles]);
  const { shadowed, removals } = await surfacedAndReplaced(ctx, partition, collisions);
  return { collisions, displaced, dropped, shadowed, removals };
};

const carrySplitOf = (
  stageZero: ReadonlyArray<IndexEntry>,
  { keptKeys, outside }: CarryPartition,
  { collisions, displaced, dropped, shadowed, removals }: CarryCollisions,
): CarrySplit => {
  const shadowedKeys = keysOf(shadowed);
  return {
    stageZero,
    isKept: (key) => keptKeys.has(key) && !displaced.deletions.has(key) && !dropped.has(key),
    dropped,
    droppedTarget: collisions.targetFiles,
    outsideTarget: outside.filter(
      (e) => !collisions.indexFiles.has(indexPathKey(e)) && !shadowedKeys.has(indexPathKey(e)),
    ),
    surfaced: shadowed,
    removals,
  };
};

/** Applies the two-way merge of a branch switch: refuses, or sets the kept paths aside. */
const carryHeadAgreement = async (
  ctx: Context,
  opts: MaterializeTreeOpts,
  allTarget: ReadonlyArray<TargetEntry>,
): Promise<CarriedOpts> => {
  if (opts.headTree === undefined) return { opts, allTarget, carried: [], removals: [] };
  const stageZero = opts.currentIndex.entries.filter((e) => e.flags.stage === 0);
  const { agreed } = await agreementWithHead(
    ctx,
    { ...opts, headTree: opts.headTree },
    allTarget,
    stageZero,
  );
  const movers = sparseMovers(opts.sparse, stageZero);
  const partition = partitionCarry(allTarget, stageZero, agreed, movers);
  const resolved = await resolveCarryCollisions(ctx, opts, partition);
  return carriedOptsOf(opts, allTarget, carrySplitOf(stageZero, partition, resolved));
};

/** A staged path the target lacks and the patterns exclude still belongs to the index, as skip-worktree. */
const stagedOutsideTarget = (
  stageZero: ReadonlyArray<IndexEntry>,
  allTarget: ReadonlyArray<TargetEntry>,
  agreed: (key: IndexPathKey) => boolean,
  movers: ReadonlySet<IndexPathKey>,
): IndexEntry[] => {
  const inTarget = new Set(allTarget.map(indexPathKey));
  return stageZero.filter((e) => {
    const key = indexPathKey(e);
    return movers.has(key) && agreed(key) && !inTarget.has(key);
  });
};

export const materializeTree = async (
  ctx: Context,
  options: MaterializeTreeOpts,
): Promise<MaterializeTreeResult> => {
  const { newIndexEntries, written, deleted } = await materializeTreeJudging(
    ctx,
    options,
    'oneway',
  );
  return { newIndexEntries, written, deleted };
};

/** What the stale pass found up to date, for the index commit; not part of the public surface. */
export interface JudgedMaterialization extends MaterializeTreeResult {
  readonly verified: IsVerified;
}

const validateExcludedPaths = (ctx: Context, excluded: ReadonlyArray<TargetEntry>): void => {
  // Excluded entries skip the changeset, yet git verifies every path it adds to the index.
  const pathRules = indexPathRulesOf(ctx);
  for (const entry of excluded) {
    pathRules.validateIndexPath(entry.path, NO_PARSER_OFFSET, entry.mode, entry.pathBytes);
  }
};

const classifyChangeset = async (
  ctx: Context,
  plan: MaterializePlan,
  opts: MaterializeTreeOpts,
  workdir: string,
  staleRule: StaleRule,
): Promise<JudgedChangeset> => {
  const computed = computeChangeset(plan.indexForDiff, plan.target);
  const rawChangeset =
    opts.unmergedPaths === 'reset'
      ? projectUnmergedPaths(computed, plan.indexForDiff, plan.target)
      : computed;
  if (opts.forceRewriteAll !== true) {
    return { changeset: rawChangeset, verified: NOTHING_VERIFIED };
  }
  return rewriteStaleNoops(ctx, rawChangeset, plan.indexForDiff, workdir, staleRule);
};

const withRemovals = (changeset: Changeset, removals: ReadonlyArray<ChangesetEntry>): Changeset => {
  if (removals.length === 0) return changeset;
  const entries = [...changeset.entries, ...removals];
  return { entries: entries.sort(pathComparatorFor(entries)), stats: tallyStats(entries) };
};

const applyOptionsOf = (
  opts: MaterializeTreeOpts,
  changeset: Changeset,
  workdir: string,
): ApplyChangesetOpts => ({
  changeset,
  force: opts.force ?? false,
  ...(opts.ignoredOccupants && { ignoredOccupants: opts.ignoredOccupants }),
  ...(opts.untrackedOccupants && { untrackedOccupants: opts.untrackedOccupants }),
  ...(opts.unmergedPaths && { unmergedPaths: opts.unmergedPaths }),
  workdir,
  ...(opts.checkoutMetadata && { checkoutMetadata: opts.checkoutMetadata }),
});

const assembleIndexEntries = (
  result: ApplyChangesetResult,
  opts: MaterializeTreeOpts,
  plan: MaterializePlan,
  carried: ReadonlyArray<IndexEntry>,
): ReadonlyArray<IndexEntry> => {
  const inScope = mergeNewIndexEntries(
    result.writtenEntries,
    opts.currentIndex,
    plan.target,
    opts.paths,
  );
  // Sparse branch-switch: append one synthesised skip-worktree entry per
  // excluded target path so the index keeps every tracked path (git-faithful).
  // Stryker disable next-line ConditionalExpression: equivalent — forcing the guard false re-sorts the already path-sorted `inScope` (from `mergeNewIndexEntries`, same comparator) into a content-identical list; the guard only skips that redundant work.
  if (plan.excluded.length === 0 && carried.length === 0) return inScope;
  return sortIndexEntries([...inScope, ...carried, ...plan.excluded.map(skipWorktreeEntry)]);
};

/** `materializeTree` with the routine that judges a stale entry named; not part of the public surface. */
export const materializeTreeJudging = async (
  ctx: Context,
  options: MaterializeTreeOpts,
  staleRule: StaleRule,
): Promise<JudgedMaterialization> => {
  const fullTarget = await collectTargetEntries(ctx, options.targetTree);
  const { opts, allTarget, carried, removals } = await carryHeadAgreement(ctx, options, fullTarget);
  const plan = planMaterialize(allTarget, opts);
  validateExcludedPaths(ctx, plan.excluded);
  const workdir = requireWorkTree(ctx, 'materializeTree');
  const judged = await classifyChangeset(ctx, plan, opts, workdir, staleRule);
  const { verified } = judged;
  const result = await applyChangesetWithAttributes(
    ctx,
    applyOptionsOf(opts, withRemovals(judged.changeset, removals), workdir),
    checkoutDirection(opts, plan),
  );
  const newIndexEntries = assembleIndexEntries(result, opts, plan, carried);
  return { newIndexEntries, written: result.written, deleted: result.deleted, verified };
};
