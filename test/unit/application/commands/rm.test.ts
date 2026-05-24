import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { rm } from '../../../../src/application/commands/rm.js';
import { fileNotFound, TsgitError } from '../../../../src/domain/index.js';
import { seedRepo } from './fixtures.js';

const seedAndStage = async (workingTree: Readonly<Record<string, string>>) => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree });
  await add(ctx, Object.keys(workingTree));
  return ctx;
};

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

describe('rm', () => {
  describe('Given an empty pathspec', () => {
    describe('When rm', () => {
      it('Then throws EMPTY_PATHSPEC', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        // Assert
        await expectError(() => rm(ctx, []), 'EMPTY_PATHSPEC');
      });
    });
  });

  describe('Given a tracked file', () => {
    describe('When rm', () => {
      it('Then result.removed lists it and the file is deleted', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act
        const sut = await rm(ctx, ['a.txt']);

        // Assert
        expect(sut.removed).toEqual(['a.txt']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(false);
      });
    });
  });

  describe('Given cached=true', () => {
    describe('When rm', () => {
      it('Then index entry removed but working file kept', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act
        await rm(ctx, ['a.txt'], { cached: true });

        // Assert
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(true);
      });
    });
  });

  describe('Given an untracked path', () => {
    describe('When rm', () => {
      it('Then throws PATHSPEC_NO_MATCH', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        // Assert
        await expectError(() => rm(ctx, ['ghost.txt']), 'PATHSPEC_NO_MATCH');
      });
    });
  });

  describe('Given a glob "*.log" with two matching tracked files', () => {
    describe('When rm', () => {
      it('Then both are removed (no PATHSPEC_NO_MATCH for globs)', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.log': 'a', 'b.log': 'b', 'keep.ts': 'k' });

        // Act
        const sut = await rm(ctx, ['*.log']);

        // Assert
        expect([...sut.removed].sort()).toEqual(['a.log', 'b.log']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/keep.ts`)).toBe(true);
      });
    });
  });

  describe('Given a glob "*.nope" with no matches', () => {
    describe('When rm', () => {
      it('Then returns removed=[] without throwing', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act
        const sut = await rm(ctx, ['*.nope']);

        // Assert — glob no-match is a no-op, not an error (Git semantics).
        expect(sut.removed).toEqual([]);
      });
    });
  });

  describe('Given a glob + a `!`-negation', () => {
    describe('When rm', () => {
      it('Then negated paths stay in the index', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.log': 'a', 'keep.log': 'k', 'b.log': 'b' });

        // Act
        const sut = await rm(ctx, ['*.log', '!keep.log']);

        // Assert
        expect([...sut.removed].sort()).toEqual(['a.log', 'b.log']);
        expect(await ctx.fs.exists(`${ctx.layout.workDir}/keep.log`)).toBe(true);
      });
    });
  });

  describe('Given a bare repo', () => {
    describe('When rm', () => {
      it('Then throws BARE_REPOSITORY tagged with operation "rm"', async () => {
        // Arrange — fresh ctx with bare=true config seeded BEFORE any read.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

        // Act
        const err = await expectError(() => rm(ctx, ['a.txt']), 'BARE_REPOSITORY');

        // Assert — the operation label travels with the error (kills `'rm'` -> `''`).
        if (err.data.code !== 'BARE_REPOSITORY') throw new Error('unexpected error shape');
        expect(err.data.operation).toBe('rm');
        expect(err.message).toBe('BARE_REPOSITORY: operation requires a working tree: rm');
      });
    });
  });

  describe('Given a corrupt index (INVALID_INDEX_HEADER) and a glob', () => {
    describe('When rm', () => {
      it('Then the parse error is tolerated and removed is empty', async () => {
        // Arrange — an index file shorter than the hash trailer makes readIndex
        // throw INVALID_INDEX_HEADER. rm tolerates it via INDEX_MISSING_CODES.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, new Uint8Array([1, 2, 3]));

        // Act — glob never triggers PATHSPEC_NO_MATCH, so the only path to a throw
        // is rm re-throwing the parse error (which it must NOT do).
        const sut = await rm(ctx, ['*.nope']);

        // Assert — kills `'INVALID_INDEX_HEADER'` -> `''` in INDEX_MISSING_CODES.
        expect(sut.removed).toEqual([]);
      });
    });
  });

  describe('Given a corrupt index (INVALID_INDEX_ENTRY) and a glob', () => {
    describe('When rm', () => {
      it('Then the parse error is tolerated and removed is empty', async () => {
        // Arrange — checksum-valid index whose single entry has no NUL terminator,
        // so parseIndex throws INVALID_INDEX_ENTRY (reached only after the checksum
        // passes).
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const payload = new Uint8Array(12 + 62 + 100);
        const view = new DataView(payload.buffer);
        view.setUint32(0, 0x44495243); // 'DIRC'
        view.setUint32(4, 2); // version 2
        view.setUint32(8, 1); // 1 entry
        view.setUint32(12 + 24, 0o100644); // entry mode
        view.setUint16(12 + 60, 5); // declared path length
        payload.fill(0x78, 12 + 62); // garbage path bytes, no NUL terminator
        const checksum = await ctx.hash.hash(payload);
        const indexBytes = new Uint8Array(payload.length + checksum.length);
        indexBytes.set(payload, 0);
        indexBytes.set(checksum, payload.length);
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, indexBytes);

        // Act
        const sut = await rm(ctx, ['*.nope']);

        // Assert — kills `'INVALID_INDEX_ENTRY'` -> `''` in INDEX_MISSING_CODES.
        expect(sut.removed).toEqual([]);
      });
    });
  });

  describe('Given readIndex stat racing to FILE_NOT_FOUND and a glob', () => {
    describe('When rm', () => {
      it('Then the error is tolerated and removed is empty', async () => {
        // Arrange — index file exists (so readIndex passes the exists() guard) but
        // ctx.fs.stat throws FILE_NOT_FOUND, simulating the file vanishing between
        // exists() and stat(). readIndex propagates FILE_NOT_FOUND.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, new Uint8Array(32));
        const indexFile = `${ctx.layout.gitDir}/index`;
        const racingCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (path: string) => {
              if (path === indexFile) throw fileNotFound(indexFile);
              return ctx.fs.stat(path);
            },
          },
        };

        // Act
        const sut = await rm(racingCtx, ['*.nope']);

        // Assert — kills `'FILE_NOT_FOUND'` -> `''` in INDEX_MISSING_CODES.
        expect(sut.removed).toEqual([]);
      });
    });
  });

  describe('Given a non-INDEX_MISSING readIndex error', () => {
    describe('When rm', () => {
      it('Then the error propagates (not silently tolerated)', async () => {
        // Arrange — make readIndex throw a code that is NOT in INDEX_MISSING_CODES.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, new Uint8Array(32));
        const indexFile = `${ctx.layout.gitDir}/index`;
        const failingCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (path: string) => {
              if (path === indexFile) {
                throw new TsgitError({ code: 'PERMISSION_DENIED', path: indexFile });
              }
              return ctx.fs.stat(path);
            },
          },
        };

        // Act / Assert — kills the L52 ConditionalExpression mutants: a `true`
        // mutant would swallow this, a `false` mutant would swallow nothing — and
        // this branch must re-throw PERMISSION_DENIED specifically because it is
        // not an INDEX_MISSING code.
        await expectError(() => rm(failingCtx, ['*.nope']), 'PERMISSION_DENIED');
      });
    });
  });

  describe('Given cached=false and a working file that vanishes during removeFile', () => {
    describe('When rm', () => {
      it('Then the FILE_NOT_FOUND race is tolerated', async () => {
        // Arrange — a tracked file whose ctx.fs.rm throws FILE_NOT_FOUND, simulating
        // the working copy disappearing mid-remove. lstat still succeeds.
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'a.txt': 'a' } });
        await add(ctx, ['a.txt']);
        const workFile = `${ctx.layout.workDir}/a.txt`;
        const racingCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rm: async (path: string) => {
              if (path === workFile) throw fileNotFound(workFile);
              return ctx.fs.rm(path);
            },
          },
        };

        // Act — must NOT throw: the removeFile catch swallows FILE_NOT_FOUND.
        const sut = await rm(racingCtx, ['a.txt']);

        // Assert — index entry still removed; kills L68 BlockStatement (an empty
        // catch would swallow everything) and L69 ConditionalExpression `-> false`
        // (which would re-throw FILE_NOT_FOUND).
        expect(sut.removed).toEqual(['a.txt']);
      });
    });
  });

  describe('Given cached=false and a missing working file (CHECKOUT_OVERWRITE_DIRTY)', () => {
    describe('When rm', () => {
      it('Then the error propagates', async () => {
        // Arrange — a tracked file already deleted from the working tree. removeFile
        // sees the missing file and throws CHECKOUT_OVERWRITE_DIRTY, NOT FILE_NOT_FOUND.
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'a.txt': 'a' } });
        await add(ctx, ['a.txt']);
        await ctx.fs.rm(`${ctx.layout.workDir}/a.txt`);

        // Act / Assert — the removeFile catch must re-throw any non-FILE_NOT_FOUND
        // error. Kills L69 EqualityOperator `=== ` -> `!==` (which would swallow
        // CHECKOUT_OVERWRITE_DIRTY) and the `-> true` ConditionalExpression mutant.
        const err = await expectError(() => rm(ctx, ['a.txt']), 'CHECKOUT_OVERWRITE_DIRTY');
        if (err.data.code !== 'CHECKOUT_OVERWRITE_DIRTY') throw new Error('unexpected error shape');
        expect(err.data.paths).toEqual(['a.txt']);
      });
    });
  });

  describe('Given breakStaleLockMs and a stale lock', () => {
    describe('When rm', () => {
      it('Then the stale lock is broken and rm succeeds', async () => {
        // Arrange — pre-create index.lock and report an ancient mtime for it, so
        // its age exceeds breakStaleLockMs. With the option threaded through,
        // acquireIndexLock breaks the stale lock and rm proceeds.
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        const lockPath = `${ctx.layout.gitDir}/index.lock`;
        await ctx.fs.writeExclusive(lockPath, new Uint8Array());
        const staleCtx = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: async (path: string) => {
              const stat = await ctx.fs.lstat(path);
              // Report epoch-0 mtime for the lock so it always reads as stale.
              return path === lockPath ? { ...stat, mtimeMs: 0 } : stat;
            },
          },
        };

        // Act — kills L48 ObjectLiteral `-> {}`: with `{}` breakStaleLockMs is
        // dropped, the lock is never broken, and rm throws RESOURCE_LOCKED instead.
        const sut = await rm(staleCtx, ['a.txt'], { breakStaleLockMs: 1 });

        // Assert — the option was threaded through; the stale lock was broken.
        expect(sut.removed).toEqual(['a.txt']);
      });
    });
  });

  describe('Given no breakStaleLockMs and a held lock', () => {
    describe('When rm', () => {
      it('Then it surfaces RESOURCE_LOCKED', async () => {
        // Arrange — pre-create index.lock with no breakStaleLockMs option.
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        await ctx.fs.writeExclusive(`${ctx.layout.gitDir}/index.lock`, new Uint8Array());

        // Act / Assert — baseline: without the option a contended lock is fatal.
        const err = await expectError(() => rm(ctx, ['a.txt']), 'RESOURCE_LOCKED');
        if (err.data.code !== 'RESOURCE_LOCKED') throw new Error('unexpected error shape');
        expect(err.data.resource).toBe('index');
      });
    });
  });

  describe('Given a successful rm', () => {
    describe('When it completes', () => {
      it('Then the index lock is released (a second rm is not RESOURCE_LOCKED)', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a', 'b.txt': 'b' });

        // Act — first rm acquires the lock; commit() consumes it.
        await rm(ctx, ['a.txt']);
        // A second rm would throw RESOURCE_LOCKED if the lock were not released.
        const sut = await rm(ctx, ['b.txt']);

        // Assert — the lock file is gone after a successful rm.
        expect(sut.removed).toEqual(['b.txt']);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
      });
    });
  });

  describe('Given a rm that throws PATHSPEC_NO_MATCH before commit', () => {
    describe('When it rejects', () => {
      it('Then the finally block still releases the lock', async () => {
        // Arrange — `commit()` consumes the lock on the happy path, so a successful
        // rm cannot prove the `finally` release runs. Force a failure AFTER the
        // lock is acquired but BEFORE commit: an unmatched literal makes
        // enforceLiteralMustMatch throw, leaving the lock un-consumed. Only the
        // `finally` block can drop it.
        const ctx = await seedAndStage({ 'a.txt': 'a', 'b.txt': 'b' });

        // Act — first rm acquires the lock then rejects pre-commit.
        await expectError(() => rm(ctx, ['ghost.txt']), 'PATHSPEC_NO_MATCH');

        // Assert — the lock was released by `finally`; the file is gone and a
        // follow-up rm succeeds instead of throwing RESOURCE_LOCKED. Kills L76
        // BlockStatement `-> {}` (an empty `finally` leaks the un-committed lock).
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
        const sut = await rm(ctx, ['b.txt']);
        expect(sut.removed).toEqual(['b.txt']);
      });
    });
  });
});
