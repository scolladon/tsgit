import { TsgitError } from '../../../domain/error.js';
import { type IndexEntry, serializeIndex } from '../../../domain/git-index/index.js';
import type { Context } from '../../../ports/context.js';
import { indexPath, lockSuffix } from '../path-layout.js';

interface AcquireOptions {
  /** Injectable clock — defaults to `Date.now`. Tests override to simulate stale/skewed locks. */
  readonly now?: () => number;
}

interface IndexLock {
  /** Drop the lock without modifying the index on disk. Idempotent. */
  readonly release: () => Promise<void>;
  /**
   * Atomically commit the new index. Writes a temp lock file, fsyncs (where
   * supported), and renames over `${gitDir}/index`. After commit, `release`
   * becomes a no-op.
   */
  readonly commit: (entries: ReadonlyArray<IndexEntry>) => Promise<void>;
}

const resourceLocked = (path: string, mtimeMs: number | undefined): TsgitError => {
  if (mtimeMs === undefined) {
    return new TsgitError({ code: 'RESOURCE_LOCKED', resource: 'index', path });
  }
  return new TsgitError({ code: 'RESOURCE_LOCKED', resource: 'index', path, mtimeMs });
};

/**
 * Acquire `${gitDir}/index.lock` for the read-modify-write cycle.
 *
 * The break window is the repo-wide `ctx.config?.breakStaleLockMs` — stale-lock
 * breaking is environment policy fixed at `openRepository`, so every index
 * acquisition honours it.
 *
 * Without a window (unset): lock contention surfaces as `RESOURCE_LOCKED`
 * (callers must handle).
 *
 * With a window `N`: when the existing lock's age `(now - mtime)` is in the
 * half-open range `[N, ∞)`, the lock is removed once and acquisition is retried.
 * A second contention surfaces as `RESOURCE_LOCKED`. When the lock's mtime
 * appears to be in the future (clock-skew guard), the lock is NOT broken.
 */
export const acquireIndexLock = async (
  ctx: Context,
  opts: AcquireOptions = {},
): Promise<IndexLock> => {
  const lockPath = `${indexPath(ctx.layout.gitDir)}${lockSuffix}`;
  const indexFile = indexPath(ctx.layout.gitDir);
  const now = opts.now ?? (() => Date.now());
  const breakStaleLockMs = ctx.config?.breakStaleLockMs;

  try {
    await ctx.fs.writeExclusive(lockPath, new Uint8Array());
  } catch (err) {
    if (!(err instanceof TsgitError) || err.data.code !== 'FILE_EXISTS') throw err;
    if (breakStaleLockMs === undefined) {
      throw resourceLocked(lockPath, await readLockMtime(ctx, lockPath));
    }
    await maybeBreakStaleLock(ctx, lockPath, breakStaleLockMs, now);
  }
  return makeLock(ctx, lockPath, indexFile);
};

const readLockMtime = async (ctx: Context, lockPath: string): Promise<number | undefined> => {
  try {
    const stat = await ctx.fs.lstat(lockPath);
    return stat.mtimeMs;
  } catch {
    return undefined;
  }
};

const maybeBreakStaleLock = async (
  ctx: Context,
  lockPath: string,
  breakStaleLockMs: number,
  now: () => number,
): Promise<void> => {
  const mtimeMs = await readLockMtime(ctx, lockPath);
  if (mtimeMs === undefined) {
    // Lock disappeared between attempts — retry the exclusive write directly.
    await ctx.fs.writeExclusive(lockPath, new Uint8Array());
    return;
  }
  const age = now() - mtimeMs;
  if (age < 0) {
    // Backward clock skew: refuse to break (treat as unknown age).
    throw resourceLocked(lockPath, mtimeMs);
  }
  if (age < breakStaleLockMs) {
    throw resourceLocked(lockPath, mtimeMs);
  }
  await ctx.fs.rm(lockPath);
  // Single retry — a second contention surfaces.
  try {
    await ctx.fs.writeExclusive(lockPath, new Uint8Array());
  } catch (err) {
    if (err instanceof TsgitError && err.data.code === 'FILE_EXISTS') {
      throw resourceLocked(lockPath, await readLockMtime(ctx, lockPath));
    }
    throw err;
  }
};

const makeLock = (ctx: Context, lockPath: string, indexFile: string): IndexLock => {
  let committed = false;
  let released = false;
  return {
    release: async () => {
      if (committed || released) return;
      released = true;
      try {
        await ctx.fs.rm(lockPath);
      } catch (err) {
        // Already gone — fine.
        if (!(err instanceof TsgitError) || err.data.code !== 'FILE_NOT_FOUND') throw err;
      }
    },
    commit: async (entries) => {
      if (committed || released) return;
      const body = serializeIndex({
        version: 2,
        entries: [...entries],
        extensions: [],
        trailerSha: new Uint8Array(0),
      });
      const checksum = await ctx.hash.hash(body);
      const bytes = new Uint8Array(body.length + checksum.length);
      bytes.set(body, 0);
      bytes.set(checksum, body.length);
      await ctx.fs.write(lockPath, bytes);
      await ctx.fs.rename(lockPath, indexFile);
      committed = true;
    },
  };
};
