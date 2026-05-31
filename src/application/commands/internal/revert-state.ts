/**
 * Persisted single-revert state for `revert`. `.git/REVERT_HEAD` records the
 * commit currently being reverted; it is the parallel of `.git/CHERRY_PICK_HEAD`
 * but is **never** promoted to a parent (a revert is single-parent and authored
 * by the current identity). `commit` reads it to allow the resolving commit and
 * clears it on success. The conflict `MERGE_MSG` block is shared with cherry-pick
 * (`conflictMergeMsg`); the revert message draft is built here.
 */
import type { CommitData } from '../../../domain/objects/commit.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';
import { readOptionalOidFile } from './oid-file.js';

const revertHeadPath = (ctx: Context): string => `${ctx.layout.gitDir}/REVERT_HEAD`;

/** Write `.git/REVERT_HEAD` containing the reverted commit id + LF. */
export const writeRevertHead = async (ctx: Context, revertedId: ObjectId): Promise<void> => {
  await ctx.fs.writeUtf8(revertHeadPath(ctx), `${revertedId}\n`);
};

/**
 * Read `.git/REVERT_HEAD` and return the reverted commit id, or `undefined` when
 * absent/empty. A corrupt (non-40-hex) value throws `INVALID_OBJECT_ID` via the
 * ObjectId factory — a mid-write crash must not yield a malformed revert.
 */
export const readRevertHead = (ctx: Context): Promise<ObjectId | undefined> =>
  readOptionalOidFile(ctx, revertHeadPath(ctx));

/** Remove `.git/REVERT_HEAD`. Idempotent — missing is not an error. */
export const clearRevertHead = async (ctx: Context): Promise<void> => {
  const path = revertHeadPath(ctx);
  if (await ctx.fs.exists(path)) {
    await ctx.fs.rm(path);
  }
};

/**
 * Quote a commit subject the way git does for the revert message slot: wrap in
 * double quotes, backslash-escaping only `"` and `\` (git leaves everything else
 * — including non-ASCII — verbatim here, so this is **not** `JSON.stringify`).
 */
export const quoteSubject = (subject: string): string => `"${subject.replace(/([\\"])/g, '\\$1')}"`;

/**
 * The default `git revert` message: `Revert "<subject>"` (first line of the
 * reverted commit only) then `This reverts commit <oid>.` — byte-faithful to git.
 */
export const revertMessage = (cData: CommitData, reverted: ObjectId): string => {
  const subject = cData.message.split('\n')[0] as string;
  return `Revert ${quoteSubject(subject)}\n\nThis reverts commit ${reverted}.\n`;
};
