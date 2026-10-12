/**
 * git rebase's preemptive fast-forward: `fill_branch_base` walks onto against
 * head first, and only a branch base equal to onto earns the second walk —
 * upstream against head — then the first-parent linearity check.
 */
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readCommitData } from '../../primitives/internal/read-commit-data.js';
import { mergeBasesOf } from '../../primitives/merge-base.js';

const soleMergeBase = async (
  ctx: Context,
  a: ObjectId,
  b: ObjectId,
): Promise<ObjectId | undefined> => {
  const bases = await mergeBasesOf(ctx, [a, b], { all: true });
  return bases.length === 1 ? bases[0] : undefined;
};

/** git's `fill_branch_base`: the sole merge base of `onto` and `head`; `undefined` for none or several. */
export const branchBaseOf = (
  ctx: Context,
  onto: ObjectId,
  head: ObjectId,
): Promise<ObjectId | undefined> => soleMergeBase(ctx, onto, head);

/** git's `is_linear_history`: no merge on `to`'s first-parent chain before `from` or a root. */
export const isLinearHistory = async (
  ctx: Context,
  from: ObjectId,
  to: ObjectId,
): Promise<boolean> => {
  for (let id: ObjectId | undefined = to; id !== undefined && id !== from; ) {
    const { parents } = await readCommitData(ctx, id);
    if (parents.length > 1) return false;
    id = parents[0];
  }
  return true;
};

export interface FastForwardEnds {
  readonly onto: ObjectId;
  readonly upstream: ObjectId;
  readonly head: ObjectId;
  /** {@link branchBaseOf} `onto` and `head`. */
  readonly branchBase: ObjectId | undefined;
}

/** git's `can_fast_forward`: head already sits linearly on onto, the sole base it shares with upstream. */
export const canFastForward = async (ctx: Context, ends: FastForwardEnds): Promise<boolean> => {
  if (ends.branchBase !== ends.onto) return false;
  if ((await soleMergeBase(ctx, ends.upstream, ends.head)) !== ends.onto) return false;
  return isLinearHistory(ctx, ends.onto, ends.head);
};
