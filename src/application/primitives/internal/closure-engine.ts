/**
 * Shared reachability closure engine. Computes the objects reachable from
 * `wants` and excludes what `not` covers, through either of two tiers the
 * REQUEST selects — `tier` is required and the engine holds no default,
 * because the two commands that call it disagree on what "unset" should
 * mean. `'bitmap'` prefers a usable midx bitmap for the in-use generation,
 * then a usable pack bitmap, then falls back to the walk on any fault,
 * silently — artefact preference, not tier preference: the two bitmap
 * artefacts compute the identical answer, so which one served it is never
 * observable from the result alone. `'walk'` always walks.
 *
 * What the walk excludes, and the commit/tree asymmetry that reproduces
 * git's own over-report, lives in `closure-not-marks.ts`.
 *
 * Order is deterministic for a given call, but is not git's own order and is
 * not equal across calls with different shapes — callers that need a stable
 * display order sort the result themselves.
 */
import {
  type Commit,
  type FilePath,
  isDirectory,
  type ObjectId,
} from '../../../domain/objects/index.js';
import { PACK_NAME_HASH_SEED, PACK_NAME_HASH_V1 } from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import { getPackRegistry, readObject } from '../read-object.js';
import { MAX_PUSH_OBJECTS } from '../types.js';
import { isGitlink } from '../validators.js';
import { walkCommits } from '../walk-commits.js';
import { walkTree } from '../walk-tree.js';
import { type BitmapClosureRequest, resolveBitmapClosure } from './bitmap-binding.js';
import {
  markBoundaryTrees,
  markNotSide,
  type NotMarks,
  type WalkedCommit,
} from './closure-not-marks.js';
import { loadMidxBitmapArtefact } from './midx-bitmap-binding.js';
import { type EmitState, resolveTagChain, tryEmit } from './object-emit.js';
import { loadPackBitmapArtefact } from './pack-bitmap-binding.js';

/** `'bitmap'` asks for the bitmap tier (with a silent walk fallback on any
 *  fault); `'walk'` always walks. No default — see the module doc. */
export type ClosureTier = 'bitmap' | 'walk';

export interface ClosureRequest {
  readonly wants: ReadonlyArray<ObjectId>;
  readonly not: ReadonlyArray<ObjectId>;
  /** Include trees and blobs, not just commits and tags. */
  readonly objects: boolean;
  /** The tier the CALLER asks for — required, no engine-side default. */
  readonly tier: ClosureTier;
  /**
   * At most this many commits emitted (under `objects`, those commits and
   * everything they reach). Governs the commit walk only — tag/tree/blob
   * wants resolved outside it are unaffected. `0` walks no commits at all.
   * Omitted means unbounded. Forces the walk tier regardless of `tier`
   * (git itself abandons the bitmap for it).
   */
  readonly maxCount?: number;
  /** Follow only the first parent of each commit. Omitted means every
   *  parent. Ignored on the bitmap tier, which does not traverse. */
  readonly firstParent?: boolean;
  /**
   * Emit the resolved commit seeds themselves and stop — no parent
   * traversal. Under `objects`, each seed's own tree still counts.
   * Ignored on the bitmap tier, which does not traverse.
   */
  readonly noWalk?: boolean;
}

export interface ClosureObject {
  readonly id: ObjectId;
  readonly type: 'commit' | 'tree' | 'blob' | 'tag';
  /**
   * Populated by the walk. A reachability artefact encodes types and bits,
   * never names, so the bitmap tier never fills this.
   */
  readonly path?: FilePath;
  /**
   * git's `pack_name_hash` of `path`; `0` for a path-less object. Populated
   * by the walk tier only — a reachability artefact encodes types and bits,
   * never names, so the bitmap tier never fills this.
   */
  readonly nameHash?: number;
}

export interface ClosureResult {
  readonly objects: ReadonlyArray<ClosureObject>;
  /** The tier that actually answered — a `'bitmap'` request still answers
   *  `'walk'` after a silent fallback. Internal: neither command surfaces
   *  this, since artefact choice selects between two computations of the
   *  same answer. */
  readonly tier: ClosureTier;
}

/** One record per `emit` call, rather than four positional arguments — a
 *  pathless call site just omits `path`, instead of spelling out a
 *  positional `undefined` that says nothing. `path` is a genuinely optional
 *  key (omitted, never `path: undefined`); `walkClosure` pushes this record
 *  straight onto its result, so key absence here IS key absence on the
 *  returned `ClosureObject`. */
interface ClosureEmission {
  readonly id: ObjectId;
  readonly type: ClosureObject['type'];
  readonly path?: FilePath;
  readonly nameHash: number;
}

type Emit = (entry: ClosureEmission) => void;

/** Root tree entries carry the empty path — git's own convention for the
 *  tree named directly by a commit (or a tree-typed want), as opposed to
 *  the paths `walkTree` assigns its descendants. */
const ROOT_PATH = '' as FilePath;

const NO_MARKS: ReadonlySet<ObjectId> = new Set();

/**
 * What `emitTree` needs to know beyond the tree it is walking: the not-side's
 * marks, the closure-wide set of ids already emitted (by reference — this
 * MUST be the live set the closure keeps growing, never a copy, since the
 * prune below reads it as the walk proceeds), and `core.maxTreeDepth`
 * resolved once for the whole closure rather than once per `emitTree` call.
 */
interface TreeEmitScope {
  readonly marked: ReadonlySet<ObjectId>;
  readonly emitted: ReadonlySet<ObjectId>;
  readonly maxDepth: number;
}

/**
 * Emit `treeId` and its non-gitlink contents, skipping anything marked
 * uninteresting or already emitted. `path` and `nameHash` come from
 * `walkTree`'s own fold (`PACK_NAME_HASH_V1`); the root tree itself carries
 * the empty path and the fold's seed.
 *
 * Mirrors git's `process_tree` (`list-objects.c`): a tree already
 * UNINTERESTING or SEEN is never expanded, and never re-emitted, on the
 * interesting side — the root short-circuit below returns before even the
 * root emit, and `skipTree` prunes each already-known directory entry from
 * the descent while still yielding the entry itself.
 */
async function emitTree(
  ctx: Context,
  treeId: ObjectId,
  scope: TreeEmitScope,
  emit: Emit,
): Promise<void> {
  if (scope.marked.has(treeId) || scope.emitted.has(treeId)) return;
  emit({ id: treeId, type: 'tree', path: ROOT_PATH, nameHash: PACK_NAME_HASH_SEED });
  const skipTree = (id: ObjectId): boolean => scope.marked.has(id) || scope.emitted.has(id);
  for await (const entry of walkTree(ctx, treeId, {
    pathHasher: PACK_NAME_HASH_V1,
    maxDepth: scope.maxDepth,
    skipTree,
  })) {
    if (isGitlink(entry.mode)) continue;
    if (scope.marked.has(entry.id)) continue;
    emit({
      id: entry.id,
      type: isDirectory(entry.mode) ? 'tree' : 'blob',
      path: entry.path,
      nameHash: entry.nameHash ?? 0,
    });
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
  scope: TreeEmitScope,
  emit: Emit,
): Promise<Commit[]> {
  const commitSeeds: Commit[] = [];
  for (const wantId of wants) {
    const peeled = await resolveTagChain(ctx, wantId, (tagId) =>
      emit({ id: tagId, type: 'tag', nameHash: 0 }),
    );
    const obj = await readObject(ctx, peeled);
    if (obj.type === 'commit') {
      commitSeeds.push(obj);
      continue;
    }
    if (obj.type === 'tree') {
      await emitTree(ctx, peeled, { ...scope, marked: NO_MARKS }, emit);
      continue;
    }
    // A recorded divergence: git names a direct want after the pending
    // object's own name; tsgit has none to give it, so it hashes to 0.
    emit({ id: peeled, type: 'blob', nameHash: 0 });
  }
  return commitSeeds;
}

/**
 * `noWalk`'s own building block, reached only when there is no `not` side
 * (git ignores `--no-walk` with a range): emit each commit seed itself with no
 * parent enqueue at all. `maxCount` still bounds how many seeds are emitted;
 * `objects` still emits each seed's own tree. With no `not` side there is no
 * boundary tree to mark.
 */
async function emitSeedsWithoutWalking(
  ctx: Context,
  commitSeeds: ReadonlyArray<Commit>,
  marks: NotMarks,
  scope: TreeEmitScope,
  request: ClosureRequest,
  emit: Emit,
): Promise<void> {
  let emitted = 0;
  for (const seed of commitSeeds) {
    if (marks.commits.has(seed.id)) continue;
    if (request.maxCount !== undefined && emitted >= request.maxCount) return;
    emit({ id: seed.id, type: 'commit', nameHash: 0 });
    emitted += 1;
    if (request.objects) await emitTree(ctx, seed.data.tree, scope, emit);
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
  scope: TreeEmitScope,
  request: ClosureRequest,
  emit: Emit,
): Promise<void> {
  // git's `mark_edges_uninteresting` runs over the WHOLE interesting frontier
  // (`limit_list`) before `--max-count` truncates the output, so an edge parent
  // beyond the count still has its tree marked. A limited-objects walk (one with
  // a `not` side) must therefore drain to the `until` boundary before applying
  // `maxCount`; a commits-only or negative-free walk has no boundary to discover
  // past the cap and breaks early as before.
  const drainsFully = request.objects === true && marks.commits.size > 0;
  const walked: WalkedCommit[] = [];
  for await (const commit of walkCommits(ctx, {
    from: commitSeeds.map((seed) => seed.id),
    until: marks.commits,
    ignoreMissing: true,
    order: request.firstParent === true ? 'first-parent' : 'topo',
  })) {
    walked.push({ id: commit.id, tree: commit.data.tree, parents: commit.data.parents });
    if (request.maxCount !== undefined && walked.length >= request.maxCount && !drainsFully) break;
  }

  if (request.objects) await markBoundaryTrees(ctx, walked, marks);

  const emitted = request.maxCount !== undefined ? walked.slice(0, request.maxCount) : walked;
  for (const commit of emitted) {
    emit({ id: commit.id, type: 'commit', nameHash: 0 });
    if (request.objects) await emitTree(ctx, commit.tree, scope, emit);
  }
}

/** Dispatch the commit-seed side of the closure: no seeds, `maxCount: 0`, `noWalk`, or the full walk. */
async function emitCommitSeeds(
  ctx: Context,
  commitSeeds: ReadonlyArray<Commit>,
  marks: NotMarks,
  scope: TreeEmitScope,
  request: ClosureRequest,
  emit: Emit,
): Promise<void> {
  if (commitSeeds.length === 0 || request.maxCount === 0) return;
  // git ignores `--no-walk` once a range (a `not` tip) is present, falling back
  // to the ordinary bounded walk; `noWalk` shows only the tips solely when there
  // is nothing to exclude.
  if (request.noWalk === true && request.not.length === 0)
    return emitSeedsWithoutWalking(ctx, commitSeeds, marks, scope, request, emit);
  return walkAndEmitCommits(ctx, commitSeeds, marks, scope, request, emit);
}

async function walkClosure(ctx: Context, request: ClosureRequest): Promise<ClosureObject[]> {
  const state: EmitState = { emitted: new Set<ObjectId>(), cap: MAX_PUSH_OBJECTS };
  const results: ClosureObject[] = [];
  const emit: Emit = (entry) => {
    if (!tryEmit(state, entry.id)) return;
    results.push(entry);
  };

  const marks = await markNotSide(ctx, request.not);
  const scope: TreeEmitScope = {
    marked: marks.objects,
    emitted: state.emitted,
    maxDepth: marks.maxDepth,
  };
  const commitSeeds = await resolveWants(ctx, request.wants, scope, emit);
  await emitCommitSeeds(ctx, commitSeeds, marks, scope, request, emit);

  return results;
}

function projectedRequest(request: ClosureRequest): BitmapClosureRequest {
  return { wants: request.wants, not: request.not, objects: request.objects };
}

/**
 * Artefact preference, exclusive and by artefact, not by tier: a usable midx
 * bitmap for the in-use midx generation answers alone — the pack-bitmap loop
 * below is never even reached — one arm below the walk fallback for a midx
 * bitmap declined on a fault (parse refusal or an out-of-range position),
 * which lands on the SAME pack-bitmap loop a missing/absent midx bitmap
 * would. Every registered pack's bitmap is then tried in turn, answering
 * from the first that loads and range-validates. `undefined` when nothing
 * does, the caller's signal to fall back to the walk with nothing surfaced.
 */
async function tryBitmapClosure(
  ctx: Context,
  request: ClosureRequest,
): Promise<ClosureObject[] | undefined> {
  const registry = getPackRegistry(ctx);
  const midxArtefact = await loadMidxBitmapArtefact(ctx, await registry.midxBitmap());
  if (midxArtefact !== undefined) {
    return [...(await resolveBitmapClosure(ctx, midxArtefact, projectedRequest(request)))];
  }

  const packs = await registry.all();
  for (const pack of packs) {
    const artefact = await loadPackBitmapArtefact(ctx, pack);
    if (artefact === undefined) continue;
    return [...(await resolveBitmapClosure(ctx, artefact, projectedRequest(request)))];
  }
  return undefined;
}

export async function computeClosure(
  ctx: Context,
  request: ClosureRequest,
): Promise<ClosureResult> {
  if (request.wants.length === 0) return { objects: [], tier: request.tier };

  // `maxCount` defeats the bitmap here, in the engine that owns the contract,
  // rather than only in the callers that happen to project it — git itself
  // abandons the bitmap for a bounded count, and a bitmap has no bounded
  // sub-answer to give: it would silently return the whole closure.
  if (request.tier === 'bitmap' && request.maxCount === undefined) {
    const bitmapObjects = await tryBitmapClosure(ctx, request);
    if (bitmapObjects !== undefined) return { objects: bitmapObjects, tier: 'bitmap' };
  }

  return { objects: await walkClosure(ctx, request), tier: 'walk' };
}
