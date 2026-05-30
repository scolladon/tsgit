import { describe, expect, it } from 'vitest';
import {
  parentDir,
  removeWorkingTreeFile,
  writeWorkingTreeFile,
} from '../../../../../src/application/primitives/internal/write-working-tree-file.js';
import type { FilePath } from '../../../../../src/domain/objects/index.js';
import { buildSeededContext } from '../fixtures.js';

describe('write-working-tree-file', () => {
  describe('parentDir', () => {
    describe('Given a nested path', () => {
      describe('When the parent is computed', () => {
        it('Then it returns the directory portion', () => {
          // Arrange + Act + Assert
          expect(parentDir('/work/dir/a.txt')).toBe('/work/dir');
        });
      });
    });

    describe('Given a root-level path', () => {
      describe('When the parent is computed', () => {
        it('Then it returns undefined (no parent to create)', () => {
          // Arrange + Act + Assert — the leading-slash-only case (lastSlash === 0).
          expect(parentDir('/foo')).toBeUndefined();
        });
      });
    });

    describe('Given a path with no slash', () => {
      describe('When the parent is computed', () => {
        it('Then it returns undefined', () => {
          // Arrange + Act + Assert
          expect(parentDir('foo')).toBeUndefined();
        });
      });
    });
  });

  describe('writeWorkingTreeFile', () => {
    describe('Given a nested path whose parent does not exist', () => {
      describe('When the file is written', () => {
        it('Then the parent directory is created and the bytes land', async () => {
          // Arrange
          const ctx = await buildSeededContext();

          // Act
          await writeWorkingTreeFile(ctx, 'nested/deep/a.txt' as FilePath, new Uint8Array([7]));

          // Assert
          const bytes = await ctx.fs.read(`${ctx.layout.workDir}/nested/deep/a.txt`);
          expect([...bytes]).toEqual([7]);
        });
      });
    });
  });

  describe('removeWorkingTreeFile', () => {
    describe('Given an existing working file', () => {
      describe('When it is removed', () => {
        it('Then the file is gone', async () => {
          // Arrange
          const ctx = await buildSeededContext();
          await ctx.fs.write(`${ctx.layout.workDir}/a.txt`, new Uint8Array([1]));

          // Act
          await removeWorkingTreeFile(ctx, 'a.txt' as FilePath);

          // Assert
          expect(await ctx.fs.exists(`${ctx.layout.workDir}/a.txt`)).toBe(false);
        });
      });
    });

    describe('Given an absent working file', () => {
      describe('When it is removed', () => {
        it('Then it is a no-op (no throw)', async () => {
          // Arrange
          const ctx = await buildSeededContext();

          // Act + Assert — must not throw on a missing file.
          await expect(
            removeWorkingTreeFile(ctx, 'missing.txt' as FilePath),
          ).resolves.toBeUndefined();
        });
      });
    });
  });
});
