/**
 * The not-side of the walk-tier closure: everything `computeClosure`'s walk
 * must NOT emit, and the asymmetry between how commits and trees earn that
 * exclusion.
 *
 * A commit `not` tip is only collected here: which of its ancestors are
 * uninteresting is the closure's limited walk to decide — git's `limit_list`,
 * which walks both sides together by commit date and gives up on the
 * excluded side once it has stayed all-uninteresting for a few commits, so a
 * clock-skewed excluded line can leave a shared ancestor listed. Trees are
 * marked more narrowly, and NEVER for a `not` tip merely for being a tip:
 * only the own tree of every uninteresting commit the limited walk lists as
 * an edge (a parent of a listed commit, or a commit listed before it turned
 * uninteresting), which `markBoundaryTrees` marks under `--objects` — git's
 * `mark_edges_uninteresting`. A `not` tip no interesting walk reaches leaves
 * its own tree unmarked and a blob it shares with a `want` is still emitted —
 * reproducing git's set, not a tighter one.
 */
import { operationAborted } from '../../../domain/error.js';
import { isObjectNotFound, treeDepthExceeded } from '../../../domain/objects/error.js';
import {
  type GitObject,
  isDirectory,
  type ObjectId,
  type Tree,
} from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';
import { isGitlink } from '../validators.js';
import { assignObjectType, type ObjectTypeTable } from './object-type-table.js';
import { type CommitMeta, readCommitMeta } from './read-commit-meta.js';
import { resolveMaxTreeDepth } from './resolve-max-tree-depth.js';

export interface NotMarks {
  /** Every commit `not` tip, tags peeled, in argument order — the limited
   *  walk's excluded seeds. */
  readonly commitTips: ReadonlyArray<ObjectId>;
  /** Mutable: the interesting walk extends this with boundary commits' own
   *  trees as it discovers them — see `markBoundaryTrees`. */
  readonly objects: Set<ObjectId>;
  /** Threaded through to `markBoundaryTrees` so a tree already marked here
   *  (a directly-named tree tip's) is never re-walked. */
  readonly seenTrees: Set<ObjectId>;
  /** Resolved once by `markNotSide` from `core.maxTreeDepth` — `markBoundaryTrees`
   *  reads it back from here instead of resolving it again. */
  readonly maxDepth: number;
  /** The invocation's object-type table the marked entries are typed into; omitted, nothing is typed. */
  readonly objectTypes?: ObjectTypeTable;
}

interface NotMarksAccumulator extends NotMarks {
  readonly commitTips: ObjectId[];
}

/**
 * The negative side's tolerance for a tree it cannot read: `undefined` for a
 * locally absent object, every other failure rethrown. Git's
 * `mark_tree_contents_uninteresting` calls `parse_tree_gently(tree,
 * quiet_on_missing = 1)` and simply returns when it fails, after
 * `mark_tree_uninteresting` has already flagged the tree object itself — so a
 * negative whose tree is missing (a `--filter=tree:0` promisor gap, a pruned
 * or corrupt tree) prunes that one oid and nothing below it, and the walk
 * quietly over-reports instead of refusing. Measured on git 2.55.0: with the
 * negative's root tree deleted, `rev-list --objects W ^H` and `pack-objects
 * --revs --stdout` both exit 0. The positive side keeps refusing — git does
 * too.
 */
const readTreeIfPresent = async (
  ctx: Context,
  treeId: ObjectId,
): Promise<GitObject | undefined> => {
  try {
    return await readObject(ctx, treeId);
  } catch (error) {
    if (isObjectNotFound(error)) return undefined;
    throw error;
  }
};

/**
 * Recursively mark `treeId` and its non-gitlink contents uninteresting.
 * Under typing, each entry is looked up as its mode types it — git's
 * `mark_tree_contents_uninteresting` — and an entry an earlier lookup typed
 * otherwise is logged and left unmarked.
 *
 * This descent was measured honouring `core.maxTreeDepth` exactly, to 100000
 * (2026-08-15): depth 100000 completes, and a fixture one level deeper refuses
 * cleanly with `TREE_DEPTH_EXCEEDED` at depth 100001 — so the configured cap,
 * not the call stack, is what bounds it. Deeper than that is unmeasured.
 */
async function markTree(ctx: Context, treeId: ObjectId, marks: NotMarks, depth = 0): Promise<void> {
  if (marks.seenTrees.has(treeId)) return;
  marks.seenTrees.add(treeId);
  if (depth > marks.maxDepth) throw treeDepthExceeded(depth);
  // Stryker disable next-line ConditionalExpression: equivalent — the readObject below re-checks ctx.signal and throws the identical operationAborted; the only mark this guard saves is discarded by that same throw.
  if (ctx.signal?.aborted) throw operationAborted();
  marks.objects.add(treeId);
  const tree = await readMarkedTree(ctx, treeId, marks.objectTypes);
  if (tree === undefined) return;
  for (const entry of tree.entries) {
    if (isGitlink(entry.mode)) continue;
    const type = isDirectory(entry.mode) ? 'tree' : 'blob';
    if (!assignObjectType(ctx, marks.objectTypes, entry.id, type)) continue;
    if (type === 'blob') marks.objects.add(entry.id);
    else await markTree(ctx, entry.id, marks, depth + 1);
  }
}

/**
 * git's `parse_tree_gently` on the excluded side: a missing tree is skipped
 * quietly, one stored as something else is `Object X not a tree` under typing.
 */
const readMarkedTree = async (
  ctx: Context,
  treeId: ObjectId,
  objectTypes: ObjectTypeTable | undefined,
): Promise<Tree | undefined> => {
  const object = await readTreeIfPresent(ctx, treeId);
  if (object === undefined || object.type === 'tree') return object;
  if (objectTypes !== undefined) ctx.logger?.error?.(`Object ${treeId} not a tree`, { id: treeId });
  return undefined;
};

/**
 * Mark one `not` tip uninteresting: peel a tag chain, marking every tag on it
 * as git's `handle_commit` flags each object it peels, then collect a commit
 * for the limited walk (its own tree is left to `markBoundaryTrees`), or mark
 * a tree/blob tip directly.
 */
async function markUninteresting(
  ctx: Context,
  id: ObjectId,
  acc: NotMarksAccumulator,
): Promise<void> {
  const obj = await readObject(ctx, id);
  if (obj.type === 'tag') {
    acc.objects.add(id);
    await markUninteresting(ctx, obj.data.object, acc);
    return;
  }
  if (obj.type === 'commit') {
    acc.commitTips.push(id);
    return;
  }
  if (obj.type === 'tree') {
    // A directly-named tree/blob `not` id is marked outright — git's
    // `handle_commit` marks a pending object of that type directly.
    await markTree(ctx, id, acc);
    return;
  }
  acc.objects.add(id);
}

/** Collect every commit `not` tip; mark a directly-named tree/blob tip
 *  outright. A tip's own tree is left to `markBoundaryTrees` — see this
 *  module's own doc. */
export async function markNotSide(
  ctx: Context,
  not: ReadonlyArray<ObjectId>,
  objectTypes?: ObjectTypeTable,
): Promise<NotMarks> {
  const acc: NotMarksAccumulator = {
    commitTips: [],
    objects: new Set<ObjectId>(),
    seenTrees: new Set<ObjectId>(),
    maxDepth: await resolveMaxTreeDepth(ctx),
    ...(objectTypes === undefined ? {} : { objectTypes }),
  };
  for (const notId of not) {
    await markUninteresting(ctx, notId, acc);
  }
  return acc;
}

/**
 * The negative side's tolerance for a boundary commit it cannot resolve:
 * `undefined` for a locally absent object, every other failure rethrown —
 * git's `mark_tree_uninteresting` returns on a commit with no tree to give.
 */
export const readCommitMetaIfPresent = async (
  ctx: Context,
  id: ObjectId,
): Promise<CommitMeta | undefined> => {
  try {
    return await readCommitMeta(ctx, id);
  } catch (error) {
    if (isObjectNotFound(error)) return undefined;
    throw error;
  }
};

/**
 * Mark the own tree of every `boundary` commit uninteresting — git's
 * `mark_edges_uninteresting`, which must complete before ANY interesting
 * tree is emitted: a boundary a later commit surfaces must still gate an
 * earlier one's tree walk. The tree comes from the commit-graph when the
 * commit is in it, as git's `repo_get_commit_tree` reads it.
 */
export async function markBoundaryTrees(
  ctx: Context,
  boundary: Iterable<ObjectId>,
  marks: NotMarks,
): Promise<void> {
  for (const commitId of boundary) {
    const meta = await readCommitMetaIfPresent(ctx, commitId);
    if (meta === undefined) continue;
    await markTree(ctx, meta.tree, marks);
  }
}

/** A commit tree git's sparse marking starts from, excluded when its commit is. */
export interface SparseTreeSeed {
  readonly tree: ObjectId;
  readonly excluded: boolean;
}

/**
 * git's `pack.useSparse` marking (`mark_trees_uninteresting_sparse`): group
 * the listed commits' trees and their parents' by path, and descend only a
 * path both an excluded and an included tree hold. An excluded tree marks
 * its direct children whatever their path; a subtree an included commit
 * holds under a path no excluded tree shares stays in the closure even when
 * an excluded tree holds it elsewhere.
 */
export async function markSparseTrees(
  ctx: Context,
  seeds: Iterable<SparseTreeSeed>,
  marks: NotMarks,
): Promise<void> {
  const trees = new Set<ObjectId>();
  for (const seed of seeds) {
    if (seed.excluded) marks.objects.add(seed.tree);
    trees.add(seed.tree);
  }
  await markTreeGroup(ctx, trees, marks, 0);
}

async function markTreeGroup(
  ctx: Context,
  trees: ReadonlySet<ObjectId>,
  marks: NotMarks,
  depth: number,
): Promise<void> {
  if (!holdsBothSides(trees, marks.objects)) return;
  if (depth > marks.maxDepth) throw treeDepthExceeded(depth);
  const byName = new Map<string, Set<ObjectId>>();
  for (const tree of trees) await addChildrenByName(ctx, tree, byName, marks.objects);
  for (const group of byName.values()) await markTreeGroup(ctx, group, marks, depth + 1);
}

const holdsBothSides = (trees: ReadonlySet<ObjectId>, marked: ReadonlySet<ObjectId>): boolean => {
  let excluded = false;
  let included = false;
  for (const tree of trees) {
    if (marked.has(tree)) excluded = true;
    else included = true;
  }
  return excluded && included;
};

/** Lossless map key for an entry name: one code unit per name byte. */
const nameKey = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

async function addChildrenByName(
  ctx: Context,
  treeId: ObjectId,
  byName: Map<string, Set<ObjectId>>,
  marked: Set<ObjectId>,
): Promise<void> {
  const tree = await readTreeIfPresent(ctx, treeId);
  if (tree === undefined || tree.type !== 'tree') return;
  const excluded = marked.has(treeId);
  for (const entry of tree.entries) {
    if (isGitlink(entry.mode)) continue;
    if (excluded) marked.add(entry.id);
    if (!isDirectory(entry.mode)) continue;
    const key = nameKey(entry.nameBytes);
    const group = byName.get(key) ?? new Set<ObjectId>();
    group.add(entry.id);
    byName.set(key, group);
  }
}
