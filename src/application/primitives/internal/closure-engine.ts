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
 * With a commit on the `not` side the walk is git's limited walk
 * (`limit_list`, `limit-list.ts`): it may give up on a clock-skewed excluded
 * line before reaching a shared ancestor and list it, exactly as git's
 * `rev-list` and `pack-objects --revs` do. The bitmap tier answers the exact
 * set difference, as git's bitmap path does. What the walk excludes, and the
 * commit/tree asymmetry that reproduces git's own over-report, lives in
 * `closure-not-marks.ts`.
 *
 * Order is deterministic for a given call, but is not git's own order and is
 * not equal across calls with different shapes — callers that need a stable
 * display order sort the result themselves.
 */

import type { TsgitError } from '../../../domain/error.js';
import { errorDataCode } from '../../../domain/error-data-code.js';
import { badTreeObject, treeEntryTypeMismatch } from '../../../domain/objects/error.js';
import {
  type Commit,
  type FilePath,
  isDirectory,
  type ObjectId,
} from '../../../domain/objects/index.js';
import { PACK_NAME_HASH_SEED, PACK_NAME_HASH_V1 } from '../../../domain/storage/index.js';
import type { Context } from '../../../ports/context.js';
import { getObjectStore } from '../object-store.js';
import { readObject } from '../read-object.js';
import { readTree } from '../read-tree.js';
import { MAX_PUSH_OBJECTS } from '../types.js';
import { isGitlink } from '../validators.js';
import { walkCommitsStoppingAt } from '../walk-commits.js';
import { walkTree } from '../walk-tree.js';
import {
  type BitmapClosureRequest,
  type LoadedBitmapArtefact,
  resolveBitmapClosure,
} from './bitmap-binding.js';
import {
  createNotMarks,
  markBoundaryTrees,
  markNotTip,
  markSparseTrees,
  type NotMarks,
  type NotMarksAccumulator,
  readCommitMetaIfPresent,
  type SparseTreeSeed,
} from './closure-not-marks.js';
import {
  type LimitedWalk,
  limitList,
  limitOrFailSetup,
  resolveLimitOptions,
} from './limit-list.js';
import { loadMidxBitmapArtefact } from './midx-bitmap-binding.js';
import { type EmitState, resolveTagChain, tryEmit } from './object-emit.js';
import { assignObjectType, type ObjectTypeTable } from './object-type-table.js';
import { loadPackBitmapArtefact } from './pack-bitmap-binding.js';
import { descendTreePath } from './resolve-tree-path.js';

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
  /**
   * Mark the excluded side the way git's `pack.useSparse` does: only along
   * the paths both sides hold. Omitted means git's dense marking of every
   * edge tree, as `rev-list` does. Only a walk with a `not` side differs.
   */
  readonly sparse?: boolean;
  /** Follow only the first parent of each commit. Omitted means every
   *  parent. Ignored on the bitmap tier, which does not traverse. */
  readonly firstParent?: boolean;
  /**
   * Emit the resolved commit seeds themselves and stop — no parent
   * traversal. Under `objects`, each seed's own tree still counts.
   * Ignored on the bitmap tier, which does not traverse.
   */
  readonly noWalk?: boolean;
  /** The invocation's object-type table the wants are typed into; omitted, nothing is typed. */
  readonly objectTypes?: ObjectTypeTable;
  /**
   * Every tip of `wants` and `not`, in git's pending (command-line) order:
   * the order tips are peeled and marked, and which of equal-dated commits
   * the walk pops first. Omitted means `wants`, then `not`.
   */
  readonly tips?: ReadonlyArray<ClosureTip>;
}

/** One walk tip, wanted or excluded. */
export interface ClosureTip {
  readonly id: ObjectId;
  readonly excluded: boolean;
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
  readonly objectTypes: ObjectTypeTable | undefined;
}

const SEPARATOR = '/';

/**
 * git's `process_tree_contents` death on an entry its mode types against an
 * earlier lookup: the entry named within the tree that lists it.
 */
async function entryTypeMismatch(
  ctx: Context,
  rootId: ObjectId,
  path: FilePath,
  mode: 'tree' | 'blob',
): Promise<TsgitError> {
  const cut = path.lastIndexOf(SEPARATOR);
  if (cut === -1) return treeEntryTypeMismatch(rootId, path, mode);
  const holder = await descendTreePath(
    ctx,
    await readTree(ctx, rootId),
    path.slice(0, cut),
    rootId,
  );
  return treeEntryTypeMismatch(holder.id, path.slice(cut + 1), mode);
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
  try {
    await emitTreeContents(ctx, treeId, scope, emit);
  } catch (error) {
    throw asBadTree(ctx, scope, error);
  }
}

/**
 * git's `process_tree` parses a tree before listing it: under typing, a tree
 * stored as something else is `Object X not a tree`, then `bad tree object X`.
 */
const asBadTree = (ctx: Context, scope: TreeEmitScope, error: unknown): unknown => {
  if (scope.objectTypes === undefined || errorDataCode(error) !== 'UNEXPECTED_OBJECT_TYPE') {
    return error;
  }
  const { id } = (error as TsgitError).data as { readonly id: ObjectId };
  ctx.logger?.error?.(`Object ${id} not a tree`, { id });
  return badTreeObject(id);
};

async function emitTreeContents(
  ctx: Context,
  treeId: ObjectId,
  scope: TreeEmitScope,
  emit: Emit,
): Promise<void> {
  const skipTree = (id: ObjectId): boolean => scope.marked.has(id) || scope.emitted.has(id);
  for await (const entry of walkTree(ctx, treeId, {
    pathHasher: PACK_NAME_HASH_V1,
    maxDepth: scope.maxDepth,
    skipTree,
    strictSubtrees: scope.objectTypes !== undefined,
  })) {
    if (isGitlink(entry.mode)) continue;
    const type = isDirectory(entry.mode) ? 'tree' : 'blob';
    if (!assignObjectType(ctx, scope.objectTypes, entry.id, type)) {
      throw await entryTypeMismatch(ctx, treeId, entry.path, type);
    }
    if (scope.marked.has(entry.id)) continue;
    emit({
      id: entry.id,
      type,
      path: entry.path,
      nameHash: entry.nameHash ?? 0,
    });
  }
}

/** A want git keeps pending past the commit walk — a tag, a tree or a blob —
 *  shown only if the walk has not marked it uninteresting by then. */
interface PendingObject {
  readonly id: ObjectId;
  readonly type: Exclude<ClosureObject['type'], 'commit'>;
}

interface ResolvedWants {
  readonly commitSeeds: ReadonlyArray<Commit>;
  readonly pending: ReadonlyArray<PendingObject>;
  /** Every commit tip, wanted or excluded, in pending order — the walk's arrival order. */
  readonly seeds: ReadonlyArray<ObjectId>;
}

interface ResolvingWants {
  readonly commitSeeds: Commit[];
  readonly pending: PendingObject[];
  readonly seeds: ObjectId[];
}

const pendingTips = (request: ClosureRequest): ReadonlyArray<ClosureTip> =>
  request.tips ?? [
    ...request.wants.map((id) => ({ id, excluded: false })),
    ...request.not.map((id) => ({ id, excluded: true })),
  ];

/**
 * git's `prepare_revision_walk`: each tip in pending order — an excluded one
 * marked, a wanted one resolved — and every commit among them seeded in that
 * order.
 */
async function resolveTips(
  ctx: Context,
  request: ClosureRequest,
  marks: NotMarksAccumulator,
): Promise<ResolvedWants> {
  const resolving: ResolvingWants = { commitSeeds: [], pending: [], seeds: [] };
  for (const tip of pendingTips(request)) {
    const commit = tip.excluded
      ? await markNotTip(ctx, tip.id, marks)
      : await resolveWant(ctx, request, tip.id, resolving);
    if (commit !== undefined) resolving.seeds.push(commit);
  }
  return resolving;
}

/**
 * Resolve one want: peel tags (keeping each tag pending), then either seed
 * the commit walk or keep a tree/blob want pending. Commit seeds carry their
 * full body so the `noWalk` path can emit them (and, under `objects`, their
 * own tree) without a second read. Answers the commit seeded, if any.
 */
async function resolveWant(
  ctx: Context,
  request: ClosureRequest,
  wantId: ObjectId,
  resolving: ResolvingWants,
): Promise<ObjectId | undefined> {
  const peeled = await resolveTagChain(ctx, request.objectTypes, wantId, (tagId) =>
    resolving.pending.push({ id: tagId, type: 'tag' }),
  );
  const obj = await readObject(ctx, peeled);
  if (obj.type !== 'commit') {
    resolving.pending.push({ id: peeled, type: obj.type });
    return undefined;
  }
  resolving.commitSeeds.push(obj);
  return obj.id;
}

/**
 * git's `traverse_non_commits`: a pending tag, tree or blob is shown unless
 * flagged uninteresting — named by the not side, reached through an excluded
 * tag or tree, or held by a boundary commit's tree the walk marked. A tree
 * want is the root of its own subtree, so it carries the empty path.
 */
async function emitPending(
  ctx: Context,
  pending: ReadonlyArray<PendingObject>,
  scope: TreeEmitScope,
  emit: Emit,
): Promise<void> {
  for (const object of pending) {
    if (object.type === 'tree') {
      await emitTree(ctx, object.id, scope, emit);
      continue;
    }
    if (scope.marked.has(object.id)) continue;
    // A recorded divergence: git names a direct blob want after the pending
    // object's own name; tsgit has none to give it, so it hashes to 0.
    emit({ id: object.id, type: object.type, nameHash: 0 });
  }
}

/**
 * `noWalk`'s own building block, reached only when there is no `not` side
 * (git ignores `--no-walk` with a range): each commit seed itself with no
 * parent enqueue at all. `maxCount` still bounds how many seeds are listed.
 * With no `not` side there is no boundary tree to mark.
 */
const seedsWithoutWalking = (
  commitSeeds: ReadonlyArray<Commit>,
  request: ClosureRequest,
): ReadonlyArray<WalkedCommit> =>
  (request.maxCount === undefined ? commitSeeds : commitSeeds.slice(0, request.maxCount)).map(
    walkedFrom,
  );

/** The slice of a walked commit the emit pass needs. */
interface WalkedCommit {
  readonly id: ObjectId;
  readonly tree: ObjectId;
}

/** The commits a walk lists, and the uninteresting ones whose trees it marks. */
interface CommitWalk {
  readonly walked: ReadonlyArray<WalkedCommit>;
  readonly boundary: ReadonlySet<ObjectId>;
  /** The limited walk, whose listed commits sparse marking groups. */
  readonly limited?: LimitedWalk;
}

const walkedFrom = (commit: Commit): WalkedCommit => ({ id: commit.id, tree: commit.data.tree });

/**
 * Nothing excluded. A typing or counted walk is git's streaming
 * `get_revision`, which parses each parent as it pops a commit — newest
 * first, ties in arrival order — and dies on the first commit whose parents
 * it cannot parse; `limitList` walks exactly that order, refuses naming that
 * commit, and a count stops it once that many commits have had their parents
 * parsed. Otherwise any order reaches the same set.
 */
async function collectUnlimitedWalk(
  ctx: Context,
  commitSeeds: ReadonlyArray<Commit>,
  request: ClosureRequest,
): Promise<CommitWalk> {
  const from = commitSeeds.map((seed) => seed.id);
  if (request.objectTypes !== undefined || request.maxCount !== undefined) {
    return collectStreamedWalk(ctx, from, request);
  }
  const order = request.firstParent === true ? 'first-parent' : 'breadth-first';
  const walked: WalkedCommit[] = [];
  for await (const commit of walkCommitsStoppingAt(ctx, { from, ignoreMissing: true, order })) {
    walked.push(walkedFrom(commit));
  }
  return { walked, boundary: NO_MARKS };
}

async function collectStreamedWalk(
  ctx: Context,
  from: ReadonlyArray<ObjectId>,
  request: ClosureRequest,
): Promise<CommitWalk> {
  const { objectTypes, maxCount } = request;
  const options = await resolveLimitOptions(
    ctx,
    { from, ignoreMissing: objectTypes === undefined },
    {
      until: new Set(),
      firstParent: request.firstParent === true,
      settle: 'slop',
      ...(objectTypes === undefined ? {} : { objectTypes }),
      ...(maxCount === undefined ? {} : { takeAtMost: maxCount }),
    },
  );
  const { shownHeads } = await limitList(ctx, options);
  return { walked: shownHeads, boundary: NO_MARKS };
}

/**
 * git's `mark_edges_uninteresting` edges: every uninteresting parent of a
 * listed commit, and every commit listed before it turned uninteresting.
 */
const edgesOf = (walk: LimitedWalk): ReadonlySet<ObjectId> => {
  const boundary = new Set(walk.dropped);
  for (const commit of walk.shownHeads) {
    for (const parent of commit.parents) {
      if (walk.uninteresting.has(parent)) boundary.add(parent);
    }
  }
  return boundary;
};

/**
 * A commit excluded: git's `limit_list` over both sides, which runs to
 * completion before `maxCount` truncates the list — an edge beyond the count
 * still has its tree marked, as `mark_edges_uninteresting` sees the whole list.
 */
async function collectLimitedWalk(
  ctx: Context,
  resolved: ResolvedWants,
  marks: NotMarks,
  request: ClosureRequest,
): Promise<CommitWalk> {
  const options = await resolveLimitOptions(
    ctx,
    {
      from: resolved.commitSeeds.map((seed) => seed.id),
      ignoreMissing: request.objectTypes === undefined,
    },
    {
      seeds: resolved.seeds,
      until: new Set(marks.commitTips),
      firstParent: request.firstParent === true,
      settle: 'slop',
      ...(request.objectTypes === undefined ? {} : { objectTypes: request.objectTypes }),
    },
  );
  const walk = await limitOrFailSetup(ctx, options);
  return { walked: walk.shownHeads, boundary: edgesOf(walk), limited: walk };
}

/**
 * git's sparse `mark_edges_uninteresting` seeds: every commit the limited
 * walk keeps in its list — the shown ones and those it dropped — and every
 * parent of one, each tree flagged with its commit's exclusion.
 */
async function sparseSeedsOf(
  ctx: Context,
  walk: LimitedWalk,
): Promise<ReadonlyArray<SparseTreeSeed>> {
  const trees = new Map(walk.shownHeads.map((commit) => [commit.id, commit.tree]));
  const seeds: SparseTreeSeed[] = [];
  const commits = [...walk.shownHeads, ...(await readDropped(ctx, walk.dropped))];
  for (const commit of commits) {
    seeds.push({ tree: commit.tree, excluded: walk.uninteresting.has(commit.id) });
    for (const parent of commit.parents) {
      const tree = trees.get(parent) ?? (await readCommitMetaIfPresent(ctx, parent))?.tree;
      if (tree !== undefined) seeds.push({ tree, excluded: walk.uninteresting.has(parent) });
    }
  }
  return seeds;
}

const readDropped = async (
  ctx: Context,
  dropped: Iterable<ObjectId>,
): Promise<ReadonlyArray<{ id: ObjectId; tree: ObjectId; parents: ReadonlyArray<ObjectId> }>> => {
  const out: { id: ObjectId; tree: ObjectId; parents: ReadonlyArray<ObjectId> }[] = [];
  for (const id of dropped) {
    const meta = await readCommitMetaIfPresent(ctx, id);
    if (meta !== undefined) out.push({ id, tree: meta.tree, parents: meta.parents });
  }
  return out;
};

/**
 * Walk the commit seeds' ancestry, bounded by `maxCount` and ordered by
 * `firstParent`, buffered first: boundary-tree marking (`markBoundaryTrees`)
 * needs the FULL walk before any tree is emitted, since a boundary a later
 * commit surfaces must still gate an earlier commit's own tree walk — and a
 * pending tree or blob want, which git shows only after the commit walk.
 */
async function walkCommitSeeds(
  ctx: Context,
  resolved: ResolvedWants,
  marks: NotMarks,
  request: ClosureRequest,
): Promise<ReadonlyArray<WalkedCommit>> {
  const commitWalk =
    marks.commitTips.length === 0
      ? await collectUnlimitedWalk(ctx, resolved.commitSeeds, request)
      : await collectLimitedWalk(ctx, resolved, marks, request);
  if (request.objects) await markExcludedTrees(ctx, commitWalk, marks, request);
  const { walked } = commitWalk;
  return request.maxCount !== undefined ? walked.slice(0, request.maxCount) : walked;
}

async function markExcludedTrees(
  ctx: Context,
  walk: CommitWalk,
  marks: NotMarks,
  request: ClosureRequest,
): Promise<void> {
  if (request.sparse !== true || walk.limited === undefined) {
    await markBoundaryTrees(ctx, walk.boundary, marks);
    return;
  }
  await markSparseTrees(ctx, await sparseSeedsOf(ctx, walk.limited), marks);
}

/** Dispatch the commit-seed side of the closure: no seeds, `maxCount: 0`, `noWalk`, or the full walk. */
async function listCommitSeeds(
  ctx: Context,
  resolved: ResolvedWants,
  marks: NotMarks,
  request: ClosureRequest,
): Promise<ReadonlyArray<WalkedCommit>> {
  const { commitSeeds } = resolved;
  if (commitSeeds.length === 0 || request.maxCount === 0) return [];
  // git ignores `--no-walk` once a range (a `not` tip) is present, falling back
  // to the ordinary bounded walk; `noWalk` shows only the tips solely when there
  // is nothing to exclude.
  if (request.noWalk === true && request.not.length === 0)
    return seedsWithoutWalking(commitSeeds, request);
  return walkCommitSeeds(ctx, resolved, marks, request);
}

/**
 * git's `traverse_commit_list`: every listed commit as the walk shows it, then
 * — under `objects` — the pending tags, trees and blobs, then each listed
 * commit's tree, which the walk queued behind them.
 */
async function emitListed(
  ctx: Context,
  listed: {
    readonly walked: ReadonlyArray<WalkedCommit>;
    readonly pending: ReadonlyArray<PendingObject>;
  },
  scope: TreeEmitScope,
  request: ClosureRequest,
  emit: Emit,
): Promise<void> {
  for (const commit of listed.walked) emit({ id: commit.id, type: 'commit', nameHash: 0 });
  if (!request.objects) return;
  await emitPending(ctx, listed.pending, scope, emit);
  for (const commit of listed.walked) await emitTree(ctx, commit.tree, scope, emit);
}

async function walkClosure(ctx: Context, request: ClosureRequest): Promise<ClosureObject[]> {
  const state: EmitState = { emitted: new Set<ObjectId>(), cap: MAX_PUSH_OBJECTS };
  const results: ClosureObject[] = [];
  const emit: Emit = (entry) => {
    if (!tryEmit(state, entry.id)) return;
    results.push(entry);
  };

  const marks = await createNotMarks(ctx, {
    objects: request.objects,
    ...(request.objectTypes === undefined ? {} : { objectTypes: request.objectTypes }),
  });
  const scope: TreeEmitScope = {
    marked: marks.objects,
    emitted: state.emitted,
    maxDepth: marks.maxDepth,
    objectTypes: request.objectTypes,
  };
  const resolved = await resolveTips(ctx, request, marks);
  const walked = await listCommitSeeds(ctx, resolved, marks, request);
  await emitListed(ctx, { walked, pending: resolved.pending }, scope, request, emit);

  return results;
}

function projectedRequest(request: ClosureRequest): BitmapClosureRequest {
  const { wants, not, objects, objectTypes } = request;
  return objectTypes === undefined ? { wants, not, objects } : { wants, not, objects, objectTypes };
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
  const { sources } = await getObjectStore(ctx);
  // Every source's midx is prepared (and may refuse) before any bitmap is
  // opened, even when the first midx bitmap answers alone, and every midx
  // bitmap outranks every pack bitmap — git's `open_midx_bitmap` order.
  for (const { registry } of sources) await registry.assertLoadable();
  for (const { registry } of sources) {
    const midxArtefact = await loadMidxBitmapArtefact(ctx, await registry.midxBitmap());
    if (midxArtefact !== undefined) return closureFrom(ctx, midxArtefact, request);
  }

  for (const { registry } of sources) {
    for (const pack of await registry.all()) {
      const artefact = await loadPackBitmapArtefact(ctx, pack);
      if (artefact !== undefined) return closureFrom(ctx, artefact, request);
    }
  }
  return undefined;
}

async function closureFrom(
  ctx: Context,
  artefact: LoadedBitmapArtefact,
  request: ClosureRequest,
): Promise<ClosureObject[]> {
  return [...(await resolveBitmapClosure(ctx, artefact, projectedRequest(request)))];
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
