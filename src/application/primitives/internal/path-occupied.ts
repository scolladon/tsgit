/**
 * Whether anything occupies a working-tree path — an `lstat`-based presence probe, so a
 * dangling symlink still counts as occupying the path (a target-following `exists` would
 * not). Shared by `apply-changeset.ts`'s dirty/untracked-clash checks and `stash.ts`'s
 * untracked-restore overwrite check — both need the same "is something here" answer.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { Context } from '../../../ports/context.js';

function isFileNotFound(error: unknown): boolean {
  return errorDataCode(error) === 'FILE_NOT_FOUND';
}

export async function pathIsOccupied(ctx: Context, absPath: string): Promise<boolean> {
  try {
    await ctx.fs.lstat(absPath);
    return true;
  } catch (err) {
    if (isFileNotFound(err)) return false;
    throw err;
  }
}
