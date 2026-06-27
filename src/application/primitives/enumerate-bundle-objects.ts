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
 */
import { TsgitError } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';
import { MAX_PUSH_OBJECTS } from './types.js';
import { isGitlink } from './validators.js';
import { walkCommits } from './walk-commits.js';
import { walkTree } from './walk-tree.js';

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

interface EmitState {
  readonly emitted: Set<ObjectId>;
  readonly boundary: Set<ObjectId>;
  readonly cap: number;
}

const tryEmit = (state: EmitState, id: ObjectId): void => {
  if (state.emitted.has(id)) return;
  if (state.emitted.size >= state.cap) {
    throw new TsgitError({
      code: 'PACK_TOO_LARGE',
      objectCount: state.emitted.size + 1,
      limit: state.cap,
    });
  }
  state.emitted.add(id);
};

const collectUninteresting = async (
  ctx: Context,
  haves: ReadonlyArray<ObjectId>,
): Promise<UninterestingClosure> => {
  const commits = new Set<ObjectId>();
  const objects = new Set<ObjectId>();
  if (haves.length === 0) return { commits, objects };
  for await (const commit of walkCommits(ctx, { from: haves, ignoreMissing: true })) {
    commits.add(commit.id);
    objects.add(commit.id);
    objects.add(commit.data.tree);
    for await (const entry of walkTree(ctx, commit.data.tree, { recursive: true })) {
      if (!isGitlink(entry.mode)) objects.add(entry.id);
    }
  }
  return { commits, objects };
};

const resolveTagChain = async (ctx: Context, id: ObjectId, state: EmitState): Promise<ObjectId> => {
  let current = id;
  for (let depth = 0; depth < 16; depth += 1) {
    const obj = await readObject(ctx, current);
    if (obj.type !== 'tag') return current;
    tryEmit(state, current);
    current = obj.data.object;
  }
  return current;
};

const walkInteresting = async (
  ctx: Context,
  seeds: ReadonlyArray<ObjectId>,
  uninteresting: UninterestingClosure,
  state: EmitState,
): Promise<void> => {
  for await (const commit of walkCommits(ctx, {
    from: seeds,
    until: [...uninteresting.commits],
    ignoreMissing: true,
  })) {
    tryEmit(state, commit.id);
    if (!uninteresting.objects.has(commit.data.tree)) tryEmit(state, commit.data.tree);
    for await (const entry of walkTree(ctx, commit.data.tree, { recursive: true })) {
      if (isGitlink(entry.mode) || uninteresting.objects.has(entry.id)) continue;
      tryEmit(state, entry.id);
    }
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
  const state: EmitState = {
    emitted: new Set<ObjectId>(),
    boundary: new Set<ObjectId>(),
    cap: input.maxObjects ?? MAX_PUSH_OBJECTS,
  };
  const uninteresting = await collectUninteresting(ctx, input.haves);
  const seeds: ObjectId[] = [];
  for (const want of input.wants) {
    seeds.push(await resolveTagChain(ctx, want, state));
  }
  await walkInteresting(ctx, seeds, uninteresting, state);
  return { objects: [...state.emitted], boundary: [...state.boundary] };
};
