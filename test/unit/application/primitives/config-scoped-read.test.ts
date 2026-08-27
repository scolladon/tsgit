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

const configPathOf = (ctx: Context): string => `${ctx.layout.gitDir}/config`;

/**
 * Wraps `ctx.fs.stat` so a call against the local config path always
 * returns the FROZEN stat captured before this call, regardless of any
 * write that lands on it afterwards — deterministically simulating a
 * same-tick, same-size external rewrite a real clock's millisecond
 * resolution might or might not happen to reproduce. Mirrors
 * `read-index.test.ts`'s `withFrozenStat`.
 */
const withFrozenConfigStat = async (ctx: Context): Promise<Context> => {
  const path = configPathOf(ctx);
  const frozen = await ctx.fs.stat(path);
  return {
    ...ctx,
    fs: {
      ...ctx.fs,
      stat: async (p: string) => (p === path ? frozen : ctx.fs.stat(p)),
    },
  };
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
  //
  // The stat is deliberately FROZEN (`withFrozenConfigStat`), not left to a
  // real rewrite's real mtime: mtime+size staleness detection (added
  // alongside this scenario) WOULD catch an ordinary same-size rewrite most
  // of the time, since two sequential writes rarely land in the exact same
  // clock tick — making a test that relies on real timing flaky rather than
  // deterministic. Freezing the stat pins the one case detection genuinely
  // cannot help with (a same-tick, same-size external rewrite — see
  // `scopeFileMtimeKey`'s own docstring), for which
  // `invalidateScopedConfigCache` remains the only signal.
  describe('Given a scoped value cached, and the config file rewritten under a frozen (same-tick) stat', () => {
    describe('When invalidateConfigCache runs alone', () => {
      it('Then the next scoped read still serves the stale cached value', async () => {
        // Arrange
        const base = createMemoryContext();
        await seed(base, '[user]\n\tname = ada\n');
        const ctx = await withFrozenConfigStat(base);
        await getConfigValue({ ctx, key: 'user.name', scope: 'local' });
        await seed(base, '[user]\n\tname = bob\n');

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
        const base = createMemoryContext();
        await seed(base, '[user]\n\tname = ada\n');
        const ctx = await withFrozenConfigStat(base);
        await getConfigValue({ ctx, key: 'user.name', scope: 'local' });
        await seed(base, '[user]\n\tname = bob\n');

        // Act
        invalidateConfigCache(ctx);
        invalidateScopedConfigCache(ctx);
        const result = await getConfigValue({ ctx, key: 'user.name', scope: 'local' });

        // Assert
        expect(result).toEqual({ key: 'user.name', value: 'bob', scope: 'local' });
      });
    });
  });

  describe('Given a scoped value cached, and the config file rewritten to a different size on disk — via raw fs.writeUtf8, no invalidator called', () => {
    describe('When the next scoped read runs', () => {
      it('Then it sees the new value — mtime+size staleness detection catches the rewrite on its own', async () => {
        // Arrange — closes the same latent-bug class `config-read.ts`'s
        // `cache` closes: a raw write past both invalidators (the pattern
        // most tests, and some production call sites, use to seed/mutate
        // config) must still be observed on the next read, not served
        // forever from a session/gitDir-keyed cache with no freshness
        // check of its own.
        const ctx = createMemoryContext();
        await seed(ctx, '[user]\n\tname = ada\n');
        await getConfigValue({ ctx, key: 'user.name', scope: 'local' });
        await seed(ctx, '[user]\n\tname = a-much-longer-value\n');

        // Act — deliberately no invalidateConfigCache/invalidateScopedConfigCache.
        const result = await getConfigValue({ ctx, key: 'user.name', scope: 'local' });

        // Assert
        expect(result).toEqual({ key: 'user.name', value: 'a-much-longer-value', scope: 'local' });
      });
    });
  });
});
