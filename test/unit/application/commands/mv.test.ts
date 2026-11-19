import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { add } from '../../../../src/application/commands/add.js';
import { mv } from '../../../../src/application/commands/mv.js';
import { indexEntryFromStat } from '../../../../src/application/primitives/internal/index-entry-from-stat.js';
import { readIndex } from '../../../../src/application/primitives/read-index.js';
import { updateConfigEntries } from '../../../../src/application/primitives/update-config.js';
import { writeObject } from '../../../../src/application/primitives/write-object.js';
import {
  pathTooLong,
  permissionDenied,
  unsupportedOperation,
} from '../../../../src/domain/error.js';
import type { IndexEntry } from '../../../../src/domain/git-index/index.js';
import { fileNotFound, TsgitError } from '../../../../src/domain/index.js';
import type { FileMode, FilePath, ObjectId } from '../../../../src/domain/objects/index.js';
import { FILE_MODE } from '../../../../src/domain/objects/index.js';
import type { Context } from '../../../../src/ports/context.js';
import { serializeIndexFixtureAsync } from '../primitives/fixtures.js';
import { asBareContext, seedRepo } from './fixtures.js';

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
        const result = await mv(ctx, ['a.txt'], 'b.txt');

        // Assert
        expect(result.moved).toEqual([{ from: 'a.txt', to: 'b.txt' }]);
        expect(result.skipped).toEqual([]);
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
        const result = await mv(ctx, ['a.txt'], 'dir');

        // Assert
        expect(result.moved).toEqual([{ from: 'a.txt', to: 'dir/a.txt' }]);
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
        const result = await mv(ctx, ['b.txt', 'a.txt'], 'dir');

        // Assert
        expect(result.moved).toEqual([
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
        const result = await mv(ctx, ['old'], 'new');

        // Assert
        expect(result.moved).toEqual([
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
        const result = await mv(ctx, ['src'], 'dest');

        // Assert
        expect(result.moved).toEqual([{ from: 'src/f.txt', to: 'dest/src/f.txt' }]);
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
        const result = await mv(ctx, ['a.txt'], 'present.txt', { force: true });

        // Assert
        expect(result.moved).toEqual([{ from: 'a.txt', to: 'present.txt' }]);
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
        const result = await mv(ctx, ['a.txt'], 'b.txt', { dryRun: true });

        // Assert
        expect(result.moved).toEqual([{ from: 'a.txt', to: 'b.txt' }]);
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
        const result = await mv(ctx, ['a.txt', 'ghost.txt'], 'dir', { skipErrors: true });

        // Assert
        expect(result.moved).toEqual([{ from: 'a.txt', to: 'dir/a.txt' }]);
        expect(result.skipped).toEqual([{ source: 'ghost.txt', reason: 'source-not-tracked' }]);
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

  describe('Given a directory and something inside it as two sources', () => {
    describe('When mv', () => {
      it('Then throws MV_OVERLAPPING_SOURCES naming the child and its parent', async () => {
        // Arrange — `a` (dir) and `a/b` (its subdir) both listed as sources.
        const ctx = await seedAndStage({ 'a/b/x.txt': '1', 'a/y.txt': '2', 'dir/keep.txt': 'k' });

        // Act / Assert
        const err = await expectError(() => mv(ctx, ['a', 'a/b'], 'dir'), 'MV_OVERLAPPING_SOURCES');
        if (err.data.code !== 'MV_OVERLAPPING_SOURCES') throw new Error('unexpected shape');
        expect(err.data.child).toBe('a/b');
        expect(err.data.parent).toBe('a');
        // Atomic — nothing moved.
        expect(await exists(ctx, 'a/b/x.txt')).toBe(true);
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
      it('Then throws WORK_TREE_REQUIRED tagged with operation "mv"', async () => {
        // Arrange
        const ctx0 = createMemoryContext();
        await seedRepo(ctx0, {});
        const ctx = asBareContext(ctx0);

        // Act
        const err = await expectError(() => mv(ctx, ['a.txt'], 'b.txt'), 'WORK_TREE_REQUIRED');

        // Assert
        if (err.data.code !== 'WORK_TREE_REQUIRED') throw new Error('unexpected error shape');
        expect(err.data.operation).toBe('mv');
        expect(err.message).toBe('WORK_TREE_REQUIRED: operation requires a working tree: mv');
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

  describe('Given config.breakStaleLockMs and a stale lock', () => {
    describe('When mv', () => {
      it('Then the stale lock is broken and mv succeeds', async () => {
        // Arrange — the break window lives on config (set once at open), not on
        // a per-call mv option; the stale lock reports a far-past mtime.
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        const lockPath = `${ctx.layout.gitDir}/index.lock`;
        await ctx.fs.writeExclusive(lockPath, new Uint8Array());
        const staleCtx: Context = {
          ...ctx,
          config: { ...ctx.config, breakStaleLockMs: 1 },
          fs: {
            ...ctx.fs,
            lstat: async (path: string) => {
              const stat = await ctx.fs.lstat(path);
              return path === lockPath ? { ...stat, mtimeMs: 0 } : stat;
            },
          },
        };

        // Act
        const result = await mv(staleCtx, ['a.txt'], 'b.txt');

        // Assert
        expect(result.moved).toEqual([{ from: 'a.txt', to: 'b.txt' }]);
      });
    });
  });

  describe('Given a held lock without config.breakStaleLockMs', () => {
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
        const result = await mv(ctx, ['b.txt'], 'd.txt');

        // Assert
        expect(result.moved).toEqual([{ from: 'b.txt', to: 'd.txt' }]);
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
        const result = await mv(ctx, ['b.txt'], 'c.txt');
        expect(result.moved).toEqual([{ from: 'b.txt', to: 'c.txt' }]);
      });
    });
  });

  describe('Given a corrupt index (INVALID_INDEX_HEADER)', () => {
    describe('When mv', () => {
      it('Then the parse error is tolerated and the source reads as untracked', async () => {
        // Arrange — an index shorter than the hash trailer makes readIndex throw
        // INVALID_INDEX_HEADER; readIndexMap tolerates it as an empty index.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, new Uint8Array([1, 2, 3]));

        // Act / Assert — empty index ⇒ 'a.txt' untracked ⇒ MV_SOURCE_NOT_TRACKED
        // (re-throwing the parse error would surface INVALID_INDEX_HEADER instead).
        await expectError(() => mv(ctx, ['a.txt'], 'b.txt'), 'MV_SOURCE_NOT_TRACKED');
      });
    });
  });

  describe('Given a corrupt index (INVALID_INDEX_ENTRY)', () => {
    describe('When mv', () => {
      it('Then the parse error is tolerated and the source reads as untracked', async () => {
        // Arrange — checksum-valid index whose single entry has no NUL terminator,
        // so parseIndex throws INVALID_INDEX_ENTRY (reached past the checksum).
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

        // Act / Assert
        await expectError(() => mv(ctx, ['a.txt'], 'b.txt'), 'MV_SOURCE_NOT_TRACKED');
      });
    });
  });

  describe('Given readIndex racing to FILE_NOT_FOUND', () => {
    describe('When mv', () => {
      it('Then the error is tolerated and the source reads as untracked', async () => {
        // Arrange — index exists (passes readIndex's exists() guard) but stat throws
        // FILE_NOT_FOUND, simulating the file vanishing; readIndex propagates it and
        // readIndexMap tolerates it as an empty index.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const indexFile = `${ctx.layout.gitDir}/index`;
        await ctx.fs.write(indexFile, new Uint8Array(32));
        const racingCtx: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            stat: async (path: string) => {
              if (path === indexFile) throw fileNotFound(indexFile);
              return ctx.fs.stat(path);
            },
          },
        };

        // Act / Assert
        await expectError(() => mv(racingCtx, ['a.txt'], 'b.txt'), 'MV_SOURCE_NOT_TRACKED');
      });
    });
  });

  describe('Given a non-index-missing readIndex error', () => {
    describe('When mv', () => {
      it('Then the error propagates (not silently tolerated)', async () => {
        // Arrange — make readIndex throw a code that is NOT index-missing; readIndexMap
        // must re-throw it rather than swallow it into an empty index.
        const ctx = createMemoryContext();
        await seedRepo(ctx, {});
        const indexFile = `${ctx.layout.gitDir}/index`;
        await ctx.fs.write(indexFile, new Uint8Array(32));
        const failingCtx: Context = {
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

        // Act / Assert
        await expectError(() => mv(failingCtx, ['a.txt'], 'b.txt'), 'PERMISSION_DENIED');
      });
    });
  });

  describe('Given a tracked directory source that is a plain file on disk', () => {
    describe('When mv', () => {
      it('Then MV_BAD_SOURCE (a directory source must be a real directory on disk)', async () => {
        // Arrange — 'd/f.txt' is tracked, so 'd' classifies as a directory source;
        // replace the working subtree with a regular file named 'd'.
        const ctx = await seedAndStage({ 'd/f.txt': '1' });
        await ctx.fs.rmRecursive(work(ctx, 'd'));
        await ctx.fs.writeUtf8(work(ctx, 'd'), 'now-a-file');

        // Act / Assert — sourceExistsOnDisk('d','directory') is false because the
        // on-disk entry is a file, not a directory.
        await expectError(() => mv(ctx, ['d'], 'dest'), 'MV_BAD_SOURCE');
      });
    });
  });

  describe('Given a tracked file source that is a directory on disk', () => {
    describe('When mv', () => {
      it('Then MV_BAD_SOURCE (a file source must be a file or symlink on disk)', async () => {
        // Arrange — 'a.txt' is tracked as a file; replace it on disk with a directory.
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        await ctx.fs.rm(work(ctx, 'a.txt'));
        await ctx.fs.mkdir(work(ctx, 'a.txt'));

        // Act / Assert — sourceExistsOnDisk('a.txt','file') is false (neither file
        // nor symlink), so the move is refused as a bad source.
        await expectError(() => mv(ctx, ['a.txt'], 'b.txt'), 'MV_BAD_SOURCE');
      });
    });
  });

  describe('Given a trailing-slash destination naming an existing directory', () => {
    describe('When mv', () => {
      it('Then the trailing slash is stripped and the file moves into the directory', async () => {
        // Arrange — destination 'dir/' must resolve to the existing 'dir' (the slash
        // stripped before the directory probe), moving 'a.txt' to 'dir/a.txt'.
        const ctx = await seedAndStage({ 'a.txt': 'a', 'dir/keep.txt': 'k' });

        // Act
        const result = await mv(ctx, ['a.txt'], 'dir/');

        // Assert
        expect(result.moved).toEqual([{ from: 'a.txt', to: 'dir/a.txt' }]);
        expect(await readWork(ctx, 'dir/a.txt')).toBe('a');
      });
    });
  });

  describe('Given reverse-ordered sources moved into a directory', () => {
    describe('When mv', () => {
      it('Then moved is sorted ascending by from, regardless of argument order', async () => {
        // Arrange — sources listed z-before-a; the result must be a-before-z.
        const ctx = await seedAndStage({ 'a.txt': 'a', 'z.txt': 'z', 'dir/keep.txt': 'k' });

        // Act
        const result = await mv(ctx, ['z.txt', 'a.txt'], 'dir');

        // Assert — pins the ascending sort (a mutant that keeps argument order would
        // yield z before a).
        expect(result.moved).toEqual([
          { from: 'a.txt', to: 'dir/a.txt' },
          { from: 'z.txt', to: 'dir/z.txt' },
        ]);
      });
    });
  });
});

describe('mv with a source string holding a lone surrogate', () => {
  describe('Given a lossy entry and its U+FFFD twin with the twin on disk', () => {
    describe('When mv names the lone-surrogate spelling', () => {
      it('Then the twin moves and the lossy entry stays', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedRepo(ctx, { workingTree: { '\uFFFD.txt': 'u' } });
        const stat = await ctx.fs.lstat(work(ctx, '\uFFFD.txt'));
        const blob = await writeObject(ctx, {
          type: 'blob',
          id: '' as ObjectId,
          content: new TextEncoder().encode('u'),
        });
        const entryOf = (path: FilePath): IndexEntry => ({
          ...indexEntryFromStat(stat, FILE_MODE.REGULAR, blob, path),
          fileSize: 0,
        });
        const lossy: IndexEntry = {
          ...entryOf('\uFFFD.txt' as FilePath),
          pathBytes: Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74),
        };
        const twin = entryOf('\uFFFD.txt' as FilePath);
        await ctx.fs.write(
          `${ctx.layout.gitDir}/index`,
          await serializeIndexFixtureAsync(
            { version: 2, entries: [twin, lossy], extensions: [], trailerSha: new Uint8Array(0) },
            ctx,
          ),
        );
        const sut = mv;

        // Act
        const result = await sut(ctx, ['\uDCFF.txt'], 'x');

        // Assert
        const index = await readIndex(ctx);
        expect(result.moved).toEqual([{ from: '\uFFFD.txt', to: 'x' }]);
        expect(index.entries.map((e) => [e.path, e.pathBytes])).toEqual([
          ['x', undefined],
          ['\uFFFD.txt', Uint8Array.of(0xff, 0x2e, 0x74, 0x78, 0x74)],
        ]);
      });
    });
  });
});

interface SeededRow {
  readonly path: string;
  readonly bytes?: ReadonlyArray<number>;
  readonly mode?: FileMode;
}

const seedRows = async (
  workingTree: Readonly<Record<string, string>>,
  rows: ReadonlyArray<SeededRow>,
): Promise<Context> => {
  const ctx = createMemoryContext();
  await seedRepo(ctx, { workingTree });
  const stat = await ctx.fs.lstat(work(ctx, Object.keys(workingTree)[0] as string));
  const blob = await writeObject(ctx, {
    type: 'blob',
    id: '' as ObjectId,
    content: new TextEncoder().encode('b'),
  });
  const entries: IndexEntry[] = rows.map((row) => ({
    ...indexEntryFromStat(stat, row.mode ?? FILE_MODE.REGULAR, blob, row.path as FilePath),
    fileSize: 0,
    ...(row.bytes === undefined ? {} : { pathBytes: Uint8Array.from(row.bytes) }),
  }));
  await ctx.fs.write(
    `${ctx.layout.gitDir}/index`,
    await serializeIndexFixtureAsync(
      { version: 2, entries, extensions: [], trailerSha: new Uint8Array(0) },
      ctx,
    ),
  );
  return ctx;
};

const indexView = async (ctx: Context) =>
  (await readIndex(ctx)).entries.map((e) => [e.path, e.pathBytes && Array.from(e.pathBytes)]);

const captureError = async (fn: () => Promise<unknown>): Promise<TsgitError | undefined> => {
  try {
    await fn();
  } catch (err) {
    return err as TsgitError;
  }
  return undefined;
};

describe('mv selecting directory members by path bytes', () => {
  describe('Given a U+FFFD directory member and a lossy entry whose bytes cross a slash', () => {
    describe('When mv moves the U+FFFD directory to .g', () => {
      it('Then only the literal member moves and the index never names a .git path', async () => {
        // Arrange
        const ctx = await seedRows({ '�/k': 'k' }, [
          { path: '�/k' },
          { path: '�/it/p', bytes: [0xff, 0x2f, 0x69, 0x74, 0x2f, 0x70] },
        ]);
        const sut = mv;

        // Act
        const result = await sut(ctx, ['�'], '.g');

        // Assert
        expect(result.moved).toEqual([{ from: '�/k', to: '.g/k' }]);
        expect(await indexView(ctx)).toEqual([
          ['.g/k', undefined],
          ['�/it/p', [0xff, 0x2f, 0x69, 0x74, 0x2f, 0x70]],
        ]);
      });
    });
  });

  describe('Given a U+FFFD directory member and a lossy entry under the same view', () => {
    describe('When mv moves the U+FFFD directory to dst', () => {
      it('Then the lossy entry keeps its bytes and only the literal member moves', async () => {
        // Arrange
        const ctx = await seedRows({ '�/x': 'x' }, [
          { path: '�/x' },
          { path: '�/x', bytes: [0xff, 0x2f, 0x78] },
        ]);
        const sut = mv;

        // Act
        const result = await sut(ctx, ['�'], 'dst');

        // Assert
        expect(result.moved).toEqual([{ from: '�/x', to: 'dst/x' }]);
        expect(await indexView(ctx)).toEqual([
          ['dst/x', undefined],
          ['�/x', [0xff, 0x2f, 0x78]],
        ]);
      });
    });
  });
});

describe('mv re-validating the moved path', () => {
  describe('Given a tracked symlink entry', () => {
    describe('When mv targets .gitmodules', () => {
      it('Then it rejects with the gitmodules-symlink reason and the index is unchanged', async () => {
        // Arrange
        const ctx = await seedRows({ x: 'x' }, [{ path: 'x', mode: FILE_MODE.SYMLINK }]);
        const before = await indexView(ctx);
        const sut = mv;

        // Act
        const error = await captureError(() => sut(ctx, ['x'], '.gitmodules'));

        // Assert
        expect(error?.data).toMatchObject({
          code: 'INVALID_INDEX_ENTRY',
          reason: "'.gitmodules' must not be a symlink",
        });
        expect(await indexView(ctx)).toEqual(before);
      });
    });
  });
});

describe('mv re-validating a tracked directory member', () => {
  describe('Given a tracked directory d holding x\\y', () => {
    describe('When mv d e runs under Windows path syntax', () => {
      it('Then it rejects with the backslash reason and nothing moves', async () => {
        // Arrange
        const ctx = await seedRows({ 'd/x\\y': 'y' }, [{ path: 'd/x\\y' }]);
        const before = await indexView(ctx);
        const sut = mv;

        // Act
        const error = await captureError(() =>
          sut({ ...ctx, windowsPathSyntax: true }, ['d'], 'e'),
        );

        // Assert
        expect(error?.data).toMatchObject({
          code: 'INVALID_INDEX_ENTRY',
          reason: 'backslash rejected under Windows path syntax',
        });
        expect(await indexView(ctx)).toEqual(before);
        expect(await exists(ctx, 'd/x\\y')).toBe(true);
        expect(await exists(ctx, 'e')).toBe(false);
      });
    });

    describe('When mv d e runs under POSIX path syntax', () => {
      it('Then it resolves and the index lists e/x\\y', async () => {
        // Arrange
        const ctx = await seedRows({ 'd/x\\y': 'y' }, [{ path: 'd/x\\y' }]);
        const sut = mv;

        // Act
        await sut(ctx, ['d'], 'e');

        // Assert
        expect((await indexView(ctx)).map(([path]) => path)).toEqual(['e/x\\y']);
      });
    });
  });
});

const seedMember = (extraMembers: Readonly<Record<string, string>> = {}): Promise<Context> =>
  seedRows({ 'd/y': 'y', ...extraMembers }, [
    { path: 'd/y' },
    { path: 'd/�', bytes: [0x64, 0x2f, 0xff] },
  ]);

describe('mv on a directory holding a lossy member', () => {
  describe('Given a directory on disk holding only a lossy member', () => {
    describe('When mv renames it with skipErrors', () => {
      it('Then the directory is skipped as a bad source and nothing moves', async () => {
        // Arrange
        const ctx = await seedRows({ 'd/y': 'y' }, [
          { path: 'd/\uFFFD', bytes: [0x64, 0x2f, 0xff] },
        ]);
        const sut = mv;

        // Act
        const result = await sut(ctx, ['d'], 'e', { skipErrors: true });

        // Assert
        expect(result).toEqual({ moved: [], skipped: [{ source: 'd', reason: 'bad-source' }] });
        expect(await exists(ctx, 'd/y')).toBe(true);
      });
    });
  });

  describe('Given d/y on disk and a lossy d/<0xff> member', () => {
    describe('When mv renames d without skipErrors', () => {
      it('Then it refuses naming the member and the index is unchanged', async () => {
        // Arrange
        const ctx = await seedMember();
        const before = await indexView(ctx);
        const sut = mv;

        // Act
        const error = await captureError(() => sut(ctx, ['d'], 'e'));

        // Assert
        expect(error?.data).toMatchObject({
          code: 'MV_BAD_SOURCE',
          source: 'd/�',
          destination: 'e/�',
        });
        expect(await indexView(ctx)).toEqual(before);
      });
    });

    describe('When mv renames d with skipErrors', () => {
      it('Then the lossy member stays and the rest moves', async () => {
        // Arrange
        const ctx = await seedMember();
        const sut = mv;

        // Act
        const result = await sut(ctx, ['d'], 'e', { skipErrors: true });

        // Assert
        expect(result.moved).toEqual([{ from: 'd/y', to: 'e/y' }]);
        expect(await indexView(ctx)).toEqual([
          ['d/�', [0x64, 0x2f, 0xff]],
          ['e/y', undefined],
        ]);
      });
    });
  });
});

const withoutDirectoryRename = (ctx: Context): Context => {
  const { renameDirectory: _absent, ...fs } = ctx.fs;
  return { ...ctx, fs };
};

describe('mv — a move the file system refuses', () => {
  const failingRename = (ctx: Context, fault: TsgitError): Context => ({
    ...ctx,
    fs: {
      ...ctx.fs,
      rename: async () => {
        throw fault;
      },
    },
  });

  const failingDirectoryRename = (ctx: Context, fault: TsgitError): Context => ({
    ...ctx,
    fs: {
      ...ctx.fs,
      renameDirectory: async () => {
        throw fault;
      },
    },
  });

  describe('Given a rename the file system refuses as too long', () => {
    describe('When mv', () => {
      it('Then it names the destination and leaves the index and the source unchanged', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        const refusing = failingRename(ctx, pathTooLong('/abs/a.txt'));
        const sut = mv;

        // Act
        const err = await expectError(() => sut(refusing, ['a.txt'], 'b.txt'), 'PATH_TOO_LONG');

        // Assert
        expect(err.data).toEqual({ code: 'PATH_TOO_LONG', path: 'b.txt' });
        expect(await indexEntry(ctx, 'a.txt')).toBeDefined();
        expect(await indexEntry(ctx, 'b.txt')).toBeUndefined();
        expect(await exists(ctx, 'a.txt')).toBe(true);
      });
    });

    describe('When mv moves into a directory', () => {
      it('Then it names the target inside that directory', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a', 'd/k': 'k' });
        const refusing = failingRename(ctx, pathTooLong('/abs/a.txt'));
        const sut = mv;

        // Act
        const err = await expectError(() => sut(refusing, ['a.txt'], 'd'), 'PATH_TOO_LONG');

        // Assert
        expect(err.data).toEqual({ code: 'PATH_TOO_LONG', path: 'd/a.txt' });
      });
    });
  });

  describe('Given a directory move whose rename the file system refuses as too long', () => {
    describe('When mv', () => {
      it('Then it names the destination directory', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f' });
        const refusing = failingDirectoryRename(ctx, pathTooLong('/abs/d'));
        const sut = mv;

        // Act
        const err = await expectError(() => sut(refusing, ['d'], 'e'), 'PATH_TOO_LONG');

        // Assert
        expect(err.data).toEqual({ code: 'PATH_TOO_LONG', path: 'e' });
      });
    });
  });

  describe('Given a directory whose source descendant the file system refuses as too long', () => {
    const refuseDescendant = (ctx: Context, fault: TsgitError): Context => {
      const descendant = work(ctx, 'd/f');
      return {
        ...ctx,
        fs: {
          ...ctx.fs,
          lstat: async (path: string) => {
            if (path === descendant) throw fault;
            return ctx.fs.lstat(path);
          },
        },
      };
    };

    describe('When mv with renameDirectory', () => {
      it('Then the move succeeds and the index holds e/f', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f' });
        const refusing = refuseDescendant(ctx, pathTooLong('/abs/d/f'));
        const sut = mv;

        // Act
        await sut(refusing, ['d'], 'e');

        // Assert
        expect(await indexEntry(ctx, 'e/f')).toBeDefined();
        expect(await exists(ctx, 'e/f')).toBe(true);
      });
    });

    describe('When mv without renameDirectory', () => {
      it('Then the refusal keeps naming that source descendant', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f' });
        const fault = pathTooLong('/abs/d/f');
        const refusing = withoutDirectoryRename(refuseDescendant(ctx, fault));
        const sut = mv;

        // Act
        const outcome = sut(refusing, ['d'], 'e');

        // Assert
        await expect(outcome).rejects.toBe(fault);
      });
    });
  });

  describe('Given a directory whose source descendant lstat faults, without renameDirectory', () => {
    describe('When mv', () => {
      it('Then nothing moved and the index is unchanged', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/a': 'a', 'd/f': 'f' });
        const fault = permissionDenied(work(ctx, 'd/f'));
        const faulting = withoutDirectoryRename({
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: async (path: string) => {
              if (path === work(ctx, 'd/f')) throw fault;
              return ctx.fs.lstat(path);
            },
          },
        });
        const sut = mv;

        // Act
        const outcome = sut(faulting, ['d'], 'e');

        // Assert
        await expect(outcome).rejects.toBe(fault);
        expect(await exists(ctx, 'd/a')).toBe(true);
        expect(await exists(ctx, 'e')).toBe(false);
        expect(await indexEntry(ctx, 'd/a')).toBeDefined();
      });
    });
  });

  describe('Given a directory move whose leaf rename the file system refuses as too long', () => {
    describe('When mv without renameDirectory', () => {
      it('Then it names that leaf inside the destination', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f' });
        const refusing = failingRename(withoutDirectoryRename(ctx), pathTooLong('/abs/d/f'));
        const sut = mv;

        // Act
        const err = await expectError(() => sut(refusing, ['d'], 'e'), 'PATH_TOO_LONG');

        // Assert
        expect(err.data).toEqual({ code: 'PATH_TOO_LONG', path: 'e/f' });
      });
    });
  });

  describe('Given a directory rename refused UNSUPPORTED_OPERATION EINVAL', () => {
    describe('When mv without skipErrors', () => {
      it('Then it rejects with that very error, the index keeps d/f and the source is on disk', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f' });
        const fault = unsupportedOperation('filesystem', 'EINVAL');
        const refusing = failingDirectoryRename(ctx, fault);
        const sut = mv;

        // Act
        const outcome = sut(refusing, ['d'], 'e');

        // Assert
        await expect(outcome).rejects.toBe(fault);
        expect(await indexEntry(ctx, 'd/f')).toBeDefined();
        expect(await indexEntry(ctx, 'e/f')).toBeUndefined();
        expect(await exists(ctx, 'd/f')).toBe(true);
      });
    });
  });

  describe('Given a rename the file system refuses for another reason', () => {
    describe('When mv', () => {
      it('Then it rethrows that very error', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a.txt': 'a' });
        const fault = permissionDenied('/abs/a.txt');
        const refusing: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rename: async () => {
              throw fault;
            },
          },
        };
        const sut = mv;

        // Act
        const outcome = sut(refusing, ['a.txt'], 'b.txt');

        // Assert
        await expect(outcome).rejects.toBe(fault);
      });
    });
  });
});

describe('mv — skipErrors and a rename the file system refuses', () => {
  const failingWorkTreeRename = (
    ctx: Context,
    fault: TsgitError,
    refusedName: string,
  ): Context => ({
    ...ctx,
    fs: {
      ...ctx.fs,
      rename: async (src: string, dst: string) => {
        if (!src.startsWith(ctx.layout.gitDir) && src.endsWith(refusedName)) throw fault;
        return ctx.fs.rename(src, dst);
      },
    },
  });

  const failingDirectoryRename = (ctx: Context, fault: Error): Context => ({
    ...ctx,
    fs: {
      ...ctx.fs,
      renameDirectory: async () => {
        throw fault;
      },
    },
  });

  describe('Given a tracked directory whose rename succeeds', () => {
    describe('When mv with skipErrors', () => {
      it('Then nothing is removed recursively', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f' });
        const rmRecursive = vi.fn(ctx.fs.rmRecursive.bind(ctx.fs));
        const watched: Context = { ...ctx, fs: { ...ctx.fs, rmRecursive } };
        const sut = mv;

        // Act
        const result = await sut(watched, ['d'], 'e', { skipErrors: true });

        // Assert
        expect(result.skipped).toEqual([]);
        expect(rmRecursive).not.toHaveBeenCalled();
      });
    });
  });

  describe('Given a tracked file whose rename refuses PATH_TOO_LONG', () => {
    describe('When mv with skipErrors', () => {
      it('Then base is skipped as rename-failed and index and disk keep base', async () => {
        // Arrange
        const ctx = await seedAndStage({ base: 'b', 'S/k': 'k' });
        const refusing = failingWorkTreeRename(ctx, pathTooLong('/abs/base'), 'base');
        const sut = mv;

        // Act
        const result = await sut(refusing, ['base'], 'S', { skipErrors: true });

        // Assert
        expect(result).toEqual({
          moved: [],
          skipped: [{ source: 'base', reason: 'rename-failed' }],
        });
        expect(await indexEntry(ctx, 'base')).toBeDefined();
        expect(await indexEntry(ctx, 'S/base')).toBeUndefined();
        expect(await exists(ctx, 'base')).toBe(true);
      });
    });
  });

  describe('Given an untracked ghost and a refused base in one call', () => {
    describe('When mv with skipErrors', () => {
      it('Then skipped lists the planning skip first, then the rename skip', async () => {
        // Arrange
        const ctx = await seedAndStage({ base: 'b', 'S/k': 'k' });
        const refusing = failingWorkTreeRename(ctx, pathTooLong('/abs/base'), 'base');
        const sut = mv;

        // Act
        const result = await sut(refusing, ['ghost', 'base'], 'S', { skipErrors: true });

        // Assert
        expect(result.skipped).toEqual([
          { source: 'ghost', reason: 'source-not-tracked' },
          { source: 'base', reason: 'rename-failed' },
        ]);
      });
    });
  });

  describe('Given two files where only the first rename refuses', () => {
    describe('When mv with skipErrors', () => {
      it('Then the second moves in index and disk and the first stays', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'first.txt': '1', 'second.txt': '2', 'S/k': 'k' });
        const refusing = failingWorkTreeRename(ctx, pathTooLong('/abs/first.txt'), 'first.txt');
        const sut = mv;

        // Act
        const result = await sut(refusing, ['first.txt', 'second.txt'], 'S', { skipErrors: true });

        // Assert
        expect(result.moved).toEqual([{ from: 'second.txt', to: 'S/second.txt' }]);
        expect(await indexEntry(ctx, 'S/second.txt')).toBeDefined();
        expect(await exists(ctx, 'S/second.txt')).toBe(true);
        expect(await indexEntry(ctx, 'first.txt')).toBeDefined();
        expect(await exists(ctx, 'first.txt')).toBe(true);
      });
    });
  });

  describe('Given a directory whose renameDirectory refuses EINVAL', () => {
    describe('When mv with skipErrors', () => {
      it('Then the members move in the index and nothing remains at d', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f', 'd/s/t': 't' });
        await ctx.fs.writeUtf8(work(ctx, 'd/u'), 'u');
        await ctx.fs.mkdir(work(ctx, 'd/emp'));
        const refusing = failingDirectoryRename(ctx, unsupportedOperation('filesystem', 'EINVAL'));
        const sut = mv;

        // Act
        const result = await sut(refusing, ['d'], 'D', { skipErrors: true });

        // Assert
        expect((await indexView(ctx)).map(([path]) => path)).toEqual(['D/f', 'D/s/t']);
        expect(result.moved).toEqual([
          { from: 'd/f', to: 'D/f' },
          { from: 'd/s/t', to: 'D/s/t' },
        ]);
        expect(result.skipped).toEqual([{ source: 'd', reason: 'rename-failed' }]);
        expect(await exists(ctx, 'd')).toBe(false);
      });
    });
  });

  describe('Given a directory holding a lossy member whose renameDirectory refuses', () => {
    describe('When mv with skipErrors', () => {
      it('Then the lossy entry stays in the index under d/ and d is not deleted', async () => {
        // Arrange
        const ctx = await seedMember();
        const refusing = failingDirectoryRename(ctx, unsupportedOperation('filesystem', 'EINVAL'));
        const sut = mv;

        // Act
        await sut(refusing, ['d'], 'e', { skipErrors: true });

        // Assert
        expect(await indexView(ctx)).toEqual([
          ['d/�', [0x64, 0x2f, 0xff]],
          ['e/y', undefined],
        ]);
        expect(await exists(ctx, 'd/y')).toBe(true);
      });
    });
  });

  describe('Given d refusing and e renamed into d/e', () => {
    describe('When mv(d, e) into D with skipErrors', () => {
      it('Then d/e is gone too', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f', 'e/x': 'x' });
        const stubbed: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: async (path: string) =>
              ctx.fs.lstat(path === work(ctx, 'D') ? work(ctx, 'd') : path),
            renameDirectory: async (src: string) => {
              if (src === work(ctx, 'd')) throw unsupportedOperation('filesystem', 'EINVAL');
              return ctx.fs.rename(src, work(ctx, 'd/e'));
            },
          },
        };
        const sut = mv;

        // Act
        await sut(stubbed, ['d', 'e'], 'D', { skipErrors: true });

        // Assert
        expect(await exists(ctx, 'd/e')).toBe(false);
        expect(await exists(ctx, 'd')).toBe(false);
      });
    });
  });

  describe('Given a TsgitError from renameDirectory and no skipErrors', () => {
    describe('When mv', () => {
      it('Then it rejects with that very error and the index is unchanged', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f' });
        const fault = unsupportedOperation('filesystem', 'EINVAL');
        const refusing = failingDirectoryRename(ctx, fault);
        const sut = mv;

        // Act
        const outcome = sut(refusing, ['d'], 'D');

        // Assert
        await expect(outcome).rejects.toBe(fault);
        expect((await indexView(ctx)).map(([path]) => path)).toEqual(['d/f']);
      });
    });
  });

  describe('Given a plain Error from renameDirectory and skipErrors', () => {
    describe('When mv', () => {
      it('Then it rejects with that very error and the index is unchanged', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f' });
        const fault = new Error('boom');
        const refusing = failingDirectoryRename(ctx, fault);
        const sut = mv;

        // Act
        const outcome = sut(refusing, ['d'], 'D', { skipErrors: true });

        // Assert
        await expect(outcome).rejects.toBe(fault);
        expect((await indexView(ctx)).map(([path]) => path)).toEqual(['d/f']);
      });
    });
  });

  describe('Given a second source whose member fails Windows path validation', () => {
    describe('When mv into t', () => {
      it('Then INVALID_INDEX_ENTRY and the first source has not moved on disk', async () => {
        // Arrange
        const seeded = await seedRows({ a: 'a', 'd/x\\y': 'y', 't/k': 'k' }, [
          { path: 'a' },
          { path: 'd/x\\y' },
        ]);
        const ctx: Context = { ...seeded, windowsPathSyntax: true };
        const sut = mv;

        // Act
        const error = await captureError(() => sut(ctx, ['a', 'd'], 't'));

        // Assert
        expect(error?.data.code).toBe('INVALID_INDEX_ENTRY');
        expect(await exists(ctx, 'a')).toBe(true);
      });
    });
  });
});

describe('mv — skipErrors and a partial entry-by-entry move', () => {
  const faultOnRename = (
    ctx: Context,
    { at, fault }: { at: number; fault: TsgitError },
  ): Context => {
    const inner = withoutDirectoryRename(ctx);
    let seen = 0;
    return {
      ...inner,
      fs: {
        ...inner.fs,
        rename: async (src: string, dst: string) => {
          if (!src.startsWith(ctx.layout.gitDir)) seen += 1;
          if (seen === at && !src.startsWith(ctx.layout.gitDir)) throw fault;
          return ctx.fs.rename(src, dst);
        },
      },
    };
  };

  // Simulates a case-insensitive host: /repo/T/D and /repo/T/d are the same directory.
  const foldingCase = (ctx: Context): Context => {
    const fold = (arg: unknown): unknown =>
      typeof arg === 'string' && arg.startsWith('/repo/T/D')
        ? `/repo/T/d${arg.slice('/repo/T/D'.length)}`
        : arg;
    const fs = new Proxy(ctx.fs, {
      get: (target, key) => {
        const member = Reflect.get(target, key, target);
        if (typeof member !== 'function') return member;
        return (...args: unknown[]) => member.apply(target, args.map(fold));
      },
    });
    return { ...ctx, fs };
  };

  describe('Given d (tracked d/f, d/g, untracked d/u, empty d/emp) and a rename fault at the 2nd leaf', () => {
    describe('When mv(d, e) with skipErrors', () => {
      it('Then d is skipped, the index holds e/f and e/g and neither d nor e exists', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f', 'd/g': 'g' });
        await ctx.fs.writeUtf8(work(ctx, 'd/u'), 'u');
        await ctx.fs.mkdir(work(ctx, 'd/emp'));
        const faulting = faultOnRename(ctx, { at: 2, fault: permissionDenied('/abs/x') });
        const sut = mv;

        // Act
        const result = await sut(faulting, ['d'], 'e', { skipErrors: true });

        // Assert
        expect(result.skipped).toEqual([{ source: 'd', reason: 'rename-failed' }]);
        expect((await indexView(ctx)).map(([path]) => path)).toEqual(['e/f', 'e/g']);
        expect(await exists(ctx, 'd')).toBe(false);
        expect(await exists(ctx, 'e')).toBe(false);
      });
    });
  });

  describe('Given a file base whose rename writes the destination S and then throws', () => {
    describe('When mv(base, S) with skipErrors', () => {
      it('Then S keeps base bytes, base exists and the index keeps base', async () => {
        // Arrange
        const ctx = await seedAndStage({ base: 'b' });
        const writing: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            rename: async (src: string, dst: string) => {
              if (src.startsWith(ctx.layout.gitDir) || !src.endsWith('base')) {
                return ctx.fs.rename(src, dst);
              }
              await ctx.fs.writeUtf8(dst, await ctx.fs.readUtf8(src));
              throw permissionDenied('/abs/base');
            },
          },
        };
        const sut = mv;

        // Act
        const result = await sut(writing, ['base'], 'S', { skipErrors: true });

        // Assert
        expect(result.skipped).toEqual([{ source: 'base', reason: 'rename-failed' }]);
        expect(await readWork(ctx, 'S')).toBe('b');
        expect(await exists(ctx, 'base')).toBe(true);
        expect(await indexEntry(ctx, 'base')).toBeDefined();
      });
    });
  });

  describe('Given d/y, d/z and a lossy d/<0xff> member and a rename fault at the 2nd leaf', () => {
    describe('When mv(d, e) with skipErrors', () => {
      it('Then the first leaf stays under e, the other under d, the lossy entry stays indexed and d exists', async () => {
        // Arrange
        const ctx = await seedMember({ 'd/z': 'z' });
        const faulting = faultOnRename(ctx, { at: 2, fault: permissionDenied('/abs/x') });
        const sut = mv;

        // Act
        await sut(faulting, ['d'], 'e', { skipErrors: true });

        // Assert
        expect(await exists(ctx, 'e/y')).toBe(true);
        expect(await exists(ctx, 'd/z')).toBe(true);
        expect((await indexView(ctx)).map(([path]) => path)).toContain('d/�');
        expect(await exists(ctx, 'd')).toBe(true);
      });
    });
  });

  describe('Given x/d and y/D moved into T where T/D aliases T/d and a rename fault at the 3rd leaf', () => {
    describe('When mv(x/d, y/D) into T with skipErrors', () => {
      it('Then T/d/f survives, y/D is gone and only y/D is skipped', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'x/d/f': 'f', 'y/D/g': 'g', 'T/keep': 'k' });
        await ctx.fs.writeUtf8(work(ctx, 'y/D/u'), 'u');
        const faulting = foldingCase(
          faultOnRename(ctx, { at: 3, fault: permissionDenied('/abs/x') }),
        );
        const sut = mv;

        // Act
        const result = await sut(faulting, ['x/d', 'y/D'], 'T', { skipErrors: true });

        // Assert
        expect(await exists(ctx, 'T/d/f')).toBe(true);
        expect(await exists(ctx, 'y/D')).toBe(false);
        expect(result.skipped).toEqual([{ source: 'y/D', reason: 'rename-failed' }]);
      });
    });
  });

  describe('Given the first mkdir of /repo/e faulting', () => {
    describe('When mv(d, e) with skipErrors', () => {
      it('Then rmRecursive is called with /repo/d and never with /repo/e', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f', 'd/g': 'g' });
        const inner = withoutDirectoryRename(ctx);
        const rmRecursive = vi.fn(inner.fs.rmRecursive.bind(inner.fs));
        const faulting: Context = {
          ...inner,
          fs: {
            ...inner.fs,
            rmRecursive,
            mkdir: async (path: string) => {
              if (path === work(ctx, 'e')) throw permissionDenied(path);
              return inner.fs.mkdir(path);
            },
          },
        };
        const sut = mv;

        // Act
        await sut(faulting, ['d'], 'e', { skipErrors: true });

        // Assert
        const removed = rmRecursive.mock.calls.map(([path]) => path);
        expect(removed).toContain(work(ctx, 'd'));
        expect(removed).not.toContain(work(ctx, 'e'));
      });
    });
  });

  describe('Given the same fixture as the partial move and no skipErrors', () => {
    describe('When mv(d, e)', () => {
      it('Then it rejects with the fault, the index is unchanged and the partial move stays', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'd/f': 'f', 'd/g': 'g' });
        const fault = permissionDenied('/abs/x');
        const faulting = faultOnRename(ctx, { at: 2, fault });
        const sut = mv;

        // Act
        const outcome = sut(faulting, ['d'], 'e');

        // Assert
        await expect(outcome).rejects.toBe(fault);
        expect((await indexView(ctx)).map(([path]) => path)).toEqual(['d/f', 'd/g']);
        expect(await exists(ctx, 'e/f')).toBe(true);
        expect(await exists(ctx, 'd/g')).toBe(true);
      });
    });
  });
});

describe('mv — a destination that differs only in case', () => {
  const aliasing = (ctx: Context, alias: string, real: string): Context => ({
    ...ctx,
    fs: {
      ...ctx.fs,
      lstat: async (path: string) => {
        const aliased = work(ctx, alias);
        const mapped =
          path === aliased || path.startsWith(`${aliased}/`)
            ? work(ctx, real) + path.slice(aliased.length)
            : path;
        return ctx.fs.lstat(mapped);
      },
    },
  });
  const setIgnoreCase = (ctx: Context, value: string): Promise<void> =>
    updateConfigEntries(ctx, [{ section: 'core', key: 'ignorecase', value }]);

  describe('Given core.ignorecase true and F aliasing f', () => {
    describe('When mv(f, F)', () => {
      it('Then the index holds F, not f, and the disk holds F', async () => {
        // Arrange
        const ctx = await seedAndStage({ f: 'f' });
        await setIgnoreCase(ctx, 'true');
        const sut = mv;

        // Act
        await sut(aliasing(ctx, 'F', 'f'), ['f'], 'F');

        // Assert
        expect((await readIndex(ctx)).entries.map((e) => e.path)).toEqual(['F']);
        expect(await exists(ctx, 'F')).toBe(true);
        expect(await exists(ctx, 'f')).toBe(false);
      });
    });
  });

  describe.each([
    { label: 'false', configure: (ctx: Context) => setIgnoreCase(ctx, 'false') },
    { label: 'absent', configure: async () => undefined },
  ])('Given core.ignorecase $label and F aliasing f', ({ configure }) => {
    describe('When mv(f, F)', () => {
      it('Then it refuses MV_DESTINATION_EXISTS and the index is unchanged', async () => {
        // Arrange
        const ctx = await seedAndStage({ f: 'f' });
        await configure(ctx);
        const sut = mv;

        // Act
        const error = await expectError(
          () => sut(aliasing(ctx, 'F', 'f'), ['f'], 'F'),
          'MV_DESTINATION_EXISTS',
        );

        // Assert
        expect(error.data).toMatchObject({ source: 'f', destination: 'F' });
        expect((await readIndex(ctx)).entries.map((e) => e.path)).toEqual(['f']);
      });
    });
  });

  describe('Given core.ignorecase true and an untracked G that is not a case variant', () => {
    describe('When mv(f, G)', () => {
      it('Then it refuses MV_DESTINATION_EXISTS and leaves G untouched', async () => {
        // Arrange
        const ctx = await seedAndStage({ f: 'f' });
        await ctx.fs.writeUtf8(work(ctx, 'G'), 'g');
        await setIgnoreCase(ctx, 'true');
        const sut = mv;

        // Act
        const error = await expectError(() => sut(ctx, ['f'], 'G'), 'MV_DESTINATION_EXISTS');

        // Assert
        expect(error.data).toMatchObject({ source: 'f', destination: 'G' });
        expect(await ctx.fs.readUtf8(work(ctx, 'G'))).toBe('g');
      });
    });
  });

  describe('Given core.ignorecase true, a directory a/d and A aliasing a', () => {
    describe('When mv(a/d, A)', () => {
      it('Then it refuses MV_DESTINATION_EXISTS with index and disk unchanged', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a/d/x': 'x' });
        await setIgnoreCase(ctx, 'true');
        const sut = mv;

        // Act
        const error = await expectError(
          () => sut(aliasing(ctx, 'A', 'a'), ['a/d'], 'A'),
          'MV_DESTINATION_EXISTS',
        );

        // Assert
        expect(error.data).toMatchObject({ source: 'a/d', destination: 'A/d' });
        expect((await readIndex(ctx)).entries.map((e) => e.path)).toEqual(['a/d/x']);
        expect(await exists(ctx, 'a/d/x')).toBe(true);
      });
    });
  });

  describe('Given core.ignorecase true and A aliasing a', () => {
    describe('When mv(a/g, A)', () => {
      it('Then a/g moves to A/g', async () => {
        // Arrange
        const ctx = await seedAndStage({ 'a/g': 'g' });
        await setIgnoreCase(ctx, 'true');
        const sut = mv;

        // Act
        await sut(aliasing(ctx, 'A', 'a'), ['a/g'], 'A');

        // Assert
        expect((await readIndex(ctx)).entries.map((e) => e.path)).toEqual(['A/g']);
      });
    });
  });
});

describe('mv — a destination beyond a symbolic link', () => {
  const TREE = {
    f: 'f',
    g: 'g',
    'dir/a': 'a',
    'dir/b': 'b',
    'sub/keep': 'k',
    'sub/sub2/k': 'k2',
  };

  const seedLinked = async (): Promise<Context> => {
    const ctx = await seedAndStage(TREE);
    await ctx.fs.symlink('sub', work(ctx, 'inner'));
    await ctx.fs.symlink('inner', work(ctx, 'deep'));
    await ctx.fs.symlink('nowhere', work(ctx, 'dang'));
    await ctx.fs.symlink('f', work(ctx, 'pointer'));
    return ctx;
  };

  const indexPaths = async (ctx: Context): Promise<ReadonlyArray<string>> =>
    (await readIndex(ctx)).entries.map((e) => e.path);

  const failingDirectoryRename = (ctx: Context, fault: TsgitError): Context => ({
    ...ctx,
    fs: {
      ...ctx.fs,
      renameDirectory: async () => {
        throw fault;
      },
    },
  });

  describe.each([
    { label: 'a link at the parent', target: 'inner/g', opts: {} },
    { label: 'a deeper link', target: 'deep/inner/g', opts: {} },
    { label: 'a dangling link', target: 'dang/x', opts: {} },
    { label: 'a link to a file', target: 'pointer/x', opts: {} },
    { label: 'a missing path below the link', target: 'inner/absent/x', opts: {} },
    { label: 'force', target: 'inner/g', opts: { force: true } },
    { label: 'dryRun', target: 'inner/g', opts: { dryRun: true } },
  ])('Given a file and $label', ({ target, opts }) => {
    describe('When mv', () => {
      it('Then it refuses naming source and destination and changes nothing', async () => {
        // Arrange
        const ctx = await seedLinked();
        const sut = mv;

        // Act
        const err = await captureError(() => sut(ctx, ['f'], target, opts));

        // Assert
        expect(err?.data).toMatchObject({
          code: 'MV_DESTINATION_BEYOND_SYMLINK',
          source: 'f',
          destination: target,
        });
        expect(await indexPaths(ctx)).toContain('f');
        expect(await exists(ctx, 'f')).toBe(true);
      });
    });
  });

  describe('Given a directory and a link at the destination parent', () => {
    describe('When mv', () => {
      it('Then it names the first member and its repathed destination', async () => {
        // Arrange
        const ctx = await seedLinked();
        const sut = mv;

        // Act
        const err = await captureError(() => sut(ctx, ['dir'], 'inner/x'));

        // Assert
        expect(err?.data).toMatchObject({
          code: 'MV_DESTINATION_BEYOND_SYMLINK',
          source: 'dir/a',
          destination: 'inner/x/a',
        });
        expect(await exists(ctx, 'dir/a')).toBe(true);
        expect(await indexPaths(ctx)).toContain('dir/a');
      });
    });
  });

  describe('Given skipErrors and a file beyond a link', () => {
    describe.each([{ dryRun: false }, { dryRun: true }])(
      'When mv with dryRun $dryRun',
      ({ dryRun }) => {
        it('Then the file is skipped and nothing is written', async () => {
          // Arrange
          const ctx = await seedLinked();
          const sut = mv;

          // Act
          const result = await sut(ctx, ['f'], 'inner/g', { skipErrors: true, dryRun });

          // Assert
          expect(result).toEqual({
            moved: [],
            skipped: [{ source: 'f', reason: 'destination-beyond-symlink' }],
          });
          expect(await exists(ctx, 'f')).toBe(true);
          expect(await exists(ctx, 'sub/g')).toBe(false);
        });
      },
    );
  });

  describe('Given skipErrors and a directory beyond a link', () => {
    describe('When mv', () => {
      it('Then the directory is renamed, its members skip and stay indexed', async () => {
        // Arrange
        const ctx = await seedLinked();
        const sut = mv;

        // Act
        const result = await sut(ctx, ['dir'], 'inner/x', { skipErrors: true });

        // Assert
        expect(result).toEqual({
          moved: [],
          skipped: [
            { source: 'dir/a', reason: 'destination-beyond-symlink' },
            { source: 'dir/b', reason: 'destination-beyond-symlink' },
          ],
        });
        expect(await indexPaths(ctx)).toEqual(expect.arrayContaining(['dir/a', 'dir/b']));
        expect(await exists(ctx, 'dir')).toBe(false);
      });
    });

    describe('When mv with dryRun', () => {
      it('Then the same result is reported and nothing is written', async () => {
        // Arrange
        const ctx = await seedLinked();
        const sut = mv;

        // Act
        const result = await sut(ctx, ['dir'], 'inner/x', { skipErrors: true, dryRun: true });

        // Assert
        expect(result.skipped.map((s) => s.source)).toEqual(['dir/a', 'dir/b']);
        expect(await exists(ctx, 'dir/a')).toBe(true);
      });
    });

    describe('When mv names a second, untracked source', () => {
      it('Then the member skips, then the untracked source', async () => {
        // Arrange
        const ctx = await seedLinked();
        const sut = mv;

        // Act
        const result = await sut(ctx, ['dir', 'ghost'], 'inner/sub2', { skipErrors: true });

        // Assert
        expect(result.moved).toEqual([]);
        expect(result.skipped).toEqual([
          { source: 'dir/a', reason: 'destination-beyond-symlink' },
          { source: 'dir/b', reason: 'destination-beyond-symlink' },
          { source: 'ghost', reason: 'source-not-tracked' },
        ]);
      });
    });

    describe('When the directory rename is refused', () => {
      it('Then rename-failed ends the skips and the directory stays', async () => {
        // Arrange
        const ctx = await seedLinked();
        const refusing = failingDirectoryRename(ctx, pathTooLong('/abs/dir'));
        const sut = mv;

        // Act
        const result = await sut(refusing, ['dir'], 'inner/x', { skipErrors: true });

        // Assert
        expect(result.skipped.at(-1)).toEqual({ source: 'dir', reason: 'rename-failed' });
        expect(await exists(ctx, 'dir/a')).toBe(true);
        expect(await exists(ctx, 'dir/b')).toBe(true);
        expect(await exists(ctx, 'sub/x')).toBe(false);
      });
    });
  });

  describe('Given an existing destination reached through a link', () => {
    describe.each([{ force: false }, { force: true }])('When mv with force $force', ({ force }) => {
      it('Then it is not this refusal', async () => {
        // Arrange
        const ctx = await seedLinked();
        const sut = mv;

        // Act
        const err = await captureError(() => sut(ctx, ['dir'], 'inner/keep', { force }));

        // Assert
        expect(err?.data.code).toBe('MV_DESTINATION_DIRECTORY_MISSING');
      });
    });
  });

  describe('Given checks that precede the link check', () => {
    describe('When a directory moves under itself through a link', () => {
      it('Then it is MV_INTO_SELF', async () => {
        // Arrange
        const ctx = await seedAndStage(TREE);
        await ctx.fs.symlink('sub', work(ctx, 'dir/l'));
        const sut = mv;

        // Act
        const err = await captureError(() => sut(ctx, ['dir'], 'dir/l/x'));

        // Assert
        expect(err?.data.code).toBe('MV_INTO_SELF');
      });
    });

    describe('When the source is untracked but present', () => {
      it('Then it is MV_SOURCE_NOT_TRACKED', async () => {
        // Arrange
        const ctx = await seedLinked();
        await ctx.fs.writeUtf8(work(ctx, 'u'), 'u');
        const sut = mv;

        // Act
        const err = await captureError(() => sut(ctx, ['u'], 'inner/u'));

        // Assert
        expect(err?.data.code).toBe('MV_SOURCE_NOT_TRACKED');
      });
    });

    describe('When a leading component is a regular file', () => {
      it('Then it is MV_DESTINATION_DIRECTORY_MISSING', async () => {
        // Arrange
        const ctx = await seedLinked();
        const sut = mv;

        // Act
        const err = await captureError(() => sut(ctx, ['dir'], 'sub/keep/x'));

        // Assert
        expect(err?.data.code).toBe('MV_DESTINATION_DIRECTORY_MISSING');
      });
    });
  });

  describe('Given a file system that refuses to name the link as too long', () => {
    describe('When mv', () => {
      it('Then the scan tolerates it and the parent is reported missing', async () => {
        // Arrange
        const ctx = await seedLinked();
        const inner = work(ctx, 'inner');
        const stubbed: Context = {
          ...ctx,
          fs: {
            ...ctx.fs,
            lstat: async (path: string) => {
              if (path === inner) throw pathTooLong(path);
              return ctx.fs.lstat(path);
            },
          },
        };
        const sut = mv;

        // Act
        const err = await captureError(() => sut(stubbed, ['f'], 'inner/g'));

        // Assert
        expect(err?.data.code).toBe('MV_DESTINATION_DIRECTORY_MISSING');
      });
    });
  });

  describe('Given a trailing slash on a destination beyond a link', () => {
    describe('When a file moves to a linked directory', () => {
      it('Then the destination is the joined path', async () => {
        // Arrange
        const ctx = await seedLinked();
        const sut = mv;

        // Act
        const err = await captureError(() => sut(ctx, ['f'], 'inner/'));

        // Assert
        expect(err?.data).toMatchObject({
          code: 'MV_DESTINATION_BEYOND_SYMLINK',
          source: 'f',
          destination: 'inner/f',
        });
      });
    });

    describe('When skipErrors moves a directory to a linked directory', () => {
      it('Then the directory is renamed and its members skip', async () => {
        // Arrange
        const ctx = await seedLinked();
        const sut = mv;

        // Act
        const result = await sut(ctx, ['dir'], 'inner/', { skipErrors: true });

        // Assert
        expect(result.skipped.map((s) => s.source)).toEqual(['dir/a', 'dir/b']);
        expect(await exists(ctx, 'dir')).toBe(false);
      });
    });

    describe.each([{ link: 'dang' }, { link: 'pointer' }])(
      'When the destination is $link/',
      ({ link }) => {
        it('Then it is MV_DESTINATION_DIRECTORY_MISSING naming the slash form', async () => {
          // Arrange
          const ctx = await seedLinked();
          const sut = mv;

          // Act
          const err = await captureError(() => sut(ctx, ['f'], `${link}/`));

          // Assert
          expect(err?.data).toMatchObject({
            code: 'MV_DESTINATION_DIRECTORY_MISSING',
            destination: `${link}/`,
          });
        });
      },
    );

    describe('When two files move to a link without the slash', () => {
      it('Then it is MV_DESTINATION_NOT_DIRECTORY', async () => {
        // Arrange
        const ctx = await seedLinked();
        const sut = mv;

        // Act
        const err = await captureError(() => sut(ctx, ['f', 'g'], 'inner'));

        // Assert
        expect(err?.data.code).toBe('MV_DESTINATION_NOT_DIRECTORY');
      });
    });
  });
});
