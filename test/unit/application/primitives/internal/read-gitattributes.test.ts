import { describe, expect, it, vi } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  buildAttributeProvider,
  maybeBuildAttributeProvider,
} from '../../../../../src/application/primitives/internal/read-gitattributes.js';
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

// Wraps `lstat` so every probe reports a symbolic link, forcing the
// attributes-file reader to skip the (otherwise valid) root .gitattributes.
const withSymlinkLstat = (ctx: Context): Context => {
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
  return { ...ctx, fs: hostileFs } as Context;
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

  describe('Given a gitattributes configuration that yields a set merge attribute', () => {
    describe('When resolving', () => {
      it.each<{
        label: string;
        path: string;
        homeDir?: string;
        arrange: (ctx: Context) => Promise<void>;
        expected: { set: string };
      }>([
        {
          label: 'only a root .gitattributes: the rule applies',
          path: 'a.txt',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.gitattributes', '*.txt merge=root\n');
          },
          expected: { set: 'root' },
        },
        {
          label:
            'info/attributes and a root .gitattributes both assigning merge: info/attributes wins (highest precedence)',
          path: 'a.txt',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.gitattributes', '*.txt merge=root\n');
            await seed(ctx, '/repo/.git/info/attributes', '*.txt merge=info\n');
          },
          expected: { set: 'info' },
        },
        {
          label: 'a subdirectory and a root .gitattributes: the deeper directory wins',
          path: 'sub/a.txt',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.gitattributes', '* merge=root\n');
            await seed(ctx, '/repo/sub/.gitattributes', '*.txt merge=sub\n');
          },
          expected: { set: 'sub' },
        },
        {
          label:
            'a global core.attributesFile (absolute) and a root .gitattributes: the root wins (global has lowest precedence)',
          path: 'a.txt',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = /repo/global-attrs\n');
            await seed(ctx, '/repo/global-attrs', '* merge=global\n');
            await seed(ctx, '/repo/.gitattributes', '* merge=root\n');
          },
          expected: { set: 'root' },
        },
        {
          label: 'only a global core.attributesFile: the global rule applies',
          path: 'a.txt',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = /repo/global-attrs\n');
            await seed(ctx, '/repo/global-attrs', '* merge=global\n');
          },
          expected: { set: 'global' },
        },
        {
          label:
            'core.attributesFile starting with `~/` and homeDir set: resolves under the home directory',
          path: 'a.txt',
          homeDir: '/repo/home',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = ~/.gitattributes\n');
            await seed(ctx, '/repo/home/.gitattributes', '* merge=home\n');
          },
          expected: { set: 'home' },
        },
        {
          label:
            'core.attributesFile = `~` alone and homeDir set: resolves to the home directory itself',
          path: 'a.txt',
          homeDir: '/repo/home-attrs',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = ~\n');
            await seed(ctx, '/repo/home-attrs', '* merge=tilde\n');
          },
          expected: { set: 'tilde' },
        },
        {
          label:
            'core.attributesFile pointing at a directory: the global source is skipped (non-regular file)',
          path: 'a.txt',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = /repo\n');
            await seed(ctx, '/repo/.gitattributes', '* merge=root\n');
          },
          expected: { set: 'root' },
        },
        {
          label: 'a user macro defined in the root .gitattributes: the macro expansion applies',
          path: 'a.md',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.gitattributes', '[attr]docs merge=union\n*.md docs\n');
          },
          expected: { set: 'union' },
        },
      ])('Then $label', async ({ path, homeDir, arrange, expected }) => {
        // Arrange
        const sut = merge;
        const ctx = createMemoryContext(homeDir === undefined ? {} : { homeDir });
        await arrange(ctx);

        // Act
        const result = await sut(ctx, path);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a gitattributes configuration with no applicable global rule', () => {
    describe('When resolving', () => {
      it.each<{
        label: string;
        arrange: (ctx: Context) => Promise<void>;
        hostile?: boolean;
      }>([
        {
          label: 'core.attributesFile starting with `~/` but homeDir undefined',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = ~/.gitattributes\n');
          },
        },
        {
          label: 'no core.attributesFile is set',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.git/config', '[core]\n  bare = false\n');
          },
        },
        {
          label: 'core.attributesFile = "" (empty, feature-off)',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = \n');
          },
        },
        {
          label: 'lstat reports the root .gitattributes as a symbolic link',
          arrange: async (ctx: Context): Promise<void> => {
            await seed(ctx, '/repo/.gitattributes', '* merge=root\n');
          },
          hostile: true,
        },
      ])(
        "Then the global source is skipped (yields 'unspecified') ($label)",
        async ({ arrange, hostile }) => {
          // Arrange
          const sut = merge;
          const ctx = createMemoryContext();
          await arrange(ctx);
          const target = hostile === true ? withSymlinkLstat(ctx) : ctx;

          // Act
          const result = await sut(target, 'a.txt');

          // Assert
          expect(result).toBe('unspecified');
        },
      );
    });
  });

  describe('Given core.attributesFile = "" (empty, feature-off)', () => {
    describe('When buildAttributeProvider resolves a path', () => {
      it('Then it never lstats the empty path', async () => {
        // Arrange — the memory adapter resolves lstat('') to the rootDir
        // directory, masking a bare unspecified assertion. The behavioral kill
        // is the empty path being short-circuited before reaching resolution.
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.git/config', '[core]\n  attributesFile = \n');
        const lstatSpy = vi.spyOn(ctx.fs, 'lstat');

        // Act
        await (await buildAttributeProvider(ctx)).sourcesForPath('a.txt' as FilePath);

        // Assert
        expect(lstatSpy).not.toHaveBeenCalledWith('');
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

  describe('Given the root .gitattributes pre-seeded into the directory cache at build time', () => {
    describe('When resolving a root-level path after construction', () => {
      it('Then the lookup touches no `.gitattributes` on disk (fully served from the seeded cache)', async () => {
        // Arrange — the provider seeds the cache with the root directory (`''`)
        // at build time, so a later root-level lookup must not re-read or scan
        // any `.gitattributes`, nor scan any spurious ancestor directory.
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.gitattributes', '* merge=root\n');
        const provider = await buildAttributeProvider(ctx);
        const lstatSpy = vi.spyOn(ctx.fs, 'lstat');

        // Act
        await provider.sourcesForPath('a.txt' as FilePath);

        // Assert
        const gitattributesLstats = lstatSpy.mock.calls
          .map(([p]) => p)
          .filter((p) => p.endsWith('.gitattributes'));
        expect(gitattributesLstats).toEqual([]);
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

describe('maybeBuildAttributeProvider', () => {
  describe('Given a context without a command runner (ctx.command is undefined)', () => {
    describe('When maybeBuildAttributeProvider is called', () => {
      it('Then resolves to undefined (no provider built without a runner)', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await maybeBuildAttributeProvider(ctx);

        // Assert — the conditional `ctx.command !== undefined` must be checked:
        // when command is absent the right-hand branch must run, not always-build.
        expect(sut).toBeUndefined();
      });
    });
  });

  describe('Given a context with a command runner', () => {
    describe('When maybeBuildAttributeProvider is called', () => {
      it('Then resolves to a defined AttributeProvider', async () => {
        // Arrange
        const ctx = createMemoryContext({
          command: { run: async () => ({ exitCode: 0 }) },
        });

        // Act
        const sut = await maybeBuildAttributeProvider(ctx);

        // Assert
        expect(sut).toBeDefined();
      });
    });
  });
});
