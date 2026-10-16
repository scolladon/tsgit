/**
 * git's `schedule_dir_for_removal` / `remove_scheduled_dirs`: after a tracked
 * file leaves the work tree, the directory it sat in is removed when that left
 * it empty, then its parent, climbing until a directory refuses removal. A
 * directory still holding anything (an untracked file included) refuses and
 * ends the climb; a symlink or a file standing where a directory was expected
 * is never removed; the work tree root is never a candidate because only the
 * relative leading components are considered.
 */
import type { Context } from '../../../ports/context.js';
import { removeEmptyDirectory } from './empty-directories.js';
import { lstatIfReachable } from './fs-probes.js';
import { joinPath } from './join-working-tree-path.js';

const parentDirectory = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};

const distinctParentsDeepestFirst = (paths: Iterable<string>): ReadonlyArray<string> => {
  const parents = new Set<string>();
  for (const path of paths) if (path.includes('/')) parents.add(parentDirectory(path));
  return [...parents].sort((a, b) => b.length - a.length);
};

/** Directories the target state still tracks an entry under; none of them can end up empty. */
export type SurvivingDirectories = ReadonlySet<string>;

/** Every ancestor directory of the given tracked paths; a directory already listed ends its path's climb. */
export const survivingDirectoriesOf = (trackedPaths: Iterable<string>): SurvivingDirectories => {
  const directories = new Set<string>();
  for (const path of trackedPaths) {
    let directory = parentDirectory(path);
    while (directory !== '' && !directories.has(directory)) {
      directories.add(directory);
      directory = parentDirectory(directory);
    }
  }
  return directories;
};

const isRealDirectory = async (ctx: Context, absolute: string): Promise<boolean> => {
  const stat = await lstatIfReachable(ctx.fs, absolute);
  return stat?.isDirectory === true;
};

const removeIfEmptyDirectory = async (ctx: Context, absolute: string): Promise<boolean> =>
  (await isRealDirectory(ctx, absolute)) && (await removeEmptyDirectory(ctx, absolute));

/**
 * Climbs while each directory is removed, as git does; reaching a directory
 * right after removing a child retries it, because that child may have been
 * its last entry. A directory a previous climb already reached is not a fresh
 * start.
 */
const climbFrom = async (
  ctx: Context,
  workdir: string,
  { start, surviving }: { readonly start: string; readonly surviving: SurvivingDirectories },
  visited: Set<string>,
): Promise<void> => {
  if (visited.has(start)) return;
  let dir = start;
  while (dir !== '' && !surviving.has(dir)) {
    visited.add(dir);
    if (!(await removeIfEmptyDirectory(ctx, joinPath(workdir, dir)))) return;
    dir = parentDirectory(dir);
  }
};

/**
 * No filesystem call when nothing was removed, nor for a directory the target
 * state still tracks an entry under: it cannot end up empty, so the attempt
 * would only fail.
 */
export const pruneEmptiedDirectories = async (
  ctx: Context,
  workdir: string,
  removedPaths: Iterable<string>,
  surviving: SurvivingDirectories,
): Promise<void> => {
  const visited = new Set<string>();
  for (const dir of distinctParentsDeepestFirst(removedPaths)) {
    await climbFrom(ctx, workdir, { start: dir, surviving }, visited);
  }
};
