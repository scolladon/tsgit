import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { removeEmptyDirectory } from '../../../../../src/application/primitives/internal/empty-directories.js';
import { permissionDenied, type TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';

describe('internal/empty-directories', () => {
  describe('removeEmptyDirectory', () => {
    describe('Given a directory that still holds an entry', () => {
      describe('When removeEmptyDirectory runs', () => {
        it('Then it reports the directory as not removable and leaves it standing', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const dir = `${ctx.layout.gitDir}/keep`;
          await ctx.fs.writeUtf8(`${dir}/child`, 'x');
          const sut = removeEmptyDirectory;

          // Act
          const result = await sut(ctx, dir);

          // Assert
          expect(result).toBe(false);
          expect(await ctx.fs.exists(`${dir}/child`)).toBe(true);
        });
      });
    });

    describe('Given a directory that is already gone', () => {
      describe('When removeEmptyDirectory runs', () => {
        it('Then it reports the directory as not removable rather than refusing', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const sut = removeEmptyDirectory;

          // Act
          const result = await sut(ctx, `${ctx.layout.gitDir}/absent`);

          // Assert
          expect(result).toBe(false);
        });
      });
    });

    describe('Given an empty directory', () => {
      describe('When removeEmptyDirectory runs', () => {
        it('Then it reports the removal and the directory is gone', async () => {
          // Arrange
          const ctx = createMemoryContext();
          const dir = `${ctx.layout.gitDir}/gone`;
          await ctx.fs.mkdir(dir);
          const sut = removeEmptyDirectory;

          // Act
          const result = await sut(ctx, dir);

          // Assert
          expect(result).toBe(true);
          expect(await ctx.fs.exists(dir)).toBe(false);
        });
      });
    });

    describe('Given a removal that fails for a reason other than non-emptiness or absence', () => {
      describe('When removeEmptyDirectory runs', () => {
        it('Then that refusal propagates instead of reading as not removable', async () => {
          // Arrange
          const base = createMemoryContext();
          const dir = `${base.layout.gitDir}/guarded`;
          await base.fs.mkdir(dir);
          const ctx: Context = {
            ...base,
            fs: {
              ...base.fs,
              rm: async (path: string) => {
                if (path === dir) throw permissionDenied(path);
                return base.fs.rm(path);
              },
            },
          };
          const sut = removeEmptyDirectory;

          // Act
          const refusal = await sut(ctx, dir).catch((err: TsgitError) => err.data);

          // Assert
          expect(refusal).toEqual({ code: 'PERMISSION_DENIED', path: dir });
        });
      });
    });
  });
});
