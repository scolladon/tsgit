import { describe, expect, it, vi } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import * as configReadMod from '../../../../../src/application/primitives/config-read.js';
import {
  deltaBaseCacheBudgetFor,
  GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES,
} from '../../../../../src/application/primitives/internal/resolve-delta-base-cache-limit.js';
import type { Context } from '../../../../../src/ports/context.js';

const seed = async (ctx: Context, content: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, content);
};

describe('deltaBaseCacheBudgetFor', () => {
  describe('Given a Context with no core.deltaBaseCacheLimit and no cacheBudgets override', () => {
    describe('When deltaBaseCacheBudgetFor is called', () => {
      it('Then it resolves to the 96 MiB git default', async () => {
        // Arrange
        const ctx = createMemoryContext();

        // Act
        const result = await deltaBaseCacheBudgetFor(ctx);

        // Assert
        expect(result).toBe(GIT_DEFAULT_DELTA_BASE_CACHE_LIMIT_BYTES);
      });
    });
  });

  describe('Given a Context whose config sets core.deltaBaseCacheLimit', () => {
    describe('When deltaBaseCacheBudgetFor is called', () => {
      it('Then it resolves to the parsed config value', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seed(ctx, '[core]\n\tdeltaBaseCacheLimit = 8m\n');

        // Act
        const result = await deltaBaseCacheBudgetFor(ctx);

        // Assert
        expect(result).toBe(8 * 1024 * 1024);
      });
    });
  });

  describe('Given a Context with cacheBudgets.deltaBaseCacheMaxBytes AND a conflicting config key', () => {
    describe('When deltaBaseCacheBudgetFor is called', () => {
      it('Then the explicit option wins over the config key', async () => {
        // Arrange
        const base = createMemoryContext();
        await seed(base, '[core]\n\tdeltaBaseCacheLimit = 8m\n');
        const ctx: Context = { ...base, cacheBudgets: { deltaBaseCacheMaxBytes: 4096 } };

        // Act
        const result = await deltaBaseCacheBudgetFor(ctx);

        // Assert
        expect(result).toBe(4096);
      });

      it('Then readConfig is never called — the option suppresses the key entirely', async () => {
        // Arrange
        const base = createMemoryContext();
        await seed(base, '[core]\n\tdeltaBaseCacheLimit = 8m\n');
        const ctx: Context = { ...base, cacheBudgets: { deltaBaseCacheMaxBytes: 4096 } };
        const spy = vi.spyOn(configReadMod, 'readConfig');

        // Act
        await deltaBaseCacheBudgetFor(ctx);

        // Assert
        expect(spy).not.toHaveBeenCalled();
        spy.mockRestore();
      });
    });
  });
});
