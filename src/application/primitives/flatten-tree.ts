/**
 * Flatten a nested `Tree` object into the `FlatTree` shape that the
 * Phase 5 `mergeTrees` domain primitive consumes.
 *
 * Used by Phase 13.4a's clean-merge tree walk in `merge.ts` to drive the
 * three-way merge over `(base, ours, theirs)`. Each call walks one of
 * the three trees and returns a `Map<FilePath, { id, mode }>` keyed by
 * the canonical leaf path (with `/` separators).
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
