import type { IndexEntry } from '../../../domain/git-index/index.js';
import { gitfileTooLarge, notARepository } from '../../../domain/repository/error.js';
import type { Context } from '../../../ports/context.js';
import type { WorkingTreeDelta } from '../../primitives/compare-working-tree-entry.js';
import { probeGitlinkCheckout } from '../../primitives/internal/gitlink-head.js';
import type { ChangedPath } from '../status.js';

export type SubmoduleState = NonNullable<ChangedPath['submodule']>;

/**
 * What git's dirty check reports for a gitlink: the checkout's HEAD moving off the
 * recorded commit, then, once a `.git` that leads to no repository has refused,
 * the submodule's own changes.
 */
export const submoduleState = async (
  ctx: Context,
  entry: IndexEntry,
  delta: WorkingTreeDelta,
): Promise<SubmoduleState> => {
  const state = {
    commitChanged: delta.status === 'modified',
    trackedChanges: false,
    untrackedChanges: false,
  };
  if (delta.status === 'type-changed') return state;
  const checkout = await probeGitlinkCheckout(ctx, entry.path);
  if (checkout.kind === 'oversized') throw gitfileTooLarge(checkout.shown);
  if (checkout.kind === 'broken') throw notARepository(checkout.shown);
  return state;
};
