import { NO_PARSER_OFFSET, validateIndexPath } from '../../../domain/git-index/path-validator.js';
import type { MergeConflict, MergeOutcome } from '../../../domain/merge/index.js';
import { FILE_MODE, type FilePath } from '../../../domain/objects/index.js';

/**
 * Whole-set path gate for a conflicting merge's working-tree write. Mirrors
 * the write's own `touched`/`conflicts` selection, so every path it is about
 * to touch is validated here, in one pass, before any of them are — the
 * refusal has to be atomic, or a hostile name leaves siblings already on
 * disk.
 *
 * `resolved-deleted` carries no mode of its own (a delete writes nothing),
 * so `REGULAR` stands in: the only mode-sensitive rule `validateIndexPath`
 * can apply — the `.gitmodules`-symlink rejection — is a write-time concern
 * that does not apply to a removal. A conflict with no derivable mode is
 * still validated for the same reason: the index entry is written for it
 * regardless of whether any working-tree bytes follow.
 *
 * Shared by the `merge` command and the primitive that cherry-pick, revert,
 * rebase and stash apply go through; both write the same set the same way,
 * and a gate that drifted between them would be a gate on one surface only.
 */
export const validateMergeWritePaths = (
  outcomes: ReadonlyArray<MergeOutcome>,
  conflicts: ReadonlyArray<MergeConflict>,
  changed: ReadonlySet<FilePath>,
): void => {
  for (const outcome of outcomes) {
    if (outcome.status === 'conflict' || !changed.has(outcome.path)) continue;
    validateIndexPath(
      outcome.path,
      NO_PARSER_OFFSET,
      outcome.status === 'resolved-deleted' ? FILE_MODE.REGULAR : outcome.mode,
    );
  }
  for (const conflict of conflicts) {
    const mode = conflict.mergedMode ?? conflict.ourMode ?? conflict.theirMode;
    validateIndexPath(conflict.path, NO_PARSER_OFFSET, mode ?? FILE_MODE.REGULAR);
  }
};
