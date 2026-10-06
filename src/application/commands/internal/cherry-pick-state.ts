/**
 * Persisted single-pick state for `cherry-pick`. The `CHERRY_PICK_HEAD` root ref records
 * the commit currently being picked; it is the parallel of `.git/MERGE_HEAD` but
 * is **never** promoted to a second parent (cherry-pick stays single-parent).
 * `commit` reads it to allow the resolving commit and clears it on success.
 * `MERGE_MSG` is shared with the merge machine (`internal/merge-state.ts`).
 */
import type { FilePath, ObjectId, RefName } from '../../../domain/objects/index.js';
import { CHERRY_PICK_HEAD } from '../../../domain/refs/state-files.js';
import type { Context } from '../../../ports/context.js';
import { deleteRootRef, readRootRef, writeRootRef } from '../../primitives/internal/root-ref.js';

const CHERRY_PICK_HEAD_REF = CHERRY_PICK_HEAD as RefName;

/** Record the picked commit in `CHERRY_PICK_HEAD`. */
export const writeCherryPickHead = (ctx: Context, pickedId: ObjectId): Promise<void> =>
  writeRootRef(ctx, CHERRY_PICK_HEAD_REF, pickedId);

/** The picked commit id, or `undefined` when `CHERRY_PICK_HEAD` is absent or broken (git's reading). */
export const readCherryPickHead = (ctx: Context): Promise<ObjectId | undefined> =>
  readRootRef(ctx, CHERRY_PICK_HEAD_REF);

/** Drop `CHERRY_PICK_HEAD`. Idempotent — missing is not an error. */
export const clearCherryPickHead = (ctx: Context): Promise<void> =>
  deleteRootRef(ctx, CHERRY_PICK_HEAD_REF);

/**
 * Build the `MERGE_MSG` draft for a conflicted pick: the source message, a blank
 * line, then a tab-indented `# Conflicts:` block — byte-faithful to git.
 */
export const conflictMergeMsg = (draft: string, paths: ReadonlyArray<FilePath>): string => {
  // Trim the draft's trailing whitespace so a stripspace'd message (which ends
  // in a single LF) yields exactly one blank line before the block — git's bytes.
  const body = draft.replace(/\s+$/, '');
  return `${body}\n${conflictsHint(paths)}`;
};

/** git's `append_conflicts_hint`: a blank line, then the `# Conflicts:` block. */
export const conflictsHint = (paths: ReadonlyArray<FilePath>): string =>
  `\n# Conflicts:\n${paths.map((p) => `#\t${p}\n`).join('')}`;
