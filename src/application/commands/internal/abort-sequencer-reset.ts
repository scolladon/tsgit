/**
 * The shared `cherry-pick` / `revert` `--abort` tail (ADR-232): hard-reset the
 * working tree + index + branch to the recovery `target`, record git's faithful
 * `reset: moving to <oid>` reflog, clear the op-specific `*_HEAD` marker, then
 * tear down `MERGE_MSG` and the sequencer. Extracted once the history-rewrite
 * `*-abort` family reached three members.
 *
 * `rebase --abort` faithfully diverges — it reattaches a detached HEAD with a
 * `rebase (abort): returning to <name>` reflog and never moves the branch ref or
 * touches `.git/sequencer/` — so it does **not** route through this helper.
 */
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { updateRef } from '../../primitives/update-ref.js';
import { clearMergeMsg } from './merge-state.js';
import { hardResetWorktreeToCommit } from './reset-worktree.js';
import { clearSequencer } from './sequencer-state.js';

export interface AbortSequencerResetOptions {
  readonly branch: RefName;
  readonly target: ObjectId;
  /** Remove the op-specific marker (`clearCherryPickHead` / `clearRevertHead`). */
  readonly clearHead: (ctx: Context) => Promise<void>;
}

export const abortSequencerReset = async (
  ctx: Context,
  options: AbortSequencerResetOptions,
): Promise<void> => {
  await hardResetWorktreeToCommit(ctx, options.target);
  await updateRef(ctx, options.branch, options.target, {
    reflogMessage: `reset: moving to ${options.target}`,
  });
  await options.clearHead(ctx);
  await clearMergeMsg(ctx);
  await clearSequencer(ctx);
};
