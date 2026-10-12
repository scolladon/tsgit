/**
 * Persisted single-revert state for `revert`. The `REVERT_HEAD` root ref records the
 * commit currently being reverted; it is the parallel of `.git/CHERRY_PICK_HEAD`
 * but is **never** promoted to a parent (a revert is single-parent and authored
 * by the current identity). `commit` reads it to allow the resolving commit and
 * clears it on success. The conflict `MERGE_MSG` block is shared with cherry-pick
 * (`conflictMergeMsg`); the revert message draft is built here.
 */

import type { CommitData } from '../../../domain/objects/commit.js';
import { subjectLine } from '../../../domain/objects/commit-message.js';
import type { ObjectId, RefName } from '../../../domain/objects/index.js';
import { REVERT_HEAD } from '../../../domain/refs/state-files.js';
import type { Context } from '../../../ports/context.js';
import { deleteRootRef, readRootRef, writeRootRef } from '../../primitives/internal/root-ref.js';

const REVERT_HEAD_REF = REVERT_HEAD as RefName;

/** Record the reverted commit in `REVERT_HEAD`. */
export const writeRevertHead = (ctx: Context, revertedId: ObjectId): Promise<void> =>
  writeRootRef(ctx, REVERT_HEAD_REF, revertedId);

/** The reverted commit id, or `undefined` when `REVERT_HEAD` is absent or broken (git's reading). */
export const readRevertHead = (ctx: Context): Promise<ObjectId | undefined> =>
  readRootRef(ctx, REVERT_HEAD_REF);

/** Drop `REVERT_HEAD`. Idempotent — missing is not an error. */
export const clearRevertHead = (ctx: Context): Promise<void> => deleteRootRef(ctx, REVERT_HEAD_REF);

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
  const subject = subjectLine(cData.message);
  return `Revert ${quoteSubject(subject)}\n\nThis reverts commit ${reverted}.\n`;
};
