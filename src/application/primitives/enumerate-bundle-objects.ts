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
 *
 * The wants-side walk also folds git's own `pack_name_hash` per object, one
 * entry at a time, as it descends — the same fold `walkTree`'s `pathHasher`
 * performs, done here by hand because this walk already holds
 * `entry.nameBytes` at every step and has no other reason to route through
 * `walkTree`.
 */
import { operationAborted } from '../../domain/error.js';
import { treeDepthExceeded } from '../../domain/objects/error.js';
import { type FileMode, isDirectory, type ObjectId } from '../../domain/objects/index.js';
import { foldPathSegment, PACK_NAME_HASH_V1, type PathHasher } from '../../domain/storage/index.js';
import type { Context } from '../../ports/context.js';
import { type EmitState, resolveTagChain, tryEmit } from './internal/object-emit.js';
import { resolveMaxTreeDepth } from './internal/resolve-max-tree-depth.js';
import { readObject } from './read-object.js';
import { MAX_PUSH_OBJECTS } from './types.js';
import { isGitlink } from './validators.js';
import { walkCommits } from './walk-commits.js';

/** Taken through the seam rather than the concrete fold, so adopting a
 *  second hash version stays the one-module port it is meant to be. */
const HASHER: PathHasher = PACK_NAME_HASH_V1;

export interface EnumerateBundleObjectsInput {
  /** Positive endpoint oids — commits or annotated tags. */
  readonly wants: ReadonlyArray<ObjectId>;
  /** Excluded commit oids — explicit excludes or computed merge-bases. */
  readonly haves: ReadonlyArray<ObjectId>;
  /** Hard cap on total emitted objects. Defaults to MAX_PUSH_OBJECTS. */
  readonly maxObjects?: number;
}

/** An object id paired with git's `pack_name_hash` of its own path — `0`
 *  for a tag or a commit, neither of which has a path. */
export interface BundleObjectEntry {
  readonly id: ObjectId;
  readonly nameHash: number;
}

export interface BundleObjectClosure {
  /**
   * Deduped object set for pack building: tags + commits + trees + blobs,
   * each paired with git's `pack_name_hash` of its own path. A tag or a
   * commit — neither has a path — carries `0`.
   */
  readonly objects: ReadonlyArray<BundleObjectEntry>;
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

// Bundle-local extension: adds boundary tracking for prerequisite commit
// detection and the hash-carrying accumulator `enumerateBundleObjects`
// returns. `emitted` (from `EmitState`) stays the dedup set `tryEmit` reads;
// a `Set` cannot also carry a hash per member, so the emitted pack inputs
// live in their own array, pushed to only alongside a successful `tryEmit`.
interface BundleEmitState extends EmitState {
  readonly boundary: Set<ObjectId>;
  readonly packInputs: Array<BundleObjectEntry>;
}

/** The wants-side tree walk's collaborators that stay fixed across every
 *  call — one bound per `walkInteresting` invocation, mirroring
 *  `walk-tree.ts`'s `WalkConfig`. Only `treeId`, `hashState` and `depth`
 *  vary per `emitTreeObjects` call. */
interface BundleWalkConfig {
  readonly ctx: Context;
  /** Read-only here: the haves phase already filled it, and this walk only
   *  tests membership — unlike `state` and `seenTrees`, which it mutates. */
  readonly uninteresting: ReadonlySet<ObjectId>;
  readonly state: BundleEmitState;
  readonly seenTrees: Set<ObjectId>;
  readonly maxDepth: number;
}

/** Folds `nameBytes` onto `hashState` — git's empty-prefix rule (the root
 *  tree's own entries hash their bare name, never a leading `/`) then the
 *  entry's own bytes. `depth === 0` identifies the root call — the only one
 *  whose `treeId` is a commit's own tree, never a subtree reached by
 *  recursion. */
function foldEntryHash(hashState: number, nameBytes: Uint8Array, depth: number): number {
  return foldPathSegment(HASHER, hashState, nameBytes, depth === 0);
}

/** `tryEmit` guards the cap and the dedup set; a successful emit also
 *  records the id's hash in traversal order, since a `Set` alone cannot. */
function emitWithHash(state: BundleEmitState, id: ObjectId, nameHash: number): void {
  if (tryEmit(state, id)) state.packInputs.push({ id, nameHash });
}

// Walk a tree recursively, collecting all non-gitlink object ids into
// `objects`. Subtrees already in `seenTrees` are skipped — their objects are
// already collected, so descending again would be redundant.
//
// No per-walk flat-entry cap is applied here: this is a prepass over LOCAL
// repo objects on the create path, and the PACK_TOO_LARGE guard in tryEmit
// already bounds the total number of emitted (interesting) objects.
//
// This descent was measured honouring `core.maxTreeDepth` to at least
// 100000 (2026-08-15): a fixture one level past a cap of 100000 refuses cleanly
// with `TREE_DEPTH_EXCEEDED` at depth 100001. Deeper than that is
// unmeasured — no raw stack overflow was observed at any depth tried.
const collectTreeObjects = async (
  ctx: Context,
  treeId: ObjectId,
  objects: Set<ObjectId>,
  seenTrees: Set<ObjectId>,
  maxDepth: number,
  depth = 0,
): Promise<void> => {
  if (seenTrees.has(treeId)) return;
  seenTrees.add(treeId);
  if (depth > maxDepth) throw treeDepthExceeded(depth);
  // Stryker disable next-line ConditionalExpression: equivalent — resolveObject calls checkAborted at the start of every read, so the unconditional readObject two lines below throws the identical OPERATION_ABORTED
  if (ctx.signal?.aborted) throw operationAborted();
  objects.add(treeId);
  const treeObj = await readObject(ctx, treeId);
  if (treeObj.type !== 'tree') return;
  for (const entry of treeObj.entries) {
    // Stryker disable next-line ConditionalExpression: equivalent — disabling the guard sends a gitlink to the next branch where isDirectory('160000') is false, so its oid joins the uninteresting set but is never emitted (the wants-side isGitlink guard skips it); the object closure is unchanged
    if (isGitlink(entry.mode)) continue;
    // equivalent-mutant: BlockStatement→{} / ConditionalExpression→false — recursive collectTreeObjects calls objects.add(treeId) at the top for any id, including non-tree ones; final uninteresting set is the same
    if (!isDirectory(entry.mode as FileMode)) {
      objects.add(entry.id);
      continue;
    }
    await collectTreeObjects(ctx, entry.id, objects, seenTrees, maxDepth, depth + 1);
  }
};

// Walk a tree recursively, emitting non-gitlink objects absent from
// `uninteresting`. Subtrees already in `seenTrees` are skipped — either all
// their objects are already in `uninteresting` (nothing to emit) or they were
// already emitted during an earlier commit's walk.
//
// This descent was measured honouring `core.maxTreeDepth` to at least
// 100000 (2026-08-15): a fixture one level past a cap of 100000 refuses cleanly
// with `TREE_DEPTH_EXCEEDED` at depth 100001. Deeper than that is
// unmeasured — no raw stack overflow was observed at any depth tried.
const emitTreeObjects = async (
  config: BundleWalkConfig,
  treeId: ObjectId,
  hashState: number,
  depth = 0,
): Promise<void> => {
  if (config.seenTrees.has(treeId)) return;
  config.seenTrees.add(treeId);
  if (depth > config.maxDepth) throw treeDepthExceeded(depth);
  // Stryker disable next-line ConditionalExpression: equivalent — resolveObject calls checkAborted at the start of every read, so the unconditional readObject two lines below throws the identical OPERATION_ABORTED
  if (config.ctx.signal?.aborted) throw operationAborted();
  // Stryker disable next-line ConditionalExpression: equivalent — every uninteresting tree was collected into seenTrees during the haves phase, so the seenTrees guard at the top returns first; !config.uninteresting.has(treeId) is always true when this line is reached
  if (!config.uninteresting.has(treeId)) emitWithHash(config.state, treeId, hashState);
  const treeObj = await readObject(config.ctx, treeId);
  if (treeObj.type !== 'tree') return;
  for (const entry of treeObj.entries) {
    if (isGitlink(entry.mode)) continue;
    const entryHash = foldEntryHash(hashState, entry.nameBytes, depth);
    // equivalent-mutant: ConditionalExpression→true — all entries recurse into emitTreeObjects; blobs are emitted via the emitWithHash call at the top of the recursive invocation, with the SAME entryHash the blob branch below would have used, before the type-check return; final emitted set AND every nameHash are identical
    if (isDirectory(entry.mode as FileMode)) {
      await emitTreeObjects(config, entry.id, entryHash, depth + 1);
      continue;
    }
    if (!config.uninteresting.has(entry.id)) emitWithHash(config.state, entry.id, entryHash);
  }
};

const collectUninteresting = async (
  ctx: Context,
  haves: ReadonlyArray<ObjectId>,
  seenTrees: Set<ObjectId>,
  maxDepth: number,
): Promise<UninterestingClosure> => {
  const commits = new Set<ObjectId>();
  const objects = new Set<ObjectId>();
  if (haves.length === 0) return { commits, objects };
  for await (const commit of walkCommits(ctx, { from: haves, ignoreMissing: true })) {
    commits.add(commit.id);
    objects.add(commit.id);
    await collectTreeObjects(ctx, commit.data.tree, objects, seenTrees, maxDepth);
  }
  return { commits, objects };
};

const walkInteresting = async (
  ctx: Context,
  seeds: ReadonlyArray<ObjectId>,
  uninteresting: UninterestingClosure,
  state: BundleEmitState,
  seenTrees: Set<ObjectId>,
  maxDepth: number,
): Promise<void> => {
  const walkConfig: BundleWalkConfig = {
    ctx,
    uninteresting: uninteresting.objects,
    state,
    seenTrees,
    maxDepth,
  };
  for await (const commit of walkCommits(ctx, {
    from: seeds,
    until: [...uninteresting.commits],
    ignoreMissing: true,
  })) {
    // A commit has no path of its own — git's `pack_name_hash` sees none
    // and returns 0; its own tree is the one object here that starts the
    // fold fresh, from the seed.
    emitWithHash(state, commit.id, 0);
    await emitTreeObjects(walkConfig, commit.data.tree, HASHER.seed);
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
  const maxDepth = await resolveMaxTreeDepth(ctx);
  const state: BundleEmitState = {
    emitted: new Set<ObjectId>(),
    boundary: new Set<ObjectId>(),
    cap: input.maxObjects ?? MAX_PUSH_OBJECTS,
    packInputs: [],
  };
  const seenTrees = new Set<ObjectId>();
  const uninteresting = await collectUninteresting(ctx, input.haves, seenTrees, maxDepth);
  const seeds: ObjectId[] = [];
  for (const want of input.wants) {
    seeds.push(
      // A tag has no path of its own either — same 0 a commit carries.
      await resolveTagChain(ctx, want, (oid) => {
        emitWithHash(state, oid, 0);
      }),
    );
  }
  await walkInteresting(ctx, seeds, uninteresting, state, seenTrees, maxDepth);
  return { objects: state.packInputs, boundary: [...state.boundary] };
};
