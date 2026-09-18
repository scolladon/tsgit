import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { pathIsOccupied } from '../../../../../src/application/primitives/internal/path-occupied.js';
import { TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { FileSystem } from '../../../../../src/ports/file-system.js';

/** The same context with the optional presence probe removed, as an adapter omitting it has. */
function withoutLexists(ctx: Context): Context {
  const { lexists: _omitted, ...fs } = ctx.fs;
  return { ...ctx, fs };
}

const contexts: ReadonlyArray<{ readonly probe: string; readonly build: () => Context }> = [
  { probe: 'lexists', build: () => createMemoryContext() },
  { probe: 'the lstat fallback', build: () => withoutLexists(createMemoryContext()) },
];

describe('internal/path-occupied', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(contexts)('Given a file system answering through $probe', ({ build }) => {
    describe('When pathIsOccupied runs on a regular file', () => {
      it('Then it reports true', async () => {
        // Arrange
        const ctx = build();
        await ctx.fs.writeUtf8('/repo/file.txt', 'content');
        const sut = pathIsOccupied;

        // Act
        const result = await sut(ctx, '/repo/file.txt');

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When pathIsOccupied runs on a dangling symlink', () => {
      it('Then it still reports true — the probe sees the link, not its missing target', async () => {
        // Arrange
        const ctx = build();
        await ctx.fs.symlink('/nonexistent/target', '/repo/link');
        const sut = pathIsOccupied;

        // Act
        const result = await sut(ctx, '/repo/link');

        // Assert
        expect(result).toBe(true);
      });
    });

    describe('When pathIsOccupied runs on a path with no entry', () => {
      it('Then it reports false', async () => {
        // Arrange
        const ctx = build();
        const sut = pathIsOccupied;

        // Act
        const result = await sut(ctx, '/repo/missing.txt');

        // Assert
        expect(result).toBe(false);
      });
    });
  });

  describe('Given a file system providing lexists', () => {
    describe('When pathIsOccupied runs on a present and an absent path', () => {
      it('Then it answers from lexists without calling lstat', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.writeUtf8('/repo/file.txt', 'content');
        const lstat = vi.spyOn(ctx.fs, 'lstat');
        const sut = pathIsOccupied;

        // Act
        const result = [await sut(ctx, '/repo/file.txt'), await sut(ctx, '/repo/missing.txt')];

        // Assert
        expect(result).toEqual([true, false]);
        expect(lstat).not.toHaveBeenCalled();
      });
    });
  });

  const faultingProbes: ReadonlyArray<{
    readonly probe: string;
    readonly build: (base: Context, target: string) => Context;
  }> = [
    {
      probe: 'lexists',
      build: (base, target) => {
        const lexists: FileSystem['lexists'] = async (p) => {
          if (p === target) throw new TsgitError({ code: 'PERMISSION_DENIED', path: p });
          return false;
        };
        return { ...base, fs: { ...base.fs, lexists } };
      },
    },
    {
      probe: 'the lstat fallback',
      build: (base, target) => {
        const bare = withoutLexists(base);
        const lstat: FileSystem['lstat'] = async (p) => {
          if (p === target) throw new TsgitError({ code: 'PERMISSION_DENIED', path: p });
          return bare.fs.lstat(p);
        };
        return { ...bare, fs: { ...bare.fs, lstat } };
      },
    },
  ];

  describe.each(faultingProbes)(
    'Given $probe fails with a fault other than absence',
    ({ build }) => {
      describe('When pathIsOccupied runs', () => {
        it('Then the fault propagates instead of being read as absent', async () => {
          // Arrange
          const target = '/repo/unreadable.txt';
          const ctx = build(createMemoryContext(), target);
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
          const data = (caught as TsgitError).data;
          expect(data.code).toBe('PERMISSION_DENIED');
          if (data.code === 'PERMISSION_DENIED') expect(data.path).toBe(target);
        });
      });
    },
  );
});
