import { describe, expect, it } from 'vitest';
import { BrowserFileSystem } from '../../../../../src/adapters/browser/browser-file-system.js';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import type { IniSection } from '../../../../../src/application/primitives/config-read.js';
import {
  isWorktreeScopeActive,
  mergeConfigsByScope,
  resolveScopePath,
  SCOPE_ORDER,
} from '../../../../../src/application/primitives/internal/config-scope.js';
import { permissionDenied, type TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';
import type { FileSystem } from '../../../../../src/ports/file-system.js';

const u8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const withBrowserFs = (ctx: Context): Context => ({
  ...ctx,
  fs: new BrowserFileSystem({} as unknown as FileSystemDirectoryHandle),
});

const withFsOverride = (ctx: Context, overrides: Partial<FileSystem>): Context => ({
  ...ctx,
  fs: { ...ctx.fs, ...overrides } as FileSystem,
});

const section = (
  s: string,
  sub: string | undefined,
  entries: ReadonlyArray<{ key: string; value: string }>,
): IniSection => ({ section: s, subsection: sub, entries });

describe('SCOPE_ORDER', () => {
  describe('Given the constant, When read', () => {
    it('Then it equals [system, global, local, worktree] exactly', () => {
      // Arrange + Assert
      expect(SCOPE_ORDER).toEqual(['system', 'global', 'local', 'worktree']);
    });
  });
});

describe('resolveScopePath', () => {
  describe('Given a scope that resolves without throwing', () => {
    describe('When resolveScopePath runs', () => {
      it.each([
        {
          label: 'scope "local"',
          scope: 'local' as const,
          arrange: () => {
            const ctx = createMemoryContext();
            return { ctx, expected: `${ctx.layout.gitDir}/config` };
          },
        },
        {
          label: 'scope "worktree" with extensions.worktreeConfig = true in local',
          scope: 'worktree' as const,
          arrange: () => {
            const ctx = createMemoryContext({
              files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = true\n') },
            });
            return { ctx, expected: `${ctx.layout.gitDir}/config.worktree` };
          },
        },
        {
          label: 'scope "global" with the XDG file present',
          scope: 'global' as const,
          arrange: () => ({
            ctx: createMemoryContext({
              xdg: '/repo/cfg',
              files: { '/repo/cfg/git/config': u8('[user]\n\tname = ada\n') },
            }),
            expected: '/repo/cfg/git/config',
          }),
        },
        {
          label: 'scope "global" with no XDG file, but ~/.gitconfig present',
          scope: 'global' as const,
          arrange: () => ({
            ctx: createMemoryContext({
              home: '/repo/u/ada',
              xdg: '/repo/cfg',
              files: { '/repo/u/ada/.gitconfig': u8('[user]\n\tname = ada\n') },
            }),
            expected: '/repo/u/ada/.gitconfig',
          }),
        },
        {
          label: 'scope "global" with neither file present (canonical write target)',
          scope: 'global' as const,
          arrange: () => ({
            ctx: createMemoryContext({ home: '/repo/u/ada', xdg: '/repo/cfg' }),
            expected: '/repo/u/ada/.gitconfig',
          }),
        },
        {
          label: 'scope "system" on a memory adapter',
          scope: 'system' as const,
          arrange: () => ({
            ctx: createMemoryContext({ systemConfig: '/repo/opt/etc/gitconfig' }),
            expected: '/repo/opt/etc/gitconfig',
          }),
        },
        {
          label:
            'scope "global" where fs.exists rejects for every probe (a failed probe reads as absent)',
          scope: 'global' as const,
          arrange: () => ({
            ctx: withFsOverride(createMemoryContext({ home: '/repo/u/ada', xdg: '/repo/cfg' }), {
              exists: () => Promise.reject(new Error('stat failed')),
            }),
            expected: '/repo/u/ada/.gitconfig',
          }),
        },
      ])('Then $label resolves to the expected path', async ({ scope, arrange }) => {
        // Arrange
        const sut = resolveScopePath;
        const { ctx, expected } = arrange();

        // Act
        const result = await sut(ctx, scope);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a scope resolveScopePath itself refuses', () => {
    describe('When resolveScopePath runs', () => {
      it.each([
        {
          label: 'scope "worktree" without the extension',
          scope: 'worktree' as const,
          ctx: () => createMemoryContext(),
          expected: {
            code: 'CONFIG_SCOPE_NOT_AVAILABLE',
            scope: 'worktree',
            reason: 'worktree-extension-unset',
          },
        },
        {
          label: 'scope "global" against a browser adapter',
          scope: 'global' as const,
          ctx: () => withBrowserFs(createMemoryContext()),
          expected: {
            code: 'CONFIG_SCOPE_NOT_AVAILABLE',
            scope: 'global',
            reason: 'browser-adapter',
          },
        },
        {
          label: 'scope "system" against a browser adapter',
          scope: 'system' as const,
          ctx: () => withBrowserFs(createMemoryContext()),
          expected: {
            code: 'CONFIG_SCOPE_NOT_AVAILABLE',
            scope: 'system',
            reason: 'browser-adapter',
          },
        },
        {
          label: 'scope "system" where systemConfigPath resolves to the empty string',
          scope: 'system' as const,
          ctx: () => createMemoryContext({ systemConfig: '' }),
          expected: { code: 'CONFIG_SYSTEM_PATH_UNRESOLVED' },
        },
      ])('Then throws $expected.code ($label)', async ({ scope, ctx, expected }) => {
        // Arrange
        const sut = resolveScopePath;
        let caught: TsgitError | undefined;

        // Act
        try {
          await sut(ctx(), scope);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual(expected);
      });
    });
  });

  describe('Given scope "global" where the adapter path getter throws a non-adapter TsgitError', () => {
    describe('When resolveScopePath runs', () => {
      it('Then the original error propagates unchanged (not converted to browser-adapter)', async () => {
        // Arrange
        const original = permissionDenied('/denied');
        const ctx = withFsOverride(createMemoryContext(), {
          xdgConfigHome: () => {
            throw original;
          },
        });
        let caught: TsgitError | undefined;

        // Act
        try {
          await resolveScopePath(ctx, 'global');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({ code: 'PERMISSION_DENIED', path: '/denied' });
      });
    });
  });

  describe('Given scope "global" where the adapter path getter throws a non-TsgitError', () => {
    describe('When resolveScopePath runs', () => {
      it('Then the thrown error propagates unchanged', async () => {
        // Arrange
        const original = new Error('adapter exploded');
        const ctx = withFsOverride(createMemoryContext(), {
          xdgConfigHome: () => {
            throw original;
          },
        });
        let caught: unknown;

        // Act
        try {
          await resolveScopePath(ctx, 'global');
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(original);
      });
    });
  });
});

describe('isWorktreeScopeActive', () => {
  describe('Given a local config in a given state', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it.each([
        {
          label: '[extensions] worktreeConfig = true',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = true\n') },
          expected: true,
        },
        {
          label: 'the worktreeConfig key is absent',
          files: { '/repo/.git/config': u8('[user]\n\tname = ada\n') },
          expected: false,
        },
        {
          label: 'no local config exists at all (missing file is not an error)',
          files: {},
          expected: false,
        },
        {
          label: 'worktreeConfig = true sits under a non-[extensions] section',
          files: { '/repo/.git/config': u8('[user]\n\tworktreeConfig = true\n') },
          expected: false,
        },
        {
          label: 'worktreeConfig = true sits under a subsectioned [extensions "x"]',
          files: { '/repo/.git/config': u8('[extensions "x"]\n\tworktreeConfig = true\n') },
          expected: false,
        },
        {
          label: '[extensions] carries a different key set to true',
          files: { '/repo/.git/config': u8('[extensions]\n\totherKey = true\n') },
          expected: false,
        },
        {
          label: '[extensions] worktreeConfig = false (must be exactly "true")',
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = false\n') },
          expected: false,
        },
      ])('Then returns $expected ($label)', async ({ files, expected }) => {
        // Arrange
        const sut = isWorktreeScopeActive;
        const ctx = createMemoryContext({ files });

        // Act
        const result = await sut(ctx);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given the local config read rejects with a non-FILE_NOT_FOUND TsgitError', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then the error propagates (only FILE_NOT_FOUND is swallowed)', async () => {
        // Arrange
        const original = permissionDenied('/repo/.git/config');
        const ctx = withFsOverride(createMemoryContext(), {
          readUtf8: () => Promise.reject(original),
        });
        let caught: TsgitError | undefined;

        // Act
        try {
          await isWorktreeScopeActive(ctx);
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({ code: 'PERMISSION_DENIED', path: '/repo/.git/config' });
      });
    });
  });

  describe('Given the local config read rejects with a non-TsgitError', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then the error propagates unchanged', async () => {
        // Arrange
        const original = new Error('disk on fire');
        const ctx = withFsOverride(createMemoryContext(), {
          readUtf8: () => Promise.reject(original),
        });
        let caught: unknown;

        // Act
        try {
          await isWorktreeScopeActive(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toBe(original);
      });
    });
  });
});

describe('mergeConfigsByScope', () => {
  describe('Given an input array of scope-tagged sections', () => {
    describe('When mergeConfigsByScope runs', () => {
      it.each([
        {
          label: 'empty input: returns an empty array',
          input: [] as ReadonlyArray<{
            readonly scope: 'system' | 'global' | 'local' | 'worktree';
            readonly sections: ReadonlyArray<IniSection>;
          }>,
          expected: [] as ReadonlyArray<unknown>,
        },
        {
          label: 'only local sections: returns each section tagged with local in physical order',
          input: [
            {
              scope: 'local' as const,
              sections: [section('user', undefined, []), section('core', undefined, [])],
            },
          ],
          expected: [
            { scope: 'local', section: section('user', undefined, []) },
            { scope: 'local', section: section('core', undefined, []) },
          ],
        },
        {
          label: 'local and global with no overlap: global comes before local (scope precedence)',
          input: [
            {
              scope: 'local' as const,
              sections: [section('user', undefined, [{ key: 'name', value: 'l' }])],
            },
            {
              scope: 'global' as const,
              sections: [section('user', undefined, [{ key: 'name', value: 'g' }])],
            },
          ],
          expected: [
            { scope: 'global', section: section('user', undefined, [{ key: 'name', value: 'g' }]) },
            { scope: 'local', section: section('user', undefined, [{ key: 'name', value: 'l' }]) },
          ],
        },
      ])('Then $label', ({ input, expected }) => {
        // Arrange
        const sut = mergeConfigsByScope;

        // Act
        const result = sut(input);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe('Given all four scopes, When mergeConfigsByScope runs', () => {
    it('Then output preserves the four-scope precedence (system → global → local → worktree)', () => {
      // Arrange
      const make = (s: string) => [section(s, undefined, [])];
      const input = [
        { scope: 'worktree' as const, sections: make('worktree') },
        { scope: 'local' as const, sections: make('local') },
        { scope: 'global' as const, sections: make('global') },
        { scope: 'system' as const, sections: make('system') },
      ];

      // Act
      const sut = mergeConfigsByScope(input);

      // Assert
      expect(sut.map((e) => e.scope)).toEqual(['system', 'global', 'local', 'worktree']);
    });
  });
});
