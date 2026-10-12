/**
 * `AUTO_MERGE` — the root ref naming the tree an ort merge checked out. It is a
 * ref, not a state file: it lives wherever the ref backend keeps root refs (a
 * loose file, or the reftable stack), and a broken value refuses the write.
 */
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { AUTO_MERGE } from '../../../domain/refs/state-files.js';
import type { Context } from '../../../ports/context.js';
import { deleteRootRef, writeRootRef } from './root-ref.js';

const AUTO_MERGE_REF = AUTO_MERGE as RefName;

/** git's `merge_switch_to_result`: `AUTO_MERGE` names the result tree it checked out. */
export const writeAutoMerge = (ctx: Context, tree: ObjectId): Promise<void> =>
  writeRootRef(ctx, AUTO_MERGE_REF, tree);

/** git's `refs_delete_ref(…, "AUTO_MERGE", …, REF_NO_DEREF)`; a broken value is reported and kept. */
export const removeAutoMerge = (ctx: Context): Promise<void> => deleteRootRef(ctx, AUTO_MERGE_REF);
