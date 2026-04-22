/**
 * Lock-file + rename helper for ref updates. Reserved for `updateRef`;
 * `writeObject` uses `fs.writeExclusive` directly for loose objects.
 */
import { TsgitError } from '../../domain/error.js';
import type { RefName } from '../../domain/objects/index.js';
import { refLocked } from '../../domain/refs/error.js';
import type { Context } from '../../ports/context.js';
import { lockSuffix } from './path-layout.js';

export async function atomicWriteRef(
  ctx: Context,
  refName: RefName,
  refPath: string,
  content: Uint8Array,
): Promise<void> {
  const lockPath = `${refPath}${lockSuffix}`;
  try {
    await ctx.fs.writeExclusive(lockPath, content);
  } catch (error) {
    if (isFileExists(error)) {
      throw refLocked(refName);
    }
    throw error;
  }
  try {
    await ctx.fs.rename(lockPath, refPath);
  } catch (error) {
    // Best-effort lock cleanup. Only swallow FILE_NOT_FOUND (the rename may have
    // succeeded partially on some filesystems), otherwise propagate so a stuck
    // lock surfaces instead of silently persisting.
    try {
      await ctx.fs.rm(lockPath);
    } catch (rmError) {
      if (!isFileNotFound(rmError)) throw rmError;
    }
    throw error;
  }
}

function isFileExists(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'FILE_EXISTS';
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'FILE_NOT_FOUND';
}
