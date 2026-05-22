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
import {
  compareEntryPath,
  type GitIndex,
  type IndexEntry,
  STAGE0_FLAGS,
} from '../../domain/git-index/index.js';
import {
  FILE_MODE,
  type FileMode,
  type FilePath,
  type ObjectId,
} from '../../domain/objects/index.js';
import type { SparseMatcher } from '../../domain/sparse/index.js';
import type { Context } from '../../ports/context.js';
import { applyChangeset } from './apply-changeset.js';
import {
  type Changeset,
  type ChangesetEntry,
  type ChangesetStats,
  computeChangeset,
} from './compute-changeset.js';
import { walkTree } from './walk-tree.js';

export interface MaterializeTreeOpts {
  readonly targetTree: ObjectId;
  readonly currentIndex: GitIndex;
  readonly force?: boolean;
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
}

export interface MaterializeTreeResult {
  readonly newIndexEntries: ReadonlyArray<IndexEntry>;
  readonly written: number;
  readonly deleted: number;
}

interface TargetEntry {
  readonly path: FilePath;
  readonly id: ObjectId;
  readonly mode: FileMode;
}

const collectTargetEntries = async (ctx: Context, treeId: ObjectId): Promise<TargetEntry[]> => {
  const collected: TargetEntry[] = [];
  for await (const entry of walkTree(ctx, treeId)) {
    if (entry.mode === FILE_MODE.DIRECTORY) continue;
    collected.push({ path: entry.path, id: entry.id, mode: entry.mode });
  }
  return collected;
};

const filterByPaths = <T extends { readonly path: FilePath }>(
  entries: ReadonlyArray<T>,
  paths: ReadonlySet<FilePath>,
): T[] => entries.filter((e) => paths.has(e.path));

const indexEntriesByPath = (index: GitIndex): Map<FilePath, IndexEntry> => {
  const out = new Map<FilePath, IndexEntry>();
  for (const entry of index.entries) {
    if (entry.flags.stage === 0) out.set(entry.path, entry);
  }
  return out;
};

const writtenEntriesByPath = (
  writtenEntries: ReadonlyArray<IndexEntry>,
): Map<FilePath, IndexEntry> => {
  const out = new Map<FilePath, IndexEntry>();
  for (const entry of writtenEntries) out.set(entry.path, entry);
  return out;
};

const preserveOutOfScope = (
  oldByPath: ReadonlyMap<FilePath, IndexEntry>,
  scopedPaths: ReadonlySet<FilePath> | undefined,
): IndexEntry[] => {
  if (scopedPaths === undefined) return [];
  const out: IndexEntry[] = [];
  for (const [path, entry] of oldByPath) {
    if (!scopedPaths.has(path)) out.push(entry);
  }
  return out;
};

const pickEntry = (
  path: FilePath,
  writtenByPath: ReadonlyMap<FilePath, IndexEntry>,
  oldByPath: ReadonlyMap<FilePath, IndexEntry>,
): IndexEntry | undefined => writtenByPath.get(path) ?? oldByPath.get(path);

const mergeNewIndexEntries = (
  writtenEntries: ReadonlyArray<IndexEntry>,
  currentIndex: GitIndex,
  target: ReadonlyArray<TargetEntry>,
  scopedPaths: ReadonlySet<FilePath> | undefined,
): ReadonlyArray<IndexEntry> => {
  const writtenByPath = writtenEntriesByPath(writtenEntries);
  const oldByPath = indexEntriesByPath(currentIndex);

  const merged: IndexEntry[] = preserveOutOfScope(oldByPath, scopedPaths);
  for (const entry of target) {
    const picked = pickEntry(entry.path, writtenByPath, oldByPath);
    if (picked !== undefined) merged.push(picked);
  }
  // `merged` paths are all distinct — out-of-scope (not in `scopedPaths`) and
  // target (in `scopedPaths`) are disjoint, and target paths come from a tree
  // walk of unique paths. So `a.path === b.path` never occurs and a single
  // less-than test is a correct total-order comparator; the `> : 0` tail would
  // be dead code.
  // Stryker disable next-line EqualityOperator: equivalent — distinct paths mean `<` vs `<=` only differ on the impossible equal-path case.
  merged.sort((a, b) => (a.path < b.path ? -1 : 1));
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

/**
 * Synthesize the index entry for a target-tree path the sparse matcher
 * excludes: present in the index with the tree's `id` / `mode`, skip-worktree
 * set, stat fields zeroed (the file is absent — there is nothing to `lstat`,
 * and `status` skips skip-worktree entries so the zeroes are never consulted).
 */
const skipWorktreeEntry = (entry: TargetEntry): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode: entry.mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id: entry.id,
  flags: { ...STAGE0_FLAGS, skipWorktree: true },
  path: entry.path,
});

/** Path-sort the merged entry list (in-pattern + synthesised excluded). */
const sortIndexEntries = (entries: ReadonlyArray<IndexEntry>): IndexEntry[] =>
  [...entries].sort(compareEntryPath);

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

export const materializeTree = async (
  ctx: Context,
  opts: MaterializeTreeOpts,
): Promise<MaterializeTreeResult> => {
  const allTarget = await collectTargetEntries(ctx, opts.targetTree);
  const plan = planMaterialize(allTarget, opts);

  const rawChangeset = computeChangeset(plan.indexForDiff, plan.target);
  const changeset =
    opts.forceRewriteAll === true ? upgradeNoopsToUpdates(rawChangeset) : rawChangeset;

  const result = await applyChangeset(ctx, {
    changeset,
    force: opts.force ?? false,
    workdir: ctx.layout.workDir,
  });

  const inScope = mergeNewIndexEntries(
    result.writtenEntries,
    opts.currentIndex,
    plan.target,
    opts.paths,
  );
  // Sparse branch-switch: append one synthesised skip-worktree entry per
  // excluded target path so the index keeps every tracked path (git-faithful).
  const newIndexEntries =
    // Stryker disable next-line ConditionalExpression: equivalent — forcing the guard false re-sorts the already-path-sorted `inScope` (from `mergeNewIndexEntries`) into a content-identical list when `excluded` is empty; the guard only skips that redundant work.
    plan.excluded.length === 0
      ? inScope
      : sortIndexEntries([...inScope, ...plan.excluded.map(skipWorktreeEntry)]);

  return {
    newIndexEntries,
    written: result.written,
    deleted: result.deleted,
  };
};
