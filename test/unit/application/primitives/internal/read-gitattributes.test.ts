import { describe, expect, it, vi } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { buildAttributeProvider } from '../../../../../src/application/primitives/internal/read-gitattributes.js';
import { MAX_GITATTRIBUTES_BYTES } from '../../../../../src/application/primitives/types.js';
import { resolveAttribute } from '../../../../../src/domain/attributes/index.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { FilePath } from '../../../../../src/domain/objects/object-id.js';
import type { Context } from '../../../../../src/ports/context.js';

const seed = async (ctx: Context, path: string, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(path, content);
};

const merge = async (ctx: Context, path: string) => {
  const { sources, macros } = await (await buildAttributeProvider(ctx)).sourcesForPath(
    path as FilePath,
  );
  return resolveAttribute(sources, path as FilePath, 'merge', macros);
};

describe('buildAttributeProvider', () => {
  describe('Given no attribute files', () => {
    describe('When resolving an attribute', () => {
      it("Then yields 'unspecified' but still exposes the built-in `binary` macro", async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const { sources, macros } = await (await buildAttributeProvider(ctx)).sourcesForPath(
          'a.txt' as FilePath,
        );

        // Assert
        expect(sources).toEqual([]);
        expect(macros.get('binary')?.get('merge')).toBe(false);
      });
    });
  });

  describe('Given only a root .gitattributes', () => {
    describe('When resolving', () => {
      it('Then the rule applies', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.gitattributes', '*.txt merge=root\n');

        // Act
        const sut = await merge(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ set: 'root' });
      });
    });
  });

  describe('Given info/attributes and a root .gitattributes both assigning merge', () => {
    describe('When resolving', () => {
      it('Then info/attributes wins (highest precedence)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.gitattributes', '*.txt merge=root\n');
        await seed(ctx, '/repo/.git/info/attributes', '*.txt merge=info\n');

        // Act
        const sut = await merge(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ set: 'info' });
      });
    });
  });

  describe('Given a subdirectory and a root .gitattributes', () => {
    describe('When resolving a path in the subdirectory', () => {
      it('Then the deeper directory wins', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.gitattributes', '* merge=root\n');
        await seed(ctx, '/repo/sub/.gitattributes', '*.txt merge=sub\n');

        // Act
        const sut = await merge(ctx, 'sub/a.txt');

        // Assert
        expect(sut).toEqual({ set: 'sub' });
      });
    });
  });

  describe('Given a global core.attributesFile (absolute) and a root .gitattributes', () => {
    describe('When resolving', () => {
      it('Then the root wins (global has lowest precedence)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = /repo/global-attrs\n');
        await seed(ctx, '/repo/global-attrs', '* merge=global\n');
        await seed(ctx, '/repo/.gitattributes', '* merge=root\n');

        // Act
        const sut = await merge(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ set: 'root' });
      });
    });
  });

  describe('Given only a global core.attributesFile', () => {
    describe('When resolving', () => {
      it('Then the global rule applies', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = /repo/global-attrs\n');
        await seed(ctx, '/repo/global-attrs', '* merge=global\n');

        // Act
        const sut = await merge(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ set: 'global' });
      });
    });
  });

  describe('Given core.attributesFile = "" (empty string)', () => {
    describe('When resolving', () => {
      it("Then there is no global source ('unspecified') and the empty value is never resolved as a path", async () => {
        // Arrange — a valued-but-empty attributesFile must be feature-off, identical
        // to absent: the empty value must NEVER reach the path loader (which would
        // lstat('') — an ENOENT throw on a real filesystem). Spying on lstat proves
        // the short-circuit fires before resolution.
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = \n');
        const lstat = vi.spyOn(ctx.fs, 'lstat');

        // Act
        const sut = await merge(ctx, 'a.txt');

        // Assert — feature-off, and the empty value was never handed to lstat.
        expect(sut).toBe('unspecified');
        expect(lstat).not.toHaveBeenCalledWith('');
      });
    });
  });

  describe('Given core.attributesFile starting with `~/` and homeDir set', () => {
    describe('When resolving', () => {
      it('Then it resolves under the home directory', async () => {
        // Arrange
        const ctx = createMemoryContext({ homeDir: '/repo/home' });
        await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = ~/.gitattributes\n');
        await seed(ctx, '/repo/home/.gitattributes', '* merge=home\n');

        // Act
        const sut = await merge(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ set: 'home' });
      });
    });
  });

  describe('Given core.attributesFile = `~` alone and homeDir set', () => {
    describe('When resolving', () => {
      it('Then it resolves to the home directory itself', async () => {
        // Arrange
        const ctx = createMemoryContext({ homeDir: '/repo/home-attrs' });
        await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = ~\n');
        await seed(ctx, '/repo/home-attrs', '* merge=tilde\n');

        // Act
        const sut = await merge(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ set: 'tilde' });
      });
    });
  });

  describe('Given core.attributesFile starting with `~/` but homeDir undefined', () => {
    describe('When resolving', () => {
      it("Then the global source is skipped (yields 'unspecified')", async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = ~/.gitattributes\n');

        // Act
        const sut = await merge(ctx, 'a.txt');

        // Assert
        expect(sut).toBe('unspecified');
      });
    });
  });

  describe('Given no core.attributesFile', () => {
    describe('When resolving', () => {
      it("Then there is no global source ('unspecified')", async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.git/config', '[core]\n  bare = false\n');

        // Act
        const sut = await merge(ctx, 'a.txt');

        // Assert
        expect(sut).toBe('unspecified');
      });
    });
  });

  describe('Given a user macro defined in the root .gitattributes', () => {
    describe('When resolving a path the macro matches', () => {
      it('Then the macro expansion applies', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.gitattributes', '[attr]docs merge=union\n*.md docs\n');

        // Act
        const sut = await merge(ctx, 'a.md');

        // Assert
        expect(sut).toEqual({ set: 'union' });
      });
    });
  });

  describe('Given repeated lookups that share directories', () => {
    describe('When sourcesForPath is called twice for the same nested path', () => {
      it('Then each directory `.gitattributes` is read at most once', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.gitattributes', '* merge=root\n');
        await seed(ctx, '/repo/a/.gitattributes', '* merge=a\n');
        await seed(ctx, '/repo/a/b/.gitattributes', '* merge=ab\n');
        const provider = await buildAttributeProvider(ctx);
        const spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        await provider.sourcesForPath('a/b/x.txt' as FilePath);
        await provider.sourcesForPath('a/b/x.txt' as FilePath);

        // Assert — each directory read once across both lookups
        const counts = spy.mock.calls
          .map(([p]) => p)
          .filter((p) => p.endsWith('.gitattributes'))
          .reduce<Record<string, number>>((acc, p) => {
            acc[p] = (acc[p] ?? 0) + 1;
            return acc;
          }, {});
        expect(counts['/repo/a/.gitattributes']).toBe(1);
        expect(counts['/repo/a/b/.gitattributes']).toBe(1);
      });
    });
  });

  describe('Given an attributes file over the size cap', () => {
    describe('When building the provider', () => {
      it('Then it throws GITATTRIBUTES_FILE_TOO_LARGE with the sanitized basename', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.gitattributes', 'x'.repeat(MAX_GITATTRIBUTES_BYTES + 1));

        // Act / Assert
        let caught: TsgitError | undefined;
        try {
          await buildAttributeProvider(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }
        expect(caught?.data).toEqual({
          code: 'GITATTRIBUTES_FILE_TOO_LARGE',
          path: '.gitattributes',
          size: MAX_GITATTRIBUTES_BYTES + 1,
          limit: MAX_GITATTRIBUTES_BYTES,
        });
      });
    });
  });

  describe('Given core.attributesFile pointing at a directory', () => {
    describe('When building the provider', () => {
      it('Then the global source is skipped (non-regular file)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = /repo\n');
        await seed(ctx, '/repo/.gitattributes', '* merge=root\n');

        // Act
        const sut = await merge(ctx, 'a.txt');

        // Assert
        expect(sut).toEqual({ set: 'root' });
      });
    });
  });

  describe('Given lstat reports a symbolic link', () => {
    describe('When building the provider', () => {
      it('Then the attributes file is skipped', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.gitattributes', '* merge=root\n');
        const hostileFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'lstat') {
              return async () => ({
                isFile: true,
                isDirectory: false,
                isSymbolicLink: true,
                size: 10,
                mtimeMs: 0,
                ctimeMs: 0,
                mode: 0o120000,
              });
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const hostileCtx = { ...ctx, fs: hostileFs } as Context;

        // Act
        const sut = await merge(hostileCtx, 'a.txt');

        // Assert
        expect(sut).toBe('unspecified');
      });
    });
  });

  describe('Given lstat throws a non-FILE_NOT_FOUND error', () => {
    describe('When building the provider', () => {
      it('Then the error propagates', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const hostileFs = new Proxy(ctx.fs, {
          get(target, prop, receiver) {
            if (prop === 'lstat') {
              return async () => {
                throw new Error('unexpected I/O failure');
              };
            }
            return Reflect.get(target, prop, receiver);
          },
        });
        const hostileCtx = { ...ctx, fs: hostileFs } as Context;

        // Act / Assert
        let caught: unknown;
        try {
          await buildAttributeProvider(hostileCtx);
        } catch (err) {
          caught = err;
        }
        expect((caught as Error).message).toBe('unexpected I/O failure');
      });
    });
  });
});
