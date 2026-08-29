import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import { __resetConfigCacheForTests } from '../../../../src/application/primitives/config-read.js';
import {
  __resetSectionsCacheForTests,
  getConfigValue,
} from '../../../../src/application/primitives/config-scoped-read.js';
import { assertOperationalRepository } from '../../../../src/application/primitives/internal/repo-state.js';
import {
  removeConfigSection,
  renameConfigSection,
} from '../../../../src/application/primitives/update-config-sections.js';
import type { Context } from '../../../../src/ports/context.js';

const configPath = (ctx: Context): string => `${ctx.layout.gitDir}/config`;

const seed = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(configPath(ctx), content);
};

describe('primitives/update-config-sections', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  describe('Given a section cached by a scoped read', () => {
    describe('When renameConfigSection renames it', () => {
      it('Then a subsequent scoped read sees the section under its new name', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "old"]\n\turl = u\n');
        await getConfigValue({ ctx, key: 'remote.old.url', scope: 'local' });

        // Act
        await renameConfigSection({ ctx, oldName: 'remote.old', newName: 'remote.new' });

        // Assert
        const renamed = await getConfigValue({ ctx, key: 'remote.new.url', scope: 'local' });
        expect(renamed).toEqual({ key: 'remote.new.url', value: 'u', scope: 'local' });
      });
    });

    describe('When removeConfigSection removes it', () => {
      it('Then a subsequent scoped read no longer finds the removed key', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[remote "origin"]\n\turl = u\n');
        await getConfigValue({ ctx, key: 'remote.origin.url', scope: 'local' });

        // Act
        await removeConfigSection({ ctx, sectionName: 'remote.origin' });

        // Assert
        const result = await getConfigValue({ ctx, key: 'remote.origin.url', scope: 'local' });
        expect(result).toEqual({ key: 'remote.origin.url', value: undefined });
      });
    });
  });

  // Write-path symmetry: renameConfigSection calls invalidateConfigCache,
  // which also drops the operational gate-verdict memo (see config-read.ts's
  // memoizeGateVerdict) — so a section rename that flips an eager `[core]`
  // boolean is observed by a command already run once on the same Context,
  // not served a stale, pre-rename verdict.
  describe('Given the operational gate has run once on a Context', () => {
    describe('When renameConfigSection rewrites the `[core]` section under a bad boolean value', () => {
      it('Then the next assertOperationalRepository call observes the rewritten value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\tbare = false\n[old]\n\tsparseCheckout = bogus\n');
        await ctx.fs.symlink('refs/heads/main', `${ctx.layout.gitDir}/HEAD`);
        await assertOperationalRepository(ctx);

        // Act — fold `[old]`'s bad boolean into `[core]` by renaming the section.
        await renameConfigSection({ ctx, oldName: 'old', newName: 'core' });
        let caught: unknown;
        try {
          await assertOperationalRepository(ctx);
        } catch (err) {
          caught = err;
        }

        // Assert
        expect(caught).toMatchObject({ data: { code: 'CONFIG_BAD_BOOLEAN_VALUE' } });
      });
    });
  });
});
