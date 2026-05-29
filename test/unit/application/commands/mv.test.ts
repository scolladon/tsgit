import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { mv } from '../../../../src/application/commands/mv.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { TsgitError } from '../../../../src/domain/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { seedRepo } from './fixtures.js';

const seedAndStage = async (workingTree: Readonly<Record<string, string>>): Promise<Context> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree });
  await add(ctx, Object.keys(workingTree));
  return ctx;
};

const work = (ctx: Context, path: string): string => `${ctx.layout.workDir}/${path}`;
const exists = (ctx: Context, path: string): Promise<boolean> => ctx.fs.exists(work(ctx, path));
const readWork = (ctx: Context, path: string): Promise<string> => ctx.fs.readUtf8(work(ctx, path));

const indexEntry = async (ctx: Context, path: string) => {
  const index = await readIndex(ctx);
  return index.entries.find((entry) => entry.path === path);
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

describe('mv', () => {
  describe('Given an empty source list', () => {
    describe('When mv', () => {
      it('Then throws EMPTY_PATHSPEC', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        // Act / Assert
        await expectError(() => mv(ctx, [], 'b.txt'), 'EMPTY_PATHSPEC');
      });
    });
  });

  describe('Given a tracked file', () => {
    describe('When mv renames it', () => {
      it('Then moved lists from→to, working file moved, index repathed with same blob', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        const before = await indexEntry(ctx, 'a.txt');

        // Act
        const sut = await mv(ctx, ['a.txt'], 'b.txt');

        // Assert
        expect(sut.moved).toEqual([{ from: 'a.txt', to: 'b.txt' }]);
        expect(sut.skipped).toEqual([]);
        expect(await exists(ctx, 'a.txt')).toBe(false);
        expect(await readWork(ctx, 'b.txt')).toBe('a');
        const after = await indexEntry(ctx, 'b.txt');
        expect(after?.id).toBe(before?.id);
        expect(await indexEntry(ctx, 'a.txt')).toBeUndefined();
      });
    });
  });

  describe('Given a tracked file with an unstaged working-tree edit', () => {
    describe('When mv renames it', () => {
      it('Then the working content travels and the index keeps the staged blob (cache-entry copy)', async () => {
        // Arrange — stage 'a.txt'='committed', then edit on disk WITHOUT re-staging.
        const ctx = await seedAndStage({ 'a.txt': 'committed' });
        const staged = await indexEntry(ctx, 'a.txt');
        await ctx.fs.writeUtf8(work(ctx, 'a.txt'), 'modified-on-disk');

        // Act
        await mv(ctx, ['a.txt'], 'b.txt');

        // Assert — working file = edited bytes; index blob = the staged blob (no re-hash).
        expect(await readWork(ctx, 'b.txt')).toBe('modified-on-disk');
        const moved = await indexEntry(ctx, 'b.txt');
        expect(moved?.id).toBe(staged?.id);
      });
    });
  });

  describe('Given a single file and an existing directory destination', () => {
    describe('When mv', () => {
      it('Then the file moves into the directory keeping its basename', async () => {
        // Arrange — seed a tracked dir (via a file under it) plus the mover.
        const ctx = await seedAndStage({ 'a.txt': 'a', 'dir/keep.txt': 'k' });

        // Act
        const sut = await mv(ctx, ['a.txt'], 'dir');

        // Assert
        expect(sut.moved).toEqual([{ from: 'a.txt', to: 'dir/a.txt' }]);
        expect(await exists(ctx, 'a.txt')).toBe(false);
        expect(await readWork(ctx, 'dir/a.txt')).toBe('a');
      });
    });
  });

  describe('Given two files and an existing directory destination', () => {
    describe('When mv', () => {
      it('Then both move into the directory and moved is sorted by from', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a', 'b.txt': 'b', 'dir/keep.txt': 'k' });

        // Act
        const sut = await mv(ctx, ['b.txt', 'a.txt'], 'dir');

        // Assert
        expect(sut.moved).toEqual([
          { from: 'a.txt', to: 'dir/a.txt' },
          { from: 'b.txt', to: 'dir/b.txt' },
        ]);
        expect(await exists(ctx, 'a.txt')).toBe(false);
        expect(await exists(ctx, 'b.txt')).toBe(false);
        expect(await readWork(ctx, 'dir/a.txt')).toBe('a');
        expect(await readWork(ctx, 'dir/b.txt')).toBe('b');
      });
    });
  });

  describe('Given a tracked directory', () => {
    describe('When mv renames the directory', () => {
      it('Then every entry under it is reparented and the working subtree is moved', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'old/f.txt': '1', 'old/g.txt': '2' });

        // Act
        const sut = await mv(ctx, ['old'], 'new');

        // Assert
        expect(sut.moved).toEqual([
          { from: 'old/f.txt', to: 'new/f.txt' },
          { from: 'old/g.txt', to: 'new/g.txt' },
        ]);
        expect(await indexEntry(ctx, 'old/f.txt')).toBeUndefined();
        expect(await indexEntry(ctx, 'new/f.txt')).toBeDefined();
        expect(await readWork(ctx, 'new/g.txt')).toBe('2');
      });
    });
  });

  describe('Given a tracked directory containing an untracked file', () => {
    describe('When mv renames the directory', () => {
      it('Then the untracked file is carried by the single working-tree rename', async () => {
        // Arrange — stage only old/f.txt; old/extra.txt is untracked but on disk.
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { 'old/f.txt': '1' } });
        await add(ctx, ['old/f.txt']);
        await ctx.fs.writeUtf8(work(ctx, 'old/extra.txt'), 'x');

        // Act
        await mv(ctx, ['old'], 'new');

        // Assert
        expect(await readWork(ctx, 'new/extra.txt')).toBe('x');
        expect(await exists(ctx, 'old/extra.txt')).toBe(false);
      });
    });
  });

  describe('Given a directory moved into an existing directory', () => {
    describe('When mv', () => {
      it('Then the directory is reparented under the destination keeping its name', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'src/f.txt': '1', 'dest/keep.txt': 'k' });

        // Act
        const sut = await mv(ctx, ['src'], 'dest');

        // Assert
        expect(sut.moved).toEqual([{ from: 'src/f.txt', to: 'dest/src/f.txt' }]);
        expect(await readWork(ctx, 'dest/src/f.txt')).toBe('1');
      });
    });
  });

  describe('Given force and a tracked destination file', () => {
    describe('When mv', () => {
      it('Then the destination is overwritten with the source blob', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a', 'keep.txt': 'k' });
        const sourceId = (await indexEntry(ctx, 'a.txt'))?.id;

        // Act
        await mv(ctx, ['a.txt'], 'keep.txt', { force: true });

        // Assert
        expect(await indexEntry(ctx, 'a.txt')).toBeUndefined();
        expect((await indexEntry(ctx, 'keep.txt'))?.id).toBe(sourceId);
        expect(await readWork(ctx, 'keep.txt')).toBe('a');
      });
    });
  });

  describe('Given force and an on-disk untracked destination', () => {
    describe('When mv', () => {
      it('Then the untracked destination is overwritten', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        await ctx.fs.writeUtf8(work(ctx, 'present.txt'), 'x');

        // Act
        const sut = await mv(ctx, ['a.txt'], 'present.txt', { force: true });

        // Assert
        expect(sut.moved).toEqual([{ from: 'a.txt', to: 'present.txt' }]);
        expect(await readWork(ctx, 'present.txt')).toBe('a');
      });
    });
  });

  describe('Given dryRun', () => {
    describe('When mv', () => {
      it('Then it returns the plan but mutates neither the index nor the working tree', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act
        const sut = await mv(ctx, ['a.txt'], 'b.txt', { dryRun: true });

        // Assert
        expect(sut.moved).toEqual([{ from: 'a.txt', to: 'b.txt' }]);
        expect(await exists(ctx, 'a.txt')).toBe(true);
        expect(await exists(ctx, 'b.txt')).toBe(false);
        expect(await indexEntry(ctx, 'a.txt')).toBeDefined();
        expect(await indexEntry(ctx, 'b.txt')).toBeUndefined();
      });
    });
  });

  describe('Given skipErrors and a mix of one bad and one good source', () => {
    describe('When mv', () => {
      it('Then the bad source is skipped and the good one moves', async () => {
        // Arrange — a.txt tracked; ghost.txt untracked. Into an existing dir.
        const ctx = await seedAndStage({ 'a.txt': 'a', 'dir/keep.txt': 'k' });

        // Act
        const sut = await mv(ctx, ['a.txt', 'ghost.txt'], 'dir', { skipErrors: true });

        // Assert
        expect(sut.moved).toEqual([{ from: 'a.txt', to: 'dir/a.txt' }]);
        expect(sut.skipped).toEqual([{ source: 'ghost.txt', reason: 'source-not-tracked' }]);
        expect(await readWork(ctx, 'dir/a.txt')).toBe('a');
      });
    });
  });

  describe('Given an untracked source', () => {
    describe('When mv', () => {
      it('Then throws MV_SOURCE_NOT_TRACKED carrying source and destination', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act
        const err = await expectError(
          () => mv(ctx, ['ghost.txt'], 'z.txt'),
          'MV_SOURCE_NOT_TRACKED',
        );

        // Assert
        if (err.data.code !== 'MV_SOURCE_NOT_TRACKED') throw new Error('unexpected error shape');
        expect(err.data.source).toBe('ghost.txt');
        expect(err.data.destination).toBe('z.txt');
      });
    });
  });

  describe('Given a tracked source missing from the working tree', () => {
    describe('When mv', () => {
      it('Then throws MV_BAD_SOURCE', async () => {
        // Arrange — stage a.txt then delete it from disk.
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        await ctx.fs.rm(work(ctx, 'a.txt'));

        // Act
        const err = await expectError(() => mv(ctx, ['a.txt'], 'b.txt'), 'MV_BAD_SOURCE');

        // Assert
        if (err.data.code !== 'MV_BAD_SOURCE') throw new Error('unexpected error shape');
        expect(err.data.source).toBe('a.txt');
        expect(err.data.destination).toBe('b.txt');
      });
    });
  });

  describe('Given a tracked destination without force', () => {
    describe('When mv', () => {
      it('Then throws MV_DESTINATION_EXISTS', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a', 'keep.txt': 'k' });

        // Act / Assert
        const err = await expectError(
          () => mv(ctx, ['a.txt'], 'keep.txt'),
          'MV_DESTINATION_EXISTS',
        );
        if (err.data.code !== 'MV_DESTINATION_EXISTS') throw new Error('unexpected error shape');
        expect(err.data.destination).toBe('keep.txt');
      });
    });
  });

  describe('Given an on-disk untracked destination without force', () => {
    describe('When mv', () => {
      it('Then throws MV_DESTINATION_EXISTS', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        await ctx.fs.writeUtf8(work(ctx, 'present.txt'), 'x');

        // Act / Assert
        await expectError(() => mv(ctx, ['a.txt'], 'present.txt'), 'MV_DESTINATION_EXISTS');
      });
    });
  });

  describe('Given a directory source over an existing file with force', () => {
    describe('When mv', () => {
      it('Then it still throws MV_DESTINATION_EXISTS (force does not apply to directory sources)', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'dir/f.txt': '1', 'plain.txt': 'F' });

        // Act / Assert
        await expectError(
          () => mv(ctx, ['dir'], 'plain.txt', { force: true }),
          'MV_DESTINATION_EXISTS',
        );
      });
    });
  });

  describe('Given a source moved onto itself', () => {
    describe('When mv', () => {
      it('Then throws MV_INTO_SELF', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act / Assert
        const err = await expectError(() => mv(ctx, ['a.txt'], 'a.txt'), 'MV_INTO_SELF');
        if (err.data.code !== 'MV_INTO_SELF') throw new Error('unexpected error shape');
        expect(err.data.source).toBe('a.txt');
      });
    });
  });

  describe('Given a directory moved into itself', () => {
    describe('When mv', () => {
      it('Then throws MV_INTO_SELF', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'dir/f.txt': '1' });

        // Act / Assert
        await expectError(() => mv(ctx, ['dir'], 'dir/sub'), 'MV_INTO_SELF');
      });
    });
  });

  describe('Given two sources and a non-directory destination', () => {
    describe('When mv', () => {
      it('Then throws MV_DESTINATION_NOT_DIRECTORY', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a', 'b.txt': 'b' });

        // Act / Assert
        const err = await expectError(
          () => mv(ctx, ['a.txt', 'b.txt'], 'nope.txt'),
          'MV_DESTINATION_NOT_DIRECTORY',
        );
        if (err.data.code !== 'MV_DESTINATION_NOT_DIRECTORY') throw new Error('unexpected shape');
        expect(err.data.destination).toBe('nope.txt');
      });
    });
  });

  describe('Given a trailing-slash destination whose directory is absent', () => {
    describe('When mv', () => {
      it('Then throws MV_DESTINATION_DIRECTORY_MISSING preserving the trailing slash', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act / Assert
        const err = await expectError(
          () => mv(ctx, ['a.txt'], 'missing/'),
          'MV_DESTINATION_DIRECTORY_MISSING',
        );
        if (err.data.code !== 'MV_DESTINATION_DIRECTORY_MISSING')
          throw new Error('unexpected shape');
        expect(err.data.destination).toBe('missing/');
      });
    });
  });

  describe('Given a rename whose destination parent directory is absent', () => {
    describe('When mv', () => {
      it('Then throws MV_DESTINATION_DIRECTORY_MISSING', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act / Assert
        const err = await expectError(
          () => mv(ctx, ['a.txt'], 'sub/b.txt'),
          'MV_DESTINATION_DIRECTORY_MISSING',
        );
        if (err.data.code !== 'MV_DESTINATION_DIRECTORY_MISSING')
          throw new Error('unexpected shape');
        expect(err.data.destination).toBe('sub/b.txt');
      });
    });
  });

  describe('Given two sources mapping to the same target', () => {
    describe('When mv', () => {
      it('Then throws MV_MULTIPLE_SOURCES_SAME_TARGET', async () => {
        // Arrange — two distinct tracked files with the same basename under
        // different dirs, moved into one directory ⇒ collide at dir/f.txt.
        const ctx = await seedAndStage({ 'x/f.txt': '1', 'y/f.txt': '2', 'dir/keep.txt': 'k' });

        // Act / Assert
        const err = await expectError(
          () => mv(ctx, ['x/f.txt', 'y/f.txt'], 'dir'),
          'MV_MULTIPLE_SOURCES_SAME_TARGET',
        );
        if (err.data.code !== 'MV_MULTIPLE_SOURCES_SAME_TARGET')
          throw new Error('unexpected shape');
        expect(err.data.destination).toBe('dir/f.txt');
      });
    });
  });

  describe('Given one bad source among good ones without skipErrors', () => {
    describe('When mv', () => {
      it('Then it aborts atomically — no working-tree mutation, index unchanged', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a', 'dir/keep.txt': 'k' });

        // Act
        await expectError(() => mv(ctx, ['a.txt', 'ghost.txt'], 'dir'), 'MV_SOURCE_NOT_TRACKED');

        // Assert — a.txt did NOT move; nothing landed in dir.
        expect(await exists(ctx, 'a.txt')).toBe(true);
        expect(await exists(ctx, 'dir/a.txt')).toBe(false);
        expect(await indexEntry(ctx, 'a.txt')).toBeDefined();
        expect(await indexEntry(ctx, 'dir/a.txt')).toBeUndefined();
      });
    });
  });

  describe('Given a bare repo', () => {
    describe('When mv', () => {
      it('Then throws BARE_REPOSITORY tagged with operation "mv"', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, '[core]\n  bare = true\n');

        // Act
        const err = await expectError(() => mv(ctx, ['a.txt'], 'b.txt'), 'BARE_REPOSITORY');

        // Assert
        if (err.data.code !== 'BARE_REPOSITORY') throw new Error('unexpected error shape');
        expect(err.data.operation).toBe('mv');
        expect(err.message).toBe('BARE_REPOSITORY: operation requires a working tree: mv');
      });
    });
  });

  describe('Given a source path that escapes the repository', () => {
    describe('When mv', () => {
      it('Then throws PATHSPEC_OUTSIDE_REPO', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act / Assert
        await expectError(() => mv(ctx, ['../escape'], 'b.txt'), 'PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given a destination path that escapes the repository', () => {
    describe('When mv', () => {
      it('Then throws PATHSPEC_OUTSIDE_REPO', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });

        // Act / Assert
        await expectError(() => mv(ctx, ['a.txt'], '../escape'), 'PATHSPEC_OUTSIDE_REPO');
      });
    });
  });

  describe('Given breakStaleLockMs and a stale lock', () => {
    describe('When mv', () => {
      it('Then the stale lock is broken and mv succeeds', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        const lockPath = `${ctx.layout.gitDir}/index.lock`;
        await ctx.fs.writeExclusive(lockPath, new Uint8Array());
        const staleCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: async (path: string) => {
              const stat = await ctx.fs.lstat(path);
              return path === lockPath ? { ...stat, mtimeMs: 0 } : stat;
            },
          },
        };

        // Act
        const sut = await mv(staleCtx, ['a.txt'], 'b.txt', { breakStaleLockMs: 1 });

        // Assert
        expect(sut.moved).toEqual([{ from: 'a.txt', to: 'b.txt' }]);
      });
    });
  });

  describe('Given a held lock without breakStaleLockMs', () => {
    describe('When mv', () => {
      it('Then it surfaces RESOURCE_LOCKED', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        await ctx.fs.writeExclusive(`${ctx.layout.gitDir}/index.lock`, new Uint8Array());

        // Act / Assert
        await expectError(() => mv(ctx, ['a.txt'], 'b.txt'), 'RESOURCE_LOCKED');
      });
    });
  });

  describe('Given a successful mv', () => {
    describe('When it completes', () => {
      it('Then the index lock is released (a second mv is not RESOURCE_LOCKED)', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a', 'b.txt': 'b' });

        // Act
        await mv(ctx, ['a.txt'], 'c.txt');
        const sut = await mv(ctx, ['b.txt'], 'd.txt');

        // Assert
        expect(sut.moved).toEqual([{ from: 'b.txt', to: 'd.txt' }]);
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
      });
    });
  });

  describe('Given an mv that throws before commit', () => {
    describe('When it rejects', () => {
      it('Then the finally block releases the lock', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a', 'b.txt': 'b' });

        // Act — reject pre-commit (untracked source) AFTER the lock is acquired.
        await expectError(() => mv(ctx, ['ghost.txt'], 'z.txt'), 'MV_SOURCE_NOT_TRACKED');

        // Assert — a follow-up mv succeeds instead of RESOURCE_LOCKED.
        expect(await ctx.fs.exists(`${ctx.layout.gitDir}/index.lock`)).toBe(false);
        const sut = await mv(ctx, ['b.txt'], 'c.txt');
        expect(sut.moved).toEqual([{ from: 'b.txt', to: 'c.txt' }]);
      });
    });
  });
});
