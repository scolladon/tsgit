/**
 * Removal of empty directories, shared by the files ref store, the reflog
 * writer and the work tree's gitlink and prune removals: one removal attempt
 * per directory, never a recursive delete of anything that is not a directory.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { Context } from '../../../ports/context.js';
import { lstatIfReachable } from './fs-probes.js';

/** The removal failures that mean "not removable", as a failing `rmdir`
 *  does for git: the directory is still non-empty (the browser adapter
 *  reports that as absent) or already gone. */
const UNREMOVABLE_DIRECTORY_CODES: ReadonlySet<string> = new Set([
  'DIRECTORY_NOT_EMPTY',
  'FILE_NOT_FOUND',
  'NOT_A_DIRECTORY',
]);

/** Removes `dir` when it is empty; `false` when it is non-empty or already
 *  gone. Through the port's `rmdir` when it has one — a single call that
 *  refuses a file or a symbolic link — else through `rm`, which also removes
 *  a file, so `dir` must then be known to be a directory. */
export async function removeEmptyDirectory(ctx: Context, dir: string): Promise<boolean> {
  try {
    await (ctx.fs.rmdir ?? ctx.fs.rm).call(ctx.fs, dir);
    return true;
  } catch (err) {
    // Stryker disable next-line StringLiteral: equivalent — the `??` fallback is reached only when `errorDataCode` yields undefined, and no literal put there is a member of UNREMOVABLE_DIRECTORY_CODES, so the probe answers false whatever the literal is.
    if (UNREMOVABLE_DIRECTORY_CODES.has(errorDataCode(err) ?? '')) return false;
    throw err;
  }
}

const isRealDirectory = async (ctx: Context, absolute: string): Promise<boolean> => {
  const stat = await lstatIfReachable(ctx.fs, absolute);
  return stat?.isDirectory === true;
};

/** `rmdir` refuses a link or a file itself; the `rm` fallback would remove them, so it is guarded by a probe. */
export const removeIfEmptyDirectory = async (ctx: Context, absolute: string): Promise<boolean> =>
  ctx.fs.rmdir === undefined
    ? (await isRealDirectory(ctx, absolute)) && (await removeEmptyDirectory(ctx, absolute))
    : removeEmptyDirectory(ctx, absolute);

/**
 * git's `remove_dir_recurse` with `REMOVE_DIR_EMPTY_ONLY`: descends each
 * directory entry of `dir` in listing order and stops at the first entry
 * that is not a directory — every empty subdirectory met before it stays
 * removed — then removes `dir` itself. `true` only when the whole tree is
 * gone. `dir` must be known to be a directory.
 */
export async function removeEmptyDirectoryTree(ctx: Context, dir: string): Promise<boolean> {
  for (const entry of await ctx.fs.readdir(dir)) {
    if (!entry.isDirectory) return false;
    if (!(await removeEmptyDirectoryTree(ctx, `${dir}/${entry.name}`))) return false;
  }
  return removeEmptyDirectory(ctx, dir);
}
