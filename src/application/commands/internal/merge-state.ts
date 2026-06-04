/**
 * Persisted merge-state writers for.4b.
 *
 * `.git/MERGE_HEAD`, `.git/MERGE_MSG`, `.git/ORIG_HEAD` are the canonical
 * git markers that record "a merge is in progress". `merge` writes them
 * when conflicts are detected; `commit` reads MERGE_HEAD to pick up the
 * second parent and deletes the trio when the resolved merge commits.
 *
 * Symmetric with `repo-state.ts` which reads these markers via
 * `assertNoPendingOperation`. See `docs/adr/027-merge-conflict-write-order.md`
 * for the load-bearing write order.
 */

import type { ObjectId } from '../../../domain/objects/index.js';
import { ObjectId as ObjectIdFactory } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';

const mergeHeadPath = (ctx: Context): string => `${ctx.layout.gitDir}/MERGE_HEAD`;
const mergeMsgPath = (ctx: Context): string => `${ctx.layout.gitDir}/MERGE_MSG`;
const origHeadPath = (ctx: Context): string => `${ctx.layout.gitDir}/ORIG_HEAD`;

/** Write `.git/MERGE_HEAD` containing the merge target's commit id + LF. */
export const writeMergeHead = async (ctx: Context, targetId: ObjectId): Promise<void> => {
  await ctx.fs.writeUtf8(mergeHeadPath(ctx), `${targetId}\n`);
};

/** Write `.git/MERGE_MSG` containing the merge message draft. */
export const writeMergeMsg = async (ctx: Context, message: string): Promise<void> => {
  await ctx.fs.writeUtf8(mergeMsgPath(ctx), message);
};

/** Write `.git/ORIG_HEAD` containing the pre-merge HEAD commit id + LF. */
export const writeOrigHead = async (ctx: Context, oldHeadId: ObjectId): Promise<void> => {
  await ctx.fs.writeUtf8(origHeadPath(ctx), `${oldHeadId}\n`);
};

/**
 * Read `.git/MERGE_HEAD` and return the recorded target ObjectId, or
 * `undefined` when the file is absent. Used by `commit` to pick up the
 * second parent for a resolved merge.
 */
export const readMergeHead = async (ctx: Context): Promise<ObjectId | undefined> => {
  const path = mergeHeadPath(ctx);
  if (!(await ctx.fs.exists(path))) return undefined;
  const content = await ctx.fs.readUtf8(path);
  const trimmed = content.trim();
  if (trimmed.length === 0) return undefined;
  // Validate via the ObjectId factory — a corrupt MERGE_HEAD (mid-write
  // crash) would otherwise produce a malformed second parent on the
  // resolving commit. Factory throws INVALID_OBJECT_ID for non-40-hex.
  return ObjectIdFactory.from(trimmed);
};

/**
 * Read `.git/ORIG_HEAD` and return the recorded pre-merge ObjectId,
 * or `undefined` when the file is absent. Used by `mergeAbort` to
 * restore the working tree, index, and branch ref to the pre-merge
 * commit. Validation via the ObjectId factory rejects a corrupt
 * `ORIG_HEAD` (mid-write crash) with `INVALID_OBJECT_ID`.
 */
export const readOrigHead = async (ctx: Context): Promise<ObjectId | undefined> => {
  const path = origHeadPath(ctx);
  if (!(await ctx.fs.exists(path))) return undefined;
  const content = await ctx.fs.readUtf8(path);
  const trimmed = content.trim();
  if (trimmed.length === 0) return undefined;
  return ObjectIdFactory.from(trimmed);
};

/**
 * Read `.git/MERGE_MSG` and return its content, or `undefined` when
 * the file is absent. Used by `commit` as the default message when
 * resolving a merge.
 */
export const readMergeMsg = async (ctx: Context): Promise<string | undefined> => {
  const path = mergeMsgPath(ctx);
  if (!(await ctx.fs.exists(path))) return undefined;
  return ctx.fs.readUtf8(path);
};

/**
 * Delete the merge-state files after a resolved merge commit. Idempotent
 * — missing files are not an error.
 */
export const clearMergeState = async (ctx: Context): Promise<void> => {
  for (const path of [mergeHeadPath(ctx), mergeMsgPath(ctx)]) {
    if (await ctx.fs.exists(path)) {
      await ctx.fs.rm(path);
    }
  }
};

/** Delete `.git/MERGE_MSG` only (cherry-pick / revert resolution). Idempotent. */
export const clearMergeMsg = async (ctx: Context): Promise<void> => {
  const path = mergeMsgPath(ctx);
  if (await ctx.fs.exists(path)) {
    await ctx.fs.rm(path);
  }
};
