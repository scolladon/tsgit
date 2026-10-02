import type { ObjectId } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import { commitHeader, graphCommitIds } from '../../../primitives/internal/read-commit-graph.js';

/** A commit as git's `parse_commit_in_graph` fills it: tree and parents, never its bytes. */
export interface GraphCommit {
  readonly type: 'commit';
  readonly tree: ObjectId;
  readonly parents: ReadonlyArray<ObjectId>;
}

/** Every commit the commit-graph holds, as the graph describes it. */
export const readGraphCommits = async (
  ctx: Context,
): Promise<ReadonlyMap<ObjectId, GraphCommit>> => {
  const held = new Map<ObjectId, GraphCommit>();
  for (const id of await graphCommitIds(ctx)) {
    const header = await commitHeader(ctx, id);
    if (header === undefined) continue;
    held.set(id, { type: 'commit', tree: header.rootTree, parents: header.parents });
  }
  return held;
};
