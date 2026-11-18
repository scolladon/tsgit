import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  removeEmptyDirectory,
  removeIfEmptyDirectory,
} from '../../../../../src/application/primitives/internal/empty-directories.js';
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
              rmdir: async (path: string) => {
                if (path === dir) throw permissionDenied(path);
                return base.fs.rmdir?.(path);
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

describe('internal/empty-directories without the optional rmdir', () => {
  const withoutRmdir = (base: Context): Context => {
    const { rmdir: _omitted, ...rest } = base.fs;
    return { ...base, fs: rest };
  };

  describe('Given a port without rmdir and an empty directory', () => {
    describe('When removeEmptyDirectory runs', () => {
      it('Then it removes the directory through rm', async () => {
        // Arrange
        const base = createMemoryContext();
        const dir = `${base.layout.gitDir}/fallback`;
        await base.fs.mkdir(dir);
        const ctx = withoutRmdir(base);
        const sut = removeEmptyDirectory;

        // Act
        const result = await sut(ctx, dir);

        // Assert
        expect(result).toBe(true);
        expect(await base.fs.exists(dir)).toBe(false);
      });
    });
  });

  describe('Given a path holding a file', () => {
    describe('When removeEmptyDirectory runs', () => {
      it('Then it reports the path as not removable and keeps the file', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const file = `${ctx.layout.gitDir}/plain`;
        await ctx.fs.writeUtf8(file, 'x');
        const sut = removeEmptyDirectory;

        // Act
        const result = await sut(ctx, file);

        // Assert
        expect(result).toBe(false);
        expect(await ctx.fs.exists(file)).toBe(true);
      });
    });
  });
});

describe('internal/empty-directories removeIfEmptyDirectory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const withoutRmdir = (base: Context): Context => {
    const { rmdir: _omitted, ...rest } = base.fs;
    return { ...base, fs: rest };
  };

  describe('Given a port without rmdir and a regular file', () => {
    describe('When removeIfEmptyDirectory runs', () => {
      it('Then it reports false and keeps the file', async () => {
        // Arrange
        const base = createMemoryContext();
        const file = `${base.layout.gitDir}/plain`;
        await base.fs.writeUtf8(file, 'mine');
        const ctx = withoutRmdir(base);
        const sut = removeIfEmptyDirectory;

        // Act
        const result = await sut(ctx, file);

        // Assert
        expect(result).toBe(false);
        expect(await base.fs.readUtf8(file)).toBe('mine');
      });
    });
  });

  describe('Given a port without rmdir and a symlink to an empty directory', () => {
    describe('When removeIfEmptyDirectory runs', () => {
      it('Then it reports false and keeps the link and its target', async () => {
        // Arrange
        const base = createMemoryContext();
        const target = `${base.layout.gitDir}/target`;
        const link = `${base.layout.gitDir}/link`;
        await base.fs.mkdir(target);
        await base.fs.symlink(target, link);
        const ctx = withoutRmdir(base);
        const sut = removeIfEmptyDirectory;

        // Act
        const result = await sut(ctx, link);

        // Assert
        expect(result).toBe(false);
        expect((await base.fs.lstat(link)).isSymbolicLink).toBe(true);
        expect(await base.fs.exists(target)).toBe(true);
      });
    });
  });

  describe('Given a port without rmdir and an empty directory', () => {
    describe('When removeIfEmptyDirectory runs', () => {
      it('Then it removes the directory', async () => {
        // Arrange
        const base = createMemoryContext();
        const dir = `${base.layout.gitDir}/empty`;
        await base.fs.mkdir(dir);
        const ctx = withoutRmdir(base);
        const sut = removeIfEmptyDirectory;

        // Act
        const result = await sut(ctx, dir);

        // Assert
        expect(result).toBe(true);
        expect(await base.fs.exists(dir)).toBe(false);
      });
    });
  });

  describe('Given a port without rmdir and an absent path', () => {
    describe('When removeIfEmptyDirectory runs', () => {
      it('Then it reports false', async () => {
        // Arrange
        const ctx = withoutRmdir(createMemoryContext());
        const sut = removeIfEmptyDirectory;

        // Act
        const result = await sut(ctx, `${ctx.layout.gitDir}/missing`);

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a port with rmdir and a regular file', () => {
    describe('When removeIfEmptyDirectory runs', () => {
      it('Then it asks rmdir once for that exact path and reports false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const file = `${ctx.layout.gitDir}/plain`;
        await ctx.fs.writeUtf8(file, 'mine');
        const rmdir = vi.spyOn(ctx.fs, 'rmdir');
        const sut = removeIfEmptyDirectory;

        // Act
        const result = await sut(ctx, file);

        // Assert
        expect(result).toBe(false);
        expect(rmdir).toHaveBeenCalledTimes(1);
        expect(rmdir).toHaveBeenCalledWith(file);
        expect(await ctx.fs.readUtf8(file)).toBe('mine');
      });
    });
  });
});
