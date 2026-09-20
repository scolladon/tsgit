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

/** Commits a held lock by renaming it onto its path. */
export type CommitLock = (rename: () => Promise<void>) => Promise<void>;

const RENAME_ONLY: CommitLock = (rename) => rename();

/**
 * Exclusively creates `<path>.lock`, writes `content` into it, then renames
 * it onto `path` — the same lock-then-rename shape git itself takes for a
 * single-file artefact (a ref, `commit-graph`, …). `onLocked` receives the
 * lock path and produces the format-specific refusal a contended write
 * throws; `commitLock` runs while the lock is held and performs the rename
 * through the callback it receives — so a caller can check before renaming,
 * or retry a refused rename once it has cleared the cause. A refusal it
 * throws removes the lock and leaves `path` untouched; every other failure
 * propagates unchanged.
 */
export async function atomicWriteFile(
  ctx: Context,
  path: string,
  content: Uint8Array,
  onLocked: (lockPath: string) => TsgitError,
  commitLock: CommitLock = RENAME_ONLY,
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
    await commitLock(() => ctx.fs.rename(lockPath, path));
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

/**
 * Holds `<path>.lock` for the duration of `body`: `body` receives a
 * `commit` callback that writes the lock's real content and renames it onto
 * `path` — git's own lock-then-rename shape, exposed for a body that must
 * do MORE work (under the same lock) before or after the rename, unlike
 * {@link atomicWriteFile}'s single write. A held lock refuses through
 * `onLocked`, exactly as `atomicWriteFile` does. Once `body` returns or
 * throws, an uncommitted lock is removed; a committed one no longer exists
 * at `<path>.lock` (it was renamed away), so nothing is removed.
 */
export async function withLockFile(
  ctx: Context,
  path: string,
  onLocked: (lockPath: string) => TsgitError,
  body: (commit: (content: Uint8Array) => Promise<void>) => Promise<void>,
): Promise<void> {
  const lockPath = `${path}${lockSuffix}`;
  try {
    await ctx.fs.writeExclusive(lockPath, new Uint8Array(0));
  } catch (error) {
    if (isFileExists(error)) throw onLocked(lockPath);
    throw error;
  }
  let committed = false;
  try {
    await body(async (content) => {
      await ctx.fs.write(lockPath, content);
      await ctx.fs.rename(lockPath, path);
      committed = true;
    });
  } finally {
    if (!committed) await removeLockBestEffort(ctx, lockPath);
  }
}

/** Best-effort lock removal shared by every uncommitted exit path — a
 *  `FILE_NOT_FOUND` is swallowed (the lock may already be gone), anything
 *  else propagates so a stuck lock surfaces instead of persisting silently. */
async function removeLockBestEffort(ctx: Context, lockPath: string): Promise<void> {
  try {
    await ctx.fs.rm(lockPath);
  } catch (rmError) {
    if (!isFileNotFound(rmError)) throw rmError;
  }
}

export async function atomicWriteRef(
  ctx: Context,
  refName: RefName,
  refPath: string,
  content: Uint8Array,
  commitLock: CommitLock = RENAME_ONLY,
): Promise<void> {
  return await atomicWriteFile(ctx, refPath, content, () => refLocked(refName), commitLock);
}

function isFileExists(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'FILE_EXISTS';
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof TsgitError && error.data.code === 'FILE_NOT_FOUND';
}
