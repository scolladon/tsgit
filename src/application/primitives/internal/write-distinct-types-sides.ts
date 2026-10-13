/**
 * Working-tree materialisation of a distinct-types conflict: each side's blob
 * is written at its recorded path (`ourPath`/`theirPath`), symlink-aware.
 * Shared by `merge`'s conflict persistence and `applyMergeToWorktree`
 * (cherry-pick / revert / rebase / stash).
 */
import type { MergeConflict } from '../../../domain/merge/index.js';
import type { LeadingPathScanner } from './symlinked-leading-path.js';
import type { WorkingTreeWriter } from './write-converted-entry.js';

export const writeDistinctTypesSides = async (
  writer: WorkingTreeWriter,
  conflict: MergeConflict,
  scanner?: LeadingPathScanner,
): Promise<void> => {
  const { ourPath, theirPath, ourId, ourMode, theirId, theirMode } = conflict;
  if (ourPath !== undefined && ourId !== undefined && ourMode !== undefined) {
    await writer.writeBlob(ourPath, ourId, ourMode, scanner);
  }
  if (theirPath !== undefined && theirId !== undefined && theirMode !== undefined) {
    await writer.writeBlob(theirPath, theirId, theirMode, scanner);
  }
};
