/**
 * git's `repo_in_merge_bases(a, b)` narrowed to the question every caller
 * actually asks: is `ancestor` reachable from `descendant`. The walk yields
 * `descendant` itself first, so an oid compared against itself answers true
 * without a separate fast path.
 */

import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { walkCommits } from '../../primitives/walk-commits.js';

export const isAncestor = async (
  ctx: Context,
  ancestor: ObjectId,
  descendant: ObjectId,
): Promise<boolean> => {
  for await (const commit of walkCommits(ctx, { from: [descendant], ignoreMissing: true })) {
    if (commit.id === ancestor) return true;
  }
  return false;
};
