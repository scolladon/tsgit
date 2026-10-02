import { describe, expect, it } from 'vitest';
import { createMemoryContext } from '../../../../../src/adapters/memory/memory-adapter.js';
import { readGcExpiryCutoff } from '../../../../../src/application/primitives/internal/gc-config-guard.js';
import { TsgitError } from '../../../../../src/domain/index.js';
import type { Context } from '../../../../../src/ports/context.js';

const seedConfig = async (ctx: Context, config: string): Promise<void> => {
  await ctx.fs.writeUtf8(`${ctx.layout.gitDir}/config`, config);
};

const captureError = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe('readGcExpiryCutoff', () => {
  describe('Given the key is absent', () => {
    describe('When called with a fallback', () => {
      it('Then resolves the fallback, as git applies its default', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[core]\n\tbare = false\n');
        const sut = readGcExpiryCutoff;

        // Act
        const result = await sut(ctx, 'pruneExpire', 'now');

        // Assert
        expect(result).toBe(Number.POSITIVE_INFINITY);
      });
    });
  });

  describe('Given a valid entry followed by a valueless one', () => {
    describe('When called', () => {
      it('Then refuses the last entry as a missing value at its line', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(ctx, '[gc]\n\tpruneExpire = now\n\tPRUNEEXPIRE\n');
        const sut = readGcExpiryCutoff;

        // Act
        const caught = await captureError(() => sut(ctx, 'pruneExpire', 'now'));

        // Assert
        expect(caught).toBeInstanceOf(TsgitError);
        expect((caught as TsgitError).data).toEqual({
          code: 'CONFIG_MISSING_VALUE',
          key: 'gc.pruneexpire',
          source: `${ctx.layout.gitDir}/config`,
          line: 3,
        });
      });
    });
  });

  describe('Given a valueless entry under a later [gc "<sub>"] or another section', () => {
    describe('When called', () => {
      it('Then ignores it, as git reads only the subsectionless key', async () => {
        // Arrange
        const ctx = createMemoryContext();
        await seedConfig(
          ctx,
          '[gc]\n\tpruneExpire = now\n[gc "x"]\n\tpruneExpire\n[core]\n\tpruneExpire\n',
        );
        const sut = readGcExpiryCutoff;

        // Act
        const result = await sut(ctx, 'pruneExpire', '2.weeks.ago');

        // Assert
        expect(result).toBe(Number.POSITIVE_INFINITY);
      });
    });
  });
});
