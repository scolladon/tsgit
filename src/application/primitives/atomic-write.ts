/**
 * Lock-file + rename helper: `atomicWriteFile` is the generic primitive
 * (any single-file artefact behind a `<path>.lock`); `atomicWriteRef`
 * specialises it for ref updates. `writeObject` uses `fs.writeExclusive`
 * directly for loose objects, which need no lock file at all.
 */
import { TsgitError } from '../../domain/error.js';
import type { RefName } from '../../domain/objects/index.js';
import { refLocked } from '../../domain/refs/error.js';
import type { Context } from '../../ports/context.js';
import { lockSuffix } from './path-layout.js';

/**
 * Exclusively creates `<path>.lock`, writes `content` into it, then renames
 * it onto `path` — the same lock-then-rename shape git itself takes for a
 * single-file artefact (a ref, `commit-graph`, …). `onLocked` receives the
 * lock path and produces the format-specific refusal a contended write
 * throws; every other failure propagates unchanged.
 */
export async function atomicWriteFile(
  ctx: Context,
  path: string,
  content: Uint8Array,
  onLocked: (lockPath: string) => TsgitError,
): Promise<void> {
  const lockPath = `${path}${lockSuffix}`;
  try {
    await ctx.fs.writeExclusive(lockPath, content);
  } catch (error) {
    if (isFileExists(error)) {
      throw onLocked(lockPath);
    }
    throw error;
  }
  try {
    await ctx.fs.rename(lockPath, path);
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

export async function atomicWriteRef(
  ctx: Context,
  refName: RefName,
  refPath: string,
  content: Uint8Array,
): Promise<void> {
  return atomicWriteFile(ctx, refPath, content, () => refLocked(refName));
}

function isFileExists(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'FILE_EXISTS';
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'FILE_NOT_FOUND';
}
