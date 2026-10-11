import type { CommitData } from '../../../domain/objects/commit.js';
import { emptyTreeOid, type ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { treeOf } from './history-rewrite.js';

/** git's `is_original_commit_empty`: the tree equals the first parent's (or the empty tree). */
export const isOriginallyEmpty = async (ctx: Context, data: CommitData): Promise<boolean> => {
  const parent: ObjectId | undefined = data.parents[0];
  const parentTree =
    parent !== undefined ? await treeOf(ctx, parent) : emptyTreeOid(ctx.hashConfig);
  return data.tree === parentTree;
};
