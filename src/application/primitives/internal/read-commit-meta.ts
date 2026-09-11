/**
 * Shared commit-metadata reader for history-walk primitives that need only
 * parents, committer date and generation — git's `parse_commit_in_graph`
 * role. Graph first (`commitHeader`, no object read); `readObject` +
 * `applyGraft` fallback otherwise.
 */
import { applyGraft } from '../../../domain/commit/graft.js';
import type { Commit } from '../../../domain/objects/commit.js';
import type { ObjectId } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { readObject } from '../read-object.js';
import { type CommitHeader, commitHeader } from './read-commit-graph.js';
import { loadShallowSet } from './shallow-set.js';

/** git's `GENERATION_NUMBER_INFINITY` role: a commit the graph does not
 *  serve (or serves with a stored generation of 0) sorts as infinitely
 *  young. */
export const GENERATION_INFINITY = Number.POSITIVE_INFINITY;

export interface CommitMeta {
  readonly parents: ReadonlyArray<ObjectId>;
  /** The commit's own root tree: the graph's stored `rootTree` on a hit, the
   *  commit object's own `tree` header on the fallback. */
  readonly tree: ObjectId;
  readonly committerDate: number;
  /** Graph generation — topo level or corrected commit date — or
   *  GENERATION_INFINITY when no graph serves this commit (or serves it with 0). */
  readonly generation: number;
}

const fromHeader = (header: CommitHeader): CommitMeta => ({
  parents: header.parents,
  tree: header.rootTree,
  committerDate: header.committerDate,
  generation: header.generation > 0 ? header.generation : GENERATION_INFINITY,
});

/** Graph first; `readObject` + `applyGraft` fallback. `undefined` for a non-commit
 *  object; OBJECT_NOT_FOUND propagates. A graph hit for a missing body does not
 *  throw — git's `repo_parse_commit` succeeds from the graph too. */
export const readCommitMeta = async (
  ctx: Context,
  id: ObjectId,
): Promise<CommitMeta | undefined> => {
  const header = await commitHeader(ctx, id);
  if (header !== undefined) return fromHeader(header);
  const object = await readObject(ctx, id);
  if (object.type !== 'commit') return undefined;
  const grafted = applyGraft(object, await loadShallowSet(ctx));
  return {
    parents: grafted.data.parents,
    tree: grafted.data.tree,
    committerDate: grafted.data.committer.timestamp,
    generation: GENERATION_INFINITY,
  };
};

/** For a `Commit` already in hand (a peeled ref tip): the graph supplies only
 *  the generation, with no object read. */
export const commitMetaOf = async (ctx: Context, commit: Commit): Promise<CommitMeta> => {
  const header = await commitHeader(ctx, commit.id);
  const grafted = applyGraft(commit, await loadShallowSet(ctx));
  return {
    parents: grafted.data.parents,
    tree: commit.data.tree,
    committerDate: commit.data.committer.timestamp,
    generation: header === undefined ? GENERATION_INFINITY : fromHeader(header).generation,
  };
};
