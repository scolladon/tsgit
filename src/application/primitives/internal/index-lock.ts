import { TsgitError } from '../../../domain/error.js';
import { errorDataCode } from '../../../domain/error-data-code.js';
import {
  type CarryKind,
  type CarrySettings,
  carryExtensions,
  NO_INDEX_CHANGE,
  withRestagedPaths,
} from '../../../domain/git-index/carry-extensions.js';
import { diffIndexEntries } from '../../../domain/git-index/diff-index-entries.js';
import { type IndexEntry, serializeIndex } from '../../../domain/git-index/index.js';
import type { GitIndex, IndexExtension } from '../../../domain/git-index/index-entry.js';
import type { IndexPath } from '../../../domain/git-index/index-path-key.js';
import { bytesEqual } from '../../../domain/objects/encoding.js';
import type { Context } from '../../../ports/context.js';
import { readConfig } from '../config-read.js';
import { indexPath, lockSuffix } from '../path-layout.js';
import { invalidateIndexCache } from '../read-index.js';
import { type IsVerified, readPreviousIndex, smudgeRacilyClean } from './smudge-racily-clean.js';

const UNKNOWN_FAILURE_CODE = 'unknown';
const REFRESH_SKIPPED = 'status: index refresh skipped';

interface AcquireOptions {
  /** Injectable clock — defaults to `Date.now`. Tests override to simulate stale/skewed locks. */
  readonly now?: () => number;
}

/**
 * Why the index is written, which decides what the extensions it carries survive.
 * `'update'`: entries replaced in place (add, rm, mv, mixed reset, checkout of paths,
 * sparse-checkout, submodule add). `'replace'`: the index rebuilt from a tree or a
 * merge (checkout of a branch, reset --hard, the merge family, stash, pull, clone,
 * worktree add).
 */
export type IndexWriteKind = Exclude<CarryKind, 'refresh'>;

export interface CommitOptions {
  /** Entries the writer re-staged whatever their object name; honoured for `'update'` only. */
  readonly restagedPaths?: ReadonlyArray<IndexPath>;
}

export interface IndexLock {
  /** Drop the lock without modifying the index on disk. Idempotent. */
  readonly release: () => Promise<void>;
  /**
   * Atomically commit the new index. Writes a temp lock file, fsyncs (where
   * supported), and renames over `${gitDir}/index`. After commit, `release`
   * becomes a no-op.
   */
  readonly commit: (
    entries: ReadonlyArray<IndexEntry>,
    kind: IndexWriteKind,
    options?: CommitOptions,
  ) => Promise<void>;
  /**
   * Write back refreshed stat data only. Resolves `false` and releases the lock when
   * the index changed on disk since `read` (or vanished); nothing is written then.
   * `verified` names the paths the caller already found unchanged, which the racy
   * smudge does not check again.
   */
  readonly commitRefresh: (
    read: GitIndex,
    refreshed: ReadonlyArray<IndexEntry>,
    verified: IsVerified,
  ) => Promise<boolean>;
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

/**
 * Acquire `${gitDir}/index.lock` for an opportunistic write. One exclusive write, no
 * stale-lock breaking: any failure resolves `undefined` so the caller carries on
 * without writing.
 */
export const acquireOptionalIndexLock = async (ctx: Context): Promise<IndexLock | undefined> => {
  const indexFile = indexPath(ctx.layout.gitDir);
  const lockPath = `${indexFile}${lockSuffix}`;
  try {
    await ctx.fs.writeExclusive(lockPath, new Uint8Array());
  } catch (err) {
    reportDegrade(ctx, err, lockPath);
    return undefined;
  }
  return makeLock(ctx, lockPath, indexFile);
};

const stringField = (value: unknown, key: string): string | undefined => {
  if (typeof value !== 'object' || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' ? field : undefined;
};

const degradeCode = (err: unknown): string =>
  errorDataCode(err) ?? stringField(err, 'name') ?? UNKNOWN_FAILURE_CODE;

const reportDegrade = (ctx: Context, err: unknown, path: string): void => {
  const reason = stringField((err as { data?: unknown } | null)?.data, 'reason');
  ctx.logger?.warn?.(REFRESH_SKIPPED, {
    code: degradeCode(err),
    path,
    ...(reason === undefined ? {} : { reason }),
  });
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

const carriedExtensions = async (
  ctx: Context,
  previous: GitIndex | undefined,
  entries: ReadonlyArray<IndexEntry>,
  kind: IndexWriteKind,
  options: CommitOptions,
): Promise<ReadonlyArray<IndexExtension>> => {
  // Stryker disable next-line ConditionalExpression: equivalent — carryExtensions over no extensions yields [] too; the guard only skips the O(n) entry diff.
  if (previous === undefined || previous.extensions.length === 0) return [];
  const diff = diffIndexEntries(previous.entries, entries);
  const change = withRestagedPaths(diff, options.restagedPaths ?? []);
  return carryExtensions(previous.extensions, change, kind, await carrySettings(ctx));
};

const carrySettings = async (ctx: Context): Promise<CarrySettings> => ({
  untrackedCache: (await readConfig(ctx)).core?.untrackedCache,
  digestLength: ctx.hashConfig.digestLength,
});

const withRefreshedStat = (
  read: GitIndex,
  refreshed: ReadonlyArray<IndexEntry>,
): ReadonlyArray<IndexEntry> => {
  const byPath = new Map(refreshed.map((entry) => [entry.path, entry]));
  return read.entries.map((entry) =>
    entry.flags.stage === 0 ? (byPath.get(entry.path) ?? entry) : entry,
  );
};

const stageLock = async (
  ctx: Context,
  lockPath: string,
  entries: ReadonlyArray<IndexEntry>,
  extensions: ReadonlyArray<IndexExtension>,
): Promise<void> => {
  const body = serializeIndex(
    { version: 2, entries: [...entries], extensions, trailerSha: new Uint8Array(0) },
    ctx.hashConfig.digestLength,
  );
  const checksum = await ctx.hash.hash(body);
  const bytes = new Uint8Array(body.length + checksum.length);
  bytes.set(body, 0);
  bytes.set(checksum, body.length);
  await ctx.fs.write(lockPath, bytes);
};

const publishLock = async (ctx: Context, lockPath: string, indexFile: string): Promise<void> => {
  await ctx.fs.rename(lockPath, indexFile);
  // Drop the cached readIndex entry unconditionally — a same-tick write
  // can have a stat identical to what was cached, and the cache must
  // never serve a stale read of our own commit.
  invalidateIndexCache(ctx);
};

const writeLocked = async (
  ctx: Context,
  lockPath: string,
  indexFile: string,
  entries: ReadonlyArray<IndexEntry>,
  extensions: ReadonlyArray<IndexExtension>,
): Promise<void> => {
  await stageLock(ctx, lockPath, entries, extensions);
  await publishLock(ctx, lockPath, indexFile);
};

/** A refresh-write failure, tagged with the path the failing operation targeted. */
class RefreshSiteFailure {
  constructor(
    readonly path: string,
    readonly cause: unknown,
  ) {}
}

const atSite = async <T>(path: string, operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (err) {
    throw new RefreshSiteFailure(path, err);
  }
};

interface RefreshSites {
  readonly lockPath: string;
  readonly indexFile: string;
}

const carriedOnRefresh = async (
  ctx: Context,
  previous: GitIndex,
): Promise<ReadonlyArray<IndexExtension>> =>
  carryExtensions(previous.extensions, NO_INDEX_CHANGE, 'refresh', await carrySettings(ctx));

/** The index as read with the refreshed stats, racily-clean entries smudged against `previous`. */
const stagedRefresh = (
  ctx: Context,
  {
    read,
    refreshed,
    previous,
    verified,
  }: {
    readonly read: GitIndex;
    readonly refreshed: ReadonlyArray<IndexEntry>;
    readonly previous: GitIndex;
    readonly verified: IsVerified;
  },
): Promise<ReadonlyArray<IndexEntry>> =>
  smudgeRacilyClean(ctx, withRefreshedStat(read, refreshed), previous, verified);

/** Resolves `false` when the index moved on disk since `read`; the caller releases the lock. */
const writeRefreshed = async (
  ctx: Context,
  sites: RefreshSites,
  read: GitIndex,
  refreshed: ReadonlyArray<IndexEntry>,
  verified: IsVerified,
): Promise<boolean> => {
  const previous = await atSite(sites.indexFile, () => readPreviousIndex(ctx));
  if (previous === undefined || !bytesEqual(previous.trailerSha, read.trailerSha)) return false;
  const extensions = await carriedOnRefresh(ctx, previous);
  const entries = await stagedRefresh(ctx, { read, refreshed, previous, verified });
  await atSite(sites.lockPath, () => stageLock(ctx, sites.lockPath, entries, extensions));
  await atSite(sites.indexFile, () => publishLock(ctx, sites.lockPath, sites.indexFile));
  return true;
};

/** What the lock has become: committed to the index, or dropped. Either ends its use. */
interface LockState {
  committed: boolean;
  released: boolean;
}

const isSpent = (state: LockState): boolean => state.committed || state.released;

const releaseLock = async (ctx: Context, sites: RefreshSites, state: LockState): Promise<void> => {
  if (isSpent(state)) return;
  state.released = true;
  try {
    await ctx.fs.rm(sites.lockPath);
  } catch (err) {
    // Already gone — fine.
    if (!(err instanceof TsgitError) || err.data.code !== 'FILE_NOT_FOUND') throw err;
  }
};

const commitLocked = async (
  ctx: Context,
  sites: RefreshSites,
  state: LockState,
  entries: ReadonlyArray<IndexEntry>,
  kind: IndexWriteKind,
  options: CommitOptions,
): Promise<void> => {
  if (isSpent(state)) return;
  const previous = await readPreviousIndex(ctx);
  const smudged = await smudgeRacilyClean(ctx, entries, previous);
  const extensions = await carriedExtensions(ctx, previous, smudged, kind, options);
  await writeLocked(ctx, sites.lockPath, sites.indexFile, smudged, extensions);
  state.committed = true;
};

const commitRefreshed = async (
  ctx: Context,
  sites: RefreshSites,
  state: LockState,
  read: GitIndex,
  refreshed: ReadonlyArray<IndexEntry>,
  verified: IsVerified,
): Promise<boolean> => {
  if (isSpent(state)) return false;
  try {
    state.committed = await writeRefreshed(ctx, sites, read, refreshed, verified);
  } catch (err) {
    if (!(err instanceof RefreshSiteFailure)) throw err;
    await releaseLock(ctx, sites, state);
    reportDegrade(ctx, err.cause, err.path);
    return false;
  }
  await releaseLock(ctx, sites, state);
  return state.committed;
};

const makeLock = (ctx: Context, lockPath: string, indexFile: string): IndexLock => {
  const sites: RefreshSites = { lockPath, indexFile };
  const state: LockState = { committed: false, released: false };
  return {
    release: () => releaseLock(ctx, sites, state),
    commit: (entries, kind, options = {}) =>
      commitLocked(ctx, sites, state, entries, kind, options),
    commitRefresh: (read, refreshed, verified) =>
      commitRefreshed(ctx, sites, state, read, refreshed, verified),
  };
};
