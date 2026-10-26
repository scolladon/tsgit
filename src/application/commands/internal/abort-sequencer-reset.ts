/**
 * The shared `cherry-pick` / `revert` `--skip` and `--abort` tails. git ends a
 * stopped pick with `reset --merge <oid>`: ORIG_HEAD takes the HEAD it leaves
 * (written only once the reset succeeded, a refusal changes nothing),
 * the working tree + index (+ branch, on abort) move to the target with git's
 * `reset: moving to <oid>` reflog, and `remove_branch_state` clears the stop.
 * An abort then tears the sequencer down.
 *
 * `rebase --abort` faithfully diverges — it reattaches a detached HEAD with a
 * `rebase (abort): returning to <name>` reflog and never moves the branch ref or
 * touches `.git/sequencer/` — so it does **not** route through this helper.
 */
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { resetMovingTo } from '../../../domain/reflog/reflog-messages.js';
import type { Context } from '../../../ports/context.js';
import { resolveRef } from '../../primitives/resolve-ref.js';
import { updateRef } from '../../primitives/update-ref.js';
import { removeBranchState } from './branch-state.js';
import { writeOrigHead } from './merge-state.js';
import { mergeResetWorktreeToCommit } from './reset-worktree.js';
import { clearSequencer } from './sequencer-state.js';

export interface AbortSequencerResetOptions {
  readonly target: ObjectId;
}

const HEAD: RefName = 'HEAD' as RefName;

/** `--skip`'s `reset --merge HEAD`: drop the stopped pick, HEAD stays put. */
export const skipSequencerReset = async (ctx: Context, head: ObjectId): Promise<void> => {
  await mergeResetWorktreeToCommit(ctx, head);
  await writeOrigHead(ctx, head);
  await removeBranchState(ctx, 'silent');
};

export const abortSequencerReset = async (
  ctx: Context,
  options: AbortSequencerResetOptions,
): Promise<void> => {
  const left = await resolveRef(ctx, HEAD);
  await mergeResetWorktreeToCommit(ctx, options.target);
  await writeOrigHead(ctx, left);
  await updateRef(ctx, HEAD, options.target, {
    reflogMessage: resetMovingTo(options.target),
  });
  await removeBranchState(ctx, 'silent');
  await clearSequencer(ctx);
};
