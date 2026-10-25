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

import { type WouldOverwriteClasses, workingTreeDirty } from '../../../domain/commands/error.js';
import { comparePaths } from '../../../domain/diff/index.js';
import { TsgitError } from '../../../domain/error.js';
import { unexpectedObjectType } from '../../../domain/objects/error.js';
import type { FilePath, ObjectId, RefName } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { type MaterializeTreeOpts, materializeTree } from '../../primitives/materialize-tree.js';
import { readIndex } from '../../primitives/read-index.js';
import { readObject } from '../../primitives/read-object.js';
import { loadSparseMatcher } from '../../primitives/read-sparse-checkout.js';
import { resolveRef } from '../../primitives/resolve-ref.js';
import { acquireIndexLock } from './index-update.js';

type ResetMode = Pick<
  MaterializeTreeOpts,
  'force' | 'forceRewriteAll' | 'unmergedPaths' | 'untrackedOccupants' | 'headTree'
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

/** A reset that stopped short because an untracked or dirty path would be overwritten. */
export interface WorktreeRefusal extends WouldOverwriteClasses {
  readonly kind: 'refused';
}

export type ResetOutcome = { readonly kind: 'reset' } | WorktreeRefusal;

/**
 * `reset --hard` as `rebase --abort` / `--skip` and a `--rebase-merges` `reset` step run it:
 * tracked changes are discarded, but an untracked occupant is never overwritten (ignored ones
 * are). A refusal lists every offending path and leaves the tree, index and HEAD untouched.
 */
export const attemptProtectedResetWorktreeToCommit = async (
  ctx: Context,
  commitId: ObjectId,
): Promise<ResetOutcome> => {
  try {
    await resetWorktreeToCommit(ctx, commitId, {
      force: true,
      forceRewriteAll: true,
      untrackedOccupants: 'protect',
      unmergedPaths: 'reset',
    });
    return { kind: 'reset' };
  } catch (err) {
    return refusalOrRethrow(err);
  }
};

const refusalOrRethrow = (err: unknown): WorktreeRefusal => {
  if (err instanceof TsgitError && err.data.code === 'CHECKOUT_OVERWRITE_DIRTY') {
    return { kind: 'refused', localChanges: err.data.localChanges, untracked: err.data.untracked };
  }
  throw err;
};

export const protectedResetWorktreeToCommit = async (
  ctx: Context,
  commitId: ObjectId,
): Promise<void> => {
  const outcome = await attemptProtectedResetWorktreeToCommit(ctx, commitId);
  if (outcome.kind === 'refused') throw workingTreeDirty(outcome);
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

// Both arrays arrive already sorted by `comparePaths` from every CHECKOUT_OVERWRITE_DIRTY throw site.
const firstBlockingPathOnly = ({
  localChanges,
  untracked,
}: {
  readonly localChanges: ReadonlyArray<FilePath>;
  readonly untracked: ReadonlyArray<FilePath>;
}): TsgitError => {
  const earliestLocal = localChanges.slice(0, 1);
  const earliestUntracked = untracked.slice(0, 1);
  const [firstLocal] = earliestLocal;
  const [firstUntracked] = earliestUntracked;
  const localLeads =
    firstLocal !== undefined &&
    // Stryker disable next-line EqualityOperator: equivalent — a path is probed once and lands in one class, so a path is never both first local and first untracked and the tie `<=` adds is unreachable.
    (firstUntracked === undefined || comparePaths(firstLocal, firstUntracked) < 0);
  return localLeads
    ? workingTreeDirty({ localChanges: earliestLocal, untracked: [] })
    : workingTreeDirty({ localChanges: [], untracked: earliestUntracked });
};

const HEAD = 'HEAD' as RefName;

const treeOf = async (ctx: Context, commitId: ObjectId): Promise<ObjectId> => {
  const commit = await readObject(ctx, commitId);
  if (commit.type !== 'commit') throw unexpectedObjectType('commit', commit.type, commitId);
  return commit.data.tree;
};

export type CheckoutOutcome = { readonly kind: 'checked-out' } | WorktreeRefusal;

/**
 * The unforced two-way checkout rebase runs before it moves HEAD (git's `could not detach HEAD`
 * on refusal): a path HEAD and the target agree on keeps its occupant, an untracked occupant
 * where the target writes refuses with every offending path and nothing is touched, an ignored
 * one is overwritten.
 */
export const attemptCheckoutWorktreeToCommit = async (
  ctx: Context,
  target: ObjectId,
): Promise<CheckoutOutcome> => {
  const headTree = await treeOf(ctx, await resolveRef(ctx, HEAD));
  try {
    await resetWorktreeToCommit(ctx, target, { force: false, headTree });
    return { kind: 'checked-out' };
  } catch (err) {
    return refusalOrRethrow(err);
  }
};

export const checkoutWorktreeToCommit = async (ctx: Context, target: ObjectId): Promise<void> => {
  const outcome = await attemptCheckoutWorktreeToCommit(ctx, target);
  if (outcome.kind === 'refused') throw workingTreeDirty(outcome);
};
