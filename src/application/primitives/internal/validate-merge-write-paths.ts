import { validateTreePath } from '../../../domain/git-index/path-validator.js';
import {
  type MergeConflict,
  type MergeOutcome,
  recordsOwnPaths,
} from '../../../domain/merge/index.js';
import { FILE_MODE, type FileMode, type FilePath } from '../../../domain/objects/index.js';

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
    validateTreePath(
      outcome.path,
      outcome.status === 'resolved-deleted' ? FILE_MODE.REGULAR : outcome.mode,
    );
  }
  for (const conflict of conflicts) validateConflictWritePaths(conflict);
};

/**
 * Validates every path a conflict writes with the mode it is written with —
 * git checks each path against its own side's mode, so one side's symlink
 * must not taint another side's path (or the reverse). Only the
 * `.gitmodules`-symlink rule is mode-sensitive.
 */
export const validateConflictWritePaths = (conflict: MergeConflict): void => {
  if (!recordsOwnPaths(conflict)) {
    const mode = conflict.mergedMode ?? conflict.ourMode ?? conflict.theirMode;
    validateTreePath(conflict.path, mode ?? FILE_MODE.REGULAR);
    return;
  }
  validateTreePath(conflict.path, modeWrittenAt(conflict, conflict.path) ?? FILE_MODE.REGULAR);
  for (const [path, mode] of sidePaths(conflict)) validateTreePath(path, mode ?? FILE_MODE.REGULAR);
};

type SidePath = readonly [FilePath, FileMode | undefined];

/** A conflict that renames a side (`<path>~<label>`) writes the moved path too; git refuses the whole merge when it is invalid. */
const sidePaths = (conflict: MergeConflict): ReadonlyArray<SidePath> =>
  (
    [
      [conflict.ourPath, conflict.ourMode],
      [conflict.theirPath, conflict.theirMode],
      [conflict.basePath, conflict.baseMode],
    ] as const
  ).filter((side): side is SidePath => side[0] !== undefined);

/** The mode of the side written at `path`; a directory standing at `path` has none. */
const modeWrittenAt = (conflict: MergeConflict, path: FilePath): FileMode | undefined =>
  sidePaths(conflict).find(([sidePath]) => sidePath === path)?.[1];
