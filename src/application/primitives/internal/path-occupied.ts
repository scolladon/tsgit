/**
 * Whether anything occupies a working-tree path — a no-follow presence probe, so a
 * dangling symlink still counts as occupying the path (a target-following `exists` would
 * not). Shared by `apply-changeset.ts`'s dirty/untracked-clash checks and `stash.ts`'s
 * untracked-restore overwrite check — both need the same "is something here" answer.
 */
import { errorDataCode } from '../../../domain/error-data-code.js';
import type { Context } from '../../../ports/context.js';
import type { FileSystem } from '../../../ports/file-system.js';

function isFileNotFound(error: unknown): boolean {
  return errorDataCode(error) === 'FILE_NOT_FOUND';
}

/** The answer an adapter without `lexists` gives: `lstat`, with absence read off its refusal. */
async function lstatFindsEntry(fs: FileSystem, absPath: string): Promise<boolean> {
  try {
    await fs.lstat(absPath);
    return true;
  } catch (err) {
    if (isFileNotFound(err)) return false;
    throw err;
  }
}

export async function pathIsOccupied(ctx: Context, absPath: string): Promise<boolean> {
  const { fs } = ctx;
  if (fs.lexists !== undefined) return fs.lexists(absPath);
  return lstatFindsEntry(fs, absPath);
}
