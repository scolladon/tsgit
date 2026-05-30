/**
 * Flatten a nested `Tree` object into the `FlatTree` shape that the
 * `mergeTrees` domain primitive consumes.
 *
 * Bridges `walkTree`'s iterator into the `FlatTree` Map of
 * `path → { id, mode }`. Consumed by `merge.ts`'s clean-merge tree walk
 * and by `rm`'s HEAD-vs-index staged-change check (the safety valve), so
 * it is exported from the primitives barrel.
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
