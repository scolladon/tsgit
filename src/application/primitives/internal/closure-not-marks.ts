/**
 * The not-side of the walk-tier closure: everything `computeClosure`'s walk
 * must NOT emit, and the asymmetry between how commits and trees earn that
 * exclusion.
 *
 * A `not` tip's *entire* commit ancestry is marked uninteresting — git's own
 * merge-base exclusion, propagated through every parent edge, so a commit
 * reachable from BOTH a `want` and a `not` (a shared ancestor) is still
 * excluded. Trees are marked more narrowly, and NEVER for a `not` tip merely
 * for being a tip: only the own tree of every commit the *interesting* walk's
 * parent pointers discover to be uninteresting (a "boundary" commit — the
 * merge-base is the common case, a diamond can surface more than one), which
 * `markBoundaryTrees` marks under `--objects`. git's limited walk does the same
 * (`mark_edges_uninteresting` marks only edge parents' trees), so a `not` tip
 * no interesting walk reaches leaves its own tree unmarked and a blob it shares
 * with a `want` is still emitted — reproducing git's set, not a tighter one.
 */
import { invalidWalkInput, operationAborted, TsgitError } from '../../../domain/error.js';
import { treeDepthExceeded } from '../../../domain/objects/error.js';
import { type GitObject, isDirectory, type ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';
import { MAX_WALK_QUEUE_SIZE } from '../types.js';
import { isGitlink, REASON_WALK_QUEUE_OVERFLOW } from '../validators.js';
import { type CommitMeta, readCommitMeta } from './read-commit-meta.js';
import { resolveMaxTreeDepth } from './resolve-max-tree-depth.js';

/** The slice of a walked commit `markBoundaryTrees` needs — its own id and
 *  tree, plus the parents that discover further boundary commits. Declared
 *  here (not `closure-engine.ts`) so the existing dependency direction —
 *  `closure-engine.ts` already imports from this module — stays a DAG. */
export interface WalkedCommit {
  readonly id: ObjectId;
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
}

export interface NotMarks {
  readonly commits: ReadonlySet<ObjectId>;
  /** Every marked commit's own tree id, populated alongside `commits` by
   *  `markCommitAncestry` — `markBoundaryTrees` looks a marked parent up
   *  here instead of re-reading it. */
  readonly commitTrees: ReadonlyMap<ObjectId, ObjectId>;
  /** Mutable: the interesting walk extends this with boundary commits' own
   *  trees as it discovers them — see `markBoundaryTrees`. */
  readonly objects: Set<ObjectId>;
  /** Threaded through to `markBoundaryTrees` so a tree already marked here
   *  (a directly-named tree tip's) is never re-walked. */
  readonly seenTrees: Set<ObjectId>;
  /** Resolved once by `markNotSide` from `core.maxTreeDepth` — `markBoundaryTrees`
   *  reads it back from here instead of resolving it again. */
  readonly maxDepth: number;
}

/**
 * The mutable working set every `not` tip contributes to. `markNotSide` returns
 * the read-only {@link NotMarks} view of it. `missing` is an internal dedup memo
 * — a parent the store cannot serve, remembered so a later child (in this tip's
 * walk or a sibling tip's) never pays the miss twice — and is not part of that
 * view.
 */
interface NotMarksAccumulator {
  readonly commits: Set<ObjectId>;
  readonly commitTrees: Map<ObjectId, ObjectId>;
  readonly objects: Set<ObjectId>;
  readonly seenTrees: Set<ObjectId>;
  readonly missing: Set<ObjectId>;
  readonly maxDepth: number;
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
    if (error instanceof TsgitError && error.data.code === 'OBJECT_NOT_FOUND') return undefined;
    throw error;
  }
};

/**
 * Recursively mark `treeId` and its non-gitlink contents uninteresting.
 *
 * This descent was measured honouring `core.maxTreeDepth` exactly, to 100000
 * (2026-08-15): depth 100000 completes, and a fixture one level deeper refuses
 * cleanly with `TREE_DEPTH_EXCEEDED` at depth 100001 — so the configured cap,
 * not the call stack, is what bounds it. Deeper than that is unmeasured.
 */
async function markTree(
  ctx: Context,
  treeId: ObjectId,
  marked: Set<ObjectId>,
  seenTrees: Set<ObjectId>,
  maxDepth: number,
  depth = 0,
): Promise<void> {
  if (seenTrees.has(treeId)) return;
  seenTrees.add(treeId);
  if (depth > maxDepth) throw treeDepthExceeded(depth);
  // Stryker disable next-line ConditionalExpression: equivalent — the readObject below re-checks ctx.signal and throws the identical operationAborted; the only mark this guard saves is discarded by that same throw.
  if (ctx.signal?.aborted) throw operationAborted();
  marked.add(treeId);
  const treeObj = await readTreeIfPresent(ctx, treeId);
  if (treeObj === undefined) return;
  if (treeObj.type !== 'tree') return;
  for (const entry of treeObj.entries) {
    if (isGitlink(entry.mode)) continue;
    if (!isDirectory(entry.mode)) {
      marked.add(entry.id);
      continue;
    }
    await markTree(ctx, entry.id, marked, seenTrees, maxDepth, depth + 1);
  }
}

/**
 * The negative side's tolerance for a commit it cannot resolve: `undefined`
 * for a locally absent object, every other failure rethrown. `readCommitMeta`
 * already answers `undefined` for an oid that resolves to something other
 * than a commit, so both kinds of parent the marker cannot follow reach the same skip.
 */
const readCommitMetaIfPresent = async (
  ctx: Context,
  id: ObjectId,
): Promise<CommitMeta | undefined> => {
  try {
    return await readCommitMeta(ctx, id);
  } catch (error) {
    if (error instanceof TsgitError && error.data.code === 'OBJECT_NOT_FOUND') return undefined;
    throw error;
  }
};

/**
 * Marks `id` and its FULL commit ancestry uninteresting — git's own
 * merge-base exclusion: a commit reachable from a `not` tip is excluded from
 * the walk even when it is ALSO reachable from a `want`, however many parent
 * edges separate it from the tip. `acc.commits` doubles as the visited set
 * and the short-circuit on a commit a prior `not` id's own pass already
 * covered, so overlapping ancestries are walked once. Distinct from tree
 * marking (`markTree`, above), which stays scoped to specific commits' own
 * trees — that asymmetry is what reproduces git's own over-report.
 *
 * Records each walked commit's own tree in `commitTrees` too, so
 * `markBoundaryTrees` can look a marked ancestor's tree up later instead of
 * reading it — and, since it only ever reads that map at a key `commits`
 * also gained here, the lookup is proven to hit.
 *
 * Root tree and parents are the only two fields this needs, and
 * `readCommitMeta` serves both from the commit-graph without touching the
 * object store. That is git's own behaviour on the negative side:
 * `repo_parse_commit` answers a commit from the graph whether or not its body
 * is still there, and walks the parents the graph names. The deferred enqueue
 * in `walkCommits` exists to protect a YIELDING walk under `ignoreMissing`,
 * which only needs to hold because the body it yields must exist; nothing
 * here is yielded, so nothing here needs the body. A shallow repository
 * disables the graph outright, so the fallback's grafted parents still cut
 * the ancestry at the boundary exactly as before.
 */
async function markCommitAncestry(
  ctx: Context,
  id: ObjectId,
  acc: NotMarksAccumulator,
): Promise<void> {
  const frontier: AncestryFrontier = { queue: [id], queued: new Set([id]) };
  for (let head = 0; head < frontier.queue.length; head += 1) {
    if (ctx.signal?.aborted) throw operationAborted();
    const current = frontier.queue[head] as ObjectId;
    frontier.queued.delete(current);
    if (acc.commits.has(current)) continue;
    const meta = await readCommitMetaIfPresent(ctx, current);
    if (meta === undefined) {
      acc.missing.add(current);
      continue;
    }
    acc.commits.add(current);
    acc.commitTrees.set(current, meta.tree);
    enqueueUnmarkedParents(frontier, meta.parents, acc);
  }
}

/**
 * The ancestry walk's head-cursor frontier. `queued` is git's ENQUEUED flag:
 * a parent named by many children is queued once, and the bound counts
 * distinct pending ids — the same discipline and the same refusal
 * `walkCommits` applies to its own frontier.
 */
interface AncestryFrontier {
  readonly queue: ObjectId[];
  readonly queued: Set<ObjectId>;
}

function enqueueUnmarkedParents(
  frontier: AncestryFrontier,
  parents: ReadonlyArray<ObjectId>,
  acc: NotMarksAccumulator,
): void {
  for (const parent of parents) {
    if (acc.commits.has(parent) || frontier.queued.has(parent) || acc.missing.has(parent)) {
      continue;
    }
    if (frontier.queued.size >= MAX_WALK_QUEUE_SIZE) {
      throw invalidWalkInput(REASON_WALK_QUEUE_OVERFLOW);
    }
    frontier.queue.push(parent);
    frontier.queued.add(parent);
  }
}

/**
 * Mark one `not` tip uninteresting: peel a tag chain, then mark a commit's
 * full ancestry (commits only — its own tree is left to `markBoundaryTrees`),
 * or mark a tree/blob tip directly.
 */
async function markUninteresting(
  ctx: Context,
  id: ObjectId,
  acc: NotMarksAccumulator,
): Promise<void> {
  const obj = await readObject(ctx, id);
  if (obj.type === 'tag') {
    await markUninteresting(ctx, obj.data.object, acc);
    return;
  }
  if (obj.type === 'commit') {
    // A commit `not` tip contributes only its ancestry commits — NOT its own
    // tree. git's limited walk marks a tree uninteresting only when the
    // interesting walk's parent pointers reach the commit that owns it (an edge
    // parent), which `markBoundaryTrees` replicates under `--objects`; a tip no
    // interesting walk touches leaves its tree unmarked, exactly as git does.
    await markCommitAncestry(ctx, id, acc);
    return;
  }
  if (obj.type === 'tree') {
    // A directly-named tree/blob `not` id is marked outright — git's
    // `handle_commit` marks a pending object of that type directly.
    await markTree(ctx, id, acc.objects, acc.seenTrees, acc.maxDepth);
    return;
  }
  acc.objects.add(id);
}

/** Mark every `not` tip's full commit ancestry; a directly-named tree/blob tip
 *  outright. A tip's own tree is left to `markBoundaryTrees` — see this
 *  module's own doc. */
export async function markNotSide(ctx: Context, not: ReadonlyArray<ObjectId>): Promise<NotMarks> {
  const acc: NotMarksAccumulator = {
    commits: new Set<ObjectId>(),
    commitTrees: new Map<ObjectId, ObjectId>(),
    objects: new Set<ObjectId>(),
    seenTrees: new Set<ObjectId>(),
    missing: new Set<ObjectId>(),
    maxDepth: await resolveMaxTreeDepth(ctx),
  };
  for (const notId of not) {
    await markUninteresting(ctx, notId, acc);
  }
  return {
    commits: acc.commits,
    commitTrees: acc.commitTrees,
    objects: acc.objects,
    seenTrees: acc.seenTrees,
    maxDepth: acc.maxDepth,
  };
}

/**
 * For every parent of a walked (interesting) commit that falls in the
 * not-side's full ancestor closure, mark THAT parent's own tree
 * uninteresting too — git's own boundary-commit behaviour: any uninteresting
 * commit the interesting walk's own parent pointers touch gets its tree
 * marked, not only the tips the caller passed (the merge-base is the common
 * case, but a diamond can surface more than one). Idempotent per parent id,
 * and must complete before ANY of `walked`'s trees are emitted — a boundary
 * discovered only by a later commit in the list must still gate an earlier
 * one's tree walk.
 */
export async function markBoundaryTrees(
  ctx: Context,
  walked: ReadonlyArray<WalkedCommit>,
  marks: NotMarks,
): Promise<void> {
  const seenBoundary = new Set<ObjectId>();
  for (const commit of walked) {
    for (const parentId of commit.parents) {
      if (!marks.commits.has(parentId) || seenBoundary.has(parentId)) continue;
      seenBoundary.add(parentId);
      // `parentId` passed the `marks.commits` check above, and
      // `markCommitAncestry` always sets `commitTrees` alongside `commits`
      // for the same id — this lookup is guaranteed to hit.
      const parentTree = marks.commitTrees.get(parentId) as ObjectId;
      await markTree(ctx, parentTree, marks.objects, marks.seenTrees, marks.maxDepth);
    }
  }
}
