import { noOperationInProgress } from '../../domain/commands/error.js';
import type { AuthorIdentity } from '../../domain/objects/index.js';
import type { Context } from '../../ports/context.js';
import { type CommitOptions, type CommitResult, commit } from './commit.js';
import { readMergeHead } from './internal/merge-state.js';
import { assertNotBare, assertRepository } from './internal/repo-state.js';

export interface MergeContinueInput {
  /** Override `MERGE_MSG`. Empty/undefined falls back to the draft. */
  readonly message?: string;
  /** Forwarded to commit. */
  readonly author?: AuthorIdentity;
  readonly committer?: AuthorIdentity;
  /** Skip the `pre-commit` and `commit-msg` hooks (git's `--no-verify`). */
  readonly noVerify?: boolean;
}

export type MergeContinueResult = CommitResult;

/**
 * Finalise a conflicting merge as a merge commit. Asserts a merge is in
 * progress, then delegates to `commit` — which already reads
 * `MERGE_HEAD` for the second parent, falls back to `MERGE_MSG` when the
 * message is empty, runs hooks, and clears merge state on success
 * (ADR-174).
 *
 * Refuses when no merge is in progress (`MERGE_HEAD` absent). Refuses
 * (via `commit`) when the index still has stage-1/2/3 entries.
 */
export const mergeContinue = async (
  ctx: Context,
  opts: MergeContinueInput = {},
): Promise<MergeContinueResult> => {
  await assertRepository(ctx);
  await assertNotBare(ctx, 'merge --continue');
  const mergeHead = await readMergeHead(ctx);
  if (mergeHead === undefined) throw noOperationInProgress('merge');
  return commit(ctx, buildCommitOptions(opts));
};

const buildCommitOptions = (opts: MergeContinueInput): CommitOptions => ({
  message: opts.message ?? '',
  ...(opts.author !== undefined && { author: opts.author }),
  ...(opts.committer !== undefined && { committer: opts.committer }),
  ...(opts.noVerify !== undefined && { noVerify: opts.noVerify }),
});
