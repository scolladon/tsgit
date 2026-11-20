import { describe, expect, it } from 'vitest';
import { checkOutSkippedChanges } from '../../../../../src/application/commands/internal/check-out-skipped-changes.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import type { IndexEntry } from '../../../../../src/domain/git-index/index.js';
import { STAGE0_FLAGS } from '../../../../../src/domain/git-index/index.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FileMode, FilePath, ObjectId } from '../../../../../src/domain/objects/index.js';
import type { Context } from '../../../../../src/ports/context.js';
import { buildSeededContext } from '../../primitives/fixtures.js';

const writeBlob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const entryOf = (
  path: string,
  id: ObjectId,
  {
    mode = FILE_MODE.REGULAR,
    skipWorktree = false,
  }: { mode?: FileMode; skipWorktree?: boolean } = {},
): IndexEntry => ({
  ctimeSeconds: 0,
  ctimeNanoseconds: 0,
  mtimeSeconds: 0,
  mtimeNanoseconds: 0,
  dev: 0,
  ino: 0,
  mode,
  uid: 0,
  gid: 0,
  fileSize: 0,
  id,
  flags: { ...STAGE0_FLAGS, skipWorktree },
  path: path as FilePath,
});

const workPath = (ctx: Context, path: string): string => `${ctx.layout.workDir}/${path}`;
const readWork = async (ctx: Context, path: string): Promise<string> =>
  new TextDecoder().decode(await ctx.fs.read(workPath(ctx, path)));

describe('checkOutSkippedChanges', () => {
  const sut = checkOutSkippedChanges;

  describe('Given a skip-worktree entry whose blob differs from the previous index', () => {
    describe('When the skipped changes are checked out', () => {
      it('Then the file holds the blob and the entry loses its bit and records the size', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const v1 = await writeBlob(ctx, 'one\n');
        const v2 = await writeBlob(ctx, 'two two\n');

        // Act
        const result = await sut(
          ctx,
          [entryOf('a/f', v2, { skipWorktree: true })],
          [entryOf('a/f', v1, { skipWorktree: true })],
        );

        // Assert
        expect(await readWork(ctx, 'a/f')).toBe('two two\n');
        expect(result).toHaveLength(1);
        expect(result[0]?.flags.skipWorktree).toBe(false);
        expect(result[0]?.id).toBe(v2);
        expect(result[0]?.fileSize).toBe(8);
      });
    });
  });

  describe('Given a pre-merge entry without the bit and a merged entry the merge hid with a new blob', () => {
    describe('When the skipped changes are checked out', () => {
      it('Then nothing is written and the entry loses its bit', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const v1 = await writeBlob(ctx, 'one\n');
        const v2 = await writeBlob(ctx, 'two two\n');

        // Act
        const result = await sut(
          ctx,
          [entryOf('a/f', v2, { skipWorktree: true })],
          [entryOf('a/f', v1)],
        );

        // Assert
        expect(await ctx.fs.exists(workPath(ctx, 'a/f'))).toBe(false);
        expect(result).toHaveLength(1);
        expect(result[0]?.flags.skipWorktree).toBe(false);
        expect(result[0]?.id).toBe(v2);
        expect(result[0]?.fileSize).toBe(0);
      });
    });
  });

  describe('Given a skip-worktree entry absent from the previous index', () => {
    describe('When the skipped changes are checked out', () => {
      it('Then the file is written and the bit cleared', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const v1 = await writeBlob(ctx, 'new\n');

        // Act
        const result = await sut(ctx, [entryOf('a/n', v1, { skipWorktree: true })], []);

        // Assert
        expect(await readWork(ctx, 'a/n')).toBe('new\n');
        expect(result[0]?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given a skip-worktree entry identical to the previous index', () => {
    describe('When the skipped changes are checked out', () => {
      it('Then nothing is written and the entry is returned as it was', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const v1 = await writeBlob(ctx, 'one\n');
        const entry = entryOf('a/f', v1, { skipWorktree: true });

        // Act
        const result = await sut(ctx, [entry], [entry]);

        // Assert
        expect(await ctx.fs.exists(workPath(ctx, 'a/f'))).toBe(false);
        expect(result).toEqual([entry]);
      });
    });
  });

  describe('Given a skip-worktree entry whose only change is the mode', () => {
    describe('When the skipped changes are checked out', () => {
      it('Then the file is written and the bit cleared', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const v1 = await writeBlob(ctx, 'one\n');

        // Act
        const result = await sut(
          ctx,
          [entryOf('a/f', v1, { mode: FILE_MODE.EXECUTABLE, skipWorktree: true })],
          [entryOf('a/f', v1, { skipWorktree: true })],
        );

        // Assert
        expect(await readWork(ctx, 'a/f')).toBe('one\n');
        expect(result[0]?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given a changed entry that is not skip-worktree', () => {
    describe('When the skipped changes are checked out', () => {
      it('Then nothing is written and the entry is returned as it was', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const v1 = await writeBlob(ctx, 'one\n');
        const v2 = await writeBlob(ctx, 'two\n');
        const entry = entryOf('a/f', v2);

        // Act
        const result = await sut(ctx, [entry], [entryOf('a/f', v1)]);

        // Assert
        expect(await ctx.fs.exists(workPath(ctx, 'a/f'))).toBe(false);
        expect(result).toEqual([entry]);
      });
    });
  });

  describe('Given a changed skip-worktree symlink entry', () => {
    describe('When the skipped changes are checked out', () => {
      it('Then the link is created, the stat stays zero and the bit is cleared', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const target = await writeBlob(ctx, 'dest');

        // Act
        const result = await sut(
          ctx,
          [entryOf('a/l', target, { mode: FILE_MODE.SYMLINK, skipWorktree: true })],
          [],
        );

        // Assert
        expect(await ctx.fs.readlink(workPath(ctx, 'a/l'))).toBe('dest');
        expect(result[0]?.fileSize).toBe(0);
        expect(result[0]?.flags.skipWorktree).toBe(false);
      });
    });
  });

  describe('Given merged entries carrying a gitattributes blob that sets eol=crlf', () => {
    describe('When a skipped change is checked out', () => {
      it('Then the written file has CRLF line endings', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const attributes = await writeBlob(ctx, '* text eol=crlf\n');
        const content = await writeBlob(ctx, 'a\nb\n');

        // Act
        await sut(
          ctx,
          [entryOf('.gitattributes', attributes), entryOf('a/f', content, { skipWorktree: true })],
          [entryOf('.gitattributes', attributes)],
        );

        // Assert
        expect(await readWork(ctx, 'a/f')).toBe('a\r\nb\r\n');
      });
    });
  });
});
