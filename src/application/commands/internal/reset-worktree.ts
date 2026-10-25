/**
 * Hard-reset the working tree + index to `commitId`'s tree — `reset --hard`
 * semantics with `forceRewriteAll` so dirty / no-op'd paths don't survive the
 * reset. Sparse-aware.
 *
 * Inlined here (rather than delegated to the `reset` command) so it can run
 * while an operation marker (`MERGE_HEAD` / `CHERRY_PICK_HEAD`) is still on disk:
 * `reset`'s own `assertNoPendingOperation` would fire on the very marker the
 * abort/skip is about to clear (ADR-170). Shared by `merge --abort` and
 * `cherry-pick --skip` / `--abort`.
 */

import { workingTreeDirty } from '../../../domain/commands/error.js';
import { comparePaths } from '../../../domain/diff/index.js';
import { TsgitError } from '../../../domain/error.js';
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { FilePath, ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { type MaterializeTreeOpts, materializeTree } from '../../primitives/materialize-tree.js';
import { readIndex } from '../../primitives/read-index.js';
import { readObject } from '../../primitives/read-object.js';
import { loadSparseMatcher } from '../../primitives/read-sparse-checkout.js';
import { asMergeDirtyError } from '../merge.js';
import { acquireIndexLock } from './index-update.js';

type ResetMode = Pick<
  MaterializeTreeOpts,
  'force' | 'forceRewriteAll' | 'unmergedPaths' | 'untrackedOccupants'
>;

const resetWorktreeToCommit = async (
  ctx: Context,
  commitId: ObjectId,
  mode: ResetMode,
): Promise<void> => {
  const matcher = await loadSparseMatcher(ctx);
  const commit = await readObject(ctx, commitId);
  if (commit.type !== 'commit') throw unexpectedObjectType('commit', commit.type, commitId);
  const lock = await acquireIndexLock(ctx);
  try {
    const currentIndex = await readIndex(ctx);
    const result = await materializeTree(ctx, {
      targetTree: commit.data.tree,
      currentIndex,
      ...mode,
      ...(matcher !== undefined ? { sparse: matcher } : {}),
    });
    await lock.commit(result.newIndexEntries, 'replace');
  } finally {
    await lock.release();
  }
};

export const hardResetWorktreeToCommit = (ctx: Context, commitId: ObjectId): Promise<void> =>
  resetWorktreeToCommit(ctx, commitId, { force: true, forceRewriteAll: true });

/**
 * `reset --hard` as `rebase --abort` / `--skip` run it: tracked changes are discarded, but an
 * untracked occupant is never overwritten (ignored ones are) and every offending path is listed.
 */
export const protectedResetWorktreeToCommit = async (
  ctx: Context,
  commitId: ObjectId,
): Promise<void> => {
  try {
    await resetWorktreeToCommit(ctx, commitId, {
      force: true,
      forceRewriteAll: true,
      untrackedOccupants: 'protect',
      unmergedPaths: 'reset',
    });
  } catch (err) {
    throw asMergeDirtyError(err);
  }
};

/**
 * `reset --merge` as `merge --abort` runs it: a path the index and the target agree on keeps its
 * occupant and local change, unmerged paths are reset, and the refusal names only the first
 * blocking path, as git's single-path error does.
 */
export const mergeResetWorktreeToCommit = async (
  ctx: Context,
  commitId: ObjectId,
): Promise<void> => {
  try {
    await resetWorktreeToCommit(ctx, commitId, { force: false, unmergedPaths: 'reset' });
  } catch (err) {
    throw err instanceof TsgitError && err.data.code === 'CHECKOUT_OVERWRITE_DIRTY'
      ? firstBlockingPathOnly(err.data)
      : err;
  }
};

const firstBlockingPathOnly = ({
  localChanges,
  untracked,
}: {
  readonly localChanges: ReadonlyArray<FilePath>;
  readonly untracked: ReadonlyArray<FilePath>;
}): TsgitError => {
  const firstLocal = [...localChanges].sort(comparePaths)[0];
  const firstUntracked = [...untracked].sort(comparePaths)[0];
  if (
    firstUntracked === undefined ||
    (firstLocal !== undefined && comparePaths(firstLocal, firstUntracked) < 0)
  ) {
    return workingTreeDirty({
      localChanges: firstLocal === undefined ? [] : [firstLocal],
      untracked: [],
    });
  }
  return workingTreeDirty({ localChanges: [], untracked: [firstUntracked] });
};
