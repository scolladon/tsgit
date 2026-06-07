import type { TreeDiff } from '../../../domain/diff/index.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { diffTrees } from '../../primitives/diff-trees.js';
import { treeOf } from './history-rewrite.js';

/**
 * The changes a commit introduced against its (first) parent — the diff
 * `show` and `whatchanged` attach to a single-parent commit. A root commit
 * (`parent === undefined`) diffs against the empty tree. Recursive, with rename
 * detection on (git's `diff.renames` default; matches `git show` / `git log
 * --raw`). Pass `withStat` to attach per-file line counts (a `StatTreeDiff`).
 */
export const diffCommitAgainstParent = async (
  ctx: Context,
  parent: ObjectId | undefined,
  tree: ObjectId,
  withStat = false,
): Promise<TreeDiff> => {
  const oldTree = parent !== undefined ? await treeOf(ctx, parent) : undefined;
  return diffTrees(ctx, oldTree, tree, {
    recursive: true,
    detectRenames: true,
    ...(withStat ? { withStat: true } : {}),
  });
};
