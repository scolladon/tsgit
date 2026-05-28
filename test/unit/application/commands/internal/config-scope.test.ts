import { describe, expect, it } from 'vitest';
import { BrowserFileSystem } from '../../../../../src/adapters/browser/browser-file-system.js';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import {
  isWorktreeScopeActive,
  mergeConfigsByScope,
  resolveScopePath,
  SCOPE_ORDER,
} from '../../../../../src/application/commands/internal/config-scope.js';
import type { IniSection } from '../../../../../src/application/primitives/config-read.js';
import type { TsgitError } from '../../../../../src/domain/error.js';
import type { Context } from '../../../../../src/ports/context.js';

const u8 = (s: string): Uint8Array => new TextEncoder().encode(s);

const withBrowserFs = (ctx: Context): Context => ({
  ...ctx,
  fs: new BrowserFileSystem({} as unknown as FileSystemDirectoryHandle),
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
