/**
 * Removal of empty directories in the refs and logs trees, shared by the
 * files ref store and the reflog writer: one removal attempt per directory,
 * never a recursive delete of anything that is not a directory.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { Context } from '../../../ports/context.js';

/** The removal failures that mean "not removable", as a failing `rmdir`
 *  does for git: the directory is still non-empty (the browser adapter
 *  reports that as absent) or already gone. */
const UNREMOVABLE_DIRECTORY_CODES: ReadonlySet<string> = new Set([
  'DIRECTORY_NOT_EMPTY',
  'FILE_NOT_FOUND',
]);

/** Removes `dir` when it is empty; `false` when it is non-empty or already
 *  gone. `dir` must be known to be a directory — the port's `rm` also
 *  removes a file. */
export async function removeEmptyDirectory(ctx: Context, dir: string): Promise<boolean> {
  try {
    await ctx.fs.rm(dir);
    return true;
  } catch (err) {
    // Stryker disable next-line StringLiteral: equivalent — the `??` fallback is reached only when `errorDataCode` yields undefined, and no literal put there is a member of UNREMOVABLE_DIRECTORY_CODES, so the probe answers false whatever the literal is.
    if (UNREMOVABLE_DIRECTORY_CODES.has(errorDataCode(err) ?? '')) return false;
    throw err;
  }
}

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
