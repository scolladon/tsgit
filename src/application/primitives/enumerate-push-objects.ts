/**
 * push closure walker.
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
 * oid is yielded and the chain is followed (tag → tag →... → commit)
 * before handing the resolved commit oid to `walkCommits`.
 *
 * Gitlink entries in a tree (submodules) are NOT included: the oid
 * names a commit that lives in another repository, which we cannot
 * resolve locally and have no business including in this push's pack.
 */
import type { ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { type EmitState, resolveTagChain, tryEmit } from './internal/object-emit.js';
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
    // Stryker disable next-line ObjectLiteral: equivalent — walkTree defaults `recursive` to `true` when the option is absent, so `{}` behaves identically to `{ recursive: true }`.
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
