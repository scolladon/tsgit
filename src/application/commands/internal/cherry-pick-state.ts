/**
 * Persisted single-pick state for `cherry-pick`. `.git/CHERRY_PICK_HEAD` records
 * the commit currently being picked; it is the parallel of `.git/MERGE_HEAD` but
 * is **never** promoted to a second parent (cherry-pick stays single-parent).
 * `commit` reads it to allow the resolving commit and clears it on success.
 * `MERGE_MSG` is shared with the merge machine (`internal/merge-state.ts`).
 */
import type { FilePath, ObjectId } from '../../../domain/objects/index.js';
import { ObjectId as ObjectIdFactory } from '../../../domain/objects/index.js';
import type { Context } from '../../../ports/context.js';

const cherryPickHeadPath = (ctx: Context): string => `${ctx.layout.gitDir}/CHERRY_PICK_HEAD`;

/** Write `.git/CHERRY_PICK_HEAD` containing the picked commit id + LF. */
export const writeCherryPickHead = async (ctx: Context, pickedId: ObjectId): Promise<void> => {
  await ctx.fs.writeUtf8(cherryPickHeadPath(ctx), `${pickedId}\n`);
};

/**
 * Read `.git/CHERRY_PICK_HEAD` and return the picked commit id, or `undefined`
 * when absent/empty. A corrupt (non-40-hex) value throws `INVALID_OBJECT_ID`
 * via the ObjectId factory — a mid-write crash must not yield a malformed pick.
 */
export const readCherryPickHead = async (ctx: Context): Promise<ObjectId | undefined> => {
  const path = cherryPickHeadPath(ctx);
  if (!(await ctx.fs.exists(path))) return undefined;
  const trimmed = (await ctx.fs.readUtf8(path)).trim();
  if (trimmed.length === 0) return undefined;
  return ObjectIdFactory.from(trimmed);
};

/** Remove `.git/CHERRY_PICK_HEAD`. Idempotent — missing is not an error. */
export const clearCherryPickHead = async (ctx: Context): Promise<void> => {
  const path = cherryPickHeadPath(ctx);
  if (await ctx.fs.exists(path)) {
    await ctx.fs.rm(path);
  }
};

/**
 * Build the `MERGE_MSG` draft for a conflicted pick: the source message, a blank
 * line, then a tab-indented `# Conflicts:` block — byte-faithful to git.
 */
export const conflictMergeMsg = (draft: string, paths: ReadonlyArray<FilePath>): string => {
  // Trim the draft's trailing whitespace so a stripspace'd message (which ends
  // in a single LF) yields exactly one blank line before the block — git's bytes.
  const body = draft.replace(/\s+$/, '');
  const block = paths.map((p) => `#\t${p}\n`).join('');
  return `${body}\n\n# Conflicts:\n${block}`;
};
