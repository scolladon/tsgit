/**
 * Phase 12.3 — push closure walker.
 *
 * Enumerates every object the remote does NOT have so the caller can
 * stream them into `buildPack`. Walks commits from `wants` with `haves`
 * as the boundary (canonical `until` semantics — the haves themselves
 * are never yielded), then walks each commit's tree for the trees and
 * blobs they reference. Duplicates are removed across the whole stream
 * via a single `Set<ObjectId>`.
 *
 * Annotated tags pushed via a refspec must appear in the stream too —
 * `readObject` is called on each want; if the result is a Tag, the tag
 * oid is yielded and the chain is followed (tag → tag → ... → commit)
 * before handing the resolved commit oid to `walkCommits`.
 *
 * Gitlink entries in a tree (submodules) are NOT included: the oid
 * names a commit that lives in another repository, which we cannot
 * resolve locally and have no business including in this push's pack.
 */
import { TsgitError } from '../../domain/error.js';
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { readObject } from './read-object.js';
import { MAX_PUSH_OBJECTS } from './types.js';
import { isGitlink } from './validators.js';
import { walkCommits } from './walk-commits.js';
import { walkTree } from './walk-tree.js';

export interface EnumeratePushObjectsInput {
  /**
   * Object ids the caller wants on the remote. Each MUST resolve to a
   * commit or an annotated tag (tags are unwrapped to commits before the
   * commit walk).
   */
  readonly wants: ReadonlyArray<ObjectId>;
  /** Object ids the remote already has (server's advertised ref tips). */
  readonly haves: ReadonlyArray<ObjectId>;
  /** Hard cap on objects emitted. Defaults to MAX_PUSH_OBJECTS. */
  readonly maxObjects?: number;
}

interface EmitState {
  readonly emitted: Set<ObjectId>;
  readonly cap: number;
}

const tryEmit = (state: EmitState, id: ObjectId): boolean => {
  if (state.emitted.has(id)) return false;
  state.emitted.add(id);
  if (state.emitted.size > state.cap) {
    throw new TsgitError({
      code: 'PACK_TOO_LARGE',
      objectCount: state.emitted.size,
      limit: state.cap,
    });
  }
  return true;
};

const collectCommitSeeds = async (
  ctx: Context,
  state: EmitState,
  wants: ReadonlyArray<ObjectId>,
): Promise<ObjectId[]> => {
  const seeds: ObjectId[] = [];
  for (const want of wants) {
    const seed = await resolveTagChain(ctx, want, (oid) => {
      tryEmit(state, oid);
    });
    seeds.push(seed);
  }
  return seeds;
};

async function* walkCommitClosure(
  ctx: Context,
  state: EmitState,
  seeds: ReadonlyArray<ObjectId>,
  haves: ReadonlyArray<ObjectId>,
): AsyncIterable<ObjectId> {
  for await (const commit of walkCommits(ctx, {
    from: seeds,
    until: haves,
    ignoreMissing: true,
  })) {
    if (tryEmit(state, commit.id)) yield commit.id;
    if (tryEmit(state, commit.data.tree)) yield commit.data.tree;
    for await (const entry of walkTree(ctx, commit.data.tree, { recursive: true })) {
      if (isGitlink(entry.mode)) continue;
      if (tryEmit(state, entry.id)) yield entry.id;
    }
  }
}

export async function* enumeratePushObjects(
  ctx: Context,
  input: EnumeratePushObjectsInput,
): AsyncIterable<ObjectId> {
  const state: EmitState = {
    emitted: new Set<ObjectId>(),
    cap: input.maxObjects ?? MAX_PUSH_OBJECTS,
  };

  const commitSeeds = await collectCommitSeeds(ctx, state, input.wants);
  // Tag oids recorded during unwrap are yielded before the commit walk.
  for (const id of state.emitted) yield id;

  yield* walkCommitClosure(ctx, state, commitSeeds, input.haves);
}

/**
 * Follow a tag chain (annotated tag → annotated tag → ... → commit)
 * yielding each tag oid through `recordTag`. Returns the terminal
 * commit oid for the caller to use as a commit-walk seed. Non-tag
 * oids pass through untouched.
 */
const resolveTagChain = async (
  ctx: Context,
  id: ObjectId,
  recordTag: (id: ObjectId) => void,
): Promise<ObjectId> => {
  let current = id;
  // A pathological tag-of-tag chain would be rare but a malicious server
  // could in principle advertise one; cap the unwrap at the same depth
  // we already use for symbolic ref resolution to avoid an infinite loop
  // if a tag points back at itself (corrupt object).
  for (let i = 0; i < 16; i += 1) {
    const obj = await readObject(ctx, current);
    if (obj.type !== 'tag') return current;
    recordTag(current);
    current = obj.data.object;
  }
  return current;
};
