import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { acquireIndexLock } from '../../../../../src/application/commands/internal/index-update.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const indexPath = (ctx: Context): string => `${ctx.config.gitDir}/index`;
const lockPath = (ctx: Context): string => `${indexPath(ctx)}.lock`;

const expectError = async (fn: () => Promise<unknown>, code: string): Promise<TsgitError> => {
  let caught: unknown;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TsgitError);
  expect((caught as TsgitError).data.code).toBe(code);
  return caught as TsgitError;
};

describe('internal/index-update', () => {
  it('Given no existing lock, When acquireIndexLock, Then returns a lock with release/commit', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act
    const sut = await acquireIndexLock(ctx);

    // Assert
    expect(typeof sut.release).toBe('function');
    expect(typeof sut.commit).toBe('function');
    expect(await ctx.fs.exists(lockPath(ctx))).toBe(true);
    await sut.release();
  });

  it('Given a lock file already present, When acquireIndexLock without breakStaleLockMs, Then throws RESOURCE_LOCKED', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));

    // Act + Assert
    await expectError(() => acquireIndexLock(ctx), 'RESOURCE_LOCKED');
  });

  it('Given a stale lock older than breakStaleLockMs, When acquireIndexLock, Then breaks + retries + succeeds', async () => {
    // Arrange — write the lock, then move time forward via mtime manipulation by spying.
    const ctx = createMemoryContext();
    await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));
    // Memory FS sets mtime=now; emulate "old" by injecting a now() that says we are far in the future.
    const now = () => Date.now() + 60_000;

    // Act
    const sut = await acquireIndexLock(ctx, { breakStaleLockMs: 1000, now });

    // Assert
    expect(await ctx.fs.exists(lockPath(ctx))).toBe(true);
    await sut.release();
  });

  it('Given a lock with mtime in the future (clock skew), When acquireIndexLock with breakStaleLockMs, Then does NOT break (RESOURCE_LOCKED)', async () => {
    // Arrange
    const ctx = createMemoryContext();
    await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));
    // now() in the past makes mtime appear "in the future" relative to it.
    const now = () => Date.now() - 60_000;

    // Act + Assert
    await expectError(
      () => acquireIndexLock(ctx, { breakStaleLockMs: 1000, now }),
      'RESOURCE_LOCKED',
    );
  });

  it('Given a held lock, When commit(entries=[]) is called, Then index file is updated and lock is gone', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const sut = await acquireIndexLock(ctx);

    // Act
    await sut.commit([]);

    // Assert
    expect(await ctx.fs.exists(lockPath(ctx))).toBe(false);
    expect(await ctx.fs.exists(indexPath(ctx))).toBe(true);
  });

  it('Given a held lock + commit, When release is called after commit, Then it is a no-op', async () => {
    // Arrange
    const ctx = createMemoryContext();
    const sut = await acquireIndexLock(ctx);
    await sut.commit([]);

    // Act + Assert — must not throw.
    await sut.release();
    expect(await ctx.fs.exists(lockPath(ctx))).toBe(false);
  });

  it('Given a held lock without commit, When release is called, Then lock file is removed; index unchanged', async () => {
    // Arrange — write a sentinel index and verify the release leaves it intact.
    const ctx = createMemoryContext();
    const sentinel = new Uint8Array([1, 2, 3, 4]);
    await ctx.fs.write(indexPath(ctx), sentinel);
    const sut = await acquireIndexLock(ctx);

    // Act
    await sut.release();

    // Assert
    expect(await ctx.fs.exists(lockPath(ctx))).toBe(false);
    const onDisk = await ctx.fs.read(indexPath(ctx));
    expect(onDisk).toEqual(sentinel);
  });

  it('Given a lock with mtime exactly EQUAL to breakStaleLockMs, When acquireIndexLock, Then breaks (boundary: age >= threshold)', async () => {
    // Arrange — kills `age < breakStaleLockMs` boundary mutants by hitting age == threshold.
    const ctx = createMemoryContext();
    await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));
    const mtime = (await ctx.fs.lstat(lockPath(ctx))).mtimeMs;
    // now() exactly threshold ms ahead of mtime → age == threshold → break.
    const now = () => mtime + 1000;

    // Act
    const sut = await acquireIndexLock(ctx, { breakStaleLockMs: 1000, now });

    // Assert — the lock was broken and re-acquired.
    expect(await ctx.fs.exists(lockPath(ctx))).toBe(true);
    await sut.release();
  });

  it('Given a lock with mtime ALMOST at threshold, When acquireIndexLock, Then does NOT break (anti-boundary: age < threshold)', async () => {
    // Arrange — kills `age < breakStaleLockMs` direction mutants.
    const ctx = createMemoryContext();
    await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));
    const mtime = (await ctx.fs.lstat(lockPath(ctx))).mtimeMs;
    const now = () => mtime + 999; // 1 ms below threshold

    // Act + Assert
    await expectError(
      () => acquireIndexLock(ctx, { breakStaleLockMs: 1000, now }),
      'RESOURCE_LOCKED',
    );
  });

  it('Given commit then a second commit on the same lock object, When commit is called twice, Then the second is a no-op (post-commit guard)', async () => {
    // Arrange — kills the `if (committed || released) return;` guard mutants.
    const ctx = createMemoryContext();
    const lock = await acquireIndexLock(ctx);
    await lock.commit([]);

    // Act + Assert — second commit should not re-write the index or throw.
    await lock.commit([]);
  });

  it('Given release then release on the same lock object, When release is called twice, Then second is a no-op', async () => {
    const ctx = createMemoryContext();
    const lock = await acquireIndexLock(ctx);

    await lock.release();
    await lock.release();
  });

  it('Given two concurrent acquireIndexLock calls, When both started, Then exactly one wins', async () => {
    // Arrange
    const ctx = createMemoryContext();

    // Act — race two acquires.
    const results = await Promise.allSettled([acquireIndexLock(ctx), acquireIndexLock(ctx)]);

    // Assert — exactly one resolves, the other rejects with RESOURCE_LOCKED.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as TsgitError;
    expect(reason.data.code).toBe('RESOURCE_LOCKED');
    if (fulfilled[0]?.status === 'fulfilled') await fulfilled[0].value.release();
  });
});
