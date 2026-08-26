import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../src/adapters/memory/memory-adapter.js';
import {
  __resetConfigCacheForTests,
  invalidateConfigCache,
} from '../../../../src/application/primitives/config-read.js';
import {
  __resetSectionsCacheForTests,
  getConfigValue,
  invalidateScopedConfigCache,
} from '../../../../src/application/primitives/config-scoped-read.js';
import type { Context } from '../../../../src/ports/context.js';

const seed = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

describe('primitives/config-scoped-read', () => {
  beforeEach(() => {
    __resetConfigCacheForTests();
    __resetSectionsCacheForTests();
  });

  // Pins the corrected contract (previously falsely documented): the two
  // per-Context config caches — `readConfig`'s and the scoped-sections one —
  // are invalidated independently. `invalidateConfigCache` alone never
  // reaches the scoped cache; every writer that needs both calls both.
  describe('Given a scoped value cached, and the config file rewritten on disk', () => {
    describe('When invalidateConfigCache runs alone', () => {
      it('Then the next scoped read still serves the stale cached value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n\tname = ada\n');
        await getConfigValue({ ctx, key: 'user.name', scope: 'local' });
        await seed(ctx, '[user]\n\tname = bob\n');

        // Act
        invalidateConfigCache(ctx);
        const result = await getConfigValue({ ctx, key: 'user.name', scope: 'local' });

        // Assert
        expect(result).toEqual({ key: 'user.name', value: 'ada', scope: 'local' });
      });
    });

    describe('When invalidateScopedConfigCache also runs', () => {
      it('Then the next scoped read sees the new value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n\tname = ada\n');
        await getConfigValue({ ctx, key: 'user.name', scope: 'local' });
        await seed(ctx, '[user]\n\tname = bob\n');

        // Act
        invalidateConfigCache(ctx);
        invalidateScopedConfigCache(ctx);
        const result = await getConfigValue({ ctx, key: 'user.name', scope: 'local' });

        // Assert
        expect(result).toEqual({ key: 'user.name', value: 'bob', scope: 'local' });
      });
    });
  });
});
