/**
 * Root refs — `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `ORIG_HEAD`, `REBASE_HEAD`,
 * `AUTO_MERGE` — are refs, not state files: they live wherever the ref backend
 * keeps root refs (a loose file, or the reftable stack). Only the pseudorefs
 * `MERGE_HEAD` and `FETCH_HEAD` stay files whatever the backend.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { refResolvesForReading, resolveRefForReading } from '../resolve-ref.js';
import { deleteRefs, updateRef } from '../update-ref.js';

/** git's `refs_update_ref(…, REF_NO_DEREF)`: a broken current value refuses the write. */
export const writeRootRef = async (ctx: Context, name: RefName, id: ObjectId): Promise<void> => {
  await updateRef(ctx, name, id, { noDeref: true, reflogMessage: '' });
};

/** git's `repo_get_oid` on a root ref: its id, or `undefined` when absent or broken. */
export const readRootRef = (ctx: Context, name: RefName): Promise<ObjectId | undefined> =>
  resolveRefForReading(ctx, name);

/** git's `refs_ref_exists`: a broken root ref does not exist. */
export const rootRefExists = (ctx: Context, name: RefName): Promise<boolean> =>
  refResolvesForReading(ctx, name);

/**
 * git's `refs_delete_ref(…, REF_NO_DEREF)`: every caller ignores its result,
 * so a broken value is reported and left in place.
 */
export const deleteRootRef = async (ctx: Context, name: RefName): Promise<void> => {
  try {
    await deleteRefs(ctx, [name], { noDeref: true });
  } catch (error) {
    if (errorDataCode(error) !== 'INVALID_REF') throw error;
    ctx.logger?.error?.(
      `cannot lock ref '${name}': unable to resolve reference '${name}': reference broken`,
    );
  }
};
