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
  describe('Given scope "local"', () => {
    describe('When resolveScopePath runs', () => {
      it('Then returns "${gitDir}/config"', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await resolveScopePath(ctx, 'local');

        // Assert
        expect(sut).toBe(`${ctx.layout.gitDir}/config`);
      });
    });
  });

  describe('Given scope "worktree" with extensions.worktreeConfig = true in local', () => {
    describe('When resolveScopePath runs', () => {
      it('Then returns "${gitDir}/config.worktree"', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: {
            '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = true\n'),
          },
        });

        // Act
        const sut = await resolveScopePath(ctx, 'worktree');

        // Assert
        expect(sut).toBe(`${ctx.layout.gitDir}/config.worktree`);
      });
    });
  });

  describe('Given scope "worktree" without the extension', () => {
    describe('When resolveScopePath runs', () => {
      it('Then throws CONFIG_SCOPE_NOT_AVAILABLE with reason worktree-extension-unset', async () => {
        // Arrange
        const ctx = createMemoryContext();
        let caught: TsgitError | undefined;

        // Act
        try {
          await resolveScopePath(ctx, 'worktree');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_SCOPE_NOT_AVAILABLE',
          scope: 'worktree',
          reason: 'worktree-extension-unset',
        });
      });
    });
  });

  describe('Given scope "global" with the XDG file present', () => {
    describe('When resolveScopePath runs', () => {
      it('Then returns "${xdg}/git/config"', async () => {
        // Arrange
        const ctx = createMemoryContext({
          xdg: '/repo/cfg',
          files: {
            '/repo/cfg/git/config': u8('[user]\n\tname = ada\n'),
          },
        });

        // Act
        const sut = await resolveScopePath(ctx, 'global');

        // Assert
        expect(sut).toBe('/repo/cfg/git/config');
      });
    });
  });

  describe('Given scope "global" with no XDG file, but ~/.gitconfig present', () => {
    describe('When resolveScopePath runs', () => {
      it('Then returns "${home}/.gitconfig"', async () => {
        // Arrange
        const ctx = createMemoryContext({
          home: '/repo/u/ada',
          xdg: '/repo/cfg',
          files: {
            '/repo/u/ada/.gitconfig': u8('[user]\n\tname = ada\n'),
          },
        });

        // Act
        const sut = await resolveScopePath(ctx, 'global');

        // Assert
        expect(sut).toBe('/repo/u/ada/.gitconfig');
      });
    });
  });

  describe('Given scope "global" with neither file present', () => {
    describe('When resolveScopePath runs', () => {
      it('Then returns "${home}/.gitconfig" (canonical write target)', async () => {
        // Arrange
        const ctx = createMemoryContext({ home: '/repo/u/ada', xdg: '/repo/cfg' });

        // Act
        const sut = await resolveScopePath(ctx, 'global');

        // Assert
        expect(sut).toBe('/repo/u/ada/.gitconfig');
      });
    });
  });

  describe('Given scope "system" on a memory adapter', () => {
    describe('When resolveScopePath runs', () => {
      it('Then returns the injected system path', async () => {
        // Arrange
        const ctx = createMemoryContext({ systemConfig: '/repo/opt/etc/gitconfig' });

        // Act
        const sut = await resolveScopePath(ctx, 'system');

        // Assert
        expect(sut).toBe('/repo/opt/etc/gitconfig');
      });
    });
  });

  describe('Given scope "global" against a browser adapter', () => {
    describe('When resolveScopePath runs', () => {
      it('Then throws CONFIG_SCOPE_NOT_AVAILABLE with reason browser-adapter', async () => {
        // Arrange
        const ctx = withBrowserFs(createMemoryContext());
        let caught: TsgitError | undefined;

        // Act
        try {
          await resolveScopePath(ctx, 'global');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_SCOPE_NOT_AVAILABLE',
          scope: 'global',
          reason: 'browser-adapter',
        });
      });
    });
  });

  describe('Given scope "system" against a browser adapter', () => {
    describe('When resolveScopePath runs', () => {
      it('Then throws CONFIG_SCOPE_NOT_AVAILABLE with reason browser-adapter', async () => {
        // Arrange
        const ctx = withBrowserFs(createMemoryContext());
        let caught: TsgitError | undefined;

        // Act
        try {
          await resolveScopePath(ctx, 'system');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({
          code: 'CONFIG_SCOPE_NOT_AVAILABLE',
          scope: 'system',
          reason: 'browser-adapter',
        });
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

  describe('Given scope "global" where fs.exists rejects for every probe', () => {
    describe('When resolveScopePath runs', () => {
      it('Then it falls through to "${home}/.gitconfig" (a failed probe reads as absent)', async () => {
        // Arrange
        const ctx = withFsOverride(createMemoryContext({ home: '/repo/u/ada', xdg: '/repo/cfg' }), {
          exists: () => Promise.reject(new Error('stat failed')),
        });

        // Act
        const sut = await resolveScopePath(ctx, 'global');

        // Assert
        expect(sut).toBe('/repo/u/ada/.gitconfig');
      });
    });
  });

  describe('Given scope "system" where systemConfigPath resolves to the empty string', () => {
    describe('When resolveScopePath runs', () => {
      it('Then throws CONFIG_SYSTEM_PATH_UNRESOLVED', async () => {
        // Arrange
        const ctx = createMemoryContext({ systemConfig: '' });
        let caught: TsgitError | undefined;

        // Act
        try {
          await resolveScopePath(ctx, 'system');
        } catch (err) {
          caught = err as TsgitError;
        }

        // Assert
        expect(caught?.data).toEqual({ code: 'CONFIG_SYSTEM_PATH_UNRESOLVED' });
      });
    });
  });
});

describe('isWorktreeScopeActive', () => {
  describe('Given a local config with [extensions] worktreeConfig = true', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then returns true', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: {
            '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = true\n'),
          },
        });

        // Act
        const sut = await isWorktreeScopeActive(ctx);

        // Assert
        expect(sut).toBe(true);
      });
    });
  });

  describe('Given a local config without the worktreeConfig key', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then returns false', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: {
            '/repo/.git/config': u8('[user]\n\tname = ada\n'),
          },
        });

        // Act
        const sut = await isWorktreeScopeActive(ctx);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given no local config at all', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then returns false (missing file is not an error)', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const sut = await isWorktreeScopeActive(ctx);

        // Assert
        expect(sut).toBe(false);
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

  describe('Given worktreeConfig = true under a non-[extensions] section', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then returns false (only the [extensions] section is consulted)', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: { '/repo/.git/config': u8('[user]\n\tworktreeConfig = true\n') },
        });

        // Act
        const sut = await isWorktreeScopeActive(ctx);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given worktreeConfig = true under a subsectioned [extensions "x"]', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then returns false (only the subsectionless [extensions] counts)', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: { '/repo/.git/config': u8('[extensions "x"]\n\tworktreeConfig = true\n') },
        });

        // Act
        const sut = await isWorktreeScopeActive(ctx);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given [extensions] with a non-worktreeConfig key set to true', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then returns false (a different key never gates the worktree scope)', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: { '/repo/.git/config': u8('[extensions]\n\totherKey = true\n') },
        });

        // Act
        const sut = await isWorktreeScopeActive(ctx);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });

  describe('Given [extensions] worktreeConfig = false', () => {
    describe('When isWorktreeScopeActive runs', () => {
      it('Then returns false (the value must be exactly "true")', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: { '/repo/.git/config': u8('[extensions]\n\tworktreeConfig = false\n') },
        });

        // Act
        const sut = await isWorktreeScopeActive(ctx);

        // Assert
        expect(sut).toBe(false);
      });
    });
  });
});

describe('mergeConfigsByScope', () => {
  describe('Given empty input, When mergeConfigsByScope runs', () => {
    it('Then returns an empty array', () => {
      // Arrange + Act
      const sut = mergeConfigsByScope([]);

      // Assert
      expect(sut).toEqual([]);
    });
  });

  describe('Given only local sections, When mergeConfigsByScope runs', () => {
    it('Then returns each section tagged with local in physical order', () => {
      // Arrange
      const sections = [section('user', undefined, []), section('core', undefined, [])];

      // Act
      const sut = mergeConfigsByScope([{ scope: 'local', sections }]);

      // Assert
      expect(sut).toEqual([
        { scope: 'local', section: sections[0] },
        { scope: 'local', section: sections[1] },
      ]);
    });
  });

  describe('Given local and global with no overlap, When mergeConfigsByScope runs', () => {
    it('Then global comes before local (scope precedence)', () => {
      // Arrange
      const localSections = [section('user', undefined, [{ key: 'name', value: 'l' }])];
      const globalSections = [section('user', undefined, [{ key: 'name', value: 'g' }])];

      // Act
      const sut = mergeConfigsByScope([
        { scope: 'local', sections: localSections },
        { scope: 'global', sections: globalSections },
      ]);

      // Assert
      expect(sut).toEqual([
        { scope: 'global', section: globalSections[0] },
        { scope: 'local', section: localSections[0] },
      ]);
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
