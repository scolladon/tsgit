import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { acquireIndexLock } from '../../../../../src/application/commands/internal/index-update.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { FileStat } from '../../../../../src/ports/file-system.js';

const indexPath = (ctx: Context): string => `${ctx.layout.gitDir}/index`;
const lockPath = (ctx: Context): string => `${indexPath(ctx)}.lock`;

/**
 * Set the repo-wide stale-lock break window (environment policy on `ctx.config`,
 * the only place `acquireIndexLock` reads it from). Shares the original `fs` and
 * `layout`, so assertions on the source `ctx` observe the same lock file.
 */
const withWindow = (ctx: Context, breakStaleLockMs: number): Context => ({
  ...ctx,
  config: { ...ctx.config, breakStaleLockMs },
});

/** A FileStat with an arbitrary mtime — used to simulate a stale lock for break tests. */
const statWithMtime = (mtimeMs: number): FileStat => ({
  ctimeMs: mtimeMs,
  mtimeMs,
  dev: 0,
  ino: 0,
  mode: 0o100644,
  uid: 0,
  gid: 0,
  size: 0,
  isFile: true,
  isDirectory: false,
  isSymbolicLink: false,
});

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

const expectThrows = async (fn: () => Promise<unknown>): Promise<unknown> => {
  let caught: unknown;
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    caught = err;
  }
  expect(threw).toBe(true);
  return caught;
};

describe('internal/index-update', () => {
  describe('Given no existing lock', () => {
    describe('When acquireIndexLock', () => {
      it('Then returns a lock with release/commit', async () => {
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
    });
  });

  describe('Given a lock file already present', () => {
    describe('When acquireIndexLock without breakStaleLockMs', () => {
      it('Then throws RESOURCE_LOCKED', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));

        // Act + Assert
        await expectError(() => acquireIndexLock(ctx), 'RESOURCE_LOCKED');
      });
    });
  });

  describe('Given a stale lock older than breakStaleLockMs', () => {
    describe('When acquireIndexLock', () => {
      it('Then breaks + retries + succeeds', async () => {
        // Arrange — write the lock, then move time forward via mtime manipulation by spying.
        const ctx = createMemoryContext();
        await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));
        // Memory FS sets mtime=now; emulate "old" by injecting a now() that says we are far in the future.
        const now = () => Date.now() + 60_000;

        // Act
        const sut = await acquireIndexLock(withWindow(ctx, 1000), { now });

        // Assert
        expect(await ctx.fs.exists(lockPath(ctx))).toBe(true);
        await sut.release();
      });
    });
  });

  describe('Given a lock with mtime in the future (clock skew)', () => {
    describe('When acquireIndexLock with breakStaleLockMs', () => {
      it('Then does NOT break (RESOURCE_LOCKED)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));
        // now() in the past makes mtime appear "in the future" relative to it.
        const now = () => Date.now() - 60_000;

        // Act + Assert
        await expectError(
          () => acquireIndexLock(withWindow(ctx, 1000), { now }),
          'RESOURCE_LOCKED',
        );
      });
    });
  });

  describe('Given a held lock', () => {
    describe('When commit(entries=[]) is called', () => {
      it('Then index file is updated and lock is gone', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = await acquireIndexLock(ctx);

        // Act
        await sut.commit([]);

        // Assert
        expect(await ctx.fs.exists(lockPath(ctx))).toBe(false);
        expect(await ctx.fs.exists(indexPath(ctx))).toBe(true);
      });
    });
  });

  describe('Given a held lock + commit', () => {
    describe('When release is called after commit', () => {
      it('Then it is a no-op', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = await acquireIndexLock(ctx);
        await sut.commit([]);

        // Act + Assert — must not throw.
        await sut.release();
        // Assert
        expect(await ctx.fs.exists(lockPath(ctx))).toBe(false);
      });
    });
  });

  describe('Given a held lock without commit', () => {
    describe('When release is called', () => {
      it('Then lock file is removed; index unchanged', async () => {
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
    });
  });

  describe('Given a lock with mtime exactly EQUAL to breakStaleLockMs', () => {
    describe('When acquireIndexLock', () => {
      it('Then breaks (boundary: age >= threshold)', async () => {
        // Arrange — kills `age < breakStaleLockMs` boundary mutants by hitting age == threshold.
        const ctx = createMemoryContext();
        await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));
        const mtime = (await ctx.fs.lstat(lockPath(ctx))).mtimeMs;
        // now() exactly threshold ms ahead of mtime → age == threshold → break.
        const now = () => mtime + 1000;

        // Act
        const sut = await acquireIndexLock(withWindow(ctx, 1000), { now });

        // Assert — the lock was broken and re-acquired.
        expect(await ctx.fs.exists(lockPath(ctx))).toBe(true);
        await sut.release();
      });
    });
  });

  describe('Given a lock with mtime ALMOST at threshold', () => {
    describe('When acquireIndexLock', () => {
      it('Then does NOT break (anti-boundary: age < threshold)', async () => {
        // Arrange — kills `age < breakStaleLockMs` direction mutants.
        const ctx = createMemoryContext();
        await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));
        const mtime = (await ctx.fs.lstat(lockPath(ctx))).mtimeMs;
        const now = () => mtime + 999; // 1 ms below threshold

        // Act + Assert
        await expectError(
          () => acquireIndexLock(withWindow(ctx, 1000), { now }),
          'RESOURCE_LOCKED',
        );
      });
    });
  });

  describe('Given a stale lock and ctx.config.breakStaleLockMs with no per-call option', () => {
    describe('When acquireIndexLock', () => {
      it('Then the config window drives the break', async () => {
        // Arrange — the policy lives on ctx.config; opts carries only the clock.
        // A far-future now() makes the lock stale under the config window.
        const base = createMemoryContext();
        const ctx: Context = { ...base, config: { breakStaleLockMs: 1000 } };
        await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));
        const now = (): number => Date.now() + 60_000;

        // Act
        const sut = await acquireIndexLock(ctx, { now });

        // Assert — broken + re-acquired, not RESOURCE_LOCKED.
        expect(await ctx.fs.exists(lockPath(ctx))).toBe(true);
        await sut.release();
      });
    });
  });

  describe('Given commit then a second commit on the same lock object', () => {
    describe('When commit is called twice', () => {
      it('Then the second is a no-op (post-commit guard)', async () => {
        // Arrange — kills the `if (committed || released) return;` guard mutants.
        const ctx = createMemoryContext();
        const lock = await acquireIndexLock(ctx);
        await lock.commit([]);

        // Act + Assert — second commit should not re-write the index or throw.
        await expect(lock.commit([])).resolves.toBeUndefined();
      });
    });
  });

  describe('Given release then release on the same lock object', () => {
    describe('When release is called twice', () => {
      it('Then second is a no-op', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const lock = await acquireIndexLock(ctx);

        await lock.release();
        // Assert
        await expect(lock.release()).resolves.toBeUndefined();
      });
    });
  });

  describe('Given two concurrent acquireIndexLock calls', () => {
    describe('When both started', () => {
      it('Then exactly one wins', async () => {
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
  });

  describe('Given writeExclusive throws a non-TsgitError', () => {
    describe('When acquireIndexLock', () => {
      it('Then that exact error is rethrown', async () => {
        // Arrange — kills the `!(err instanceof TsgitError)` operand: a plain Error must
        // rethrow verbatim, not be treated as a lock-contention TsgitError.
        const base = createMemoryContext();
        const boom = new Error('boom');
        const writeExclusive = async (): Promise<void> => {
          throw boom;
        };
        const ctx: Context = { ...base, fs: { ...base.fs, writeExclusive } };

        // Act
        const caught = await expectThrows(() => acquireIndexLock(ctx));

        // Assert — the original plain Error, not a TsgitError nor a TypeError.
        expect(caught).toBe(boom);
        expect((caught as Error).message).toBe('boom');
      });
    });
  });

  describe('Given writeExclusive throws a TsgitError that is not FILE_EXISTS', () => {
    describe('When acquireIndexLock', () => {
      it('Then it is rethrown', async () => {
        // Arrange — kills the `err.data.code !== 'FILE_EXISTS'` operand: a non-FILE_EXISTS
        // TsgitError must rethrow, never be swallowed into a successful lock acquisition.
        const base = createMemoryContext();
        const denied = new TsgitError({ code: 'PERMISSION_DENIED', path: lockPath(base) });
        const writeExclusive = async (): Promise<void> => {
          throw denied;
        };
        const ctx: Context = { ...base, fs: { ...base.fs, writeExclusive } };

        // Act + Assert
        const caught = await expectError(() => acquireIndexLock(ctx), 'PERMISSION_DENIED');
        expect(caught).toBe(denied);
      });
    });
  });

  describe('Given backward clock skew with a negative breakStaleLockMs (age above threshold)', () => {
    describe('When acquireIndexLock', () => {
      it('Then the skew guard still refuses to break', async () => {
        // Arrange — kills `age < 0` (the clock-skew guard). With a negative threshold and a
        // negative age above it, the `age < breakStaleLockMs` check alone would break the lock;
        // only the dedicated `age < 0` guard keeps RESOURCE_LOCKED.
        const ctx = createMemoryContext();
        await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));
        const mtime = (await ctx.fs.lstat(lockPath(ctx))).mtimeMs;
        const now = (): number => mtime - 50; // age = -50, above threshold -100

        // Act + Assert — clock-skew guard fires before the threshold comparison.
        const caught = await expectError(
          () => acquireIndexLock(withWindow(ctx, -100), { now }),
          'RESOURCE_LOCKED',
        );
        expect(caught.data).toMatchObject({ resource: 'index', mtimeMs: mtime });
      });
    });
  });

  describe('Given a lock whose age is exactly zero with breakStaleLockMs zero', () => {
    describe('When acquireIndexLock', () => {
      it('Then it is treated as non-skewed and broken', async () => {
        // Arrange — kills the `age <= 0` mutant. age == 0 must NOT count as backward skew;
        // with a zero threshold the lock is stale and gets broken + re-acquired.
        const ctx = createMemoryContext();
        await ctx.fs.write(lockPath(ctx), new Uint8Array([1]));
        const mtime = (await ctx.fs.lstat(lockPath(ctx))).mtimeMs;
        const now = (): number => mtime; // age = 0 exactly

        // Act
        const sut = await acquireIndexLock(withWindow(ctx, 0), { now });

        // Assert — succeeded (broken), not rejected as clock skew.
        expect(await ctx.fs.exists(lockPath(ctx))).toBe(true);
        await sut.release();
      });
    });
  });

  describe('Given a held lock', () => {
    describe('When release is called twice', () => {
      it('Then the underlying rm runs exactly once', async () => {
        // Arrange — kills the `released` guard + `released = true` assignment in release().
        const ctx = createMemoryContext();
        const rmSpy = vi.spyOn(ctx.fs, 'rm');
        const sut = await acquireIndexLock(ctx);

        // Act
        await sut.release();
        await sut.release();

        // Assert — second release short-circuits; rm is not invoked again.
        expect(rmSpy).toHaveBeenCalledTimes(1);
        expect(rmSpy).toHaveBeenCalledWith(lockPath(ctx));
      });
    });
  });

  describe('Given a committed lock', () => {
    describe('When release is called', () => {
      it('Then rm is never invoked (committed guard)', async () => {
        // Arrange — kills the `committed` operand of the release guard, the `||`→`&&`
        // logical mutant, and the `committed = true` assignment in commit().
        const ctx = createMemoryContext();
        const sut = await acquireIndexLock(ctx);
        await sut.commit([]);
        const rmSpy = vi.spyOn(ctx.fs, 'rm');

        // Act
        await sut.release();

        // Assert — commit already consumed the lock; release must not touch the filesystem.
        expect(rmSpy).not.toHaveBeenCalled();
      });
    });
    describe('When commit is called again', () => {
      it('Then rename is not invoked a second time', async () => {
        // Arrange — kills the `committed` operand + `||`→`&&` mutant of the commit guard
        // and the `committed = true` assignment.
        const ctx = createMemoryContext();
        const sut = await acquireIndexLock(ctx);
        await sut.commit([]);
        const renameSpy = vi.spyOn(ctx.fs, 'rename');

        // Act
        await sut.commit([]);

        // Assert — the second commit short-circuits before rewriting the index.
        expect(renameSpy).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a released lock', () => {
    describe('When commit is called', () => {
      it('Then no index file is written (released guard)', async () => {
        // Arrange — kills the `released` operand + `||`→`&&` mutant of the commit guard
        // and the `released = true` assignment.
        const ctx = createMemoryContext();
        const sut = await acquireIndexLock(ctx);
        await sut.release();

        // Act
        await sut.commit([]);

        // Assert — release already dropped the lock; commit must not resurrect an index.
        expect(await ctx.fs.exists(indexPath(ctx))).toBe(false);
      });
    });
  });

  describe('Given rm throws a non-TsgitError during release', () => {
    describe('When release is called', () => {
      it('Then that exact error is rethrown', async () => {
        // Arrange — kills the release-catch BlockStatement and the `!(err instanceof TsgitError)`
        // operand: a plain Error escaping rm must propagate, not be swallowed.
        const base = createMemoryContext();
        const boom = new Error('rm-failed');
        const rm = async (): Promise<void> => {
          throw boom;
        };
        const ctx: Context = { ...base, fs: { ...base.fs, rm } };
        const sut = await acquireIndexLock(ctx);

        // Act
        const caught = await expectThrows(() => sut.release());

        // Assert
        expect(caught).toBe(boom);
        expect((caught as Error).message).toBe('rm-failed');
      });
    });
  });

  describe('Given rm throws a non-FILE_NOT_FOUND TsgitError during release', () => {
    describe('When release is called', () => {
      it('Then it is rethrown', async () => {
        // Arrange — kills the `err.data.code !== 'FILE_NOT_FOUND'` operand: only a genuine
        // FILE_NOT_FOUND is "already gone"; any other TsgitError must surface.
        const base = createMemoryContext();
        const denied = new TsgitError({ code: 'PERMISSION_DENIED', path: lockPath(base) });
        const rm = async (): Promise<void> => {
          throw denied;
        };
        const ctx: Context = { ...base, fs: { ...base.fs, rm } };
        const sut = await acquireIndexLock(ctx);

        // Act + Assert
        const caught = await expectError(() => sut.release(), 'PERMISSION_DENIED');
        expect(caught).toBe(denied);
      });
    });
  });

  describe('Given rm throws FILE_NOT_FOUND during release', () => {
    describe('When release is called', () => {
      it('Then it is swallowed', async () => {
        // Arrange — covers the FILE_NOT_FOUND === arm: a missing lock file is benign.
        const base = createMemoryContext();
        const rm = async (): Promise<void> => {
          throw new TsgitError({ code: 'FILE_NOT_FOUND', path: lockPath(base) });
        };
        const ctx: Context = { ...base, fs: { ...base.fs, rm } };
        const sut = await acquireIndexLock(ctx);

        // Act + Assert — release resolves without throwing.
        await expect(sut.release()).resolves.toBeUndefined();
      });
    });
  });

  describe('Given the retry write after breaking a stale lock fails with FILE_EXISTS', () => {
    describe('When acquireIndexLock', () => {
      it('Then RESOURCE_LOCKED surfaces', async () => {
        // Arrange — kills the maybeBreakStaleLock catch: FILE_EXISTS on the retry write must
        // be mapped to RESOURCE_LOCKED, not rethrown raw nor swallowed.
        const base = createMemoryContext();
        const lock = lockPath(base);
        let writeCalls = 0;
        const writeExclusive = async (): Promise<void> => {
          writeCalls += 1;
          throw new TsgitError({ code: 'FILE_EXISTS', path: lock });
        };
        // Stale lock far in the past so it is broken, then the retry write contends.
        const now = (): number => 10_000;
        const ctxStale: Context = {
          ...base,
          fs: {
            ...base.fs,
            writeExclusive,
            rm: async (): Promise<void> => undefined,
            lstat: async (): Promise<FileStat> => statWithMtime(0),
          },
        };

        // Act + Assert
        const caught = await expectError(
          () => acquireIndexLock(withWindow(ctxStale, 1000), { now }),
          'RESOURCE_LOCKED',
        );
        expect(writeCalls).toBe(2);
        expect(caught.data).toMatchObject({ resource: 'index' });
      });
    });
  });

  describe('Given the retry write after breaking a stale lock fails with a non-FILE_EXISTS error', () => {
    describe('When acquireIndexLock', () => {
      it('Then that error is rethrown', async () => {
        // Arrange — kills the `instanceof && code === FILE_EXISTS` condition of the
        // maybeBreakStaleLock catch: a PERMISSION_DENIED retry failure must propagate as-is.
        const base = createMemoryContext();
        const lock = lockPath(base);
        const denied = new TsgitError({ code: 'PERMISSION_DENIED', path: lock });
        let writeCalls = 0;
        const writeExclusive = async (): Promise<void> => {
          writeCalls += 1;
          if (writeCalls === 1) throw new TsgitError({ code: 'FILE_EXISTS', path: lock });
          throw denied;
        };
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            writeExclusive,
            rm: async (): Promise<void> => undefined,
            lstat: async (): Promise<FileStat> => statWithMtime(0),
          },
        };
        const now = (): number => 10_000;

        // Act + Assert
        const caught = await expectError(
          () => acquireIndexLock(withWindow(ctx, 1000), { now }),
          'PERMISSION_DENIED',
        );
        expect(caught).toBe(denied);
        expect(writeCalls).toBe(2);
      });
    });
  });
});
