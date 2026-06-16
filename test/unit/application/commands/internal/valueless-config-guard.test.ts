import { describe, expect, it } from 'vitest';

import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { configGet, configList } from '../../../../../src/application/commands/config.js';
import { assertNoValuelessCoreConfig } from '../../../../../src/application/commands/internal/valueless-config-guard.js';
import type { TsgitError } from '../../../../../src/domain/error.js';

const seed = async (
  ctx: ReturnType<typeof createMemoryContext>,
  content: string,
): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

describe('assertNoValuelessCoreConfig', () => {
  describe('Given a config with a valueless core.excludesFile', () => {
    describe('When assertNoValuelessCoreConfig runs', () => {
      it('Then it throws CONFIG_MISSING_VALUE for core.excludesfile with the line and source', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\texcludesFile\n');
        const sut = assertNoValuelessCoreConfig;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert — each field individually (mutation-resistant)
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
          source: string;
        };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('core.excludesfile');
        expect(data.line).toBe(2);
        expect(data.source).toBe(`${ctx.layout.gitDir}/config`);
      });
    });
  });

  describe('Given a config with a valueless core.attributesFile', () => {
    describe('When assertNoValuelessCoreConfig runs', () => {
      it('Then it throws CONFIG_MISSING_VALUE for core.attributesfile', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\tattributesFile\n');
        const sut = assertNoValuelessCoreConfig;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
        };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('core.attributesfile');
        expect(data.line).toBe(2);
      });
    });
  });

  describe('Given a config with a valueless core.hooksPath', () => {
    describe('When assertNoValuelessCoreConfig runs', () => {
      it('Then it throws CONFIG_MISSING_VALUE for core.hookspath', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\thooksPath\n');
        const sut = assertNoValuelessCoreConfig;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
        };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('core.hookspath');
        expect(data.line).toBe(2);
      });
    });
  });

  describe('Given a config with two valueless core path-likes', () => {
    describe('When assertNoValuelessCoreConfig runs', () => {
      it('Then it reports the earlier one by file line', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\tattributesFile\n\texcludesFile\n');
        const sut = assertNoValuelessCoreConfig;

        // Act
        let caught: unknown;
        try {
          await sut(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert — the earlier key (attributesfile at line 2) wins
        const data = (caught as TsgitError).data as {
          code: string;
          key: string;
          line: number;
        };
        expect(data.code).toBe('CONFIG_MISSING_VALUE');
        expect(data.key).toBe('core.attributesfile');
        expect(data.line).toBe(2);
      });
    });
  });

  describe('Given a config with an empty-string core.excludesFile', () => {
    describe('When assertNoValuelessCoreConfig runs', () => {
      it('Then it does not throw', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\texcludesFile = \n');
        const sut = assertNoValuelessCoreConfig;

        // Act + Assert — empty string is valued, not valueless
        await expect(sut(ctx)).resolves.toBeUndefined();
      });
    });
  });

  describe('Given a config with no core path-likes', () => {
    describe('When assertNoValuelessCoreConfig runs', () => {
      it('Then it does not throw', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\trepositoryformatversion = 0\n');
        const sut = assertNoValuelessCoreConfig;

        // Act + Assert
        await expect(sut(ctx)).resolves.toBeUndefined();
      });
    });
  });

  describe('Given a config with a valueless core.excludesFile', () => {
    describe('When configList runs (porcelain exemption)', () => {
      it('Then configList does not throw', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: { '/repo/.git/HEAD': new TextEncoder().encode('ref: refs/heads/main\n') },
        });
        await seed(ctx, '[core]\n\texcludesFile\n');
        const sut = configList;

        // Act + Assert — porcelain config stays non-throwing on valueless keys
        await expect(sut(ctx, {})).resolves.toBeDefined();
      });
    });

    describe('When configGet runs (porcelain exemption)', () => {
      it('Then configGet does not throw', async () => {
        // Arrange
        const ctx = createMemoryContext({
          files: { '/repo/.git/HEAD': new TextEncoder().encode('ref: refs/heads/main\n') },
        });
        await seed(ctx, '[core]\n\texcludesFile\n');
        const sut = configGet;

        // Act + Assert
        await expect(sut(ctx, { key: 'core.excludesfile' })).resolves.toBeDefined();
      });
    });
  });
});
