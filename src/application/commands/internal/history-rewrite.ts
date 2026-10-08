/**
 * Helpers shared by the history-rewriting porcelain (`cherry-pick`, `revert`,
 * `rebase`): read a commit's data, project its tree, and guard a symbolic HEAD.
 * Each replay command consumes the same building blocks, so they live here
 * rather than being copied per command.
 */
import { noInitialCommit } from '../../../domain/commands/error.js';
import { TsgitError } from '../../../domain/error.js';
import { unsupportedOperation } from '../../../domain/index.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readCommitData } from '../../primitives/internal/read-commit-data.js';
import { readHeadRaw } from '../../primitives/internal/repo-state.js';
import { resolveRef } from '../../primitives/resolve-ref.js';

export { readCommitData };

export const treeOf = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> =>
  (await readCommitData(ctx, commitId)).tree;

/** Read the symbolic HEAD branch, refusing a detached HEAD for `verb`. */
export const requireSymbolicHead = async (ctx: Context, verb: string): Promise<RefName> => {
  const head = await readHeadRaw(ctx);
  if (head.kind !== 'symbolic') {
    throw unsupportedOperation(verb, 'cannot run with detached HEAD');
  }
  return head.target;
};

/** Resolve the (symbolic) HEAD branch to its commit, or refuse on an unborn branch. */
export const resolveHeadCommit = async (ctx: Context, branch: RefName): Promise<ObjectId> => {
  try {
    return await resolveRef(ctx, branch);
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'REF_NOT_FOUND') throw noInitialCommit();
    throw err;
  }
};
