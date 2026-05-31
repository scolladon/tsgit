/**
 * Hard-reset the working tree + index to `commitId`'s tree — `reset --hard`
 * semantics with `forceRewriteAll` so dirty / no-op'd paths don't survive the
 * reset. Sparse-aware.
 *
 * Inlined here (rather than delegated to the `reset` command) so it can run
 * while an operation marker (`MERGE_HEAD` / `CHERRY_PICK_HEAD`) is still on disk:
 * `reset`'s own `assertNoPendingOperation` would fire on the very marker the
 * abort/skip is about to clear (ADR-170). Shared by `merge --abort` and
 * `cherry-pick --skip` / `--abort`.
 */
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { materializeTree } from '../../primitives/materialize-tree.js';
import { readIndex } from '../../primitives/read-index.js';
import { readObject } from '../../primitives/read-object.js';
import { loadSparseMatcher } from '../../primitives/read-sparse-checkout.js';
import { acquireIndexLock } from './index-update.js';

export const hardResetWorktreeToCommit = async (
  ctx: Context,
  commitId: ObjectId,
): Promise<void> => {
  const matcher = await loadSparseMatcher(ctx);
  const commit = await readObject(ctx, commitId);
  if (commit.type !== 'commit') throw unexpectedObjectType('commit', commit.type, commitId);
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const result = await materializeTree(ctx, {
      targetTree: commit.data.tree,
      currentIndex,
      force: true,
      forceRewriteAll: true,
      // equivalent-mutant: the sparse-matcher branch is unobservable without a sparse-checkout fixture in the abort/skip tests; the matcher itself is covered by `read-sparse-checkout.test.ts` and the wiring mirrors reset/checkout (which carry their own sparse fixtures, e.g. sparse-reset-merge.test.ts).
      ...(matcher !== undefined ? { sparse: matcher } : {}),
    });
    await lock.commit(result.newIndexEntries);
  } finally {
    await lock.release();
  }
};
