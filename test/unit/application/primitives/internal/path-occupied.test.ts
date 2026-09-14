import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { pathIsOccupied } from '../../../../../src/application/primitives/internal/path-occupied.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';

describe('internal/path-occupied', () => {
  describe('Given a regular file at the path', () => {
    describe('When pathIsOccupied runs', () => {
      it('Then it reports true', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8('/repo/file.txt', 'content');
        const sut = pathIsOccupied;

        // Act
        const result = await sut(ctx, '/repo/file.txt');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given a dangling symlink at the path', () => {
    describe('When pathIsOccupied runs', () => {
      it('Then it still reports true — an lstat probe sees the link, not its missing target', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.symlink('/nonexistent/target', '/repo/link');
        const sut = pathIsOccupied;

        // Act
        const result = await sut(ctx, '/repo/link');

        // Assert
        expect(result).toBe(true);
      });
    });
  });

  describe('Given no entry at the path', () => {
    describe('When pathIsOccupied runs', () => {
      it('Then it reports false', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const sut = pathIsOccupied;

        // Act
        const result = await sut(ctx, '/repo/missing.txt');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given lstat fails with a fault other than FILE_NOT_FOUND', () => {
    describe('When pathIsOccupied runs', () => {
      it('Then the fault propagates instead of being read as absent', async () => {
        // Arrange
        const base = createMemoryContext();
        const target = '/repo/unreadable.txt';
        const ctx: Context = {
          ...base,
          fs: {
            ...base.fs,
            lstat: async (p: string) => {
              if (p === target) throw new TsgitError({ code: 'PERMISSION_DENIED', path: p });
              return base.fs.lstat(p);
            },
          },
        };
        const sut = pathIsOccupied;

        // Act
        let caught: unknown;
        try {
          await sut(ctx, target);
          expect.unreachable();
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data.code).toBe('PERMISSION_DENIED');
      });
    });
  });
});
