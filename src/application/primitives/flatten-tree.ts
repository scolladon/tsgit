/**
 * Flatten a nested `Tree` into the `FlatTree` shape that the `mergeTrees`
 * domain primitive (and the recursive tree-diff) consume.
 *
 * Bridges `walkTree`'s iterator into the `FlatTree` Map of
 * `path → { id, mode }`. Accepts either an oid or an already-resolved `Tree`
 * object (the recursive diff passes the latter to avoid a redundant root read);
 * `walkTree` resolves both. Consumed by `merge.ts`'s clean-merge tree walk,
 * `rm`'s HEAD-vs-index staged-change check, and the `diffTrees` recursive path,
 * so it is exported from the primitives barrel.
 *
 * Pure with respect to the working tree — only reads git objects via
 * `walkTree`.
 */
import type { FlatTree, FlatTreeEntry } from '../../domain/diff/flat-tree.js';
import { FILE_MODE, type FilePath, type ObjectId, type Tree } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { walkTree } from './walk-tree.js';

export const flattenTree = async (
  ctx: Context,
  treeIdOrObject: ObjectId | Tree,
): Promise<FlatTree> => {
  const entries = new Map<FilePath, FlatTreeEntry>();
  for await (const entry of walkTree(ctx, treeIdOrObject)) {
    if (entry.mode === FILE_MODE.DIRECTORY) continue;
    entries.set(entry.path, { id: entry.id, mode: entry.mode });
  }
  return { entries };
};
