/**
 * Bundle object and boundary enumeration.
 *
 * Computes the exact set of git objects to pack into a bundle and the
 * boundary (prerequisite) commits — implementing the semantics of
 * `git rev-list --objects --boundary <wants> --not <haves>`.
 *
 * Two-phase algorithm:
 * 1. Walk ALL commits reachable from `haves` and collect their full object
 *    closure (commits + trees + blobs) into an "uninteresting" set.
 * 2. Walk commits from `wants` stopping at the full uninteresting closure
 *    (not just the direct haves tips), emit objects NOT in the uninteresting
 *    set, and record each parent that is in the uninteresting closure as a
 *    boundary commit.
 *
 * The full-closure `until` in phase 2 is load-bearing for the criss-cross
 * boundary case: passing `haves` directly as the stop frontier would miss
 * ancestors of the exclude tips that are direct parents of interesting
 * commits, yielding an incorrect boundary set.
 *
 * A shared `seenTrees` Set is threaded across both phases so that any
 * subtree already fully traversed is not re-read. This prunes O(commits ×
 * shared-subtrees) re-reads down to O(unique-trees) — critical for
 * incremental bundles where near-root subtrees appear in every commit.
 */
import { operationAborted } from '../../domain/error.js';
import { treeDepthExceeded } from '../../domain/objects/error.js';
import { type FileMode, isDirectory, type ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { type EmitState, resolveTagChain, tryEmit } from './internal/object-emit.js';
import { readObject } from './read-object.js';
import { MAX_PUSH_OBJECTS } from './types.js';
import { isGitlink } from './validators.js';
import { walkCommits } from './walk-commits.js';

// Same bound as walk-tree.ts's default maxDepth — prevents stack overflow on
// pathologically deep tree structures.
const MAX_TREE_DEPTH = 1024;

export interface EnumerateBundleObjectsInput {
  /** Positive endpoint oids — commits or annotated tags. */
  readonly wants: ReadonlyArray<ObjectId>;
  /** Excluded commit oids — explicit excludes or computed merge-bases. */
  readonly haves: ReadonlyArray<ObjectId>;
  /** Hard cap on total emitted objects. Defaults to MAX_PUSH_OBJECTS. */
  readonly maxObjects?: number;
}

export interface BundleObjectClosure {
  /** Deduped object set for pack building: tags + commits + trees + blobs. */
  readonly objects: ReadonlyArray<ObjectId>;
  /**
   * Boundary commit oids — commits in the uninteresting closure that are
   * direct parents of interesting commits. UNSORTED: the caller sorts by
   * oid ascending before serialising the bundle header.
   */
  readonly boundary: ReadonlyArray<ObjectId>;
}

interface UninterestingClosure {
  readonly commits: Set<ObjectId>;
  readonly objects: Set<ObjectId>;
}

// Bundle-local extension: adds boundary tracking for prerequisite commit detection.
interface BundleEmitState extends EmitState {
  readonly boundary: Set<ObjectId>;
}

// Walk a tree recursively, collecting all non-gitlink object ids into
// `objects`. Subtrees already in `seenTrees` are skipped — their objects are
// already collected, so descending again would be redundant.
//
// No per-walk flat-entry cap is applied here: this is a prepass over LOCAL
// repo objects on the create path, and the PACK_TOO_LARGE guard in tryEmit
// already bounds the total number of emitted (interesting) objects.
const collectTreeObjects = async (
  ctx: Context,
  treeId: ObjectId,
  objects: Set<ObjectId>,
  seenTrees: Set<ObjectId>,
  depth = 0,
): Promise<void> => {
  if (seenTrees.has(treeId)) return;
  seenTrees.add(treeId);
  if (depth > MAX_TREE_DEPTH) throw treeDepthExceeded(depth);
  if (ctx.signal?.aborted) throw operationAborted();
  objects.add(treeId);
  const treeObj = await readObject(ctx, treeId);
  if (treeObj.type !== 'tree') return;
  for (const entry of treeObj.entries) {
    if (isGitlink(entry.mode)) continue;
    if (!isDirectory(entry.mode as FileMode)) {
      objects.add(entry.id);
      continue;
    }
    await collectTreeObjects(ctx, entry.id, objects, seenTrees, depth + 1);
  }
};

// Walk a tree recursively, emitting non-gitlink objects absent from
// `uninteresting`. Subtrees already in `seenTrees` are skipped — either all
// their objects are already in `uninteresting` (nothing to emit) or they were
// already emitted during an earlier commit's walk.
const emitTreeObjects = async (
  ctx: Context,
  treeId: ObjectId,
  uninteresting: Set<ObjectId>,
  state: BundleEmitState,
  seenTrees: Set<ObjectId>,
  depth = 0,
): Promise<void> => {
  if (seenTrees.has(treeId)) return;
  seenTrees.add(treeId);
  if (depth > MAX_TREE_DEPTH) throw treeDepthExceeded(depth);
  if (ctx.signal?.aborted) throw operationAborted();
  if (!uninteresting.has(treeId)) tryEmit(state, treeId);
  const treeObj = await readObject(ctx, treeId);
  if (treeObj.type !== 'tree') return;
  for (const entry of treeObj.entries) {
    if (isGitlink(entry.mode)) continue;
    if (isDirectory(entry.mode as FileMode)) {
      await emitTreeObjects(ctx, entry.id, uninteresting, state, seenTrees, depth + 1);
      continue;
    }
    if (!uninteresting.has(entry.id)) tryEmit(state, entry.id);
  }
};

const collectUninteresting = async (
  ctx: Context,
  haves: ReadonlyArray<ObjectId>,
  seenTrees: Set<ObjectId>,
): Promise<UninterestingClosure> => {
  const commits = new Set<ObjectId>();
  const objects = new Set<ObjectId>();
  if (haves.length === 0) return { commits, objects };
  for await (const commit of walkCommits(ctx, { from: haves, ignoreMissing: true })) {
    commits.add(commit.id);
    objects.add(commit.id);
    await collectTreeObjects(ctx, commit.data.tree, objects, seenTrees);
  }
  return { commits, objects };
};

const walkInteresting = async (
  ctx: Context,
  seeds: ReadonlyArray<ObjectId>,
  uninteresting: UninterestingClosure,
  state: BundleEmitState,
  seenTrees: Set<ObjectId>,
): Promise<void> => {
  for await (const commit of walkCommits(ctx, {
    from: seeds,
    until: [...uninteresting.commits],
    ignoreMissing: true,
  })) {
    tryEmit(state, commit.id);
    await emitTreeObjects(ctx, commit.data.tree, uninteresting.objects, state, seenTrees);
    for (const parent of commit.data.parents) {
      if (uninteresting.commits.has(parent)) state.boundary.add(parent);
    }
  }
};

export const enumerateBundleObjects = async (
  ctx: Context,
  input: EnumerateBundleObjectsInput,
): Promise<BundleObjectClosure> => {
  if (input.wants.length === 0) return { objects: [], boundary: [] };
  const state: BundleEmitState = {
    emitted: new Set<ObjectId>(),
    boundary: new Set<ObjectId>(),
    cap: input.maxObjects ?? MAX_PUSH_OBJECTS,
  };
  const seenTrees = new Set<ObjectId>();
  const uninteresting = await collectUninteresting(ctx, input.haves, seenTrees);
  const seeds: ObjectId[] = [];
  for (const want of input.wants) {
    seeds.push(
      await resolveTagChain(ctx, want, (oid) => {
        tryEmit(state, oid);
      }),
    );
  }
  await walkInteresting(ctx, seeds, uninteresting, state, seenTrees);
  return { objects: [...state.emitted], boundary: [...state.boundary] };
};
