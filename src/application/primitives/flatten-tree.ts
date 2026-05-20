/**
 * Flatten a nested `Tree` object into the `FlatTree` shape that the
 * `mergeTrees` domain primitive consumes.
 *
 * @internal Currently consumed only by `merge.ts`'s clean-merge tree
 * walk. Not exported from the primitives barrel — the function exists
 * to bridge `walkTree`'s iterator into the `FlatTree` Map that
 * `mergeTrees` expects, and the merge command is the only user with
 * that need today. Promote to the public surface if a second caller
 * appears.
 *
 * Pure with respect to the working tree — only reads git objects via
 * `walkTree`.
 */
import type { FlatTree, FlatTreeEntry } from '../../domain/diff/flat-tree.js';
import { FILE_MODE, type FilePath, type ObjectId } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { walkTree } from './walk-tree.js';

export const flattenTree = async (ctx: Context, treeId: ObjectId): Promise<FlatTree> => {
  const entries = new Map<FilePath, FlatTreeEntry>();
  for await (const entry of walkTree(ctx, treeId)) {
    if (entry.mode === FILE_MODE.DIRECTORY) continue;
    entries.set(entry.path, { id: entry.id, mode: entry.mode });
  }
  return { entries };
};
