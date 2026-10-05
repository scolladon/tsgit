/**
 * Persisted merge-state writers.
 *
 * `.git/MERGE_HEAD`, `.git/MERGE_MODE`, `.git/MERGE_MSG`, `.git/ORIG_HEAD`
 * are the canonical git markers that record "a merge is in progress". `merge`
 * writes them when conflicts are detected; `commit` reads MERGE_HEAD (and
 * MERGE_MODE) for the parents and deletes all but ORIG_HEAD when the resolved
 * merge commits.
 *
 * Symmetric with `repo-state.ts` which reads these markers via
 * `assertNoPendingOperation`. See `docs/adr/027-merge-conflict-write-order.md`
 * for the load-bearing write order.
 *
 * @writes
 *   surface: merge
 *   kind:    byte-identical
 *   format:  git-merge-state-files
 */

import type { ObjectId } from '../../../domain/objects/index.js';
import { ObjectId as ObjectIdFactory } from '../../../domain/objects/index.js';
import { MERGE_HEAD, MERGE_MODE, MERGE_MSG, ORIG_HEAD } from '../../../domain/refs/state-files.js';
import type { Context } from '../../../ports/context.js';

const mergeHeadPath = (ctx: Context): string => `${ctx.layout.gitDir}/${MERGE_HEAD}`;
const mergeMsgPath = (ctx: Context): string => `${ctx.layout.gitDir}/${MERGE_MSG}`;
const mergeModePath = (ctx: Context): string => `${ctx.layout.gitDir}/${MERGE_MODE}`;

/** git's `MERGE_MODE` content: `no-ff` under `--no-ff`, else empty. */
export type MergeMode = '' | typeof NO_FAST_FORWARD;

const NO_FAST_FORWARD = 'no-ff';
const origHeadPath = (ctx: Context): string => `${ctx.layout.gitDir}/${ORIG_HEAD}`;

/** Write `.git/MERGE_HEAD`: each head merged's commit id + LF, in merge order. */
export const writeMergeHeads = async (
  ctx: Context,
  targetIds: ReadonlyArray<ObjectId>,
): Promise<void> => {
  await ctx.fs.writeUtf8(mergeHeadPath(ctx), targetIds.map((id) => `${id}\n`).join(''));
};

/** Write `.git/MERGE_MODE`: whether the stopped merge refused to fast-forward. */
export const writeMergeMode = async (
  ctx: Context,
  fastForward: 'only' | 'never' | 'allow' | undefined,
): Promise<void> => {
  const mode: MergeMode = fastForward === 'never' ? NO_FAST_FORWARD : '';
  await ctx.fs.writeUtf8(mergeModePath(ctx), mode);
};

/** Whether `.git/MERGE_MODE` reads exactly `no-ff` — the commit then keeps every parent. */
export const readsNoFastForward = async (ctx: Context): Promise<boolean> => {
  const path = mergeModePath(ctx);
  if (!(await ctx.fs.exists(path))) return false;
  return (await ctx.fs.readUtf8(path)) === NO_FAST_FORWARD;
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
 * Read every `.git/MERGE_HEAD` line — one per head merged, in merge order —
 * or `undefined` when the file is absent or empty. Each line is validated via
 * the ObjectId factory: a corrupt MERGE_HEAD (mid-write crash) refuses with
 * INVALID_OBJECT_ID rather than produce a malformed parent.
 */
export const readMergeHeads = async (
  ctx: Context,
): Promise<ReadonlyArray<ObjectId> | undefined> => {
  const path = mergeHeadPath(ctx);
  if (!(await ctx.fs.exists(path))) return undefined;
  const lines = (await ctx.fs.readUtf8(path)).split('\n').map((line) => line.trim());
  const ids = lines.filter((line) => line.length > 0).map((line) => ObjectIdFactory.from(line));
  return ids.length === 0 ? undefined : ids;
};

/** What `MERGE_HEAD` resolves to as a ref — its first line — or `undefined` when absent. */
export const readMergeHead = async (ctx: Context): Promise<ObjectId | undefined> =>
  (await readMergeHeads(ctx))?.[0];

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
  for (const path of [mergeHeadPath(ctx), mergeMsgPath(ctx), mergeModePath(ctx)]) {
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
