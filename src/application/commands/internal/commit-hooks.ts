import type { Context } from '../../../ports/context.js';
import { runHook } from '../../primitives/run-hook.js';
import { sanitizeMessage } from './commit-message.js';

/** Fire the `pre-commit` hook unless verification is disabled (`--no-verify`). */
export const runPreCommitHook = async (ctx: Context, noVerify: boolean): Promise<void> => {
  if (noVerify) return;
  await runHook(ctx, 'pre-commit');
};

/** git's `prepare-commit-msg` message source (the hook's 2nd argument). tsgit
 *  only ever produces `message` (a supplied message) or `merge` (a merge /
 *  cherry-pick / revert resolution, where `MERGE_MSG` exists). */
export type PrepareCommitMsgSource = 'message' | 'merge';

interface CommitMessageHookOptions {
  readonly noVerify: boolean;
  readonly allowEmptyMessage: boolean;
  readonly source: PrepareCommitMsgSource;
}

/**
 * Round-trip the commit message through the `prepare-commit-msg` and
 * `commit-msg` hooks, in git's order: write it to `.git/COMMIT_EDITMSG`, run
 * `prepare-commit-msg` (with the path and message source), then — unless
 * verification is disabled — `commit-msg`, then re-read the (possibly
 * rewritten) file and re-sanitise it.
 *
 * `prepare-commit-msg` runs even when `noVerify` is set: git's `--no-verify`
 * bypasses only `pre-commit` and `commit-msg`. Returns the message unchanged
 * (writing no file) when no hook runner is wired.
 */
export const applyCommitMessageHooks = async (
  ctx: Context,
  message: string,
  options: CommitMessageHookOptions,
): Promise<string> => {
  if (ctx.hooks === undefined) return message;
  const editMsgPath = `${ctx.layout.gitDir}/COMMIT_EDITMSG`;
  await ctx.fs.writeUtf8(editMsgPath, message);
  await runHook(ctx, 'prepare-commit-msg', { args: [editMsgPath, options.source] });
  if (!options.noVerify) {
    await runHook(ctx, 'commit-msg', { args: [editMsgPath] });
  }
  const edited = await ctx.fs.readUtf8(editMsgPath);
  return sanitizeMessage(edited, { allowEmpty: options.allowEmptyMessage });
};
