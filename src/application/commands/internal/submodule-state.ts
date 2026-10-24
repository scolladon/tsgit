import type { IndexEntry } from '../../../domain/git-index/index.js';
import { gitfileTooLarge, notARepository } from '../../../domain/repository/error.js';
import type { Context } from '../../../ports/context.js';
import type { WorkingTreeDelta } from '../../primitives/compare-working-tree-entry.js';
import { probeGitlinkCheckout } from '../../primitives/internal/gitlink-head.js';
import type { ChangedPath, StatusResult } from '../status.js';

export type SubmoduleState = NonNullable<ChangedPath['submodule']>;

/** The status run inside a checked-out submodule, injected so this module only types `status`. */
export interface SubmoduleDeps {
  readonly childStatus: (child: Context) => Promise<StatusResult>;
}

/** git checks only the `S..U` field of a nested gitlink row: such a row adds untracked changes, not tracked ones. */
const isOnlyUntracked = ({ submodule }: ChangedPath): boolean =>
  submodule?.commitChanged === false &&
  submodule.trackedChanges === false &&
  submodule.untrackedChanges;

const insideOf = (
  result: StatusResult,
): Pick<SubmoduleState, 'trackedChanges' | 'untrackedChanges'> => ({
  trackedChanges: result.unmerged.length > 0 || result.changes.some((row) => !isOnlyUntracked(row)),
  untrackedChanges:
    result.untracked.length > 0 || result.changes.some((row) => row.submodule?.untrackedChanges),
});

/**
 * What git's dirty check reports for a gitlink: the checkout's HEAD moving off the
 * recorded commit, then, once a `.git` that leads to no repository has refused,
 * the submodule's own changes.
 */
export const submoduleState = async (
  ctx: Context,
  entry: IndexEntry,
  delta: WorkingTreeDelta,
  { childStatus }: SubmoduleDeps,
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
  if (checkout.kind === 'none') return state;
  return { ...state, ...insideOf(await childStatus(await checkout.context())) };
};
