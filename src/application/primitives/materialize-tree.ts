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
 * - `reset --hard` therefore MUST set `forceRewriteAll: true` so every noop
 *  upgrades to update and the post-write stats land in the output. Without
 *  that, a locally-modified working-tree file that the index still records
 *  as clean would survive the reset, AND the donor stats would be stale
 *  relative to the actual disk state.
 */

import { checkoutOverwriteDirty } from '../../domain/commands/error.js';
import { comparePaths } from '../../domain/diff/index.js';
import { type GitIndex, type IndexEntry, skipWorktreeEntry } from '../../domain/git-index/index.js';
import {
  escapedPathOf,
  type IndexPath,
  type IndexPathKey,
  indexPathKey,
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
import { applyChangesetWithAttributes } from './apply-changeset.js';
import {
  type Changeset,
  type ChangesetEntry,
  type ChangesetStats,
  computeChangeset,
} from './compute-changeset.js';
import type { CheckoutMetadata } from './internal/apply-smudge-filter.js';
import { indexPathRulesOf } from './internal/index-path-rules.js';
import { indexRuleEntries } from './internal/index-rule-entries.js';
import {
  type AttributeDirection,
  attributeBlobLookup,
  isAttributesPath,
} from './internal/read-gitattributes.js';
import { requireWorkTree } from './internal/repo-state.js';
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
   * When true, every target-tree path is written to the working tree
   * unconditionally — even paths the index→target diff classified as `noop`
   * (same `id` AND `mode`). Required by `reset --hard`, where the working
   * tree may diverge from the index (uncommitted local modifications); the
   * standard index→target diff cannot see that drift, so noops would skip
   * paths the caller wants overwritten. Default `false` keeps the Phase
   * 13.1 checkout behaviour: clean files are never spuriously rewritten.
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
   */
  readonly headTree?: ObjectId;
}

export interface MaterializeTreeResult {
  readonly newIndexEntries: ReadonlyArray<IndexEntry>;
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

/** Every stage of every out-of-scope path survives, so another path's conflict is kept. */
const preserveOutOfScope = (
  currentIndex: GitIndex,
  scopedPaths: ReadonlySet<FilePath> | undefined,
): IndexEntry[] =>
  scopedPaths === undefined
    ? []
    : currentIndex.entries.filter((e) => !scopedPaths.has(escapedPathOf(e)));

const pickEntry = (
  entry: TargetEntry,
  writtenByPath: ReadonlyMap<IndexPathKey, IndexEntry>,
  oldByPath: ReadonlyMap<IndexPathKey, IndexEntry>,
): IndexEntry | undefined => {
  const key = indexPathKey(entry);
  return writtenByPath.get(key) ?? oldByPath.get(key);
};

const mergeNewIndexEntries = (
  writtenEntries: ReadonlyArray<IndexEntry>,
  currentIndex: GitIndex,
  target: ReadonlyArray<TargetEntry>,
  scopedPaths: ReadonlySet<FilePath> | undefined,
): ReadonlyArray<IndexEntry> => {
  const writtenByPath = writtenEntriesByPath(writtenEntries);
  const oldByPath = indexEntriesByPath(currentIndex);

  const merged: IndexEntry[] = preserveOutOfScope(currentIndex, scopedPaths);
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

const upgradeNoopsToUpdates = (changeset: Changeset): Changeset => {
  const entries = changeset.entries.map((entry) =>
    entry.kind === 'noop' ? { ...entry, kind: 'update' as const } : entry,
  );
  // Re-tally stats from the mutated entry list rather than doing per-entry
  // arithmetic on the prior stats. Equivalent result, simpler mutation surface,
  // and `applyChangeset`'s progress denominator (`stats.add + update + delete`)
  // now stays consistent with the entry list it iterates.
  return { entries, stats: tallyStats(entries) };
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
}

/** git re-evaluates the sparse patterns of every path, so these never stay put. */
const sparseMovers = (
  sparse: SparseMatcher | undefined,
  target: ReadonlyArray<TargetEntry>,
  index: ReadonlyArray<IndexEntry>,
): Set<IndexPathKey> => {
  if (sparse === undefined) return new Set();
  const outside = [...target, ...index].filter((e) => !sparse(e.path));
  const hidden = index.filter((e) => e.flags.skipWorktree);
  return new Set([...outside, ...hidden].map(indexPathKey));
};

/** Applies the two-way merge of a branch switch: refuses, or sets the kept paths aside. */
const carryHeadAgreement = async (
  ctx: Context,
  opts: MaterializeTreeOpts,
  allTarget: ReadonlyArray<TargetEntry>,
): Promise<CarriedOpts> => {
  if (opts.headTree === undefined) return { opts, allTarget, carried: [] };
  const head = await collectTargetEntries(ctx, opts.headTree);
  const stageZero = opts.currentIndex.entries.filter((e) => e.flags.stage === 0);
  const carry = carryStagedChanges(head, allTarget, stageZero);
  const { refused } = carry;
  const movers = sparseMovers(opts.sparse, allTarget, stageZero);
  const kept = new Set([...carry.kept].filter((key) => !movers.has(key)));
  if (refused.length > 0) {
    throw checkoutOverwriteDirty({ localChanges: [...refused].sort(comparePaths), untracked: [] });
  }
  const carried = stageZero.filter((e) => kept.has(indexPathKey(e)));
  return {
    opts: {
      ...opts,
      currentIndex: {
        ...opts.currentIndex,
        entries: opts.currentIndex.entries.filter((e) => !carried.includes(e)),
      },
    },
    allTarget: allTarget.filter((e) => !kept.has(indexPathKey(e))),
    carried,
  };
};

export const materializeTree = async (
  ctx: Context,
  options: MaterializeTreeOpts,
): Promise<MaterializeTreeResult> => {
  const fullTarget = await collectTargetEntries(ctx, options.targetTree);
  const { opts, allTarget, carried } = await carryHeadAgreement(ctx, options, fullTarget);
  const plan = planMaterialize(allTarget, opts);
  // Excluded entries skip the changeset, yet git verifies every path it adds to the index.
  const pathRules = indexPathRulesOf(ctx);
  for (const entry of plan.excluded) {
    pathRules.validateIndexPath(entry.path, NO_PARSER_OFFSET, entry.mode, entry.pathBytes);
  }

  const rawChangeset = computeChangeset(plan.indexForDiff, plan.target);
  const changeset =
    opts.forceRewriteAll === true ? upgradeNoopsToUpdates(rawChangeset) : rawChangeset;

  const result = await applyChangesetWithAttributes(
    ctx,
    {
      changeset,
      force: opts.force ?? false,
      workdir: requireWorkTree(ctx, 'materializeTree'),
      ...(opts.checkoutMetadata && { checkoutMetadata: opts.checkoutMetadata }),
    },
    checkoutDirection(opts, plan),
  );

  const inScope = mergeNewIndexEntries(
    result.writtenEntries,
    opts.currentIndex,
    plan.target,
    opts.paths,
  );
  // Sparse branch-switch: append one synthesised skip-worktree entry per
  // excluded target path so the index keeps every tracked path (git-faithful).
  const newIndexEntries =
    plan.excluded.length === 0 && carried.length === 0
      ? inScope
      : sortIndexEntries([...inScope, ...carried, ...plan.excluded.map(skipWorktreeEntry)]);

  return {
    newIndexEntries,
    written: result.written,
    deleted: result.deleted,
  };
};
