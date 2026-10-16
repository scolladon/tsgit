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
import { boundedMapFor } from './concurrency.js';
import { removeEmptyDirectory } from './empty-directories.js';
import { lstatIfReachable } from './fs-probes.js';
import { joinPath } from './join-working-tree-path.js';

const parentDirectory = (path: string): string => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
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

/** `rmdir` refuses a link or a file itself; the `rm` fallback would remove them, so it is guarded by a probe. */
const removeIfEmptyDirectory = async (ctx: Context, absolute: string): Promise<boolean> =>
  ctx.fs.rmdir === undefined
    ? (await isRealDirectory(ctx, absolute)) && (await removeEmptyDirectory(ctx, absolute))
    : removeEmptyDirectory(ctx, absolute);

const depthOf = (dir: string): number => {
  let depth = 0;
  for (let i = dir.indexOf('/'); i !== -1; i = dir.indexOf('/', i + 1)) depth++;
  return depth;
};

type Levels = Map<number, Set<string>>;

const schedule = (levels: Levels, dir: string, surviving: SurvivingDirectories): void => {
  if (dir === '' || surviving.has(dir)) return;
  const depth = depthOf(dir);
  const level = levels.get(depth);
  if (level === undefined) levels.set(depth, new Set([dir]));
  else level.add(dir);
};

const deepestDepth = (levels: Levels): number => Math.max(...levels.keys());

/**
 * Attempts one depth level at a time, deepest first, each level through the
 * bounded I/O pool: a directory is tried only once every child scheduled
 * below it has been tried, so it is removed iff the removals left it empty,
 * as git does. A directory that refuses ends its chain; its parent is tried
 * only when it is itself a start or another child of it was removed.
 */
export const pruneEmptiedDirectories = async (
  ctx: Context,
  workdir: string,
  removedPaths: Iterable<string>,
  surviving: SurvivingDirectories,
): Promise<void> => {
  const levels: Levels = new Map();
  for (const path of removedPaths) schedule(levels, parentDirectory(path), surviving);
  while (levels.size > 0) {
    const depth = deepestDepth(levels);
    const dirs = [...(levels.get(depth) ?? [])];
    levels.delete(depth);
    const removed = await boundedMapFor(ctx, 'ioBound', dirs, (dir) =>
      removeIfEmptyDirectory(ctx, joinPath(workdir, dir)),
    );
    dirs.forEach((dir, i) => {
      if (removed[i]) schedule(levels, parentDirectory(dir), surviving);
    });
  }
};
