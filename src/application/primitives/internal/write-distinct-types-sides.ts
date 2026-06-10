/**
 * Working-tree materialisation of a distinct-types conflict: each side's blob
 * is written at its recorded path (`ourPath`/`theirPath`), symlink-aware.
 * Shared by `merge`'s conflict persistence and `applyMergeToWorktree`
 * (cherry-pick / revert / rebase / stash).
 */
import { MAX_CONFLICT_OUTPUT_BYTES, type MergeConflict } from '../../../domain/merge/index.js';
import type { Context } from '../../../ports/context.js';
import { readBlob } from '../read-blob.js';
import { writeWorkingTreeEntry } from './write-working-tree-file.js';

export const writeDistinctTypesSides = async (
  ctx: Context,
  conflict: MergeConflict,
): Promise<void> => {
  const { ourPath, theirPath, ourId, ourMode, theirId, theirMode } = conflict;
  if (ourPath !== undefined && ourId !== undefined && ourMode !== undefined) {
    // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
    const ourBlob = await readBlob(ctx, ourId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES });
    await writeWorkingTreeEntry(ctx, ourPath, ourBlob.content, ourMode);
  }
  if (theirPath !== undefined && theirId !== undefined && theirMode !== undefined) {
    // Stryker disable next-line ObjectLiteral: equivalent — the 256 MiB cap is unobservable without a 256 MiB fixture; cap mechanics covered by read-blob.test.ts.
    const theirBlob = await readBlob(ctx, theirId, { maxBytes: MAX_CONFLICT_OUTPUT_BYTES });
    await writeWorkingTreeEntry(ctx, theirPath, theirBlob.content, theirMode);
  }
};
