/**
 * Materialise a freshly-cloned (or otherwise populated) gitdir's `HEAD` tree
 * into its working tree, writing the matching index. The clone→worktree half of
 * the submodule substrate (ADR-289): tsgit's `clone` propagates refs + objects
 * but never checks out a working tree, so the submodule verbs run this straight
 * after a child-context clone.
 *
 * Reads `HEAD` (peeling commit → tree via `readTree`), diffs it against the
 * current module index, applies the changeset to the working tree, and commits
 * the resulting index under its own lock. It updates **no** ref and writes **no**
 * reflog entry — git's clone checkout is silent beyond the `clone: from` line the
 * clone itself records.
 */
import type { RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { acquireIndexLock } from './internal/index-lock.js';
import { type MaterializeTreeResult, materializeTree } from './materialize-tree.js';
import { readIndex } from './read-index.js';
import { readTree } from './read-tree.js';

export const materializeWorktreeFromHead = async (ctx: Context): Promise<MaterializeTreeResult> => {
  const target = await readTree(ctx, 'HEAD' as RefName);
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const result = await materializeTree(ctx, { targetTree: target.id, currentIndex });
    await lock.commit(result.newIndexEntries);
    return result;
  } finally {
    await lock.release();
  }
};
