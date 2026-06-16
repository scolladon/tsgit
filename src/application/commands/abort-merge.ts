import { noOperationInProgress } from '../../domain/commands/error.js';
import { unsupportedOperation } from '../../domain/index.js';
import type { ObjectId, RefName } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { updateRef } from '../primitives/update-ref.js';
import { clearMergeState, readMergeHead, readOrigHead } from './internal/merge-state.js';
import { assertNotBare, assertRepository, readHeadRaw } from './internal/repo-state.js';
import { hardResetWorktreeToCommit } from './internal/reset-worktree.js';
import { assertNoValuelessCoreConfig } from './internal/valueless-config-guard.js';

export interface MergeAbortResult {
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
export const mergeAbort = async (ctx: Context): Promise<MergeAbortResult> => {
  await assertRepository(ctx);
  await assertNoValuelessCoreConfig(ctx);
  await assertNotBare(ctx, 'merge --abort');
  const mergeHead = await readMergeHead(ctx);
  // Load-bearing under the ADR-027 write order: `merge`'s conflict path
  // writes `ORIG_HEAD` *before* `MERGE_HEAD`. A crash between the two leaves
  // `ORIG_HEAD` on disk with `MERGE_HEAD` absent — without this guard,
  // `mergeAbort` would silently hard-reset to `ORIG_HEAD` instead of
  // surfacing the inconsistent state to the caller.
  if (mergeHead === undefined) throw noOperationInProgress('merge');
  const origHead = await readOrigHead(ctx);
  if (origHead === undefined) throw noOperationInProgress('merge');
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation('merge --abort', 'cannot abort with detached HEAD');
  }
  await hardResetWorktreeToCommit(ctx, origHead);
  // git's `merge --abort` delegates to a `reset` whose rev argument is the
  // symbolic `HEAD`, so the coupled-HEAD reflog reads `reset: moving to HEAD`
  // (the literal `HEAD`, not the oid). The branch entry is skipped upstream: a
  // conflicted merge never moved HEAD, so `origHead` equals the current tip.
  await updateRef(ctx, head.target, origHead, { reflogMessage: 'reset: moving to HEAD' });
  await clearMergeState(ctx);
  return { origHead, branch: head.target };
};
