import { workingTreeDirty } from '../../../domain/commands/error.js';
import { TsgitError } from '../../../domain/error.js';

/**
 * Map `materializeTree`'s checkout-flavoured dirty refusal to the merge-family
 * `WORKING_TREE_DIRTY` code, so the whole 3-way merge family speaks one
 * would-overwrite error; any other error passes through untouched. Exported for
 * direct unit testing.
 */
export const asMergeDirtyError = (err: unknown): unknown =>
  err instanceof TsgitError && err.data.code === 'CHECKOUT_OVERWRITE_DIRTY'
    ? workingTreeDirty({ localChanges: err.data.localChanges, untracked: err.data.untracked })
    : err;
