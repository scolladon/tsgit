/**
 * git's `schedule_dir_for_removal` / `remove_scheduled_dirs`: after a tracked
 * file leaves the work tree, every leading directory it left empty is removed
 * too, deepest first. A directory still holding anything (an untracked file
 * included) refuses removal and stays; the work tree root is never a
 * candidate because only the relative leading components are considered.
 */
import type { Context } from '../../../ports/context.js';
import { removeEmptyDirectory } from './empty-directories.js';
import { joinPath } from './join-working-tree-path.js';

const leadingDirectories = (path: string): ReadonlyArray<string> => {
  const parts = path.split('/').slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'));
};

const distinctDirectoriesDeepestFirst = (paths: Iterable<string>): ReadonlyArray<string> => {
  const directories = new Set<string>();
  for (const path of paths) for (const dir of leadingDirectories(path)) directories.add(dir);
  return [...directories].sort((a, b) => b.length - a.length);
};

/** One removal attempt per distinct leading directory of `removedPaths`; no filesystem call when nothing was removed. */
export const pruneEmptiedDirectories = async (
  ctx: Context,
  workdir: string,
  removedPaths: Iterable<string>,
): Promise<void> => {
  for (const dir of distinctDirectoriesDeepestFirst(removedPaths)) {
    await removeEmptyDirectory(ctx, joinPath(workdir, dir));
  }
};
