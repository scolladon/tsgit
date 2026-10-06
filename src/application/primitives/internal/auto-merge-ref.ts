/**
 * `AUTO_MERGE` — the root ref naming the tree an ort merge checked out. It is a
 * ref, not a state file: it lives wherever the ref backend keeps root refs (a
 * loose file, or the reftable stack), and a broken value refuses the write.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { AUTO_MERGE } from '../../../domain/refs/state-files.js';
import type { Context } from '../../../ports/context.js';
import { deleteRefs, updateRef } from '../update-ref.js';

const AUTO_MERGE_REF = AUTO_MERGE as RefName;

/** git's `merge_switch_to_result`: `AUTO_MERGE` names the result tree it checked out. */
export const writeAutoMerge = async (ctx: Context, tree: ObjectId): Promise<void> => {
  await updateRef(ctx, AUTO_MERGE_REF, tree, { noDeref: true, reflogMessage: '' });
};

/**
 * git's `refs_delete_ref(…, "AUTO_MERGE", …, REF_NO_DEREF)`: every caller
 * ignores its result, so a broken value is reported and left in place.
 */
export const removeAutoMerge = async (ctx: Context): Promise<void> => {
  try {
    await deleteRefs(ctx, [AUTO_MERGE_REF], { noDeref: true });
  } catch (error) {
    if (errorDataCode(error) !== 'INVALID_REF') throw error;
    ctx.logger?.error?.(
      `cannot lock ref '${AUTO_MERGE}': unable to resolve reference '${AUTO_MERGE}': reference broken`,
    );
  }
};
