import { noOperationInProgress } from '../../domain/commands/error.js';
import { unsupportedOperation } from '../../domain/index.js';
import { unexpectedObjectType } from '../../domain/objects/error.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { materializeTree } from '../primitives/materialize-tree.js';
import { readIndex } from '../primitives/read-index.js';
import { readObject } from '../primitives/read-object.js';
import { loadSparseMatcher } from '../primitives/read-sparse-checkout.js';
import { updateRef } from '../primitives/update-ref.js';
import { acquireIndexLock } from './internal/index-update.js';
import { clearMergeState, readMergeHead, readOrigHead } from './internal/merge-state.js';
import { assertNotBare, assertRepository, readHeadRaw } from './internal/repo-state.js';

export interface AbortMergeResult {
  /** The commit `ORIG_HEAD` recorded; HEAD now points at this id. */
  readonly origHead: ObjectId;
  /** The branch HEAD is on (always defined — detached merges are rejected upstream). */
  readonly branch: RefName;
}

/**
 * Abort a conflicting merge. Restores the working tree, index, and branch
 * ref to `ORIG_HEAD`, then clears `MERGE_HEAD` and `MERGE_MSG`. `ORIG_HEAD`
 * is preserved on disk as a cross-operation recovery aid (ADR-173).
 *
 * Refuses when no merge is in progress (`MERGE_HEAD` absent) or when the
 * merge state is incomplete (`ORIG_HEAD` absent — corrupt half-state).
 *
 * The hard-reset machinery is inlined rather than delegated to `reset` so
 * the call can bypass `assertNoPendingOperation` (which would itself
 * fire on the very `MERGE_HEAD` we're about to clear). See ADR-170.
 */
export const abortMerge = async (ctx: Context): Promise<AbortMergeResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'merge --abort');
  const mergeHead = await readMergeHead(ctx);
  if (mergeHead === undefined) throw noOperationInProgress('merge');
  const origHead = await readOrigHead(ctx);
  if (origHead === undefined) throw noOperationInProgress('merge');
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('merge --abort', 'cannot abort with detached HEAD');
  }
  await resetToOrigHead(ctx, origHead);
  await updateRef(ctx, head.target, origHead, { reflogMessage: 'merge: aborted' });
  await clearMergeState(ctx);
  return { origHead, branch: head.target };
};

/**
 * Hard-reset the working tree and index to `origHead`'s tree. Mirrors
 * `reset --hard` semantics: every working-tree file is rewritten
 * (`forceRewriteAll: true`) so dirty noop'd paths don't survive the
 * abort.
 */
const resetToOrigHead = async (ctx: Context, origHead: ObjectId): Promise<void> => {
  const matcher = await loadSparseMatcher(ctx);
  const commit = await readObject(ctx, origHead);
  if (commit.type !== 'commit') {
    throw unexpectedObjectType('commit', commit.type, origHead);
  }
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const result = await materializeTree(ctx, {
      targetTree: commit.data.tree,
      currentIndex,
      force: true,
      forceRewriteAll: true,
      ...(matcher !== undefined ? { sparse: matcher } : {}),
    });
    await lock.commit(result.newIndexEntries);
  } finally {
    await lock.release();
  }
};
