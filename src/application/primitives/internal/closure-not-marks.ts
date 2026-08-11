/**
 * The not-side of the walk-tier closure: everything `computeClosure`'s walk
 * must NOT emit, and the asymmetry between how commits and trees earn that
 * exclusion.
 *
 * A `not` tip's *entire* commit ancestry is marked uninteresting — git's own
 * merge-base exclusion, propagated through every parent edge, so a commit
 * reachable from BOTH a `want` and a `not` (a shared ancestor) is still
 * excluded. Trees are marked more narrowly: only the explicit `not` tip's own
 * tree, plus the own tree of every commit the *interesting* walk's parent
 * pointers discover to already be uninteresting (a "boundary" commit — the
 * merge-base is the common case, but a diamond can surface more than one). An
 * ancestor's tree that the interesting walk never touches is never marked, so
 * an object reachable only through it is emitted again — that is what
 * reproduces git's measured over-report rather than the exact set difference,
 * which would be a divergence from git here.
 */
import { operationAborted } from '../../../domain/error.js';
import { treeDepthExceeded } from '../../../domain/objects/error.js';
import { type Commit, isDirectory, type ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';
import { isGitlink } from '../validators.js';
import { walkCommits } from '../walk-commits.js';

/** Same bound as walk-tree.ts's default maxDepth and enumerate-bundle-objects.ts's
 *  marking pass — prevents stack overflow on a pathologically deep tree. */
const MAX_TREE_DEPTH = 1024;

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
   *  (the tip's own) is never re-walked. */
  readonly seenTrees: Set<ObjectId>;
}

/** Recursively mark `treeId` and its non-gitlink contents uninteresting. */
async function markTree(
  ctx: Context,
  treeId: ObjectId,
  marked: Set<ObjectId>,
  seenTrees: Set<ObjectId>,
  depth = 0,
): Promise<void> {
  if (seenTrees.has(treeId)) return;
  seenTrees.add(treeId);
  if (depth > MAX_TREE_DEPTH) throw treeDepthExceeded(depth);
  // Stryker disable next-line ConditionalExpression: equivalent — the readObject below re-checks ctx.signal and throws the identical operationAborted; the only mark this guard saves is discarded by that same throw.
  if (ctx.signal?.aborted) throw operationAborted();
  marked.add(treeId);
  const treeObj = await readObject(ctx, treeId);
  if (treeObj.type !== 'tree') return;
  for (const entry of treeObj.entries) {
    if (isGitlink(entry.mode)) continue;
    if (!isDirectory(entry.mode)) {
      marked.add(entry.id);
      continue;
    }
    await markTree(ctx, entry.id, marked, seenTrees, depth + 1);
  }
}

/**
 * Marks `id` and its FULL commit ancestry uninteresting — git's own
 * merge-base exclusion: a commit reachable from a `not` tip is excluded from
 * the walk even when it is ALSO reachable from a `want`, however many parent
 * edges separate it from the tip. `until` short-circuits on a commit a prior
 * `not` id's own walk already covered, so overlapping ancestries are walked
 * once. Distinct from tree marking (`markTree`, above), which stays scoped
 * to specific commits' own trees — that asymmetry is what reproduces git's
 * own over-report.
 *
 * Records each walked commit's own tree in `commitTrees` too: `walkCommits`
 * has already read the body, so `markBoundaryTrees` can look up a marked
 * ancestor's tree later without a second read — and, since it only ever
 * reads that map at a key `commits` also gained here, the lookup is proven
 * to hit.
 */
async function markCommitAncestry(
  ctx: Context,
  id: ObjectId,
  markedCommits: Set<ObjectId>,
  commitTrees: Map<ObjectId, ObjectId>,
): Promise<void> {
  for await (const commit of walkCommits(ctx, {
    from: [id],
    // Stryker disable next-line ArrayDeclaration: equivalent — every id already in markedCommits had its own full ancestry walked, so dropping the cut-off only re-walks commits whose marks are already set.
    until: [...markedCommits],
    ignoreMissing: true,
  })) {
    markedCommits.add(commit.id);
    commitTrees.set(commit.id, commit.data.tree);
  }
}

/**
 * Mark one `not` tip uninteresting: peel a tag chain, then mark a commit's
 * full ancestry (commits) and own tree (objects), or mark a tree/blob tip
 * directly.
 */
async function markUninteresting(
  ctx: Context,
  id: ObjectId,
  markedCommits: Set<ObjectId>,
  commitTrees: Map<ObjectId, ObjectId>,
  markedObjects: Set<ObjectId>,
  seenTrees: Set<ObjectId>,
): Promise<void> {
  const obj = await readObject(ctx, id);
  if (obj.type === 'tag') {
    await markUninteresting(
      ctx,
      obj.data.object,
      markedCommits,
      commitTrees,
      markedObjects,
      seenTrees,
    );
    return;
  }
  if (obj.type === 'commit') {
    await markCommitAncestry(ctx, id, markedCommits, commitTrees);
    await markTree(ctx, obj.data.tree, markedObjects, seenTrees);
    return;
  }
  if (obj.type === 'tree') {
    await markTree(ctx, id, markedObjects, seenTrees);
    return;
  }
  markedObjects.add(id);
}

/** Mark every `not` tip's full ancestry (commits) and own tree (objects) —
 *  see this module's own doc. */
export async function markNotSide(ctx: Context, not: ReadonlyArray<ObjectId>): Promise<NotMarks> {
  const commits = new Set<ObjectId>();
  const commitTrees = new Map<ObjectId, ObjectId>();
  const objects = new Set<ObjectId>();
  const seenTrees = new Set<ObjectId>();
  for (const notId of not) {
    await markUninteresting(ctx, notId, commits, commitTrees, objects, seenTrees);
  }
  return { commits, commitTrees, objects, seenTrees };
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
  walked: ReadonlyArray<Commit>,
  marks: NotMarks,
): Promise<void> {
  const seenBoundary = new Set<ObjectId>();
  for (const commit of walked) {
    for (const parentId of commit.data.parents) {
      if (!marks.commits.has(parentId) || seenBoundary.has(parentId)) continue;
      seenBoundary.add(parentId);
      // `parentId` passed the `marks.commits` check above, and
      // `markCommitAncestry` always sets `commitTrees` alongside `commits`
      // for the same id — this lookup is guaranteed to hit.
      const parentTree = marks.commitTrees.get(parentId) as ObjectId;
      await markTree(ctx, parentTree, marks.objects, marks.seenTrees);
    }
  }
}
