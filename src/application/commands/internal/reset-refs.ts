import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { resetMovingTo } from '../../../domain/reflog/reflog-messages.js';
import type { Context } from '../../../ports/context.js';
import { resolveRefOrMissing } from '../../primitives/resolve-ref.js';
import { updateRef } from '../../primitives/update-ref.js';
import { removeBranchState } from './branch-state.js';
import { clearOrigHead, writeOrigHead } from './merge-state.js';

/** git's `reset_refs`: ORIG_HEAD takes the commit HEAD leaves; an unborn HEAD drops it. */
const recordOrigHead = async (ctx: Context): Promise<void> => {
  const left = await resolveRefOrMissing(ctx, 'HEAD');
  if (left !== undefined) return writeOrigHead(ctx, left);
  await clearOrigHead(ctx);
};

/**
 * The ref tail every `reset` (and stash push's child reset) runs: ORIG_HEAD, then HEAD moved
 * through the literal `HEAD` — `updateRef` dereferences a symbolic HEAD to its branch and logs the
 * coupled split, a detached HEAD is written directly, and either way a no-move skips the reflog,
 * as git's needs-commit semantics do — then the in-progress branch state is dropped.
 */
export const recordResetRefs = async (ctx: Context, id: ObjectId, rev: string): Promise<void> => {
  await recordOrigHead(ctx);
  await updateRef(ctx, 'HEAD' as RefName, id, { reflogMessage: resetMovingTo(rev) });
  await removeBranchState(ctx, 'silent');
};
