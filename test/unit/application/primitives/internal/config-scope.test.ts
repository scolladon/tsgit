import { describe, expect, it } from 'vitest';
import { BrowserFileSystem } from '../../../../../src/adapters/browser/browser-file-system.js';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import type { IniSection } from '../../../../../src/application/primitives/config-read.js';
import {
  mergeConfigsByScope,
  resolveScopePath,
  resolveWorktreeScopePath,
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
        const { ctx, expected } = arrange();

        // Act
        const result = await resolveScopePath(ctx, scope);

        // Assert
        expect(result).toBe(expected);
      });
    });
  });

  describe('Given a scope resolveScopePath itself refuses', () => {
    describe('When resolveScopePath runs', () => {
      it.each([
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
        let caught: TsgitError | undefined;

        // Act
        try {
          await resolveScopePath(ctx(), scope);
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

describe('resolveWorktreeScopePath', () => {
  describe('Given active: true and an accepted layout', () => {
    describe('When resolveWorktreeScopePath runs', () => {
      it('Then it resolves to gitDir/config.worktree', () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = resolveWorktreeScopePath(ctx, { active: true });

        // Assert
        expect(result).toBe(`${ctx.layout.gitDir}/config.worktree`);
      });
    });
  });

  describe('Given active: false and an accepted layout', () => {
    describe('When resolveWorktreeScopePath runs', () => {
      it('Then it throws CONFIG_SCOPE_NOT_AVAILABLE with reason worktree-extension-unset', () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        let caught: TsgitError | undefined;
        try {
          resolveWorktreeScopePath(ctx, { active: false });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toStrictEqual({
          code: 'CONFIG_SCOPE_NOT_AVAILABLE',
          scope: 'worktree',
          reason: 'worktree-extension-unset',
        });
      });
    });
  });

  describe('Given a layout refused for an unsupported repository format', () => {
    describe('When resolveWorktreeScopePath runs, even with active: true', () => {
      it("Then the reason is 'repository-not-accepted', not 'worktree-extension-unset'", () => {
        // Arrange — two different facts share one unavailable scope; reporting
        // a refused repository as an unset extension sends the caller looking
        // for a config key that was never read.
        const base = createMemoryContext();
        const ctx = {
          ...base,
          layout: {
            ...base.layout,
            formatRefusal: { kind: 'version' as const, version: 99 },
          },
        };

        // Act
        let caught: TsgitError | undefined;
        try {
          resolveWorktreeScopePath(ctx, { active: true });
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toStrictEqual({
          code: 'CONFIG_SCOPE_NOT_AVAILABLE',
          scope: 'worktree',
          reason: 'repository-not-accepted',
        });
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
        // Arrange & Act
        const result = mergeConfigsByScope(input);

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
      const result = mergeConfigsByScope(input);

      // Assert
      expect(result.map((e) => e.scope)).toEqual(['system', 'global', 'local', 'worktree']);
    });
  });
});
