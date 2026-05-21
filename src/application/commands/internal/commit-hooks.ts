import type { Context } from '../../../ports/context.js';
import { runHook } from '../../primitives/run-hook.js';
import { sanitizeMessage } from './commit-message.js';

/** Fire the `pre-commit` hook unless verification is disabled (`--no-verify`). */
export const runPreCommitHook = async (ctx: Context, noVerify: boolean): Promise<void> => {
  if (noVerify) return;
  await runHook(ctx, 'pre-commit');
};

interface CommitMsgHookOptions {
  readonly noVerify: boolean;
  readonly allowEmptyMessage: boolean;
}

/**
 * Round-trip the commit message through the `commit-msg` hook: write it to
 * `.git/COMMIT_EDITMSG`, run the hook with that path as its argument, then
 * re-read the (possibly rewritten) file and re-sanitise it. Returns the
 * message unchanged when verification is disabled or no hook runner is wired.
 */
export const applyCommitMsgHook = async (
  ctx: Context,
  message: string,
  options: CommitMsgHookOptions,
): Promise<string> => {
  if (options.noVerify || ctx.hooks === undefined) return message;
  const editMsgPath = `${ctx.layout.gitDir}/COMMIT_EDITMSG`;
  await ctx.fs.writeUtf8(editMsgPath, message);
  await runHook(ctx, 'commit-msg', { args: [editMsgPath] });
  const edited = await ctx.fs.readUtf8(editMsgPath);
  return sanitizeMessage(edited, { allowEmpty: options.allowEmptyMessage });
};
