/**
 * Shared reachability closure engine. Computes the objects reachable from
 * `wants` and excludes what the walk marks uninteresting from `not` — the
 * walk tier only, in this part (a bitmap tier arrives later).
 *
 * The walk marks a `not` tip's *entire* commit ancestry uninteresting —
 * git's own merge-base exclusion, propagated through every parent edge, so a
 * commit reachable from BOTH a `want` and a `not` (a shared ancestor) is
 * still excluded. Trees are marked more narrowly: only the explicit `not`
 * tip's own tree, plus the own tree of every commit the *interesting* walk's
 * parent pointers discover to already be uninteresting (a "boundary"
 * commit — the merge-base is the common case, but a diamond can surface
 * more than one). An ancestor's tree that the interesting walk never touches
 * is never marked, so an object reachable only through it is emitted again
 * — that is what reproduces git's measured over-report rather than the
 * exact set difference, which would be a divergence from git here.
 *
 * Order is deterministic for a given call, but is not git's own order and is
 * not equal across calls with different shapes — callers that need a stable
 * display order sort the result themselves.
 */
import { operationAborted } from '../../../domain/error.js';
import { treeDepthExceeded } from '../../../domain/objects/error.js';
import {
  type Commit,
  type FilePath,
  isDirectory,
  type ObjectId,
} from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';
import { MAX_PUSH_OBJECTS } from '../types.js';
import { isGitlink } from '../validators.js';
import { walkCommits } from '../walk-commits.js';
import { walkTree } from '../walk-tree.js';
import { type EmitState, resolveTagChain, tryEmit } from './object-emit.js';

/** Same bound as walk-tree.ts's default maxDepth and enumerate-bundle-objects.ts's
 *  marking pass — prevents stack overflow on a pathologically deep tree. */
const MAX_TREE_DEPTH = 1024;

export interface ClosureRequest {
  readonly wants: ReadonlyArray<ObjectId>;
  readonly not: ReadonlyArray<ObjectId>;
  /** Include trees and blobs, not just commits and tags. */
  readonly objects: boolean;
  /**
   * At most this many commits emitted (under `objects`, those commits and
   * everything they reach). Governs the commit walk only — tag/tree/blob
   * wants resolved outside it are unaffected. `0` walks no commits at all.
   * Omitted means unbounded.
   */
  readonly maxCount?: number;
  /** Follow only the first parent of each commit. Omitted means every parent. */
  readonly firstParent?: boolean;
  /**
   * Emit the resolved commit seeds themselves and stop — no parent
   * traversal. Under `objects`, each seed's own tree still counts.
   */
  readonly noWalk?: boolean;
}

export interface ClosureObject {
  readonly id: ObjectId;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  /**
   * Populated by the walk. A reachability artefact encodes types and bits,
   * never names, so a future non-walking producer cannot fill this.
   */
  readonly path?: FilePath;
}

export interface ClosureResult {
  readonly objects: ReadonlyArray<ClosureObject>;
}

type Emit = (id: ObjectId, type: ClosureObject['type'], path?: FilePath) => void;

/** Root tree entries carry the empty path — git's own convention for the
 *  tree named directly by a commit (or a tree-typed want), as opposed to
 *  the paths `walkTree` assigns its descendants. */
const ROOT_PATH = '' as FilePath;

const NO_MARKS: ReadonlySet<ObjectId> = new Set();

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
 * once. Distinct from tree marking (`markTree`, below), which stays scoped
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

/**
 * Emit `treeId` and its non-gitlink contents, skipping anything marked
 * uninteresting. `path` comes from `walkTree`; the root tree itself carries
 * the empty path.
 */
async function emitTree(
  ctx: Context,
  treeId: ObjectId,
  marked: ReadonlySet<ObjectId>,
  emit: Emit,
): Promise<void> {
  if (!marked.has(treeId)) emit(treeId, 'tree', ROOT_PATH);
  for await (const entry of walkTree(ctx, treeId)) {
    if (isGitlink(entry.mode)) continue;
    if (marked.has(entry.id)) continue;
    emit(entry.id, isDirectory(entry.mode) ? 'tree' : 'blob', entry.path);
  }
}

/**
 * Resolve every want: peel tags (recording each tag oid), then either seed
 * the commit walk or — for a tree/blob want, which has no parents — emit
 * itself and its own subtree directly. Commit seeds carry their full body so
 * the `noWalk` path can emit them (and, under `objects`, their own tree)
 * without a second read.
 */
async function resolveWants(
  ctx: Context,
  wants: ReadonlyArray<ObjectId>,
  emit: Emit,
): Promise<Commit[]> {
  const commitSeeds: Commit[] = [];
  for (const wantId of wants) {
    const peeled = await resolveTagChain(ctx, wantId, (tagId) => emit(tagId, 'tag'));
    const obj = await readObject(ctx, peeled);
    if (obj.type === 'commit') {
      commitSeeds.push(obj);
      continue;
    }
    if (obj.type === 'tree') {
      await emitTree(ctx, peeled, NO_MARKS, emit);
      continue;
    }
    emit(peeled, 'blob');
  }
  return commitSeeds;
}

interface NotMarks {
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

/** Mark every `not` tip's full ancestry (commits) and own tree (objects) —
 *  see the module doc. */
async function markNotSide(ctx: Context, not: ReadonlyArray<ObjectId>): Promise<NotMarks> {
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
async function markBoundaryTrees(
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

/**
 * `noWalk`'s own building block: emit each commit seed itself, skipping one
 * marked uninteresting, with no parent enqueue at all. `maxCount` still
 * bounds how many seeds are emitted; `objects` still emits each seed's own
 * tree.
 */
async function emitSeedsWithoutWalking(
  ctx: Context,
  commitSeeds: ReadonlyArray<Commit>,
  marks: NotMarks,
  request: ClosureRequest,
  emit: Emit,
): Promise<void> {
  let emitted = 0;
  for (const seed of commitSeeds) {
    if (marks.commits.has(seed.id)) continue;
    if (request.maxCount !== undefined && emitted >= request.maxCount) return;
    emit(seed.id, 'commit');
    emitted += 1;
    if (request.objects) await emitTree(ctx, seed.data.tree, marks.objects, emit);
  }
}

/**
 * Walk the commit seeds' ancestry, bounded by `maxCount` and ordered by
 * `firstParent`, buffered first: boundary-tree discovery (`markBoundaryTrees`)
 * needs the FULL walked set before any tree is emitted, since a boundary a
 * later commit surfaces must still gate an earlier commit's own tree walk.
 */
async function walkAndEmitCommits(
  ctx: Context,
  commitSeeds: ReadonlyArray<Commit>,
  marks: NotMarks,
  request: ClosureRequest,
  emit: Emit,
): Promise<void> {
  const walked: Commit[] = [];
  for await (const commit of walkCommits(ctx, {
    from: commitSeeds.map((seed) => seed.id),
    until: [...marks.commits],
    ignoreMissing: true,
    order: request.firstParent === true ? 'first-parent' : 'topo',
  })) {
    walked.push(commit);
    if (request.maxCount !== undefined && walked.length >= request.maxCount) break;
  }

  if (request.objects) await markBoundaryTrees(ctx, walked, marks);

  for (const commit of walked) {
    emit(commit.id, 'commit');
    if (request.objects) await emitTree(ctx, commit.data.tree, marks.objects, emit);
  }
}

/** Dispatch the commit-seed side of the closure: no seeds, `maxCount: 0`, `noWalk`, or the full walk. */
async function emitCommitSeeds(
  ctx: Context,
  commitSeeds: ReadonlyArray<Commit>,
  marks: NotMarks,
  request: ClosureRequest,
  emit: Emit,
): Promise<void> {
  if (commitSeeds.length === 0 || request.maxCount === 0) return;
  if (request.noWalk === true)
    return emitSeedsWithoutWalking(ctx, commitSeeds, marks, request, emit);
  return walkAndEmitCommits(ctx, commitSeeds, marks, request, emit);
}

export async function computeClosure(
  ctx: Context,
  request: ClosureRequest,
): Promise<ClosureResult> {
  if (request.wants.length === 0) return { objects: [] };

  const state: EmitState = { emitted: new Set<ObjectId>(), cap: MAX_PUSH_OBJECTS };
  const results: ClosureObject[] = [];
  const emit: Emit = (id, type, path) => {
    if (!tryEmit(state, id)) return;
    results.push(path === undefined ? { id, type } : { id, type, path });
  };

  const marks = await markNotSide(ctx, request.not);
  const commitSeeds = await resolveWants(ctx, request.wants, emit);
  await emitCommitSeeds(ctx, commitSeeds, marks, request, emit);

  return { objects: results };
}
