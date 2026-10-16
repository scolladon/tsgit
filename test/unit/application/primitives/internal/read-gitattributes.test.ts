import { describe, expect, it, vi } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  type AttributeDirection,
  type AttributeProvider,
  attributeBlobLookup,
  buildAttributeProvider,
  buildCheckinAttributeProvider,
} from '../../../../../src/application/primitives/internal/read-gitattributes.js';
import { MAX_GITATTRIBUTES_BYTES } from '../../../../../src/application/primitives/types.js';
import { writeObject } from '../../../../../src/application/primitives/write-object.js';
import { writeTree } from '../../../../../src/application/primitives/write-tree.js';
import { resolveAttribute } from '../../../../../src/domain/attributes/index.js';
import {
  fileNotFound,
  permissionDenied,
  type TsgitError,
} from '../../../../../src/domain/error.js';
import { type IndexEntry, STAGE0_FLAGS } from '../../../../../src/domain/git-index/index-entry.js';
import { FILE_MODE } from '../../../../../src/domain/objects/file-mode.js';
import type { FilePath, ObjectId } from '../../../../../src/domain/objects/object-id.js';
import { treeEntry } from '../../../../../src/domain/objects/tree.js';
import type { Context } from '../../../../../src/ports/context.js';
import { asBareContext } from '../../commands/fixtures.js';
import {
  buildTreeChain,
  deepIndexPath,
  instrumentedContext,
  serializeIndexFixtureAsync,
  writeLooseWithDeclaredSize,
  writeRawObjectBytes,
} from '../fixtures.js';

const seed = async (ctx: Context, path: string, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(path, content);
};

const merge = async (ctx: Context, path: string) => {
  const { sources, macros } = await (await buildAttributeProvider(ctx)).sourcesForPath(
    path as FilePath,
  );
  return resolveAttribute(sources, path as FilePath, 'merge', macros);
};

// Wraps `lstat` AND its non-throwing `tryLstat` twin so every probe reports a
// symbolic link, forcing the attributes-file reader to skip the (otherwise
// valid) root .gitattributes regardless of which one the reader prefers.
const withSymlinkLstat = (ctx: Context): Context => {
  const hostileFs = new Proxy(ctx.fs, {
    get(target, prop, receiver) {
      if (prop === 'lstat' || prop === 'tryLstat' || prop === 'lstatIfReachable') {
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
        const ctx = createMemoryContext(homeDir === undefined ? {} : { homeDir });
        await arrange(ctx);

        // Act
        const result = await merge(ctx, path);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a directory chain that contains `..` as a substring but not as an escaping segment', () => {
    describe('When resolving attribute sources for the path', () => {
      it('Then a directory containing `..` in the middle of its name is read, not skipped as escaping (a..b/c, reached through an adversarial double-slash segment)', async () => {
        // Arrange — the double slash makes dirChain also visit 'a..b/' and
        // 'a..b//c', both of which split to an empty '' segment; only the
        // nested 'c' level carries the seeded file, so a wrongly-escaped
        // 'a..b//c' entry cannot be masked by a shallower, unseeded sibling.
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/a..b/c/.gitattributes', '* merge=ab\n');
        const readUtf8Spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        const result = await merge(ctx, 'a..b//c/x.txt');

        // Assert
        expect(result).toEqual({ set: 'ab' });
        expect(readUtf8Spy).toHaveBeenCalledWith('/repo/a..b//c/.gitattributes');
      });

      it('Then a directory starting with `..` but followed by a non-dot/space character is read, not skipped as escaping (..x)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/..x/.gitattributes', '* merge=leading\n');
        const readUtf8Spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        const result = await merge(ctx, '..x/x.txt');

        // Assert
        expect(result).toEqual({ set: 'leading' });
        expect(readUtf8Spy).toHaveBeenCalledWith('/repo/..x/.gitattributes');
      });

      it('Then a directory ending with `..` but not starting with it is read, not skipped as escaping (x..)', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/x../.gitattributes', '* merge=trailing\n');
        const readUtf8Spy = vi.spyOn(ctx.fs, 'readUtf8');

        // Act
        const result = await merge(ctx, 'x../x.txt');

        // Assert
        expect(result).toEqual({ set: 'trailing' });
        expect(readUtf8Spy).toHaveBeenCalledWith('/repo/x../.gitattributes');
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
          const ctx = createMemoryContext();
          await arrange(ctx);
          const target = hostile === true ? withSymlinkLstat(ctx) : ctx;

          // Act
          const result = await merge(target, 'a.txt');

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

  describe('Given concurrent lookups under one uncached directory', () => {
    describe('When sourcesForPath runs for two of its files at once', () => {
      it('Then that directory `.gitattributes` is read once and serves both', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/a/.gitattributes', '* merge=a\n');
        const provider = await buildAttributeProvider(ctx);
        const spy = vi.spyOn(ctx.fs, 'readUtf8');
        const sut = provider.sourcesForPath;

        // Act
        const result = await Promise.all([sut('a/x.txt' as FilePath), sut('a/y.txt' as FilePath)]);

        // Assert
        const reads = spy.mock.calls.filter(([path]) => path === '/repo/a/.gitattributes');
        expect(reads).toHaveLength(1);
        expect(result.map(({ sources }) => sources.map(({ basedir }) => basedir))).toEqual([
          ['a'],
          ['a'],
        ]);
      });
    });
  });

  describe('Given a root .gitattributes', () => {
    describe('When resolving a top-level file', () => {
      it('Then it touches the file system no further than the build did', async () => {
        // Arrange
        const base = createMemoryContext();
        await seed(base, '/repo/.gitattributes', '* merge=root\n');
        const { ctx, calls } = instrumentedContext(base);
        const provider = await buildAttributeProvider(ctx);
        const sut = provider.sourcesForPath;
        const built = calls().length;

        // Act
        const result = await sut('top.txt' as FilePath);

        // Assert
        expect(result.sources.map(({ basedir }) => basedir)).toEqual(['']);
        expect(calls().slice(built)).toEqual([]);
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
            if (prop === 'lstat' || prop === 'tryLstat' || prop === 'lstatIfReachable') {
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

  describe('Given a diff path whose directory chain lexically escapes the worktree', () => {
    describe('When resolving attribute sources for the path', () => {
      it.each([
        {
          label: 'a `..`-laden chain (the raw merge-join does not validate entry names)',
          path: '../../../../../../etc/passwd',
        },
        {
          label: 'a `.. ` (dot-dot-space) segment Win32 canonicalises to `..`',
          path: '.. /file.txt',
        },
        {
          label: 'a Windows drive-absolute directory',
          path: 'C:/secrets/file.txt',
        },
        {
          label: 'a backslash-separated directory that normalises into a `..` segment',
          path: '..\\secret/file.txt',
        },
        {
          label: 'a leading-`/` absolute directory',
          path: '/etc/file.txt',
        },
      ])(
        'Then yields zero sources without ever touching the filesystem ($label)',
        async ({ path }) => {
          // Arrange
          const ctx = createMemoryContext();
          const provider = await buildAttributeProvider(ctx);
          const sut = provider.sourcesForPath;
          const lstatSpy = vi.spyOn(ctx.fs, 'lstat');
          const readUtf8Spy = vi.spyOn(ctx.fs, 'readUtf8');

          // Act
          const { sources } = await sut(path as FilePath);

          // Assert
          expect(sources).toEqual([]);
          expect(lstatSpy).not.toHaveBeenCalled();
          expect(readUtf8Spy).not.toHaveBeenCalled();
        },
      );
    });
  });

  describe('Given a bare repository (no work tree, attr.tree unset)', () => {
    describe('When resolving an attribute governed only by a root .gitattributes', () => {
      it("Then yields 'unspecified' without throwing (verified against real git 2.55: a bare clone reads no work-tree/HEAD .gitattributes by default)", async () => {
        // Arrange
        const seeded = createMemoryContext();
        await seed(seeded, '/repo/.gitattributes', '* merge=root\n');
        const ctx = asBareContext(seeded);

        // Act
        const result = await merge(ctx, 'a.txt');

        // Assert
        expect(result).toBe('unspecified');
      });
    });

    describe('When resolving an attribute governed by info/attributes', () => {
      it('Then the rule still applies (info/attributes never lives in the work tree)', async () => {
        // Arrange
        const seeded = createMemoryContext();
        await seed(seeded, '/repo/.git/info/attributes', '* merge=info\n');
        const ctx = asBareContext(seeded);

        // Act
        const result = await merge(ctx, 'a.txt');

        // Assert
        expect(result).toEqual({ set: 'info' });
      });
    });

    describe('When resolving an attribute governed by a global core.attributesFile', () => {
      it('Then the rule still applies (a global file is unaffected by bareness)', async () => {
        // Arrange
        const seeded = createMemoryContext();
        await seed(seeded, '/repo/.git/config', '[core]\n  attributesFile = /repo/global-attrs\n');
        await seed(seeded, '/repo/global-attrs', '* merge=global\n');
        const ctx = asBareContext(seeded);

        // Act
        const result = await merge(ctx, 'a.txt');

        // Assert
        expect(result).toEqual({ set: 'global' });
      });
    });

    describe('When resolving a nested path with per-directory .gitattributes', () => {
      it('Then every directory source is skipped, not just the root', async () => {
        // Arrange
        const seeded = createMemoryContext();
        await seed(seeded, '/repo/.gitattributes', '* merge=root\n');
        await seed(seeded, '/repo/sub/.gitattributes', '*.txt merge=sub\n');
        const ctx = asBareContext(seeded);

        // Act
        const { sources } = await (await buildAttributeProvider(ctx)).sourcesForPath(
          'sub/a.txt' as FilePath,
        );

        // Assert
        expect(sources).toEqual([]);
      });
    });
  });
});

describe('attributeBlobLookup', () => {
  describe('Given a gitlink and a regular entry named .gitattributes', () => {
    describe('When looking each path up', () => {
      it('Then only the regular entry is found', () => {
        // Arrange
        const id = '1'.repeat(40) as ObjectId;
        const entries = [
          { path: '.gitattributes', id, mode: FILE_MODE.GITLINK },
          { path: 'sub/.gitattributes', id, mode: FILE_MODE.REGULAR },
        ];
        const sut = attributeBlobLookup;

        // Act
        const lookup = sut(entries);
        const found = [
          lookup('.gitattributes' as FilePath),
          lookup('sub/.gitattributes' as FilePath),
        ];

        // Assert
        expect(found).toEqual([undefined, id]);
      });
    });
  });
});

describe('buildCheckinAttributeProvider', () => {
  describe('Given a context without a command runner and no required filter', () => {
    describe('When buildCheckinAttributeProvider runs', () => {
      it('Then a provider resolving the index .gitattributes is returned', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const attrs = await putBlob(ctx, '*.txt eol=crlf\n');
        await seedIndex(ctx, [indexEntry('.gitattributes', attrs)]);

        // Act
        const sut = buildCheckinAttributeProvider;
        const provider = await sut(ctx);

        // Assert
        expect(await eolOf(provider, 'f.txt')).toEqual({ set: 'crlf' });
      });
    });
  });

  describe('Given a context with a command runner', () => {
    describe('When buildCheckinAttributeProvider is called', () => {
      it('Then resolves to a defined AttributeProvider', async () => {
        // Arrange
        const ctx = createMemoryContext({
          command: { run: async () => ({ exitCode: 0 }) },
        });

        // Act
        const result = await buildCheckinAttributeProvider(ctx);

        // Assert
        expect(result).toBeDefined();
      });
    });
  });

  describe('Given an index with a nested stage-0 .gitattributes and a root one at stage 2 only', () => {
    describe('When the provider resolves paths', () => {
      it('Then the stage-2 root file governs as git reads ours, and the nested stage-0 file too', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const root = await putBlob(ctx, '*.txt eol=lf\n');
        const nested = await putBlob(ctx, '*.txt eol=crlf\n');
        await seedIndex(ctx, [
          indexEntry('.gitattributes', root, 2),
          indexEntry('sub/.gitattributes', nested),
          indexEntry('sub/not.gitattributes', root),
        ]);

        // Act
        const sut = buildCheckinAttributeProvider;
        const provider = await sut(ctx);

        // Assert
        expect(await eolOf(provider, 'f.txt')).toEqual({ set: 'lf' });
        expect(await eolOf(provider, 'sub/f.txt')).toEqual({ set: 'crlf' });
      });
    });
  });

  describe('Given a .gitattributes index entry that is a gitlink', () => {
    describe('When the provider resolves f.txt', () => {
      it('Then no attributes apply, git reading no blob for it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const attrs = await putBlob(ctx, '*.txt eol=crlf\n');
        await seedIndex(ctx, [indexEntry('.gitattributes', attrs, 0, FILE_MODE.GITLINK)]);

        // Act
        const sut = buildCheckinAttributeProvider;
        const provider = await sut(ctx);

        // Assert
        expect(await eolOf(provider, 'f.txt')).toBe('unspecified');
      });
    });
  });

  describe('Given a .gitattributes index entry whose object is missing', () => {
    describe('When the provider resolves f.txt', () => {
      it('Then no attributes apply', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedIndex(ctx, [indexEntry('.gitattributes', '1'.repeat(40) as ObjectId)]);

        // Act
        const sut = buildCheckinAttributeProvider;
        const provider = await sut(ctx);

        // Assert
        expect(await eolOf(provider, 'f.txt')).toBe('unspecified');
      });
    });
  });

  describe('Given a .gitattributes index entry whose object is a tree', () => {
    describe('When the provider resolves f.txt', () => {
      it('Then no attributes apply', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const tree = await putTree(ctx, []);
        await seedIndex(ctx, [indexEntry('.gitattributes', tree)]);

        // Act
        const sut = buildCheckinAttributeProvider;
        const provider = await sut(ctx);

        // Assert
        expect(await eolOf(provider, 'f.txt')).toBe('unspecified');
      });
    });
  });

  describe('Given a .gitattributes index entry in symlink mode', () => {
    describe('When the provider resolves f.txt', () => {
      it('Then the blob content applies, as git check-attr --cached reads it', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const attrs = await putBlob(ctx, '*.txt eol=crlf\n');
        await seedIndex(ctx, [indexEntry('.gitattributes', attrs, 0, FILE_MODE.SYMLINK)]);

        // Act
        const sut = buildCheckinAttributeProvider;
        const provider = await sut(ctx);

        // Assert
        expect(await eolOf(provider, 'f.txt')).toEqual({ set: 'crlf' });
      });
    });
  });

  describe('Given a .gitattributes index entry whose object cannot be inflated', () => {
    describe('When the provider resolves f.txt', () => {
      it('Then the corruption surfaces with its own code', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const id = 'ab'.repeat(20) as ObjectId;
        await ctx.fs.write(
          `${ctx.layout.gitDir}/objects/ab/${'ab'.repeat(19)}`,
          new Uint8Array([1, 2, 3, 4]),
        );
        await seedIndex(ctx, [indexEntry('.gitattributes', id)]);
        const sut = buildCheckinAttributeProvider;

        // Act
        const failure = await sut(ctx).then(
          () => undefined,
          (err: TsgitError) => err,
        );

        // Assert
        expect(failure?.data.code).toBe('DECOMPRESS_FAILED');
      });
    });
  });

  describe('Given a work-tree root .gitattributes and an index on disk', () => {
    describe('When the provider is built and queried for a root path', () => {
      it('Then the index is never read', async () => {
        // Arrange
        const base = createMemoryContext();
        await seedIndex(base, []);
        await base.fs.writeUtf8(`${base.layout.workDir}/.gitattributes`, '*.txt eol=crlf\n');
        const { ctx, indexReads } = countingIndexReads(base);

        const sut = buildCheckinAttributeProvider;

        // Act
        const provider = await sut(ctx);
        await eolOf(provider, 'f.txt');

        // Assert
        expect(indexReads()).toBe(0);
      });
    });
  });

  describe('Given no work-tree .gitattributes and an index recording nested ones', () => {
    describe('When the provider is queried for paths in several directories', () => {
      it('Then the index is read once across every lookup', async () => {
        // Arrange
        const base = createMemoryContext();
        const attrs = await putBlob(base, '*.txt eol=crlf\n');
        await seedIndex(base, [
          indexEntry('a/.gitattributes', attrs),
          indexEntry('b/.gitattributes', attrs),
        ]);
        const { ctx, indexReads } = countingIndexReads(base);

        const sut = buildCheckinAttributeProvider;

        // Act
        const provider = await sut(ctx);
        const resolved = [
          await eolOf(provider, 'a/f.txt'),
          await eolOf(provider, 'b/f.txt'),
          await eolOf(provider, 'c/f.txt'),
        ];

        // Assert
        expect(resolved).toEqual([{ set: 'crlf' }, { set: 'crlf' }, 'unspecified']);
        expect(indexReads()).toBe(1);
      });
    });
  });

  describe('Given the entries of an index already read', () => {
    describe('When the provider is built from them', () => {
      it('Then the index file is not read again and their .gitattributes applies', async () => {
        // Arrange
        const base = createMemoryContext();
        const attrs = await putBlob(base, '*.txt eol=crlf\n');
        const { ctx, indexReads } = countingIndexReads(base);

        const sut = buildCheckinAttributeProvider;

        // Act
        const provider = await sut(ctx, { entries: [indexEntry('.gitattributes', attrs)] });

        // Assert
        expect(await eolOf(provider, 'f.txt')).toEqual({ set: 'crlf' });
        expect(indexReads()).toBe(0);
      });
    });
  });

  describe('Given the entries of an index already read with .gitattributes at stages 1, 2 and 3', () => {
    describe('When the provider is built from them', () => {
      it('Then the stage-2 .gitattributes applies, as git reads the unmerged path', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const base = await putBlob(ctx, '*.txt eol=native\n');
        const ours = await putBlob(ctx, '*.txt eol=crlf\n');
        const theirs = await putBlob(ctx, '*.txt eol=lf\n');
        const entries = [
          indexEntry('.gitattributes', base, 1),
          indexEntry('.gitattributes', ours, 2),
          indexEntry('.gitattributes', theirs, 3),
        ];
        const sut = buildCheckinAttributeProvider;

        // Act
        const provider = await sut(ctx, { entries });

        // Assert
        expect(await eolOf(provider, 'f.txt')).toEqual({ set: 'crlf' });
      });
    });
  });

  describe('Given a corrupt index header', () => {
    describe('When buildCheckinAttributeProvider runs', () => {
      it('Then it tolerates the index as empty, as add does', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await ctx.fs.write(`${ctx.layout.gitDir}/index`, new Uint8Array(40));

        // Act
        const sut = buildCheckinAttributeProvider;
        const provider = await sut(ctx);

        // Assert
        expect(await eolOf(provider, 'f.txt')).toBe('unspecified');
      });
    });
  });

  describe('Given an index file that exists but vanishes before it is read', () => {
    describe('When buildCheckinAttributeProvider runs', () => {
      it('Then it tolerates the missing index as empty', async () => {
        // Arrange
        const base = createMemoryContext();
        const ctx = withFailingIndexReads(base, fileNotFound(`${base.layout.gitDir}/index`));

        // Act
        const sut = buildCheckinAttributeProvider;
        const provider = await sut(ctx);

        // Assert
        expect(await eolOf(provider, 'f.txt')).toBe('unspecified');
      });
    });
  });

  describe('Given a valid index header followed by an entry with a rejected path', () => {
    describe('When buildCheckinAttributeProvider runs', () => {
      it('Then it tolerates the garbage index as empty, as add does', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedIndex(ctx, [indexEntry('../escape', '1'.repeat(40) as ObjectId)]);

        // Act
        const sut = buildCheckinAttributeProvider;
        const provider = await sut(ctx);

        // Assert
        expect(await eolOf(provider, 'f.txt')).toBe('unspecified');
      });
    });
  });

  describe('Given an index read failing with a permission error', () => {
    describe('When buildCheckinAttributeProvider runs', () => {
      it('Then it rejects with that error code', async () => {
        // Arrange
        const base = createMemoryContext();
        const ctx = withFailingIndexReads(base, permissionDenied(`${base.layout.gitDir}/index`));
        const sut = buildCheckinAttributeProvider;

        // Act
        const failure = await sut(ctx).then(
          () => undefined,
          (err: TsgitError) => err,
        );

        // Assert
        expect(failure?.data.code).toBe('PERMISSION_DENIED');
      });
    });
  });

  describe('Given an index read failing with another error', () => {
    describe('When buildCheckinAttributeProvider runs', () => {
      it('Then the error propagates', async () => {
        // Arrange
        const base = createMemoryContext();
        const boom = new Error('disk on fire');
        const ctx = { ...base, fs: { ...base.fs, exists: () => Promise.reject(boom) } } as Context;

        // Act
        const act = buildCheckinAttributeProvider(ctx);

        // Assert
        await expect(act).rejects.toBe(boom);
      });
    });
  });
});

const INDEX_READERS = new Set<string | symbol>(['stat', 'tryStat', 'read', 'readUtf8']);

/** The index file reports as present, and every read of it fails with `error`; other files behave. */
const withFailingIndexReads = (base: Context, error: TsgitError): Context => {
  const isIndex = (path: unknown): boolean => String(path).endsWith('/index');
  const fs = new Proxy(base.fs, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop === 'exists') {
        return (path: string) =>
          isIndex(path) ? Promise.resolve(true) : original.call(target, path);
      }
      if (!INDEX_READERS.has(prop)) return original;
      return (path: string, ...rest: unknown[]) =>
        isIndex(path) ? Promise.reject(error) : original.call(target, path, ...rest);
    },
  });
  return { ...base, fs } as Context;
};

/** Counts reads of the index file (not its stats), whatever the reader. */
const countingIndexReads = (base: Context): { ctx: Context; indexReads: () => number } => {
  let reads = 0;
  const fs = new Proxy(base.fs, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop !== 'read') return original;
      return (path: string, ...rest: unknown[]) => {
        if (String(path).endsWith('/index')) reads += 1;
        return original.call(target, path, ...rest);
      };
    },
  });
  return { ctx: { ...base, fs } as Context, indexReads: () => reads };
};

const putBlob = (ctx: Context, content: string): Promise<ObjectId> =>
  writeObject(ctx, {
    type: 'blob',
    content: new TextEncoder().encode(content),
    id: '' as ObjectId,
  });

const putTree = (
  ctx: Context,
  entries: ReadonlyArray<readonly [string, string, ObjectId]>,
): Promise<ObjectId> =>
  writeTree(
    ctx,
    entries.map(([mode, name, id]) => treeEntry(mode as never, name, id)),
  );

const buildTreeAttributeProvider = (ctx: Context, tree: ObjectId) =>
  buildAttributeProvider(ctx, { kind: 'tree', tree });

const treeResolve = async (
  ctx: Context,
  tree: ObjectId,
  path: string,
  name = 'merge',
): Promise<unknown> => {
  const { sources, macros } = await (await buildTreeAttributeProvider(ctx, tree)).sourcesForPath(
    path as FilePath,
  );
  return resolveAttribute(sources, path, name, macros);
};

/** `d0/…/d{depth}` with a file at the bottom and a `.gitattributes` in every tenth directory. */
const putDeepTreeWithAttributes = async (ctx: Context, depth: number): Promise<ObjectId> => {
  let child = await putBlob(ctx, 'leaf');
  let childMode: string = FILE_MODE.REGULAR;
  for (let level = depth; level >= 0; level -= 1) {
    const entries: Array<readonly [string, string, ObjectId]> = [[childMode, `d${level}`, child]];
    if (level % 10 === 0) {
      entries.push([FILE_MODE.REGULAR, '.gitattributes', await putBlob(ctx, `* merge=${level}\n`)]);
    }
    child = await putTree(ctx, entries);
    childMode = FILE_MODE.DIRECTORY;
  }
  return child;
};

describe('buildAttributeProvider with a tree direction', () => {
  describe('Given a tree with a root and a nested .gitattributes', () => {
    describe('When resolving paths', () => {
      it.each([
        { path: 'a.txt', expected: { set: 'root' } },
        { path: 'sub/a.txt', expected: { set: 'sub' } },
      ])('Then $path reads the tree files', async ({ path, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        const rootAttrs = await putBlob(ctx, '*.txt merge=root\n');
        const subAttrs = await putBlob(ctx, '*.txt merge=sub\n');
        const sub = await putTree(ctx, [[FILE_MODE.REGULAR, '.gitattributes', subAttrs]]);
        const tree = await putTree(ctx, [
          [FILE_MODE.REGULAR, '.gitattributes', rootAttrs],
          [FILE_MODE.DIRECTORY, 'sub', sub],
        ]);

        // Act
        const result = await treeResolve(ctx, tree, path);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a .gitattributes two directories down, a file named like a directory and no such directory', () => {
    describe('When resolving each path before any of its parent directories', () => {
      it.each([
        { path: 'top/mid/a.txt', expected: { set: 'mid' } },
        { path: 'file/a.txt', expected: { set: 'root' } },
        { path: 'missing/a.txt', expected: { set: 'root' } },
      ])('Then $path reads the files on its own chain', async ({ path, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        const rootAttrs = await putBlob(ctx, '*.txt merge=root\n');
        const midAttrs = await putBlob(ctx, '*.txt merge=mid\n');
        const mid = await putTree(ctx, [[FILE_MODE.REGULAR, '.gitattributes', midAttrs]]);
        const top = await putTree(ctx, [[FILE_MODE.DIRECTORY, 'mid', mid]]);
        const tree = await putTree(ctx, [
          [FILE_MODE.REGULAR, '.gitattributes', rootAttrs],
          [FILE_MODE.REGULAR, 'file', midAttrs],
          [FILE_MODE.DIRECTORY, 'top', top],
        ]);

        // Act
        const result = await treeResolve(ctx, tree, path);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given a worktree .gitattributes and a tree without one', () => {
    describe('When resolving', () => {
      it('Then the worktree file is ignored', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.gitattributes', '*.txt merge=worktree\n');
        const tree = await putTree(ctx, []);

        // Act
        const result = await treeResolve(ctx, tree, 'a.txt');

        // Assert
        expect(result).toBe('unspecified');
      });
    });
  });

  describe('Given a bare context', () => {
    describe('When resolving from a tree', () => {
      it('Then the tree .gitattributes applies', async () => {
        // Arrange
        const ctx = asBareContext(createMemoryContext());
        const attrs = await putBlob(ctx, '*.txt merge=bare\n');
        const tree = await putTree(ctx, [[FILE_MODE.REGULAR, '.gitattributes', attrs]]);

        // Act
        const result = await treeResolve(ctx, tree, 'a.txt');

        // Assert
        expect(result).toEqual({ set: 'bare' });
      });
    });
  });

  describe('Given a .gitattributes entry of each mode', () => {
    describe('When resolving', () => {
      it.each([
        { mode: FILE_MODE.REGULAR, expected: { set: 'x' } },
        { mode: FILE_MODE.EXECUTABLE, expected: { set: 'x' } },
        { mode: FILE_MODE.SYMLINK, expected: 'unspecified' },
      ])('Then mode $mode yields $expected', async ({ mode, expected }) => {
        // Arrange
        const ctx = createMemoryContext();
        const attrs = await putBlob(ctx, '*.txt merge=x\n');
        const tree = await putTree(ctx, [[mode, '.gitattributes', attrs]]);

        // Act
        const result = await treeResolve(ctx, tree, 'a.txt');

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given info/attributes and a tree .gitattributes both assigning merge', () => {
    describe('When resolving', () => {
      it('Then info/attributes wins', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '/repo/.git/info/attributes', '*.txt merge=info\n');
        const attrs = await putBlob(ctx, '*.txt merge=tree\n');
        const tree = await putTree(ctx, [[FILE_MODE.REGULAR, '.gitattributes', attrs]]);

        // Act
        const result = await treeResolve(ctx, tree, 'a.txt');

        // Assert
        expect(result).toEqual({ set: 'info' });
      });
    });
  });

  describe('Given a macro defined in the tree root .gitattributes', () => {
    describe('When a rule uses the macro', () => {
      it('Then the macro expands', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const attrs = await putBlob(ctx, '[attr]mine merge=macro\n*.txt mine\n');
        const tree = await putTree(ctx, [[FILE_MODE.REGULAR, '.gitattributes', attrs]]);

        // Act
        const result = await treeResolve(ctx, tree, 'a.txt');

        // Assert
        expect(result).toEqual({ set: 'macro' });
      });
    });
  });

  describe('Given a tree .gitattributes over the size cap', () => {
    describe('When building the provider', () => {
      it('Then it throws GITATTRIBUTES_FILE_TOO_LARGE', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const attrs = await putBlob(ctx, 'x'.repeat(MAX_GITATTRIBUTES_BYTES + 1));
        const tree = await putTree(ctx, [[FILE_MODE.REGULAR, '.gitattributes', attrs]]);

        // Act
        let caught: TsgitError | undefined;
        try {
          await buildTreeAttributeProvider(ctx, tree);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'GITATTRIBUTES_FILE_TOO_LARGE',
          path: '.gitattributes',
          size: MAX_GITATTRIBUTES_BYTES + 1,
          limit: MAX_GITATTRIBUTES_BYTES,
        });
      });
    });
  });

  describe('Given a tree .gitattributes whose header declares a size over the cap', () => {
    describe('When building the provider', () => {
      it('Then it refuses on the declared size before reading the body', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const body = new TextEncoder().encode('x');
        const attrs = await writeRawObjectBytes(ctx, 'blob', body);
        await writeLooseWithDeclaredSize(ctx, attrs, 'blob', MAX_GITATTRIBUTES_BYTES + 1, body);
        const tree = await putTree(ctx, [[FILE_MODE.REGULAR, '.gitattributes', attrs]]);

        // Act
        let caught: TsgitError | undefined;
        try {
          await buildTreeAttributeProvider(ctx, tree);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'GITATTRIBUTES_FILE_TOO_LARGE',
          path: '.gitattributes',
          size: MAX_GITATTRIBUTES_BYTES + 1,
          limit: MAX_GITATTRIBUTES_BYTES,
        });
      });
    });
  });

  describe('Given a tree .gitattributes exactly at the size cap', () => {
    describe('When resolving a path', () => {
      it('Then the file is read, not refused', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const attrs = await putBlob(ctx, '#'.repeat(MAX_GITATTRIBUTES_BYTES));
        const tree = await putTree(ctx, [[FILE_MODE.REGULAR, '.gitattributes', attrs]]);
        const sut = treeResolve;

        // Act
        const result = await sut(ctx, tree, 'a.txt');

        // Assert
        expect(result).toBe('unspecified');
      });
    });
  });

  describe('Given a tree nested many directories deep, read with every object cache off', () => {
    describe('When each directory and the leaf are resolved in walk order', () => {
      it('Then it reads the root once and two trees per directory, never re-descending from the root', async () => {
        // Arrange
        const depth = 60;
        const base = createMemoryContext({ deltaCacheMaxBytes: 0, parsedObjectMemoMaxEntries: 0 });
        const tree = await buildTreeChain(base, depth);
        const { ctx, calls } = instrumentedContext(base);
        const sut = buildTreeAttributeProvider;

        // Act
        const provider = await sut(ctx, tree);
        for (let slashes = 0; slashes < depth; slashes += 1) {
          await provider.sourcesForPath(`${deepIndexPath(slashes)}/` as FilePath);
        }
        await provider.sourcesForPath(deepIndexPath(depth) as FilePath);

        // Assert
        const result = calls().filter(
          ({ method, path }) => method === 'read' && path.includes('/objects/'),
        );
        expect(result).toHaveLength(2 * depth + 1);
      });
    });
  });

  describe('Given a directory carrying its own .gitattributes', () => {
    describe("When the directory's own key is looked up", () => {
      it('Then its sources stop at its parent, as the directory is a path in that parent', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const subAttrs = await putBlob(ctx, 'sub merge=own\n');
        const sub = await putTree(ctx, [[FILE_MODE.REGULAR, '.gitattributes', subAttrs]]);
        const rootAttrs = await putBlob(ctx, 'sub merge=parent\n');
        const tree = await putTree(ctx, [
          [FILE_MODE.REGULAR, '.gitattributes', rootAttrs],
          [FILE_MODE.DIRECTORY, 'sub', sub],
        ]);
        const provider = await buildTreeAttributeProvider(ctx, tree);
        const sut = provider.sourcesForPath;

        // Act
        const result = await sut('sub/' as FilePath);

        // Assert
        expect(result.sources.map(({ basedir }) => basedir)).toEqual(['']);
      });
    });
  });

  describe('Given a tree nested many directories deep with a .gitattributes in every tenth one, read with every object cache off', () => {
    describe('When each directory and the leaf are resolved in walk order', () => {
      it('Then each .gitattributes blob is read once beside the two tree reads per directory', async () => {
        // Arrange
        const depth = 60;
        const attributeFiles = depth / 10 + 1;
        const base = createMemoryContext({ deltaCacheMaxBytes: 0, parsedObjectMemoMaxEntries: 0 });
        const tree = await putDeepTreeWithAttributes(base, depth);
        const { ctx, calls } = instrumentedContext(base);
        const sut = buildTreeAttributeProvider;

        // Act
        const provider = await sut(ctx, tree);
        for (let slashes = 0; slashes < depth; slashes += 1) {
          await provider.sourcesForPath(`${deepIndexPath(slashes)}/` as FilePath);
        }
        await provider.sourcesForPath(deepIndexPath(depth) as FilePath);

        // Assert
        const result = calls().filter(
          ({ method, path }) => method === 'read' && path.includes('/objects/'),
        );
        expect(result).toHaveLength(2 * depth + 1 + attributeFiles);
      });
    });
  });

  describe('Given a worktree nested many directories deep with a .gitattributes in every directory', () => {
    describe('When each directory and the leaf are resolved in walk order', () => {
      it("Then it reads each directory's .gitattributes exactly once", async () => {
        // Arrange
        const depth = 60;
        const base = createMemoryContext();
        await seed(base, '/repo/.gitattributes', '* merge=root\n');
        for (let slashes = 0; slashes < depth; slashes += 1) {
          await seed(
            base,
            `/repo/${deepIndexPath(slashes)}/.gitattributes`,
            `* merge=${slashes}\n`,
          );
        }
        const { ctx, calls } = instrumentedContext(base);
        const sut = buildAttributeProvider;

        // Act
        const provider = await sut(ctx);
        for (let slashes = 0; slashes < depth; slashes += 1) {
          await provider.sourcesForPath(`${deepIndexPath(slashes)}/` as FilePath);
        }
        await provider.sourcesForPath(deepIndexPath(depth) as FilePath);

        // Assert
        const result = calls().filter(
          ({ method, path }) => method === 'readUtf8' && path.endsWith('/.gitattributes'),
        );
        expect(result).toHaveLength(depth + 1);
        expect(new Set(result.map(({ path }) => path)).size).toBe(depth + 1);
      });
    });
  });

  describe('Given a tree a thousand directories deep with a .gitattributes in every tenth one', () => {
    describe('When each directory and the leaf are resolved in walk order', () => {
      it('Then every level keeps its own rules', async () => {
        // Arrange
        const depth = 1000;
        const ctx = createMemoryContext();
        const tree = await putDeepTreeWithAttributes(ctx, depth);
        const provider = await buildTreeAttributeProvider(ctx, tree);
        const sut = provider.sourcesForPath;

        // Act
        for (let slashes = 0; slashes < depth; slashes += 1) {
          await sut(`${deepIndexPath(slashes)}/` as FilePath);
        }
        const result = await sut(deepIndexPath(depth) as FilePath);

        // Assert
        expect(result.sources.map(({ basedir }) => basedir)).toEqual([
          ...Array.from({ length: 100 }, (_unused, tenth) => deepIndexPath(999 - 10 * tenth)),
          '',
        ]);
      });
    });
  });
});

const indexEntry = (
  path: string,
  id: ObjectId,
  stage: 0 | 1 | 2 | 3 = 0,
  mode: IndexEntry['mode'] = FILE_MODE.REGULAR,
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
  flags: { ...STAGE0_FLAGS, stage },
  path: path as FilePath,
});

const seedIndex = async (ctx: Context, entries: ReadonlyArray<IndexEntry>): Promise<void> => {
  const bytes = await serializeIndexFixtureAsync(
    { version: 2, entries: [...entries], extensions: [], trailerSha: new Uint8Array(0) },
    ctx,
  );
  await ctx.fs.write(`${ctx.layout.gitDir}/index`, bytes);
};

const eolOf = async (provider: AttributeProvider | undefined, path: string): Promise<unknown> => {
  const { sources, macros } = await (provider as AttributeProvider).sourcesForPath(
    path as FilePath,
  );
  return resolveAttribute(sources, path, 'eol', macros);
};

const lookupOf =
  (files: Readonly<Record<string, ObjectId>>) =>
  (path: FilePath): ObjectId | undefined =>
    files[path];

describe('buildAttributeProvider with an index direction', () => {
  describe('Given an index .gitattributes and no worktree file', () => {
    describe('When a worktree-first provider resolves f.txt', () => {
      it('Then eol is { set: crlf }', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const attrs = await putBlob(ctx, '*.txt eol=crlf\n');
        const direction: AttributeDirection = {
          kind: 'worktree-first',
          index: lookupOf({ '.gitattributes': attrs }),
        };

        // Act
        const sut = buildAttributeProvider;
        const provider = await sut(ctx, direction);

        // Assert
        expect(await eolOf(provider, 'f.txt')).toEqual({ set: 'crlf' });
      });
    });
  });

  describe('Given index *.txt eol=crlf and worktree *.txt eol=lf', () => {
    const arrange = async () => {
      const ctx = createMemoryContext();
      await seed(ctx, '/repo/.gitattributes', '*.txt eol=lf\n');
      const attrs = await putBlob(ctx, '*.txt eol=crlf\n');
      return { ctx, index: lookupOf({ '.gitattributes': attrs }) };
    };

    describe('When a provider of each direction resolves f.txt', () => {
      it.each([
        { kind: 'worktree-first', expected: { set: 'lf' } },
        { kind: 'index-first', expected: { set: 'crlf' } },
      ] as const)('Then $kind resolves eol to $expected', async ({ kind, expected }) => {
        // Arrange
        const { ctx, index } = await arrange();

        // Act
        const sut = buildAttributeProvider;
        const provider = await sut(ctx, { kind, index });

        // Assert
        expect(await eolOf(provider, 'f.txt')).toEqual(expected);
      });
    });

    describe('When an index-first provider resolves a file the index lacks', () => {
      it('Then index-first falls back to the worktree when the index lacks the file', async () => {
        // Arrange
        const { ctx } = await arrange();

        // Act
        const sut = buildAttributeProvider;
        const provider = await sut(ctx, { kind: 'index-first', index: lookupOf({}) });

        // Assert
        expect(await eolOf(provider, 'f.txt')).toEqual({ set: 'lf' });
      });
    });
  });

  describe('Given a nested index .gitattributes', () => {
    describe('When an index-first provider resolves a path under it', () => {
      it('Then the directory file is looked up as <dir>/.gitattributes', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const attrs = await putBlob(ctx, '*.txt eol=crlf\n');
        const index = lookupOf({ 'sub/.gitattributes': attrs });

        // Act
        const sut = buildAttributeProvider;
        const provider = await sut(ctx, { kind: 'index-first', index });

        // Assert
        expect(await eolOf(provider, 'sub/f.txt')).toEqual({ set: 'crlf' });
        expect(await eolOf(provider, 'f.txt')).toBe('unspecified');
      });
    });
  });

  describe('Given an index .gitattributes blob over the size cap', () => {
    describe('When building the provider', () => {
      it('Then the read refuses as the tree reader does', async () => {
        // Arrange
        const ctx = createMemoryContext();
        const attrs = await putBlob(ctx, 'x'.repeat(MAX_GITATTRIBUTES_BYTES + 1));
        const index = lookupOf({ '.gitattributes': attrs });

        // Act
        let caught: TsgitError | undefined;
        try {
          await buildAttributeProvider(ctx, { kind: 'index-first', index });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'GITATTRIBUTES_FILE_TOO_LARGE',
          path: '.gitattributes',
          size: MAX_GITATTRIBUTES_BYTES + 1,
          limit: MAX_GITATTRIBUTES_BYTES,
        });
      });
    });
  });
});
