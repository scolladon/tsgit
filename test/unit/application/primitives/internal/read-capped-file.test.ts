import { describe, expect, it } from 'vitest';
import { loadCappedUtf8 } from '../../../../../src/application/primitives/internal/read-capped-file.js';
import { gitignoreFileTooLarge } from '../../../../../src/domain/commands/error.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { FileStat, FileSystem } from '../../../../../src/ports/file-system.js';
import { buildSeededContext } from '../fixtures.js';

const LIMIT = 16;

interface CountedLstat {
  readonly ctx: Context;
  readonly calls: () => number;
}

const withCounter = (
  base: Context,
  fs: FileSystem,
  countingLstat: (p: string) => Promise<FileStat>,
): CountedLstat['ctx'] => ({ ...base, fs: { ...fs, lstat: countingLstat } });

/** The context's fs still provides `tryLstat` — the converted arm. */
const withCountedLstat = (base: Context): CountedLstat => {
  let calls = 0;
  const countingLstat = async (p: string): Promise<FileStat> => {
    calls += 1;
    return base.fs.lstat(p);
  };
  return { ctx: withCounter(base, base.fs, countingLstat), calls: () => calls };
};

/** The context's fs no longer has `tryLstat` at all — the fallback arm. */
const withCountedLstatNoProbe = (base: Context): CountedLstat => {
  let calls = 0;
  const countingLstat = async (p: string): Promise<FileStat> => {
    calls += 1;
    return base.fs.lstat(p);
  };
  const { tryLstat: _tryLstat, ...withoutProbe } = base.fs;
  return { ctx: withCounter(base, withoutProbe, countingLstat), calls: () => calls };
};

describe('loadCappedUtf8', () => {
  describe('Given an absent path', () => {
    describe('When loadCappedUtf8 runs', () => {
      it('Then it resolves undefined', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        const sut = loadCappedUtf8;

        // Act
        const result = await sut(ctx, '/repo/.gitignore', LIMIT, gitignoreFileTooLarge);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a symlink at the path', () => {
    describe('When loadCappedUtf8 runs', () => {
      it('Then it resolves undefined without reading the target', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/target.txt', 'ignored\n');
        await ctx.fs.symlink('/repo/target.txt', '/repo/.gitignore');
        const sut = loadCappedUtf8;

        // Act
        const result = await sut(ctx, '/repo/.gitignore', LIMIT, gitignoreFileTooLarge);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a directory at the path', () => {
    describe('When loadCappedUtf8 runs', () => {
      it('Then it resolves undefined — a directory is not a file', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.mkdir('/repo/.gitignore');
        const sut = loadCappedUtf8;

        // Act
        const result = await sut(ctx, '/repo/.gitignore', LIMIT, gitignoreFileTooLarge);

        // Assert
        expect(result).toBeUndefined();
      });
    });
  });

  describe('Given a file over the size limit', () => {
    describe('When loadCappedUtf8 runs', () => {
      it('Then it throws the caller-supplied tooLarge error', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.gitignore', 'x'.repeat(LIMIT + 1));
        const sut = loadCappedUtf8;

        // Act & Assert
        let caught: unknown;
        try {
          await sut(ctx, '/repo/.gitignore', LIMIT, gitignoreFileTooLarge);
          expect.unreachable();
        } catch (error) {
          caught = error;
        }
        expect((caught as TsgitError).data.code).toBe('GITIGNORE_FILE_TOO_LARGE');
      });
    });
  });

  describe('Given a file within the size limit', () => {
    describe('When loadCappedUtf8 runs', () => {
      it('Then it resolves the file text', async () => {
        // Arrange
        const ctx = await buildSeededContext();
        await ctx.fs.writeUtf8('/repo/.gitignore', '*.log\n');
        const sut = loadCappedUtf8;

        // Act
        const result = await sut(ctx, '/repo/.gitignore', LIMIT, gitignoreFileTooLarge);

        // Assert
        expect(result).toBe('*.log\n');
      });
    });
  });

  describe('Given 200 absent .gitignore paths on a file system that provides tryLstat', () => {
    describe('When loadCappedUtf8 runs on each path', () => {
      it('Then ctx.fs.lstat is never called', async () => {
        // Arrange
        const base = await buildSeededContext();
        const { ctx, calls } = withCountedLstat(base);
        const sut = loadCappedUtf8;

        // Act
        for (let i = 0; i < 200; i += 1) {
          await sut(ctx, `/repo/dir${i}/.gitignore`, LIMIT, gitignoreFileTooLarge);
        }

        // Assert
        expect(calls()).toBe(0);
      });
    });
  });

  describe('Given 200 absent .gitignore paths on a file system without tryLstat', () => {
    describe('When loadCappedUtf8 runs on each path', () => {
      it('Then the fallback answers identically, through 200 lstat calls', async () => {
        // Arrange
        const base = await buildSeededContext();
        const { ctx, calls } = withCountedLstatNoProbe(base);
        const sut = loadCappedUtf8;

        // Act
        const results: Array<string | undefined> = [];
        for (let i = 0; i < 200; i += 1) {
          results.push(await sut(ctx, `/repo/dir${i}/.gitignore`, LIMIT, gitignoreFileTooLarge));
        }

        // Assert
        expect(results.every((result) => result === undefined)).toBe(true);
        expect(calls()).toBe(200);
      });
    });
  });
});
