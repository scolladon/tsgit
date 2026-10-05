/**
 * git's `remove_branch_state` family — the cleanup every command that ends or
 * abandons an in-progress operation runs: `reset`, a branch `checkout`,
 * `merge --abort`, `commit` and the sequencer.
 *
 * @writes
 *   surface: branch-state
 *   kind:    byte-identical
 *   format:  git-merge-state-files
 */
import {
  AUTO_MERGE,
  CHERRY_PICK_HEAD,
  MERGE_HEAD,
  MERGE_MODE,
  MERGE_MSG,
  MERGE_RR,
  REVERT_HEAD,
  SQUASH_MSG,
} from '../../../domain/refs/state-files.js';
import type { Context } from '../../../ports/context.js';
import { clearSequencer } from './sequencer-state.js';

/** Whether a cancelled pick or revert is reported, as a non-quiet `checkout` does. */
export type CancelReport = 'announce' | 'silent';

const MERGE_BRANCH_STATE = [MERGE_HEAD, MERGE_RR, MERGE_MSG, MERGE_MODE, AUTO_MERGE] as const;

const CANCELLED_OPERATIONS = [
  { marker: CHERRY_PICK_HEAD, warning: 'cancelling a cherry picking in progress' },
  { marker: REVERT_HEAD, warning: 'cancelling a revert in progress' },
] as const;

/** Remove `<gitDir>/<name>`; whether it was there. */
const removeStateFile = async (ctx: Context, name: string): Promise<boolean> => {
  const path = `${ctx.layout.gitDir}/${name}`;
  if (!(await ctx.fs.exists(path))) return false;
  await ctx.fs.rm(path);
  return true;
};

/** git's `remove_merge_branch_state`: the stopped merge's files. */
export const removeMergeBranchState = async (ctx: Context): Promise<void> => {
  for (const name of MERGE_BRANCH_STATE) await removeStateFile(ctx, name);
};

/** git's `have_finished_the_last_pick`: the todo holds at most the current line. */
const haveFinishedTheLastPick = async (ctx: Context): Promise<boolean> => {
  const todo = `${ctx.layout.gitDir}/sequencer/todo`;
  if (!(await ctx.fs.exists(todo))) return false;
  const content = await ctx.fs.readUtf8(todo);
  const eol = content.indexOf('\n');
  return eol === -1 || eol === content.length - 1;
};

/**
 * git's `sequencer_post_commit_cleanup`: drop a pick's or revert's marker and
 * `AUTO_MERGE`, and the sequencer once its last pick is the one cancelled.
 */
export const sequencerPostCommitCleanup = async (
  ctx: Context,
  report: CancelReport,
): Promise<void> => {
  let cancelled = false;
  for (const { marker, warning } of CANCELLED_OPERATIONS) {
    if (!(await removeStateFile(ctx, marker))) continue;
    if (report === 'announce') ctx.logger?.warn?.(warning);
    cancelled = true;
  }
  await removeStateFile(ctx, AUTO_MERGE);
  if (cancelled && (await haveFinishedTheLastPick(ctx))) await clearSequencer(ctx);
};

/** git's `remove_branch_state`: every trace of an in-progress operation's stop. */
export const removeBranchState = async (ctx: Context, report: CancelReport): Promise<void> => {
  await sequencerPostCommitCleanup(ctx, report);
  await removeStateFile(ctx, SQUASH_MSG);
  await removeMergeBranchState(ctx);
};
